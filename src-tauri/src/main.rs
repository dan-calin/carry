#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use fs2::FileExt;
use std::env;
use std::ffi::{OsStr, OsString};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpStream};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::webview::{Color, ScrollBarStyle};
use tauri::{RunEvent, WebviewUrl, WebviewWindowBuilder};
use windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
use winreg::RegKey;

const CREATE_NO_WINDOW: u32 = 0x08000000;
const BACKGROUND_SESSION_VERSION: &str = "tauri-v1";
const APP_USER_MODEL_ID: &str = "Carry.Desktop";
const WEBVIEW2_CLIENT_KEY: &str =
    r"Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
const WEBVIEW2_MACHINE_KEY: &str =
    r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

struct LaunchContext {
    app_url: String,
    backend: Option<Child>,
    backend_pid: Option<u32>,
    descriptor_path: PathBuf,
    base_directory: PathBuf,
}

fn main() {
    if let Err(error) = run() {
        show_error(&error);
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    set_application_id();
    let base_directory = application_root()?;
    ensure_webview2_runtime(&base_directory)?;

    let arguments: Vec<OsString> = env::args_os().skip(1).collect();
    let mut launch = prepare_launch(&base_directory, &arguments)?;
    let parsed_url = validate_loopback_url(&launch.app_url)
        .ok_or_else(|| "Carry's private local address was invalid.".to_string())?;
    let api_origin = parsed_url.origin().ascii_serialization();
    let token = parsed_url
        .fragment()
        .ok_or_else(|| "Carry's private window token was missing.".to_string())?;
    let native_config = serde_json::json!({
        "apiOrigin": api_origin,
        "token": token,
        "nativeWindow": true
    });
    let initialization_script = format!(
        "Object.defineProperty(window, '__CARRY_NATIVE__', {{ value: Object.freeze({}), configurable: false, writable: false }});",
        native_config
    );

    let backend_running = Arc::new(AtomicBool::new(launch.backend.is_some()));
    let event_backend_running = Arc::clone(&backend_running);
    let monitor_backend_running = Arc::clone(&backend_running);
    let backend_pid = launch.backend_pid;
    let descriptor_path = launch.descriptor_path.clone();
    let descriptor_url = launch.app_url.clone();
    let base_for_descriptor = launch.base_directory.clone();
    let mut backend = launch.backend.take();

    let app = tauri::Builder::default()
        .setup(move |app| {
            let _window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("Carry")
                    .inner_size(1380.0, 860.0)
                    .min_inner_size(420.0, 360.0)
                    .center()
                    .prevent_overflow()
                    .decorations(false)
                    .resizable(true)
                    .shadow(true)
                    .background_color(Color(35, 38, 44, 255))
                    .scroll_bar_style(ScrollBarStyle::FluentOverlay)
                    .zoom_hotkeys_enabled(false)
                    .devtools(cfg!(debug_assertions))
                    .initialization_script(initialization_script)
                    .on_navigation(|url| {
                        url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost")
                    })
                    .build()?;

            #[cfg(debug_assertions)]
            if env::var("CARRY_TAURI_DEVTOOLS").as_deref() == Ok("1") {
                _window.open_devtools();
            }

            if let Some(mut child) = backend.take() {
                let app_handle = app.handle().clone();
                thread::spawn(move || {
                    let exit_code = child
                        .wait()
                        .ok()
                        .and_then(|status| status.code())
                        .unwrap_or(1);
                    monitor_backend_running.store(false, Ordering::SeqCst);
                    if let Some(pid) = backend_pid {
                        delete_background_session_if_matches(
                            &descriptor_path,
                            &base_for_descriptor,
                            pid,
                            &descriptor_url,
                        );
                    }
                    app_handle.exit(exit_code);
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .map_err(|error| format!("Carry could not create its native window: {error}"))?;

    app.run(move |_app_handle, event| {
        if let RunEvent::ExitRequested { api, .. } = event {
            if event_backend_running.load(Ordering::SeqCst) {
                api.prevent_exit();
            }
        }
    });
    Ok(())
}

fn application_root() -> Result<PathBuf, String> {
    if let Some(root) = env::var_os("CARRY_APP_ROOT") {
        return Ok(PathBuf::from(root));
    }
    let executable = env::current_exe()
        .map_err(|error| format!("Windows could not locate Carry.exe: {error}"))?;
    executable
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "Windows could not locate Carry's application folder.".to_string())
}

fn prepare_launch(base_directory: &Path, arguments: &[OsString]) -> Result<LaunchContext, String> {
    let node = base_directory.join("runtime").join("node.exe");
    let carry_script = base_directory.join("bin").join("carry.js");
    if !node.is_file() || !carry_script.is_file() {
        return Err(
            "Carry's application files are incomplete. Reinstall Carry and try again.".to_string(),
        );
    }

    let state_directory = carry_state_directory()?;
    fs::create_dir_all(&state_directory)
        .map_err(|error| format!("Carry could not prepare its local application state: {error}"))?;
    let descriptor_path = state_directory.join("background-session.txt");
    let _startup_lock = if arguments.is_empty() {
        Some(acquire_startup_lock(&state_directory.join("startup.lock"))?)
    } else {
        None
    };

    if arguments.is_empty() {
        if let Some(app_url) = read_background_session(&descriptor_path, base_directory) {
            return Ok(LaunchContext {
                app_url,
                backend: None,
                backend_pid: None,
                descriptor_path,
                base_directory: base_directory.to_path_buf(),
            });
        }
        let _ = fs::remove_file(&descriptor_path);
    }

    let (backend, app_url) = start_backend(base_directory, &node, &carry_script, arguments)?;
    let backend_pid = backend.id();
    write_background_session(&descriptor_path, base_directory, backend_pid, &app_url)?;
    Ok(LaunchContext {
        app_url,
        backend: Some(backend),
        backend_pid: Some(backend_pid),
        descriptor_path,
        base_directory: base_directory.to_path_buf(),
    })
}

fn start_backend(
    base_directory: &Path,
    node: &Path,
    carry_script: &Path,
    arguments: &[OsString],
) -> Result<(Child, String), String> {
    let mut command = Command::new(node);
    command
        .arg(carry_script)
        .arg("app")
        .arg("--no-open")
        .args(arguments)
        .current_dir(base_directory)
        .env("CARRY_PACKAGED_APP", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW);

    let mut child = command
        .spawn()
        .map_err(|error| format!("Windows could not start Carry's sync engine: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Carry could not read its sync engine startup status.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Carry could not read its sync engine diagnostics.".to_string())?;
    let diagnostics = Arc::new(Mutex::new(String::new()));
    let error_diagnostics = Arc::clone(&diagnostics);
    let (url_sender, url_receiver) = mpsc::sync_channel(1);

    thread::spawn(move || {
        let mut sent = false;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if !sent {
                if let Some(url) = extract_loopback_url(&line) {
                    let _ = url_sender.send(url);
                    sent = true;
                }
            }
        }
    });
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if let Ok(mut text) = error_diagnostics.lock() {
                if text.len() < 2000 && !line.trim().is_empty() {
                    if !text.is_empty() {
                        text.push('\n');
                    }
                    text.push_str(line.trim());
                }
            }
        }
    });

    match url_receiver.recv_timeout(Duration::from_secs(15)) {
        Ok(app_url) => Ok((child, app_url)),
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            let detail = diagnostics
                .lock()
                .map(|value| value.clone())
                .unwrap_or_default();
            Err(if detail.is_empty() {
                "Carry's private local server did not start. Reinstall Carry and try again."
                    .to_string()
            } else {
                format!("Carry's private local server did not start.\n\n{detail}")
            })
        }
    }
}

fn extract_loopback_url(line: &str) -> Option<String> {
    let start = line.to_ascii_lowercase().find("http://127.0.0.1:")?;
    let candidate = line[start..]
        .split(|character: char| character.is_whitespace() || character == '\u{1b}')
        .next()?;
    validate_loopback_url(candidate).map(|_| candidate.to_string())
}

fn validate_loopback_url(value: &str) -> Option<tauri::Url> {
    let url = tauri::Url::parse(value).ok()?;
    let token = url.fragment()?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || url.path() != "/"
        || token.len() != 48
        || !token.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return None;
    }
    Some(url)
}

fn carry_state_directory() -> Result<PathBuf, String> {
    let local_data = env::var_os("LOCALAPPDATA").ok_or_else(|| {
        "Windows did not provide Carry's local application-data folder.".to_string()
    })?;
    Ok(PathBuf::from(local_data).join("Carry"))
}

fn acquire_startup_lock(path: &Path) -> Result<File, String> {
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|error| format!("Carry could not coordinate application startup: {error}"))?;
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        match file.try_lock_exclusive() {
            Ok(()) => return Ok(file),
            Err(error) if Instant::now() < deadline => {
                if error.kind() != std::io::ErrorKind::WouldBlock {
                    thread::sleep(Duration::from_millis(100));
                } else {
                    thread::sleep(Duration::from_millis(100));
                }
            }
            Err(_) => {
                return Err("Carry is still opening. Wait a moment, then try again.".to_string())
            }
        }
    }
}

fn write_background_session(
    descriptor_path: &Path,
    base_directory: &Path,
    process_id: u32,
    app_url: &str,
) -> Result<(), String> {
    let temporary_path = descriptor_path.with_extension("txt.new");
    let contents = format!(
        "{}\n{}\n{}\n{}\n",
        process_id,
        BACKGROUND_SESSION_VERSION,
        base_directory.display(),
        app_url
    );
    fs::write(&temporary_path, contents)
        .map_err(|error| format!("Carry could not save its background session: {error}"))?;
    fs::copy(&temporary_path, descriptor_path)
        .map_err(|error| format!("Carry could not publish its background session: {error}"))?;
    let _ = fs::remove_file(temporary_path);
    Ok(())
}

fn read_background_session(descriptor_path: &Path, base_directory: &Path) -> Option<String> {
    let contents = fs::read_to_string(descriptor_path).ok()?;
    let lines: Vec<&str> = contents.lines().collect();
    if lines.len() != 4 || lines[1] != BACKGROUND_SESSION_VERSION {
        return None;
    }
    let saved_base = fs::canonicalize(lines[2]).ok()?;
    let current_base = fs::canonicalize(base_directory).ok()?;
    if saved_base != current_base {
        return None;
    }
    let _process_id: u32 = lines[0].parse().ok()?;
    validate_loopback_url(lines[3])?;
    if !probe_background_session(lines[3]) {
        return None;
    }
    Some(lines[3].to_string())
}

fn probe_background_session(app_url: &str) -> bool {
    let Some(url) = validate_loopback_url(app_url) else {
        return false;
    };
    let Some(port) = url.port() else {
        return false;
    };
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_secs(3)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(8)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));
    let token = url.fragment().unwrap_or_default();
    let request = format!(
        "GET /api/state HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Carry-Token: {token}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut status = String::new();
    if BufReader::new(stream).read_line(&mut status).is_err() {
        return false;
    }
    status.starts_with("HTTP/1.1 200")
}

fn delete_background_session_if_matches(
    descriptor_path: &Path,
    base_directory: &Path,
    process_id: u32,
    app_url: &str,
) {
    let Ok(contents) = fs::read_to_string(descriptor_path) else {
        return;
    };
    let lines: Vec<&str> = contents.lines().collect();
    if lines.len() == 4
        && lines[0] == process_id.to_string()
        && lines[1] == BACKGROUND_SESSION_VERSION
        && Path::new(lines[2]) == base_directory
        && lines[3] == app_url
    {
        let _ = fs::remove_file(descriptor_path);
    }
}

fn webview2_runtime_installed() -> bool {
    registry_runtime_version(RegKey::predef(HKEY_CURRENT_USER), WEBVIEW2_CLIENT_KEY)
        .or_else(|| {
            registry_runtime_version(RegKey::predef(HKEY_LOCAL_MACHINE), WEBVIEW2_MACHINE_KEY)
        })
        .is_some_and(|version| !version.is_empty() && version != "0.0.0.0")
}

fn registry_runtime_version(root: RegKey, path: &str) -> Option<String> {
    root.open_subkey(path)
        .ok()?
        .get_value::<String, _>("pv")
        .ok()
}

fn ensure_webview2_runtime(base_directory: &Path) -> Result<(), String> {
    if webview2_runtime_installed() {
        return Ok(());
    }
    let bootstrapper = base_directory
        .join("runtime")
        .join("MicrosoftEdgeWebview2Setup.exe");
    if !bootstrapper.is_file() {
        return Err(
            "Carry needs the Microsoft WebView2 Runtime, but its signed installer is missing. Reinstall Carry and try again."
                .to_string(),
        );
    }
    let status = Command::new(&bootstrapper)
        .args(["/silent", "/install"])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|error| format!("Carry could not install the WebView2 Runtime: {error}"))?;
    if !matches!(status.code(), Some(0) | Some(3010)) {
        return Err(format!(
            "Microsoft WebView2 Runtime setup failed with exit code {}.",
            status.code().unwrap_or(-1)
        ));
    }
    for _ in 0..20 {
        if webview2_runtime_installed() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(250));
    }
    Err("Microsoft WebView2 Runtime setup completed, but Windows still cannot find the runtime. Restart Windows and try Carry again.".to_string())
}

fn set_application_id() {
    let application_id = wide(APP_USER_MODEL_ID);
    unsafe {
        let _ = SetCurrentProcessExplicitAppUserModelID(application_id.as_ptr());
    }
}

fn show_error(message: &str) {
    let title = wide("Carry could not open");
    let body = wide(message);
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            body.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
}

fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    value
        .as_ref()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_private_tokenized_loopback_urls() {
        assert!(validate_loopback_url(
            "http://127.0.0.1:43210/#0123456789abcdef0123456789abcdef0123456789abcdef"
        )
        .is_some());
        assert!(validate_loopback_url(
            "https://example.com/#0123456789abcdef0123456789abcdef0123456789abcdef"
        )
        .is_none());
        assert!(validate_loopback_url("http://127.0.0.1:43210/#short").is_none());
    }

    #[test]
    fn extracts_the_url_from_backend_output() {
        let url = "http://127.0.0.1:43210/#0123456789abcdef0123456789abcdef0123456789abcdef";
        assert_eq!(
            extract_loopback_url(&format!("Carry app ready: {url}")),
            Some(url.to_string())
        );
    }
}

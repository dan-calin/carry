using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;
using Carry.Windows;

namespace Carry.Setup
{
    internal static class CarrySetup
    {
        private const string PayloadResource = "Carry.Payload.zip";
        private const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Carry";

        [STAThread]
        private static int Main(string[] args)
        {
            SetupOptions options;
            try
            {
                options = SetupOptions.Parse(args);
                string installDirectory = options.InstallDirectory ?? DefaultInstallDirectory();
                installDirectory = Path.GetFullPath(installDirectory).TrimEnd(Path.DirectorySeparatorChar);

                StopRunningCarry(installDirectory);
                ExtractPayload(installDirectory);
                File.WriteAllText(
                    Path.Combine(installDirectory, ".carry-installed"),
                    ProductVersion() + Environment.NewLine);

                if (options.RegisterApplication)
                {
                    RegisterApplication(installDirectory);
                }

                if (options.LaunchApplication)
                {
                    ProcessStartInfo launch = new ProcessStartInfo();
                    launch.FileName = Path.Combine(installDirectory, "Carry.exe");
                    launch.WorkingDirectory = installDirectory;
                    launch.UseShellExecute = true;
                    Process.Start(launch);
                }

                if (!options.Quiet)
                {
                    MessageBox.Show(
                        "Carry is installed and available from Windows Search.",
                        "Carry is ready",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Information);
                }
                return 0;
            }
            catch (Exception error)
            {
                bool quiet = Array.IndexOf(args, "--quiet") >= 0;
                if (!quiet)
                {
                    MessageBox.Show(
                        "Carry could not be installed.\n\n" + error.Message,
                        "Carry Setup",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error);
                }
                return 1;
            }
        }

        private static string DefaultInstallDirectory()
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs",
                "Carry");
        }

        private static void StopRunningCarry(string installDirectory)
        {
            if (!Directory.Exists(installDirectory))
            {
                return;
            }

            string expectedRuntime = Path.GetFullPath(
                Path.Combine(installDirectory, "runtime", "node.exe"));
            string expectedLauncher = Path.GetFullPath(
                Path.Combine(installDirectory, "Carry.exe"));
            System.Collections.Generic.List<Process> runtimeProcesses =
                FindExactProcesses("node", expectedRuntime);
            System.Collections.Generic.List<Process> launcherProcesses =
                FindExactProcesses("Carry", expectedLauncher);

            if (runtimeProcesses.Count == 0 && launcherProcesses.Count == 0)
            {
                return;
            }

            try
            {
                WindowsShell.CloseCarryWindows();
                Thread.Sleep(300);
            }
            catch
            {
                // Exact process paths below still make the update safe.
            }

            StopExactProcesses(runtimeProcesses, false);
            // Carry.exe normally exits as soon as its owned Node backend ends.
            // Wait briefly before forcing only that exact installed launcher.
            StopExactProcesses(launcherProcesses, true);
        }

        private static System.Collections.Generic.List<Process> FindExactProcesses(
            string processName,
            string expectedExecutable)
        {
            System.Collections.Generic.List<Process> matches =
                new System.Collections.Generic.List<Process>();
            foreach (Process process in Process.GetProcessesByName(processName))
            {
                string executablePath;
                try
                {
                    executablePath = process.MainModule.FileName;
                }
                catch
                {
                    process.Dispose();
                    continue;
                }
                if (string.Equals(
                    Path.GetFullPath(executablePath),
                    expectedExecutable,
                    StringComparison.OrdinalIgnoreCase))
                {
                    matches.Add(process);
                }
                else
                {
                    process.Dispose();
                }
            }
            return matches;
        }

        private static void StopExactProcesses(
            System.Collections.Generic.List<Process> processes,
            bool waitBeforeKill)
        {
            foreach (Process process in processes)
            {
                using (process)
                {
                    try
                    {
                        if (waitBeforeKill && !process.HasExited)
                        {
                            process.WaitForExit(1500);
                        }
                        if (!process.HasExited)
                        {
                            process.Kill();
                        }
                        if (!process.HasExited && !process.WaitForExit(5000))
                        {
                            throw new IOException(
                                "Carry is still running. Close it in Task Manager, then run Setup again.");
                        }
                    }
                    catch (InvalidOperationException)
                    {
                        // The process exited between discovery and shutdown.
                    }
                }
            }
        }

        private static void ExtractPayload(string installDirectory)
        {
            Directory.CreateDirectory(installDirectory);
            string rootWithSeparator = installDirectory + Path.DirectorySeparatorChar;

            Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream(PayloadResource);
            if (payload == null)
            {
                throw new InvalidDataException("The installer payload is missing.");
            }

            using (payload)
            using (ZipArchive archive = new ZipArchive(payload, ZipArchiveMode.Read))
            {
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    string relativePath = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                    string destination = Path.GetFullPath(Path.Combine(installDirectory, relativePath));
                    bool insideRoot = destination.StartsWith(rootWithSeparator, StringComparison.OrdinalIgnoreCase);
                    if (!insideRoot && !string.Equals(destination, installDirectory, StringComparison.OrdinalIgnoreCase))
                    {
                        throw new InvalidDataException("The installer contains an unsafe path.");
                    }

                    if (string.IsNullOrEmpty(entry.Name))
                    {
                        Directory.CreateDirectory(destination);
                        continue;
                    }

                    string parent = Path.GetDirectoryName(destination);
                    if (!string.IsNullOrEmpty(parent))
                    {
                        Directory.CreateDirectory(parent);
                    }
                    using (Stream input = entry.Open())
                    using (FileStream output = new FileStream(destination, FileMode.Create, FileAccess.Write, FileShare.None))
                    {
                        input.CopyTo(output);
                    }
                }
            }
        }

        private static void RegisterApplication(string installDirectory)
        {
            string launcher = Path.Combine(installDirectory, "Carry.exe");
            string uninstaller = Path.Combine(installDirectory, "Uninstall.exe");
            WindowsShell.CreateStartMenuShortcut(launcher, installDirectory);

            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(UninstallKey))
            {
                if (key == null)
                {
                    throw new InvalidOperationException("Windows could not register Carry.");
                }
                key.SetValue("DisplayName", "Carry");
                key.SetValue("DisplayVersion", ProductVersion());
                key.SetValue("DisplayIcon", launcher + ",0");
                key.SetValue("Publisher", "Carry contributors");
                key.SetValue("InstallLocation", installDirectory);
                key.SetValue("UninstallString", "\"" + uninstaller + "\"");
                key.SetValue("QuietUninstallString", "\"" + uninstaller + "\" --quiet");
                key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                key.SetValue("InstallDate", DateTime.UtcNow.ToString("yyyyMMdd"));
                key.SetValue("EstimatedSize", EstimatedSizeKilobytes(installDirectory), RegistryValueKind.DWord);
            }
        }

        private static int EstimatedSizeKilobytes(string directory)
        {
            long bytes = 0;
            foreach (string file in Directory.GetFiles(directory, "*", SearchOption.AllDirectories))
            {
                bytes += new FileInfo(file).Length;
            }
            return (int)Math.Min(int.MaxValue, Math.Max(1, bytes / 1024));
        }

        private static string ProductVersion()
        {
            Version version = Assembly.GetExecutingAssembly().GetName().Version;
            return version.Major + "." + version.Minor + "." + version.Build;
        }

        private sealed class SetupOptions
        {
            internal string InstallDirectory;
            internal bool RegisterApplication = true;
            internal bool LaunchApplication = true;
            internal bool Quiet;

            internal static SetupOptions Parse(string[] args)
            {
                SetupOptions options = new SetupOptions();
                for (int index = 0; index < args.Length; index++)
                {
                    string argument = args[index];
                    if (argument == "--install-dir")
                    {
                        if (++index >= args.Length || string.IsNullOrWhiteSpace(args[index]))
                        {
                            throw new ArgumentException("--install-dir requires a folder path.");
                        }
                        options.InstallDirectory = args[index];
                    }
                    else if (argument == "--no-register")
                    {
                        options.RegisterApplication = false;
                    }
                    else if (argument == "--no-launch")
                    {
                        options.LaunchApplication = false;
                    }
                    else if (argument == "--quiet")
                    {
                        options.Quiet = true;
                    }
                    else
                    {
                        throw new ArgumentException("Unknown setup option: " + argument);
                    }
                }
                return options;
            }
        }
    }
}

[CmdletBinding()]
param(
    [string]$Version,
    [string]$NodeVersion = '24.18.0',
    [string]$OutputDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
if (-not $Version) { $Version = [string]$package.version }
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Version must use major.minor.patch format.' }
if ($NodeVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'NodeVersion must use major.minor.patch format.' }

$outputRoot = if ($OutputDirectory) {
    [System.IO.Path]::GetFullPath($OutputDirectory)
} else {
    Join-Path $projectRoot 'dist'
}
$buildRoot = Join-Path $projectRoot '.build\windows'
$stageRoot = Join-Path $buildRoot 'stage'
$testInstallRoot = Join-Path $buildRoot 'setup-test'
$cacheRoot = Join-Path $projectRoot '.build-cache\node'
$webViewCacheRoot = Join-Path $projectRoot '.build-cache\webview2'

function Assert-ProjectChild([string]$PathToCheck) {
    $resolved = [System.IO.Path]::GetFullPath($PathToCheck)
    $prefix = $projectRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Build path must remain inside the project: $resolved"
    }
}

Assert-ProjectChild $outputRoot
Assert-ProjectChild $buildRoot
Assert-ProjectChild $cacheRoot
Assert-ProjectChild $webViewCacheRoot

& node (Join-Path $projectRoot 'scripts\prepare-native.js')
if ($LASTEXITCODE -ne 0) { throw 'The pinned DataChannel dependency is not ready.' }

foreach ($directory in @($buildRoot, $outputRoot)) {
    if (Test-Path -LiteralPath $directory) {
        Remove-Item -LiteralPath $directory -Recurse -Force
    }
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
}
New-Item -ItemType Directory -Path $stageRoot, $cacheRoot, $webViewCacheRoot -Force | Out-Null

$archiveName = "node-v$NodeVersion-win-x64.zip"
$archivePath = Join-Path $cacheRoot $archiveName
$releaseBase = "https://nodejs.org/download/release/v$NodeVersion"
$checksums = (Invoke-WebRequest -UseBasicParsing -Uri "$releaseBase/SHASUMS256.txt").Content
$pattern = '(?m)^([a-f0-9]{64})\s+\*?' + [regex]::Escape($archiveName) + '\s*$'
$checksumMatch = [regex]::Match($checksums, $pattern)
if (-not $checksumMatch.Success) { throw "Node checksum was not published for $archiveName" }
$expectedHash = $checksumMatch.Groups[1].Value.ToUpperInvariant()

$needsDownload = -not (Test-Path -LiteralPath $archivePath)
if (-not $needsDownload) {
    $needsDownload = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ne $expectedHash
}
if ($needsDownload) {
    $temporaryArchive = "$archivePath.download"
    Invoke-WebRequest -UseBasicParsing -Uri "$releaseBase/$archiveName" -OutFile $temporaryArchive
    $downloadedHash = (Get-FileHash -LiteralPath $temporaryArchive -Algorithm SHA256).Hash
    if ($downloadedHash -ne $expectedHash) {
        [System.IO.File]::Delete($temporaryArchive)
        throw 'Downloaded Node runtime failed SHA-256 verification.'
    }
    Move-Item -LiteralPath $temporaryArchive -Destination $archivePath -Force
}

$nodeExtractRoot = Join-Path $buildRoot 'node'
Expand-Archive -LiteralPath $archivePath -DestinationPath $nodeExtractRoot -Force
$nodeDistribution = Join-Path $nodeExtractRoot "node-v$NodeVersion-win-x64"
foreach ($required in @('node.exe', 'LICENSE')) {
    if (-not (Test-Path -LiteralPath (Join-Path $nodeDistribution $required))) {
        throw "The official Node archive is missing $required"
    }
}

$webViewBootstrapUri = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703'
$webViewBootstrapPath = Join-Path $webViewCacheRoot 'MicrosoftEdgeWebview2Setup.exe'
function Test-MicrosoftSignedExecutable([string]$ExecutablePath) {
    if (-not (Test-Path -LiteralPath $ExecutablePath)) { return $false }
    $signature = Get-AuthenticodeSignature -LiteralPath $ExecutablePath
    return $signature.Status -eq [System.Management.Automation.SignatureStatus]::Valid -and
        $null -ne $signature.SignerCertificate -and
        $signature.SignerCertificate.Subject -match '(?:^|,\s*)O=Microsoft Corporation(?:,|$)'
}
if (-not (Test-MicrosoftSignedExecutable $webViewBootstrapPath)) {
    $temporaryBootstrapper = "$webViewBootstrapPath.download"
    Invoke-WebRequest -UseBasicParsing -Uri $webViewBootstrapUri -OutFile $temporaryBootstrapper
    if (-not (Test-MicrosoftSignedExecutable $temporaryBootstrapper)) {
        [System.IO.File]::Delete($temporaryBootstrapper)
        throw 'Downloaded WebView2 bootstrapper is not validly signed by Microsoft.'
    }
    Move-Item -LiteralPath $temporaryBootstrapper -Destination $webViewBootstrapPath -Force
}
$webViewBootstrapHash = (Get-FileHash -LiteralPath $webViewBootstrapPath -Algorithm SHA256).Hash

foreach ($directoryName in @('app', 'bin', 'lib', 'relay')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot $directoryName) -Destination (Join-Path $stageRoot $directoryName) -Recurse
}
foreach ($fileName in @('package.json', 'README.md', 'LICENSE', 'SECURITY.md', 'PRIVACY.md')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot $fileName) -Destination (Join-Path $stageRoot $fileName)
}
Copy-Item -LiteralPath (Join-Path $projectRoot 'THIRD_PARTY_NOTICES.md') -Destination (Join-Path $stageRoot 'THIRD_PARTY_NOTICES.md')

$dataChannelSource = Join-Path $projectRoot 'node_modules\node-datachannel'
$dataChannelStage = Join-Path $stageRoot 'node_modules\node-datachannel'
foreach ($required in @('package.json', 'LICENSE', 'dist', 'build\Release\node_datachannel.node')) {
    if (-not (Test-Path -LiteralPath (Join-Path $dataChannelSource $required))) {
        throw "The pinned DataChannel package is missing $required"
    }
}
New-Item -ItemType Directory -Path $dataChannelStage -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $dataChannelSource 'package.json') -Destination $dataChannelStage
Copy-Item -LiteralPath (Join-Path $dataChannelSource 'LICENSE') -Destination $dataChannelStage
Copy-Item -LiteralPath (Join-Path $dataChannelSource 'dist') -Destination (Join-Path $dataChannelStage 'dist') -Recurse
New-Item -ItemType Directory -Path (Join-Path $dataChannelStage 'build\Release') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $dataChannelSource 'build\Release\node_datachannel.node') `
    -Destination (Join-Path $dataChannelStage 'build\Release\node_datachannel.node')

$runtimeRoot = Join-Path $stageRoot 'runtime'
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $nodeDistribution 'node.exe') -Destination (Join-Path $runtimeRoot 'node.exe')
Copy-Item -LiteralPath (Join-Path $nodeDistribution 'LICENSE') -Destination (Join-Path $runtimeRoot 'LICENSE-node.txt')
Copy-Item -LiteralPath $webViewBootstrapPath -Destination (Join-Path $runtimeRoot 'MicrosoftEdgeWebview2Setup.exe')
[System.IO.File]::WriteAllText(
    (Join-Path $runtimeRoot 'README.txt'),
    "Carry bundles the official Node.js v$NodeVersion Windows x64 runtime.`r`nSource: $releaseBase/$archiveName`r`nSHA-256: $expectedHash`r`n`r`nCarry also bundles Microsoft's signed Evergreen WebView2 bootstrapper for PCs where Windows does not already provide the runtime.`r`nSource: $webViewBootstrapUri`r`nSHA-256: $webViewBootstrapHash`r`n")

$cscCandidates = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$csc = $cscCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $csc) { throw 'The Windows .NET Framework C# compiler was not found.' }

$versionParts = $Version.Split('.')
$assemblyVersion = "$($versionParts[0]).$($versionParts[1]).$($versionParts[2]).0"
$assemblyInfo = Join-Path $buildRoot 'AssemblyInfo.cs'
[System.IO.File]::WriteAllText($assemblyInfo, @"
using System.Reflection;
[assembly: AssemblyTitle("Carry")]
[assembly: AssemblyDescription("Secure peer-to-peer folder and agent-memory sync")]
[assembly: AssemblyCompany("Carry contributors")]
[assembly: AssemblyProduct("Carry")]
[assembly: AssemblyCopyright("Copyright (c) 2026 Carry contributors")]
[assembly: AssemblyVersion("$assemblyVersion")]
[assembly: AssemblyFileVersion("$assemblyVersion")]
"@)

$iconPath = Join-Path $projectRoot 'app\assets\carry.ico'
if (-not (Test-Path -LiteralPath $iconPath)) { throw 'app/assets/carry.ico is missing.' }
$windowsSources = Join-Path $projectRoot 'scripts\windows'
$applicationManifest = Join-Path $windowsSources 'Carry.manifest'
if (-not (Test-Path -LiteralPath $applicationManifest)) { throw 'scripts/windows/Carry.manifest is missing.' }

function Invoke-CSharpCompiler([string]$OutputPath, [string[]]$Sources, [string[]]$References, [string[]]$Resources) {
    $compilerArguments = @(
        '/nologo',
        '/target:winexe',
        '/platform:x64',
        '/optimize+',
        "/win32icon:$iconPath",
        "/win32manifest:$applicationManifest",
        "/out:$OutputPath"
    )
    foreach ($reference in $References) { $compilerArguments += "/reference:$reference" }
    foreach ($resource in $Resources) { $compilerArguments += "/resource:$resource" }
    $compilerArguments += $Sources
    & $csc @compilerArguments
    if ($LASTEXITCODE -ne 0) { throw "C# compilation failed for $OutputPath" }
}

$cargo = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
if (-not (Test-Path -LiteralPath $cargo)) {
    $cargoCommand = Get-Command cargo.exe -ErrorAction SilentlyContinue
    if ($null -ne $cargoCommand) { $cargo = $cargoCommand.Source }
}
if (-not (Test-Path -LiteralPath $cargo)) {
    throw "Rust/Cargo is required to build Carry's Tauri desktop shell."
}
& $cargo `
    build `
    --locked `
    --release `
    --features custom-protocol `
    --manifest-path (Join-Path $projectRoot 'src-tauri\Cargo.toml')
if ($LASTEXITCODE -ne 0) { throw 'The Tauri desktop shell failed to compile.' }
$tauriExecutable = Join-Path $projectRoot 'src-tauri\target\release\carry.exe'
if (-not (Test-Path -LiteralPath $tauriExecutable)) {
    throw 'The Tauri build did not produce carry.exe.'
}
Copy-Item -LiteralPath $tauriExecutable -Destination (Join-Path $stageRoot 'Carry.exe')

Invoke-CSharpCompiler `
    (Join-Path $stageRoot 'Uninstall.exe') `
    @((Join-Path $windowsSources 'CarryUninstall.cs'), (Join-Path $windowsSources 'WindowsShell.cs'), $assemblyInfo) `
    @('System.Windows.Forms.dll') `
    @()

$shortcutTestSource = Join-Path $buildRoot 'ShortcutTest.cs'
$shortcutTestExecutable = Join-Path $buildRoot 'ShortcutTest.exe'
$shortcutTestPath = Join-Path $buildRoot 'Carry-test.lnk'
[System.IO.File]::WriteAllText($shortcutTestSource, @'
using System;
using Carry.Windows;
internal static class ShortcutTest
{
    [STAThread]
    private static int Main(string[] args)
    {
        WindowsShell.CreateShortcut(args[0], args[1], args[2]);
        return string.Equals(
            WindowsShell.ReadShortcutApplicationId(args[0]),
            WindowsShell.ApplicationId,
            StringComparison.Ordinal) ? 0 : 2;
    }
}
'@)
Invoke-CSharpCompiler `
    $shortcutTestExecutable `
    @($shortcutTestSource, (Join-Path $windowsSources 'WindowsShell.cs')) `
    @() `
    @()
$shortcutArguments = "`"$shortcutTestPath`" `"$(Join-Path $stageRoot 'Carry.exe')`" `"$stageRoot`""
$shortcutProcess = Start-Process -FilePath $shortcutTestExecutable -ArgumentList $shortcutArguments -Wait -PassThru -WindowStyle Hidden
if ($shortcutProcess.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $shortcutTestPath)) {
    throw 'The Windows Start Menu shortcut test failed.'
}
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutTestPath)
if (-not [string]::Equals($shortcut.TargetPath, (Join-Path $stageRoot 'Carry.exe'), [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'The generated Windows shortcut points to the wrong executable.'
}

& node (Join-Path $projectRoot 'test\package-itest.js') $stageRoot
if ($LASTEXITCODE -ne 0) { throw 'The staged Windows package failed validation.' }

$portableName = "Carry-$Version-windows-x64-portable.zip"
$portablePath = Join-Path $outputRoot $portableName
Compress-Archive -Path (Join-Path $stageRoot '*') -DestinationPath $portablePath -CompressionLevel Optimal

$setupName = "Carry-Setup-$Version-windows-x64.exe"
$setupPath = Join-Path $outputRoot $setupName
Invoke-CSharpCompiler `
    $setupPath `
    @((Join-Path $windowsSources 'CarrySetup.cs'), (Join-Path $windowsSources 'WindowsShell.cs'), $assemblyInfo) `
    @('System.Windows.Forms.dll', 'System.IO.Compression.dll', 'System.IO.Compression.FileSystem.dll') `
    @("$portablePath,Carry.Payload.zip")

$setupArguments = "--install-dir `"$testInstallRoot`" --no-register --no-launch --quiet"
$setupProcess = Start-Process -FilePath $setupPath -ArgumentList $setupArguments -Wait -PassThru -WindowStyle Hidden
if ($setupProcess.ExitCode -ne 0) { throw "The setup executable test failed with exit code $($setupProcess.ExitCode)." }
& node (Join-Path $projectRoot 'test\package-itest.js') $testInstallRoot
if ($LASTEXITCODE -ne 0) { throw 'The extracted setup payload failed validation.' }

$runtimeHoldScript = Join-Path $testInstallRoot 'runtime-hold.js'
$runtimeHoldProcess = $null
$launcherHoldSource = Join-Path $buildRoot 'CarryHold.cs'
$launcherHoldExecutable = Join-Path $buildRoot 'CarryHold.exe'
$launcherHoldProcess = $null
try {
    [System.IO.File]::WriteAllText(
        $launcherHoldSource,
        "using System.Threading; internal static class CarryHold { private static void Main() { Thread.Sleep(Timeout.Infinite); } }`n")
    Invoke-CSharpCompiler `
        -OutputPath $launcherHoldExecutable `
        -Sources @($launcherHoldSource) `
        -References @() `
        -Resources @()
    Copy-Item -LiteralPath $launcherHoldExecutable -Destination (Join-Path $testInstallRoot 'Carry.exe') -Force
    $launcherHoldProcess = Start-Process `
        -FilePath (Join-Path $testInstallRoot 'Carry.exe') `
        -PassThru `
        -WindowStyle Hidden

    [System.IO.File]::WriteAllText(
        $runtimeHoldScript,
        "setInterval(function () {}, 1000);`n")
    $runtimeHoldProcess = Start-Process `
        -FilePath (Join-Path $testInstallRoot 'runtime\node.exe') `
        -ArgumentList "`"$runtimeHoldScript`"" `
        -PassThru `
        -WindowStyle Hidden
    Start-Sleep -Milliseconds 300
    if ($runtimeHoldProcess.HasExited) {
        throw 'The packaged runtime did not stay active for the upgrade test.'
    }
    if ($launcherHoldProcess.HasExited) {
        throw 'The packaged launcher hold process did not stay active for the upgrade test.'
    }

    $upgradeProcess = Start-Process `
        -FilePath $setupPath `
        -ArgumentList $setupArguments `
        -Wait `
        -PassThru `
        -WindowStyle Hidden
    if ($upgradeProcess.ExitCode -ne 0) {
        throw "Setup could not update a running Carry installation (exit $($upgradeProcess.ExitCode))."
    }
    $runtimeHoldProcess.Refresh()
    if (-not $runtimeHoldProcess.HasExited) {
        throw 'Setup did not stop the exact installed Carry runtime before updating.'
    }
    $launcherHoldProcess.Refresh()
    if (-not $launcherHoldProcess.HasExited) {
        throw 'Setup did not stop the exact installed Carry launcher before updating.'
    }
    & node (Join-Path $projectRoot 'test\package-itest.js') $testInstallRoot
    if ($LASTEXITCODE -ne 0) { throw 'The upgraded setup payload failed validation.' }
}
finally {
    if ($null -ne $runtimeHoldProcess) {
        $runtimeHoldProcess.Refresh()
        if (-not $runtimeHoldProcess.HasExited) { $runtimeHoldProcess.Kill() }
        $runtimeHoldProcess.Dispose()
    }
    if ($null -ne $launcherHoldProcess) {
        $launcherHoldProcess.Refresh()
        if (-not $launcherHoldProcess.HasExited) { $launcherHoldProcess.Kill() }
        $launcherHoldProcess.Dispose()
    }
    if (Test-Path -LiteralPath $runtimeHoldScript) {
        Remove-Item -LiteralPath $runtimeHoldScript -Force
    }
}

# Verify the uninstaller's exact-path shutdown logic separately from Setup.
# A background remote session normally owns both these installed executables;
# uninstall must stop them without touching an unrelated Node process.
$uninstallHarnessSource = Join-Path $buildRoot 'UninstallLifecycleTest.cs'
$uninstallHarnessExecutable = Join-Path $buildRoot 'UninstallLifecycleTest.exe'
[System.IO.File]::WriteAllText($uninstallHarnessSource, @'
using System;
using System.Reflection;
internal static class UninstallLifecycleTest
{
    private static int Main(string[] args)
    {
        Assembly assembly = Assembly.LoadFrom(args[0]);
        Type type = assembly.GetType("Carry.Setup.CarryUninstall", true);
        MethodInfo stop = type.GetMethod("StopRunningCarry", BindingFlags.NonPublic | BindingFlags.Static);
        if (stop == null) return 2;
        stop.Invoke(null, new object[] { args[1] });
        return 0;
    }
}
'@)
Invoke-CSharpCompiler `
    -OutputPath $uninstallHarnessExecutable `
    -Sources @($uninstallHarnessSource) `
    -References @() `
    -Resources @()

$uninstallRuntimeProcess = $null
$uninstallLauncherProcess = $null
$unrelatedNodeProcess = $null
try {
    [System.IO.File]::WriteAllText(
        $runtimeHoldScript,
        "setInterval(function () {}, 1000);`n")
    $systemNode = (Get-Command node -ErrorAction Stop).Source
    Copy-Item -LiteralPath $launcherHoldExecutable -Destination (Join-Path $testInstallRoot 'Carry.exe') -Force
    $uninstallLauncherProcess = Start-Process `
        -FilePath (Join-Path $testInstallRoot 'Carry.exe') `
        -PassThru `
        -WindowStyle Hidden
    $uninstallRuntimeProcess = Start-Process `
        -FilePath (Join-Path $testInstallRoot 'runtime\node.exe') `
        -ArgumentList "`"$runtimeHoldScript`"" `
        -PassThru `
        -WindowStyle Hidden
    $unrelatedNodeProcess = Start-Process `
        -FilePath $systemNode `
        -ArgumentList "`"$runtimeHoldScript`"" `
        -PassThru `
        -WindowStyle Hidden
    Start-Sleep -Milliseconds 300

    $harnessArguments = "`"$(Join-Path $testInstallRoot 'Uninstall.exe')`" `"$testInstallRoot`""
    $harnessProcess = Start-Process `
        -FilePath $uninstallHarnessExecutable `
        -ArgumentList $harnessArguments `
        -Wait `
        -PassThru `
        -WindowStyle Hidden
    if ($harnessProcess.ExitCode -ne 0) {
        throw "Uninstaller lifecycle harness failed with exit code $($harnessProcess.ExitCode)."
    }
    $uninstallRuntimeProcess.Refresh()
    $uninstallLauncherProcess.Refresh()
    $unrelatedNodeProcess.Refresh()
    if (-not $uninstallRuntimeProcess.HasExited -or -not $uninstallLauncherProcess.HasExited) {
        throw 'Uninstaller did not stop the exact installed Carry processes.'
    }
    if ($unrelatedNodeProcess.HasExited) {
        throw 'Uninstaller stopped an unrelated Node process.'
    }
}
finally {
    foreach ($process in @($uninstallRuntimeProcess, $uninstallLauncherProcess, $unrelatedNodeProcess)) {
        if ($null -eq $process) { continue }
        $process.Refresh()
        if (-not $process.HasExited) { $process.Kill() }
        $process.Dispose()
    }
    Copy-Item -LiteralPath (Join-Path $stageRoot 'Carry.exe') -Destination (Join-Path $testInstallRoot 'Carry.exe') -Force
    if (Test-Path -LiteralPath $runtimeHoldScript) {
        Remove-Item -LiteralPath $runtimeHoldScript -Force
    }
}
& node (Join-Path $projectRoot 'test\package-itest.js') $testInstallRoot
if ($LASTEXITCODE -ne 0) { throw 'The package failed validation after the uninstall lifecycle test.' }

$uninstallProbe = Start-Process `
    -FilePath (Join-Path $testInstallRoot 'Uninstall.exe') `
    -ArgumentList '--quiet' `
    -Wait `
    -PassThru `
    -WindowStyle Hidden
if ($uninstallProbe.ExitCode -eq 0 -or -not (Test-Path -LiteralPath (Join-Path $testInstallRoot 'Carry.exe'))) {
    throw 'The uninstaller did not protect a nonstandard directory.'
}

$checksumPath = Join-Path $outputRoot 'SHA256SUMS.txt'
$checksumLines = @()
foreach ($artifact in @($setupPath, $portablePath)) {
    $hash = (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash.ToLowerInvariant()
    $checksumLines += "$hash  $([System.IO.Path]::GetFileName($artifact))"
}
[System.IO.File]::WriteAllLines($checksumPath, $checksumLines)

Write-Host "Carry Windows release built successfully:"
Get-ChildItem -LiteralPath $outputRoot | Select-Object Name, Length

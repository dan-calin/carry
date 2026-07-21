using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;
using Carry.Windows;

namespace Carry.Setup
{
    internal static class CarryUninstall
    {
        private const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Carry";

        [STAThread]
        private static int Main(string[] args)
        {
            bool quiet = Array.IndexOf(args, "--quiet") >= 0;
            int removeIndex = Array.IndexOf(args, "--remove");
            try
            {
                if (removeIndex >= 0)
                {
                    if (removeIndex + 1 >= args.Length)
                    {
                        throw new ArgumentException("The install location is missing.");
                    }
                    return RemoveInstalledApplication(args[removeIndex + 1], quiet);
                }

                string installDirectory = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory)
                    .TrimEnd(Path.DirectorySeparatorChar);
                ValidateInstallDirectory(installDirectory);

                if (!quiet)
                {
                    DialogResult choice = MessageBox.Show(
                        "Remove Carry from this PC?\n\nYour synced project folders will not be deleted.",
                        "Uninstall Carry",
                        MessageBoxButtons.YesNo,
                        MessageBoxIcon.Question,
                        MessageBoxDefaultButton.Button2);
                    if (choice != DialogResult.Yes)
                    {
                        return 0;
                    }
                }

                string temporaryCopy = Path.Combine(
                    Path.GetTempPath(),
                    "Carry-Uninstall-" + Guid.NewGuid().ToString("N") + ".exe");
                File.Copy(Application.ExecutablePath, temporaryCopy, true);

                ProcessStartInfo cleanup = new ProcessStartInfo();
                cleanup.FileName = temporaryCopy;
                cleanup.Arguments = "--remove " + QuoteArgument(installDirectory) + (quiet ? " --quiet" : string.Empty);
                cleanup.WorkingDirectory = Path.GetTempPath();
                cleanup.UseShellExecute = true;
                Process.Start(cleanup);
                return 0;
            }
            catch (Exception error)
            {
                if (!quiet)
                {
                    MessageBox.Show(
                        "Carry could not be removed.\n\n" + error.Message,
                        "Uninstall Carry",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error);
                }
                return 1;
            }
        }

        private static int RemoveInstalledApplication(string installDirectory, bool quiet)
        {
            Thread.Sleep(600);
            installDirectory = Path.GetFullPath(installDirectory).TrimEnd(Path.DirectorySeparatorChar);
            ValidateInstallDirectory(installDirectory);

            // Remote sessions intentionally keep the packaged launcher and
            // Node runtime alive after the app window closes. Stop only the
            // executables from this exact Carry installation before deleting
            // it; unrelated Node/Carry processes must never be touched.
            StopRunningCarry(installDirectory);
            DeleteInstallDirectory(installDirectory);
            DeleteBackgroundSession();
            WindowsShell.DeleteStartMenuShortcut();
            Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false);

            if (!quiet)
            {
                MessageBox.Show(
                    "Carry was removed. Your project folders were left untouched.",
                    "Carry uninstalled",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
            }
            return 0;
        }

        private static void StopRunningCarry(string installDirectory)
        {
            string expectedRuntime = Path.GetFullPath(
                Path.Combine(installDirectory, "runtime", "node.exe"));
            string expectedLauncher = Path.GetFullPath(
                Path.Combine(installDirectory, "Carry.exe"));
            System.Collections.Generic.List<Process> runtimeProcesses =
                FindExactProcesses("node", expectedRuntime);
            System.Collections.Generic.List<Process> launcherProcesses =
                FindExactProcesses("Carry", expectedLauncher);

            try
            {
                WindowsShell.CloseCarryWindows();
                Thread.Sleep(300);
            }
            catch
            {
                // Exact process paths below still make removal safe.
            }

            StopExactProcesses(runtimeProcesses, false);
            // Carry.exe normally exits with its owned backend. Give it a short
            // grace period before forcing only the exact installed launcher.
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
                                "Carry is still running. Close it in Task Manager, then uninstall again.");
                        }
                    }
                    catch (InvalidOperationException)
                    {
                        // The process exited between discovery and shutdown.
                    }
                }
            }
        }

        private static void DeleteInstallDirectory(string installDirectory)
        {
            Exception lastError = null;
            for (int attempt = 0; attempt < 6; attempt++)
            {
                try
                {
                    Directory.Delete(installDirectory, true);
                    return;
                }
                catch (IOException error)
                {
                    lastError = error;
                }
                catch (UnauthorizedAccessException error)
                {
                    lastError = error;
                }
                Thread.Sleep(150 * (attempt + 1));
            }
            throw new IOException(
                "Carry's files are still in use. Close Carry in Task Manager, then uninstall again.",
                lastError);
        }

        private static void DeleteBackgroundSession()
        {
            try
            {
                string localData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                string statePath = Path.Combine(localData, "Carry", "background-session.txt");
                if (File.Exists(statePath))
                {
                    File.Delete(statePath);
                }
            }
            catch
            {
                // A stale descriptor is harmless and self-cleans on reinstall.
            }
        }

        private static void ValidateInstallDirectory(string directory)
        {
            string expected = Path.GetFullPath(Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs",
                "Carry")).TrimEnd(Path.DirectorySeparatorChar);
            if (!string.Equals(directory, expected, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("Carry will only remove its own per-user install folder.");
            }
            if (!File.Exists(Path.Combine(directory, ".carry-installed")))
            {
                throw new InvalidOperationException("The Carry installation marker is missing.");
            }
        }

        private static string QuoteArgument(string value)
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }
    }
}

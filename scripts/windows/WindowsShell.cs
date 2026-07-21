using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace Carry.Windows
{
    internal static class WindowsShell
    {
        private const string ShortcutName = "Carry.lnk";
        internal const string ApplicationId = "Carry.Desktop";
        private static readonly Guid AppModelFormatId = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
        private static readonly PropertyKey AppModelIdKey = new PropertyKey(AppModelFormatId, 5);

        private delegate bool EnumWindowsCallback(IntPtr window, IntPtr state);

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr state);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr window);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr window, StringBuilder text, int maximumLength);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

        [DllImport("user32.dll")]
        private static extern bool PostMessage(
            IntPtr window,
            uint message,
            IntPtr wParam,
            IntPtr lParam);

        [DllImport("ole32.dll")]
        private static extern int PropVariantClear(ref PropVariant variant);

        internal static string StartMenuShortcutPath
        {
            get
            {
                return Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.Programs),
                    ShortcutName);
            }
        }

        internal static void CreateStartMenuShortcut(string executablePath, string workingDirectory)
        {
            CreateShortcut(StartMenuShortcutPath, executablePath, workingDirectory);
        }

        internal static void CreateShortcut(string shortcutPath, string executablePath, string workingDirectory)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(shortcutPath));

            IShellLinkW link = (IShellLinkW)new ShellLink();
            try
            {
                link.SetPath(executablePath);
                link.SetWorkingDirectory(workingDirectory);
                link.SetDescription("Secure peer-to-peer folder and agent-memory sync");
                link.SetIconLocation(executablePath, 0);
                link.SetArguments(string.Empty);
                SetStringProperty((IPropertyStore)link, AppModelIdKey, ApplicationId, true);
                ((IPersistFile)link).Save(shortcutPath, true);
            }
            finally
            {
                Marshal.FinalReleaseComObject(link);
            }
        }

        internal static void DeleteStartMenuShortcut()
        {
            string shortcutPath = StartMenuShortcutPath;
            if (File.Exists(shortcutPath))
            {
                File.Delete(shortcutPath);
            }
        }

        internal static void CloseCarryWindows()
        {
            EnumWindows(delegate(IntPtr window, IntPtr state)
            {
                if (IsCarryWindow(window))
                {
                    PostMessage(window, 0x0010, IntPtr.Zero, IntPtr.Zero);
                }
                return true;
            }, IntPtr.Zero);
        }

        internal static string ReadShortcutApplicationId(string shortcutPath)
        {
            IShellLinkW link = (IShellLinkW)new ShellLink();
            try
            {
                ((IPersistFile)link).Load(shortcutPath, 0);
                PropVariant value;
                PropertyKey key = AppModelIdKey;
                int result = ((IPropertyStore)link).GetValue(ref key, out value);
                if (result < 0)
                {
                    Marshal.ThrowExceptionForHR(result);
                }
                try
                {
                    return value.AsString();
                }
                finally
                {
                    PropVariantClear(ref value);
                }
            }
            finally
            {
                Marshal.FinalReleaseComObject(link);
            }
        }

        private static void SetStringProperty(
            IPropertyStore propertyStore,
            PropertyKey key,
            string text,
            bool commit)
        {
            PropVariant value = PropVariant.FromString(text);
            try
            {
                int result = propertyStore.SetValue(ref key, ref value);
                if (result < 0)
                {
                    Marshal.ThrowExceptionForHR(result);
                }
                if (commit)
                {
                    result = propertyStore.Commit();
                    if (result < 0)
                    {
                        Marshal.ThrowExceptionForHR(result);
                    }
                }
            }
            finally
            {
                PropVariantClear(ref value);
            }
        }

        private static bool IsCarryWindow(IntPtr window)
        {
            if (!IsWindowVisible(window))
            {
                return false;
            }
            StringBuilder title = new StringBuilder(64);
            GetWindowText(window, title, title.Capacity);
            if (!string.Equals(title.ToString(), "Carry", StringComparison.Ordinal))
            {
                return false;
            }

            uint processId;
            GetWindowThreadProcessId(window, out processId);
            try
            {
                using (Process process = Process.GetProcessById((int)processId))
                {
                    return string.Equals(process.ProcessName, "Carry", StringComparison.OrdinalIgnoreCase);
                }
            }
            catch
            {
                return false;
            }
        }
    }

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    internal struct PropertyKey
    {
        internal Guid FormatId;
        internal uint PropertyId;

        internal PropertyKey(Guid formatId, uint propertyId)
        {
            FormatId = formatId;
            PropertyId = propertyId;
        }
    }

    [StructLayout(LayoutKind.Explicit)]
    internal struct PropVariant
    {
        [FieldOffset(0)]
        private ushort valueType;
        [FieldOffset(8)]
        private IntPtr pointerValue;

        internal static PropVariant FromString(string value)
        {
            PropVariant variant = new PropVariant();
            variant.valueType = 31;
            variant.pointerValue = Marshal.StringToCoTaskMemUni(value);
            return variant;
        }

        internal string AsString()
        {
            if (valueType != 31 || pointerValue == IntPtr.Zero)
            {
                return null;
            }
            return Marshal.PtrToStringUni(pointerValue);
        }
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
    internal interface IPropertyStore
    {
        [PreserveSig]
        int GetCount(out uint propertyCount);
        [PreserveSig]
        int GetAt(uint propertyIndex, out PropertyKey key);
        [PreserveSig]
        int GetValue(ref PropertyKey key, out PropVariant value);
        [PreserveSig]
        int SetValue(ref PropertyKey key, ref PropVariant value);
        [PreserveSig]
        int Commit();
    }

    [ComImport]
    [Guid("00021401-0000-0000-C000-000000000046")]
    internal class ShellLink
    {
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("000214F9-0000-0000-C000-000000000046")]
    internal interface IShellLinkW
    {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int maxPath, IntPtr findData, uint flags);
        void GetIDList(out IntPtr itemIdList);
        void SetIDList(IntPtr itemIdList);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder description, int maxName);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string description);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder directory, int maxPath);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string directory);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder arguments, int maxPath);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string arguments);
        void GetHotkey(out short hotkey);
        void SetHotkey(short hotkey);
        void GetShowCmd(out int showCommand);
        void SetShowCmd(int showCommand);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder iconPath, int iconPathLength, out int iconIndex);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string iconPath, int iconIndex);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
        void Resolve(IntPtr windowHandle, uint flags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("0000010b-0000-0000-C000-000000000046")]
    internal interface IPersistFile
    {
        void GetClassID(out Guid classId);
        [PreserveSig]
        int IsDirty();
        void Load([MarshalAs(UnmanagedType.LPWStr)] string fileName, uint mode);
        void Save([MarshalAs(UnmanagedType.LPWStr)] string fileName, bool remember);
        void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string fileName);
        void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string fileName);
    }
}

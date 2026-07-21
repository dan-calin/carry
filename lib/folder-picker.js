'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const WINDOWS_FOLDER_PICKER_SOURCE = String.raw`
using System;
using System.Runtime.InteropServices;

namespace Carry
{
    public static class NativeFolderPicker
    {
        private const uint FosPickFolders = 0x00000020;
        private const uint FosForceFileSystem = 0x00000040;
        private const uint FosPathMustExist = 0x00000800;
        private const uint SigdnFileSystemPath = 0x80058000;
        private const int CancelledHResult = unchecked((int)0x800704C7);

        public static string Pick(string initialFolder)
        {
            IFileDialog dialog = null;
            IShellItem initialItem = null;
            IShellItem selectedItem = null;
            IntPtr selectedPath = IntPtr.Zero;

            try
            {
                dialog = (IFileDialog)new FileOpenDialog();

                uint options;
                dialog.GetOptions(out options);
                dialog.SetOptions(options | FosPickFolders | FosForceFileSystem | FosPathMustExist);
                dialog.SetTitle("Select Folder");
                dialog.SetOkButtonLabel("Select Folder");

                if (!String.IsNullOrWhiteSpace(initialFolder))
                {
                    Guid shellItemId = typeof(IShellItem).GUID;
                    try
                    {
                        SHCreateItemFromParsingName(initialFolder, IntPtr.Zero, ref shellItemId, out initialItem);
                        dialog.SetFolder(initialItem);
                    }
                    catch (COMException)
                    {
                        // Windows will use its normal default location if the suggested folder disappears.
                    }
                }

                int result = dialog.Show(IntPtr.Zero);
                if (result == CancelledHResult)
                {
                    return null;
                }
                if (result != 0)
                {
                    Marshal.ThrowExceptionForHR(result);
                }

                dialog.GetResult(out selectedItem);
                selectedItem.GetDisplayName(SigdnFileSystemPath, out selectedPath);
                return Marshal.PtrToStringUni(selectedPath);
            }
            finally
            {
                if (selectedPath != IntPtr.Zero)
                {
                    Marshal.FreeCoTaskMem(selectedPath);
                }
                if (selectedItem != null)
                {
                    Marshal.FinalReleaseComObject(selectedItem);
                }
                if (initialItem != null)
                {
                    Marshal.FinalReleaseComObject(initialItem);
                }
                if (dialog != null)
                {
                    Marshal.FinalReleaseComObject(dialog);
                }
            }
        }

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
        private static extern void SHCreateItemFromParsingName(
            [MarshalAs(UnmanagedType.LPWStr)] string path,
            IntPtr bindingContext,
            ref Guid interfaceId,
            [MarshalAs(UnmanagedType.Interface)] out IShellItem shellItem);

        [ComImport]
        [Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
        private class FileOpenDialog
        {
        }

        [ComImport]
        [Guid("42F85136-DB7E-439C-85F1-E4075D135FC8")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IFileDialog
        {
            [PreserveSig]
            int Show(IntPtr parent);
            void SetFileTypes(uint count, IntPtr filterSpecs);
            void SetFileTypeIndex(uint fileTypeIndex);
            void GetFileTypeIndex(out uint fileTypeIndex);
            void Advise(IntPtr events, out uint cookie);
            void Unadvise(uint cookie);
            void SetOptions(uint options);
            void GetOptions(out uint options);
            void SetDefaultFolder(IShellItem shellItem);
            void SetFolder(IShellItem shellItem);
            void GetFolder(out IShellItem shellItem);
            void GetCurrentSelection(out IShellItem shellItem);
            void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
            void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
            void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
            void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
            void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
            void GetResult(out IShellItem shellItem);
            void AddPlace(IShellItem shellItem, uint placement);
            void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
            void Close(int result);
            void SetClientGuid(ref Guid clientGuid);
            void ClearClientData();
            void SetFilter(IntPtr filter);
        }

        [ComImport]
        [Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IShellItem
        {
            void BindToHandler(IntPtr bindingContext, ref Guid handlerId, ref Guid interfaceId, out IntPtr result);
            void GetParent(out IShellItem shellItem);
            void GetDisplayName(uint displayName, out IntPtr name);
            void GetAttributes(uint attributeMask, out uint attributes);
            void Compare(IShellItem shellItem, uint hint, out int order);
        }
    }
}
`;

function resolveFolder(value, cwd) {
  const raw = String(value || '').trim().replace(/^"|"$/g, '');
  if (!raw) throw new Error('no folder was selected');
  return path.resolve(cwd || process.cwd(), raw);
}

// Use Windows' Explorer-style folder picker without adding a package dependency.
// The initial path is passed through the environment, never interpolated into
// PowerShell source, so special characters cannot become script input.
function browse(initialFolder) {
  if (process.platform !== 'win32') return null;
  const script = [
    "$source = @'",
    WINDOWS_FOLDER_PICKER_SOURCE,
    "'@",
    'Add-Type -TypeDefinition $source -Language CSharp',
    '$selected = [Carry.NativeFolderPicker]::Pick($env:CARRY_PICKER_INITIAL)',
    'if ($selected) { [Console]::Out.Write($selected) }',
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-STA', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, CARRY_PICKER_INITIAL: path.resolve(initialFolder || process.cwd()) },
  });
  if (result.error) throw new Error('Windows folder picker could not open: ' + result.error.message);
  if (result.status !== 0) throw new Error('Windows folder picker failed');
  const selected = String(result.stdout || '').trim();
  return selected ? path.resolve(selected) : null;
}

module.exports = { resolveFolder, browse };

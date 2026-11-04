// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from 'node:child_process'

export function windowsSaveDialog(directory: string, name: string): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.reject(new Error('The local Save As dialog requires Windows.'))
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

public sealed class ScanRulerDialogOwner : IWin32Window {
  [StructLayout(LayoutKind.Sequential)]
  private struct Rect { public int Left, Top, Right, Bottom; }
  private delegate bool EnumWindow(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] private static extern bool EnumThreadWindows(uint thread, EnumWindow callback, IntPtr parameter);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder name, int length);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll", SetLastError = true)] private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
  public IntPtr Handle { get; private set; }

  public ScanRulerDialogOwner() : this(GetForegroundWindow()) {}

  public ScanRulerDialogOwner(IntPtr window) {
    Handle = window;
    if (Handle == IntPtr.Zero) throw new InvalidOperationException("No foreground browser window is available to own Save As.");
  }

  public bool CenterDialog() {
    bool centered = false;
    var area = Screen.FromHandle(Handle).WorkingArea;
    EnumThreadWindows(GetCurrentThreadId(), delegate(IntPtr window, IntPtr parameter) {
      var name = new StringBuilder(256);
      GetClassName(window, name, name.Capacity);
      if (name.ToString() != "#32770" || !IsWindowVisible(window)) return true;
      Rect rect;
      if (!GetWindowRect(window, out rect)) throw new InvalidOperationException("Could not read the Save As dialog bounds.");
      int x = area.Left + Math.Max(0, (area.Width - (rect.Right - rect.Left)) / 2);
      int y = area.Top + Math.Max(0, (area.Height - (rect.Bottom - rect.Top)) / 2);
      // Move only this process's dialog, without resizing or changing activation.
      if (!SetWindowPos(window, IntPtr.Zero, x, y, 0, 0, 0x0015))
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      centered = true;
      return false;
    }, IntPtr.Zero);
    return centered;
  }
}
'@
if ([ScanRulerDialogOwner]::SetThreadDpiAwarenessContext([IntPtr](-4)) -eq [IntPtr]::Zero) {
  throw 'Could not enable per-monitor DPI awareness for Save As.'
}
$owner = New-Object ScanRulerDialogOwner
$dialog = New-Object System.Windows.Forms.SaveFileDialog
$dialog.Title = if ($env:SCANRULER_SAVE_EXT -eq 'scanruler') { 'Save ScanRuler project' } else { 'Export ScanRuler file' }
$dialog.InitialDirectory = $env:SCANRULER_SAVE_DIRECTORY
$dialog.FileName = $env:SCANRULER_SAVE_NAME
$dialog.Filter = $env:SCANRULER_SAVE_FILTER
$dialog.DefaultExt = $env:SCANRULER_SAVE_EXT
$dialog.AddExtension = $true
$dialog.OverwritePrompt = $true
$dialog.CheckPathExists = $true
$positionTimer = New-Object System.Windows.Forms.Timer
# The native dialog finishes its initial layout after becoming visible.
$positionTimer.Interval = 200
$positionTimer.add_Tick({
  if ($owner.CenterDialog()) { $positionTimer.Stop() }
})
try {
  $positionTimer.Start()
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($dialog.FileName)))
  }
} finally { $positionTimer.Dispose(); $dialog.Dispose() }
`
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      windowsHide: true,
      env: {
        ...process.env, SCANRULER_SAVE_DIRECTORY: directory, SCANRULER_SAVE_NAME: name,
        SCANRULER_SAVE_EXT: name.slice(name.lastIndexOf('.') + 1).toLowerCase(),
        SCANRULER_SAVE_FILTER: `ScanRuler ${name.endsWith('.scanruler') ? 'project' : 'export'} (*${name.slice(name.lastIndexOf('.'))})|*${name.slice(name.lastIndexOf('.'))}`,
      },
    }, (error, stdout, stderr) => {
      if (error) { reject(new Error(`Save As dialog failed: ${stderr || error.message}`)); return }
      resolve(stdout.trim() ? Buffer.from(stdout.trim(), 'base64').toString('utf8') : null)
    })
  })
}

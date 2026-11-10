// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it.skipIf(process.platform !== 'win32').each(['scanruler', 'step'])('centers native .%s Save As on each owner monitor and cancels without writing', async (extension) => {
  const source = await readFile(new URL('../scripts/windowsSaveDialog.ts', import.meta.url), 'utf8')
  const nativeScript = /const script = `([\s\S]*?)`/.exec(source)?.[1]
  if (!nativeScript) throw new Error('The native dialog script was not found.')
  const script = nativeScript.replace('$owner = New-Object ScanRulerDialogOwner',
    '$owner = New-Object ScanRulerDialogOwner -ArgumentList $testWindow.Handle')
  const harness = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DialogProbe {
  private delegate bool EnumWindow(IntPtr window, IntPtr parameter);
  [StructLayout(LayoutKind.Sequential)]
  public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] private static extern bool EnumThreadWindows(uint thread, EnumWindow callback, IntPtr parameter);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder name, int length);
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  public static Rect Bounds;
  public static System.Drawing.Rectangle OwnerArea;
  public static bool Cancel(bool waitForCenter) {
    bool found = false;
    EnumThreadWindows(GetCurrentThreadId(), delegate(IntPtr window, IntPtr parameter) {
      var name = new StringBuilder(256);
      GetClassName(window, name, name.Capacity);
      if (name.ToString() != "#32770") return true;
      GetWindowRect(window, out Bounds);
      int x = OwnerArea.Left + Math.Max(0, (OwnerArea.Width - (Bounds.Right - Bounds.Left)) / 2);
      int y = OwnerArea.Top + Math.Max(0, (OwnerArea.Height - (Bounds.Bottom - Bounds.Top)) / 2);
      if (waitForCenter && (Bounds.Left != x || Bounds.Top != y)) return true;
      PostMessage(window, 0x0010, IntPtr.Zero, IntPtr.Zero);
      found = true;
      return false;
    }, IntPtr.Zero);
    return found;
  }
}
'@
$null = [DialogProbe]::SetThreadDpiAwarenessContext([IntPtr](-4))
$results = @()
foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
  $testWindow = New-Object System.Windows.Forms.Form
  $testWindow.Text = 'ScanRuler dialog placement test'
  $testWindow.StartPosition = 'Manual'
  $testWindow.Location = $screen.WorkingArea.Location
  $testWindow.Size = New-Object System.Drawing.Size(400, 300)
  $testWindow.Show()
  $testWindow.Activate()
  $null = [DialogProbe]::SetForegroundWindow($testWindow.Handle)
  [System.Windows.Forms.Application]::DoEvents()
  $cancelTimer = New-Object System.Windows.Forms.Timer
  [DialogProbe]::OwnerArea = $screen.WorkingArea
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  $cancelTimer.Interval = 100
  $cancelTimer.add_Tick({
    if ([DialogProbe]::Cancel([DateTime]::UtcNow -lt $deadline)) { $cancelTimer.Stop() }
  })
  try {
    $cancelTimer.Start()
    & ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(script).toString('base64')}'))))
    $rect = [DialogProbe]::Bounds
    $area = $screen.WorkingArea
    $results += @{
      x = $rect.Left; y = $rect.Top
      expectedX = $area.Left + [Math]::Max(0, [int][Math]::Floor(($area.Width - ($rect.Right - $rect.Left)) / 2))
      expectedY = $area.Top + [Math]::Max(0, [int][Math]::Floor(($area.Height - ($rect.Bottom - $rect.Top)) / 2))
    }
  } finally { $cancelTimer.Dispose(); $testWindow.Dispose() }
}
ConvertTo-Json -Compress -InputObject @($results)
`
  const { stdout, stderr } = await promisify(execFile)('powershell.exe', [
    '-NoProfile', '-STA', '-EncodedCommand', Buffer.from(harness, 'utf16le').toString('base64'),
  ], {
    windowsHide: true,
    timeout: 45_000,
    env: {
      ...process.env, SCANRULER_SAVE_DIRECTORY: process.env.TEMP, SCANRULER_SAVE_NAME: `placement-test.${extension}`,
      SCANRULER_SAVE_EXT: extension, SCANRULER_SAVE_FILTER: `Test (*.${extension})|*.${extension}`,
    },
  })
  expect(stderr).toBe('')
  const results: { x: number; y: number; expectedX: number; expectedY: number }[] = JSON.parse(stdout)
  expect(results.length).toBeGreaterThan(0)
  for (const result of results) {
    expect(result.x).toBe(result.expectedX)
    expect(result.y).toBe(result.expectedY)
  }
  console.info(`Verified native Save As centering on ${results.length} monitors.`)
}, 60_000)

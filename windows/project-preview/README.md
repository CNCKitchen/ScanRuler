<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Windows `.scanruler` saved-preview handler

Optional **x64 Windows Explorer COM preview handler**, implemented in C# with
Windows Forms and the installed .NET Framework 4 compiler. This is native
Windows shell integration, not a C++ DLL or browser viewer. No NuGet packages,
SDK, Visual Studio, installer, file opener, thumbnail provider, or changes to
other file types are required.

**Building and testing never register anything. Registration requires explicit
permission and a separate, opt-in command.** The unit tests run without
registration. On one UAC-disabled machine, a machine-scope registration was
activated out of process (`CLSCTX_LOCAL_SERVER`) in its own `prevhost.exe`
and rendered a real browser-saved project. Explorer's own preview pane,
low-integrity `prevhost`, Explorer policy settings and real-world shell lifetime
behaviour have not been verified automatically.
Manual validation also confirmed the embedded image appears in the standard
Windows Open dialog's preview pane. This does not establish support for every
Windows shell host or security configuration.

## Build and tests

Run in 64-bit Windows PowerShell, on x64 Windows with .NET Framework 4 installed:

```powershell
.\build.ps1 -Test
```

Default output is this directory's ignored `bin`. To keep all compiled output
outside the worktree, select an existing persistent directory:

```powershell
.\build.ps1 -Test -OutputDirectory 'C:\Build\ScanRulerProjectPreview'
```

The script invokes
`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`, compiles
`ScanRuler.ProjectPreview.dll` and the standalone test executable, and runs tests
without installing dependencies. Tests create brief isolated Windows Forms
hosts, not browser windows or an existing ScanRuler session.

Coverage includes stored PNGs, skipped deflated JSON, legacy projects, ZIP/PNG
corruption and checksums, encrypted/data-descriptor/unsupported compression
rejection, encoded-size and dimension limits, short reads, bounded header counts,
a synthetic sparse 1 GiB scan with measured bounded reads, aspect-fit painting
and borders, resize/reparent/focus/accelerator behavior, error UI and Trace,
and repeated unload. The COM harness creates a **managed instance**, obtains its
COM callable wrapper using `QueryInterface`, and invokes the native COM vtable
with a real native `IStream` and window handles. It does **not** call
`CoCreateInstance` or prove registered Explorer activation.

Registration-plan tests check the managed COM entries, dedicated preview host,
extension-only association and consent guard without opening or writing the
registry. The ownership-restoration algorithm is tested against an in-memory
backend, including restoration of original types and preservation of externally
changed/removed values. Registration/unregistration against Windows itself is
intentionally not part of the test suite.

## File contract and limits

- Read-only, seekable `IInitializeWithStream` input. No filenames are opened,
  no files are extracted, no project is modified and no model is rebuilt.
- ZIP local headers without data descriptors, as produced by `fflate.zipSync`.
  `project.json` must be first. Writers should store `preview.png` second with
  compression method **0**; the reader also accepts it later by seeking over
  other members. Other members may use method 0 or 8, but are never inflated.
- The ZIP end record is checked first with at most 65,557 bytes of tail reads.
  At most 4,096 local members and 2 MiB of cumulative local header/name/extra
  bytes are accepted; member names are limited to 4,096 bytes.
- Multi-disk, ZIP64, encryption, data descriptors, unknown flags/compression,
  impossible offsets/sizes and truncated headers are rejected explicitly.
- PNG is limited to **8 MiB encoded** and **2,048 pixels per dimension**.
  IHDR dimensions are checked before decoding. ZIP CRC and PNG chunk CRCs and
  bounds are checked. Animated PNG and unknown critical chunks are rejected.
  Only pixel-related PNG chunks reach GDI+; compressed profiles/text are
  discarded to avoid metadata inflation unrelated to image dimensions.
- Once a valid preview is found, the reader stops. It is not a general ZIP or
  project validator and does not verify later scan payloads or their checksums.
  A legacy result requires the remaining local headers and central-directory
  structure to be coherent. Missing previews are not synthesized:

  > No saved preview. Open and save this project in a preview-enabled ScanRuler version.

- Errors instead display “Unable to display saved preview” with a bounded,
  non-sensitive explanation. Exceptions are reported through standard
  `System.Diagnostics.Trace`; the handler does not create log files.
- The image is aspect-fit to the entire current pane, including enlargement,
  with an 8-pixel margin and image/outer borders. Its original aspect ratio is
  retained through resize/maximize. Decoded images, GDI resources and HWNDs are
  disposed on unload. The caller-owned stream is not forcibly released.

## Registration — only with permission

Registration copies the supplied build DLL into
`%LOCALAPPDATA%\ScanRuler\ProjectPreview\<SHA256>\ScanRuler.ProjectPreview.dll`
and verifies its SHA256 **before** registry writes. The registered CodeBase
points to that persistent copy, never the build/session output. Existing
different files are never overwritten; an existing identical file is not claimed
as owned. The default persistent backup is
`%LOCALAPPDATA%\ScanRuler\ProjectPreview\registration-backup.clixml`.
Keep Windows/.NET patched. This is a
managed handler running in a dedicated `prevhost.exe` COM surrogate. Managed COM
objects are agile, so surrogate calls arrive on RPC worker threads that do not
pump messages. The handler therefore keeps its pane on its own STA thread with a
message loop and stops that thread on `Unload`. Process and
decoder memory overhead is additional to the bounded encoded/pixel buffers.
It is **not** validated for 32-bit Explorer or native ARM64 Explorer.

Inspect the no-side-effects plan first (safe without registry permission):

```powershell
.\Register-Preview.ps1 -Action Plan -AssemblyPath '.\bin\ScanRuler.ProjectPreview.dll'
```

After permission, run **64-bit PowerShell as the current user, not elevated**:

```powershell
.\Register-Preview.ps1 -Action Register -AllowRegistryChanges `
  -AssemblyPath '.\bin\ScanRuler.ProjectPreview.dll'
```

Registration writes **HKCU, 64-bit registry view only**:

- `.scanruler\shellex\{8895B1C6-B41F-4C1C-A562-0D564250836F}` preview slot;
  extension defaults, open verbs, ProgID and `UserChoice` remain untouched.
- Handler CLSID `{B7D14566-0509-4CCE-A71F-0A2B1A87B76B}` with CLR registration:
  `InprocServer32=mscoree.dll`, `Class`, full `Assembly`, `RuntimeVersion`,
  absolute file-URI `CodeBase`, and apartment threading. The `CodeBase` is written
  unescaped (`file:///C:/Program Files/...`), as RegAsm writes it. With a
  percent-escaped path (`%20`), the CLR shim failed with `0x80070002` whenever
  the DLL was not already in the host's application folder.
- A **unique**, handler-owned AppID
  `{AE5AF77B-6FA1-4FF1-8C96-66938662D264}` and its `DllSurrogate` pointing to
  the Windows `System32\prevhost.exe`. It deliberately does not use the shared
  native preview-handler AppID.
- The handler's named value in the per-user `PreviewHandlers` list.

No system-wide keys, 3MF/STEP associations, default apps, Explorer policies or
preview-host integrity settings are changed. The script does not invoke Regasm,
restart Explorer or launch a surrogate. Enable Explorer's Preview pane yourself
if desired; reopening Explorer may be needed after a permitted registration.

### UAC disabled: machine COM scope

When UAC is disabled (`EnableLUA=0`), every process, including Explorer and file
dialogs, runs elevated. Microsoft documents that the COM runtime then ignores
per-user COM configuration, so the per-user CLSID cannot activate (`0x80070002`)
and Windows shows "This file can't be previewed." In that case, from an
administrator PowerShell, after unregistering any per-user registration:

```powershell
.\Register-Preview.ps1 -Action Register -AllowRegistryChanges -ComScope Machine `
  -AssemblyPath '.\bin\ScanRuler.ProjectPreview.dll'
```

This installs the DLL under `%ProgramFiles%\ScanRuler\ProjectPreview\<SHA256>` and
writes only this handler's CLSID and AppID under `HKLM\Software\Classes`. The
`.scanruler` preview slot and preview-handler list stay in HKCU. Unregister reads
the scope from the backup. See
[Merged view of HKEY_CLASSES_ROOT](https://learn.microsoft.com/en-us/windows/win32/sysinfo/merged-view-of-hkey-classes-root).

Every replaced value and its registry type is backed up **before** the first
write. Re-registration with an existing backup is refused. Do not lose or edit
the backup. `-WhatIf` is also supported.

After permission, unregister using that same backup, even if the DLL has moved:

```powershell
.\Register-Preview.ps1 -Action Unregister -AllowRegistryChanges `
  -BackupPath "$env:LOCALAPPDATA\ScanRuler\ProjectPreview\registration-backup.clixml"
```

Unregister restores/removes **only values still matching this registration**.
It leaves values another program subsequently changed or removed untouched,
reports conflicts and retains their backup. Only empty keys created by this
registration are removed. Once registry restoration succeeds without conflicts,
the installed DLL is removed only if this registration created it and its hash
still matches. Externally changed DLLs, preexisting identical DLLs, and files
locked by a running host are left untouched. Conflicts/locked files retain the
backup so unregistration can be retried after the host releases the file. Only
an empty version directory is removed; no installation tree is recursively
deleted. A failed registration attempts the same ownership-checked rollback.
Keep the backup if rollback/restoration is partial.

### Official interface/registration references

- [IPreviewHandler (including the separate AppID requirement for managed handlers)](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nn-shobjidl_core-ipreviewhandler)
- [Registering a preview handler](https://learn.microsoft.com/en-us/windows/win32/shell/how-to-register-a-preview-handler)
- [.NET Framework COM registration and mscoree](https://learn.microsoft.com/en-us/dotnet/standard/native-interop/registering-assemblies-with-com)

No third-party implementation source or new dependencies are included.

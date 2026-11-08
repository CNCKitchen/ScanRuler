; SPDX-License-Identifier: AGPL-3.0-only
; The Windows installer of the desktop app, compiled by scripts/make-installer.ts with Inno Setup: AppVersion, SourceDir (the packaged app), OutputDir, OutputBase (the installer's name without .exe) and Arch (x64compatible or arm64) are passed in on the command line.
#ifndef AppVersion
  #error AppVersion is not defined
#endif
#ifndef SourceDir
  #error SourceDir is not defined
#endif
#ifndef OutputDir
  #error OutputDir is not defined
#endif
#ifndef OutputBase
  #error OutputBase is not defined
#endif
#ifndef Arch
  #error Arch is not defined
#endif

[Setup]
AppId={{A0E1BC3B-D27B-460A-8552-E867D6A2D839}
AppName=ScanRuler
AppVersion={#AppVersion}
AppPublisher=CNC Kitchen
AppPublisherURL=https://scanruler.com/
DefaultDirName={autopf}\ScanRuler
DefaultGroupName=ScanRuler
DisableProgramGroupPage=yes
OutputDir={#OutputDir}
OutputBaseFilename={#OutputBase}
Compression=lzma2
SolidCompression=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed={#Arch}
ArchitecturesInstallIn64BitMode={#Arch}
UninstallDisplayIcon={app}\ScanRuler.exe

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\ScanRuler"; Filename: "{app}\ScanRuler.exe"

[Run]
Filename: "{app}\ScanRuler.exe"; Description: "Start ScanRuler"; Flags: nowait postinstall skipifsilent

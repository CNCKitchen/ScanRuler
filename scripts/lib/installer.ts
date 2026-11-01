// SPDX-License-Identifier: AGPL-3.0-only
// What goes into the desktop app's installers, as plain functions so it is tested without building one: the file names, the Debian control file and the desktop entry. scripts/make-installer.ts puts them to work.

export type Platform = 'darwin' | 'linux' | 'win32'
export type Arch = 'x64' | 'arm64'

/** The installer's name for a platform: a disk image, a Windows setup program, a Debian package. */
export function installerName(version: string, platform: Platform, arch: Arch): string {
  const base = `ScanRuler-${version}-${platform}-${arch}`
  if (platform === 'darwin') return `${base}.dmg`
  if (platform === 'win32') return `${base}-setup.exe`
  return `${base}.deb`
}

/** Debian's name for an architecture. */
export function debArch(arch: Arch): 'amd64' | 'arm64' {
  return arch === 'x64' ? 'amd64' : 'arm64'
}

/** Inno Setup's name for the architectures it installs on. */
export function innoArch(arch: Arch): 'x64compatible' | 'arm64' {
  return arch === 'x64' ? 'x64compatible' : 'arm64'
}

/** The libraries Electron needs at run time, which the package depends on so the package manager installs them (the alternatives are the names before and after Ubuntu 24.04's time_t transition). */
export const DEB_DEPENDS = [
  'libgtk-3-0t64 | libgtk-3-0',
  'libnotify4',
  'libnss3',
  'libxss1',
  'libxtst6',
  'xdg-utils',
  'libatspi2.0-0t64 | libatspi2.0-0',
  'libuuid1',
  'libgbm1',
  'libasound2t64 | libasound2',
] as const

export interface DebInfo {
  readonly version: string
  readonly arch: Arch
  readonly maintainer: string
  readonly homepage: string
}

/** The Debian control file. */
export function debControl(info: DebInfo): string {
  return [
    'Package: scanruler',
    `Version: ${info.version}`,
    'Section: science',
    'Priority: optional',
    `Architecture: ${debArch(info.arch)}`,
    `Maintainer: ${info.maintainer}`,
    `Depends: ${DEB_DEPENDS.join(', ')}`,
    `Homepage: ${info.homepage}`,
    'Description: Check a 3D scan against what it should have been',
    ' Fit spheres, cylinders and planes to a scan, paint its deviation from the CAD part,',
    ' map its wall thickness, and model it into a solid STEP body. Runs as a tray app with',
    ' a background server that agents can drive.',
    '',
  ].join('\n')
}

/** The menu entry that starts the app installed under /opt/ScanRuler. */
export function desktopEntry(): string {
  return ['[Desktop Entry]', 'Type=Application', 'Name=ScanRuler', 'Comment=Check a 3D scan against what it should have been', 'Exec=/opt/ScanRuler/ScanRuler', 'Icon=scanruler', 'Categories=Science;Engineering;', 'Terminal=false', ''].join('\n')
}

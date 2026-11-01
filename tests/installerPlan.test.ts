// SPDX-License-Identifier: AGPL-3.0-only
// What goes into the desktop app's installers (scripts/lib/installer.ts): the names, the Debian control file and the menu entry, checked without building an installer.

import { describe, expect, it } from 'vitest'
import { DEB_DEPENDS, debArch, debControl, desktopEntry, innoArch, installerName } from '../scripts/lib/installer'

describe('the installers', () => {
  it('are named by platform: a disk image, a setup program, a Debian package', () => {
    expect(installerName('1.2.3', 'darwin', 'arm64')).toBe('ScanRuler-1.2.3-darwin-arm64.dmg')
    expect(installerName('1.2.3', 'win32', 'x64')).toBe('ScanRuler-1.2.3-win32-x64-setup.exe')
    expect(installerName('1.2.3', 'linux', 'x64')).toBe('ScanRuler-1.2.3-linux-x64.deb')
  })

  it('use each tool\'s own name for an architecture', () => {
    expect(debArch('x64')).toBe('amd64')
    expect(debArch('arm64')).toBe('arm64')
    expect(innoArch('x64')).toBe('x64compatible')
    expect(innoArch('arm64')).toBe('arm64')
  })

  it('write a Debian control file that names the package, its architecture and what Electron needs', () => {
    const control = debControl({ version: '1.2.3', arch: 'arm64', maintainer: 'A Person <person@example.com>', homepage: 'https://example.com/' })
    expect(control).toContain('Package: scanruler\n')
    expect(control).toContain('Version: 1.2.3\n')
    expect(control).toContain('Architecture: arm64\n')
    expect(control).toContain('Maintainer: A Person <person@example.com>\n')
    expect(control).toContain(`Depends: ${DEB_DEPENDS.join(', ')}\n`)
    // A control file ends with a newline and continues a description with one leading space.
    expect(control.endsWith('\n')).toBe(true)
    expect(control.split('\n').filter((line) => line.startsWith(' ')).length).toBeGreaterThan(0)
  })

  it('give each Ubuntu-renamed library both names, so the package installs before and after the rename', () => {
    const renamed = DEB_DEPENDS.filter((name) => name.includes('t64'))
    expect(renamed.length).toBeGreaterThan(0)
    for (const name of renamed) expect(name).toMatch(/^\S+t64 \| \S+$/u)
  })

  it('write a menu entry that starts the installed app', () => {
    const entry = desktopEntry()
    expect(entry).toContain('Exec=/opt/ScanRuler/ScanRuler\n')
    expect(entry.startsWith('[Desktop Entry]\n')).toBe(true)
  })
})

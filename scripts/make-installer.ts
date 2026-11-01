// SPDX-License-Identifier: AGPL-3.0-only
// Make the desktop app's installer for the platform this runs on, from the packaged app (npm run package:electron): dist-installers/<platform>-<arch>/ gets a disk image on macOS (diskutil image), a setup program on Windows (Inno Setup, which both Windows runner images carry) or a Debian package on Linux (dpkg-deb). Each tool is the platform's own, so there is no packaging dependency to vet. The macOS app inside is signed ad hoc, and the Windows setup program is unsigned.
//
//   npm run make:installer

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import { debControl, desktopEntry, innoArch, installerName } from './lib/installer'
import { packageField } from './lib/package'
import { thisTarget } from './lib/target'

/** The project's address, which the Windows and Debian installers show. */
const HOMEPAGE = 'https://scanruler.com/'

/** The icon the Linux menu entry shows, drawn at this width from the mark's SVG. */
const MENU_ICON_PX = 512

/** The Windows program Inno Setup's compiler is, beside the installer folders a runner image uses. */
const INNO_COMPILER_DIRECTORIES = ['ProgramFiles(x86)', 'ProgramFiles', 'LOCALAPPDATA']

const root = fileURLToPath(new URL('..', import.meta.url))
const { platform, arch, name: target } = thisTarget()
const appDir = join(root, 'dist-electron', target, `ScanRuler-${target}`)
const outDir = join(root, 'dist-installers', target)

const packageJson = join(root, 'package.json')
const version = await packageField(packageJson, 'version')
const file = join(outDir, installerName(version, platform, arch))
if (!existsSync(appDir)) throw new Error(`${appDir} does not exist. Run npm run package:electron first.`)
await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

/** The sparse image is made with this many times the app's size as its ceiling: a sparse image allocates only what is written, and the compressed image holds only that, so a generous ceiling costs nothing, while APFS needs room for its metadata on top of the files. */
const SPARSE_CEILING_FACTOR = 2

/** The macOS disk image: the app beside a link to /Applications, as the Finder window shows it. It is built without hdiutil create, which is deprecated, and without diskutil image create from a folder, which macOS 15.3.1 rejects: a blank sparse image is made, mounted and filled, and then compressed into the final image, which diskutil image create from accepts on macOS 15 and on newer releases (the volume's name is the blank image's). */
async function makeDmg(): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), 'scanruler-dmg-'))
  const content = join(work, 'content')
  const mount = join(work, 'mount')
  const sparse = join(work, 'ScanRuler.sparsebundle')
  try {
    await mkdir(content)
    await mkdir(mount)
    // ditto keeps the bundle's symbolic links and extended attributes, which a plain copy loses and the signature needs.
    execFileSync('ditto', [join(appDir, 'ScanRuler.app'), join(content, 'ScanRuler.app')])
    await symlink('/Applications', join(content, 'Applications'))
    const kibibytes = Number(execFileSync('du', ['-sk', content], { encoding: 'utf8' }).split(/\s+/u)[0])
    execFileSync('diskutil', ['image', 'create', 'blank', '--format', 'UDSB', '--size', `${kibibytes * SPARSE_CEILING_FACTOR}k`, '--volumeName', 'ScanRuler', sparse], { stdio: 'inherit' })
    execFileSync('diskutil', ['image', 'attach', '--mountOptions', 'nobrowse', '--mountPoint', mount, sparse], { stdio: 'inherit' })
    try {
      execFileSync('ditto', [content, mount])
    } finally {
      execFileSync('diskutil', ['eject', mount], { stdio: 'inherit' })
    }
    execFileSync('diskutil', ['image', 'create', 'from', '--format', 'UDZO', sparse, file], { stdio: 'inherit' })
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

/** The Debian package: the app under /opt/ScanRuler, a command and a menu entry. Chromium's sandbox helper must be setuid root to work, so it is. */
async function makeDeb(): Promise<void> {
  const staging = await mkdtemp(join(tmpdir(), 'scanruler-deb-'))
  try {
    await cp(appDir, join(staging, 'opt', 'ScanRuler'), { recursive: true })
    // Debian policy: every directory in a package is 0755 whatever the build's umask or the copied directory's mode was (the staging root comes from mkdtemp, which is 0700).
    for (const directory of [staging, join(staging, 'opt'), join(staging, 'opt', 'ScanRuler')]) await chmod(directory, 0o755)
    await chmod(join(staging, 'opt', 'ScanRuler', 'chrome-sandbox'), 0o4755)
    await mkdir(join(staging, 'usr', 'bin'), { recursive: true })
    await symlink('/opt/ScanRuler/ScanRuler', join(staging, 'usr', 'bin', 'scanruler'))
    await mkdir(join(staging, 'usr', 'share', 'applications'), { recursive: true })
    await writeFile(join(staging, 'usr', 'share', 'applications', 'scanruler.desktop'), desktopEntry())
    const icons = join(staging, 'usr', 'share', 'icons', 'hicolor', `${MENU_ICON_PX}x${MENU_ICON_PX}`, 'apps')
    await mkdir(icons, { recursive: true })
    const mark = await readFile(join(root, 'public', 'scanruler-mark.svg'))
    await writeFile(join(icons, 'scanruler.png'), new Resvg(mark, { fitTo: { mode: 'width', value: MENU_ICON_PX } }).render().asPng())
    await mkdir(join(staging, 'DEBIAN'), { recursive: true })
    await writeFile(join(staging, 'DEBIAN', 'control'), debControl({ version, arch, maintainer: await packageField(packageJson, 'author'), homepage: HOMEPAGE }))
    execFileSync('fakeroot', ['dpkg-deb', '--root-owner-group', '-Zxz', '--build', staging, file], { stdio: 'inherit' })
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

/** Inno Setup's compiler: on PATH, or in the folders its installer uses. */
function innoCompiler(): string {
  const candidates = INNO_COMPILER_DIRECTORIES.flatMap((variable) => {
    const base = process.env[variable]
    return base === undefined ? [] : [join(base, 'Inno Setup 6', 'ISCC.exe'), join(base, 'Programs', 'Inno Setup 6', 'ISCC.exe')]
  })
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found === undefined) throw new Error(`Inno Setup's ISCC.exe is not in ${candidates.join(' or ')}`)
  return found
}

/** The Windows setup program, compiled from scripts/installer/windows.iss. */
function makeSetup(): void {
  const base = installerName(version, platform, arch).replace(/\.exe$/u, '')
  execFileSync(
    innoCompiler(),
    [`/DAppVersion=${version}`, `/DSourceDir=${appDir}`, `/DOutputDir=${outDir}`, `/DOutputBase=${base}`, `/DArch=${innoArch(arch)}`, join(dirname(fileURLToPath(import.meta.url)), 'installer', 'windows.iss')],
    { stdio: 'inherit' },
  )
}

if (platform === 'darwin') await makeDmg()
else if (platform === 'linux') await makeDeb()
else makeSetup()
if (!existsSync(file)) throw new Error(`the installer ${file} was not made`)
console.log(`Made ${file}`)

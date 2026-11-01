// SPDX-License-Identifier: AGPL-3.0-only
// Install the installer npm run make:installer made, for real, and run the installed app the way npm run smoke:electron runs the packaged one (it must start its server, load the page, make its tray, exit 0, and leave the server running), then uninstall and check the app is gone. macOS mounts the disk image, verifies the app's signature and copies it out; Windows runs the setup program silently into a folder of its own; Linux installs the Debian package with apt, which needs sudo. Run it where a display is available (under xvfb-run on Linux).
//
//   npm run smoke:installer

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installerName } from './lib/installer'
import { packageField } from './lib/package'
import { thisTarget } from './lib/target'

/** The Windows uninstaller deletes its own file through a helper process that runs after it exits, so for a moment the file is locked and removing the folder fails with EPERM; retrying for this long (retries times delay) outlasts the helper. */
const REMOVE_RETRIES = 25
const REMOVE_RETRY_MS = 200

const root = fileURLToPath(new URL('..', import.meta.url))
const { platform, arch, name: target } = thisTarget()
const version = await packageField(join(root, 'package.json'), 'version')
const file = join(root, 'dist-installers', target, installerName(version, platform, arch))
if (!existsSync(file)) throw new Error(`${file} does not exist. Run npm run make:installer first.`)

/** Runs the same smoke test as the packaged app's, against the installed copy at `exe`. */
function smokeInstalled(exe: string): void {
  // vite-node's own entry run by this Node, because the .bin shim is a shell script on Linux and macOS and a .cmd on Windows.
  execFileSync(process.execPath, [join(root, 'node_modules', 'vite-node', 'vite-node.mjs'), join(root, 'scripts', 'smoke-electron.ts')], { stdio: 'inherit', env: { ...process.env, SCANRULER_APP_EXE: exe } })
}

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`FAIL: ${what}`)
  console.log(`PASS: ${what}`)
}

const work = await mkdtemp(join(tmpdir(), 'scanruler-installed-'))
try {
  if (platform === 'darwin') {
    const mount = join(work, 'mount')
    await mkdir(mount)
    execFileSync('diskutil', ['image', 'attach', '--mountOptions', 'nobrowse', '--readOnly', '--mountPoint', mount, file], { stdio: 'inherit' })
    try {
      execFileSync('codesign', ['--verify', '--deep', '--strict', join(mount, 'ScanRuler.app')])
      check(true, 'the disk image holds a validly signed app')
      check(existsSync(join(mount, 'Applications')), 'and a link to /Applications')
      execFileSync('ditto', [join(mount, 'ScanRuler.app'), join(work, 'ScanRuler.app')])
    } finally {
      execFileSync('diskutil', ['eject', mount], { stdio: 'inherit' })
    }
    smokeInstalled(join(work, 'ScanRuler.app', 'Contents', 'MacOS', 'ScanRuler'))
  } else if (platform === 'win32') {
    const dir = join(work, 'ScanRuler')
    execFileSync(file, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/DIR=${dir}`], { stdio: 'inherit' })
    check(existsSync(join(dir, 'ScanRuler.exe')), 'the setup program installed the app')
    smokeInstalled(join(dir, 'ScanRuler.exe'))
    execFileSync(join(dir, 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { stdio: 'inherit' })
    check(!existsSync(join(dir, 'ScanRuler.exe')), 'and its uninstaller removed it')
  } else {
    execFileSync('sudo', ['apt-get', 'install', '-y', file], { stdio: 'inherit' })
    try {
      for (const installed of ['/opt/ScanRuler/ScanRuler', '/usr/share/applications/scanruler.desktop', '/usr/bin/scanruler']) check(existsSync(installed), `the package installed ${installed}`)
      smokeInstalled('/opt/ScanRuler/ScanRuler')
    } finally {
      execFileSync('sudo', ['apt-get', 'remove', '-y', 'scanruler'], { stdio: 'inherit' })
    }
    check(!existsSync('/opt/ScanRuler/ScanRuler'), 'and removing the package removed it')
  }
  console.log(`PASS: ${file}`)
} finally {
  await rm(work, { recursive: true, force: true, maxRetries: REMOVE_RETRIES, retryDelay: REMOVE_RETRY_MS })
}

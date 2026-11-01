// SPDX-License-Identifier: AGPL-3.0-only
// Run the packaged desktop app (npm run package:electron) with --smoke, in a config directory, a user-data directory and on a port of its own: it must start the background server, load the app into a hidden window, find the page titled ScanRuler, make its tray and exit 0. Then the background server it started must still be running after the app has gone (that is what backgrounding means), serve the app, and stop on request. Fails loudly on any step.
//
//   npm run smoke:electron   (on Linux under a display, for example xvfb-run -a npm run smoke:electron)

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { START_TIMEOUT_MS, status, stop } from '../mcp/src/daemon.js'
import { SMOKE_TIMEOUT_MS } from '../electron/shell'
import { thisTarget } from './lib/target'

const root = fileURLToPath(new URL('..', import.meta.url))
const { platform, name: target } = thisTarget()
const appDir = join(root, 'dist-electron', target, `ScanRuler-${target}`)
const executables = { darwin: join('ScanRuler.app', 'Contents', 'MacOS', 'ScanRuler'), win32: 'ScanRuler.exe', linux: 'ScanRuler' }
const exe = join(appDir, executables[platform])
if (!existsSync(exe)) {
  console.error(`FATAL: ${exe} does not exist. Run npm run package:electron first.`)
  process.exit(1)
}

/** A port nobody holds: the OS hands one out when asked for port 0, and it is given back at once. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the probe server has no port')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}
const port = await freePort()
const configDir = await mkdtemp(join(tmpdir(), 'scanruler-electron-config-'))
const userData = await mkdtemp(join(tmpdir(), 'scanruler-electron-user-'))
const env = { ...process.env, SCANRULER_MCP_CONFIG_DIR: configDir, SCANRULER_MCP_PORT: String(port) }
process.env.SCANRULER_MCP_CONFIG_DIR = configDir
function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`FAIL: ${what}`)
  console.log(`PASS: ${what}`)
}

try {
  if (platform === 'darwin') {
    // An ad hoc signature with the hardened runtime is refused by a real Mac (library validation will not load the app's own frameworks), though a CI runner lets it through, so the flag itself is checked, on the app and on its framework.
    const app = exe.slice(0, exe.indexOf('.app') + '.app'.length)
    for (const signed of [app, join(app, 'Contents', 'Frameworks', 'Electron Framework.framework')]) {
      const flags = /flags=\S+\(([^)]*)\)/.exec(spawnSync('codesign', ['-dv', signed], { encoding: 'utf8' }).stderr)?.[1]
      check(flags !== undefined && flags.includes('adhoc') && !flags.includes('runtime'), `${signed.slice(signed.lastIndexOf('/') + 1)} is signed ad hoc without the hardened runtime`)
    }
  }
  // Chromium's sandbox needs a setuid helper that a CI runner's unpacked app does not have.
  const flags = ['--smoke', `--user-data-dir=${userData}`, ...(platform === 'linux' ? ['--no-sandbox'] : [])]
  const child = spawn(exe, flags, { env, stdio: 'inherit' })
  const code = await new Promise<number | null>((resolve, reject) => {
    // The shell waits at most SMOKE_TIMEOUT_MS for the page, after the server has come up within START_TIMEOUT_MS.
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`FAIL: the app did not exit within ${(SMOKE_TIMEOUT_MS + START_TIMEOUT_MS) / 1000} seconds`))
    }, SMOKE_TIMEOUT_MS + START_TIMEOUT_MS)
    child.once('exit', (exitCode) => {
      clearTimeout(timer)
      resolve(exitCode)
    })
    child.once('error', reject)
  })
  check(code === 0, 'the app started its server, loaded the page into a hidden window, made its tray and exited 0')
  const state = await status({ port, dir: configDir })
  check(state.running === true, 'the background server it started is still running after the app has exited')
  const page = await fetch(`http://127.0.0.1:${port}/`)
  check(page.ok && (await page.text()).includes('<title>ScanRuler'), 'and it serves the app')
  check((await stop({ dir: configDir })) === true, 'and it stops on request')
  check((await status({ port, dir: configDir })).running === false, 'after which it is gone')
  console.log(`PASS: ${exe}`)
} finally {
  await stop({ dir: configDir }).catch(() => false)
  await rm(configDir, { recursive: true, force: true })
  await rm(userData, { recursive: true, force: true })
}

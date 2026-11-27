// SPDX-License-Identifier: AGPL-3.0-only
// Starts the desktop app on a spare debugging port and checks what the page
// sees: cross-origin isolation, thread count, WebGL2 and WebGPU.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'
import assert from 'node:assert/strict'

const electron = createRequire(import.meta.url)('electron')
// Its own user data: the single-instance lock is per profile, so an installed app stays untouched.
const userData = `--user-data-dir=${mkdtempSync(join(tmpdir(), 'scanruler-test-'))}`
const port = 9333
const exe = process.env.APP_EXE
const child = spawn(exe ?? electron, [...(exe ? [] : ['.']), `--remote-debugging-port=${port}`, userData], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, SCANRULER_MCP_PORT: '7399' },
  stdio: 'inherit',
})
const stop = () => child.kill()
process.on('exit', stop)

try {
  let browser
  for (let i = 0; i < 60 && !browser; i++) {
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` }).catch(() => null)
    if (!browser) await new Promise((r) => setTimeout(r, 500))
  }
  assert(browser, 'app did not expose the debugging port')
  let page
  for (let i = 0; i < 60 && !page; i++) {
    page = (await browser.pages()).find((p) => p.url().startsWith('http://127.0.0.1:7399/'))
    if (!page) await new Promise((r) => setTimeout(r, 500))
  }
  assert(page, 'main window never loaded the local app')
  await page.waitForSelector('#root *', { timeout: 30000 })
  const info = await page.evaluate(async () => ({
    isolated: crossOriginIsolated,
    threads: navigator.hardwareConcurrency,
    webgl2: !!new OffscreenCanvas(1, 1).getContext('webgl2'),
    webgpu: !!(navigator.gpu && (await navigator.gpu.requestAdapter())),
  }))
  console.log(info)
  assert.equal(info.isolated, true, 'crossOriginIsolated')
  assert(info.threads >= 4, 'threads')
  assert(info.webgl2, 'webgl2')
  assert(info.webgpu, 'webgpu')
  console.log('smoke ok')
  await browser.disconnect()
} finally {
  stop()
}

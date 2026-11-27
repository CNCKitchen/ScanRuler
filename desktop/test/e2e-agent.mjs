// SPDX-License-Identifier: AGPL-3.0-only
// End to end: the app pairs with the agent link; an MCP client reaches the page through the relay.
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
const app = spawn(electron, ['.', '--remote-debugging-port=9334', userData], { cwd: new URL('..', import.meta.url), env: { ...process.env, SCANRULER_MCP_PORT: '7398' }, stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let mcp
try {
  let browser
  for (let i = 0; i < 60 && !browser; i++) { browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9334' }).catch(() => null); if (!browser) await sleep(500) }
  let page
  for (let i = 0; i < 60 && !page; i++) { page = (await browser.pages()).find((p) => p.url().startsWith('http://127.0.0.1:7398/')); if (!page) await sleep(500) }
  await page.waitForSelector('#root *', { timeout: 30000 })
  await sleep(1500)
  const buttons = await page.$$eval('button', (b) => b.map((x) => x.textContent.trim()).filter(Boolean))
  console.log('buttons:', buttons.slice(0, 12))
  const accept = await page.evaluateHandle(() => [...document.querySelectorAll('button')].find((b) => /accept|connect|conectar|aceit|understand/i.test(b.textContent)))
  if (accept.asElement()) await accept.asElement().click()
  await sleep(2000)
  mcp = spawn(process.execPath, ['../mcp/bin/scanruler-mcp.js', '--port', '7398', '--no-update'], { stdio: ['pipe', 'pipe', 'inherit'] })
  const send = (o) => mcp.stdin.write(JSON.stringify(o) + '\n')
  let buf = ''
  const replies = new Map()
  mcp.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); replies.set(m.id, m) } })
  const call = async (id, method, params) => { send({ jsonrpc: '2.0', id, method, params }); for (let i = 0; i < 60 && !replies.has(id); i++) await sleep(250); return replies.get(id) }
  await call(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } })
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  const r = await call(2, 'tools/call', { name: 'scanruler_status', arguments: {} })
  const text = JSON.stringify(r)
  console.log(text.slice(0, 600))
  assert(/connected|page/i.test(text))
} finally { mcp?.kill(); app.kill() }

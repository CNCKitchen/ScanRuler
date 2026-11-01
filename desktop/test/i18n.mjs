// SPDX-License-Identifier: AGPL-3.0-only
// The page is translated, stays translated as React redraws, and goes back to English.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'
import assert from 'node:assert/strict'

const electron = createRequire(import.meta.url)('electron')
// Its own user data: the single-instance lock is per profile, so an installed app stays untouched.
const userData = `--user-data-dir=${mkdtempSync(join(tmpdir(), 'scanruler-test-'))}`
const dict = JSON.parse(readFileSync(new URL('../i18n/pt-BR.json', import.meta.url), 'utf8'))
const child = spawn(electron, ['.', '--remote-debugging-port=9337', userData], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, SCANRULER_MCP_PORT: '7395' },
  stdio: 'ignore',
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const text = (page) => page.evaluate(() => document.body.textContent)
try {
  let browser
  for (let i = 0; i < 60 && !browser; i++) { browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9337' }).catch(() => null); if (!browser) await sleep(500) }
  let page
  for (let i = 0; i < 60 && !page; i++) { page = (await browser.pages()).find((p) => p.url().startsWith('http://127.0.0.1:7395/')); if (!page) await sleep(500) }
  await page.waitForSelector('#root *', { timeout: 30000 }); await sleep(2500)
  let t = await text(page)
  assert(t.includes(dict['Wall Thickness']), 'tab translated')
  assert(!/\bWall Thickness\b/.test(t), 'no English tab left')
  // a click makes React draw new text; it must arrive translated
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /Espessura|Wall/i.test(b.textContent))?.click())
  await sleep(800)
  t = await text(page)
  assert(t.includes(dict['Measure wall thickness']), 'panel drawn after a click is translated')
  // back to English restores everything
  await page.evaluate(() => window.__srI18n.set(null))
  await sleep(300)
  t = await text(page)
  assert(t.includes('Measure wall thickness') && !t.includes(dict['Measure wall thickness']), 'English restored')
  // Short or unchanged values ("Auto") also occur inside English words, so only count real translations.
  const left = Object.entries(dict).filter(([k, v]) => v !== k && v.length > 12 && t.includes(v))
  assert.equal(left.length, 0, `Portuguese left after restore: ${left.map(([, v]) => v).join(' | ')}`)
  console.log('i18n ok')
  await browser.disconnect()
} finally { child.kill() }

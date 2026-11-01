// SPDX-License-Identifier: AGPL-3.0-only
// Plugin note styles must not move a 2D note away from its clicked anchor.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPng } from './e2e-flat-fixture.mjs'
import { launchApp, check, finish, sleep, click } from './e2e-lib.mjs'
const fixture = join(mkdtempSync(join(tmpdir(), 'scanruler-note-style-')), 'sheet.png')
writeFileSync(fixture, buildPng())
const { browser, page, consoleErrors } = await launchApp({ width: 1440, height: 900 })
try {
  await page.click('[data-test=workspace-flat]')
  await (await page.$('input[type=file][accept*=".png"]')).uploadFile(fixture)
  await page.waitForFunction(() => /chains found/.test(document.querySelector('[data-test=flat-edge-status]')?.textContent ?? ''))
  await click(page, '[data-test=flat-fit-text]')
  const at = await page.$eval('.viewslot:not([hidden]) .viewport canvas:not(.loupe)', el => {
    const r = el.getBoundingClientRect()
    return [r.x + r.width * .55, r.y + r.height * .4]
  })
  await page.mouse.click(...at)
  await page.waitForSelector('[data-test=flat-note-text]')
  await page.type('[data-test=flat-note-text]', 'Placed here')
  await sleep(150)
  const anchor = await page.$eval('[data-test=flat-note-1]', el => {
    const r = el.getBoundingClientRect()
    return [r.left, r.bottom]
  })
  const delta = anchor.map((v, i) => v - at[i])
  console.log(`Note anchor offset: x=${delta[0].toFixed(3)} px, y=${delta[1].toFixed(3)} px`)
  check(delta.every(v => Math.abs(v) < 1), '2D note stays at its clicked lower-left anchor with reverse plugin styles loaded')
} finally { await finish(browser, consoleErrors) }

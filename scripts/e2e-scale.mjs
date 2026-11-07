// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end test for Scale part: drives the real app in headless Chrome —
// loads ballbar.stl, fits both balls and the distance between their centres,
// then scales the scan so that distance reads twice as long, through the
// Scale part box of the Alignment group. Checks the dimension reads true
// after it, the record says how it was scaled, and undo reads the scan back
// at its old size. Ends with the two-point row: its hint, and Esc.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node scripts/e2e-scale.mjs
// Env: CHROME (chrome.exe path), APP_URL, STL (scan path).
import {
  canvasRect,
  check,
  click,
  fieldSetter,
  finish,
  fitBall,
  launchApp,
  loadScan,
  MOD,
  repoFile,
  selectByLabel,
  sleep,
} from './e2e-lib.mjs'

const STL = process.env.STL ?? repoFile('ballbar.stl')

const { browser, page, consoleErrors } = await launchApp()
await loadScan(page, STL)
const rect = await canvasRect(page)
const setText = fieldSetter(page)

const bodyHas = (t, timeout = 60_000) =>
  page.waitForFunction((s) => (document.body.innerText ?? '').includes(s), { timeout }, t).then(() => true).catch(() => false)
const text = (sel) => page.$eval(sel, (el) => el.textContent ?? '').catch(() => null)
const exists = async (sel) => (await page.$(sel)) !== null
/** The value a dimension row reads, mm: the number over its unit. */
const rowMm = async () => {
  const t = await page.$eval('[data-test="dimension-row"]', (el) => el.innerText).catch(() => '')
  const m = /^(-?\d+\.\d+)\s*\n\s*mm\s*$/im.exec(t)
  return m ? Number(m[1]) : NaN
}

check(Boolean(await fitBall(page, rect, false, 1)), 'Sphere 1 fitted')
check(Boolean(await fitBall(page, rect, true, 2)), 'Sphere 2 fitted')

await click(page, '[data-test="new-dimension"]')
await page.select('[data-test="dim-type"]', 'dist-point-point')
await sleep(150)
await selectByLabel(page, '[data-test="dim-ref-0"]', 'Sphere 1')
await selectByLabel(page, '[data-test="dim-ref-1"]', 'Sphere 2')
await sleep(250)
await click(page, '[data-test="add-dimension"]')
await sleep(300)
const before = await rowMm()
check(Math.abs(before - 148.64) < 0.2, `the centre distance reads the ball bar's length (${before} mm)`)

// ---- scale from the dimension ---------------------------------------------------
await click(page, '[data-test="start-scale"]')
check(await exists('[data-test="scale-box"]'), 'Scale part opens its box')
await selectByLabel(page, '[data-test="scale-ref-0-what"]', 'Distance 1')
await setText('[data-test="scale-ref-0-true"]', (2 * before).toFixed(4))
await sleep(200)
const result = await text('[data-test="scale-result"]')
check(/×2\b|×2 /.test(result ?? ''), `the box says the factor it comes to: "${result}"`)
check(!(await exists('[data-test="scale-refusal"]')), 'and nothing refuses it')
await click(page, '[data-test="apply-scale"]')
check(await bodyHas('Scan scaled'), 'the scan is scaled')
await sleep(500)
const after = await rowMm()
check(Math.abs(after - 2 * before) < 0.01, `the dimension reads the true length after it (${after} mm)`)
const record = await text('[data-test="scale-record"]')
check(/Scaled ×2 from Distance 1/.test(record ?? ''), `the record says how: "${record}"`)

// ---- undo reads the scan back at its old size ------------------------------
await page.keyboard.down(MOD)
await page.keyboard.press('z')
await page.keyboard.up(MOD)
check(await bodyHas('Undone'), 'undo steps back')
await sleep(800)
const undone = await rowMm()
check(Math.abs(undone - before) < 0.01, `the dimension reads as before (${undone} mm)`)
check(!(await exists('[data-test="scale-record"]')), 'and the record is gone')

// ---- two points: the hint, and Esc -----------------------------------------------
await click(page, '[data-test="start-scale"]')
await page.select('[data-test="scale-ref-0-what"]', 'points')
await sleep(200)
check(await bodyHas('one end of the length', 5000), 'picking two points says what to click')
await page.keyboard.press('Escape')
await sleep(200)
check(!(await bodyHas('one end of the length', 1000)), 'Esc stops picking')
check(await exists('[data-test="scale-box"]'), 'and the box stays open')
await page.keyboard.press('Escape')
await sleep(200)
check(!(await exists('[data-test="scale-box"]')), 'a second Esc closes it')

await finish(browser, consoleErrors)

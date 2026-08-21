// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end test of aligning an element to a reference plane: fits one plane
// on the block, then a second one elsewhere, aligns the second to the first
// in the draft box and checks that the panel reports how far off the
// measurement was, that the relation can be switched, that a relation the
// feature was never made to draws the warning, and that the element is
// created aligned.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node scripts/e2e-orient.mjs
// Env: CHROME (chrome.exe path), APP_URL, STL (scan path), SHOT_DIR.
import {
  canvasRect,
  check,
  click,
  fail,
  finish,
  launchApp,
  loadScan,
  repoFile,
  rowTexts,
  selectByLabel,
  shotPath,
  sleep,
} from './e2e-lib.mjs'

const STL = process.env.STL ?? repoFile('block-marius.stl')

const { browser, page, consoleErrors } = await launchApp()
await loadScan(page, STL)
const rect = await canvasRect(page)

const saveEnabled = (timeout = 30_000) =>
  page
    .waitForSelector('[data-test="create-element"]:not([disabled])', { timeout })
    .then(() => true)
    .catch(() => false)
const text = (sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => null)
const exists = (sel) => page.$(sel).then((h) => h !== null)

/** Fit a plane by clicking the first of the given spots that yields one. */
async function fitPlane(spots) {
  for (const [fx, fy] of spots) {
    await click(page, '[data-test="fit-plane"]')
    await page.mouse.click(rect.x + rect.w * fx, rect.y + rect.h * fy)
    await sleep(350)
    if (await saveEnabled(4_000)) return [fx, fy]
    await click(page, '[data-test="cancel-draft"]').catch(() => {})
  }
  return null
}

// ---- the reference plane ---------------------------------------------------
const first = await fitPlane([
  [0.5, 0.5],
  [0.42, 0.42],
  [0.58, 0.58],
  [0.5, 0.35],
])
if (!first) {
  fail('no reference plane could be fitted')
  await browser.close()
  process.exit(1)
}
check(!(await exists('[data-test="orient-ref"]')), 'with no other plane there is nothing to align to')
await click(page, '[data-test="create-element"]')
await sleep(200)

// ---- a second plane, somewhere else on the part ----------------------------
const second = await fitPlane([
  [0.25, 0.7],
  [0.75, 0.3],
  [0.2, 0.3],
  [0.8, 0.7],
  [0.3, 0.5],
  [0.7, 0.5],
])
if (!second) {
  fail('no second plane could be fitted')
  await browser.close()
  process.exit(1)
}
const measuredNote = await text('.draftbox .dro-note')
check(await exists('[data-test="orient-ref"]'), 'the align dropdown appears once a plane exists')
check(!(await exists('[data-test="orient-relation"]')), 'no relation is offered before a reference is chosen')

await selectByLabel(page, '[data-test="orient-ref"]', 'Plane 1')
await sleep(200)
check(await exists('[data-test="orient-relation"]'), 'choosing a reference brings up the relation')
const dev = await text('[data-test="orient-deviation"]')
const devDeg = dev ? parseFloat(dev.match(/([\d.]+)°/)?.[1] ?? 'NaN') : NaN
check(Number.isFinite(devDeg), `the panel says how far off the measurement is (${dev})`)
await page.screenshot({ path: shotPath('e2e-orient-1-aligned.png') })

// Whichever face it landed on, the two relations together cover both
// readings: one of them is near, the other roughly 90° away.
const nearDev = (d) => d < 2
const farDev = (d) => d > 60
let parallelDev = devDeg
await selectByLabel(page, '[data-test="orient-relation"]', 'Perpendicular to it')
await sleep(200)
const perpText = await text('[data-test="orient-deviation"]')
const perpDev = parseFloat(perpText.match(/([\d.]+)°/)?.[1] ?? 'NaN')
console.log(`parallel: ${parallelDev}°, perpendicular: ${perpDev}°`)
check(
  (nearDev(parallelDev) && farDev(perpDev)) || (farDev(parallelDev) && nearDev(perpDev)),
  'one relation fits the face, the other is the wrong reading of it',
)
const wrongIsPerp = farDev(perpDev)
// Put the wrong relation on and read the warning.
await selectByLabel(
  page,
  '[data-test="orient-relation"]',
  wrongIsPerp ? 'Perpendicular to it' : 'Parallel to it',
)
await sleep(200)
check(await exists('[data-test="orient-warning"]'), 'the wrong relation draws the warning')
await page.screenshot({ path: shotPath('e2e-orient-2-warning.png') })
// And the right one.
await selectByLabel(
  page,
  '[data-test="orient-relation"]',
  wrongIsPerp ? 'Parallel to it' : 'Perpendicular to it',
)
await sleep(200)
check(!(await exists('[data-test="orient-warning"]')), 'the right relation is within tolerance')
check(
  (await text('.draftbox .dro-note')) === measuredNote,
  'the measured patch and sigma under the preview are untouched by the alignment',
)

// ---- taking it off and putting it back -------------------------------------
await page.select('[data-test="orient-ref"]', '')
await sleep(150)
check(!(await exists('[data-test="orient-relation"]')), 'None takes the alignment off again')
await selectByLabel(page, '[data-test="orient-ref"]', 'Plane 1')
await sleep(150)

// ---- create it, re-open it -------------------------------------------------
await click(page, '[data-test="create-element"]')
await sleep(300)
const rows = await rowTexts(page)
check(rows.length === 2, `two planes in the list (${JSON.stringify(rows)})`)
const edits = await page.$$('[data-test="edit-element"]')
await edits[1].click()
await sleep(300)
const reopened = await page.$eval('[data-test="orient-ref"]', (e) => e.selectedOptions[0]?.textContent)
check(reopened === 'Plane 1', `re-opening brings the alignment back (${reopened})`)
await click(page, '[data-test="cancel-draft"]')
await page.screenshot({ path: shotPath('e2e-orient-3-created.png') })

await finish(browser, consoleErrors)

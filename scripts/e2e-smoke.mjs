// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end smoke test: drives the real app in headless Chrome — loads
// ballbar.stl through the file input, runs the Sphere pick-preview-create flow
// on both balls, creates a Point–Point dimension between them through the
// dimension editor, and checks the measured center distance in the sidebar.
// (The scan has no cylindrical or flat feature to exercise the other element
// types against; those are covered by the unit tests.)
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node scripts/e2e-smoke.mjs
// Env: CHROME (chrome.exe path), APP_URL, STL (scan path), SHOT_DIR.
import {
  canvasRect,
  check,
  click,
  fail,
  finish,
  fitBall,
  launchApp,
  loadScan,
  repoFile,
  rowTexts,
  selectByLabel,
  shotPath,
  sleep,
} from './e2e-lib.mjs'

const STL = process.env.STL ?? repoFile('ballbar.stl')

const { browser, page, consoleErrors } = await launchApp()
await loadScan(page, STL)
const rect = await canvasRect(page)

const posA = await fitBall(page, rect, false, 1)
const posB = await fitBall(page, rect, true, 2)
if (!posA) console.log('WARN: first sphere not fitted')
if (!posB) console.log('WARN: second sphere not fitted')

console.log('spheres:', JSON.stringify(await rowTexts(page)))

// Create the dimension: New dimension → Point–Point → Sphere 1 → Sphere 2.
await click(page, '[data-test="new-dimension"]')
await selectByLabel(page, '[data-test="dim-ref-0"]', 'Sphere 1')
await selectByLabel(page, '[data-test="dim-ref-1"]', 'Sphere 2')
await page.waitForSelector('[data-test="add-dimension"]:not([disabled])', { timeout: 10_000 })
await click(page, '[data-test="add-dimension"]')
await sleep(200)

// Second dimension straight from the viewport: with the editor open, clicking
// the two balls should fill both slots (and highlight the picked elements).
let viewportDim = false
if (posA && posB) {
  await click(page, '[data-test="new-dimension"]')
  await page.mouse.click(...posA)
  await sleep(150)
  await page.mouse.click(...posB)
  viewportDim = await page
    .waitForSelector('[data-test="add-dimension"]:not([disabled])', { timeout: 10_000 })
    .then(() => true)
    .catch(() => false)
  if (viewportDim) {
    // Commit through the keyboard path rather than the button.
    await page.keyboard.press('Enter')
    viewportDim = await page
      .waitForFunction(
        () => document.querySelectorAll('[data-test="dimension-row"]').length >= 2,
        { timeout: 5_000 },
      )
      .then(() => true)
      .catch(() => false)
    if (!viewportDim) console.log('WARN: Enter did not commit the dimension')
  } else {
    console.log('WARN: viewport picks did not fill the dimension slots')
    await click(page, '[data-test="cancel-dimension"]').catch(() => {})
  }
}

// The DRO window splits digits from the unit legend — rejoin them.
const distances = await page.$$eval('[data-test="dimension-value"]', (els) =>
  els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()),
)
console.log('distances:', JSON.stringify(distances))

await page.screenshot({ path: shotPath('e2e-final.png') })

const expectCount = viewportDim ? 2 : 1
for (let i = 0; i < expectCount; i++) {
  const m = (distances[i] ?? '').match(/(\d+\.\d+)\s*mm/i)
  const via = i === 0 ? 'dropdowns' : 'viewport picks'
  if (!m) {
    fail(`no center distance measured (${via})`)
    continue
  }
  const d = parseFloat(m[1])
  check(Math.abs(d - 148.64) < 0.05, `distance ${d} mm (${via}, expected ~148.64)`)
}
if (!viewportDim) fail('dimension via viewport picks was not created')

await finish(browser, consoleErrors)

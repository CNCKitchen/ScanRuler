// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end test of picking a construction's point straight on the scan:
// fits one ball of ballbar.stl, opens a line through two points — its slots
// pick by themselves — takes the sphere for Point A, clicks the scan for
// Point B, and checks that a Point element appeared, filled the slot, and the
// line was created through both.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node scripts/e2e-pick-slot.mjs
import {
  ballCandidates,
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

const ball = await fitBall(page, rect, false, 1)
if (!ball) fail('sphere not fitted')

await click(page, '[data-test="fit-line"]')
await selectByLabel(page, '[data-test="draft-method"]', 'Through two points')
// A construction of points alone asks for its points itself: the first slot
// is picking from the start, and filling it hands the pick to the next.
const first = await page.$eval('[data-test="draft-ref-0"]', (e) => e.options[e.selectedIndex].text)
check(first.startsWith('Picking'), `the first slot picks from the start: "${first}"`)
await selectByLabel(page, '[data-test="draft-ref-0"]', 'Sphere 1')
await sleep(100)
const picking = await page.$eval('[data-test="draft-ref-1"]', (e) => e.options[e.selectedIndex].text)
check(picking.startsWith('Picking'), `the next slot picks once the first is filled: "${picking}"`)
const hint = await page.$eval('.hintchip', (e) => e.textContent).catch(() => '')
console.log('stage hint:', hint)

// A click on the other ball, well away from the sphere already fitted.
for (const [x, y] of ballCandidates(rect, { farEnd: true })) {
  await page.mouse.click(x, y)
  await sleep(300)
  if ((await rowTexts(page)).some((t) => t.startsWith('Point'))) break
}
await page.screenshot({ path: shotPath('e2e-pick-slot-after-click.png') })
const rows = await rowTexts(page)
console.log('rows:', JSON.stringify(rows))
check(rows.some((t) => t.startsWith('Point 1')), 'a picked Point element appeared')
const chosen = await page.$eval('[data-test="draft-ref-1"]', (e) => e.options[e.selectedIndex].text)
check(chosen === 'Point 1', `slot filled with the picked point: "${chosen}"`)
const status = await page.$eval('[data-test="draft-status"]', (e) => e.className)
check(status.includes('ready'), `line preview ready: ${status}`)
await page.screenshot({ path: shotPath("e2e-pick-slot.png") })
await click(page, '[data-test="create-element"]')
await sleep(200)
const after = await rowTexts(page)
check(after.some((t) => t.startsWith('Line 1')), 'the line was created')
await finish(browser, consoleErrors)

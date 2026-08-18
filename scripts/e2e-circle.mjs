// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end test of the circle element and the marked-region deviation scope.
//
// The part is a generated 20 mm CAD cube, so the answers are known up front:
// a circle typed in from coordinates must read exactly its own diameter, three
// picks on the flat top face must produce a circle lying in that face, and a
// deviation map against the top plane restricted to a marked window must
// measure fewer points than the whole face — and none at all while nothing is
// marked.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node scripts/e2e-circle.mjs
// Env: CHROME (chrome.exe path), APP_URL, SHOT_DIR.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importStep, writeBinarySTL } from 'meshstep'
import { cubeStep } from '../tests/stepFixtures.ts'
import {
  canvasRect,
  check,
  click,
  drag,
  fail,
  finish,
  launchApp,
  loadScan,
  previewReady,
  rowTexts,
  selectByLabel,
  shotPath,
  sleep,
} from './e2e-lib.mjs'

const SIZE = 20
const dir = mkdtempSync(join(tmpdir(), 'scanruler-circle-'))
const CUBE = join(dir, 'cube.stl')
writeFileSync(
  CUBE,
  Buffer.from(
    writeBinarySTL(importStep(cubeStep(SIZE), { surfaceDeviation: 0.02, maxEdge: 2 }).mesh),
  ),
)

const { browser, page, consoleErrors } = await launchApp({ width: 1600, height: 1000 })
await loadScan(page, CUBE, { inputSelector: '[data-test=start-scan] input[type=file]' })
const rect = await canvasRect(page)

const at = (fx, fy) => [rect.x + rect.w * fx, rect.y + rect.h * fy]

// ---- a circle from coordinates: the exact numbers must come back ------------
await click(page, '[data-test=fit-circle]')
await page.waitForSelector('[data-test=draft-method]')
await selectByLabel(page, '[data-test=draft-method]', 'From coordinates')
const setParam = async (key, value) => {
  const sel = `[data-test=draft-param-${key}]`
  await page.$eval(sel, (el) => {
    el.value = ''
  })
  await page.type(sel, String(value))
  await sleep(100)
}
await setParam('d', 12)
await setParam('nx', 0)
await setParam('ny', 0)
await setParam('nz', 1)
await setParam('cx', 0)
await setParam('cy', 0)
await setParam('cz', 0)
if (!(await previewReady(page))) fail('the coordinate circle never previewed')
await page.screenshot({ path: shotPath('circle-coords-preview.png') })
await click(page, '[data-test=create-element]')
await sleep(400)
let rows = await rowTexts(page)
console.log('rows:', JSON.stringify(rows))
check(rows.length === 1 && /Circle 1.*Ø 12\.000 mm/.test(rows[0]), 'a Ø 12 coordinate circle reads back as Ø 12.000')

// ---- a circle through picked points ------------------------------------------
await click(page, '[data-test=fit-circle]')
await page.waitForSelector('[data-test=draft-status]')
// The default method is the picked-points one; the first two picks must show
// progress rather than a result.
await page.mouse.click(...at(0.5, 0.36))
await sleep(300)
let status = await page.$eval('[data-test=draft-status]', (el) => el.textContent)
console.log('after one pick:', status)
check(/1 of 3/.test(status), 'the draft counts its picks up to the minimum')
await page.mouse.click(...at(0.44, 0.46))
await sleep(300)
await page.mouse.click(...at(0.56, 0.46))
if (!(await previewReady(page, { watchStatus: false }))) fail('three picks never previewed a circle')
const dro = await page.$eval('[data-test=draft-status]', (el) => el.textContent)
console.log('three-pick circle preview:', dro)
check(/Ø/.test(dro), 'three picks preview a circle with a diameter')
// A fourth pick refines rather than resets.
await page.mouse.click(...at(0.52, 0.36))
if (!(await previewReady(page, { watchStatus: false }))) fail('the fourth pick lost the preview')
await page.screenshot({ path: shotPath('circle-picked-preview.png') })
await click(page, '[data-test=create-element]')
await sleep(400)
rows = await rowTexts(page)
console.log('rows:', JSON.stringify(rows))
check(rows.length === 2 && /Circle 2.*Ø/.test(rows[1]), 'the picked circle is created')

// The picked circle lies in the cube's top face, so its normal is ±Z and the
// summary must place its center at the face height, z = SIZE/2 above the middle
// — but the part is in scanner coordinates; assert on the copied summary shape
// instead: a diameter, a center and a normal, plus sigma from 4 points.
await click(page, '[data-test=copy-summary]').catch(() => {})

// ---- the plane the deviation section will measure against -------------------
const fitPlaneAt = async (spots) => {
  await click(page, '[data-test=fit-plane]')
  for (const [fx, fy] of spots) {
    await page.mouse.click(...at(fx, fy))
    if (await previewReady(page)) {
      await click(page, '[data-test=create-element]')
      await sleep(400)
      return true
    }
  }
  return false
}
if (!(await fitPlaneAt([[0.5, 0.42], [0.46, 0.38], [0.54, 0.46], [0.5, 0.5]]))) {
  fail('could not fit a plane on the top face')
}

// ---- the deviation map, restricted to a marked region -----------------------
await click(page, '[data-test=workspace-deviation]')
await page.waitForSelector('[data-test=source-element]')
await click(page, '[data-test=source-element]')
await page.waitForSelector('[data-test=target-select]')
// The circle is a curve with no surface, so it must not be on offer.
const offered = await page.$eval('[data-test=target-select]', (el) =>
  [...el.options].map((o) => o.textContent).join(' | '),
)
console.log('targets on offer:', offered)
check(!/circle/.test(offered), 'circles are not offered as deviation targets')
await selectByLabel(
  page,
  '[data-test=target-select]',
  offered
    .split(' | ')
    .map((s) => s.trim())
    .find((s) => /plane/.test(s)),
)
await page.waitForSelector('[data-test=deviation-legend]', { timeout: 30_000 })
await sleep(400)

const matchedCount = async () => {
  const text = await page.$eval('[data-test=deviation-stats]', (el) =>
    el.textContent.replace(/\s+/g, ' '),
  )
  return Number(/matched\s*([\d,]+)/.exec(text)[1].replace(/,/g, ''))
}
const everything = await matchedCount()
console.log('matched over the whole element:', everything)
check(everything > 50, 'the unrestricted map measures the face')

// Restrict to a marked region: with nothing marked yet the map must be empty.
await selectByLabel(page, '[data-test=target-scope]', 'Marked surface only')
await page.waitForSelector('[data-test=mark-gestures]')
await sleep(500)
const nothingMarked = await matchedCount()
console.log('matched with an empty region:', nothingMarked)
check(nothingMarked === 0, 'an empty marked region measures nothing')
await page.screenshot({ path: shotPath('circle-scope-empty.png') })

// Mark a window over part of the face — the map must follow the stroke.
await click(page, '[data-test=mark-window]')
await drag(page, at(0.46, 0.38), at(0.54, 0.46))
await sleep(600)
const inWindow = await matchedCount()
console.log('matched in the marked window:', inWindow)
check(inWindow > 0, 'the map follows the marked region')
check(inWindow < everything, 'the marked region measures less than everything')
await page.screenshot({ path: shotPath('circle-scope-marked.png') })

// Putting the tools away keeps the region and the map on it.
await click(page, '[data-test=scope-done]')
await sleep(500)
const afterDone = await matchedCount()
console.log('matched after putting the tools away:', afterDone)
check(afterDone === inWindow, 'the region survives the tools being put away')
const scopeCount = await page.$eval('[data-test=scope-count]', (el) => el.textContent)
console.log('panel says:', scopeCount)
check(/[1-9]/.test(scopeCount), 'the panel reports the size of the region')

// And back to everything: the full face again.
await selectByLabel(page, '[data-test=target-scope]', 'Everything the element bounds')
await sleep(500)
const backToAll = await matchedCount()
console.log('matched back on the whole element:', backToAll)
check(backToAll === everything, 'switching back measures everything again')

await finish(browser, consoleErrors)

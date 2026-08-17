// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end test of mapping the deviation to a fitted element: fits a plane on
// the top of a known cube, switches the deviation workspace over to measuring
// against it, and checks the map that appears is bounded to the element and
// signed towards the material.
//
// The part is generated rather than loaded from a scan, so the answers are known
// before the app starts: a 20 mm CAD cube is exactly flat, so the map on the top
// face must read zero, and the bottom face — inside the plane's footprint but
// facing the other way — must be left out until the facing filter is switched
// off, at which point it must read exactly the cube's own size.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node scripts/e2e-element-deviation.mjs
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
  colouredFraction,
  fail,
  finish,
  launchApp,
  loadScan,
  previewReady,
  shotPath,
  sleep,
} from './e2e-lib.mjs'

const SIZE = 20
const dir = mkdtempSync(join(tmpdir(), 'scanruler-element-dev-'))
const CUBE = join(dir, 'cube.stl')
writeFileSync(
  CUBE,
  Buffer.from(
    writeBinarySTL(importStep(cubeStep(SIZE), { surfaceDeviation: 0.02, maxEdge: 2 }).mesh),
  ),
)

const { browser, page, consoleErrors } = await launchApp({ width: 1600, height: 1000 })

// ---- a plane on the top of the cube, in the measure workspace ---------------
await loadScan(page, CUBE, { inputSelector: '[data-test=start-scan] input[type=file]' })
const rect = await canvasRect(page)

await click(page, '[data-test=fit-plane]')
// The part is framed from above-ish, so the middle of the canvas is the top
// face; a couple of fallbacks in case the framing puts an edge there.
let fitted = false
for (const [fx, fy] of [[0.5, 0.42], [0.46, 0.38], [0.54, 0.46], [0.5, 0.5]]) {
  await page.mouse.click(rect.x + rect.w * fx, rect.y + rect.h * fy)
  if (await previewReady(page)) {
    fitted = true
    break
  }
}
if (!fitted) fail('could not fit a plane on the cube')
await click(page, '[data-test=create-element]')
await sleep(400)
await page.screenshot({ path: shotPath('element-deviation-plane.png') })

// ---- over to the deviation workspace, measuring against it -----------------
await click(page, '[data-test=workspace-deviation]')
await page.waitForSelector('[data-test=source-element]')
// No card over the part: the stage prompt is gone the moment a scan is in.
const noPane = await page.evaluate(() => !document.querySelector('[data-test=start-pane]'))
check(noPane, 'the stage prompt is out of the way of the loaded part')

await click(page, '[data-test=source-element]')
// Nothing is chosen yet, so the workspace says what is still outstanding rather
// than showing an empty scale.
await page.waitForSelector('[data-test=need-element-chip]')
const legendBefore = await page.$('[data-test=deviation-legend]')
check(!legendBefore, 'no colour scale before an element is chosen')
await page.screenshot({ path: shotPath('element-deviation-empty.png') })

const targetValue = await page.$eval('[data-test=target-select]', (el) =>
  [...el.options].map((o) => o.value).filter(Boolean).at(0),
)
if (!targetValue) fail('the fitted plane is not offered as something to measure against')
await page.select('[data-test=target-select]', targetValue)

// No button to press: the map is arithmetic, so it is there with the choice.
await page.waitForSelector('[data-test=deviation-legend]', { timeout: 30_000 })
await sleep(500)
await page.screenshot({ path: shotPath('element-deviation-map.png') })

const detail = await page.$eval('[data-test=target-detail]', (el) => el.textContent)
console.log('element:', detail)
if (!/plane/.test(detail)) fail(`the panel does not say what the element is: ${detail}`)

const side = await page.$eval('[data-test=target-side]', (el) => el.textContent)
console.log('material side:', side)
// The cube's top face has its normals pointing out of the solid, and the plane
// was fitted on it, so the material must read as being on the normal's side.
check(/along the normal/.test(side), 'the material side was detected from the scan')

/** The legend figures, as { min, max, mean, ... } in millimetres. */
const legendStats = async () => {
  const text = await page.$eval('[data-test=deviation-stats]', (el) =>
    el.textContent.replace(/\s+/g, ' '),
  )
  const num = (label) => {
    const m = new RegExp(`${label}\\s*([−+-]?[\\d.]+)`).exec(text)
    return m ? parseFloat(m[1].replace('−', '-')) : NaN
  }
  return { text, min: num('min'), max: num('max'), mean: num('mean') }
}

const flat = await legendStats()
console.log('flat face:', flat.text)
// A CAD cube's face is exactly flat, and the tessellation cannot move a vertex
// off a plane it lies in — so the whole map is zero to within nothing.
check(Math.abs(flat.min) < 0.02 && Math.abs(flat.max) < 0.02, 'a flat face maps as flat')

const colouredOnFace = await colouredFraction(page)
console.log(`coloured stage: ${(colouredOnFace * 100).toFixed(1)} %`)
check(colouredOnFace > 0.01, 'the map is painted on the part')

// ---- what bounds the measurement -------------------------------------------
// Reach far enough to find the underside of the cube, which lies squarely
// inside the plane's footprint. With the facing filter on it must stay out.
const setNumber = async (sel, value) => {
  await page.$eval(sel, (el) => {
    el.value = ''
  })
  await page.type(sel, String(value))
  await page.$eval(sel, (el) => el.blur())
  await sleep(400)
}
await setNumber('[data-test=max-distance]', SIZE * 2)
const stillFlat = await legendStats()
console.log('reaching far, facing on:', stillFlat.text)
check(
  Math.abs(stillFlat.min) < 0.02,
  'the far side of the part stays out while the facing filter is on',
)

await click(page, '[data-test=toggle-facing]')
await sleep(500)
const bothFaces = await legendStats()
console.log('reaching far, facing off:', bothFaces.text)
// The underside of a 20 mm cube is 20 mm below the plane on its top, and it is
// missing material relative to it — so exactly −20, and negative.
check(
  Math.abs(bothFaces.min + SIZE) < 0.1,
  `the far face reads as the cube's own size: ${bothFaces.min} mm`,
)
await page.screenshot({ path: shotPath('element-deviation-facing-off.png') })

await click(page, '[data-test=toggle-facing]')
await sleep(400)

// ---- the material side turns the whole map round ---------------------------
await setNumber('[data-test=max-distance]', 1)
await click(page, '[data-test=target-flip'.concat(']'))
await sleep(500)
const flipped = await page.$eval('[data-test=target-side]', (el) => el.textContent)
console.log('flipped side:', flipped)
check(/against the normal/.test(flipped), 'the material side can be turned round')
// Facing now expects the surface to point the other way, so the top face — the
// only surface inside the footprint — drops out of the measurement entirely.
const afterFlip = await page.$eval('[data-test=deviation-stats]', (el) =>
  el.textContent.replace(/\s+/g, ' '),
)
console.log('after flip:', afterFlip)
const matched = /matched\s*([\d,]+)/.exec(afterFlip)
check(
  matched !== null && Number(matched[1].replace(/,/g, '')) === 0,
  'flipping the side takes the surface facing the old way out of the map',
)
await click(page, '[data-test=target-flip]')
await sleep(500)

// ---- showing and hiding the element ----------------------------------------
const withElement = await page.screenshot({ encoding: 'base64' })
await click(page, '[data-test=toggle-element]')
await sleep(400)
const withoutElement = await page.screenshot({ encoding: 'base64' })
check(withElement !== withoutElement, 'the element can be taken off the stage')
await click(page, '[data-test=toggle-element]')
await sleep(300)

// ---- pinning a reading, and the report -------------------------------------
let pinned = 0
for (const [fx, fy] of [[0.5, 0.42], [0.46, 0.38], [0.54, 0.46]]) {
  await page.mouse.move(rect.x + rect.w * fx, rect.y + rect.h * fy)
  await sleep(250)
  const reading = await page
    .$eval('[data-test=hover-readout]', (el) => el.textContent)
    .catch(() => null)
  if (!reading) continue
  console.log('hover reading:', reading)
  await page.mouse.click(rect.x + rect.w * fx, rect.y + rect.h * fy)
  await sleep(300)
  pinned = await page.$$eval('[data-test=probe-row]', (els) => els.length)
  if (pinned) break
}
check(pinned === 1, 'a reading off the element map pins to the part')
await page.screenshot({ path: shotPath('element-deviation-pin.png') })

// ---- the reference path is untouched behind it ------------------------------
await click(page, '[data-test=source-reference]')
await page.waitForSelector('[data-test=slot-reference]')
const refLegend = await page.$('[data-test=deviation-legend]')
check(!refLegend, 'switching back to the reference path shows no map it has not measured')
await click(page, '[data-test=source-element]')
await page.waitForSelector('[data-test=deviation-legend]', { timeout: 30_000 })
check(true, 'the element map is still there on the way back')
await page.screenshot({ path: shotPath('element-deviation-back.png') })

// ---- the element going away under the map ----------------------------------
// Extending it in the other workspace must grow the measured region, and
// deleting it must take the map with it rather than leaving a scale over
// nothing.
await click(page, '[data-test=workspace-elements]')
await page.waitForSelector('[data-test=fit-plane]')
const measuredBefore = 190
await click(page, '[data-test=element-row] [data-test=edit-element]')
await page.waitForSelector('[data-test=extend-uMin]')
for (const side of ['uMin', 'uMax', 'vMin', 'vMax']) {
  await setNumber(`[data-test=extend-${side}]`, 6)
}
await click(page, '[data-test=create-element]')
await sleep(400)
await click(page, '[data-test=workspace-deviation]')
await page.waitForSelector('[data-test=deviation-legend]', { timeout: 30_000 })
await sleep(500)
const grown = await page.$eval('[data-test=deviation-stats]', (el) =>
  el.textContent.replace(/\s+/g, ' '),
)
console.log('after extending the plane:', grown)
const grownMatched = Number(/matched\s*([\d,]+)/.exec(grown)[1].replace(/,/g, ''))
console.log(`matched: ${measuredBefore} -> ${grownMatched}`)
// The patch now overhangs the top face, so its footprint reaches down the sides
// — which the facing filter keeps out. The region it measures is the element as
// drawn either way, so the count has to move.
check(grownMatched !== measuredBefore, 'the measured region follows the element as it is extended')
await page.screenshot({ path: shotPath('element-deviation-extended.png') })

await click(page, '[data-test=workspace-elements]')
await click(page, '[data-test=element-row] button.x[title^="Delete"]')
await sleep(400)
await click(page, '[data-test=workspace-deviation]')
await sleep(600)
check(
  !(await page.$('[data-test=deviation-legend]')),
  'deleting the element takes its map and its colour scale with it',
)
await page.waitForSelector('[data-test=need-element-chip]')
check(true, 'and the workspace asks for another one')

await finish(browser, consoleErrors)

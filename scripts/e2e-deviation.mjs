// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end smoke test for the deviation workspace: drives the real app in
// headless Chrome — loads the scan through the top bar, switches workspace,
// loads the nominal part, runs the automatic best fit, measures the deviation
// map, and exercises the scale controls and the split-screen point picker.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node scripts/e2e-deviation.mjs
// Env: CHROME (chrome.exe path), APP_URL, SCAN, NOMINAL, SHOT_DIR.
import {
  colouredFraction,
  fail,
  finish,
  launchApp,
  loadScan,
  repoFile,
  requireFixture,
  shotPath,
  sleep,
} from './e2e-lib.mjs'

const SCAN = process.env.SCAN ?? repoFile('block-marius.stl')
const NOMINAL = process.env.NOMINAL ?? repoFile('side bracket left.stl')
requireFixture(NOMINAL)

const { browser, page, consoleErrors } = await launchApp({
  width: 1600,
  height: 1000,
  protocolTimeout: 600_000,
})

// ---- workspace first, then both models from the stage ----------------------
await page.click('[data-test=workspace-deviation]')
await page.waitForSelector('[data-test=start-pane]')
await page.screenshot({ path: shotPath('deviation-empty.png') })

await loadScan(page, SCAN, {
  inputSelector: '[data-test=start-scan] input[type=file]',
  timeout: 300_000,
  settle: 600,
})
// With one model in, the prompt must get out of the way of it rather than
// covering the stage.
const compact = await page.$eval('[data-test=start-pane]', (el) =>
  el.classList.contains('compact'),
)
if (!compact) fail('the start prompt still covers the stage after a model loaded')
await page.screenshot({ path: shotPath('deviation-half-loaded.png') })

await (await page.$('[data-test=start-reference] input[type=file]')).uploadFile(NOMINAL)
await page.waitForFunction(
  () => document.querySelector('[data-test=align-auto]')?.disabled === false,
  { timeout: 300_000 },
)
await sleep(900)
console.log('reference loaded')

// With both models in, the prompt clears and both parts are on the stage
// together, waiting to be aligned.
const cleared = await page.evaluate(() => !document.querySelector('[data-test=start-pane]'))
if (!cleared) fail('the stage prompt did not clear once both models were loaded')
await page.waitForSelector('[data-test=ready-chip]')
await page.screenshot({ path: shotPath('deviation-both-loaded.png') })

// ---- automatic best fit + map ---------------------------------------------
await page.click('[data-test=align-auto]')
// Catch it mid-flight: the reference should be visibly on the move.
await sleep(2500)
await page.screenshot({ path: shotPath('deviation-aligning.png') })
await page.waitForSelector('[data-test=deviation-legend]', { timeout: 300_000 })
await page.waitForFunction(
  () => !document.querySelector('[data-test=fitting-chip]'),
  { timeout: 300_000 },
)
await sleep(700)

// Once there is a map on the scan, the reference should have stood down and
// the scan should still be shown.
const ghostOff = await page.$eval('[data-test=toggle-ghost]', (el) => !el.checked)
if (!ghostOff) fail('the reference is still shown after the map was measured')
const scanOn = await page.$eval('[data-test=toggle-scan]', (el) => el.checked)
if (!scanOn) fail('the scan is not shown after the map was measured')

const rms = await page.$eval('[data-test=align-rms] b', (el) => Number(el.textContent))
const stats = await page.$eval('[data-test=deviation-stats]', (el) =>
  el.textContent.replace(/([a-z%])([A-Z−+±])/g, '$1 | $2'),
)
console.log(`align rms: ${rms} mm`)
console.log('stats:', stats)
if (!(rms > 0 && rms < 0.5)) fail(`alignment rms ${rms} mm is not a converged fit`)

await page.screenshot({ path: shotPath('deviation-map.png') })

const coloured = await colouredFraction(page)
console.log(`coloured stage: ${(coloured * 100).toFixed(1)} %`)
if (coloured < 0.05) fail('the deviation map does not appear to be painted on the scan')

// ---- scale controls -------------------------------------------------------
await page.click('[data-test=toggle-histogram]')
await page.waitForSelector('[data-test=deviation-histogram]')
const bars = await page.$$eval('[data-test=deviation-histogram] span', (els) =>
  els.filter((e) => parseFloat(e.style.width) > 0).length,
)
console.log(`histogram bins with counts: ${bars}`)
if (bars < 3) fail('histogram is empty')

const before = await page.$eval('[data-test=range-value]', (el) => el.value)
await page.$eval('[data-test=range-slider]', (el) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(el, '-0.7')
  el.dispatchEvent(new Event('change', { bubbles: true }))
  el.dispatchEvent(new Event('input', { bubbles: true }))
})
await sleep(500)
const after = await page.$eval('[data-test=range-value]', (el) => el.value)
console.log(`range: ${before} -> ${after}`)
if (before === after) fail('the range slider did not change the scale')
await page.screenshot({ path: shotPath('deviation-tight-range.png') })

// ---- hover reading and pinning --------------------------------------------
const stage = await page.$eval('.viewslot canvas', (el) => {
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height }
})
let reading = null
let pinAt = null
for (const [fx, fy] of [[0.35, 0.28], [0.62, 0.25], [0.3, 0.72], [0.45, 0.38], [0.7, 0.5]]) {
  const at = { x: stage.x + stage.w * fx, y: stage.y + stage.h * fy }
  await page.mouse.move(at.x, at.y)
  await sleep(250)
  reading = await page
    .$eval('[data-test=hover-readout]', (el) => el.textContent)
    .catch(() => null)
  if (reading) {
    pinAt = at
    break
  }
}
console.log('hover reading:', reading)
if (!reading || !/mm/.test(reading)) fail('no deviation reading appeared on hover')

await page.mouse.click(pinAt.x, pinAt.y)
await sleep(350)
const pinned = await page.$$eval('[data-test=probe-row]', (els) =>
  els.map((e) => e.textContent),
)
console.log('pinned:', pinned)
if (pinned.length !== 1) fail(`expected one pinned reading, got ${pinned.length}`)
await page.screenshot({ path: shotPath('deviation-pin.png') })

// ---- split-screen point picker --------------------------------------------
await page.click('[data-test=align-points]')
await page.waitForSelector('[data-test=split-picker]')
await sleep(900)
const halves = await page.$$('.splitview canvas')
if (halves.length !== 2) fail(`expected two picker viewports, got ${halves.length}`)

// Spots to try, in order. A ray can always miss — this part is a frame with a
// large open window — so each pick walks the list until one lands, rather than
// assuming a fixed position is on material in both views.
const SPOTS = [
  [0.35, 0.28], [0.62, 0.25], [0.3, 0.72], [0.45, 0.38],
  [0.7, 0.5], [0.25, 0.45], [0.55, 0.78], [0.42, 0.2], [0.68, 0.68],
]

const pairCount = () => page.$$eval('.splitpins .pinchip:not(.half)', (els) => els.length)
const pendingPick = () => page.$$eval('.splitpins .pinchip.half', (els) => els.length > 0)

// `from` advances per pair: without it every pick would retry the first spot
// that works and place the whole set on one point.
async function pickOn(half, landed, from) {
  for (let k = 0; k < SPOTS.length; k++) {
    const [fx, fy] = SPOTS[(from + k) % SPOTS.length]
    const r = await half.evaluate((el) => {
      const b = el.getBoundingClientRect()
      return { x: b.x, y: b.y, w: b.width, h: b.height }
    })
    await page.mouse.click(r.x + r.w * fx, r.y + r.h * fy)
    await sleep(200)
    if (await landed()) return true
  }
  return false
}

// Keep adding pairs until the picker is satisfied — three points that happen
// to land nearly in a line are refused, which is the behaviour under test.
const alignEnabled = () => page.$eval('[data-test=split-align]', (el) => !el.disabled)
for (let i = 0; i < 6 && !(await alignEnabled()); i++) {
  if (!(await pickOn(halves[0], pendingPick, i))) fail(`could not place scan point ${i + 1}`)
  const want = i + 1
  if (!(await pickOn(halves[1], async () => (await pairCount()) >= want, i))) {
    fail(`could not place reference point ${i + 1}`)
  }
}
const pins = await pairCount()
console.log(`picked pairs: ${pins}, spread ${await page.$eval('.splitfit', (el) => el.textContent).catch(() => 'n/a')}`)
await page.screenshot({ path: shotPath('deviation-split.png') })
if (pins < 3) fail(`expected at least 3 picked pairs, got ${pins}`)
if (!(await alignEnabled())) fail('the picked pairs never became enough to align')

await page.click('[data-test=split-align]')
// Watch for either outcome: the picker closes on success, or it stays up with
// a reason. Waiting only for success would hang on the failure it is meant to
// report.
await page.waitForFunction(
  () => !document.querySelector('[data-test=split-picker]') || document.querySelector('.splitwarn'),
  { timeout: 300_000 },
)
const warn = await page.$('.splitwarn')
if (warn) {
  await page.screenshot({ path: shotPath('deviation-split-failed.png') })
  fail(`point-pair alignment refused: ${await warn.evaluate((el) => el.textContent)}`)
  await browser.close()
  process.exit(1)
}
await page.waitForFunction(() => !document.querySelector('[data-test=fitting-chip]'), {
  timeout: 300_000,
})
await sleep(600)
console.log('point-pair alignment finished:', await page.$eval('[data-test=align-rms] b', (el) => el.textContent), 'mm rms')
await page.screenshot({ path: shotPath('deviation-after-points.png') })

// ---- back to the other workspace ------------------------------------------
await page.click('[data-test=workspace-elements]')
await page.waitForSelector('[data-test=fit-sphere]')
await sleep(400)
await page.screenshot({ path: shotPath('deviation-back-to-elements.png') })

await finish(browser, consoleErrors)

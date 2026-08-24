// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end test for the three things that make a best fit recoverable when it
// goes wrong: stopping one that is running, fitting the view back onto a model
// that has been orbited off screen, and selecting the surface a picked-point fit
// is measured on.
//
// The pair is built here rather than committed, the same way e2e-split.mjs does
// it: a STEP cube as the reference, and a mesh of the same cube — turned, and
// with two faces displaced — as the scan. Turned on purpose, so the automatic
// search has real work to do and there is something to stop.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node scripts/e2e-pick-fit.mjs
// Env: CHROME (chrome.exe path), APP_URL, SHOT_DIR.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importStep, writeBinarySTL } from 'meshstep'
import { cubeStep } from '../tests/stepFixtures.ts'
import { check, drag, fail, finish, launchApp, shotPath, sleep } from './e2e-lib.mjs'

const SIZE = 20

// ---- the pair --------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'scanruler-pick-'))
const stepText = cubeStep(SIZE)
const stepPath = join(dir, 'cube.step')
writeFileSync(stepPath, stepText)
const dense = importStep(stepText, { surfaceDeviation: 0.001, maxEdge: 0.8 })
const p = dense.mesh.positions
// Two faces off nominal, so the map has something to show…
for (let i = 0; i < p.length; i += 3) {
  if (Math.abs(p[i + 2] - SIZE) < 1e-6) p[i + 2] += 0.2
  if (Math.abs(p[i] - SIZE) < 1e-6) p[i] -= 0.15
}
// …and the whole thing turned off the reference's frame, so the automatic fit
// has to search rather than land on the identity in one pass.
const ANGLE = 0.6
const cos = Math.cos(ANGLE)
const sin = Math.sin(ANGLE)
for (let i = 0; i < p.length; i += 3) {
  const x = p[i] - SIZE / 2
  const y = p[i + 1] - SIZE / 2
  p[i] = x * cos - y * sin + SIZE / 2 + 7
  p[i + 1] = x * sin + y * cos + SIZE / 2 - 5
  p[i + 2] += 3
}
const scanPath = join(dir, 'cube-scan.stl')
writeFileSync(scanPath, Buffer.from(writeBinarySTL(dense.mesh)))

const { browser, page, consoleErrors } = await launchApp({
  width: 1600,
  height: 1000,
  protocolTimeout: 600_000,
})

/** What share of a viewport the part covers, and where its silhouette sits —
 *  everything the framing checks are read off. The stage is one flat colour, so
 *  a part pixel is any pixel far enough from it. */
async function partShare(selector) {
  const clip = await page.$eval(selector, (el) => {
    const r = el.getBoundingClientRect()
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height),
    }
  })
  const shot = await page.screenshot({ clip, encoding: 'base64' })
  return page.evaluate(async (b64) => {
    const img = new Image()
    img.src = 'data:image/png;base64,' + b64
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height)
    let part = 0
    let marked = 0
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2]
      if (Math.abs(r - 0xde) + Math.abs(g - 0xdc) + Math.abs(b - 0xd6) > 40) part++
      // The marking's magenta (#b5179e) is the one strongly red-and-blue thing
      // that can be on a bare part.
      if (r > 100 && b > 80 && g < r - 60 && b > g + 40) marked++
    }
    return {
      share: +(part / (width * height)).toFixed(4),
      marked: +(marked / (width * height)).toFixed(4),
    }
  }, shot)
}

const rectOf = (selector) =>
  page.$eval(selector, (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })

/** A point at fractions (fx, fy) of an element's box. */
const at = (r, fx, fy) => [Math.round(r.x + r.w * fx), Math.round(r.y + r.h * fy)]

const countText = () =>
  page.$eval('[data-test=pick-count]', (el) => el.textContent.replace(/\s+/g, ' ').trim())

// The support card sits over the top-right of the stage; closed up front,
// because the framing checks below are read off the pixels underneath it.
await page.click('[data-test=support-card] .sc-x').catch(() => {})

// ---- both models ------------------------------------------------------------
await page.click('[data-test=workspace-deviation]')
await page.waitForSelector('[data-test=start-pane]')
await (await page.$('[data-test=start-scan] input[type=file]')).uploadFile(scanPath)
await page.waitForFunction(
  () => /[1-9][\d,]* triangles/.test(document.querySelector('.file-info')?.textContent ?? ''),
  { timeout: 300_000 },
)
await (await page.$('[data-test=slot-reference] input[type=file]')).uploadFile(stepPath)
await page.waitForFunction(
  () => document.querySelector('[data-test=align-auto]')?.disabled === false,
  { timeout: 300_000 },
)
await sleep(600)

// ---- fit to view ------------------------------------------------------------
// The button sits above the axis gizmo, which is drawn into the same canvas —
// so the offset it parks at is published by the scene as a custom property.
check(
  await page.$eval(
    '.viewport',
    (el) => parseFloat(getComputedStyle(el).getPropertyValue('--gizmo-size')) > 0,
  ),
  'the viewport publishes the corner its gizmo takes',
)
const framed = await partShare('.viewport')
const viewport = await rectOf('.viewport canvas')
// Zoom right out, so the models are a speck in the middle of the stage.
await page.mouse.move(...at(viewport, 0.5, 0.5))
for (let i = 0; i < 12; i++) await page.mouse.wheel({ deltaY: 240 })
await sleep(500)
const lost = await partShare('.viewport')
check(
  lost.share < framed.share / 2,
  `zooming out shrinks the models (${framed.share} → ${lost.share})`,
)
await page.click('.viewport > [data-test=fit-view]')
await sleep(500)
const refitted = await partShare('.viewport')
check(
  Math.abs(refitted.share - framed.share) < framed.share * 0.35,
  `fit to view brings them back (${lost.share} → ${refitted.share}, was ${framed.share})`,
)

// ---- stopping a fit that is running ----------------------------------------
await page.click('[data-test=align-auto]')
const stopShown = await page
  .waitForSelector('[data-test=align-stop]', { timeout: 20_000 })
  .then(() => true)
  .catch(() => false)
check(stopShown, 'a running fit offers a way to stop it')
if (stopShown) {
  await sleep(250)
  await page.screenshot({ path: shotPath('pick-fit-1-stopping.png') })
  // Escape does the same thing the button does; the button is what is tested
  // here, and Escape is checked in the picker below.
  await page.click('[data-test=align-stop]')
  const stopped = await page
    .waitForFunction(() => !document.querySelector('[data-test=align-stop]'), { timeout: 30_000 })
    .then(() => true)
    .catch(() => false)
  check(stopped, 'the fit stops when it is asked to')
  check(
    (await page.$eval('.panel', (el) => el.innerText)).includes('Alignment stopped'),
    'and says so, rather than reporting a failure',
  )
  check(
    (await page.$('[data-test=align-rms]')) === null,
    'a stopped fit leaves no alignment behind',
  )
  check(
    (await page.$('[data-test=align-points]')) !== null,
    'the panel is back to offering the two ways to align',
  )
}

// The worker has to be usable again straight after — a stopped fit must not
// leave it wedged.
await page.click('[data-test=align-auto]')
await page.waitForSelector('[data-test=align-rms]', { timeout: 300_000 })
await page.waitForFunction(() => !document.querySelector('[data-test=fitting-chip]'), {
  timeout: 300_000,
})
check(true, 'the next fit runs normally after a stop')

// ---- the picker, and the surface a fit is measured on ----------------------
await page.click('[data-test=align-points]')
await page.waitForSelector('[data-test=split-picker]')
await sleep(700)
check(
  (await page.$('[data-test=pick-tools]')) !== null,
  'the picker offers the tools for selecting surface',
)
check(
  (await countText()).includes('Nothing selected'),
  'and starts with nothing selected — the whole scan is fitted',
)

const scanHalf = await rectOf('[data-test=split-picker] .splithalf:first-child .splitview')
const refHalf = await rectOf('[data-test=split-picker] .splithalf:last-child .splitview')

// Fit to view works in the halves too, where a part is turned by hand the most.
const halfFramed = await partShare('[data-test=split-picker] .splithalf:first-child .splitview')
await page.mouse.move(...at(scanHalf, 0.5, 0.5))
for (let i = 0; i < 10; i++) await page.mouse.wheel({ deltaY: 240 })
await sleep(400)
const halfLost = await partShare('[data-test=split-picker] .splithalf:first-child .splitview')
await page.click('[data-test=split-picker] .splithalf:first-child [data-test=fit-view]')
await sleep(400)
const halfRefitted = await partShare('[data-test=split-picker] .splithalf:first-child .splitview')
check(
  halfLost.share < halfFramed.share / 2 &&
    Math.abs(halfRefitted.share - halfFramed.share) < halfFramed.share * 0.35,
  `fit to view works in the picker's halves (${halfFramed.share} → ${halfLost.share} → ${halfRefitted.share})`,
)

// ---- selecting surface ------------------------------------------------------
await page.click('[data-test=pick-window]')
await sleep(150)
await drag(page, at(scanHalf, 0.28, 0.28), at(scanHalf, 0.72, 0.72), { settle: 500 })
const selected = await countText()
check(/points selected/.test(selected), `a window selects surface (${selected})`)
const painted = await partShare('[data-test=split-picker] .splithalf:first-child .splitview')
check(painted.marked > 0.005, `and the selection shows on the part (${painted.marked})`)
await page.screenshot({ path: shotPath('pick-fit-2-selected.png') })

// Escape stands the gesture down without touching what it took — the same
// retreat every marking session makes.
await page.keyboard.press('Escape')
await sleep(200)
check(
  await page.$eval('[data-test=pick-points]', (el) => el.getAttribute('aria-pressed') === 'true'),
  'Escape hands the camera back and the clicks back to picking',
)
check(/points selected/.test(await countText()), 'and leaves the selection alone')

await page.click('[data-test=pick-clear]')
await sleep(200)
check(
  (await countText()).includes('Nothing selected'),
  'clearing the selection puts the whole scan back in the fit',
)

// ---- three pairs, then a fit measured on the selection ---------------------
const SPOTS = [
  [0.45, 0.4],
  [0.58, 0.55],
  [0.42, 0.62],
]
for (const [fx, fy] of SPOTS) {
  await page.mouse.click(...at(scanHalf, fx, fy))
  await sleep(250)
  await page.mouse.click(...at(refHalf, fx, fy))
  await sleep(250)
}
const pins = await page.$$eval('[data-test=split-picker] .pinchip', (els) => els.length)
check(pins === 3, `three pairs make three pins (${pins})`)
check(
  await page.$eval('[data-test=split-align]', (el) => !el.disabled),
  'three spread pairs are enough to align from',
)

await page.click('[data-test=pick-window]')
await sleep(150)
await drag(page, at(scanHalf, 0.2, 0.2), at(scanHalf, 0.8, 0.8), { settle: 500 })
check(/points selected/.test(await countText()), 'surface selected for the fit')

await page.click('[data-test=split-align]')
const done = await page
  .waitForFunction(() => !document.querySelector('[data-test=split-picker]'), { timeout: 300_000 })
  .then(() => true)
  .catch(() => false)
check(done, 'the picker closes when its fit lands')
await page.waitForSelector('[data-test=align-rms]', { timeout: 300_000 })
await sleep(600)
const note = await page.$eval('.dro-note', (el) => el.textContent.replace(/\s+/g, ' ').trim())
check(/points selected/.test(note), `the fit reports the surface it was measured on (${note})`)
check(
  (await page.$eval('.panel', (el) => el.innerText)).includes('from points'),
  'and reports that it came from the picked points',
)
await page.screenshot({ path: shotPath('pick-fit-3-fitted.png') })

// The selection belongs to the session that made it: the picker took it away
// with it, so the fine fit that comes next opens on a clean part.
const after = await partShare('.viewport')
if (after.marked > 0.004) fail(`the selection outlived the picker (${after.marked})`)

await finish(browser, consoleErrors)

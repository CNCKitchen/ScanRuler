// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end smoke test for the two ways of *looking* at a deviation map: the
// scan and the reference side by side in two viewports held in one pose, and the
// colour plot switched off to leave the bare surface.
//
// The pair is built here rather than committed, the same way e2e-step.mjs builds
// it: a STEP cube as the reference and a fine mesh of the same cube — two faces
// displaced — as the scan. Which makes the check on the split view an exact one,
// because after the fit both halves are showing the same cube: their silhouettes
// have to cover the same share of their half and sit in the same place in it, or
// the two cameras are not in one pose.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node scripts/e2e-split.mjs
// Env: CHROME (chrome.exe path), APP_URL, SHOT_DIR.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importStep, writeBinarySTL } from 'meshstep'
import { cubeStep } from '../tests/stepFixtures.ts'
import { check, fail, finish, launchApp, shotPath, sleep } from './e2e-lib.mjs'

const SIZE = 20

// ---- the pair --------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'scanruler-split-'))
const stepText = cubeStep(SIZE)
const stepPath = join(dir, 'cube.step')
writeFileSync(stepPath, stepText)
const dense = importStep(stepText, { surfaceDeviation: 0.001, maxEdge: 0.8 })
const p = dense.mesh.positions
for (let i = 0; i < p.length; i += 3) {
  if (Math.abs(p[i + 2] - SIZE) < 1e-6) p[i + 2] += 0.2
  if (Math.abs(p[i] - SIZE) < 1e-6) p[i] -= 0.15
}
const scanPath = join(dir, 'cube-scan.stl')
writeFileSync(scanPath, Buffer.from(writeBinarySTL(dense.mesh)))

const { browser, page, consoleErrors } = await launchApp({
  width: 1600,
  height: 1000,
  protocolTimeout: 600_000,
})

/** The scale rides over the inner edge of the scan's half, so both halves are
 *  read with the same strip taken off their right — measuring one through an
 *  overlay and the other through clear stage would compare the overlay. */
const LEGEND_STRIP = 170

/** How a half looks, without asking the app anything: what share of it the part
 *  covers, where that silhouette sits, how much of it is coloured rather than
 *  grey, and how much of that colour is warm. Everything below is read off
 *  these four numbers. */
async function halfStats(selector) {
  const clip = await page.$eval(
    selector,
    (el, strip) => {
      const r = el.getBoundingClientRect()
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width) - strip,
        height: Math.round(r.height),
      }
    },
    LEGEND_STRIP,
  )
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
    // The stage is 0xdedcd6; a part pixel is anything far enough off it.
    let part = 0
    let sat = 0
    let warm = 0
    let sx = 0
    let sy = 0
    const sum = [0, 0, 0]
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]]
      if (Math.abs(r - 0xde) + Math.abs(g - 0xdc) + Math.abs(b - 0xd6) < 26) continue
      const px = (i / 4) % width
      const py = Math.floor(i / 4 / width)
      part++
      sx += px / width
      sy += py / height
      sum[0] += r
      sum[1] += g
      sum[2] += b
      if (Math.max(r, g, b) - Math.min(r, g, b) > 45) sat++
      // The reference is one flat colour whatever the light does to it, so the
      // warm end of the ramp is what tells a map apart from it.
      if (r - b > 25) warm++
    }
    return {
      share: +(part / (width * height)).toFixed(4),
      coloured: +(sat / Math.max(1, part)).toFixed(3),
      warm: +(warm / Math.max(1, part)).toFixed(3),
      cx: +(part ? sx / part : 0).toFixed(4),
      cy: +(part ? sy / part : 0).toFixed(4),
      // Mean colour of the part, for comparing one half's material with the
      // other's.
      mean: sum.map((c) => Math.round(c / Math.max(1, part))),
    }
  }, shot)
}

const moved = (a, b) => Math.hypot(a.cx - b.cx, a.cy - b.cy) + Math.abs(a.share - b.share)

/** Furthest apart any one channel of two mean colours is, in 0–255 counts. */
const channelGap = (a, b) => Math.max(...a.map((c, i) => Math.abs(c - b[i])))

/** The same cube in both halves: same size, same place, and colours on the scan
 *  only. This is the whole claim the split view makes. */
async function bothHalves(when) {
  const left = await halfStats('.viewport')
  const right = await halfStats('.compareview')
  console.log(`${when}: left ${JSON.stringify(left)} right ${JSON.stringify(right)}`)
  if (Math.abs(left.share - right.share) > 0.035) {
    fail(`${when}: the halves show the part at different sizes (${left.share} vs ${right.share})`)
  }
  if (Math.hypot(left.cx - right.cx, left.cy - right.cy) > 0.04) {
    fail(`${when}: the halves are not in one pose (${left.cx},${left.cy} vs ${right.cx},${right.cy})`)
  }
  if (right.warm > 0.02) fail(`${when}: the reference half is carrying map colours (${right.warm})`)
  return { left, right }
}

// The support card sits over the top-right of the stage — which is the reference
// half once the split view is open. Closed up front, because everything below is
// read off the pixels underneath it.
await page.click('[data-test=support-card] .sc-x').catch(() => {})

// ---- both switches are in the footer, and dead until they would do something
await page.click('[data-test=workspace-deviation]')
await page.waitForSelector('[data-test=toggle-split]')
check(
  await page.$eval('[data-test=toggle-split]', (el) => el.disabled),
  'the split switch is dead with no models loaded',
)
check(
  await page.$eval('[data-test=toggle-colormap]', (el) => el.disabled),
  'the colour-plot switch is dead with nothing measured',
)

await (await page.$('[data-test=start-scan] input[type=file]')).uploadFile(scanPath)
await page.waitForFunction(
  () => /[1-9][\d,]* triangles/.test(document.querySelector('.file-info')?.textContent ?? ''),
  { timeout: 300_000 },
)
check(
  await page.$eval('[data-test=toggle-split]', (el) => el.disabled),
  'the split switch is still dead with only the scan in',
)

await (await page.$('[data-test=slot-reference] input[type=file]')).uploadFile(stepPath)
await page.waitForFunction(
  () => document.querySelector('[data-test=align-auto]')?.disabled === false,
  { timeout: 300_000 },
)
await sleep(600)
check(
  !(await page.$eval('[data-test=toggle-split]', (el) => el.disabled)),
  'the split switch comes alive once both models are in',
)

// ---- side by side before anything is fitted --------------------------------
// It does not wait for a fit: opening it on an unfitted pair is how you check
// the reference is the part you meant before spending an alignment on it.
await page.click('[data-test=toggle-split]')
await page.waitForSelector('[data-test=compare-half]')
await sleep(800)
const unfitted = await bothHalves('before the fit')
check(
  unfitted.left.share > 0.02 && unfitted.right.share > 0.02,
  'both halves have their part in view with nothing fitted yet',
)
check(unfitted.left.coloured < 0.05, 'the scan is bare before anything is measured')
await page.screenshot({ path: shotPath('split-before-fit.png') })
await page.click('[data-test=toggle-split]')
await page.waitForFunction(() => !document.querySelector('[data-test=compare-half]'))
await sleep(400)

// ---- align and measure -----------------------------------------------------
await page.click('[data-test=align-auto]')
await page.waitForSelector('[data-test=deviation-legend]', { timeout: 300_000 })
await page.waitForFunction(() => !document.querySelector('[data-test=fitting-chip]'), {
  timeout: 300_000,
})
await sleep(700)

// ---- the colour plot goes off and comes back -------------------------------
const painted = await halfStats('.viewport')
console.log('map on :', JSON.stringify(painted))
if (!(painted.coloured > 0.5)) fail(`the map does not look painted: ${painted.coloured}`)
const figures = await page.$eval('[data-test=deviation-stats]', (el) =>
  el.textContent.replace(/\s+/g, ' ').trim(),
)
console.log('figures:', figures)

await page.click('[data-test=toggle-colormap]')
await sleep(500)
const bare = await halfStats('.viewport')
console.log('map off:', JSON.stringify(bare))
check(bare.coloured < 0.05, 'switching the colour plot off leaves the bare surface')
check(
  Math.abs(bare.share - painted.share) < 0.02,
  'the part is the same part underneath the colours',
)
// The scale is the key to colours that are no longer there, so it goes with
// them — histogram, figures and all.
check(
  !(await page.$('[data-test=deviation-legend]')),
  'the scale goes away with the colours it explains',
)
await page.screenshot({ path: shotPath('split-plot-off.png') })

// A reading is still to be had off the map underneath, which is the proof that
// nothing was thrown away by not looking at it.
const canvas = await page.$eval('.viewport canvas', (el) => {
  const b = el.getBoundingClientRect()
  return { x: b.x, y: b.y, w: b.width, h: b.height }
})
let bareReading = null
for (const [fx, fy] of [
  [0.5, 0.5],
  [0.42, 0.4],
  [0.6, 0.6],
  [0.35, 0.65],
]) {
  await page.mouse.move(canvas.x + canvas.w * fx, canvas.y + canvas.h * fy)
  await sleep(250)
  bareReading = await page
    .$eval('[data-test=hover-readout]', (el) => el.textContent)
    .catch(() => null)
  if (bareReading) break
}
console.log('reading with the plot off:', bareReading)
check(/mm/.test(bareReading ?? ''), 'the surface still reads out with the colours off')

await page.click('[data-test=toggle-colormap]')
await sleep(500)
check((await halfStats('.viewport')).coloured > 0.5, 'the colour plot comes back')
await page.waitForSelector('[data-test=deviation-legend]')
const figuresAgain = await page.$eval('[data-test=deviation-stats]', (el) =>
  el.textContent.replace(/\s+/g, ' ').trim(),
)
check(figuresAgain === figures, 'and brings the scale back reading exactly what it read before')

// ---- side by side ----------------------------------------------------------
await page.click('[data-test=toggle-split]')
await page.waitForSelector('[data-test=compare-half]')
await sleep(900)
const canvases = await page.$$eval('.viewslot canvas', (els) => els.length)
console.log('viewports in the slot:', canvases)
if (canvases !== 2) fail(`expected two viewports side by side, got ${canvases}`)
console.log('captions:', JSON.stringify(await page.$$eval('.splitcap', (e) => e.map((c) => c.textContent))))
await page.screenshot({ path: shotPath('split-open.png') })

const opened = await bothHalves('opened')
check(
  !(await page.$('[data-test=toggle-ghost]')),
  'the ghost switch stands down while the reference has a half of its own',
)

// ---- one material, one light, in both halves --------------------------------
// With the plot off the two halves are the same part in the same grey, or the
// eye ends up comparing colours instead of shapes. It is also the check that
// catches a flat colour and a vertex-coloured surface drifting apart: three.js
// colour-manages material.color and does not touch vertex colours, so the same
// bytes written the wrong way would land a whole gamma apart.
await page.click('[data-test=toggle-colormap]')
await sleep(500)
const bareBoth = await bothHalves('with the plot off')
const gap = channelGap(bareBoth.left.mean, bareBoth.right.mean)
console.log(`mean colour: left ${bareBoth.left.mean} right ${bareBoth.right.mean}, gap ${gap}`)
check(gap <= 8, `both halves are the same shade of the same material (gap ${gap} counts)`)
await page.screenshot({ path: shotPath('split-one-material.png') })

// And they stay one material when the scheme is swapped under them — the live
// path, which dresses a viewport that is already standing rather than building
// one.
const schemes = await page.$$eval('[data-test=view-theme] option', (els) =>
  els.map((e) => e.value),
)
for (const scheme of schemes.slice(1)) {
  await page.select('[data-test=view-theme]', scheme)
  await sleep(600)
  const swapped = await bothHalves(`in ${scheme}`)
  const g = channelGap(swapped.left.mean, swapped.right.mean)
  console.log(`${scheme}: left ${swapped.left.mean} right ${swapped.right.mean}, gap ${g}`)
  check(g <= 8, `both halves follow the ${scheme} scheme together (gap ${g} counts)`)
  await page.screenshot({ path: shotPath(`split-scheme-${scheme}.png`) })
}
await page.select('[data-test=view-theme]', schemes[0])
await sleep(500)

await page.click('[data-test=toggle-colormap]')
await page.waitForSelector('[data-test=deviation-legend]')
await sleep(400)

// ---- a gesture in either half moves both -----------------------------------
async function orbit(selector, dx, dy) {
  const r = await page.$eval(selector, (el) => {
    const b = el.getBoundingClientRect()
    return { x: b.x, y: b.y, w: b.width, h: b.height }
  })
  await page.mouse.move(r.x + r.w * 0.5, r.y + r.h * 0.5)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(r.x + r.w * 0.5 + (dx * i) / 8, r.y + r.h * 0.5 + (dy * i) / 8)
    await sleep(30)
  }
  await page.mouse.up()
  await sleep(500)
}

await orbit('.compareview canvas', 150, 70)
const fromRight = await bothHalves('after turning the reference')
check(moved(fromRight.left, opened.left) > 0.004, 'turning the reference half turns the scan')
await page.screenshot({ path: shotPath('split-turned-from-reference.png') })

await orbit('.viewport canvas', -170, -60)
const fromLeft = await bothHalves('after turning the scan')
check(moved(fromLeft.right, fromRight.right) > 0.004, 'turning the scan half turns the reference')
await page.screenshot({ path: shotPath('split-turned-from-scan.png') })

const at = await page.$eval('.viewport canvas', (el) => {
  const b = el.getBoundingClientRect()
  return { x: b.x + b.width * 0.5, y: b.y + b.height * 0.5 }
})
await page.mouse.move(at.x, at.y)
for (let i = 0; i < 4; i++) {
  await page.mouse.wheel({ deltaY: -120 })
  await sleep(80)
}
await sleep(500)
const zoomed = await bothHalves('after zooming the scan')
check(
  zoomed.right.share > fromLeft.right.share * 1.1,
  'zooming one half zooms the other',
)
await page.screenshot({ path: shotPath('split-zoomed.png') })

// ---- and back to one viewport ----------------------------------------------
await page.click('[data-test=toggle-split]')
await sleep(600)
check(!(await page.$('[data-test=compare-half]')), 'the reference half goes away with the switch')
const closed = await page.$$eval('.viewslot canvas', (els) => els.length)
if (closed !== 1) fail(`expected one viewport after closing the split view, got ${closed}`)
check(
  Boolean(await page.$('[data-test=toggle-ghost]')),
  'the ghost switch comes back with the single view',
)
await page.screenshot({ path: shotPath('split-closed.png') })

await finish(browser, consoleErrors)

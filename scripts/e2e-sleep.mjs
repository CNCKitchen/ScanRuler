// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end check that the viewports stop asking for frames when nothing
// changes, and that everything that should move the picture still does after
// they have: a wheel, a pinch, the deviation map played as motion, and a drag
// in either half of the split view moving the other.
//
// The frames are counted by wrapping requestAnimationFrame before the app's
// first script runs. An idle page should run none at all. A phone pays for
// every one in battery, and the loops used to run sixty a second each
// whether anything moved or not.
//
// The pair is built here, the same way e2e-split.mjs builds it: a STEP cube as
// the reference and a fine mesh of the same cube, two faces displaced, as the
// scan, so there is a map with something in it to play.
//
// Prereqs: dev server running (npm run dev), Chrome installed. Reads the
// camera through the development hook, window.__scanruler.
//   node scripts/e2e-sleep.mjs
// Env: CHROME (chrome.exe path), APP_URL, SHOT_DIR.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importStep, writeBinarySTL } from 'meshstep'
import { cubeStep } from '../tests/stepFixtures.ts'
import { check, finish, launchApp, loadScan, pixelDiff, sleep } from './e2e-lib.mjs'

const SIZE = 20

// ---- the pair --------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'scanruler-sleep-'))
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

// Touch on, for the pinch; the mouse still works alongside it.
const { browser, page, consoleErrors } = await launchApp({ width: 1500, height: 950 })
await page.setViewport({ width: 1500, height: 950, hasTouch: true, deviceScaleFactor: 1 })
await page.evaluateOnNewDocument(() => {
  window.__raf = 0
  const raf = window.requestAnimationFrame.bind(window)
  window.requestAnimationFrame = (cb) =>
    raf((t) => {
      window.__raf++
      cb(t)
    })
})
await page.reload({ waitUntil: 'networkidle0' })
await page.waitForSelector('.panel')

/** Frame callbacks that ran over `ms`. */
const framesOver = async (ms) => {
  const a = await page.evaluate(() => window.__raf)
  await sleep(ms)
  return (await page.evaluate(() => window.__raf)) - a
}
/** Long enough for every loop to have wound down after the last change. */
const SETTLE = 1500
const clipOf = (sel) =>
  page.$eval(sel, (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
const shot = (clip) => page.screenshot({ clip, encoding: 'base64' })
const camera = () =>
  page.evaluate(() => {
    const v = window.__scanruler.scene().viewport
    const at = v.camera.position
    return { at: [at.x, at.y, at.z], zoom: v.camera.zoom }
  })
const apart = (a, b) => Math.hypot(a.at[0] - b.at[0], a.at[1] - b.at[1], a.at[2] - b.at[2]) + Math.abs(a.zoom - b.zoom)

// ---- a map on the stage ------------------------------------------------------
await page.click('[data-test=workspace-deviation]')
await page.waitForSelector('[data-test=start-pane]')
await loadScan(page, scanPath, { inputSelector: '[data-test=start-scan] input[type=file]', timeout: 300_000, settle: 600 })
await (await page.$('[data-test=slot-reference] input[type=file]')).uploadFile(stepPath)
await page.waitForFunction(() => document.querySelector('[data-test=align-auto]')?.disabled === false, { timeout: 300_000 })
await sleep(900)
await page.click('[data-test=align-auto]')
await page.waitForSelector('[data-test=deviation-legend]', { timeout: 300_000 })
await page.waitForFunction(() => !document.querySelector('[data-test=fitting-chip]'), { timeout: 300_000 })
await sleep(SETTLE)

let n = await framesOver(2000)
check(n === 0, `idle with a map on, no frames run (${n} in 2 s)`)

// ---- a wheel after sleeping -------------------------------------------------
const view = await clipOf('.viewslot canvas')
const middle = [view.x + view.width / 2, view.y + view.height / 2]
await page.mouse.move(...middle)
await sleep(SETTLE)
let before = await shot(view)
let from = await camera()
await page.mouse.wheel({ deltaY: -240 })
await sleep(500)
let to = await camera()
check(to.zoom > from.zoom, `a wheel after sleeping zooms (zoom ${from.zoom.toFixed(3)} → ${to.zoom.toFixed(3)})`)
check((await pixelDiff(page, before, await shot(view))) > 1, 'and the picture follows it')
await page.mouse.wheel({ deltaY: 240 })
await sleep(SETTLE)

// ---- a pinch after sleeping -------------------------------------------------
// Two fingers dispatched over CDP, as e2e-touch.mjs does: Puppeteer's own
// touchscreen has one.
const cdp = await page.createCDPSession()
const touch = (type, points) =>
  cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map(([x, y], i) => ({ x, y, id: i + 1, radiusX: 12, radiusY: 12, force: 1 })),
  })
n = await framesOver(1000)
check(n === 0, `asleep before the pinch (${n} frames in 1 s)`)
before = await shot(view)
from = await camera()
const spread = (d) => [
  [middle[0] - d, middle[1]],
  [middle[0] + d, middle[1]],
]
async function pinch(d0, d1) {
  await touch('touchStart', spread(d0))
  await sleep(40)
  for (let s = 1; s <= 10; s++) {
    await touch('touchMove', spread(d0 + ((d1 - d0) * s) / 10))
    await sleep(22)
  }
  await touch('touchEnd', [])
  await sleep(500)
}
await pinch(55, 190)
to = await camera()
check(to.zoom > from.zoom * 1.3, `a pinch after sleeping zooms in (zoom ${from.zoom.toFixed(3)} → ${to.zoom.toFixed(3)})`)
check((await pixelDiff(page, before, await shot(view))) > 1, 'and the picture follows the fingers')
await sleep(SETTLE)
n = await framesOver(2000)
check(n === 0, `asleep again after the pinch (${n} frames in 2 s)`)
// Back out, so the motion below plays on the whole part: zoomed into the
// middle of a face, the displaced faces are off the screen.
await pinch(190, 55)
const back = await camera()
check(back.zoom < to.zoom / 1.3, `pinching back zooms out again (zoom ${to.zoom.toFixed(3)} → ${back.zoom.toFixed(3)})`)
await sleep(SETTLE)

// ---- the map played as motion -------------------------------------------------
await page.click('[data-test=animate-deformation]')
await sleep(800)
n = await framesOver(1000)
const a = await shot(view)
await sleep(350)
const moved = await pixelDiff(page, a, await shot(view))
check(n >= 20 && moved > 0.5, `the motion keeps the frames running (${n} in 1 s, ${moved.toFixed(2)} % of the view changed in 350 ms)`)
await page.click('[data-test=animate-deformation]')
await sleep(SETTLE)
n = await framesOver(2000)
check(n === 0, `stopped, the loop sleeps again (${n} frames in 2 s)`)

// ---- the split view: either half moves the other ------------------------------
await page.click('[data-test=toggle-split]')
await page.waitForSelector('.compareview canvas')
await sleep(SETTLE)
n = await framesOver(2000)
check(n === 0, `the split view open and idle (${n} frames in 2 s)`)
const half = await clipOf('.compareview canvas')
const scanHalf = await clipOf('.viewslot canvas')
async function orbit(r) {
  await page.mouse.move(r.x + r.width * 0.5, r.y + r.height * 0.5)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(r.x + r.width * 0.5 + (150 * i) / 8, r.y + r.height * 0.5 + (70 * i) / 8)
    await sleep(30)
  }
  await page.mouse.up()
  await sleep(600)
}
from = await camera()
before = await shot(scanHalf)
await orbit(half)
to = await camera()
check(apart(from, to) > 1e-3, `a drag in the reference half turns the scan half's camera (${apart(from, to).toFixed(3)})`)
check((await pixelDiff(page, before, await shot(scanHalf))) > 1, 'and the scan half is drawn turned')
await sleep(SETTLE)
before = await shot(half)
await orbit(scanHalf)
check((await pixelDiff(page, before, await shot(half))) > 1, 'a drag in the scan half redraws the reference half turned')
await sleep(SETTLE)
n = await framesOver(2000)
check(n === 0, `linked and idle again (${n} frames in 2 s)`)
await page.click('[data-test=toggle-split]')
await sleep(SETTLE)
n = await framesOver(2000)
check(n === 0, `the split view closed, its half kept and paused (${n} frames in 2 s)`)

await finish(browser, consoleErrors)

// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end test for the live alignment preview: drives the real app in
// headless Chrome — starts an alignment (which centres the part on the datum
// stage), picks three points on the scan, and checks that the part actually
// swings onto the chosen plane as soon as the third point lands, swings again
// when the face it stands for is changed, and holds the camera still while it
// does, so a slot picked with the part zoomed in stays pickable.
//
// The picked points are checked to be labelled "Plane 1…3" as well: they are
// three clicks on one face, not three heights.
//
// Frames are compared by decoding both screenshots back in the page and
// counting how many pixels differ — a pose change repaints a large share of
// the viewport, an idle one none of it.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node scripts/e2e-align-live.mjs
// Env: CHROME (chrome.exe path), APP_URL, STL (scan path), SHOT_DIR (shots).
import { writeFileSync } from 'node:fs'
import {
  canvasRect,
  check,
  finish,
  launchApp,
  loadScan,
  pixelDiff,
  repoFile,
  shotPath,
  sleep,
} from './e2e-lib.mjs'

const STL = process.env.STL ?? repoFile('block-marius.stl')

const { browser, page, consoleErrors } = await launchApp()
await loadScan(page, STL)
const rect = await canvasRect(page)

/** A shot of the viewport, kept as base64 so the page can decode it again. */
const shot = async (name) => {
  const buf = await page.screenshot({
    clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h },
  })
  if (name) writeFileSync(shotPath(`e2e-align-live-${name}.png`), buf)
  return buf.toString('base64')
}

const diff = (a, b) => pixelDiff(page, a, b)

/** The labels the picked points wear, in the order they were placed. */
const pickLabels = () =>
  page.$$eval('.viewport-label.probe .label-title', (els) => els.map((e) => e.textContent.trim()))

// Control: an untouched viewport paints the same picture twice, so everything
// measured below is the part having moved rather than noise.
const idleA = await shot()
await sleep(400)
const idle = await diff(idleA, await shot())
check(idle < 0.05, `an untouched viewport repaints identically (${idle.toFixed(3)}% differ)`)

await page.click('[data-test="start-alignment"]')
await sleep(500)
// Opening the editor puts the target frame on the stage — the coordinate
// planes and axes — and centres the part on it, which repaints most pixels.
const staged = await diff(idleA, await shot())
check(staged > 5, `opening the editor centres the part on the datum stage (${staged.toFixed(1)}%)`)
const stageLabels = await page.$$eval('.stage-label .label-title', (els) =>
  els.map((e) => e.textContent.trim()),
)
check(
  ['X = 0', 'Y = 0', 'Z = 0', '+X', '+Y', '+Z'].every((t) => stageLabels.includes(t)),
  `the coordinate planes and axes are labelled (${JSON.stringify(stageLabels)})`,
)

await page.select('[data-test="align-primary"]', '__pick__')
await sleep(200)

/** Click the scan until a pick lands, sweeping offsets for the holes. */
async function alignPick(fx, fy, offsets = [[0, 0], [30, 0], [0, 30], [-30, 0], [0, -30]]) {
  const before = (await pickLabels()).length
  for (const [dx, dy] of offsets) {
    await page.mouse.click(rect.x + rect.w * fx + dx, rect.y + rect.h * fy + dy)
    await sleep(250)
    if ((await pickLabels()).length > before) return true
  }
  return false
}

check(await alignPick(0.5, 0.45), 'pick 1 landed')
check(await alignPick(0.58, 0.52), 'pick 2 landed')
const picking = await shot('1-picking')
// Two points cannot span a plane, so nothing may have moved yet.
const still = await diff(picking, await shot())
check(still < 0.05, `the part stands still while the picks are incomplete (${still.toFixed(3)}%)`)

check(await alignPick(0.5, 0.58), 'pick 3 landed')
const labels = await pickLabels()
check(
  JSON.stringify(labels) === JSON.stringify(['Plane 1', 'Plane 2', 'Plane 3']),
  `picked points are labelled Plane 1…3 (${JSON.stringify(labels)})`,
)
const levelled = await shot('2-levelled')
const swing = await diff(picking, levelled)
check(swing > 5, `the part swings onto the plane as the third point lands (${swing.toFixed(1)}%)`)
check(
  await page.$eval('[data-test="align-preview"]', (el) => /\d/.test(el.textContent)),
  `the panel agrees a transform is ready (${await page.$eval('[data-test="align-preview"]', (el) => el.textContent.trim())})`,
)

// Which side of the part the picked face is — a live control too.
await page.select('[data-test="align-primary-axis"]', 'y-')
await sleep(500)
const reaxed = await shot('3-axis-changed')
const turn = await diff(levelled, reaxed)
check(turn > 5, `the part swings again when the face is read differently (${turn.toFixed(1)}%)`)

await page.select('[data-test="align-primary-axis"]', 'z-')
await sleep(500)
const back = await diff(levelled, await shot())
check(back < 0.05, `and swings back when the bottom is chosen again (${back.toFixed(3)}%)`)

// Applying only makes the preview real. The camera re-frames the part as it
// always has, so what is checked here is that it ends up on screen and that
// the preview machinery has let go of it.
await page.click('[data-test="apply-alignment"]')
await page.waitForFunction(() => (document.body.innerText ?? '').includes('Part aligned'), {
  timeout: 60_000,
})
await sleep(800)
const applied = await shot('4-applied')
check((await pickLabels()).length === 0, 'the pick markers come off when the alignment is applied')
const settled = await diff(applied, await shot())
check(settled < 0.05, `the aligned part comes to rest (${settled.toFixed(3)}% differ)`)
check(
  (await page.$('[data-test="reset-alignment"]')) !== null,
  'the alignment is recorded and can be reset',
)

// A preview that failed to let go would leave the part carrying its transform
// twice over, nowhere near the middle of the view. Ask the app where the part
// is by clicking at it: a pick only lands where the ray hits the scan.
await page.click('[data-test="start-alignment"]')
await page.select('[data-test="align-primary"]', '__pick__')
await sleep(200)
check(await alignPick(0.5, 0.5), 'the aligned part sits under the middle of the view')
await page.click('[data-test="cancel-alignment"]')

await finish(browser, consoleErrors)

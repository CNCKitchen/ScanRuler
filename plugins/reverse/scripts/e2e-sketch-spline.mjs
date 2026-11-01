// SPDX-License-Identifier: AGPL-3.0-only
import { dismissSupportCard } from '../../../scripts/e2e-lib.mjs'
// End-to-end test of the sketch's Spline tool, with the mouse, on a blank
// stage: the key in the tool row and on S takes it in hand; clicks lay its
// points with the curve following the cursor; a second click on the last
// point ends it open, a click on the first closes it, Enter ends one in
// hand; a fit point dragged with the Select tool bends the curve; and the
// closed spline's region extrudes into a closed body.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node plugins/reverse/scripts/e2e-sketch-spline.mjs
// Env: CHROME (chrome.exe path), APP_URL, SHOT_DIR.
import { check, click, drag, finish, launchApp, shotPath, sleep } from '../../../scripts/e2e-lib.mjs'
import { openReverse, reverseHelpers } from './lib.mjs'

const { browser, page, consoleErrors } = await launchApp({ width: 1600, height: 1000, protocolTimeout: 600_000 })
const { re, built } = reverseHelpers(page)

await openReverse(page)
await sleep(300)
await dismissSupportCard(page)

// A sketch with two lines laid above and below where the curves go, so
// the sheet is framed over them.
await re(() => {
  const frame = { origin: [0, 0, 0], normal: [0, 0, 1], basisU: [1, 0, 0], basisV: [0, 1, 0] }
  const s = () => window.__re.store.getState()
  s().startSketch({ kind: 'world', axis: 'z', offset: 0 }, frame)
  s().setSketchTool('line')
  s().sketchClick([-10, -40], 0.01, false, { off: true })
  s().sketchClick([110, -40], 0.01, false, { off: true })
  s().clearSelection()
  s().sketchClick([-10, 40], 0.01, false, { off: true })
  s().sketchClick([110, 40], 0.01, false, { off: true })
  s().setSketchTool('select')
})
await page.waitForSelector('[data-test=sketch-viewport] canvas')
await sleep(800)

/** A sheet point (sketch millimetres) on screen. */
const toClient = (p) =>
  re(([x, y]) => {
    const v = window.__re.sheet().sheetView()
    const r = document.querySelector('[data-test=sketch-viewport] canvas').getBoundingClientRect()
    return [r.x + r.width / 2 + (x - v.centre[0]) / v.unitsPerScreenPx, r.y + r.height / 2 - (y - v.centre[1]) / v.unitsPerScreenPx]
  }, p)
const clickAt = async (p) => {
  const [x, y] = await toClient(p)
  await page.mouse.move(x, y)
  await sleep(80)
  await page.mouse.click(x, y)
  await sleep(150)
}
const draft = () => re(() => {
  const d = window.__re.store.getState().sketchDraft
  return { tool: d.tool, pending: d.pending.length, error: d.error, splines: d.sketch.entities.filter((e) => e.kind === 'spline'), regions: d.found.length }
})

// ---- the key, and an open spline ended by a second click on its last point -------------
check((await page.$('[data-test=sketch-tools] [data-test=sketch-tool-spline]')) !== null, 'Spline is in the tool row')
await click(page, '[data-test=sketch-tool-spline]')
check((await draft()).tool === 'spline', 'the Spline key takes the tool in hand')
for (const p of [[0, 0.3], [20, 18], [45, 10], [60, 22]]) await clickAt(p)
let d = await draft()
check(d.pending === 4 && d.splines.length === 0, `each click lays a point, nothing made yet (${JSON.stringify(d)})`)
// The curve follows the cursor: the preview is drawn to it.
const [hx, hy] = await toClient([75, 5])
await page.mouse.move(hx, hy)
await sleep(200)
await page.screenshot({ path: shotPath('sketch-spline-1.png') })
await clickAt([60, 22])
d = await draft()
check(d.splines.length === 1 && d.splines[0].pts.length === 4 && !d.splines[0].closed && d.pending === 0, `a second click on the last point ends it open, through its four points (${JSON.stringify(d.splines)})`)

// ---- S, and a closed spline ---------------------------------------------------------------
await page.keyboard.press('Escape')
await sleep(100)
check((await draft()).tool === 'select', 'Escape with nothing in hand puts the tool down')
await page.keyboard.press('s')
await sleep(100)
check((await draft()).tool === 'spline', 'S takes it up again')
for (const p of [[70, -30], [95, -25], [100, -5], [75, -8]]) await clickAt(p)
await clickAt([70, -30])
d = await draft()
const closed = d.splines.find((e) => e.closed)
check(closed !== undefined && closed.pts.length === 4, `a click back on the first point closes it (${JSON.stringify(d.splines.map((e) => ({ n: e.pts.length, closed: e.closed })))})`)
check(d.regions >= 1, `the closed spline is a region (${d.regions})`)

// ---- Enter ends the points in hand ------------------------------------------------------------
for (const p of [[0, -20], [25, -15]]) await clickAt(p)
await page.keyboard.press('Enter')
await sleep(200)
d = await draft()
check(d.splines.length === 3 && d.pending === 0 && d.tool === 'spline', `Enter makes the curve of the points in hand and keeps the tool (${d.splines.length}, ${d.pending}, ${d.tool})`)
await page.screenshot({ path: shotPath('sketch-spline-2.png') })

// ---- a fit point dragged bends the curve --------------------------------------------------
await page.keyboard.press('Escape')
await sleep(100)
const before = await re(() => window.__re.store.getState().sketchDraft.sketch.entities.find((e) => e.kind === 'spline').pts[1])
await drag(page, await toClient(before), await toClient([22, 30]))
await sleep(300)
const after = await re(() => window.__re.store.getState().sketchDraft.sketch.entities.find((e) => e.kind === 'spline').pts[1])
check(Math.hypot(after[0] - 22, after[1] - 30) < 1, `a fit point dragged with Select lands where it was let go (${JSON.stringify(before)} → ${JSON.stringify(after)})`)
await page.screenshot({ path: shotPath('sketch-spline-3.png') })

// ---- the closed spline's region, extruded ---------------------------------------------------
const key = await re(() => {
  const s = () => window.__re.store.getState()
  const d = s().sketchDraft
  const id = d.sketch.entities.find((e) => e.kind === 'spline' && e.closed).id
  return d.found.find((r) => r.outer.pieces.length === 1 && r.outer.pieces[0].entity === id)?.key ?? null
})
check(key !== null, 'the closed spline bounds a region of its own')
await re((k) => {
  const s = () => window.__re.store.getState()
  const id = s().commitSketch()
  s().startExtrude(id, [k])
}, key)
await sleep(300)
await re(() => window.__re.store.getState().commitExtrude())
await built()
const body = await re(() => window.__re.store.getState().bodies[0])
check(body.closed && body.volume > 100, `the region extrudes into a closed body (${JSON.stringify({ closed: body.closed, volume: body.volume, faces: body.faces })})`)
check(body.faces === 3, `with one smooth wall round it — a top, a bottom and the spline's face (${body.faces})`)
await page.screenshot({ path: shotPath('sketch-spline-4.png') })

await finish(browser, consoleErrors)

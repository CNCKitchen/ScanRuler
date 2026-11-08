// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end test of the selection box on the sketch sheet, with the mouse,
// on a blank stage: a rectangle and a lone line beside it; with the Select
// tool a left-drag over the bare sheet draws a box instead of panning —
// dragged rightward a solid window that takes the pieces wholly inside it,
// dragged leftward a dashed crossing box that takes what it touches, lit
// while it is dragged; Shift adds to the selection, and so does Command,
// which also starts a drag on a piece; a click on the bare sheet still clears it; a press on a piece still drags the piece; the
// right button still pans; and a drawing tool in hand leaves the left-drag
// a pan.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node plugins/reverse/scripts/e2e-sketch-box.mjs
// Env: CHROME (chrome.exe path), APP_URL, SHOT_DIR.
import { check, click, finish, launchApp, MOD, shotPath, sleep } from '../../../scripts/e2e-lib.mjs'
import { openReverse, reverseHelpers } from './lib.mjs'

const { browser, page, consoleErrors } = await launchApp({ width: 1600, height: 1000, protocolTimeout: 600_000 })
const { re } = reverseHelpers(page)

await openReverse(page)
await sleep(300)
// The support card sits over the stage's lower left, where the boxes start.
if (await page.$('[data-test=support-card] .sc-x')) await click(page, '[data-test=support-card] .sc-x')

// ---- a rectangle and a lone line beside it --------------------------------------------
const ids = await re(() => {
  const frame = { origin: [0, 0, 0], normal: [0, 0, 1], basisU: [1, 0, 0], basisV: [0, 1, 0] }
  const s = () => window.__re.store.getState()
  s().startSketch({ kind: 'world', axis: 'z', offset: 0 }, frame)
  s().setSketchTool('rectangle')
  s().sketchClick([10, 5], 0.01, false, { off: true })
  s().sketchClick([50, 25], 0.01, false, { off: true })
  s().setSketchTool('line')
  s().sketchClick([60, 5], 0.01, false, { off: true })
  s().sketchClick([80, 5], 0.01, false, { off: true })
  s().setSketchTool('select')
  const pieces = s().sketchDraft.sketch.entities
  return {
    square: pieces.filter((e) => e.kind === 'line' && Math.max(e.a[0], e.b[0]) < 55).map((e) => e.id).sort((a, b) => a - b),
    bottom: pieces.find((e) => e.kind === 'line' && Math.max(e.a[0], e.b[0]) < 55 && Math.abs(e.a[1] - 5) < 0.5 && Math.abs(e.b[1] - 5) < 0.5).id,
    right: pieces.find((e) => e.kind === 'line' && Math.abs(e.a[0] - 50) < 0.5 && Math.abs(e.b[0] - 50) < 0.5).id,
    lone: pieces.find((e) => e.kind === 'line' && e.a[0] > 55).id,
  }
})
await page.waitForSelector('[data-test=sketch-viewport] canvas')
await sleep(800)
check(ids.square.length === 4, 'the rectangle is four lines')

/** A sheet point (sketch millimetres) on screen: the sheet is shown face
 *  on, unturned, its view centre in the middle of the canvas. */
const toClient = (p) =>
  re(([x, y]) => {
    const v = window.__re.sheet().sheetView()
    const r = document.querySelector('[data-test=sketch-viewport] canvas').getBoundingClientRect()
    return [r.x + r.width / 2 + (x - v.centre[0]) / v.unitsPerScreenPx, r.y + r.height / 2 - (y - v.centre[1]) / v.unitsPerScreenPx]
  }, p)
const selection = () => re(() => [...window.__re.store.getState().sketchDraft.selection].sort((a, b) => a - b))
const centre = () => re(() => window.__re.sheet().sheetView().centre)
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

/** Press at one sheet point, move to another in steps, and let go —
 *  `before` runs with the button still down, at the far end. */
async function drag(from, to, { button = 'left', shift = false, key = shift ? 'Shift' : null, before } = {}) {
  const [x0, y0] = await toClient(from)
  const [x1, y1] = await toClient(to)
  if (key) await page.keyboard.down(key)
  await page.mouse.move(x0, y0)
  await page.mouse.down({ button })
  for (let i = 1; i <= 8; i++) await page.mouse.move(x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8)
  await sleep(120)
  if (before) await before()
  await page.mouse.up({ button })
  if (key) await page.keyboard.up(key)
  await sleep(250)
}

// ---- a window, rightward ----------------------------------------------------------------
const startCentre = await centre()
let band = null
await drag([5, 0], [55, 30], {
  before: async () => {
    band = await re(() => {
      const b = document.querySelector('[data-test=sketch-viewport] .flat-band.box')
      return b ? { window: b.classList.contains('window'), crossing: b.classList.contains('crossing'), additive: b.classList.contains('additive'), w: b.getBoundingClientRect().width } : null
    })
    await page.screenshot({ path: shotPath('sketch-box-window.png') })
  },
})
check(band !== null && band.window && !band.crossing && band.w > 50, 'dragged rightward the box is a window')
check(band !== null && !band.additive, 'with no key held it bears no + (it replaces the selection)')
check(same(await selection(), ids.square), 'the window takes the four sides of the rectangle, not the lone line')
check(same(await centre(), startCentre), 'the left-drag did not pan the sheet')
check((await re(() => document.querySelector('[data-test=sketch-viewport] .flat-band'))) === null, 'the box is gone once let go')

// A window that leaves a piece half out does not take it.
await drag([5, 0], [55, 15])
check(same(await selection(), [ids.bottom]), 'a window over the lower half takes only the bottom side')

// ---- a crossing box, leftward -------------------------------------------------------------
await drag([70, 10], [45, 0], {
  before: async () => {
    band = await re(() => {
      const b = document.querySelector('[data-test=sketch-viewport] .flat-band.box')
      return b ? { window: b.classList.contains('window'), crossing: b.classList.contains('crossing') } : null
    })
    await page.screenshot({ path: shotPath('sketch-box-crossing.png') })
  },
})
check(band !== null && band.crossing && !band.window, 'dragged leftward the box is a crossing box')
check(same(await selection(), [ids.bottom, ids.right, ids.lone].sort((a, b) => a - b)), 'the crossing box takes the bottom and right sides it touches and the lone line')

// ---- Shift adds -------------------------------------------------------------------------
/** Whether the box on the stage bears the + of a box that adds. */
const marked = () => re(() => document.querySelector('[data-test=sketch-viewport] .flat-band.box')?.classList.contains('additive') ?? null)
let adding = null
await drag([5, 0], [55, 30], {
  shift: true,
  before: async () => {
    adding = await marked()
    await page.screenshot({ path: shotPath('sketch-box-additive.png') })
  },
})
check(adding === true, 'with Shift held the box bears a + while it is dragged (issue 62)')
check(same(await selection(), [...ids.square, ids.lone].sort((a, b) => a - b)), 'a window with Shift held adds the rectangle to the selection')
check(same(await centre(), startCentre), 'the Shift+drag did not pan the sheet')

// ---- Command, as a Mac presses it ----------------------------------------------------------
await drag([70, 10], [45, 0])
adding = null
await drag([5, 0], [55, 30], { key: 'Meta', before: async () => (adding = await marked()) })
check(adding === true, 'and with Command held too')
check(same(await selection(), [...ids.square, ids.lone].sort((a, b) => a - b)), 'a window with Command held adds the rectangle to the selection')
check(same(await centre(), startCentre), 'the Command+drag did not pan the sheet')
{
  const before = await re((id) => window.__re.store.getState().sketchDraft.sketch.entities.find((e) => e.id === id).a[1], ids.lone)
  await drag([70, 5], [70, 2], { key: 'Meta' })
  const after = await re((id) => window.__re.store.getState().sketchDraft.sketch.entities.find((e) => e.id === id).a[1], ids.lone)
  check(after < before - 1, `a press on a piece with Command held starts its drag (${before} to ${after})`)
  check(same(await centre(), startCentre), 'and does not pan the sheet')
  // The platform's own key: on a Mac, Control with a click is a right click.
  await page.keyboard.down(MOD)
  await page.keyboard.press('z')
  await page.keyboard.up(MOD)
  await sleep(250)
}

// ---- a click on the bare sheet clears ------------------------------------------------------
{
  const [x, y] = await toClient([30, 40])
  await page.mouse.click(x, y)
  await sleep(250)
}
check((await selection()).length === 0, 'a click on the bare sheet clears the selection')

// ---- a press on a piece drags it ----------------------------------------------------------
const loneBefore = await re((id) => window.__re.store.getState().sketchDraft.sketch.entities.find((e) => e.id === id).a, ids.lone)
await drag([70, 5], [70, -5])
const loneAfter = await re((id) => window.__re.store.getState().sketchDraft.sketch.entities.find((e) => e.id === id).a, ids.lone)
check(loneAfter[1] < loneBefore[1] - 5, 'a press on a piece still drags the piece')
check(same(await selection(), [ids.lone]), 'the piece dragged is the selection')

// ---- the right button pans ----------------------------------------------------------------
await drag([30, 15], [10, 15], { button: 'right' })
const panned = await centre()
check(panned[0] > startCentre[0] + 10, 'a right-drag pans the sheet')
check(same(await selection(), [ids.lone]), 'the right-drag leaves the selection be')

// ---- a drawing tool leaves the left-drag a pan ----------------------------------------------
await re(() => window.__re.store.getState().setSketchTool('line'))
await sleep(200)
const before = await centre()
await drag([30, 15], [10, 15])
check((await centre())[0] > before[0] + 10, 'with the Line tool in hand a left-drag pans')
check((await re(() => document.querySelector('[data-test=sketch-viewport] .flat-band'))) === null, 'and draws no box')

await finish(browser, consoleErrors)

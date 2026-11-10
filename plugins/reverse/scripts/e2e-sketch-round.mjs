// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end test of the sketch round from the public tracker, with the
// mouse, on a blank stage: dashed tracking lines from a circle's centre the
// cursor passed over, a line's start placed level with it and a point where
// two tracking lines cross (issue 107), and a line's start tracked with a
// point passed over after quadrants on the way; the Point tool held on a line's
// middle (issue 103); Trim lighting the stretch it would take and taking it
// (issue 102); and a distance between two centres pulled above them to its
// ΔX, then switched by its chip (issue 106).
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node plugins/reverse/scripts/e2e-sketch-round.mjs
// Env: CHROME (chrome.exe path), APP_URL, SHOT_DIR.
import { check, click, finish, launchApp, shotPath, sleep } from '../../../scripts/e2e-lib.mjs'
import { openReverse, reverseHelpers } from './lib.mjs'

const { browser, page, consoleErrors } = await launchApp({ width: 1600, height: 1000, protocolTimeout: 600_000 })
const { re } = reverseHelpers(page)

await openReverse(page)
await sleep(300)
if (await page.$('[data-test=support-card] .sc-x')) await click(page, '[data-test=support-card] .sc-x')

// ---- a circle at the origin, an upright line, a level line across ---------------------------
await re(() => {
  const frame = { origin: [0, 0, 0], normal: [0, 0, 1], basisU: [1, 0, 0], basisV: [0, 1, 0] }
  const s = () => window.__re.store.getState()
  s().startSketch({ kind: 'world', axis: 'z', offset: 0 }, frame)
  s().setSketch({
    entities: [
      { id: 1, kind: 'circle', c: [5, 5], r: 3 },
      { id: 2, kind: 'line', a: [40, -10], b: [40, 30] },
      { id: 3, kind: 'line', a: [-10, 15], b: [60, 15] },
      { id: 4, kind: 'circle', c: [25, -8], r: 2 },
    ],
    constraints: [],
    nextId: 5,
  })
})
await page.waitForSelector('[data-test=sketch-viewport] canvas')
await sleep(800)

/** A sheet point (sketch millimetres) on screen, the sheet face on. */
const toClient = (p) =>
  re(([x, y]) => {
    const v = window.__re.sheet().sheetView()
    const r = document.querySelector('[data-test=sketch-viewport] canvas').getBoundingClientRect()
    return [r.x + r.width / 2 + (x - v.centre[0]) / v.unitsPerScreenPx, r.y + r.height / 2 - (y - v.centre[1]) / v.unitsPerScreenPx]
  }, p)
/** Move the cursor to a sheet point, `dx`, `dy` screen pixels off it. */
const hover = async (p, dx = 0, dy = 0) => {
  const [x, y] = await toClient(p)
  await page.mouse.move(x + dx, y + dy, { steps: 4 })
  await sleep(120)
  return [x + dx, y + dy]
}
const clickAt = async (p, dx = 0, dy = 0) => {
  const [x, y] = await hover(p, dx, dy)
  await page.mouse.click(x, y)
  await sleep(200)
}
/** The guide lines the sheet draws: how many, and how many dashed. */
const guides = () =>
  re(() => {
    const g = window.__re.sheet().guideGroup.children
    return { count: g.length, dashed: g.filter((l) => l.material.dashed).length }
  })
const draft = () => re(() => window.__re.store.getState().sketchDraft)

// ---- tracking lines ------------------------------------------------------------------------------
await click(page, '[data-test=sketch-tool-line]')
check((await guides()).count === 0, 'no tracking line before the cursor has passed over a point')
// Off the coordinate planes' lines, so only the tracking line is there.
await hover([5, 5], 1, 1)
await hover([25, 5], 0, 2)
const level = await guides()
check(level.count === 1 && level.dashed === 1, `level with the circle's centre a dashed tracking line runs from it (${JSON.stringify(level)})`)
await page.screenshot({ path: shotPath('sketch-round-track.png') })
await clickAt([25, 5], 0, 2)
const start = (await draft()).pending[0]
check(start && Math.abs(start[1] - 5) < 1e-9 && Math.abs(start[0] - 25) < 0.5, `the line's start lands on it, exactly level with the centre (${JSON.stringify(start)})`)
await page.keyboard.press('Escape')
await sleep(150)
// Over the upright line's top end, then where the centre's upright and the
// end's level cross.
await hover([40, 30], 1, -1)
await hover([5, 30], 2, 2)
const crossing = await guides()
check(crossing.count === 2 && crossing.dashed === 2, `two tracking lines meet where the centre's upright crosses the end's level (${JSON.stringify(crossing)})`)
await clickAt([5, 30], 2, 2)
const corner = (await draft()).pending[0]
check(corner && Math.abs(corner[0] - 5) < 1e-9 && Math.abs(corner[1] - 30) < 1e-9, `and a click there lands on the crossing (${JSON.stringify(corner)})`)
await page.keyboard.press('Escape')
await page.keyboard.press('Escape')
await sleep(150)
// A line from one centre to where it stands level with that centre and
// upright with another, the cursor passing both circles' quadrants on the
// way: each pushed a wanted point out of a memory of two, so only one
// tracking line was left (issue 107, second round). The sketch is put
// back after, as the steps below expect it.
const sketchBefore = await re(() => window.__re.store.getState().sketchDraft.sketch)
await click(page, '[data-test=sketch-tool-line]')
await clickAt([5, 5])
await hover([8, 5])
await hover([25, -8])
await hover([25, -6])
await hover([25, 5], 2, 2)
const both = await guides()
check(both.count === 2 && both.dashed === 2, `level with the line's start and upright with the other centre, both tracking lines show (${JSON.stringify(both)})`)
await page.screenshot({ path: shotPath('sketch-round-track-both.png') })
await clickAt([25, 5], 2, 2)
const end = (await draft()).sketch.entities.find((e) => e.kind === 'line' && Math.abs(e.a[0] - 5) < 1e-9 && Math.abs(e.a[1] - 5) < 1e-9)
check(end && Math.abs(end.b[0] - 25) < 1e-9 && Math.abs(end.b[1] - 5) < 1e-9, `and the line ends on the crossing (${JSON.stringify(end)})`)
await page.keyboard.press('Escape')
await page.keyboard.press('Escape')
await sleep(150)
await re((sketch) => window.__re.store.getState().setSketch(sketch), sketchBefore)
await sleep(150)

// ---- the Point tool on a line's middle ----------------------------------------------------------
await click(page, '[data-test=sketch-tool-point]')
await clickAt([40, 10], 2, 0)
const pointed = await re(() => {
  const d = window.__re.store.getState().sketchDraft
  const p = d.sketch.entities.find((e) => e.kind === 'point')
  return { p: p?.p, held: d.sketch.constraints.some((c) => c.kind === 'coincident' && c.p.entity === p?.id && c.q.entity === 2 && c.q.at === 'center') }
})
check(pointed.p && Math.abs(pointed.p[0] - 40) < 1e-9 && Math.abs(pointed.p[1] - 10) < 1e-9 && pointed.held, `a point clicked at the upright's middle sits there, held to it (${JSON.stringify(pointed)})`)

// ---- Trim -------------------------------------------------------------------------------------------
await page.keyboard.press('Escape')
await page.keyboard.press('t')
await sleep(100)
check((await draft()).tool === 'trim', 'T takes Trim in hand')
await hover([52, 15], 0, 1)
const lit = await guides()
check(lit.count === 1 && lit.dashed === 0, `the stretch a click would take is lit under the cursor (${JSON.stringify(lit)})`)
await page.screenshot({ path: shotPath('sketch-round-trim.png') })
await clickAt([52, 15], 0, 1)
const trimmed = await re(() => {
  const d = window.__re.store.getState().sketchDraft
  const l = d.sketch.entities.find((e) => e.id === 3)
  return { error: d.error, b: l?.b, onUpright: d.sketch.constraints.some((c) => c.kind === 'pointOn' && c.p.entity === 3 && c.p.at === 'b' && 'line' in c.on && c.on.line === 2), ok: d.report?.ok }
})
check(trimmed.error === null && trimmed.b && Math.abs(trimmed.b[0] - 40) < 1e-6 && trimmed.onUpright && trimmed.ok, `the level line now ends at the upright, held on it (${JSON.stringify(trimmed)})`)

// ---- a ΔX between two centres, pulled above them ------------------------------------------------
await page.keyboard.press('Escape')
await page.keyboard.press('d')
await sleep(100)
// The circle (its diameter in hand), then the other circle: the distance
// between their centres follows the cursor.
await clickAt([8, 5])
await clickAt([27, -8])
await hover([12, 20])
await page.screenshot({ path: shotPath('sketch-round-dx.png') })
await clickAt([12, 20])
const dx = await re(() => window.__re.store.getState().sketchDraft.sketch.constraints.find((c) => c.kind === 'distance'))
check(dx && dx.axis === 'x' && Math.abs(dx.value - 20) < 1e-6, `pulled above the two centres the distance is their ΔX, 20 (${JSON.stringify(dx)})`)
await re(() => document.activeElement?.blur?.())
await page.keyboard.press('Escape')
await sleep(200)
const chip = await page.$('[data-test=sketch-distance-axis]')
check(chip !== null && /ΔX/.test(await chip.evaluate((el) => el.textContent)), 'its row carries a ΔX chip')
await chip.click()
await sleep(200)
const dy = await re(() => window.__re.store.getState().sketchDraft.sketch.constraints.find((c) => c.kind === 'distance'))
check(dy.axis === 'y' && Math.abs(dy.value - 13) < 1e-6, `the chip turns it to the ΔY, 13 (${JSON.stringify(dy)})`)
await page.screenshot({ path: shotPath('sketch-round-dy.png') })

await finish(browser, consoleErrors)

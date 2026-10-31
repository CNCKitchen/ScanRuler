// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end check of a STEP file brought in and put in place in the
// Reverse engineer workspace, on the blank stage: a 20 × 10 × 5 block
// written here as a STEP file whose part is named Bracket is imported
// through the panel's Import STEP key — its ghost shown before Import,
// the body named after the part — then moved: the gizmo's X arrow dragged,
// its Z ring turned, a distance typed, the move made; and copied, the body
// left where it stands and the copy beside it. Then the use it is for: a
// scan of the block lies 50 mm along X of where the file has it, and the
// part moved onto it reads the scan as on it in the live map while the
// Move is still open.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node plugins/reverse/scripts/e2e-reverse-import-move.mjs
// Env: CHROME (chrome.exe path), APP_URL, SHOT_DIR.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeBinarySTL } from 'meshstep'
import { check, click, enterTyper, finish, launchApp, loadScan, shotPath, sleep } from '../../../scripts/e2e-lib.mjs'
import { openReverse, reverseHelpers } from './lib.mjs'

// ---- the file: a block named Bracket -----------------------------------------------
const { OcctKernel } = await import('occt-wasm')
const occt = await OcctKernel.init()
const doc = occt.createXCAFDocument()
doc.addShape(occt.makeBox(20, 10, 5), { name: 'Bracket' })
const stepText = doc.exportSTEP()
doc.close()
const dir = mkdtempSync(join(tmpdir(), 'scanruler-import-move-'))
const stepPath = join(dir, 'bracket.step')
writeFileSync(stepPath, stepText)

/** The block as a scan: every face a half-millimetre grid of triangles,
 *  wound outward, 50 mm along X of where the file has the block. */
function blockScan(w, d, h, at) {
  const positions = []
  const indices = []
  const faces = [
    [[0, 0, h], [w, 0, 0], [0, d, 0]],
    [[0, 0, 0], [0, d, 0], [w, 0, 0]],
    [[0, 0, 0], [w, 0, 0], [0, 0, h]],
    [[0, d, 0], [0, 0, h], [w, 0, 0]],
    [[0, 0, 0], [0, 0, h], [0, d, 0]],
    [[w, 0, 0], [0, d, 0], [0, 0, h]],
  ]
  for (const [o, u, v] of faces) {
    const nu = Math.round(Math.hypot(...u) * 2)
    const nv = Math.round(Math.hypot(...v) * 2)
    const base = positions.length / 3
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) positions.push(at[0] + o[0] + (u[0] * i) / nu + (v[0] * j) / nv, at[1] + o[1] + (u[1] * i) / nu + (v[1] * j) / nv, at[2] + o[2] + (u[2] * i) / nu + (v[2] * j) / nv)
    for (let j = 0; j < nv; j++)
      for (let i = 0; i < nu; i++) {
        const a = base + j * (nu + 1) + i
        indices.push(a, a + 1, a + nu + 2, a, a + nu + 2, a + nu + 1)
      }
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) }
}
const scanPath = join(dir, 'bracket-scan.stl')
writeFileSync(scanPath, Buffer.from(writeBinarySTL(blockScan(20, 10, 5, [50, 0, 0]))))

const { browser, page, consoleErrors } = await launchApp({ width: 1600, height: 1000, protocolTimeout: 600_000 })
await openReverse(page)

const { re, screen } = reverseHelpers(page)
const state = () => re(() => {
  const s = window.__re.store.getState()
  return { building: s.building, bodies: s.bodies.map((b) => ({ id: b.id, name: b.name, box: b.box })), draft: s.featureDraft && { ...s.featureDraft }, preview: s.preview.status }
})
const waitBuilt = (count) => page.waitForFunction((n) => !window.__re.store.getState().building && window.__re.store.getState().bodies.length === n, { timeout: 60_000 }, count)
/** Where a point of the part is on the screen. */
/** Where a grip of the gizmo sits, in the part's coordinates — a ring by a
 *  point on its rim at `deg` round from its first in-plane axis. */
const gripAt = (side, deg = 0) =>
  re(
    (side, deg) => {
      const h = window.__re.scene().grips.handles.find((g) => g.side === side)
      if (!h) return null
      const p = h.mesh.position
      if (!h.ring) return [p.x, p.y, p.z]
      const r = h.mesh.scale.x
      const a = (deg * Math.PI) / 180
      // The ring's plane, square to its axis.
      const n = h.dir
      const u = Math.abs(n.x) < 0.9 ? { x: 0, y: -n.z, z: n.y } : { x: -n.y, y: n.x, z: 0 }
      const ul = Math.hypot(u.x, u.y, u.z)
      const ux = u.x / ul, uy = u.y / ul, uz = u.z / ul
      const vx = n.y * uz - n.z * uy, vy = n.z * ux - n.x * uz, vz = n.x * uy - n.y * ux
      return [p.x + r * (Math.cos(a) * ux + Math.sin(a) * vx), p.y + r * (Math.cos(a) * uy + Math.sin(a) * vy), p.z + r * (Math.cos(a) * uz + Math.sin(a) * vz)]
    },
    side,
    deg,
  )
const hovered = () => re(() => window.__re.scene().grips.hoveredHandle)
/** Press on a grip and drag it through the screen points given. */
async function dragGrip(side, from, through) {
  await page.mouse.move(from[0] - 3, from[1] - 3)
  await sleep(80)
  await page.mouse.move(from[0], from[1])
  await sleep(200)
  const lit = await hovered()
  check(lit === side, `the ${side} grip lights under the cursor (lit: ${lit})`)
  await page.mouse.down()
  for (const p of through) {
    await page.mouse.move(p[0], p[1], { steps: 6 })
    await sleep(40)
  }
  await page.mouse.up()
  await sleep(300)
}

// ---- Import STEP --------------------------------------------------------------------
await (await page.$('[data-test=feature-import-file]')).uploadFile(stepPath)
await page.waitForSelector('[data-test=import-editor]', { timeout: 10_000 })
check((await page.$eval('[data-test=import-file]', (e) => e.textContent)).includes('bracket.step'), 'the Import box names the file chosen')
await page.waitForFunction(() => window.__re.store.getState().preview.status === 'ok', { timeout: 60_000 })
await page.screenshot({ path: shotPath('reverse-import-ghost.png') })
await click(page, '[data-test=import-create]')
await waitBuilt(1)
let st = await state()
check(st.bodies[0].name === 'Bracket', `the body is named after the part in the file (${st.bodies[0].name})`)
check((await page.$$eval('[data-test=feature-row] .name', (els) => els.map((e) => e.textContent))).includes('bracket'), 'the feature row is named after the file')

// ---- Move: the gizmo ----------------------------------------------------------------
await click(page, '[data-test=feature-move-body]')
await page.waitForSelector('[data-test=move-body-editor]')
st = await state()
check(st.draft.bodies.length === 1 && st.draft.bodies[0] === st.bodies[0].id, 'the one body there is is the one the Move opens on')
check(JSON.stringify(st.draft.pivot) === JSON.stringify([10, 5, 2.5]), `the pivot is the body's middle (${st.draft.pivot})`)
await sleep(300)
await page.screenshot({ path: shotPath('reverse-move-gizmo.png') })

// The X arrow pulled 15 mm along X.
const arrow = await gripAt('moveX')
check(arrow !== null, 'the gizmo has an arrow along X')
const arrowFrom = await screen(arrow)
const arrowTo = await screen([arrow[0] + 15, arrow[1], arrow[2]])
await dragGrip('moveX', arrowFrom, [arrowTo])
st = await state()
check(Math.abs(st.draft.translate[0] - 15) < 0.75 && st.draft.translate[1] === 0 && st.draft.translate[2] === 0, `the X arrow drags the X distance alone (${st.draft.translate})`)
const ghostAt = await re(() => Array.from(window.__re.reScene().bodyPreview.matrix.elements.slice(12, 15)))
check(Math.abs(ghostAt[0] - st.draft.translate[0]) < 1e-6, `the ghost is carried with the hand (${ghostAt})`)

// The Z ring turned a quarter, counter-clockwise seen from above.
const ringFrom = await screen(await gripAt('turnZ', 30))
const ringPath = []
for (const deg of [50, 70, 90, 110, 120]) ringPath.push(await screen(await gripAt('turnZ', deg)))
await dragGrip('turnZ', ringFrom, ringPath)
st = await state()
check(Math.abs(st.draft.rotate[2] - 90) <= 2 && st.draft.rotate[0] === 0 && st.draft.rotate[1] === 0, `the Z ring turns about Z alone, by the turn of the hand (${st.draft.rotate})`)
await page.screenshot({ path: shotPath('reverse-move-dragged.png') })
// The field on the ring takes an angle typed with its unit.
await page.focus('[data-test=grip-field]')
await page.$eval('[data-test=grip-field]', (el) => (el.value = ''))
await page.type('[data-test=grip-field]', '45 deg')
await page.keyboard.press('Enter')
await sleep(200)
st = await state()
check(st.draft.rotate[2] === 45, `the field on the ring takes an angle typed as one (${st.draft.rotate})`)

// Typed: Y 7 mm, X and Z to round numbers.
const typeInto = enterTyper(page)
for (const [field, value] of [['move-body-translate-y', '7'], ['move-body-translate-x', '15'], ['move-body-rotate-z', '90']]) await typeInto(`[data-test=${field}]`, value)
st = await state()
check(JSON.stringify(st.draft.translate) === JSON.stringify([15, 7, 0]) && st.draft.rotate[2] === 90, `the numbers typed stand (${st.draft.translate} / ${st.draft.rotate})`)
await click(page, '[data-test=move-body-create]')
await page.waitForFunction(() => !window.__re.store.getState().featureDraft && !window.__re.store.getState().building, { timeout: 60_000 })
await sleep(300)
st = await state()
const box = st.bodies[0].box
const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-3)
// 20 × 10 turned a quarter about its middle (10, 5): 10 wide in X, 20 in
// Y, about the same middle; then 15 along X and 7 along Y.
check(near(box.min, [20, 2, 0]) && near(box.max, [30, 22, 5]), `the body stands where the Move put it (${box.min} – ${box.max})`)
await page.screenshot({ path: shotPath('reverse-move-done.png') })

// ---- Move with Copy -----------------------------------------------------------------
await click(page, '[data-test=feature-move-body]')
await page.waitForSelector('[data-test=move-body-editor]')
await click(page, '[data-test=move-body-copy]')
await typeInto('[data-test=move-body-translate-z]', '12')
await sleep(150)
check(await re(() => window.__re.reScene().replacedBodies.size === 0), 'a copy leaves the body drawn where it stands, the ghost beside it')
await page.screenshot({ path: shotPath('reverse-move-copy-ghost.png') })
check((await page.$eval('[data-test=move-body-create]', (e) => e.textContent)) === 'Copy the body', 'the box says it copies')
await click(page, '[data-test=move-body-create]')
await waitBuilt(2)
st = await state()
check(JSON.stringify(st.bodies.map((b) => b.name)) === JSON.stringify(['Bracket', 'Bracket (2)']), `the copy is a body of its own beside the original (${st.bodies.map((b) => b.name)})`)
check(Math.abs(st.bodies[0].box.min[2]) < 1e-3 && Math.abs(st.bodies[1].box.min[2] - 12) < 1e-3, 'the original stays, the copy is carried')
await page.screenshot({ path: shotPath('reverse-move-copied.png') })

// ---- On a scan: the part moved onto it, read by the live map -------------------------
await re(() => window.__re.store.getState().clearFeatures())
await waitBuilt(0)
// The earlier body edits still exist in undo history. Loading this scan is
// an intentional replacement, so answer the browser's warning explicitly.
let replacementAsked = false
page.once('dialog', async (dialog) => {
  replacementAsked = dialog.type() === 'confirm' && dialog.message().includes('Opening another scan')
  await dialog.accept()
})
await loadScan(page, scanPath, { inputSelector: '[data-test=slot-scan] input[type=file]', settle: 500 })
check(replacementAsked, 'opening the scan asks before clearing the earlier body edits from undo history')
await (await page.$('[data-test=feature-import-file]')).uploadFile(stepPath)
await page.waitForSelector('[data-test=import-editor]', { timeout: 10_000 })
await page.waitForFunction(() => window.__re.store.getState().preview.status === 'ok', { timeout: 60_000 })
await click(page, '[data-test=import-create]')
await waitBuilt(1)
await click(page, '[data-test=feature-move-body]')
await page.waitForSelector('[data-test=move-body-editor]')
const mapRead = () => page.waitForFunction(() => {
  const s = window.__re.store.getState()
  return s.preview.status === 'ok' && s.mapReport?.source === 'ghost' ? s.mapReport : null
}, { timeout: 30_000 }).then((h) => h.jsonValue())
// Carried onto it but turned 10° about X: off the scan but where the turn
// crosses it. A shift along X alone, or a turn about Z, would not do — the
// faces square to the axis would still lie in the scan's.
await typeInto('[data-test=move-body-translate-x]', '50')
await typeInto('[data-test=move-body-rotate-x]', '10')
await sleep(600)
let turned = await mapRead()
for (let i = 0; i < 20 && turned.within > turned.points * 0.5; i++) {
  await sleep(250)
  turned = await mapRead()
}
await typeInto('[data-test=move-body-rotate-x]', '0')
await sleep(400)
let onIt = await mapRead()
// The map reads the ghost the worker last built; a newer one may still be
// on its way.
for (let i = 0; i < 20 && onIt.within < onIt.points * 0.95; i++) {
  await sleep(250)
  onIt = await mapRead()
}
check(onIt.points > 1000 && onIt.within >= onIt.points * 0.95, `moved onto the scan, the scan reads as on the part (${onIt.within} of ${onIt.points} within the range)`)
check(turned.within < turned.points * 0.5, `turned 10° off it, it does not (${turned.within} of ${turned.points})`)
await page.screenshot({ path: shotPath('reverse-move-on-scan.png') })
await click(page, '[data-test=move-body-create]')
await page.waitForFunction(() => !window.__re.store.getState().featureDraft && !window.__re.store.getState().building, { timeout: 60_000 })

await finish(browser, consoleErrors)

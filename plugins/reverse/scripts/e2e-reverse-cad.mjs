// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end test of the CAD-side round of the Reverse engineer workspace,
// on a scan whose answer is known: a 40 × 20 × 12 mm block, modelled here
// as a block 10 mm tall — roughly, as a part is sketched before its faces
// are snapped onto the scan. Checks that a plane picker inside a label
// closes once an option is taken; that the bodies are drawn solid with
// their edges and the scan as a veil; that a fillet shows the tangent
// propagation switch and a preview standing in for the body; that a failed
// feature's reason wraps under its row; that the top face snaps onto the
// scan's top, 2 mm up, from one click — a Move face unless the box is ticked
// to change the extrude instead; that a fillet's face offers Edit for the
// fillet and no Thread or Move face; that a draft leans the walls; that a
// flat face pulls from the chips, joining outward and cutting inward; and
// that a sketch on a body face opens with the face's outline projected in,
// with the Project tool bringing in another edge.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node plugins/reverse/scripts/e2e-reverse-cad.mjs
// Env: CHROME (chrome.exe path), APP_URL, SHOT_DIR.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeBinarySTL } from 'meshstep'
import { canvasRect, check, click, finish, launchApp, loadScan, pickOption, previewReady, shotPath, sleep } from '../../../scripts/e2e-lib.mjs'
import { reverseHelpers } from './lib.mjs'
import { blockScan } from '../../../scripts/e2e-fixtures.mjs'

const W = 40, D = 20, H = 12

// ---- the scan: a dense block on the XY plane -------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'scanruler-reverse-cad-'))
/** A block from the origin, every face a 1 mm grid of triangles wound
 *  outward — dense enough for a click's patch to grow a plane on. */
const scan = blockScan(W, D, H)
const scanPath = join(dir, 'block-scan.stl')
writeFileSync(scanPath, Buffer.from(writeBinarySTL(scan)))

const { browser, page, consoleErrors } = await launchApp({ width: 1600, height: 1000, protocolTimeout: 600_000 })
await page.click('[data-test=workspace-reverse]')
await page.waitForSelector('[data-test=kernel-status]')
await page.waitForFunction(() => /ready/.test(document.querySelector('[data-test=kernel-status]')?.textContent ?? ''), { timeout: 180_000 })
await loadScan(page, scanPath, { inputSelector: '[data-test=slot-scan] input[type=file]', settle: 500 })

const { re, built } = reverseHelpers(page)
const volume = () => re(() => window.__re.store.getState().bodies[0]?.volume ?? 0)

// ---- the rough model: a block 10 tall, through the store ---------------------------
await re((w, d) => {
  const s = window.__re.store.getState()
  const frame = { origin: [0, 0, 0], normal: [0, 0, 1], basisU: [1, 0, 0], basisV: [0, 1, 0] }
  s.startSketch({ kind: 'world', axis: 'z', offset: 0 }, frame)
  window.__re.store.getState().setSketchTool('rectangle')
  window.__re.store.getState().sketchClick([0, 0], 0.01, false, { off: true })
  window.__re.store.getState().sketchClick([w, d], 0.01, false, { off: true })
  const id = window.__re.store.getState().commitSketch()
  window.__re.store.getState().startExtrude(id)
  window.__re.store.getState().setExtrude({ extent: { kind: 'distance', from: 0, to: 10 } })
}, W, D)
await page.waitForSelector('[data-test=extrude-editor]')

// ---- a plane picker inside a label closes when an option is taken -----------------
await page.select('[data-test=extrude-extent]', 'betweenPlanes')
await pickOption(page, '[data-test=extrude-plane-a]', /XY/)
await sleep(300)
check((await page.$('[data-test=extrude-plane-a-list]')) === null, 'the plane list closes once a plane is chosen')
check((await page.$eval('[data-test=extrude-plane-a]', (el) => el.dataset.value)) !== '', 'and the plane is chosen')
await page.select('[data-test=extrude-extent]', 'distance')
await re(() => window.__re.store.getState().setExtrude({ extent: { kind: 'distance', from: 0, to: 10 } }))
await re(() => window.__re.store.getState().commitExtrude())
await built()
check(Math.abs((await volume()) - W * D * 10) < 1e-3, `the rough block is built (${(await volume()).toFixed(1)} mm³)`)

// ---- solid bodies, their edges, the scan a veil ----------------------------------
await re(() => window.__re.scene().viewFrom('iso'))
await sleep(900)
const look = await re(() => {
  const scene = window.__re.scene()
  const bodies = window.__re.reScene()
  const body = [...bodies.bodyMeshes.values()][0]
  return { bodyOpaque: !body.material.transparent, scanOpacity: scene.mesh.material.opacity, edges: bodies.bodyPicks.edgeLines.reduce((n, l) => n + l.geo.instanceCount, 0), edgeDepth: bodies.bodyPicks.edgeMaterial.depthTest, edgeWidth: bodies.bodyPicks.edgeMaterial.linewidth }
})
console.log('look:', JSON.stringify(look))
check(look.bodyOpaque && look.scanOpacity < 1, 'the body is drawn solid and the scan see-through over it')
check(look.edges === 12 && look.edgeDepth && look.edgeWidth < 2, 'the body’s twelve edges are drawn thin, behind what hides them')
await page.screenshot({ path: shotPath('reverse-cad-body.png') })

// ---- a face behind the veil is picked through it ----------------------------------
// The body's top lies 2 mm under the scan's, past the noise a face is let
// off by: the see-through scan hides it from nothing, a click included.
{
  const [tx, ty] = await re((x, y, z) => window.__re.reScene().bodyPicks.screenProjection()(x, y, z), W / 2 + 6, D / 2, 10)
  await page.mouse.move(tx, ty)
  await sleep(200)
  await page.mouse.click(tx, ty)
  await sleep(300)
  const picked = await re(() => {
    const sel = window.__re.store.getState().selection
    return sel?.kind === 'bodyFace' ? sel.face.fingerprint.dir : null
  })
  check(picked !== null && picked[2] > 0.99, `a click on the scan's top picks the body's top through it (${JSON.stringify(picked)})`)
  await page.keyboard.press('Escape')
  await sleep(200)
}

// ---- the fillet: propagation on, its preview in the body's place ------------------
const rect = await canvasRect(page)
await click(page, '[data-test=feature-fillet]')
await page.waitForSelector('[data-test=fillet-editor]')
check(await page.$eval('[data-test=fillet-chain]', (el) => el.checked), 'a fillet opens with tangent propagation on')
// The top front edge, by its fingerprint, through the store.
await re(() => {
  const t = window.__re.topology(window.__re.store.getState().bodies[0].id)
  const edge = t.edges.find((e) => e.fingerprint.kind === 'line' && Math.abs(e.fingerprint.mid[2] - 10) < 1e-6 && Math.abs(e.fingerprint.mid[1]) < 1e-6)
  window.__re.store.getState().toggleDraftEdge(window.__re.store.getState().bodies[0].id, edge)
  window.__re.store.getState().setFeatureDraft({ radius: 3, radiusTyped: true })
})
await previewReady(page, { watchStatus: false })
await sleep(400)
const ghost = await re(() => {
  const scene = window.__re.scene()
  const bodies = window.__re.reScene()
  const body = [...bodies.bodyMeshes.values()][0]
  return { solid: bodies.bodyPreview && !bodies.bodyPreview.material.transparent, bodyShown: body.material.visible, previewEdges: bodies.bodyPicks.previewLines.reduce((n, l) => n + l.geo.instanceCount, 0) }
})
console.log('fillet ghost:', JSON.stringify(ghost))
check(ghost.solid && !ghost.bodyShown, 'the fillet’s preview is drawn solid in the body’s place')
check(ghost.previewEdges > 12, 'with the edges the round will have')
await page.screenshot({ path: shotPath('reverse-cad-fillet.png') })
// A radius the block cannot take fails: its row is marked, and its box says
// why once it is opened again.
await re(() => window.__re.store.getState().setFeatureDraft({ radius: 30, radiusTyped: true }))
const failedId = await re(() => window.__re.store.getState().commitFeature())
await page.waitForSelector('[data-test=feature-failed]', { timeout: 30_000 })
check((await page.$$('[data-test=feature-error]')).length === 0, 'the row marks the failure without its sentence')
await re((id) => window.__re.store.getState().editFeature(id), failedId)
await page.waitForSelector('[data-test=feature-error]', { timeout: 10_000 })
const overflow = await page.$eval('[data-test=feature-error]', (el) => ({ wide: el.scrollWidth > el.clientWidth + 1, inPanel: el.getBoundingClientRect().right <= el.closest('.panel').getBoundingClientRect().right + 1, text: el.textContent }))
console.log('failed fillet:', overflow.text)
check(!overflow.wide && overflow.inPanel, 'a failed feature’s reason wraps inside the panel')
await page.screenshot({ path: shotPath('reverse-cad-error.png') })
await re(() => window.__re.store.getState().cancelFeature())
await re(() => window.__re.store.getState().undoFeatures())
await built()

// ---- snap: the top face onto the scan's top, from one click -------------------------
// The body's top (z = 10) is inside the scan's (z = 12): looked at from
// above, the click at the middle meets the scan first.
await re(() => {
  const s = window.__re.store.getState()
  const id = s.bodies[0].id
  const top = window.__re.topology(id).faces.find((f) => f.fingerprint.dir[2] > 0.9)
  s.setSelection({ kind: 'bodyFace', bodyId: id, face: top, edges: window.__re.topology(id).edges.filter((e) => e.faces.includes(top.hash)), at: { x: 700, y: 300 } })
})
await page.waitForSelector('[data-test=chip-snap]')
const chips = await page.$$eval('[data-test=context-chips] button', (els) => els.map((e) => e.textContent.trim()))
console.log('face chips:', JSON.stringify(chips))
check(['Edit Extrude 1', 'Extrude', 'Sketch here', 'Move face', 'Snap to scan', 'Draft'].every((c) => chips.includes(c)), 'a flat face offers Edit Extrude 1, Extrude, Sketch here, Move face, Snap to scan and Draft')
await page.screenshot({ path: shotPath('reverse-cad-chips.png') })
await click(page, '[data-test=chip-snap]')
await page.waitForSelector('[data-test=move-face-editor]')
await sleep(300)
const faint = await re(() => {
  const scene = window.__re.scene()
  const bodies = window.__re.reScene()
  const body = [...bodies.bodyMeshes.values()][0]
  return { body: body.material.opacity, scan: scene.mesh.material.opacity }
})
console.log('while snapping:', JSON.stringify(faint))
check(faint.body < 0.3 && faint.scan === 1, 'while a face is snapped the body is a tint and the scan solid under it')
await re(() => window.__re.scene().viewFrom('top'))
await sleep(900)
await page.mouse.click(rect.x + rect.w / 2, rect.y + rect.h / 2)
await page.waitForFunction(() => window.__re.store.getState().featureDraft?.reading, { timeout: 30_000 }).catch(() => {})
const snap = await re(() => window.__re.store.getState().featureDraft)
console.log('snap:', JSON.stringify({ offset: snap?.offset, reading: snap?.reading, error: snap?.error }))
check(snap?.reading && Math.abs(snap.offset - 2) < 0.01, `one click on the scan reads the move: ${snap?.offset} mm`)
await previewReady(page, { watchStatus: false })
await re(() => window.__re.scene().viewFrom('iso'))
await sleep(700)
await page.screenshot({ path: shotPath('reverse-cad-snap.png') })
const asFeature = await page.$eval('[data-test=move-face-plan]', (el) => el.textContent)
check(/A Move face on the body/.test(asFeature) && /change Extrude 1 instead/.test(asFeature), `unticked, the move is a Move face, and the box offers to change the extrude instead (${asFeature})`)
check((await page.$eval('[data-test=move-face-history]', (el) => el.checked)) === false, 'the offer starts unticked')
await click(page, '[data-test=move-face-history]')
await sleep(200)
const planText = await page.$eval('[data-test=move-face-plan]', (el) => el.textContent)
console.log('plan:', planText)
check(/Extrude 1: To 10 → 12 mm/.test(planText), 'ticked, the box says the snap edits the extrude that made the face')
const listBefore = await re(() => window.__re.store.getState().features.length)
await click(page, '[data-test=move-face-create]')
await sleep(200)
await built()
await sleep(300)
check(Math.abs((await volume()) - W * D * H) < 0.5, `and the body is the scan’s height (${(await volume()).toFixed(1)} mm³ of ${W * D * H})`)
check((await re(() => window.__re.store.getState().features.length)) === listBefore, 'with no feature added — the extrude’s distance is what changed')
check((await re(() => window.__re.reScene().bodyMeshes.values().next().value.material.opacity)) === 1, 'and the body is solid again')
// A wall of a rounded block snaps by its sketch line, the round going with it.
await re(() => {
  const s = window.__re.store.getState()
  const id = s.bodies[0].id
  const edge = window.__re.topology(id).edges.find((e) => e.fingerprint.kind === 'line' && Math.abs(e.fingerprint.mid[0] - 40) < 1e-6 && Math.abs(e.fingerprint.mid[2] - 12) < 1e-6)
  s.startFeature('fillet', { body: id, edges: [edge], radius: 2, radiusTyped: true })
  window.__re.store.getState().commitFeature()
})
await sleep(200)
await built()
await sleep(300)
const rounded = await volume()
const roundedFaces = await re(() => window.__re.store.getState().bodies[0].faces)
await re(() => {
  const s = window.__re.store.getState()
  const id = s.bodies[0].id
  const wall = window.__re.topology(id).faces.find((f) => f.fingerprint.kind === 'plane' && f.fingerprint.dir[0] > 0.9)
  s.startFeature('moveFace', { body: id, faces: [wall] })
  window.__re.store.getState().setFeatureDraft({ offset: 1, history: true })
})
await page.waitForSelector('[data-test=move-face-plan]')
check(/Sketch 1: the line under this face moves 1 mm out/.test(await page.$eval('[data-test=move-face-plan]', (el) => el.textContent)), 'a wall of a rounded block is traced to its sketch line')
await page.screenshot({ path: shotPath('reverse-cad-snap-wall.png') })
await click(page, '[data-test=move-face-create]')
await sleep(200)
await built()
await sleep(300)
check(Math.abs((await volume()) - (rounded + 1 * D * H)) < 0.5 && (await re(() => window.__re.store.getState().bodies[0].faces)) === roundedFaces, `the wall moves with its round — no pad, no pocket (${(await volume()).toFixed(1)} mm³)`)
await re(() => window.__re.scene().viewFrom('iso'))
await sleep(700)
await page.screenshot({ path: shotPath('reverse-cad-rounded.png') })
// The edges are the outlines of the faces' own triangles, so a round's
// rims lie on the round's chords rather than dipping under them.
const onMesh = await re(() => {
  const picks = window.__re.reScene().bodyPicks
  const places = new Set()
  for (const e of picks.entries.values()) {
    const p = e.mesh.geometry.getAttribute('position').array
    for (let i = 0; i < p.length; i += 3) places.add(`${p[i]},${p[i + 1]},${p[i + 2]}`)
  }
  let points = 0
  let off = 0
  for (const l of picks.edgeLines) {
    const a = l.geo.attributes.instanceStart.data.array
    for (let i = 0; i < a.length; i += 3, points++) if (!places.has(`${a[i]},${a[i + 1]},${a[i + 2]}`)) off++
  }
  return { points, off }
})
check(onMesh.points > 0 && onMesh.off === 0, `the rounded block's edges lie on its triangles (${onMesh.points} points, ${onMesh.off} off them)`)
// The round's face: a quarter turn takes no thread and is not resized,
// and Edit opens the fillet that made it.
const filletId = await re(() => {
  const s = window.__re.store.getState()
  const id = s.bodies[0].id
  const round = window.__re.topology(id).faces.find((f) => f.fingerprint.kind === 'cylinder')
  s.setSelection({ kind: 'bodyFace', bodyId: id, face: round, edges: [], at: { x: 700, y: 300 } })
  return round.fingerprint.origin
})
await page.waitForSelector('[data-test=chip-edit]')
const roundChips = await page.$$eval('[data-test=context-chips] button', (els) => els.map((e) => e.textContent.trim()))
console.log('fillet face chips:', JSON.stringify(roundChips))
check(roundChips.some((c) => /^Edit Fillet \d+$/.test(c)) && !['Thread', 'Move face', 'Snap to scan'].some((c) => roundChips.includes(c)), 'a fillet’s face offers Edit Fillet, and no Thread, Move face or Snap to scan')
await page.screenshot({ path: shotPath('reverse-cad-fillet-chips.png') })
await click(page, '[data-test=chip-edit]')
await page.waitForSelector('[data-test=fillet-editor]')
check((await re(() => window.__re.store.getState().featureDraft?.featureId)) === filletId, 'Edit opens the fillet that made the face')
await re(() => window.__re.store.getState().cancelFeature())
await sleep(200)
await built()
await sleep(300)
await re(() => { window.__re.store.getState().undoFeatures(); window.__re.store.getState().undoFeatures() })
await sleep(200)
await built()
await sleep(300)

// ---- move faces: the top and a wall picked together, one offset -------------------
await re(() => {
  const s = window.__re.store.getState()
  const id = s.bodies[0].id
  const faces = window.__re.topology(id).faces
  const top = faces.find((f) => f.fingerprint.dir[2] > 0.9)
  const wall = faces.find((f) => f.fingerprint.kind === 'plane' && f.fingerprint.dir[0] > 0.9)
  s.setSelection({ kind: 'bodyItems', items: [top, wall].map((face) => ({ type: 'face', bodyId: id, face, edges: [] })), at: { x: 700, y: 300 } })
})
await page.waitForSelector('[data-test=chip-move-face]')
check((await page.$eval('[data-test=chip-move-face]', (el) => el.textContent.trim())) === 'Move faces', 'two faces picked offer Move faces')
await click(page, '[data-test=chip-move-face]')
await page.waitForSelector('[data-test=move-face-editor]')
check(/2 faces picked/.test(await page.$eval('[data-test=move-face-face]', (el) => el.textContent)), 'the box holds both faces')
await re(() => window.__re.store.getState().setFeatureDraft({ offset: 1, history: true }))
await page.waitForSelector('[data-test=move-face-plan]')
const bothPlan = await page.$eval('[data-test=move-face-plan]', (el) => el.textContent)
console.log('two faces:', bothPlan)
check(/Extrude 1: To 12 → 13 mm/.test(bothPlan) && /Sketch 1/.test(bothPlan), 'the top goes into the extrude’s distance and the wall into its sketch line, as one edit')
await click(page, '[data-test=move-face-create]')
await sleep(200)
await built()
await sleep(300)
check(Math.abs((await volume()) - (W + 1) * D * (H + 1)) < 0.5, `both faces moved out by 1 mm (${(await volume()).toFixed(1)} mm³ of ${(W + 1) * D * (H + 1)})`)
await re(() => window.__re.store.getState().undoFeatures())
await sleep(200)
await built()
await sleep(300)

// ---- draft: the long walls leaned about the bottom ----------------------------------
await click(page, '[data-test=feature-draft]')
await page.waitForSelector('[data-test=draft-editor]')
await re(() => {
  const s = window.__re.store.getState()
  const id = s.bodies[0].id
  const faces = window.__re.topology(id).faces
  s.toggleDraftFace(id, faces.find((f) => f.fingerprint.dir[2] < -0.9))
  window.__re.store.getState().toggleDraftFace(id, faces.find((f) => f.fingerprint.dir[1] > 0.9))
  window.__re.store.getState().toggleDraftFace(id, faces.find((f) => f.fingerprint.dir[1] < -0.9))
  window.__re.store.getState().setFeatureDraft({ angleDeg: 5 })
})
await previewReady(page, { watchStatus: false })
await sleep(300)
await page.screenshot({ path: shotPath('reverse-cad-draft.png') })
await click(page, '[data-test=draft-create]')
await sleep(200)
await built()
await sleep(300)
const drafted = W * D * H - 2 * 0.5 * H * (H * Math.tan((5 * Math.PI) / 180)) * W
check(Math.abs((await volume()) - drafted) < 0.5, `the draft leans both long walls 5° (${(await volume()).toFixed(1)} mm³ of ${drafted.toFixed(1)})`)
await re(() => window.__re.store.getState().undoFeatures())
await built()

// ---- a flat face pulled from the chips -----------------------------------------------
const pull = async () => {
  await re(() => {
    const s = window.__re.store.getState()
    const id = s.bodies[0].id
    const t = window.__re.topology(id)
    const side = t.faces.find((f) => f.fingerprint.dir[0] > 0.9)
    s.setSelection({ kind: 'bodyFace', bodyId: id, face: side, edges: t.edges.filter((e) => e.faces.includes(side.hash)), at: { x: 700, y: 300 } })
  })
  await click(page, '[data-test=chip-extrude-face]')
  await page.waitForSelector('[data-test=extrude-editor]')
}
const featuresBefore = await re(() => window.__re.store.getState().features.length)
await pull()
check((await re(() => window.__re.store.getState().extrudeDraft?.op)) === 'join', 'the Extrude chip on a face opens an extrude joining the body')
await re(() => window.__re.store.getState().setExtrude({ extent: { kind: 'distance', from: 0, to: -4 } }))
check((await page.$eval('[data-test=extrude-op]', (el) => el.value)) === 'cut', 'pushed inward it cuts')
const extents = await page.$$eval('[data-test=extrude-extent] option', (els) => els.map((e) => e.value))
check(['toFace', 'toNext', 'toLast'].every((k) => extents.includes(k)), 'an extrude can reach to a face, to next and to last')
await click(page, '[data-test=extrude-cancel]')
check((await re(() => window.__re.store.getState().features.length)) === featuresBefore, 'cancelled, the sketch made for it is taken back')
await pull()
await re(() => window.__re.store.getState().setExtrude({ extent: { kind: 'distance', from: 0, to: 5 } }))
await previewReady(page, { watchStatus: false })
await page.screenshot({ path: shotPath('reverse-cad-pull.png') })
await click(page, '[data-test=extrude-create]')
await sleep(200)
await built()
await sleep(300)
check(Math.abs((await volume()) - (W + 5) * D * H) < 0.5, `pulled 5 mm out, the body is 5 mm longer (${(await volume()).toFixed(1)} mm³)`)

// ---- a sketch on a face opens with the face's outline; Project brings more ----------
await re(() => {
  const s = window.__re.store.getState()
  const id = s.bodies[0].id
  const t = window.__re.topology(id)
  const top = t.faces.find((f) => f.fingerprint.dir[2] > 0.9)
  s.setSelection({ kind: 'bodyFace', bodyId: id, face: top, edges: t.edges.filter((e) => e.faces.includes(top.hash)), at: { x: 700, y: 300 } })
})
await click(page, '[data-test=chip-sketch-here]')
await page.waitForSelector('[data-test=sketch-editor]')
await sleep(1500)
const opened = await re(() => {
  const d = window.__re.store.getState().sketchDraft
  return { pieces: d.sketch.entities.length, projected: d.sketch.entities.every((e) => e.projected && e.fixed), regions: d.found.length }
})
console.log('sketch on the face:', JSON.stringify(opened))
check(opened.pieces === 4 && opened.projected && opened.regions === 1, 'the sketch opens with the face’s four edges projected in, one closed region')
// The Project tool: the body's bottom edges lie under the top's, so what is
// left to take is an upright edge, seen end on — a point at a corner.
await click(page, '[data-test=sketch-tool-project]').catch(() => re(() => window.__re.store.getState().setSketchTool('project')))
const tookPoint = await re(() => {
  const found = window.__re.sheet() && window.__re.store.getState().sketchDraft
  return Boolean(found)
})
check(tookPoint, 'the Project tool is armed on the sheet')
await page.screenshot({ path: shotPath('reverse-cad-sketch-face.png') })
await click(page, '[data-test=sketch-finish]')

await finish(browser, consoleErrors)

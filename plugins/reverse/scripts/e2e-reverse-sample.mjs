// SPDX-License-Identifier: AGPL-3.0-only
// Reverse engineer, phase C end to end on the sample part: the alignment
// nudge in the first sketch on an unaligned part, a sketch across the L
// fitted and extruded, Fit surface and Trim, the body compared in the
// Deviation workspace under the identity (no best fit, the map within a few
// hundredths on a part modelled on its own scan), and a Mirror that opens on
// the scan's own symmetry plane.
// Needs no scan file: the sample bracket is built in the page, from the dev
// server's own module, and loaded through the panel's Scan slot.
//
//   npm run dev &  node plugins/reverse/scripts/e2e-reverse-sample.mjs
import { check, click, finish, launchApp, pickOption, previewReady, shotPath, sleep } from '../../../scripts/e2e-lib.mjs'

// The sample's dimensions and pose, as src/core/geometry/samplePart.ts has them.
const WIDTH = 40, HEIGHT = 30, LEG = 12, DEPTH = 20
const VOLUME = (WIDTH * LEG + LEG * (HEIGHT - LEG)) * DEPTH
function samplePose() {
  const [x, y, z] = [0.36, 0.48, 0.8]
  const a = (14 * Math.PI) / 180
  const c = Math.cos(a), s = Math.sin(a), t = 1 - c
  return {
    r: [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c],
    t: [18, -7, 25],
  }
}
function invert(m) {
  const r = [m.r[0], m.r[3], m.r[6], m.r[1], m.r[4], m.r[7], m.r[2], m.r[5], m.r[8]]
  const t = [0, 1, 2].map((i) => -(r[i * 3] * m.t[0] + r[i * 3 + 1] * m.t[1] + r[i * 3 + 2] * m.t[2]))
  return { r, t }
}

const { browser, page, consoleErrors } = await launchApp({ width: 1600, height: 1000, protocolTimeout: 600_000 })

await page.click('[data-test=workspace-reverse]')
await page.waitForSelector('[data-test=kernel-status]')
await page.waitForFunction(() => /ready/.test(document.querySelector('[data-test=kernel-status]')?.textContent ?? ''), { timeout: 180_000 }).catch(() => {})
check(/ready/.test(await page.$eval('[data-test=kernel-status]', (el) => el.textContent)), 'the CAD kernel loads')

// ---- the sample, through the Scan slot -------------------------------------------------
await page.evaluate(async () => {
  const { buildSamplePart } = await import('/src/core/geometry/samplePart.ts')
  const { buildBinaryStl } = await import('/src/core/exportStl.ts')
  const part = buildSamplePart()
  const file = new File([buildBinaryStl(part.positions, part.indices, null, 'ScanRuler sample bracket')], 'sample-bracket.stl')
  const input = document.querySelector('[data-test=slot-scan] input[type=file]')
  const dt = new DataTransfer()
  dt.items.add(file)
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
})
await page.waitForFunction(() => /[1-9][\d,]* triangles/.test(document.querySelector('.file-info')?.textContent ?? ''), { timeout: 120_000 })
await sleep(500)
check(/sample-bracket\.stl/.test(await page.$eval('[data-test=slot-scan]', (el) => el.textContent)), 'the sample loads')

const rect3d = await page.$eval('.viewslot canvas', (el) => {
  const r = el.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, left: r.x, top: r.y, w: r.width, h: r.height }
})
/** Where a point of the part is on screen. */
const screenOf = (p) =>
  page.evaluate(
    (p, rect) => {
      const cam = window.__re.scene().viewport.camera
      cam.updateMatrixWorld()
      const v = cam.position.clone().set(p[0], p[1], p[2]).project(cam)
      return [rect.left + ((v.x + 1) / 2) * rect.w, rect.top + ((1 - v.y) / 2) * rect.h]
    },
    p,
    rect3d,
  )

// ---- the nudge in the first sketch on an unaligned part ---------------------------------
// A click on the scan starts nothing; a sketch is begun from the panel's
// Sketch on list. Any plane will do here.
const pose = samplePose()
const at = (p) => [0, 1, 2].map((i) => pose.r[i * 3] * p[0] + pose.r[i * 3 + 1] * p[1] + pose.r[i * 3 + 2] * p[2] + pose.t[i])
await page.evaluate(() => window.__re.scene().viewFrom?.('top'))
await sleep(600)
await page.mouse.click(...(await screenOf(at([6, 6, DEPTH]))))
await sleep(1200)
check((await page.$('[data-test=sketch-editor]')) === null, 'a click on the scan opens no sketch')
await pickOption(page, '[data-test=sketch-plane-select]', 'XY plane through the centre')
await page.waitForSelector('[data-test=sketch-editor]', { timeout: 20_000 }).catch(() => {})
check((await page.$('[data-test=sketch-editor]')) !== null, 'a plane chosen on the unaligned part opens a sketch')
check((await page.$('[data-test=sketch-align-nudge]')) !== null, 'and the box says the body will be built in the scanner’s frame, with the way to Measure’s alignment')
await page.screenshot({ path: shotPath('sample-nudge.png') })
await click(page, '[data-test=sketch-finish]')
await page.waitForFunction(() => !document.querySelector('[data-test=sketch-editor]'), { timeout: 10_000 }).catch(() => {})

// ---- aligned: the part back in the frame it was made in ----------------------------------
await page.evaluate((m) => window.__re.alignTo(m), invert(pose))
await sleep(800)

// ---- a sketch across the L, fit, extrude --------------------------------------------------
// The thank-you card lies over the lower left of the viewport, where the
// L's corner comes to stand; it is put away as a user would.
await page.evaluate(() => document.querySelector('[data-test=support-card] button')?.click())
await page.evaluate(() => window.__re.scene().frameAll?.())
await sleep(300)
await page.evaluate(() => window.__re.scene().viewFrom?.('top'))
await sleep(900)
await pickOption(page, '[data-test=sketch-plane-select]', 'XY plane through the centre')
await page.waitForSelector('[data-test=sketch-editor]', { timeout: 20_000 }).catch(() => {})
check((await page.$('[data-test=sketch-editor]')) !== null, 'the XY plane through the centre opens a sketch')
check((await page.$('[data-test=sketch-align-nudge]')) === null, 'with no nudge on the aligned part')
await page.waitForFunction(() => /slice chain/.test(document.querySelector('[data-test=sketch-plane]')?.textContent ?? ''), { timeout: 20_000 }).catch(() => {})
const frame = await page.evaluate(() => window.__re.store.getState().sketchDraft.frame)
console.log('sketch frame:', JSON.stringify(frame))
// "The centre" is the scan's centroid, which its triangulation puts a
// little off the middle of the box.
check(Math.abs(frame.normal[2] - 1) < 0.01 && Math.abs(frame.origin[2] - DEPTH / 2) < 0.5, 'across the L, about half way along it')
await click(page, '[data-test=sketch-fit-all]')
await page.waitForFunction(() => window.__re.store.getState().sketchDraft?.found?.length > 0, { timeout: 30_000 }).catch(() => {})
const found = await page.evaluate(() => window.__re.store.getState().sketchDraft?.found?.length ?? 0)
check(found === 1, `the slice fits to one closed L (${found} region${found === 1 ? '' : 's'})`)
await click(page, '[data-test=sketch-extrude]')
await page.waitForSelector('[data-test=extrude-editor]')
// The plane lies about half way along the part, so the body grows both
// ways: up to the end face, and down to a tenth short of the far one — the
// modelling error the mirror and the comparison below have to show.
const SHORT = 0.1
await page.evaluate(
  (z, depth, short) => {
    const re = window.__re.store.getState()
    re.setExtrude({ extent: { kind: 'distance', from: -(z - short), to: depth - z } })
  },
  frame.origin[2],
  DEPTH,
  SHORT,
)
await previewReady(page, { watchStatus: false }).catch(() => {})
await sleep(400)
await click(page, '[data-test=extrude-create]')
await page.waitForFunction(() => /mm³/.test(document.querySelector('[data-test=body-row] b')?.textContent ?? ''), { timeout: 60_000 }).catch(() => {})
const volume = Number((/([\d.]+) mm³/.exec(await page.$eval('[data-test=body-row] b', (el) => el.textContent)) ?? [])[1])
console.log('body:', volume, 'mm³, the sample is', VOLUME)
check(Math.abs(volume - VOLUME * (1 - SHORT / DEPTH)) < 1, `the body has the volume of the L, a tenth short (${volume} mm³)`)
await page.screenshot({ path: shotPath('sample-body.png') })

// ---- Fit surface: a region by clicks, the surface through it ------------------------------
// The body is put away first: a body's face under the cursor takes the
// click before the scan does. The click floods the L's end face by normal
// angle; the fit through a flat face is a flat surface within microns.
await click(page, '[data-test=body-visible]')
await sleep(200)
await click(page, '[data-test=feature-surface]')
await page.waitForSelector('[data-test=surface-editor]')
const regionText = () => page.$eval('[data-test=surface-region]', (el) => el.textContent)
check(/None/.test(await regionText()), 'a new Fit surface opens with no region')
await page.mouse.click(...(await screenOf([6, 6, DEPTH])))
await page.waitForFunction(() => /points/.test(document.querySelector('[data-test=surface-region]')?.textContent ?? ''), { timeout: 20_000 }).catch(() => {})
const regionPoints = Number((await regionText()).replace(/[^\d]/g, ''))
console.log('region:', await regionText())
check(regionPoints > 400 && regionPoints < 800, `a click floods the L’s end face into the region (${regionPoints} points — the face holds 696 cells)`)
await page.waitForFunction(() => /Fitted/.test(document.querySelector('[data-test=surface-preview]')?.textContent ?? ''), { timeout: 60_000 }).catch(() => {})
const fitted = await page.$eval('[data-test=surface-preview]', (el) => el.textContent)
console.log('fit:', fitted)
const sigma = Number((/σ ([\d.]+) mm/.exec(fitted) ?? [])[1])
check(sigma < 0.001, `the surface through the flat face is flat: σ ${sigma} mm`)
check((await page.$eval('[data-test=surface-region-clear]', (el) => el.disabled)) === false, 'Clear is offered')
await page.screenshot({ path: shotPath('sample-surface.png') })
// The same region as a plane: an exact face, held to the part's own planes.
await page.select('[data-test=surface-shape]', 'plane')
await page.waitForSelector('[data-test=surface-held]', { timeout: 60_000 }).catch(() => {})
const held = await page.$eval('[data-test=surface-held]', (el) => el.textContent).catch(() => '')
console.log('held:', held)
check(/^A plane/.test(held) && /Parallel to XY plane/.test(held), 'fitted as a plane, the end face is held parallel to the XY plane')
check((await page.$('[data-test=surface-net-u]')) === null && (await page.$('[data-test=surface-smooth]')) === null, 'a plane has no net and no smoothness to set')
const holdOptions = await page.$$eval('[data-test=surface-constrain] option', (os) => os.map((o) => o.textContent))
check(holdOptions.includes('Coincident with XY plane') && holdOptions.includes('Perpendicular to YZ plane'), `the Hold to list offers the relations by name (${holdOptions.length} options)`)
await page.select('[data-test=surface-constrain]', 'free')
await page.waitForFunction(() => /Held to nothing/.test(document.querySelector('[data-test=surface-held]')?.textContent ?? ''), { timeout: 60_000 }).catch(() => {})
check(/Held to nothing/.test(await page.$eval('[data-test=surface-held]', (el) => el.textContent).catch(() => '')), 'Nothing forbids the relations: the free fit')
await page.select('[data-test=surface-constrain]', 'on|datum:xy')
await page.waitForFunction(() => /Coincident with XY plane/.test(document.querySelector('[data-test=surface-held]')?.textContent ?? ''), { timeout: 60_000 }).catch(() => {})
check(/Coincident with XY plane/.test(await page.$eval('[data-test=surface-held]', (el) => el.textContent).catch(() => '')), 'a forced relation holds however far off the fit was')
await page.screenshot({ path: shotPath('sample-surface-plane.png') })
await page.select('[data-test=surface-shape]', 'freeform')
await page.waitForFunction(() => /Fitted/.test(document.querySelector('[data-test=surface-preview]')?.textContent ?? ''), { timeout: 60_000 }).catch(() => {})
// Ctrl-click takes the flood away again; a plain click brings it back.
await page.keyboard.down('Control')
await page.mouse.click(...(await screenOf([6, 6, DEPTH])))
await page.keyboard.up('Control')
await page.waitForFunction(() => /None/.test(document.querySelector('[data-test=surface-region]')?.textContent ?? ''), { timeout: 10_000 }).catch(() => {})
check(/None/.test(await regionText()), 'Ctrl-click takes the flood out of the region')
await page.mouse.click(...(await screenOf([6, 6, DEPTH])))
await page.waitForFunction(() => /points/.test(document.querySelector('[data-test=surface-region]')?.textContent ?? ''), { timeout: 10_000 }).catch(() => {})
await page.waitForFunction(() => /Fitted/.test(document.querySelector('[data-test=surface-preview]')?.textContent ?? ''), { timeout: 60_000 }).catch(() => {})
await click(page, '[data-test=surface-create]')
await page.waitForFunction(() => document.querySelectorAll('[data-test=feature-row]').length === 3 && !window.__re.store.getState().building, { timeout: 60_000 }).catch(() => {})
await sleep(300)
const bodyRows = await page.$$eval('[data-test=body-row]', (rows) => rows.map((r) => r.textContent))
console.log('bodies:', JSON.stringify(bodyRows))
check(bodyRows.length === 2 && /surface/.test(bodyRows[1]), 'the surface is a body of its own, listed as a surface')
check(/Surface · \d+ points · σ/.test(await page.$$eval('[data-test=feature-row]', (rows) => rows.at(-1).title).catch(() => '')), 'its row reads the point count and the fit’s σ in its tooltip')
// Undone, and the body shown again, for the mirror below.
await page.keyboard.down('Control')
await page.keyboard.press('z')
await page.keyboard.up('Control')
await page.waitForFunction(() => document.querySelectorAll('[data-test=feature-row]').length === 2 && !window.__re.store.getState().building, { timeout: 60_000 }).catch(() => {})
await click(page, '[data-test=body-visible]')
await sleep(300)

// ---- Trim: the L's eight faces as surfaces, closed into a solid ---------------------------
// The regions are taken off the scan's vertices by coordinate here — the
// click-and-flood is proven above — and committed as surfaces through the
// store; the trim itself goes through the box.
const surfacesMade = await page.evaluate(
  ({ W, H, L, D }) => {
    const scene = window.__re.scene()
    const p = scene.scanPositions()
    const faces = [
      (x, y, z) => Math.abs(z) < 1e-3,
      (x, y, z) => Math.abs(z - D) < 1e-3,
      (x, y, z) => Math.abs(x) < 1e-3,
      (x, y, z) => Math.abs(y) < 1e-3,
      (x, y, z) => Math.abs(x - W) < 1e-3 && y <= L + 1e-3,
      (x, y, z) => Math.abs(y - H) < 1e-3 && x <= L + 1e-3,
      (x, y, z) => Math.abs(x - L) < 1e-3 && y >= L - 1e-3,
      (x, y, z) => Math.abs(y - L) < 1e-3 && x >= L - 1e-3,
    ]
    const re = window.__re.store
    let made = 0
    for (const f of faces) {
      const region = []
      for (let v = 0; v < p.length / 3; v++) if (f(p[v * 3], p[v * 3 + 1], p[v * 3 + 2])) region.push(v)
      re.getState().startFeature('surface')
      re.getState().setRegion(Uint32Array.from(region))
      if (re.getState().commitFeature() !== null) made++
    }
    return made
  },
  { W: WIDTH, H: HEIGHT, L: LEG, D: DEPTH },
)
check(surfacesMade === 8, `the L’s eight faces are fitted as surfaces (${surfacesMade})`)
await page.waitForFunction(() => document.querySelectorAll('[data-test=body-row]').length === 9 && !window.__re.store.getState().building, { timeout: 120_000 }).catch(() => {})
await click(page, '[data-test=feature-trim]')
await page.waitForSelector('[data-test=trim-editor]')
check(/8 of 9/.test(await page.$eval('[data-test=trim-count]', (el) => el.textContent)), 'the Trim box opens with every surface body in the set, the solid left out')
const tolText = await page.$eval('[data-test=trim-tolerance-source]', (el) => el.textContent)
console.log('tolerance:', await page.$eval('[data-test=trim-tolerance]', (el) => el.value), '·', tolText)
check(/median σ/.test(tolText) && Number(await page.$eval('[data-test=trim-tolerance]', (el) => el.value)) === 0.05, 'the tolerance is read off the surfaces’ fits — at its floor on a noiseless part')
await page.waitForFunction(() => /Closed|Not closed/.test(document.querySelector('[data-test=trim-preview]')?.textContent ?? ''), { timeout: 120_000 }).catch(() => {})
const trimText = await page.$eval('[data-test=trim-preview]', (el) => el.textContent)
console.log('trim:', trimText)
check(/^Closed/.test(trimText), 'the eight surfaces close into a solid')
// The checklist and the viewport edit the same set. Keep only the top
// sheet visible during the click so the solid behind it cannot take the pick.
const { topSheet, hiddenForPick } = await page.evaluate(async () => {
  const re = window.__re.store.getState()
  const topSheet = re.features.filter((f) => f.kind === 'surface')[1].id
  const hiddenForPick = re.bodies.filter((b) => b.id !== topSheet && b.visible).map((b) => b.id)
  re.setBodiesVisible(hiddenForPick, false)
  re.setBodiesVisible([topSheet], true)
  window.__re.scene().viewFrom('top')
  const { reSceneOf } = await import('/plugins/reverse/viewer/reScene.ts')
  window.trimLitBodies = () => reSceneOf(window.__re.scene()).bodyPicks.lit()
  return { topSheet, hiddenForPick }
})
await click(page, '[data-test=trim-deselect-all]')
check(await page.$eval('[data-test=trim-count]', (el) => el.textContent) === '0 of 9', 'Deselect all clears the Trim checklist')
const topCheckbox = `[data-test=trim-tool-body-${topSheet}]`
const topPoint = await screenOf([6, 6, DEPTH])
await page.mouse.click(...topPoint)
await page.waitForFunction((checkbox, id) => document.querySelector(checkbox)?.checked && window.trimLitBodies().includes(id), { timeout: 10_000 }, topCheckbox, topSheet)
await page.mouse.click(...topPoint)
await page.waitForFunction((checkbox, id) => !document.querySelector(checkbox)?.checked && !window.trimLitBodies().includes(id), { timeout: 10_000 }, topCheckbox, topSheet)
check(true, 'clicking the fitted sheet toggles its checklist entry and viewport highlight')
await click(page, '[data-test=trim-select-all]')
check(await page.$eval('[data-test=trim-count]', (el) => el.textContent) === '9 of 9', 'Select all checks every offered Trim tool')
const solidCheckbox = await page.evaluate(() => {
  const solid = window.__re.store.getState().bodies.find((b) => !b.surface)
  return `[data-test=trim-tool-body-${solid.id}]`
})
await click(page, solidCheckbox)
await page.evaluate((ids) => window.__re.store.getState().setBodiesVisible(ids, true), hiddenForPick)
await page.waitForFunction(() => /^Closed/.test(document.querySelector('[data-test=trim-preview]')?.textContent ?? ''), { timeout: 120_000 })
// One surface out: the set no longer closes and the open edges are drawn.
const lastSurface = await page.evaluate(() => window.__re.store.getState().features.filter((f) => f.kind === 'surface').slice(-1)[0].id)
await click(page, `[data-test=trim-tool-body-${lastSurface}]`)
await page.waitForFunction(() => /Red marks/.test(document.querySelector('[data-test=trim-preview]')?.textContent ?? '') && window.__re.reScene().bodyPicks.openLines.length >= 4, { timeout: 120_000 })
console.log('trim, one out:', await page.$eval('[data-test=trim-preview]', (el) => el.textContent))
check(/Not closed/.test(await page.$eval('[data-test=trim-preview]', (el) => el.textContent)) && (await page.evaluate(() => window.__re.store.getState().preview.trim?.openEdges.length ?? 0)) >= 4, 'with one surface out the set does not close and the open edges round the gap are reported')
await page.screenshot({ path: shotPath('sample-trim-open.png') })
await click(page, `[data-test=trim-tool-body-${lastSurface}]`)
await page.waitForFunction(() => /^Closed/.test(document.querySelector('[data-test=trim-preview]')?.textContent ?? '') && window.__re.reScene().bodyPicks.openLines.length === 0, { timeout: 120_000 })
await click(page, '[data-test=trim-create]')
await page.waitForFunction(() => document.querySelectorAll('[data-test=body-row]').length === 10 && !window.__re.store.getState().building, { timeout: 120_000 }).catch(() => {})
await sleep(300)
const trimRow = await page.$$eval('[data-test=feature-row]', (rows) => rows.at(-1).title).catch(() => '')
const trimBody = await page.evaluate(() => window.__re.store.getState().bodies.slice(-1)[0])
console.log('trim body:', JSON.stringify(trimBody), '·', trimRow)
check(trimBody.closed && !trimBody.surface && Math.abs(trimBody.volume - VOLUME) < 1, `the trim is a closed solid of the sample’s volume (${trimBody.volume} mm³)`)
check(/solid, 8 of/.test(trimRow), 'its row reads the faces kept in its tooltip')
await page.screenshot({ path: shotPath('sample-trim.png') })
// D4: the trimmed solid is an ordinary body — a fillet on one of its edges
// takes the corner off, and the fingerprint names the edge by the faces
// the surfaces made.
const filleted = await page.evaluate(async (trimId) => {
  const re = window.__re.store
  const topo = window.__re.topology(trimId)
  const edge = topo.edges.find((e) => Math.abs(e.fingerprint.length - 20) < 0.5)
  if (!edge) return null
  re.getState().startFeature('fillet', { body: trimId })
  re.getState().toggleDraftEdge(trimId, edge)
  re.getState().setFeatureDraft({ radius: 2, radiusTyped: true })
  const id = re.getState().commitFeature()
  return { id, makers: edge.fingerprint.faces.length }
}, trimBody.id)
await page.waitForFunction(() => !window.__re.store.getState().building && document.querySelectorAll('[data-test=feature-row]').length === 12, { timeout: 120_000 }).catch(() => {})
await sleep(300)
const afterFillet = await page.evaluate((id) => window.__re.store.getState().bodies.find((b) => b.id === id), trimBody.id)
console.log('filleted:', JSON.stringify(filleted), JSON.stringify(afterFillet))
check(filleted?.id != null && afterFillet.closed && Math.abs(VOLUME - afterFillet.volume - (1 - Math.PI / 4) * 4 * DEPTH) < 0.5, `a fillet of R 2 on an edge of the trimmed solid takes the corner off (${(VOLUME - afterFillet.volume).toFixed(2)} mm³)`)
// Undone — the ten features — for the mirror below.
for (let i = 0; i < 10; i++) {
  await page.keyboard.down('Control')
  await page.keyboard.press('z')
  await page.keyboard.up('Control')
  await sleep(60)
}
await page.waitForFunction(() => document.querySelectorAll('[data-test=feature-row]').length === 2 && !window.__re.store.getState().building, { timeout: 120_000 }).catch(() => {})
await sleep(300)

// ---- Mirror opens on the scan's own symmetry plane -----------------------------------------
await click(page, '[data-test=feature-mirror]')
await page.waitForFunction(() => /symmetry plane/.test(document.querySelector('[data-test=mirror-symmetry]')?.textContent ?? '') && !/Looking/.test(document.querySelector('[data-test=mirror-symmetry]').textContent), { timeout: 120_000 }).catch(() => {})
const mirror = await page.evaluate(() => {
  const d = window.__re.store.getState().featureDraft
  return d && d.kind === 'mirror' ? { plane: d.plane, status: d.symmetry.status, rms: d.symmetry.plane?.rms } : null
})
console.log('mirror:', JSON.stringify(mirror), '·', await page.$eval('[data-test=mirror-symmetry]', (el) => el.textContent))
check(mirror?.status === 'found' && mirror.plane?.kind === 'fitted', 'the Mirror box opens with the symmetry plane found on the scan')
if (mirror?.plane?.kind === 'fitted') {
  const f = mirror.plane.frame
  check(Math.abs(Math.abs(f.normal[2]) - 1) < 0.01 && Math.abs(f.origin[2] - DEPTH / 2) < 0.05, `which is the L’s mid-plane (z = ${f.origin[2].toFixed(3)})`)
}
await click(page, '[data-test=mirror-symmetry-keep]')
await sleep(300)
const kept = await page.evaluate(() => {
  const d = window.__re.store.getState().featureDraft
  return d && d.kind === 'mirror' ? d.plane : null
})
check(kept?.kind === 'plane', 'Keep as a plane element makes it a Measure plane and moves the mirror onto it')
await click(page, '[data-test=mirror-create]')
await page.waitForFunction(() => document.querySelectorAll('[data-test=feature-row]').length === 3, { timeout: 30_000 }).catch(() => {})
await page.waitForFunction(() => !window.__re.store.getState().building, { timeout: 60_000 }).catch(() => {})
await sleep(300)
const mirrored = Number((/([\d.]+) mm³/.exec(await page.$eval('[data-test=body-row] b', (el) => el.textContent)) ?? [])[1])
check(Math.abs(mirrored - VOLUME) < 1, `mirrored about the scan’s mid-plane and joined, the short end is made up: the sample’s volume (${mirrored} mm³)`)

// Undone again: the comparison is of the body that is a tenth short.
await page.keyboard.down('Control')
await page.keyboard.press('z')
await page.keyboard.up('Control')
await page.waitForFunction(() => document.querySelectorAll('[data-test=feature-row]').length === 2 && !window.__re.store.getState().building, { timeout: 60_000 }).catch(() => {})
await sleep(500)

// ---- Compare in Deviation ---------------------------------------------------------------------
await click(page, '[data-test=compare-in-deviation]')
await page.waitForFunction(() => document.querySelector('[data-test=align-built]') !== null, { timeout: 120_000 }).catch(() => {})
check((await page.$('[data-test=align-built]')) !== null, 'Compare in Deviation switches to Deviation with the bodies as the reference and says no best fit was run')
await page.waitForSelector('[data-test=deviation-stats]', { timeout: 120_000 }).catch(() => {})
await sleep(500)
const stats = await page.$eval('[data-test=deviation-stats]', (el) => el.textContent.replace(/([a-z%])([A-Z−+±])/g, '$1 | $2')).catch(() => null)
console.log('stats:', stats)
check(stats !== null, 'the map is measured at once')
const maxDev = Number((/max \| \+([\d.]+)/.exec(stats ?? '') ?? [])[1])
check(Math.abs(maxDev - SHORT) < 0.005, `and reads the short end as the scan standing ${maxDev} mm outside the body — no best fit has spread it over the part`)
await sleep(600)
const near = await page.evaluate((d) => window.__re.colorNear([6, 6, d]), DEPTH)
const far = await page.evaluate(() => window.__re.colorNear([6, 6, 0]))
console.log('colours: near face', JSON.stringify(near), 'far face', JSON.stringify(far))
// The sample is flat-faced, so the viewer splits its sharp edges for
// shading and the colour buffer runs past the scan's vertices — the case
// in which a map used not to be drawn at all.
check(near && far && far[0] > far[1] && near[1] > near[0], 'the scan is green on the face the body meets and red on the one it falls short of')
const panelText = await page.$eval('aside.panel', (el) => el.textContent)
check(/Bodies from Reverse engineer/.test(panelText), 'the reference is labelled as the bodies from Reverse engineer')
await page.screenshot({ path: shotPath('sample-compare.png') })

await finish(browser, consoleErrors)

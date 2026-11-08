// SPDX-License-Identifier: AGPL-3.0-only
// Issue 47: a small feature on a large scan, zoomed in on. A frame two metres
// across with a Ø32 mm bore in it. What is drawn at a size of its own — a point,
// a line, the grips of the element being made, selection strokes, centre dots —
// is held in pixels, so it covers little of the bore zoomed in and can still be
// clicked zoomed out; what is measured keeps its true size. The grips go away
// while the brush is in hand. Pictures of each are left in SHOT_DIR.
//
// Prereqs: a dev server running (npm run dev), Chrome.
//   node scripts/e2e-small-feature.mjs
// Env: APP_URL, CHROME, SHOT_DIR. BEFORE=1 takes the pictures and reports what
// it finds without failing, for a build from before the change.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canvasRect, check as passes, click, fail, finish, launchApp, loadScan, shotPath, sleep } from './e2e-lib.mjs'

const BEFORE = process.env.BEFORE === '1'
const check = (ok, what) => (BEFORE ? console.log(`${ok ? 'holds' : 'DOES NOT HOLD'}: ${what}`) : passes(ok, what))
const prefix = BEFORE ? 'before' : 'after'

// ---- the scan -----------------------------------------------------------------------
// A plate 2000 × 1400, fine for 150 mm around a blind bore at the origin.
const R = 16
const DEPTH = 30
const tris = []
const quad = (a, b, c, d) => tris.push([a, b, c], [a, c, d])
const CELL = 1.5
const PATCH = 150
for (let x = -PATCH; x < PATCH; x += CELL) {
  for (let y = -PATCH; y < PATCH; y += CELL) {
    if (Math.hypot(x + CELL / 2, y + CELL / 2) < R + CELL) continue
    quad([x, y, 0], [x + CELL, y, 0], [x + CELL, y + CELL, 0], [x, y + CELL, 0])
  }
}
const SIDES = 180
for (let k = 0; k < SIDES; k++) {
  const a = (k / SIDES) * 2 * Math.PI
  const b = ((k + 1) / SIDES) * 2 * Math.PI
  for (let z = 0; z > -DEPTH; z -= CELL) {
    quad([R * Math.cos(a), R * Math.sin(a), z], [R * Math.cos(a), R * Math.sin(a), z - CELL], [R * Math.cos(b), R * Math.sin(b), z - CELL], [R * Math.cos(b), R * Math.sin(b), z])
  }
  tris.push([[0, 0, -DEPTH], [R * Math.cos(b), R * Math.sin(b), -DEPTH], [R * Math.cos(a), R * Math.sin(a), -DEPTH]])
  // The lip from the bore out to the fine grid.
  quad([R * Math.cos(a), R * Math.sin(a), 0], [(R + CELL * 2) * Math.cos(a), (R + CELL * 2) * Math.sin(a), 0], [(R + CELL * 2) * Math.cos(b), (R + CELL * 2) * Math.sin(b), 0], [R * Math.cos(b), R * Math.sin(b), 0])
}
const [W, H] = [1000, 700]
quad([-W, -H, 0], [-PATCH, -H, 0], [-PATCH, H, 0], [-W, H, 0])
quad([PATCH, -H, 0], [W, -H, 0], [W, H, 0], [PATCH, H, 0])
quad([-PATCH, -H, 0], [PATCH, -H, 0], [PATCH, -PATCH, 0], [-PATCH, -PATCH, 0])
quad([-PATCH, PATCH, 0], [PATCH, PATCH, 0], [PATCH, H, 0], [-PATCH, H, 0])
const buf = Buffer.alloc(84 + tris.length * 50)
buf.writeUInt32LE(tris.length, 80)
tris.forEach((t, i) => t.forEach((p, k) => p.forEach((x, j) => buf.writeFloatLE(x, 84 + i * 50 + 12 + k * 12 + j * 4))))
const scan = join(mkdtempSync(join(tmpdir(), 'scanruler-small-')), 'frame.stl')
writeFileSync(scan, buf)

const { browser, page, consoleErrors } = await launchApp({ width: 1400, height: 1000 })
try {
  await loadScan(page, scan)
  const rect = await canvasRect(page)
  // The support card, which would stand over the part in the pictures.
  await page.$$eval('button', (buttons) => buttons.find((b) => b.closest('[class*=support]') && /×|close/i.test(`${b.textContent}${b.title}${b.ariaLabel}`))?.click())
  const closeUp = async () => {
    await page.evaluate(() => window.__scanruler.scene().fitBox([-30, -30, -30], [30, 30, 5]))
    await sleep(500)
  }
  const closeToPoint = async () => {
    await page.evaluate(() => window.__scanruler.scene().fitBox([290, -240, -30], [350, -180, 5]))
    await sleep(500)
  }
  const allIn = async () => {
    await page.evaluate(() => window.__scanruler.scene().fitBox([-1000, -700, -30], [1000, 700, 5]))
    await sleep(500)
  }
  /** The grips on the stage, in pixels. */
  const gripSizes = () => page.evaluate(() => {
    const s = window.__scanruler.scene()
    const pixel = s.viewport.worldPerPixel()
    return s.grips.handles.map((h) => ({ side: h.side, length: h.mesh.scale.y / pixel, across: h.mesh.scale.x / pixel }))
  })
  /** The marks of an element, in pixels, by what they are. */
  const marksOf = (id) => page.evaluate((id) => {
    const s = window.__scanruler.scene()
    const pixel = s.viewport.worldPerPixel()
    const out = {}
    for (const mesh of s.overlays.pickTargets()) {
      if (mesh.userData.elementId !== id) continue
      const kind = mesh.geometry.type === 'SphereGeometry' ? 'ball' : 'rod'
      if (kind === 'ball') out.balls = [...(out.balls ?? []), mesh.scale.x / pixel]
      else {
        out.rod = mesh.scale.x / pixel
        out.rodLength = mesh.scale.y
      }
    }
    return out
  }, id)
  /** The place on the screen a point of the part is drawn at. */
  const toClient = (p) => page.evaluate((q) => {
    const s = window.__scanruler.scene()
    const c = s.viewport.renderer.domElement.getBoundingClientRect()
    const v = s.overlays.pickTargets()[0].position.clone().set(q[0], q[1], q[2])
    s.overlays.pickTargets()[0].parent.localToWorld(v)
    v.project(s.viewport.camera)
    return [c.left + ((v.x + 1) / 2) * c.width, c.top + ((1 - v.y) / 2) * c.height]
  }, p)
  const strokes = () => page.evaluate(() => window.__scanruler.scene().overlays.selectionGroup.children.length)

  // The camera leans a little, so the bore reads as one.
  await page.mouse.move(rect.x + rect.w * 0.5, rect.y + rect.h * 0.5)
  await page.mouse.down()
  await page.mouse.move(rect.x + rect.w * 0.5 + 30, rect.y + rect.h * 0.5 + 40, { steps: 5 })
  await page.mouse.up()
  await closeUp()
  await page.screenshot({ path: shotPath(`${prefix}-0-bore.png`) })

  // ---- a cylinder being made, its grips on the stage -------------------------------
  const onWall = [rect.x + rect.w * 0.5 + rect.h * 0.19, rect.y + rect.h * 0.5]
  await click(page, '[data-test="fit-cylinder"]')
  await page.mouse.move(onWall[0], onWall[1])
  await sleep(100)
  await page.mouse.click(onWall[0], onWall[1])
  await page.waitForSelector('[data-test="create-element"]:not([disabled])', { timeout: 30_000 })
  await sleep(600)
  await page.mouse.move(rect.x + 8, rect.y + 8)
  await sleep(400)
  await page.screenshot({ path: shotPath(`${prefix}-1-cylinder-draft.png`) })
  const near = await gripSizes()
  console.log('grips near', JSON.stringify(near))
  check(near.length === 2 && near.every((g) => g.length < 60), `zoomed in, the arrows are small on the screen: ${near.map((g) => `${Math.round(g.length)} px`).join(', ')}`)
  await allIn()
  await page.screenshot({ path: shotPath(`${prefix}-2-cylinder-draft-far.png`) })
  const far = await gripSizes()
  check(far.every((g) => g.length >= 20), `zoomed out, they are large enough to take hold of: ${far.map((g) => `${Math.round(g.length)} px`).join(', ')}`)
  await closeUp()

  // ---- the brush in hand: nothing in the way ------------------------------------------
  await page.select('[data-test="draft-select-mode"]', 'paint')
  await click(page, '[data-test="mark-brush"]')
  await page.waitForSelector('[data-test="mark-brush-diameter"]')
  await page.$eval('[data-test="mark-brush-diameter"]', (el) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, '6')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await sleep(300)
  // A stroke down the wall of the bore; the fit comes up as the button is let go.
  await page.mouse.move(onWall[0], onWall[1] - rect.h * 0.1)
  await page.mouse.down()
  await page.mouse.move(onWall[0], onWall[1] + rect.h * 0.1, { steps: 12 })
  await page.mouse.up()
  await sleep(1500)
  await page.mouse.move(rect.x + 8, rect.y + 8)
  await sleep(400)
  await page.screenshot({ path: shotPath(`${prefix}-3-brushing.png`) })
  const brushing = await page.evaluate(() => {
    const s = window.__scanruler.scene()
    return { armed: s.marking.gestureArmed(), grips: s.grips.handles.length, shown: s.grips.handleGroup.visible, ghost: s.overlays.previewShape?.material.opacity ?? null }
  })
  console.log('after a stroke of the brush', JSON.stringify(brushing))
  check(brushing.armed && (!brushing.shown || brushing.grips === 0), 'with the brush in hand the grips stand in the way of nothing')
  check(brushing.ghost === null || brushing.ghost <= 0.1, `and the ghost of the fit stands back: opacity ${brushing.ghost}`)
  const rimPx = await page.evaluate(() => {
    const s = window.__scanruler.scene()
    const rims = s.overlays.previewEnds.children
    return rims.length ? Math.max(...rims.map((m) => m.geometry.parameters.tube * m.scale.x)) / s.viewport.worldPerPixel() : null
  })
  check(rimPx === null || rimPx < 3, `and the rims on its ends are thin on the screen, however large the fit: ${rimPx?.toFixed(1)} px`)

  await click(page, '[data-test="cancel-draft"]')
  await sleep(300)
  await page.evaluate(() => {
    const m = window.__scanruler.measure
    const base = { color: '#ff8800', source: { type: 'picked' }, status: 'done', visible: true }
    m.setState({
      elements: [
        { ...base, id: 900, kind: 'cylinder', name: 'Cylinder 900', fit: { kind: 'cylinder', center: [0, 0, -15], axis: [0, 0, 1], radius: 16, length: 30, sigma: 0, usedPoints: 100, regionSize: 100 } },
        { ...base, id: 901, kind: 'point', name: 'Point 901', fit: { kind: 'point', center: [8, 8, 0], sigma: 0, usedPoints: 1, regionSize: 1 } },
        { ...base, id: 902, kind: 'line', name: 'Line 902', fit: { kind: 'line', center: [-8, -8, 0], dir: [1, 0, 0], length: 20, sigma: 0, usedPoints: 2, regionSize: 2 } },
        { ...base, id: 903, kind: 'point', name: 'Point 903', fit: { kind: 'point', center: [320, -210, 0], sigma: 0, usedPoints: 1, regionSize: 1 } },
      ],
      nextId: 904,
    })
  })
  await sleep(500)

  // ---- a point and a line, near and far -------------------------------------------------
  await page.screenshot({ path: shotPath(`${prefix}-4-elements-near.png`) })
  const pointNear = await marksOf(901)
  const lineNear = await marksOf(902)
  const cylinder = await page.evaluate(() => {
    const s = window.__scanruler.scene()
    const mesh = s.overlays.pickTargets().find((m) => m.userData.elementId === 900 && m.geometry.type === 'CylinderGeometry')
    return { radius: mesh.scale.x, length: mesh.scale.y }
  })
  check(cylinder.radius === 16 && cylinder.length === 30, `a cylinder keeps its true size: R ${cylinder.radius}, ${cylinder.length} long`)
  await allIn()
  await page.screenshot({ path: shotPath(`${prefix}-5-elements-far.png`) })
  const pointFar = await marksOf(901)
  const lineFar = await marksOf(902)
  const big = (m) => Math.max(...m.balls)
  console.log('point near', JSON.stringify(pointNear), 'far', JSON.stringify(pointFar))
  console.log('line near', JSON.stringify(lineNear), 'far', JSON.stringify(lineFar))
  check(big(pointNear) < 12, `zoomed in, a point is a few pixels: ${big(pointNear).toFixed(1)} px`)
  check(big(pointFar) >= 4, `zoomed out, it is large enough to click: ${big(pointFar).toFixed(1)} px`)
  check(lineNear.rod < 6 && lineFar.rod >= 2, `a line's thickness holds too: ${lineNear.rod.toFixed(1)} px near, ${lineFar.rod.toFixed(1)} px far`)
  check(lineNear.rodLength === lineFar.rodLength && lineNear.rodLength === 21, `and its length is its own: ${lineNear.rodLength}`)

  // ---- a point's pin stands clear of it, from any side ----------------------------------
  // The pin was lifted 18 px along the part's Y: looking along Y it sat on
  // the point, and from anywhere its lower half covered it (issue 47 again).
  /** How far the pin's lower edge stands above the top of the point's ball
   *  on the screen, pixels: below zero, it covers the ball. */
  const pinClearance = () => page.evaluate(() => {
    const s = window.__scanruler.scene()
    const pixel = s.viewport.worldPerPixel()
    const ball = s.overlays.pickTargets().filter((m) => m.userData.elementId === 901 && m.geometry.type === 'SphereGeometry').sort((a, b) => b.scale.x - a.scale.x)[0]
    const c = s.viewport.renderer.domElement.getBoundingClientRect()
    const v = ball.getWorldPosition(ball.position.clone()).project(s.viewport.camera)
    const y = c.top + ((1 - v.y) / 2) * c.height
    const label = [...document.querySelectorAll('.viewport-label.element-label')].find((el) => el.textContent.includes('Point 901'))
    return y - ball.scale.x / pixel - label.getBoundingClientRect().bottom
  })
  await closeUp()
  for (const view of ['iso', 'front', 'right', 'top']) {
    await page.evaluate((v) => window.__scanruler.scene().viewFrom(v), view)
    await sleep(900)
    const clear = await pinClearance()
    check(clear >= 2, `from the ${view}, the point's pin stands clear of it: ${clear.toFixed(1)} px`)
  }
  await page.screenshot({ path: shotPath(`${prefix}-5b-point-pin-front.png`) })

  // ---- Settings → Points and grips grows what is held on the screen ---------------------
  const ballAt = async () => big(await marksOf(901))
  const plain = await ballAt()
  await page.evaluate(() => window.__scanruler.scene().setMarkSize(2))
  await sleep(300)
  const doubled = await ballAt()
  check(Math.abs(doubled - 2 * plain) < 0.5, `twice the size, the point is twice as large: ${plain.toFixed(1)} → ${doubled.toFixed(1)} px`)
  check((await pinClearance()) >= 2, 'and its pin still stands clear of it')
  await page.evaluate(() => window.__scanruler.scene().setMarkSize(1))
  await sleep(300)
  await page.evaluate(() => window.__scanruler.scene().viewFrom('iso'))
  await sleep(900)
  await allIn()

  // ---- a click on the point from far off takes it, and its stroke follows the zoom -----
  check((await strokes()) === 0, 'nothing is selected yet')
  await click(page, '[data-test="new-dimension"]')
  await sleep(300)
  const [x, y] = await toClient([320, -210, 0])
  await page.mouse.move(x, y)
  await sleep(200)
  await page.mouse.click(x, y)
  await sleep(400)
  check((await strokes()) === 1, 'zoomed all the way out, a click on the point takes it into a dimension')
  await page.screenshot({ path: shotPath(`${prefix}-6-point-selected-far.png`) })
  const strokeAt = () => page.evaluate(() => {
    const s = window.__scanruler.scene()
    return s.overlays.selectionGroup.children[0].scale.x / s.viewport.worldPerPixel()
  })
  const strokeFar = await strokeAt()
  await closeToPoint()
  await page.screenshot({ path: shotPath(`${prefix}-7-point-selected-near.png`) })
  const strokeNear = await strokeAt()
  check(Math.abs(strokeFar - strokeNear) < 0.5 && strokeNear < 12, `its selection stroke stays the same on the screen: ${strokeFar.toFixed(1)} px far, ${strokeNear.toFixed(1)} px near`)
} catch (e) {
  fail(`threw: ${e instanceof Error ? e.stack : String(e)}`)
} finally {
  await finish(browser, consoleErrors)
}

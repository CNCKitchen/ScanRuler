// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end test for Mesh Tools' Trim to scan, the body modelled in the
// Reverse engineer workspace: drives the real app in headless Chrome on a
// generated block whose top is a rough fracture, models a box standing 2 mm
// into it and 0.2 mm wider than it all round — larger than the part, as a
// model of a worn part is — picks the box on the part in Mesh Tools, checks
// the break is found and marked, trims the box to it, reads the piece's
// volume against the fracture's own and its gap to the part as it reads it,
// colours its mating face by the gap, exports it as an STL and reads the file
// back, trims again with an offset and with the other side kept, steps the
// side back with Ctrl+Z, and puts the tool away with Escape — the piece still
// in view, listed in the parts list beside the scan and the box, each shown
// and hidden by its eye.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node plugins/mesh-tools/scripts/e2e-mesh-trim.mjs
// Env: CHROME (chrome.exe path), APP_URL, SHOT_DIR.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeBinarySTL } from 'meshstep'
import { awaitDownload, check, click, downloadsTo, fieldSetter, finish, launchApp, loadScan, OUT_DIR, shotPath, sleep } from '../../../scripts/e2e-lib.mjs'
import { reverseHelpers } from '../../reverse/scripts/lib.mjs'

const W = 30, H = 20
/** How much larger than the block the box is on every side, and how far
 *  below the fracture it reaches. */
const OVER = 0.2, INTO = 2, TOP = 30
const STEP = 0.5

/** The fracture's height over the block's top: a few waves, calm towards
 *  the edges, so the top meets the sides along a straight rim. */
function rough(x, y) {
  const edge = Math.min(W / 2 - Math.abs(x), W / 2 - Math.abs(y))
  const calm = Math.max(0, Math.min(1, edge / 1.5))
  return calm * (0.25 * Math.sin((2 * Math.PI * x) / 7.3 + 0.7) + 0.15 * Math.sin((2 * Math.PI * y) / 3.1 + 1.3 + 0.4 * x) + 0.1 * Math.sin((2 * Math.PI * (x + y)) / 2.3))
}

/** The block, closed: every face a grid of half a millimetre across and a
 *  millimetre up, the top lifted by the fracture, wound outward. */
function blockMesh() {
  const positions = []
  const indices = []
  const h = W / 2
  const faces = [
    [[-h, -h, H], [W, 0, 0], [0, W, 0], true],
    [[-h, -h, 0], [0, W, 0], [W, 0, 0], false],
    [[-h, -h, 0], [W, 0, 0], [0, 0, H], false],
    [[-h, h, 0], [0, 0, H], [W, 0, 0], false],
    [[-h, -h, 0], [0, 0, H], [0, W, 0], false],
    [[h, -h, 0], [0, W, 0], [0, 0, H], false],
  ]
  for (const [o, u, v, top] of faces) {
    const along = (e) => Math.round(Math.hypot(...e) / (e[2] !== 0 ? 1 : STEP))
    const nu = along(u)
    const nv = along(v)
    const base = positions.length / 3
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const x = o[0] + (u[0] * i) / nu + (v[0] * j) / nv
        const y = o[1] + (u[1] * i) / nu + (v[1] * j) / nv
        const z = o[2] + (u[2] * i) / nu + (v[2] * j) / nv
        positions.push(x, y, top ? z + rough(x, y) : z)
      }
    }
    for (let j = 0; j < nv; j++)
      for (let i = 0; i < nu; i++) {
        const a = base + j * (nu + 1) + i
        indices.push(a, a + 1, a + nu + 2, a, a + nu + 2, a + nu + 1)
      }
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) }
}

/** What the box keeps above the fracture: its footprint times the height
 *  over the block's top, less the fracture's own rise. */
function aboveFracture() {
  const half = W / 2 + OVER
  const n = 600
  let lift = 0
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const x = -half + ((i + 0.5) * 2 * half) / n
      const y = -half + ((j + 0.5) * 2 * half) / n
      if (Math.abs(x) < W / 2 && Math.abs(y) < W / 2) lift += rough(x, y) * ((2 * half) / n) ** 2
    }
  return (2 * half) ** 2 * (TOP - H) - lift
}

/** The fracture's own area within `half` of the middle each way — the
 *  waves make it some 5 % more than its footprint; flat past the block. */
function fractureArea(half) {
  const n = 600
  const d = (2 * half) / n
  const e = 1e-4
  let area = 0
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const x = -half + (i + 0.5) * d
      const y = -half + (j + 0.5) * d
      const inside = Math.abs(x) < W / 2 && Math.abs(y) < W / 2
      const hx = inside ? (rough(x + e, y) - rough(x - e, y)) / (2 * e) : 0
      const hy = inside ? (rough(x, y + e) - rough(x, y - e)) / (2 * e) : 0
      area += Math.sqrt(1 + hx * hx + hy * hy) * d * d
    }
  return area
}

mkdirSync(OUT_DIR, { recursive: true })
const SCAN = join(OUT_DIR, 'mesh-trim-block.stl')
writeFileSync(SCAN, Buffer.from(writeBinarySTL(blockMesh())))
const footprint = (W + 2 * OVER) ** 2
const kept = aboveFracture()

const { browser, page, consoleErrors } = await launchApp({ width: 1600, height: 1000, protocolTimeout: 600_000 })
const text = (sel) => page.$eval(sel, (el) => el.textContent.replace(/\s+/g, ' ').trim())
const { re, clickAt } = reverseHelpers(page)
const number = (s) => Number(String(s).replace(/[^\d.]/g, ''))
const setField = fieldSetter(page)
/** Trim, and the piece's volume once it lands. */
const trim = async () => {
  const before = await page.$eval('[data-test=trim-volume] b', (el) => el.textContent).catch(() => null)
  await click(page, '[data-test=trim-run]')
  await page.waitForFunction(
    (was) => {
      const b = document.querySelector('[data-test=trim-volume] b')
      const busy = document.querySelector('[data-test=trim-run] .spinner')
      return b && !busy && b.textContent !== was
    },
    { timeout: 120_000 },
    before,
  )
  await sleep(300)
  return number(await text('[data-test=trim-volume] b'))
}
const ghosted = () => re(() => window.__scanruler.scene().scanGhost === true)
/** What the viewport draws: the scan, the piece — the one mesh in two
 *  materials — and the lent bodies, each a group of a fill, its pass through
 *  the part and its edges. */
const drawn = () =>
  re(() => {
    const scene = window.__scanruler.scene()
    const kids = scene.partGroup.children
    return {
      scan: scene.mesh.visible,
      piece: kids.some((o) => o.isMesh && Array.isArray(o.material) && o.material.length === 2 && o.visible),
      bodies: kids.filter((o) => o.isGroup && o.children.length === 3 && o.children[2].isLineSegments).length,
    }
  })

// ---- Reverse engineer: the box, 0.2 mm wider than the block, 2 mm into it --------------
await page.click('[data-test=workspace-reverse]')
await page.waitForSelector('[data-test=slot-scan] input[type=file]')
await page.waitForFunction(() => /ready/.test(document.querySelector('[data-test=kernel-status]')?.textContent ?? ''), { timeout: 180_000 })
await loadScan(page, SCAN, { inputSelector: '[data-test=slot-scan] input[type=file]', settle: 500 })
await re(
  ({ half, from, to }) => {
    const s = () => window.__re.store.getState()
    s().startSketch({ kind: 'world', axis: 'z', offset: 0 }, { origin: [0, 0, 0], normal: [0, 0, 1], basisU: [1, 0, 0], basisV: [0, 1, 0] })
    s().setSketchTool('rectangle')
    s().sketchClick([-half, -half], 0.01, false, { off: true })
    s().sketchClick([half, half], 0.01, false, { off: true })
    s().setSketchTool('select')
    const id = s().commitSketch()
    s().startExtrude(id)
    s().setExtrude({ extent: { kind: 'distance', from, to } })
    s().commitExtrude()
  },
  { half: W / 2 + OVER, from: H - INTO, to: TOP },
)
await page.waitForFunction(() => !window.__re.store.getState().building && window.__re.store.getState().bodies.length > 0, { timeout: 60_000 })
const bodyVolume = await re(() => window.__re.store.getState().bodies[0]?.volume ?? 0)
const boxVolume = footprint * (TOP - H + INTO)
check(Math.abs(bodyVolume - boxVolume) < 0.5, `the box is built (${bodyVolume.toFixed(1)} mm³ of ${boxVolume.toFixed(1)})`)

// ---- Mesh Tools: the box picked on the part, the break found ------------------------------
await page.click('[data-test=workspace-mesh]')
await click(page, '[data-test=mesh-tool-trim]')
await page.waitForSelector('[data-test=trim-tool]')
const rows = await page.$$eval('[data-test=trim-solid]', (els) => els.map((e) => ({ name: e.textContent.replace(/\s+/g, ' ').trim(), on: e.querySelector('input').checked })))
console.log('bodies:', JSON.stringify(rows))
check(rows.length === 1 && rows[0].name === 'Solid 1 · Reverse engineer' && !rows[0].on, 'the box is on offer, not yet in hand')
check(Boolean(await page.$('[data-test=trim-pick-hint]')), 'the panel asks for a click on the body')
check(await page.$eval('[data-test=trim-run]', (el) => el.disabled), 'nothing to trim with no body in hand')
await sleep(800)
await clickAt(0, 0, 27)
check(await page.$eval('[data-test=trim-solid] input', (el) => el.checked), 'a click on the box puts it in hand')
await page.waitForSelector('[data-test=trim-break]', { timeout: 60_000 })
const breakLine = await text('[data-test=trim-break]')
console.log('break:', breakLine)
const breakArea = Number(/([\d.]+) mm²/.exec(breakLine)?.[1] ?? 0)
const inset = fractureArea(W / 2 - (0.3 - OVER))
check(Math.abs(breakArea - inset) < 0.01 * inset, `the break is the block's top, a tenth in from its edges (${breakArea} mm² of ${inset.toFixed(1)})`)
const marked = await re(() => window.__scanruler.scene().paintedVertices().length)
check(marked > 3000, `and is marked on the part (${marked} points)`)
// The marking rubbed out leaves nothing to trim with; Find again marks it.
await click(page, '[data-test=mark-clear]')
await sleep(300)
check(await page.$eval('[data-test=trim-run]', (el) => el.disabled), 'with the marking cleared there is nothing to trim with')
await click(page, '[data-test=trim-find-again]')
await page.waitForFunction((n) => window.__scanruler.scene().paintedVertices().length === n, { timeout: 60_000 }, marked).catch(() => {})
check((await re(() => window.__scanruler.scene().paintedVertices().length)) === marked, 'Find again marks the break as it was found')
check(/The break where Solid 1 reaches into the part is marked in teal/.test(await text('.strip .msg')), 'the status line says the break is marked')
check(!(await page.$eval('[data-test=trim-run]', (el) => el.disabled)), 'the box can be trimmed')
check((await text('[data-test=trim-run]')) === 'Trim Solid 1 to the break', 'the button names the body')
await page.screenshot({ path: shotPath('mesh-trim-break.png') })

// ---- trimmed on the break -----------------------------------------------------------------
const onBreak = await trim()
const expected = kept - 0.01 * footprint
check(Math.abs(onBreak - expected) < 0.005 * expected, `the piece is the box above the fracture (${onBreak} mm³ of ${expected.toFixed(1)})`)
const mating = Number(/([\d.]+) mm²/.exec(await text('[data-test=trim-mating]'))?.[1] ?? 0)
const spans = fractureArea(W / 2 + OVER)
check(Math.abs(mating - spans) < 0.01 * spans, `its mating face is the fracture across the box (${mating} mm² of ${spans.toFixed(1)})`)
check((await page.$eval('[data-test=trim-view-piece]', (el) => el.getAttribute('aria-checked'))) === 'true', 'the piece is on show')
check(await ghosted(), 'over the scan, ghosted')
await page.screenshot({ path: shotPath('mesh-trim-piece.png') })
// Its own reading of the gap: a hundredth at an offset of 0, the thinnest
// the cut can be — the scan, sampled every half millimetre, lets it be no
// nearer to the fracture's waves than a few thousandths.
const gapLine = await text('[data-test=trim-gap] b')
console.log('gap:', gapLine)
const [gapMedian, gapLow, gapHigh] = (gapLine.match(/-?\d+\.\d+/g) ?? []).map(Number)
check(Math.abs(gapMedian - 0.01) < 0.003 && gapLow > 0 && gapHigh < 0.05, `the piece reads 0.01 mm off the part (${gapLine})`)
await click(page, '[data-test=trim-view-gap]')
await page.waitForSelector('[data-test=trim-gap-legend]', { timeout: 10_000 })
check(/further off the part/.test(await text('[data-test=trim-gap-end-high]')), 'Gap colours the mating face, its legend saying which end is which')
check(await ghosted(), 'still over the scan ghosted')
await page.screenshot({ path: shotPath('mesh-trim-gap.png') })
await click(page, '[data-test=trim-view-piece]')
await sleep(200)
check(!(await page.$('[data-test=trim-gap-legend]')), 'and Piece puts the legend away')

// ---- exported as an STL, read back ------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'scanruler-trim-'))
const cdp = await downloadsTo(page, dir)
await click(page, '[data-test=export-trimmed-mesh]')
await click(page, '[data-test=export-trimmed-mesh-stl]')
const stlFile = await awaitDownload(dir, '.stl')
const stl = stlFile ? { name: stlFile, bytes: readFileSync(join(dir, stlFile)) } : null
check(Boolean(stl) && /Solid-1-trimmed\.stl$/.test(stl.name), `the piece downloaded${stl ? ` as ${stl.name}` : ''}`)
if (stl) {
  const n = stl.bytes.readUInt32LE(80)
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (let t = 0; t < n; t++) {
    for (let c = 0; c < 3; c++) {
      for (let k = 0; k < 3; k++) {
        const v = stl.bytes.readFloatLE(84 + 50 * t + 12 + c * 12 + k * 4)
        lo[k] = Math.min(lo[k], v)
        hi[k] = Math.max(hi[k], v)
      }
    }
  }
  console.log('STL box:', lo.map((v) => v.toFixed(3)), hi.map((v) => v.toFixed(3)))
  const half = W / 2 + OVER
  check(n > 1000 && stl.bytes.length === 84 + 50 * n, `the STL holds the piece's ${n} triangles`)
  check(Math.abs(lo[0] + half) < 1e-3 && Math.abs(hi[0] - half) < 1e-3 && Math.abs(hi[2] - TOP) < 1e-3, 'its sides and top are the box’s own')
  check(lo[2] > H - 0.6 && lo[2] < H, `and it reaches down to the fracture, not past it (lowest ${lo[2].toFixed(3)} mm)`)
}

// ---- the break looked at again; trimmed with an offset, and the other side --------------
await click(page, '[data-test=trim-view-break]')
await sleep(300)
check(!(await ghosted()), 'Break shows the scan again, not ghosted')
check((await re(() => window.__scanruler.scene().paintedVertices().length)) === marked, 'the break still marked as it was')
await setField('[data-test=trim-offset]', 0.15)
check(Boolean(await page.$('[data-test=trim-stale]')), 'an offset changed says the piece on hand is from before it')
const offset = await trim()
const less = onBreak - offset
check(Math.abs(less - 0.14 * footprint) < 0.15 * 0.14 * footprint, `0.15 mm off the break takes a slice that thick off the piece (${less.toFixed(1)} mm³)`)
check(!(await page.$('[data-test=trim-stale]')), 'and it is up to date again')
await page.click('[data-test=trim-flip] input')
await sleep(200)
const other = await trim()
const below = footprint * (TOP - H + INTO) - kept - 0.15 * footprint
check(Math.abs(other - below) < 0.02 * below, `Keep the other side keeps what overlapped the block (${other} mm³ of ${below.toFixed(1)})`)
await page.screenshot({ path: shotPath('mesh-trim-other-side.png') })

// ---- Ctrl+Z steps the side back; Escape puts the tool away --------------------------------
await page.$eval('[data-test=trim-flip] input', (el) => el.blur())
await page.keyboard.down('Control')
await page.keyboard.press('KeyZ')
await page.keyboard.up('Control')
await sleep(400)
check(!(await page.$eval('[data-test=trim-flip] input', (el) => el.checked)), 'Ctrl+Z steps Keep the other side back')
check(Boolean(await page.$('[data-test=trim-stale]')), 'and the piece on hand says it is from other settings')
await page.keyboard.press('Escape')
await sleep(300)
check(!(await page.$('[data-test=trim-tool]')), 'Escape puts the tool away')

// ---- the parts list: the piece stays in view, each part shown and hidden by its eye ------
await page.waitForSelector('[data-test=mesh-parts]', { timeout: 10_000 })
check(Math.abs(number(await text('[data-test=part-piece] b')) - other) < 0.05, 'the parts list holds the piece made, its volume beside it')
check((await page.$$('[data-test=part-body]')).length === 1, 'and the box lent by Reverse engineer, hidden')
let d = await drawn()
check(d.scan && d.piece && d.bodies === 0 && (await ghosted()), 'the piece stays in view with the tool put away, over the scan ghosted')
await page.screenshot({ path: shotPath('mesh-trim-parts.png') })
await click(page, '[data-test=part-piece-visible]')
await sleep(200)
d = await drawn()
check(!d.piece && !(await ghosted()), 'its eye hides the piece, and the scan is solid again')
await click(page, '[data-test=part-scan-visible]')
await sleep(200)
check(!(await drawn()).scan, 'the scan’s eye puts the scan away')
await click(page, '[data-test=part-piece-visible]')
await click(page, '[data-test=part-body-visible]')
await sleep(500)
d = await drawn()
check(!d.scan && d.piece && d.bodies === 1, 'the piece alone, with the box it was cut of drawn over it')
await page.screenshot({ path: shotPath('mesh-trim-parts-body.png') })
await click(page, '[data-test=part-body-visible]')
await click(page, '[data-test=part-scan-visible]')
await sleep(300)
d = await drawn()
check(d.scan && d.piece && d.bodies === 0, 'and the box goes again, the scan back')
check(Boolean(await page.$('[data-test=parts-export-trimmed]:not([disabled])')), 'the piece can be exported from the list')
await click(page, '[data-test=mesh-tool-trim]')
await sleep(300)
check(Boolean(await page.$('.measure-project [data-test=mesh-parts]')) && Boolean(await page.$('.measure-context [data-test=trim-tool]')), 'opening Trim keeps the parts tree in Project and the active tool in context')

await finish(browser, consoleErrors)

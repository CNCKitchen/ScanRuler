// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end test for Use symmetry in the Align part box: drives the real app
// in headless Chrome — loads a 60 × 40 × 10 block lying at an odd angle, puts
// a pose on it that is a degree and a half askew and seven millimetres off the
// middle, presses Use symmetry, and checks that the proposal names the mirror
// plane it settled on and that, applied, the part lies evenly either side of
// that coordinate plane. Then the same key with nothing set up yet, which
// starts from Auto-align's pose.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node scripts/e2e-align-symmetry.mjs
// Env: CHROME (chrome.exe path), APP_URL.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, click, finish, launchApp, loadScan, sleep } from './e2e-lib.mjs'

// ---- the scan: a gridded block, turned and moved -----------------------------
const SIZE = [60, 40, 10]
const GRID = 24
const tris = []
for (let axis = 0; axis < 3; axis++) {
  for (const side of [-1, 1]) {
    const u = (axis + 1) % 3, v = (axis + 2) % 3
    const at = (i, j) => {
      const q = [0, 0, 0]
      q[axis] = (side * SIZE[axis]) / 2
      q[u] = (i / GRID - 0.5) * SIZE[u]
      q[v] = (j / GRID - 0.5) * SIZE[v]
      return q
    }
    for (let i = 0; i < GRID; i++)
      for (let j = 0; j < GRID; j++) {
        const quad = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]
        if (side > 0) tris.push(quad[0], quad[1], quad[2], quad[0], quad[2], quad[3])
        else tris.push(quad[0], quad[2], quad[1], quad[0], quad[3], quad[2])
      }
  }
}
// Rotation about (0.3, −0.5, 0.81) by 0.9 rad, then a move.
const k = [0.3, -0.5, 0.81].map((c) => c / Math.hypot(0.3, 0.5, 0.81))
const [c, s] = [Math.cos(0.9), Math.sin(0.9)]
const MOVE = [12, -7, 30]
const turn = (q) => {
  const d = k[0] * q[0] + k[1] * q[1] + k[2] * q[2]
  const x = [k[1] * q[2] - k[2] * q[1], k[2] * q[0] - k[0] * q[2], k[0] * q[1] - k[1] * q[0]]
  return [0, 1, 2].map((i) => q[i] * c + x[i] * s + k[i] * d * (1 - c))
}
const pose = (q) => turn(q).map((v, i) => v + MOVE[i])
const stl = Buffer.alloc(84 + (tris.length / 3) * 50)
stl.writeUInt32LE(tris.length / 3, 80)
for (let t = 0; t < tris.length / 3; t++)
  for (let corner = 0; corner < 3; corner++) {
    const q = pose(tris[t * 3 + corner])
    for (let i = 0; i < 3; i++) stl.writeFloatLE(q[i], 84 + t * 50 + 12 + corner * 12 + i * 4)
  }
const scanPath = join(mkdtempSync(join(tmpdir(), 'scanruler-align-symmetry-')), 'block.stl')
writeFileSync(scanPath, stl)

const { browser, page, consoleErrors } = await launchApp()
await loadScan(page, scanPath)

/** The scan's extent along each axis, as the viewport holds it. */
const bounds = () =>
  page.evaluate(() => {
    const p = window.__scanruler.scene().scanPositions()
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < p.length; i += 3) for (let a = 0; a < 3; a++) {
      if (p[i + a] < min[a]) min[a] = p[i + a]
      if (p[i + a] > max[a]) max[a] = p[i + a]
    }
    return { min, max }
  })

/** Press Use symmetry, read the proposal, apply it, and check the part lies
 *  evenly about the plane the proposal names. */
async function useSymmetry(label) {
  await click(page, '[data-test="align-symmetry"]')
  const settled = await page
    .waitForFunction(() => /^Settled on/.test(document.querySelector('[data-test="align-proposal"]')?.textContent ?? ''), { timeout: 120_000 })
    .then(() => true)
    .catch(() => false)
  check(settled, `${label}: the editor comes back with a pose settled on the mirror plane`)
  if (!settled) return null
  const note = await page.$eval('[data-test="align-proposal"]', (el) => el.textContent)
  console.log(`${label}:`, note)
  const named = /it is the (YZ|XZ|XY) plane now — ([XYZ]) turned ([\d.]+)° onto its normal, the zero point moved ([\d.]+) mm/.exec(note)
  check(named !== null, `${label}: the note names the plane, the turn and the move`)
  if (!named) return null
  await page.waitForSelector('[data-test="apply-alignment"]:not([disabled])', { timeout: 10_000 })
  await click(page, '[data-test="apply-alignment"]')
  await page.waitForFunction(() => window.__scanruler.measure.getState().alignDraft === null && !window.__scanruler.measure.getState().busy, { timeout: 60_000 })
  await sleep(500)
  const b = await bounds()
  const axis = 'XYZ'.indexOf(named[2])
  const uneven = Math.abs(b.min[axis] + b.max[axis])
  check(uneven < 0.02, `${label}: applied, the part lies evenly either side of the ${named[1]} plane (${b.min[axis].toFixed(3)} … ${b.max[axis].toFixed(3)})`)
  // The block's own faces are square to the axes again: its box is its size.
  const size = [0, 1, 2].map((a) => b.max[a] - b.min[a]).sort((p, q) => q - p)
  check(Math.abs(size[0] - 60) < 0.05 && Math.abs(size[1] - 40) < 0.05 && Math.abs(size[2] - 10) < 0.05, `${label}: and square to them — its box is ${size.map((v) => v.toFixed(2)).join(' × ')}`)
  return { tilt: Number(named[3]), shift: Number(named[4]), axis }
}

// ---- a pose askew and off the middle ---------------------------------------------------------------
// The block's own frame, turned a degree and a half about its Z and put seven
// millimetres along its X from the middle of its bottom face.
const a = (1.5 * Math.PI) / 180
const X = turn([Math.cos(a), Math.sin(a), 0])
const Y = turn([-Math.sin(a), Math.cos(a), 0])
const Z = turn([0, 0, 1])
const origin = pose([7, 0, -5])
const along = (p, d, t) => p.map((v, i) => v + d[i] * t)
const down = Z.map((v) => -v)
await click(page, '[data-test="start-alignment"]')
await page.evaluate(
  (proposal) => window.__scanruler.measure.getState().proposeAlignment(proposal, 'A pose set up by hand, askew.'),
  {
    primary: [0, 120, 240].map((deg) => along(along(origin, X, 12 * Math.cos((deg * Math.PI) / 180)), Y, 12 * Math.sin((deg * Math.PI) / 180))),
    primaryNormals: [down, down, down],
    secondary: [along(origin, X, -12), along(origin, X, 12)],
    origin,
  },
)
await page.waitForSelector('[data-test="apply-alignment"]:not([disabled])', { timeout: 10_000 })
const first = await useSymmetry('askew')
if (first) {
  // Whichever of the block's three mirror planes won, the pose was off it by
  // what it was put off by: a degree and a half for an upright one, nothing
  // for the flat one; seven millimetres for YZ, five — half the height — for XY.
  const want = first.axis === 2 ? { tilt: 0, shift: 5 } : first.axis === 0 ? { tilt: 1.5, shift: 7 * Math.cos(a) } : { tilt: 1.5, shift: 7 * Math.sin(a) }
  check(Math.abs(first.tilt - want.tilt) < 0.06 && Math.abs(first.shift - want.shift) < 0.06, `askew: the turn and the move are what the pose was off by (${first.tilt}° and ${first.shift} mm against ${want.tilt}° and ${want.shift.toFixed(2)} mm)`)
}

// ---- with nothing set up yet --------------------------------------------------------------------------
await click(page, '[data-test="reset-alignment"]')
await page.waitForFunction(() => window.__scanruler.measure.getState().appliedAlignment === null && !window.__scanruler.measure.getState().busy, { timeout: 60_000 })
await sleep(500)
await click(page, '[data-test="start-alignment"]')
await page.waitForSelector('[data-test="align-symmetry"]')
check(await page.$eval('[data-test="apply-alignment"]', (b) => b.disabled), 'an empty editor has no pose to apply')
await useSymmetry('empty')

await finish(browser, consoleErrors)

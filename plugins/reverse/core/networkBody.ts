// SPDX-License-Identifier: AGPL-3.0-only
// A patch network made a body (PN9).
//
// The kernel takes no control net: its bsplineSurface is a surface through
// a grid of points, within a micron of them (kernel.ts surfaceThrough). So
// each patch is sampled on a grid a few times finer than its net and that
// grid goes to the kernel, with Fit Surface's retries at denser grids and
// its check on the area. A shared curve's samples are the curve's own,
// taken once and handed to both patches either side of it — the same points
// on both grids — so the two faces' edges lie within the kernel's micron of
// each other along it, and sew. The faces are sewn without being unified:
// each patch stays one face, traced back to its cell. A network that closes
// sews into a solid; an open one into a sheet. The edges left open must be
// the network's own outer boundary; one that lies along a shared curve is
// named, with the gap the faces left there.

import type { Vec3 } from '../../../src/core/types'
import type { Shape, ReKernel } from './kernel'
import type { KernelMesh } from './kernelTypes'
import type { CellOutcome, NetworkReading } from './network'
import type { FittedPatch, NetworkFitResult } from './networkFit'
import { curvePoint, patchPoint } from './networkSpline'
import { GRID_AREA_SLACK, GRID_RETRIES, gridArea } from './surfaceFit'
import { meshDeflection, diagonalOf } from './buildTypes'

/** Grid samples per net span; denser on a retry (surfaceFit GRID_RETRIES). */
const GRID_PER_SPAN = 3
/** The ghost's samples a patch side at the fewest: a net of a few spans at
 *  three samples a span — 25 across a sixth of a sphere — meshed it 0.1 %
 *  short of the solid made of the same patches. */
const GHOST_SIDE = 48
/** The sewing tolerance, mm: the grid route's edges lie within the
 *  kernel's micron of each other, and sewing at a thousandth of a
 *  millimetre has taken them; more where the gaps read more. */
const SEW_TOLERANCE = 1e-3
/** How many points along each shared curve its gap is read at. */
const GAP_SAMPLES = 8
/** A patch's samples a side in its report. */
export const PATCH_GRID = 9

/** A network's reading of itself, as its feature's row and an agent read
 *  it. */
export interface NetworkReport {
  /** Each patch: how it sits on its points, its net, the curves of its
   *  four sides and its corners' nodes, and the patch sampled PATCH_GRID ×
   *  PATCH_GRID — what the viewport picks and outlines it by. */
  patches: { seed: Vec3; rms: number; max: number; misfit: number; net: { u: number; v: number }; points: number; worst: { at: Vec3; off: number }[]; dropped?: number; sides: number[][]; corners: number[]; grid: Float32Array }[]
  cells: CellOutcome[]
  /** Closed regions of three to six sides no seed fills — Fill all's. */
  unfilled: { seed: Vec3; sides: number }[]
  /** Each shared curve: the gap between the two faces along it (mm, as
   *  the kernel's faces lie — on the ghost, which makes none, as the
   *  patches do), and the largest angle between the patches' normals
   *  along it (deg). */
  curves: { curve: number; gap: number; angle: number; crease: boolean }[]
  corners: { node: number; at: Vec3; patches: number; angle: number }[]
  strips: { spans: number; auto: boolean; curves: number[] }[]
  /** Curves left out: a node gone, a trace empty. */
  lost: number[]
  /** The cells split from their centres: each spoke's path, and each
   *  centre, by the feature's cell — what the viewport draws and drags. */
  spokes: { cell: number; points: Float32Array }[]
  centres: { cell: number; at: Vec3 }[]
  /** Each patch side beside a body's face: the angle to the face along it
   *  (deg) and the curve's stand-off from the body's edge (mm). */
  bodies: { curve: number; patch: number; mode: 'contact' | 'tangent'; angle: number; gap: number }[]
  closed: boolean
  /** The worst angle across a tangent curve and the worst gap. */
  worstAngle: number
  worstGap: number
  ms: { trace: number; cells: number; map: number; fit: number; faces: number }
}

/** The report of a reading with no body: its cells and — where the
 *  patches were fitted and the body could not be made of them — the fit's
 *  own readings, the gaps the patches' (none the kernel's faces'). */
export function emptyReport(reading: NetworkReading): NetworkReport {
  const fit = reading.fit
  if (!fit) return { patches: [], cells: reading.outcomes, unfilled: reading.cells.unfilled, curves: [], corners: [], strips: [], lost: reading.traced.lost, ...splitOf(reading), bodies: [], closed: false, worstAngle: 0, worstGap: 0, ms: { ...reading.ms, faces: 0 } }
  const curves = fit.shared.map((s) => ({ curve: s.curve, gap: s.gap, angle: s.angle, crease: s.crease }))
  return {
    patches: fit.patches.map((p) => ({ seed: p.seed, rms: p.rms, max: p.max, misfit: p.misfit, net: { u: p.net.nu, v: p.net.nv }, points: p.points, worst: p.worst, ...(p.dropped !== undefined ? { dropped: p.dropped } : {}), sides: p.sides.map((s) => s.edges.map((h) => h.curve)), corners: p.corners, grid: sampled(p) })),
    cells: reading.outcomes,
    unfilled: reading.cells.unfilled,
    curves,
    corners: fit.corners,
    strips: fit.strips,
    lost: reading.traced.lost,
    ...splitOf(reading),
    bodies: fit.bodies,
    closed: false,
    worstAngle: curves.filter((s) => !s.crease).reduce((m, s) => Math.max(m, s.angle), 0),
    worstGap: curves.reduce((m, s) => Math.max(m, s.gap), 0),
    ms: { ...reading.ms, faces: 0 },
  }
}

/** A reading's spokes and centres for its report. */
function splitOf(reading: NetworkReading): Pick<NetworkReport, 'spokes' | 'centres'> {
  return { spokes: (reading.split?.spokes ?? []).map((s) => ({ cell: s.cell, points: s.points })), centres: reading.split?.centres ?? [] }
}

/** A patch's grid for the kernel: `perSpan` samples a span — more, to make
 *  `fewest` a side at least, by its span count alone, so two patches either
 *  side of a curve still take the same samples on it — row-major with u
 *  along the rows, its boundary rows the shared samples of its sides. */
function patchGrid(patch: FittedPatch, perSpan: number, sideSamples: (k: number, count: number) => Float64Array, fewest = 0): { points: Float64Array; rows: number; cols: number } {
  const { nu, nv } = patch.net
  const rows = nu * Math.max(perSpan, Math.ceil(fewest / nu)) + 1
  const cols = nv * Math.max(perSpan, Math.ceil(fewest / nv)) + 1
  const points = new Float64Array(rows * cols * 3)
  const q: Vec3 = [0, 0, 0]
  for (let i = 1; i < rows - 1; i++) {
    for (let j = 1; j < cols - 1; j++) {
      patchPoint(patch.net, i / (rows - 1), j / (cols - 1), q)
      points.set(q, (i * cols + j) * 3)
    }
  }
  // Side 0 runs along v = 0 from u = 0, side 1 along u = 1 from v = 0,
  // side 2 along v = 1 from u = 1, side 3 along u = 0 from v = 1.
  const s0 = sideSamples(0, rows)
  const s1 = sideSamples(1, cols)
  const s2 = sideSamples(2, rows)
  const s3 = sideSamples(3, cols)
  for (let i = 0; i < rows; i++) {
    points.set(s0.subarray(i * 3, i * 3 + 3), (i * cols + 0) * 3)
    points.set(s2.subarray((rows - 1 - i) * 3, (rows - i) * 3), (i * cols + cols - 1) * 3)
  }
  for (let j = 0; j < cols; j++) {
    points.set(s1.subarray(j * 3, j * 3 + 3), ((rows - 1) * cols + j) * 3)
    points.set(s3.subarray((cols - 1 - j) * 3, (cols - j) * 3), (0 * cols + j) * 3)
  }
  return { points, rows, cols }
}

/** Each patch's side samples at a count: a curve sampled once at each
 *  count, forwards, and a side backwards on it given the samples in the
 *  other order — the same points on both grids either side of it. */
function sideSampler(fit: NetworkFitResult): (patch: FittedPatch) => (k: number, count: number) => Float64Array {
  const samples = new Map<string, Float64Array>()
  const curveSamples = (curve: number, count: number): Float64Array => {
    const key = `${curve}:${count}`
    let s = samples.get(key)
    if (!s) {
      const f = fit.curves.get(curve)!
      s = new Float64Array(count * 3)
      const q: Vec3 = [0, 0, 0]
      for (let i = 0; i < count; i++) {
        curvePoint(f.poles, f.spans, i / (count - 1), q)
        s.set(q, i * 3)
      }
      samples.set(key, s)
    }
    return s
  }
  const sideSamplesOf = (patch: FittedPatch) => (k2: number, count: number): Float64Array => {
    const side = patch.sides[k2]
    if (side.single) {
      const s = curveSamples(side.edges[0].curve, count)
      if (side.edges[0].forward) return s
      const out = new Float64Array(s.length)
      for (let i = 0; i < count; i++) out.set(s.subarray((count - 1 - i) * 3, (count - i) * 3), i * 3)
      return out
    }
    // A side of more than one curve — a T-junction's — has a row of its
    // own; its neighbours' edges are not its samples.
    const spans = k2 % 2 === 0 ? patch.net.nu : patch.net.nv
    const out = new Float64Array(count * 3)
    const q: Vec3 = [0, 0, 0]
    for (let i = 0; i < count; i++) {
      curvePoint(side.poles, spans, i / (count - 1), q)
      out.set(q, i * 3)
    }
    return out
  }
  return sideSamplesOf
}

/** The network's faces sewn into a body, and its report — or why not. */
/** Whether a network closes: every curve round every patch shared by two.
 *  Counted by curve, not by side: a T-junction's side is one side of
 *  several curves, each shared, and counted by side a closed network with a
 *  T in it never closed — it was sewn as a sheet with no volume (issue 34). */
export function networkCloses(fit: Pick<NetworkFitResult, 'patches' | 'shared'>): boolean {
  const uses = fit.patches.reduce((n, p) => n + p.sides.reduce((m, side) => m + side.edges.length, 0), 0)
  return fit.shared.length * 2 === uses
}

export function networkBody(k: ReKernel, reading: NetworkReading): { shape: Shape; report: NetworkReport; faceOf: Map<number, number> } {
  const fit = reading.fit as NetworkFitResult
  const began = performance.now()
  const sideSamplesOf = sideSampler(fit)
  const faces: Shape[] = []
  try {
    for (const patch of fit.patches) {
      let made: Shape | null = null
      let off = 0
      for (const perSpan of [GRID_PER_SPAN, ...GRID_RETRIES]) {
        const grid = patchGrid(patch, perSpan, sideSamplesOf(patch))
        const face = k.surfaceThrough(grid.points, grid.rows, grid.cols)
        off = k.surfaceArea(face) / gridArea(grid)
        if (!(off > GRID_AREA_SLACK)) {
          made = face
          break
        }
        k.release(face)
      }
      if (!made) throw new Error(`The kernel's surface through the patch at ${where(patch.seed)} does not follow it: ${off > 100 ? `${Math.round(off)} times` : `${Math.round((off - 1) * 100)} % more than`} its area at every grid it was given. Give its strips fewer spans.`)
      faces.push(made)
    }
    // The gaps along the shared curves, as the kernel's faces lie: a point
    // of the curve between two grid samples, its distance from each face.
    const shared = fit.shared.map((s) => {
      const f = fit.curves.get(s.curve)!
      let gap = 0
      const q: Vec3 = [0, 0, 0]
      for (let i = 0; i < GAP_SAMPLES; i++) {
        curvePoint(f.poles, f.spans, (i + 0.5) / GAP_SAMPLES, q)
        gap = Math.max(gap, k.distanceToPoint(faces[s.patches[0]], q) + k.distanceToPoint(faces[s.patches[1]], q))
      }
      return { curve: s.curve, gap: Math.max(gap, s.gap), angle: s.angle, crease: s.crease }
    })
    const worstGap = shared.reduce((m, s) => Math.max(m, s.gap), 0)
    const closed = networkCloses(fit)
    const tolerance = Math.max(SEW_TOLERANCE, 2 * worstGap)
    let shape = faces.length === 1 ? k.copy(faces[0]) : k.sewPatches(faces, tolerance, closed)
    if (closed && !k.isClosedSolid(shape)) {
      k.release(shape)
      shape = k.sewPatches(faces, tolerance, false)
    }
    const solid = closed && k.isClosedSolid(shape)
    // The edges left open: the outer boundary's, and any along a shared
    // curve, which did not sew.
    const open = k.edges(shape, meshDeflection(diagonalOf(k, shape))).filter((e) => e.faceHashes.length < 2)
    const notSewn = new Set<number>()
    for (const e of open) {
      for (const s of fit.shared) {
        const f = fit.curves.get(s.curve)!
        const q: Vec3 = [0, 0, 0]
        let near = Infinity
        for (let i = 0; i <= 16; i++) {
          curvePoint(f.poles, f.spans, i / 16, q)
          near = Math.min(near, Math.hypot(q[0] - e.mid[0], q[1] - e.mid[1], q[2] - e.mid[2]))
        }
        if (near < 10 * tolerance + 1e-6) notSewn.add(s.curve)
      }
    }
    if (notSewn.size > 0) {
      k.release(shape)
      const named = [...notSewn].map((c) => `curve ${c} (gap ${(shared.find((s) => s.curve === c)!.gap * 1000).toFixed(1)} µm)`).join(', ')
      throw new Error(`The patches did not sew along ${named} — their faces stand apart there; give the strip across it more spans, or draw the curve again.`)
    }
    // Each face of the body to its patch, by where its middle is.
    // Sewing keeps each face on its own surface, so the middle of a face's
    // parameter box is where its patch's is.
    const middles = faces.map((f) => k.facePoints(f)[0]?.at ?? ([0, 0, 0] as Vec3))
    const faceOf = new Map<number, number>()
    for (const f of k.facePoints(shape)) {
      let best = 0
      let bestD = Infinity
      middles.forEach((m, i) => {
        const d = Math.hypot(m[0] - f.at[0], m[1] - f.at[1], m[2] - f.at[2])
        if (d < bestD) [bestD, best] = [d, i]
      })
      faceOf.set(f.hash, best)
    }
    const report: NetworkReport = {
      patches: fit.patches.map((p) => ({ seed: p.seed, rms: p.rms, max: p.max, misfit: p.misfit, net: { u: p.net.nu, v: p.net.nv }, points: p.points, worst: p.worst, ...(p.dropped !== undefined ? { dropped: p.dropped } : {}), sides: p.sides.map((s) => s.edges.map((h) => h.curve)), corners: p.corners, grid: sampled(p) })),
      cells: reading.outcomes,
      unfilled: reading.cells.unfilled,
      curves: shared,
      corners: fit.corners,
      strips: fit.strips,
      lost: reading.traced.lost,
      ...splitOf(reading),
      bodies: fit.bodies,
      closed: solid,
      worstAngle: shared.filter((s) => !s.crease).reduce((m, s) => Math.max(m, s.angle), 0),
      worstGap,
      ms: { ...reading.ms, faces: performance.now() - began },
    }
    return { shape, report, faceOf }
  } finally {
    k.release(...faces)
  }
}

/** A network's ghost while it is being drawn: each patch meshed from its
 *  own grid, without the kernel — no faces made, none sewn — and the
 *  report of the fit, the gaps the patches' own. The grids are the ones
 *  the faces are made of, a shared curve's samples on both sides of it,
 *  so the mesh closes where the network does and its volume is read off
 *  it. Making and sewing the faces was most of a preview's time; Create
 *  makes them, and says there what they come to. */
export function networkGhost(reading: NetworkReading): { mesh: KernelMesh; report: NetworkReport; volume: number } {
  const fit = reading.fit as NetworkFitResult
  const began = performance.now()
  const sideSamplesOf = sideSampler(fit)
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  const q: Vec3 = [0, 0, 0]
  const du: Vec3 = [0, 0, 0]
  const dv: Vec3 = [0, 0, 0]
  for (const patch of fit.patches) {
    const grid = patchGrid(patch, GRID_PER_SPAN, sideSamplesOf(patch), GHOST_SIDE)
    const base = positions.length / 3
    for (let i = 0; i < grid.rows; i++) {
      for (let j = 0; j < grid.cols; j++) {
        const at = (i * grid.cols + j) * 3
        positions.push(grid.points[at], grid.points[at + 1], grid.points[at + 2])
        patchPoint(patch.net, i / (grid.rows - 1), j / (grid.cols - 1), q, du, dv)
        const n: Vec3 = [du[1] * dv[2] - du[2] * dv[1], du[2] * dv[0] - du[0] * dv[2], du[0] * dv[1] - du[1] * dv[0]]
        const l = Math.hypot(n[0], n[1], n[2]) || 1
        normals.push(n[0] / l, n[1] / l, n[2] / l)
      }
    }
    for (let i = 0; i + 1 < grid.rows; i++) {
      for (let j = 0; j + 1 < grid.cols; j++) {
        const a = base + i * grid.cols + j
        const b = a + grid.cols
        indices.push(a, b, b + 1, a, b + 1, a + 1)
      }
    }
  }
  // Closed: every side of every patch shared, as the body would be.
  const sides = fit.patches.reduce((n, p) => n + p.sides.length, 0)
  const closed = fit.shared.length * 2 === sides
  let volume = 0
  if (closed) {
    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3
      const p = positions
      volume += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) + p[a + 1] * (p[b + 2] * p[c] - p[b] * p[c + 2]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6
    }
  }
  const report = emptyReport(reading)
  return {
    mesh: { positions: Float32Array.from(positions), normals: Float32Array.from(normals), indices: Uint32Array.from(indices) },
    report: { ...report, closed, ms: { ...report.ms, faces: performance.now() - began } },
    volume: Math.abs(volume),
  }
}

/** A patch sampled PATCH_GRID × PATCH_GRID, row-major along u. */
function sampled(p: FittedPatch): Float32Array {
  const out = new Float32Array(PATCH_GRID * PATCH_GRID * 3)
  const q: Vec3 = [0, 0, 0]
  for (let i = 0; i < PATCH_GRID; i++) {
    for (let j = 0; j < PATCH_GRID; j++) {
      patchPoint(p.net, i / (PATCH_GRID - 1), j / (PATCH_GRID - 1), q)
      out.set(q, (i * PATCH_GRID + j) * 3)
    }
  }
  return out
}

function where(p: Vec3): string {
  return `(${p.map((x) => x.toFixed(1)).join(', ')})`
}

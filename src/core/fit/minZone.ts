// SPDX-License-Identifier: AGPL-3.0-only
// The minimum zone a form tolerance is judged by (ISO 1101): the narrowest
// pair of parallel planes, concentric spheres or coaxial cylinders that
// holds every point. The least-squares fit the elements carry is a good
// start but not that zone: its peak-to-peak residual is never smaller, and
// on a face with a raised corner or a bore with a flat it can be a good deal
// larger, enough to fail a part that is in tolerance.
//
// The zone is found by moving the fit — a plane's tilt, a sphere's centre, a
// cylinder's axis — to make the residuals' range as small as it goes. The
// range is a maximum of the points' residuals, so it has corners, and a
// downhill simplex (Nelder–Mead), restarted from where it stopped, is used
// for it rather than anything that wants a gradient. It starts at the fit,
// so the zone is never wider than the fit's own peak-to-peak.
//
// Only the points at the edges of the zone decide it. The search works on
// the few hundred furthest out on each side, then checks the zone against
// every point and takes in any that stick out, until none does.

import type { Vec3 } from '../types'
import { orthoBasis } from './linalg'

export type ZoneShape =
  | { kind: 'plane'; center: Vec3; normal: Vec3 }
  /** A circle in the plane through `center` square to `normal`: the zone is
   *  two concentric circles in that plane, the points read in it. */
  | { kind: 'circle'; center: Vec3; normal: Vec3 }
  | { kind: 'sphere'; center: Vec3 }
  | { kind: 'cylinder'; center: Vec3; axis: Vec3 }

export interface MinimumZone {
  /** The width of the zone: the planes' distance apart, the spheres' or
   *  cylinders' difference in radius. */
  width: number
  /** The peak-to-peak residual about the shape as given — what the zone
   *  narrows. */
  start: number
}

/** Points taken from each side of the zone into the working set, per round. */
const EDGE_POINTS = 256
const MAX_ROUNDS = 12

/** A shape's residuals given its parameters, as offsets from where it was
 *  given: written into `out` for the points `idx` names. */
type Residuals = (params: Float64Array, idx: Uint32Array, out: Float64Array) => void

/**
 * The minimum zone of `points` (packed x y z) about `shape`, the fit they
 * were measured with. Null with fewer than four points.
 */
export function minimumZone(points: Float32Array | Float64Array, shape: ZoneShape): MinimumZone | null {
  const n = Math.floor(points.length / 3)
  if (n < 4) return null
  // About the shape's centre, in doubles: the residuals are differences far
  // smaller than the coordinates.
  const c = shape.center
  const p = new Float64Array(n * 3)
  let reach = 0
  for (let i = 0; i < n; i++) {
    const x = points[i * 3] - c[0]
    const y = points[i * 3 + 1] - c[1]
    const z = points[i * 3 + 2] - c[2]
    p[i * 3] = x
    p[i * 3 + 1] = y
    p[i * 3 + 2] = z
    reach = Math.max(reach, Math.hypot(x, y, z))
  }
  const { dims, residuals } = model(shape, p)
  const all = new Uint32Array(n)
  for (let i = 0; i < n; i++) all[i] = i
  const res = new Float64Array(n)
  const x = new Float64Array(dims)
  residuals(x, all, res)
  const start = range(res, n)
  if (!(start > 0) || !(reach > 0)) return { width: Math.max(start, 0), start: Math.max(start, 0) }

  // Initial steps: a tilt that moves the far points by about the width, an
  // offset of about the width.
  const steps = new Float64Array(dims)
  // The plane's and the cylinder's first two parameters are tilts.
  const tilts = shape.kind === 'plane' ? 2 : shape.kind === 'cylinder' ? 2 : 0
  for (let d = 0; d < dims; d++) steps[d] = d < tilts ? start / reach : start

  let set = edges(res, n, new Set<number>())
  let best = start
  const work = new Float64Array(n)
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const idx = Uint32Array.from(set)
    const sub = new Float64Array(idx.length)
    const f = (params: Float64Array): number => {
      residuals(params, idx, sub)
      return range(sub, idx.length)
    }
    const found = descend(f, x, steps)
    residuals(found, all, work)
    const width = range(work, n)
    if (width < best) {
      best = width
      x.set(found)
    }
    // Every point inside the zone the working set gives: settled.
    if (width <= f(found) * (1 + 1e-9) + 1e-15) break
    const grown = edges(work, n, set)
    if (grown.size === set.size) break
    set = grown
  }
  return { width: best, start }
}

/** Max minus min of the first `n` values. */
function range(r: Float64Array, n: number): number {
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < n; i++) {
    const v = r[i]
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  return hi - lo
}

/** `set` with the EDGE_POINTS highest and lowest residuals added. */
function edges(r: Float64Array, n: number, set: Set<number>): Set<number> {
  const out = new Set(set)
  const k = Math.min(EDGE_POINTS, n)
  const sorted = Float64Array.from(r.subarray(0, n)).sort()
  const low = sorted[k - 1]
  const high = sorted[n - k]
  for (let i = 0; i < n; i++) if (r[i] <= low || r[i] >= high) out.add(i)
  return out
}

function model(shape: ZoneShape, p: Float64Array): { dims: number; residuals: Residuals } {
  if (shape.kind === 'sphere') {
    return {
      dims: 3,
      residuals: (x, idx, out) => {
        for (let k = 0; k < idx.length; k++) {
          const i = idx[k] * 3
          out[k] = Math.hypot(p[i] - x[0], p[i + 1] - x[1], p[i + 2] - x[2])
        }
      },
    }
  }
  if (shape.kind === 'circle') {
    const nrm = shape.normal
    const [u, v] = orthoBasis(nrm)
    return {
      dims: 2,
      residuals: (x, idx, out) => {
        const ox = x[0] * u[0] + x[1] * v[0]
        const oy = x[0] * u[1] + x[1] * v[1]
        const oz = x[0] * u[2] + x[1] * v[2]
        for (let k = 0; k < idx.length; k++) {
          const i = idx[k] * 3
          const qx = p[i] - ox
          const qy = p[i + 1] - oy
          const qz = p[i + 2] - oz
          const t = qx * nrm[0] + qy * nrm[1] + qz * nrm[2]
          out[k] = Math.hypot(qx - t * nrm[0], qy - t * nrm[1], qz - t * nrm[2])
        }
      },
    }
  }
  if (shape.kind === 'plane') {
    const nrm = shape.normal
    const [u, v] = orthoBasis(nrm)
    return {
      dims: 2,
      residuals: (x, idx, out) => {
        let nx = nrm[0] + x[0] * u[0] + x[1] * v[0]
        let ny = nrm[1] + x[0] * u[1] + x[1] * v[1]
        let nz = nrm[2] + x[0] * u[2] + x[1] * v[2]
        const l = Math.hypot(nx, ny, nz)
        nx /= l
        ny /= l
        nz /= l
        for (let k = 0; k < idx.length; k++) {
          const i = idx[k] * 3
          out[k] = p[i] * nx + p[i + 1] * ny + p[i + 2] * nz
        }
      },
    }
  }
  const ax = shape.axis
  const [u, v] = orthoBasis(ax)
  return {
    // The axis's tilt, two ways, and its offset across itself, two ways.
    dims: 4,
    residuals: (x, idx, out) => {
      let dx = ax[0] + x[0] * u[0] + x[1] * v[0]
      let dy = ax[1] + x[0] * u[1] + x[1] * v[1]
      let dz = ax[2] + x[0] * u[2] + x[1] * v[2]
      const l = Math.hypot(dx, dy, dz)
      dx /= l
      dy /= l
      dz /= l
      const ox = x[2] * u[0] + x[3] * v[0]
      const oy = x[2] * u[1] + x[3] * v[1]
      const oz = x[2] * u[2] + x[3] * v[2]
      for (let k = 0; k < idx.length; k++) {
        const i = idx[k] * 3
        const qx = p[i] - ox
        const qy = p[i + 1] - oy
        const qz = p[i + 2] - oz
        const t = qx * dx + qy * dy + qz * dz
        out[k] = Math.hypot(qx - t * dx, qy - t * dy, qz - t * dz)
      }
    },
  }
}

/**
 * Downhill simplex from `x0`, restarted from its best point with steps
 * halved until a restart no longer helps — a simplex can collapse on one of
 * the range's corners short of the bottom, and a fresh one gets past it.
 */
function descend(f: (x: Float64Array) => number, x0: Float64Array, steps0: Float64Array): Float64Array {
  let x: Float64Array = Float64Array.from(x0)
  let fx = f(x)
  const steps = Float64Array.from(steps0)
  for (let restart = 0; restart < 8; restart++) {
    const [y, fy] = simplex(f, x, steps)
    const better = fy < fx * (1 - 1e-7)
    if (fy < fx) {
      x = y
      fx = fy
    }
    if (!better && restart > 0) break
    for (let d = 0; d < steps.length; d++) steps[d] *= 0.5
  }
  return x
}

/** One Nelder–Mead run, with the coefficients scaled to the dimension
 *  (Gao and Han, 2012). */
function simplex(f: (x: Float64Array) => number, x0: Float64Array, steps: Float64Array): [Float64Array, number] {
  const d = x0.length
  const alpha = 1
  const beta = 1 + 2 / d
  const gamma = 0.75 - 1 / (2 * d)
  const delta = 1 - 1 / d
  const pts: Float64Array[] = [Float64Array.from(x0)]
  for (let i = 0; i < d; i++) {
    const q = Float64Array.from(x0)
    q[i] += steps[i]
    pts.push(q)
  }
  const fs = pts.map(f)
  const order = pts.map((_, i) => i)
  const mid = new Float64Array(d)
  const at = (t: number, worst: Float64Array): Float64Array => {
    const q = new Float64Array(d)
    for (let i = 0; i < d; i++) q[i] = mid[i] + t * (worst[i] - mid[i])
    return q
  }
  for (let iter = 0; iter < 200 * d; iter++) {
    order.sort((a, b) => fs[a] - fs[b])
    const best = order[0]
    const worst = order[d]
    const second = order[d - 1]
    if (fs[worst] - fs[best] <= 1e-12 * Math.max(fs[best], 1e-12)) break
    mid.fill(0)
    for (let k = 0; k < d; k++) {
      const q = pts[order[k]]
      for (let i = 0; i < d; i++) mid[i] += q[i] / d
    }
    const r = at(-alpha, pts[worst])
    const fr = f(r)
    if (fr < fs[best]) {
      const e = at(-alpha * beta, pts[worst])
      const fe = f(e)
      if (fe < fr) {
        pts[worst] = e
        fs[worst] = fe
      } else {
        pts[worst] = r
        fs[worst] = fr
      }
      continue
    }
    if (fr < fs[second]) {
      pts[worst] = r
      fs[worst] = fr
      continue
    }
    const outside = fr < fs[worst]
    const cpt = at(outside ? -alpha * gamma : gamma, pts[worst])
    const fc = f(cpt)
    if (fc < (outside ? fr : fs[worst])) {
      pts[worst] = cpt
      fs[worst] = fc
      continue
    }
    const b = pts[best]
    for (const k of order.slice(1)) {
      const q = pts[k]
      for (let i = 0; i < d; i++) q[i] = b[i] + delta * (q[i] - b[i])
      fs[k] = f(q)
    }
  }
  let bi = 0
  for (let i = 1; i <= d; i++) if (fs[i] < fs[bi]) bi = i
  return [pts[bi], fs[bi]]
}

// SPDX-License-Identifier: AGPL-3.0-only
// The torus: a tube of radius r round a circle of radius R — a fillet's
// round, a bend, an O-ring seat. What a fillet-shaped region of a scan is,
// once the plane, cylinder, cone and sphere are ruled out.
//
// The estimate rests on one fact about a torus: every surface normal passes
// through the spine circle, a tube radius away. So for the right r the
// points moved inward along their normals by r all lie on that circle, and
// a circle through them gives the axis, the centre and R at once. The tube
// radius is one unknown, searched over a range of scales, each candidate
// scored by the median torus residual (LMedS, as the other shapes are) —
// convex tubes and concave fillets alike, since a fillet's spine lies the
// other way along the normals and the search tries both signs. Damped
// Gauss–Newton over all seven parameters polishes the winner, the axis
// direction stepped by two tilt angles so it never leaves the unit sphere,
// as the cone's is.

import type { Torus, Vec3 } from '../types'
import { fitCircle2d } from './circle2d'
import { clippedRefit, type ClippedRefit } from './clip'
import { orthoBasis, solveLinear, symmetricEigen3 } from './linalg'
import { ransacConsensus } from './ransac'

/** The signed distance from the torus surface: positive outside the tube. */
export function torusResidual(t: Torus, x: number, y: number, z: number): number {
  const dx = x - t.cx, dy = y - t.cy, dz = z - t.cz
  const a = dx * t.ax + dy * t.ay + dz * t.az
  const rx = dx - a * t.ax, ry = dy - a * t.ay, rz = dz - a * t.az
  const rho = Math.sqrt(rx * rx + ry * ry + rz * rz)
  // On the axis the nearest spine point is any of them; the distance to
  // the tube is still well defined.
  return Math.sqrt((rho - t.R) ** 2 + a * a) - t.r
}

/** |cos| between a vertex normal and the torus's surface normal at the
 *  point — the direction from the nearest spine point. */
export function torusNormalAlign(t: Torus, x: number, y: number, z: number, nx: number, ny: number, nz: number): number {
  const dx = x - t.cx, dy = y - t.cy, dz = z - t.cz
  const a = dx * t.ax + dy * t.ay + dz * t.az
  let rx = dx - a * t.ax, ry = dy - a * t.ay, rz = dz - a * t.az
  const rho = Math.sqrt(rx * rx + ry * ry + rz * rz)
  if (rho < 1e-12) return 0
  rx /= rho
  ry /= rho
  rz /= rho
  // From the spine point to the surface point.
  const sx = dx - t.R * rx, sy = dy - t.R * ry, sz = dz - t.R * rz
  const len = Math.sqrt(sx * sx + sy * sy + sz * sz)
  if (len < 1e-12) return 0
  return Math.abs((sx * nx + sy * ny + sz * nz) / len)
}

function rms(positions: Float32Array, idx: ArrayLike<number>, t: Torus): number {
  let s = 0
  let m = 0
  for (let i = 0; i < idx.length; i++) {
    const j = idx[i] * 3
    const e = torusResidual(t, positions[j], positions[j + 1], positions[j + 2])
    if (!Number.isFinite(e)) continue
    s += e * e
    m++
  }
  return m ? Math.sqrt(s / m) : Infinity
}

/** The torus whose spine passes through the points moved `shift` along
 *  their normals — a circle fitted through them: the total-least-squares
 *  plane, then the 2D circle in it. Null when they do not make a circle
 *  (a straight tube, or too few). `shift` is signed: negative for a
 *  concave tube, whose spine lies against the normals. */
export function torusFromShift(positions: Float32Array, normals: Float32Array, idx: ArrayLike<number>, shift: number): Torus | null {
  const n = idx.length
  if (n < 4) return null
  const sx = new Float64Array(n), sy = new Float64Array(n), sz = new Float64Array(n)
  let mx = 0, my = 0, mz = 0
  for (let i = 0; i < n; i++) {
    const j = idx[i] * 3
    sx[i] = positions[j] - shift * normals[j]
    sy[i] = positions[j + 1] - shift * normals[j + 1]
    sz[i] = positions[j + 2] - shift * normals[j + 2]
    mx += sx[i]
    my += sy[i]
    mz += sz[i]
  }
  mx /= n
  my /= n
  mz /= n
  let cxx = 0, cxy = 0, cxz = 0, cyy = 0, cyz = 0, czz = 0
  for (let i = 0; i < n; i++) {
    const x = sx[i] - mx, y = sy[i] - my, z = sz[i] - mz
    cxx += x * x
    cxy += x * y
    cxz += x * z
    cyy += y * y
    cyz += y * z
    czz += z * z
  }
  const { values, vectors } = symmetricEigen3([cxx, cxy, cxz, cxy, cyy, cyz, cxz, cyz, czz])
  if (!(values[1] > 1e-9 * Math.max(values[2], 1e-12))) return null
  const axis = vectors[0]
  const [u, v] = orthoBasis(axis)
  const pu = new Float64Array(n), pv = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const x = sx[i] - mx, y = sy[i] - my, z = sz[i] - mz
    pu[i] = x * u[0] + y * u[1] + z * u[2]
    pv[i] = x * v[0] + y * v[1] + z * v[2]
  }
  const c = fitCircle2d(pu, pv)
  if (!c || !(c.r > 0) || !Number.isFinite(c.r)) return null
  const r = Math.abs(shift)
  return {
    cx: mx + c.cu * u[0] + c.cv * v[0],
    cy: my + c.cu * u[1] + c.cv * v[1],
    cz: mz + c.cu * u[2] + c.cv * v[2],
    ax: axis[0],
    ay: axis[1],
    az: axis[2],
    R: c.r,
    r,
  }
}

/** Geometric refinement of all seven parameters by damped Gauss–Newton with
 *  a numerical Jacobian: the centre, two tilts of the axis in the plane
 *  square to it, R and r. */
export function refineTorusGeometric(positions: Float32Array, idx: ArrayLike<number>, init: Torus, maxIter = 40): Torus {
  const n = idx.length
  if (n < 8) return init
  let t: Torus = { ...init }
  let cost = rms(positions, idx, t)
  if (!Number.isFinite(cost)) return init
  let lambda = 1e-6
  const P = 7
  const apply = (base: Torus, p: Float64Array): Torus => {
    const [u, v] = orthoBasis([base.ax, base.ay, base.az])
    let ax = base.ax + p[3] * u[0] + p[4] * v[0]
    let ay = base.ay + p[3] * u[1] + p[4] * v[1]
    let az = base.az + p[3] * u[2] + p[4] * v[2]
    const len = Math.hypot(ax, ay, az) || 1
    ax /= len
    ay /= len
    az /= len
    return { cx: base.cx + p[0], cy: base.cy + p[1], cz: base.cz + p[2], ax, ay, az, R: base.R + p[5], r: base.r + p[6] }
  }
  const scale = Math.max(t.R, t.r, 1e-3)
  for (let iter = 0; iter < maxIter; iter++) {
    const jtj = new Float64Array(P * P)
    const jtf = new Float64Array(P)
    const row = new Float64Array(P)
    const h = 1e-6 * scale
    const step = new Float64Array(P)
    // The Jacobian by central differences, parameter by parameter, over
    // every point: seven perturbed models per iteration.
    const plus: Torus[] = []
    const minus: Torus[] = []
    for (let a = 0; a < P; a++) {
      step.fill(0)
      step[a] = a >= 3 && a <= 4 ? h / scale : h
      plus.push(apply(t, step))
      step[a] = -step[a]
      minus.push(apply(t, step))
    }
    for (let i = 0; i < n; i++) {
      const j = idx[i] * 3
      const x = positions[j], y = positions[j + 1], z = positions[j + 2]
      const e = torusResidual(t, x, y, z)
      if (!Number.isFinite(e)) continue
      for (let a = 0; a < P; a++) {
        const d = a >= 3 && a <= 4 ? h / scale : h
        row[a] = (torusResidual(plus[a], x, y, z) - torusResidual(minus[a], x, y, z)) / (2 * d)
      }
      for (let a = 0; a < P; a++) {
        jtf[a] += row[a] * e
        for (let b = a; b < P; b++) jtj[a * P + b] += row[a] * row[b]
      }
    }
    for (let a = 0; a < P; a++) for (let b = 0; b < a; b++) jtj[a * P + b] = jtj[b * P + a]
    let improved = false
    for (let attempt = 0; attempt < 8 && !improved; attempt++) {
      const damped = new Float64Array(jtj)
      for (let a = 0; a < P; a++) damped[a * P + a] *= 1 + lambda
      const rhs = new Float64Array(P)
      for (let a = 0; a < P; a++) rhs[a] = -jtf[a]
      const delta = solveLinear(P, damped, rhs)
      if (!delta) {
        lambda *= 10
        continue
      }
      const next = apply(t, delta)
      if (!(next.R > 0) || !(next.r > 0)) {
        lambda *= 10
        continue
      }
      const nextCost = rms(positions, idx, next)
      if (nextCost < cost) {
        const moved = Math.hypot(delta[0], delta[1], delta[2], delta[5], delta[6]) + Math.hypot(delta[3], delta[4]) * scale
        t = next
        cost = nextCost
        lambda = Math.max(lambda / 10, 1e-9)
        improved = true
        if (moved < 1e-9 * scale) return t
      } else lambda *= 10
    }
    if (!improved) break
  }
  return t
}

export interface TorusClippedFit extends ClippedRefit<Torus> {
  torus: Torus
}

/** Gaussian best-fit with GOM-style "used points" clipping (see
 *  `clippedRefit`), each round the geometric refinement from the last. */
export function fitTorusClipped(positions: Float32Array, idx: Uint32Array | ArrayLike<number>, k: number, init: Torus): TorusClippedFit | null {
  let current = init
  const r = clippedRefit<Torus>(
    positions,
    idx,
    k,
    (used) => {
      const next = refineTorusGeometric(positions, used, current)
      if (!(next.R > 0) || !(next.r > 0)) return null
      current = next
      return next
    },
    torusResidual,
  )
  return r && { ...r, torus: r.model }
}

export interface TorusRansac {
  torus: Torus
  inliers: Uint32Array
  sigma: number
}

/** Robust torus estimate on a local patch: the tube radius searched over a
 *  range of scales with either sign, each a spine circle through a random
 *  subset of the shifted points, scored by median residual; the winner
 *  refined on its consensus set. */
export function ransacTorus(positions: Float32Array, normals: Float32Array, patch: Uint32Array, opts: { iterations?: number; seed?: number } = {}): TorusRansac | null {
  const core = ransacConsensus<Torus>(positions, patch, { iterations: opts.iterations ?? 320, seed: opts.seed }, (diag, rand) => {
    const n = patch.length
    const subset = Math.min(n, 48)
    let call = 0
    return {
      generate: () => {
        // The tube radius on a log scale from a fiftieth to twice the
        // patch's diagonal, the sign alternating; the points a random
        // strided subset so no one stretch of the patch decides.
        const k = call++
        const frac = ((k >> 1) % 40) / 39
        const shift = (k & 1 ? -1 : 1) * diag * 0.02 * Math.pow(100, frac)
        // The circle is a least-squares fit, so its points have to be the
        // round's alone: the patch comes in breadth-first order from the
        // click, and its first few hundred vertices are the surface the
        // click was on — a random pick among those, not a stride across
        // the whole patch, which on a fillet would take the flats along.
        const local = Math.min(n, Math.max(subset * 2, 300))
        const idx = new Uint32Array(subset)
        for (let i = 0; i < subset; i++) idx[i] = patch[(rand() * local) | 0]
        const t = torusFromShift(positions, normals, idx, shift)
        if (!t || !(t.R > 1e-6) || t.R > diag * 50) return null
        // Polished on its own points before it is scored: the shift grid
        // is coarse and the vertex normals of a mesh are averaged, so the
        // raw circle sits a few percent off, and a candidate that close
        // to the round scores a median the flats beside it cannot match.
        const polished = refineTorusGeometric(positions, idx, t, 8)
        return polished.R > 1e-6 && polished.R <= diag * 50 ? polished : t
      },
      residual: torusResidual,
    }
  })
  if (!core) return null
  const refined = fitTorusClipped(positions, core.inliers, 3, core.model)
  if (!refined) return null
  return { torus: refined.torus, inliers: refined.used, sigma: Math.max(refined.sigma, core.sigmaEst, 1e-9) }
}

/** The torus with its axis pointing the way the majority of the region's
 *  normals lean, so two fits of the same round agree in sign. */
export function canonicalTorus(t: Torus, normals: Float32Array, idx: ArrayLike<number>): Torus {
  let s = 0
  for (let i = 0; i < idx.length; i++) {
    const j = idx[i] * 3
    s += normals[j] * t.ax + normals[j + 1] * t.ay + normals[j + 2] * t.az
  }
  return s < 0 ? { ...t, ax: -t.ax, ay: -t.ay, az: -t.az } : t
}

/** How much of the tube's cross section the region wraps, in degrees, and
 *  how far round the spine it reaches — for the readout. */
export function torusCoverage(t: Torus, positions: Float32Array, idx: ArrayLike<number>): { tubeDeg: number; spineDeg: number } {
  const [u, v] = orthoBasis([t.ax, t.ay, t.az])
  const spine = new Set<number>()
  const tube = new Set<number>()
  for (let i = 0; i < idx.length; i++) {
    const j = idx[i] * 3
    const dx = positions[j] - t.cx, dy = positions[j + 1] - t.cy, dz = positions[j + 2] - t.cz
    const a = dx * t.ax + dy * t.ay + dz * t.az
    const pu = dx * u[0] + dy * u[1] + dz * u[2]
    const pv = dx * v[0] + dy * v[1] + dz * v[2]
    const rho = Math.hypot(pu, pv)
    spine.add(Math.round((Math.atan2(pv, pu) * 180) / Math.PI / 5))
    tube.add(Math.round((Math.atan2(a, rho - t.R) * 180) / Math.PI / 5))
  }
  return { tubeDeg: Math.min(360, tube.size * 5), spineDeg: Math.min(360, spine.size * 5) }
}

export type { Vec3 }

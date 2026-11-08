// SPDX-License-Identifier: AGPL-3.0-only
// The sphere's best fit: Coope's algebraic fit, linear and dependable, as a
// start, then the orthogonal-distance fixed-point iteration that makes it the
// Gaussian best fit, once per round of the "used points" clipping. The robust
// estimate a click starts from lives in ransac.ts.
//
// A ball whose diameter is known — a gauge ball, a ballbar's — can be fitted
// with it held: the free fit is the start, and only the centre moves. On a
// partial scan that is what keeps the centre where it belongs, since there
// the radius and the centre's place along the cap's axis trade off against
// each other, and a surface that reads a little off towards the grazing rim
// moves both of them several times as far as it is off.

import type { Sphere } from '../types'
import { refineBall } from './ballFit'
import { clippedRefit } from './clip'
import { centroidOf, solveLinear } from './linalg'

/** Linear (algebraic) sphere fit after Coope: with q = p − centroid, solve
 *  2q·a + t = |q|² in least squares for center offset a and t = r² − |a|².
 *  Fast and dependable as an initial estimate. */
function fitSphereAlgebraic(positions: Float32Array, idx: ArrayLike<number>): Sphere | null {
  const n = idx.length
  if (n < 4) return null

  const [mx, my, mz] = centroidOf(positions, idx)

  let sxx = 0, sxy = 0, sxz = 0, syy = 0, syz = 0, szz = 0
  let sx = 0, sy = 0, sz = 0
  let sxb = 0, syb = 0, szb = 0, sb = 0
  for (let i = 0; i < n; i++) {
    const j = idx[i] * 3
    const qx = positions[j] - mx
    const qy = positions[j + 1] - my
    const qz = positions[j + 2] - mz
    const b = qx * qx + qy * qy + qz * qz
    sxx += qx * qx
    sxy += qx * qy
    sxz += qx * qz
    syy += qy * qy
    syz += qy * qz
    szz += qz * qz
    sx += qx
    sy += qy
    sz += qz
    sxb += qx * b
    syb += qy * b
    szb += qz * b
    sb += b
  }

  const a = new Float64Array([
    4 * sxx, 4 * sxy, 4 * sxz, 2 * sx,
    4 * sxy, 4 * syy, 4 * syz, 2 * sy,
    4 * sxz, 4 * syz, 4 * szz, 2 * sz,
    2 * sx, 2 * sy, 2 * sz, n,
  ])
  const rhs = new Float64Array([2 * sxb, 2 * syb, 2 * szb, sb])
  const u = solveLinear(4, a, rhs)
  if (!u) return null

  const r2 = u[3] + u[0] * u[0] + u[1] * u[1] + u[2] * u[2]
  if (!(r2 > 0) || !Number.isFinite(r2)) return null
  return { cx: mx + u[0], cy: my + u[1], cz: mz + u[2], r: Math.sqrt(r2) }
}

/** Geometric (orthogonal-distance) refinement minimizing Σ(dᵢ − r)², to
 *  convergence (refineBall). This is the Gaussian best-fit. */
function refineSphereGeometric(positions: Float32Array, idx: ArrayLike<number>, init: Sphere): Sphere {
  const n = idx.length
  if (n === 0) return init
  // About the centroid, where the sums keep their digits.
  const [mx, my, mz] = centroidOf(positions, idx)
  const coords = new Float64Array(3 * n)
  for (let i = 0; i < n; i++) {
    const j = idx[i] * 3
    coords[3 * i] = positions[j] - mx
    coords[3 * i + 1] = positions[j + 1] - my
    coords[3 * i + 2] = positions[j + 2] - mz
  }
  const ball = refineBall(3, coords, [init.cx - mx, init.cy - my, init.cz - mz], init.r)
  if (!ball) return init
  return { cx: ball.centre[0] + mx, cy: ball.centre[1] + my, cz: ball.centre[2] + mz, r: ball.r }
}

/** The centre of the sphere of radius `r` that fits best — Gauss–Newton on
 *  Σ(|p − c| − r)² over the centre alone, from `start`. */
function fitSphereCentre(
  positions: Float32Array,
  idx: ArrayLike<number>,
  r: number,
  start: Sphere,
  maxIter = 50,
): Sphere | null {
  const n = idx.length
  let cx = start.cx, cy = start.cy, cz = start.cz
  for (let iter = 0; iter < maxIter; iter++) {
    let axx = 0, axy = 0, axz = 0, ayy = 0, ayz = 0, azz = 0
    let bx = 0, by = 0, bz = 0
    for (let i = 0; i < n; i++) {
      const j = idx[i] * 3
      const dx = positions[j] - cx
      const dy = positions[j + 1] - cy
      const dz = positions[j + 2] - cz
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (d < 1e-12) continue
      const ux = dx / d, uy = dy / d, uz = dz / d
      const e = d - r
      axx += ux * ux
      axy += ux * uy
      axz += ux * uz
      ayy += uy * uy
      ayz += uy * uz
      azz += uz * uz
      bx += ux * e
      by += uy * e
      bz += uz * e
    }
    const step = solveLinear(3, new Float64Array([axx, axy, axz, axy, ayy, ayz, axz, ayz, azz]), new Float64Array([bx, by, bz]))
    if (!step) return null
    cx += step[0]
    cy += step[1]
    cz += step[2]
    if (Math.hypot(step[0], step[1], step[2]) < 1e-10 * Math.max(1, r)) break
  }
  return Number.isFinite(cx) && Number.isFinite(cy) && Number.isFinite(cz) ? { cx, cy, cz, r } : null
}

export interface ClippedFit {
  sphere: Sphere
  /** RMS of radial residuals over the used points. */
  sigma: number
  /** Peak-to-peak radial residual — the surface's sphericity. */
  span: number
  /** The signed radial extremes `span` is the difference of: how far inside
   *  and outside the fitted sphere the kept points reach. */
  min: number
  max: number
  used: Uint32Array
  /** With the radius held: the sphere the same used points give when it is
   *  free — how far its radius is off the held one says how far the scan
   *  sits off the ball. */
  free?: Sphere
}

/** Gaussian best-fit with GOM-style "used points" clipping (see
 *  `clippedRefit`), each round an algebraic fit polished geometrically —
 *  and, with `held` (a radius), the centre then fitted with that radius. */
export function fitSphereClipped(
  positions: Float32Array,
  idx: Uint32Array | ArrayLike<number>,
  k: number,
  held?: number,
): ClippedFit | null {
  const freeFit = (used: ArrayLike<number>) => {
    const alg = fitSphereAlgebraic(positions, used)
    return alg && refineSphereGeometric(positions, used, alg)
  }
  const r = clippedRefit<Sphere>(
    positions,
    idx,
    k,
    (used) => {
      const free = freeFit(used)
      return free && held !== undefined ? fitSphereCentre(positions, used, held, free) : free
    },
    (s, x, y, z) => {
      const dx = x - s.cx
      const dy = y - s.cy
      const dz = z - s.cz
      return Math.sqrt(dx * dx + dy * dy + dz * dz) - s.r
    },
  )
  if (!r) return null
  const free = held !== undefined ? freeFit(r.used) : null
  return { sphere: r.model, sigma: r.sigma, span: r.span, min: r.min, max: r.max, used: r.used, ...(free ? { free } : {}) }
}

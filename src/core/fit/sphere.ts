// SPDX-License-Identifier: AGPL-3.0-only
import type { Sphere } from '../types'
import { clippedRefit } from './clip'
import { solveLinear } from './linalg'

/** Linear (algebraic) sphere fit after Coope: with q = p − centroid, solve
 *  2q·a + t = |q|² in least squares for center offset a and t = r² − |a|².
 *  Fast and dependable as an initial estimate. */
export function fitSphereAlgebraic(positions: Float32Array, idx: ArrayLike<number>): Sphere | null {
  const n = idx.length
  if (n < 4) return null

  let mx = 0, my = 0, mz = 0
  for (let i = 0; i < n; i++) {
    const j = idx[i] * 3
    mx += positions[j]
    my += positions[j + 1]
    mz += positions[j + 2]
  }
  mx /= n
  my /= n
  mz /= n

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

/** Geometric (orthogonal-distance) refinement minimizing Σ(dᵢ − r)² via the
 *  standard fixed-point iteration c ← x̄ − r̄·ū. This is the Gaussian best-fit. */
export function refineSphereGeometric(
  positions: Float32Array,
  idx: ArrayLike<number>,
  init: Sphere,
  maxIter = 150,
): Sphere {
  const n = idx.length
  if (n === 0) return init

  let mx = 0, my = 0, mz = 0
  for (let i = 0; i < n; i++) {
    const j = idx[i] * 3
    mx += positions[j]
    my += positions[j + 1]
    mz += positions[j + 2]
  }
  mx /= n
  my /= n
  mz /= n

  let cx = init.cx, cy = init.cy, cz = init.cz, r = init.r
  for (let iter = 0; iter < maxIter; iter++) {
    let sd = 0, sux = 0, suy = 0, suz = 0, m = 0
    for (let i = 0; i < n; i++) {
      const j = idx[i] * 3
      const dx = positions[j] - cx
      const dy = positions[j + 1] - cy
      const dz = positions[j + 2] - cz
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (d < 1e-12) continue
      sd += d
      sux += dx / d
      suy += dy / d
      suz += dz / d
      m++
    }
    if (m === 0) break
    const rNew = sd / m
    const ncx = mx - rNew * (sux / m)
    const ncy = my - rNew * (suy / m)
    const ncz = mz - rNew * (suz / m)
    const move = Math.sqrt((ncx - cx) ** 2 + (ncy - cy) ** 2 + (ncz - cz) ** 2)
    cx = ncx
    cy = ncy
    cz = ncz
    r = rNew
    if (move < 1e-10 * Math.max(1, r)) break
  }
  if (!Number.isFinite(cx) || !Number.isFinite(r)) return init
  return { cx, cy, cz, r }
}

export interface ClippedFit {
  sphere: Sphere
  /** RMS of radial residuals over the used points. */
  sigma: number
  used: Uint32Array
}

/** Gaussian best-fit with GOM-style "used points" clipping (see
 *  `clippedRefit`), each round an algebraic fit polished geometrically. */
export function fitSphereClipped(
  positions: Float32Array,
  idx: Uint32Array | ArrayLike<number>,
  k: number,
): ClippedFit | null {
  const r = clippedRefit<Sphere>(
    positions,
    idx,
    k,
    (used) => {
      const alg = fitSphereAlgebraic(positions, used)
      return alg && refineSphereGeometric(positions, used, alg)
    },
    (s, x, y, z) => {
      const dx = x - s.cx
      const dy = y - s.cy
      const dz = z - s.cz
      return Math.sqrt(dx * dx + dy * dy + dz * dz) - s.r
    },
  )
  return r && { sphere: r.model, sigma: r.sigma, used: r.used }
}

// SPDX-License-Identifier: AGPL-3.0-only
// The 2D circle kernel: the best circle through points given in plane
// coordinates. Every circle this tool fits comes through here — the picked
// circle element after projecting onto its total-least-squares plane, and the
// cylinder pipeline in the plane across its axis. It stands alone so that a
// fit working in a plane from the start (a flatbed scan, a section through a
// mesh) can use it without inventing a third dimension first.

import { solveLinear } from './linalg'

export interface Circle2d {
  cu: number
  cv: number
  r: number
}

/**
 * Best-fit circle through 2D points — algebraic (Coope) start, exactly
 * determined for three points and least squares beyond, then the 2D form of
 * the orthogonal-distance fixed-point iteration (a no-op for three points).
 * Null when the points do not determine a circle.
 */
export function fitCircle2d(pu: ArrayLike<number>, pv: ArrayLike<number>): Circle2d | null {
  const n = pu.length
  if (n < 3) return null

  // Algebraic (Coope) circle, solved directly — the 3×3 normal equations.
  let suu = 0, suv = 0, svv = 0, su = 0, sv = 0, sub = 0, svb = 0, sb = 0
  for (let i = 0; i < n; i++) {
    const b = pu[i] * pu[i] + pv[i] * pv[i]
    suu += pu[i] * pu[i]
    suv += pu[i] * pv[i]
    svv += pv[i] * pv[i]
    su += pu[i]
    sv += pv[i]
    sub += pu[i] * b
    svb += pv[i] * b
    sb += b
  }
  const a = new Float64Array([
    4 * suu, 4 * suv, 2 * su,
    4 * suv, 4 * svv, 2 * sv,
    2 * su, 2 * sv, n,
  ])
  const sol = solveLinear(3, a, new Float64Array([2 * sub, 2 * svb, sb]))
  if (!sol) return null
  let cu = sol[0]
  let cv = sol[1]
  const r2 = sol[2] + cu * cu + cv * cv
  if (!(r2 > 0) || !Number.isFinite(r2)) return null
  let r = Math.sqrt(r2)

  // Orthogonal-distance refinement.
  for (let iter = 0; iter < 100; iter++) {
    let sd = 0, sxu = 0, sxv = 0, m = 0
    for (let i = 0; i < n; i++) {
      const du = pu[i] - cu
      const dv = pv[i] - cv
      const dist = Math.hypot(du, dv)
      if (dist < 1e-12) continue
      sd += dist
      sxu += du / dist
      sxv += dv / dist
      m++
    }
    if (m === 0) break
    const rNew = sd / m
    const nu = su / n - rNew * (sxu / m)
    const nv = sv / n - rNew * (sxv / m)
    const move = Math.hypot(nu - cu, nv - cv)
    cu = nu
    cv = nv
    r = rNew
    if (move < 1e-10 * Math.max(1, r)) break
  }
  if (!Number.isFinite(cu) || !Number.isFinite(cv) || !Number.isFinite(r) || !(r > 0)) return null

  return { cu, cv, r }
}

// SPDX-License-Identifier: AGPL-3.0-only
// The 2D circle kernel: the best circle through points given in plane
// coordinates. Every circle this tool fits comes through here — the picked
// circle element after projecting onto its total-least-squares plane, and the
// cylinder pipeline in the plane across its axis. It stands alone so that a
// fit working in a plane from the start (a flatbed scan, a section through a
// mesh) can use it without inventing a third dimension first.

import { refineBall } from './ballFit'
import { solveLinear } from './linalg'

export interface Circle2d {
  cu: number
  cv: number
  r: number
}

/**
 * Best-fit circle through 2D points — algebraic (Coope) start, exactly
 * determined for three points and least squares beyond, then the
 * orthogonal-distance fit to convergence (refineBall; a no-op for three
 * points).
 * Null when the points do not determine a circle.
 */
export function fitCircle2d(pu0: ArrayLike<number>, pv0: ArrayLike<number>): Circle2d | null {
  const n = pu0.length
  if (n < 3) return null

  // Work about the centroid. The normal equations carry fourth powers of the
  // coordinates, and a short arc a few thousand units from the origin (image
  // pixels on a scan) cancels them to round-off — the fit would come back
  // null for points that define a circle perfectly well.
  let mu = 0, mv = 0
  for (let i = 0; i < n; i++) {
    mu += pu0[i]
    mv += pv0[i]
  }
  mu /= n
  mv /= n
  const pu = new Float64Array(n)
  const pv = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    pu[i] = pu0[i] - mu
    pv[i] = pv0[i] - mv
  }

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

  // Orthogonal-distance refinement, to convergence.
  const coords = new Float64Array(2 * n)
  for (let i = 0; i < n; i++) {
    coords[2 * i] = pu[i]
    coords[2 * i + 1] = pv[i]
  }
  const ball = refineBall(2, coords, [cu, cv], r)
  if (!ball) return null
  ;[cu, cv] = ball.centre
  r = ball.r

  return { cu: cu + mu, cv: cv + mv, r }
}

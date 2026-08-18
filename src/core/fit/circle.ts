// SPDX-License-Identifier: AGPL-3.0-only
// Circle through three or more picked points — GOM's "3-point circle",
// generalised: three points give the exact circle, more give the Gaussian
// best fit. Small point counts, so everything runs on the main thread; the
// worker pipeline never sees a circle.

import type { CircleFit, Vec3 } from '../types'
import { FitError } from './errors'
import { orthoBasis, solveLinear, symmetricEigen3 } from './linalg'

/**
 * The best-fit circle through the given points.
 *
 * The plane is the total-least-squares plane of the points (exact for three);
 * the circle is fitted in it — algebraic (Coope) start, orthogonal-distance
 * refinement, the same 2D fit the cylinder pipeline uses. sigma is the RMS 3D
 * distance of the points to the circle curve, formError the peak-to-peak
 * in-plane radial residual (the circularity of the picks).
 *
 * Throws FitError with a user-facing message on degenerate input.
 */
export function circleFromPoints(points: Vec3[]): CircleFit {
  const n = points.length
  if (n < 3) throw new FitError('A circle needs at least three points.')

  // Centroid and covariance — the TLS plane normal is the direction the
  // points scatter least along.
  let mx = 0, my = 0, mz = 0
  for (const p of points) {
    mx += p[0]
    my += p[1]
    mz += p[2]
  }
  mx /= n
  my /= n
  mz /= n
  let cxx = 0, cxy = 0, cxz = 0, cyy = 0, cyz = 0, czz = 0
  let spread = 0
  for (const p of points) {
    const x = p[0] - mx
    const y = p[1] - my
    const z = p[2] - mz
    cxx += x * x
    cxy += x * y
    cxz += x * z
    cyy += y * y
    cyz += y * z
    czz += z * z
    spread = Math.max(spread, x * x + y * y + z * z)
  }
  if (!(spread > 0)) throw new FitError('The points coincide — they do not define a circle.')
  const { values, vectors } = symmetricEigen3([cxx, cxy, cxz, cxy, cyy, cyz, cxz, cyz, czz])
  // Points on a line scatter along one direction only — the two smaller
  // eigenvalues both vanish and no plane (or circle) is defined.
  if (!(values[1] > 1e-10 * spread)) {
    throw new FitError('The points lie on a line — they do not define a circle.')
  }
  let normal = vectors[0]
  const [u, v] = orthoBasis(normal)

  // Project onto the plane through the centroid.
  const pu = new Float64Array(n)
  const pv = new Float64Array(n)
  const ph = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const x = points[i][0] - mx
    const y = points[i][1] - my
    const z = points[i][2] - mz
    pu[i] = x * u[0] + y * u[1] + z * u[2]
    pv[i] = x * v[0] + y * v[1] + z * v[2]
    ph[i] = x * normal[0] + y * normal[1] + z * normal[2]
  }

  // Algebraic (Coope) circle: exactly determined for three points, least
  // squares beyond. Solved directly — the 3×3 normal equations.
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
  if (!sol) throw new FitError('The points lie on a line — they do not define a circle.')
  let cu = sol[0]
  let cv = sol[1]
  const r2 = sol[2] + cu * cu + cv * cv
  if (!(r2 > 0) || !Number.isFinite(r2)) {
    throw new FitError("Couldn't fit a circle through these points.")
  }
  let r = Math.sqrt(r2)

  // Orthogonal-distance refinement of the 2D circle (no-op for three points).
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
  if (!Number.isFinite(cu) || !Number.isFinite(r) || !(r > 0)) {
    throw new FitError("Couldn't fit a circle through these points.")
  }

  // Which way the normal points is arbitrary for a TLS plane; pick the same
  // side every time so re-picking the same feature gives the same element.
  if (
    normal[2] < 0 ||
    (normal[2] === 0 && (normal[1] < 0 || (normal[1] === 0 && normal[0] < 0)))
  ) {
    normal = [-normal[0], -normal[1], -normal[2]]
  }

  // Residuals: radial in the circle's own plane for the form error, full 3D
  // distance to the curve for sigma.
  let sumSq = 0
  let minR = Infinity
  let maxR = -Infinity
  for (let i = 0; i < n; i++) {
    const er = Math.hypot(pu[i] - cu, pv[i] - cv) - r
    if (er < minR) minR = er
    if (er > maxR) maxR = er
    sumSq += er * er + ph[i] * ph[i]
  }

  return {
    kind: 'circle',
    center: [
      mx + cu * u[0] + cv * v[0],
      my + cu * u[1] + cv * v[1],
      mz + cu * u[2] + cv * v[2],
    ],
    normal,
    radius: r,
    sigma: Math.sqrt(sumSq / n),
    usedPoints: n,
    regionSize: n,
    formError: maxR - minR,
  }
}

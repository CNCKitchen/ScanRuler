// SPDX-License-Identifier: AGPL-3.0-only
import type { Cylinder, Vec3 } from '../types'
import { cross, normalize, orthoBasis, solveLinear, symmetricEigen3 } from './linalg'
import { mulberry32 } from './ransac'

/** Distance of a point from the cylinder surface (positive outside), and the
 *  unit radial direction there. NaN on the axis, where the radial direction
 *  is undefined. */
function radial(c: Cylinder, x: number, y: number, z: number): { e: number; wx: number; wy: number; wz: number; t: number } {
  const qx = x - c.px
  const qy = y - c.py
  const qz = z - c.pz
  const t = qx * c.ax + qy * c.ay + qz * c.az
  const wx = qx - t * c.ax
  const wy = qy - t * c.ay
  const wz = qz - t * c.az
  const rho = Math.sqrt(wx * wx + wy * wy + wz * wz)
  if (!(rho > 1e-12)) return { e: NaN, wx: 0, wy: 0, wz: 0, t }
  return { e: rho - c.r, wx: wx / rho, wy: wy / rho, wz: wz / rho, t }
}

export function cylinderResidual(c: Cylinder, x: number, y: number, z: number): number {
  return radial(c, x, y, z).e
}

function rms(positions: Float32Array, idx: ArrayLike<number>, c: Cylinder): number {
  let sumSq = 0
  let m = 0
  for (let i = 0; i < idx.length; i++) {
    const j = idx[i] * 3
    const e = radial(c, positions[j], positions[j + 1], positions[j + 2]).e
    if (!Number.isFinite(e)) continue
    sumSq += e * e
    m++
  }
  return m === 0 ? Infinity : Math.sqrt(sumSq / m)
}

/** Axis direction from surface normals. Every normal of a cylinder is
 *  perpendicular to its axis, so the axis is the direction the normal cloud
 *  scatters least along — a far better starting guess than anything derived
 *  from the point positions alone. */
export function axisFromNormals(normals: Float32Array, idx: ArrayLike<number>): Vec3 | null {
  const n = idx.length
  if (n < 3) return null
  let cxx = 0, cxy = 0, cxz = 0, cyy = 0, cyz = 0, czz = 0
  for (let i = 0; i < n; i++) {
    const j = idx[i] * 3
    const x = normals[j], y = normals[j + 1], z = normals[j + 2]
    cxx += x * x
    cxy += x * y
    cxz += x * z
    cyy += y * y
    cyz += y * z
    czz += z * z
  }
  const { values, vectors } = symmetricEigen3([cxx, cxy, cxz, cxy, cyy, cyz, cxz, cyz, czz])
  // A patch that curves too little (an almost-flat sliver) leaves the two
  // smallest directions indistinguishable — the axis would be a coin toss.
  if (!(values[1] > 1e-6 * n)) return null
  return vectors[0]
}

/** Best circle in the plane perpendicular to a fixed axis — that is the
 *  cylinder's position and radius for that direction. Algebraic (Coope) fit
 *  followed by the 2D form of the orthogonal-distance fixed-point iteration. */
export function fitCylinderOnAxis(
  positions: Float32Array,
  idx: ArrayLike<number>,
  axis: Vec3,
): Cylinder | null {
  const n = idx.length
  if (n < 5) return null
  const d = normalize(axis)
  const [u, v] = orthoBasis(d)

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

  // Project onto the (u, v) plane through the centroid.
  const pu = new Float64Array(n)
  const pv = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const j = idx[i] * 3
    const qx = positions[j] - mx
    const qy = positions[j + 1] - my
    const qz = positions[j + 2] - mz
    pu[i] = qx * u[0] + qy * u[1] + qz * u[2]
    pv[i] = qx * v[0] + qy * v[1] + qz * v[2]
  }

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
  const r2 = sol[2] + sol[0] * sol[0] + sol[1] * sol[1]
  if (!(r2 > 0) || !Number.isFinite(r2)) return null

  // Orthogonal-distance refinement of the 2D circle.
  let cu = sol[0]
  let cv = sol[1]
  let r = Math.sqrt(r2)
  for (let iter = 0; iter < 100; iter++) {
    let sd = 0, sxu = 0, sxv = 0, m = 0
    for (let i = 0; i < n; i++) {
      const du = pu[i] - cu
      const dv = pv[i] - cv
      const dist = Math.sqrt(du * du + dv * dv)
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
  if (!Number.isFinite(cu) || !Number.isFinite(r) || r <= 0) return null

  return {
    px: mx + cu * u[0] + cv * v[0],
    py: my + cu * u[1] + cv * v[1],
    pz: mz + cu * u[2] + cv * v[2],
    ax: d[0],
    ay: d[1],
    az: d[2],
    r,
  }
}

/** Geometric (orthogonal-distance) refinement of all five cylinder degrees of
 *  freedom by damped Gauss-Newton. The axis direction is perturbed inside the
 *  plane it is normal to (two angles), which keeps it a unit vector without a
 *  constraint equation, and the axis point slides in the same plane — the two
 *  degrees of freedom that would otherwise just walk along the axis are simply
 *  not in the parametrisation. */
export function refineCylinderGeometric(
  positions: Float32Array,
  idx: ArrayLike<number>,
  init: Cylinder,
  maxIter = 60,
): Cylinder {
  const n = idx.length
  if (n < 6) return init

  let c = { ...init }
  let cost = rms(positions, idx, c)
  if (!Number.isFinite(cost)) return init
  let lambda = 1e-6

  for (let iter = 0; iter < maxIter; iter++) {
    const [u, v] = orthoBasis([c.ax, c.ay, c.az])
    const jtj = new Float64Array(25)
    const jtf = new Float64Array(5)
    const row = new Float64Array(5)
    let m = 0

    for (let i = 0; i < n; i++) {
      const j = idx[i] * 3
      const { e, wx, wy, wz, t } = radial(c, positions[j], positions[j + 1], positions[j + 2])
      if (!Number.isFinite(e)) continue
      const su = wx * u[0] + wy * u[1] + wz * u[2]
      const sv = wx * v[0] + wy * v[1] + wz * v[2]
      row[0] = -su
      row[1] = -sv
      row[2] = -t * su
      row[3] = -t * sv
      row[4] = -1
      for (let a = 0; a < 5; a++) {
        jtf[a] += row[a] * e
        for (let b = a; b < 5; b++) jtj[a * 5 + b] += row[a] * row[b]
      }
      m++
    }
    if (m < 6) break
    for (let a = 0; a < 5; a++) for (let b = 0; b < a; b++) jtj[a * 5 + b] = jtj[b * 5 + a]

    let applied = false
    let converged = false
    for (let attempt = 0; attempt < 6; attempt++) {
      const mat = jtj.slice()
      for (let a = 0; a < 5; a++) mat[a * 5 + a] *= 1 + lambda
      const rhs = new Float64Array(5)
      for (let a = 0; a < 5; a++) rhs[a] = -jtf[a]
      const step = solveLinear(5, mat, rhs)
      if (!step) {
        lambda *= 10
        continue
      }
      const axis = normalize([
        c.ax + step[2] * u[0] + step[3] * v[0],
        c.ay + step[2] * u[1] + step[3] * v[1],
        c.az + step[2] * u[2] + step[3] * v[2],
      ])
      const cand: Cylinder = {
        px: c.px + step[0] * u[0] + step[1] * v[0],
        py: c.py + step[0] * u[1] + step[1] * v[1],
        pz: c.pz + step[0] * u[2] + step[1] * v[2],
        ax: axis[0],
        ay: axis[1],
        az: axis[2],
        r: c.r + step[4],
      }
      if (!(cand.r > 0) || !Number.isFinite(cand.px)) {
        lambda *= 10
        continue
      }
      const candCost = rms(positions, idx, cand)
      if (Number.isFinite(candCost) && candCost <= cost) {
        converged = cost - candCost < 1e-12 * Math.max(cost, cand.r)
        c = cand
        cost = candCost
        lambda = Math.max(lambda * 0.3, 1e-9)
        applied = true
        break
      }
      lambda *= 10
    }
    if (!applied || converged) break
  }
  return c
}

export interface ClippedCylinderFit {
  cylinder: Cylinder
  /** RMS of the radial residuals over the used points. */
  sigma: number
  used: Uint32Array
}

/** Gaussian best-fit with GOM-style "used points" clipping: fit, discard
 *  residuals beyond k·sigma, refit, until the point set is stable.
 *  k = 0 means use all points. */
export function fitCylinderClipped(
  positions: Float32Array,
  idx: Uint32Array | ArrayLike<number>,
  init: Cylinder,
  k: number,
): ClippedCylinderFit | null {
  let used: Uint32Array = idx instanceof Uint32Array ? idx : Uint32Array.from(idx as ArrayLike<number>)
  let result: ClippedCylinderFit | null = null
  let start = init

  for (let iter = 0; iter < 12; iter++) {
    const seeded = fitCylinderOnAxis(positions, used, [start.ax, start.ay, start.az]) ?? start
    const c = refineCylinderGeometric(positions, used, seeded)
    if (!(c.r > 0) || !Number.isFinite(c.r)) return result

    let sumSq = 0
    let m = 0
    const res = new Float64Array(used.length)
    for (let i = 0; i < used.length; i++) {
      const j = used[i] * 3
      const e = cylinderResidual(c, positions[j], positions[j + 1], positions[j + 2])
      res[i] = e
      if (!Number.isFinite(e)) continue
      sumSq += e * e
      m++
    }
    if (m === 0) return result
    const sigma = Math.sqrt(sumSq / m)
    result = { cylinder: c, sigma, used }
    start = c

    if (k <= 0 || sigma < 1e-9) return result
    const thr = k * sigma
    let keep = 0
    for (let i = 0; i < used.length; i++) if (Math.abs(res[i]) <= thr) keep++
    if (keep === used.length || keep < 10) return result

    const next = new Uint32Array(keep)
    let w = 0
    for (let i = 0; i < used.length; i++) if (Math.abs(res[i]) <= thr) next[w++] = used[i]
    used = next
  }
  return result
}

export interface RansacCylinderResult {
  cylinder: Cylinder
  inliers: Uint32Array
  /** Robust noise estimate (1.4826 · median absolute residual). */
  sigma: number
}

/** Cylinder through two points with known surface normals: the axis is
 *  perpendicular to both normals, and in the plane across it the axis sits
 *  where the two (projected) normal lines meet. */
function cylinderFrom2(
  positions: Float32Array,
  normals: Float32Array,
  i0: number,
  i1: number,
): Cylinder | null {
  const a = i0 * 3
  const b = i1 * 3
  const n0: Vec3 = [normals[a], normals[a + 1], normals[a + 2]]
  const n1: Vec3 = [normals[b], normals[b + 1], normals[b + 2]]
  const axisRaw = cross(n0, n1)
  const len = Math.hypot(axisRaw[0], axisRaw[1], axisRaw[2])
  // Near-parallel normals say nothing about where the axis runs.
  if (!(len > 0.08)) return null
  const d = normalize(axisRaw)
  const [u, v] = orthoBasis(d)

  const p0u = positions[a] * u[0] + positions[a + 1] * u[1] + positions[a + 2] * u[2]
  const p0v = positions[a] * v[0] + positions[a + 1] * v[1] + positions[a + 2] * v[2]
  const p1u = positions[b] * u[0] + positions[b + 1] * u[1] + positions[b + 2] * u[2]
  const p1v = positions[b] * v[0] + positions[b + 1] * v[1] + positions[b + 2] * v[2]
  const n0u = n0[0] * u[0] + n0[1] * u[1] + n0[2] * u[2]
  const n0v = n0[0] * v[0] + n0[1] * v[1] + n0[2] * v[2]
  const n1u = n1[0] * u[0] + n1[1] * u[1] + n1[2] * u[2]
  const n1v = n1[0] * v[0] + n1[1] * v[1] + n1[2] * v[2]

  // Intersect p0 + s·n0 with p1 + t·n1 in the (u, v) plane.
  const det = n0u * -n1v - -n1u * n0v
  if (Math.abs(det) < 1e-9) return null
  const du = p1u - p0u
  const dv = p1v - p0v
  const s = (du * -n1v - -n1u * dv) / det
  const cu = p0u + s * n0u
  const cv = p0v + s * n0v
  const r = Math.hypot(cu - p0u, cv - p0v)
  if (!(r > 0) || !Number.isFinite(r)) return null

  // Any point with the right (u, v) offset lies on the axis; anchor it at the
  // first sample so the axis passes near the patch.
  const alongU = cu - p0u
  const alongV = cv - p0v
  return {
    px: positions[a] + alongU * u[0] + alongV * v[0],
    py: positions[a + 1] + alongU * u[1] + alongV * v[1],
    pz: positions[a + 2] + alongU * u[2] + alongV * v[2],
    ax: d[0],
    ay: d[1],
    az: d[2],
    r,
  }
}

/** Robust cylinder estimate on a local patch: score the normal-covariance
 *  axis plus a batch of two-point-with-normals candidates by median absolute
 *  residual (LMedS), then refine on the consensus set. */
export function ransacCylinder(
  positions: Float32Array,
  normals: Float32Array,
  patch: Uint32Array,
  opts: { iterations?: number; seed?: number } = {},
): RansacCylinderResult | null {
  const n = patch.length
  if (n < 30) return null
  const iterations = opts.iterations ?? 256
  const rand = mulberry32(opts.seed ?? 0x5eed)

  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < n; i++) {
    const j = patch[i] * 3
    const x = positions[j], y = positions[j + 1], z = positions[j + 2]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  const diag = Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2)
  if (!(diag > 0)) return null

  const scoreN = Math.min(n, 512)
  const stride = n / scoreN
  const subset = new Uint32Array(scoreN)
  for (let i = 0; i < scoreN; i++) subset[i] = patch[Math.floor(i * stride)]

  const resid = new Float64Array(scoreN)

  /** Median absolute residual of a candidate over the scoring subset, or
   *  Infinity for one wildly out of scale with the local patch — beyond that
   *  range it is really a plane, never the cylinder the user clicked. */
  const medianResidual = (c: Cylinder): number => {
    if (!(c.r > diag * 0.01) || c.r > diag * 60) return Infinity
    for (let i = 0; i < scoreN; i++) {
      const j = subset[i] * 3
      const e = cylinderResidual(c, positions[j], positions[j + 1], positions[j + 2])
      resid[i] = Number.isFinite(e) ? Math.abs(e) : Infinity
    }
    const sorted = resid.slice().sort()
    return sorted[scoreN >> 1]
  }

  let bestMedian = Infinity
  let chosen: Cylinder | null = null

  const normalAxis = axisFromNormals(normals, patch)
  const fromNormals = normalAxis && fitCylinderOnAxis(positions, patch, normalAxis)
  if (fromNormals) {
    bestMedian = medianResidual(fromNormals)
    if (bestMedian < Infinity) chosen = fromNormals
  }

  for (let it = 0; it < iterations; it++) {
    const i0 = patch[(rand() * n) | 0]
    const i1 = patch[(rand() * n) | 0]
    if (i0 === i1) continue
    const c = cylinderFrom2(positions, normals, i0, i1)
    if (!c) continue
    const med = medianResidual(c)
    if (med < bestMedian) {
      bestMedian = med
      chosen = c
    }
  }

  if (!chosen) return null
  const sigmaEst = 1.4826 * bestMedian
  const thr = Math.max(3 * sigmaEst, diag * 1e-5)

  let count = 0
  for (let i = 0; i < n; i++) {
    const j = patch[i] * 3
    const e = cylinderResidual(chosen, positions[j], positions[j + 1], positions[j + 2])
    if (Number.isFinite(e) && Math.abs(e) <= thr) count++
  }
  if (count < 30) return null

  const inliers = new Uint32Array(count)
  let w = 0
  for (let i = 0; i < n; i++) {
    const j = patch[i] * 3
    const e = cylinderResidual(chosen, positions[j], positions[j + 1], positions[j + 2])
    if (Number.isFinite(e) && Math.abs(e) <= thr) inliers[w++] = patch[i]
  }

  const refined = fitCylinderClipped(positions, inliers, chosen, 3)
  if (!refined) return null
  return {
    cylinder: refined.cylinder,
    inliers: refined.used,
    sigma: Math.max(refined.sigma, sigmaEst, 1e-9),
  }
}

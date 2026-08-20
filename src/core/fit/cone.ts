// SPDX-License-Identifier: AGPL-3.0-only
import type { Cone, Vec3 } from '../types'
import { fitCircle2d } from './circle2d'
import { clippedRefit } from './clip'
import { cross, normalize, orthoBasis, solveLinear, symmetricEigen3 } from './linalg'
import { ransacConsensus } from './ransac'

/** Orthogonal distance of a point from the cone surface (positive outside),
 *  plus the unit radial direction, axial position and radial distance there.
 *  The cone is anchored at a point ON the axis — not at the apex — so nothing
 *  blows up as the half-angle approaches zero and the shape becomes a
 *  cylinder. In the (t, rho) half-plane the surface is the line
 *  rho = r + t·tan(phi), and the point-to-line distance is
 *  cos(phi)·(rho − r) − sin(phi)·t. NaN on the axis, where the radial
 *  direction is undefined. */
function slant(
  c: Cone,
  x: number,
  y: number,
  z: number,
): { e: number; wx: number; wy: number; wz: number; t: number; rho: number } {
  const qx = x - c.px
  const qy = y - c.py
  const qz = z - c.pz
  const t = qx * c.ax + qy * c.ay + qz * c.az
  const wx = qx - t * c.ax
  const wy = qy - t * c.ay
  const wz = qz - t * c.az
  const rho = Math.sqrt(wx * wx + wy * wy + wz * wz)
  if (!(rho > 1e-12)) return { e: NaN, wx: 0, wy: 0, wz: 0, t, rho }
  const e = Math.cos(c.phi) * (rho - c.r) - Math.sin(c.phi) * t
  return { e, wx: wx / rho, wy: wy / rho, wz: wz / rho, t, rho }
}

export function coneResidual(c: Cone, x: number, y: number, z: number): number {
  return slant(c, x, y, z).e
}

/** |cos| between a vertex normal and the cone's surface normal at that point
 *  — the membership test region growing uses to stay on the conical face. */
export function coneNormalAlign(
  c: Cone,
  x: number,
  y: number,
  z: number,
  nx: number,
  ny: number,
  nz: number,
): number {
  const { wx, wy, wz } = slant(c, x, y, z)
  if (wx === 0 && wy === 0 && wz === 0) return 0
  const cos = Math.cos(c.phi)
  const sin = Math.sin(c.phi)
  // Surface normal: the radial direction tilted back by the half-angle.
  const sx = cos * wx - sin * c.ax
  const sy = cos * wy - sin * c.ay
  const sz = cos * wz - sin * c.az
  return Math.abs(sx * nx + sy * ny + sz * nz)
}

function rms(positions: Float32Array, idx: ArrayLike<number>, c: Cone): number {
  let sumSq = 0
  let m = 0
  for (let i = 0; i < idx.length; i++) {
    const j = idx[i] * 3
    const e = slant(c, positions[j], positions[j + 1], positions[j + 2]).e
    if (!Number.isFinite(e)) continue
    sumSq += e * e
    m++
  }
  return m === 0 ? Infinity : Math.sqrt(sumSq / m)
}

/** Radius grows along the +axis by convention; a fit that walked the
 *  half-angle negative is the same cone with the axis reversed. */
function canonical(c: Cone): Cone {
  if (c.phi >= 0) return c
  return { ...c, ax: -c.ax, ay: -c.ay, az: -c.az, phi: -c.phi }
}

/** Axis direction from surface normals. A cone's normals all make the same
 *  angle with its axis, so their tips lie in one plane — the plane's normal
 *  is the axis. (For a cylinder that plane passes through the origin: the
 *  same estimate, so this degrades gracefully toward zero half-angle.) */
export function coneAxisFromNormals(normals: Float32Array, idx: ArrayLike<number>): Vec3 | null {
  const n = idx.length
  if (n < 3) return null
  let mx = 0, my = 0, mz = 0
  for (let i = 0; i < n; i++) {
    const j = idx[i] * 3
    mx += normals[j]
    my += normals[j + 1]
    mz += normals[j + 2]
  }
  mx /= n
  my /= n
  mz /= n
  let cxx = 0, cxy = 0, cxz = 0, cyy = 0, cyz = 0, czz = 0
  for (let i = 0; i < n; i++) {
    const j = idx[i] * 3
    const x = normals[j] - mx
    const y = normals[j + 1] - my
    const z = normals[j + 2] - mz
    cxx += x * x
    cxy += x * y
    cxz += x * z
    cyy += y * y
    cyz += y * z
    czz += z * z
  }
  const { values, vectors } = symmetricEigen3([cxx, cxy, cxz, cxy, cyy, cyz, cxz, cyz, czz])
  // A patch that curves too little (an almost-flat sliver) leaves the plane
  // through the normal tips undetermined — the axis would be a coin toss.
  if (!(values[1] > 1e-6 * n)) return null
  return vectors[0]
}

/** Best cone for a fixed axis direction: place the axis with the shared 2D
 *  circle kernel in the plane across it (a cone projects to an annulus whose
 *  middle circle is centred on the axis), then read the taper straight off a
 *  line fit of radial distance against axial position. */
export function fitConeOnAxis(
  positions: Float32Array,
  idx: ArrayLike<number>,
  axis: Vec3,
): Cone | null {
  const n = idx.length
  if (n < 6) return null
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
  const fit2d = fitCircle2d(pu, pv)
  if (!fit2d) return null
  const { cu, cv } = fit2d

  // rho against t is a straight line on a cone: rho = r + t·tan(phi).
  let st = 0, stt = 0, sr = 0, str = 0
  for (let i = 0; i < n; i++) {
    const j = idx[i] * 3
    const qx = positions[j] - mx
    const qy = positions[j + 1] - my
    const qz = positions[j + 2] - mz
    const t = qx * d[0] + qy * d[1] + qz * d[2]
    const rho = Math.hypot(pu[i] - cu, pv[i] - cv)
    st += t
    stt += t * t
    sr += rho
    str += t * rho
  }
  const det = n * stt - st * st
  // All points at one axial position — a circle slice — cannot say how the
  // radius changes along the axis; call it straight and let refinement decide.
  let tan = 0
  let r = sr / n
  if (det > 1e-12 * Math.max(1, stt) * n) {
    tan = (n * str - st * sr) / det
    r = (sr - tan * st) / n
  }
  if (!Number.isFinite(r) || !(r > 0) || !Number.isFinite(tan)) return null

  return canonical({
    px: mx + cu * u[0] + cv * v[0],
    py: my + cu * u[1] + cv * v[1],
    pz: mz + cu * u[2] + cv * v[2],
    ax: d[0],
    ay: d[1],
    az: d[2],
    r,
    phi: Math.atan(tan),
  })
}

/** Geometric (orthogonal-distance) refinement of all six cone degrees of
 *  freedom by damped Gauss-Newton — the cylinder's five parameters plus the
 *  half-angle. The axis point slides in the plane it is normal to and the
 *  direction is perturbed by two angles in that same plane, exactly as for
 *  the cylinder, so the parametrisation never leaves the unit sphere and the
 *  slide-along-the-axis degeneracy is simply not present. */
export function refineConeGeometric(
  positions: Float32Array,
  idx: ArrayLike<number>,
  init: Cone,
  maxIter = 60,
): Cone {
  const n = idx.length
  if (n < 7) return init

  let c = { ...init }
  let cost = rms(positions, idx, c)
  if (!Number.isFinite(cost)) return init
  let lambda = 1e-6

  for (let iter = 0; iter < maxIter; iter++) {
    const [u, v] = orthoBasis([c.ax, c.ay, c.az])
    const cos = Math.cos(c.phi)
    const sin = Math.sin(c.phi)
    const jtj = new Float64Array(36)
    const jtf = new Float64Array(6)
    const row = new Float64Array(6)
    let m = 0

    for (let i = 0; i < n; i++) {
      const j = idx[i] * 3
      const { e, wx, wy, wz, t, rho } = slant(c, positions[j], positions[j + 1], positions[j + 2])
      if (!Number.isFinite(e)) continue
      const su = wx * u[0] + wy * u[1] + wz * u[2]
      const sv = wx * v[0] + wy * v[1] + wz * v[2]
      const tilt = t * cos + rho * sin
      row[0] = -cos * su
      row[1] = -cos * sv
      row[2] = -tilt * su
      row[3] = -tilt * sv
      row[4] = -cos
      row[5] = -(sin * (rho - c.r) + cos * t)
      for (let a = 0; a < 6; a++) {
        jtf[a] += row[a] * e
        for (let b = a; b < 6; b++) jtj[a * 6 + b] += row[a] * row[b]
      }
      m++
    }
    if (m < 7) break
    for (let a = 0; a < 6; a++) for (let b = 0; b < a; b++) jtj[a * 6 + b] = jtj[b * 6 + a]

    let applied = false
    let converged = false
    for (let attempt = 0; attempt < 6; attempt++) {
      const mat = jtj.slice()
      for (let a = 0; a < 6; a++) mat[a * 6 + a] *= 1 + lambda
      const rhs = new Float64Array(6)
      for (let a = 0; a < 6; a++) rhs[a] = -jtf[a]
      const step = solveLinear(6, mat, rhs)
      if (!step) {
        lambda *= 10
        continue
      }
      const axis = normalize([
        c.ax + step[2] * u[0] + step[3] * v[0],
        c.ay + step[2] * u[1] + step[3] * v[1],
        c.az + step[2] * u[2] + step[3] * v[2],
      ])
      const cand: Cone = {
        px: c.px + step[0] * u[0] + step[1] * v[0],
        py: c.py + step[0] * u[1] + step[1] * v[1],
        pz: c.pz + step[0] * u[2] + step[1] * v[2],
        ax: axis[0],
        ay: axis[1],
        az: axis[2],
        r: c.r + step[4],
        phi: c.phi + step[5],
      }
      // Past ~85° the shape is a flat face and the parametrisation loses its
      // meaning; a negative radius means the step overshot the apex.
      if (!(cand.r > 0) || !Number.isFinite(cand.px) || !(Math.abs(cand.phi) < 1.48)) {
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
  return canonical(c)
}

export interface ClippedConeFit {
  cone: Cone
  /** RMS of the slant-normal residuals over the used points. */
  sigma: number
  /** Peak-to-peak residual — the surface's conicity. */
  span: number
  used: Uint32Array
}

/** Gaussian best-fit with GOM-style "used points" clipping (see
 *  `clippedRefit`). Each round re-seeds on the previous round's axis and then
 *  refines geometrically, so the axis carries over between clipping rounds
 *  instead of restarting from `init`. */
export function fitConeClipped(
  positions: Float32Array,
  idx: Uint32Array | ArrayLike<number>,
  init: Cone,
  k: number,
): ClippedConeFit | null {
  let start = init
  const r = clippedRefit<Cone>(
    positions,
    idx,
    k,
    (used) => {
      const seeded = fitConeOnAxis(positions, used, [start.ax, start.ay, start.az]) ?? start
      const c = refineConeGeometric(positions, used, seeded)
      if (!(c.r > 0) || !Number.isFinite(c.r) || !Number.isFinite(c.phi)) return null
      start = c
      return c
    },
    coneResidual,
  )
  return r && { cone: r.model, sigma: r.sigma, span: r.span, used: r.used }
}

export interface RansacConeResult {
  cone: Cone
  inliers: Uint32Array
  /** Robust noise estimate (1.4826 · median absolute residual). */
  sigma: number
}

/** Cone through three points with known surface normals: the apex is where
 *  the three tangent planes meet, the axis is normal to the plane through the
 *  three unit apex-to-point directions (they all make the half-angle with the
 *  axis, so they lie on one circle of directions), and the half-angle is the
 *  mean of those three angles. */
function coneFrom3(
  positions: Float32Array,
  normals: Float32Array,
  i0: number,
  i1: number,
  i2: number,
): Cone | null {
  const ids = [i0, i1, i2]
  const a = new Float64Array(9)
  const b = new Float64Array(3)
  for (let r = 0; r < 3; r++) {
    const j = ids[r] * 3
    a[r * 3] = normals[j]
    a[r * 3 + 1] = normals[j + 1]
    a[r * 3 + 2] = normals[j + 2]
    b[r] =
      normals[j] * positions[j] +
      normals[j + 1] * positions[j + 1] +
      normals[j + 2] * positions[j + 2]
  }
  const apex = solveLinear(3, a, b)
  if (!apex) return null

  const dirs: Vec3[] = []
  for (const id of ids) {
    const j = id * 3
    const dx = positions[j] - apex[0]
    const dy = positions[j + 1] - apex[1]
    const dz = positions[j + 2] - apex[2]
    const len = Math.hypot(dx, dy, dz)
    if (!(len > 1e-9)) return null
    dirs.push([dx / len, dy / len, dz / len])
  }
  const axisRaw = cross(
    [dirs[1][0] - dirs[0][0], dirs[1][1] - dirs[0][1], dirs[1][2] - dirs[0][2]],
    [dirs[2][0] - dirs[0][0], dirs[2][1] - dirs[0][1], dirs[2][2] - dirs[0][2]],
  )
  // Directions too alike leave the circle through them — the axis — anywhere.
  if (!(Math.hypot(axisRaw[0], axisRaw[1], axisRaw[2]) > 0.02)) return null
  let d = normalize(axisRaw)
  let dotSum = dirs[0][0] * d[0] + dirs[0][1] * d[1] + dirs[0][2] * d[2]
  dotSum += dirs[1][0] * d[0] + dirs[1][1] * d[1] + dirs[1][2] * d[2]
  dotSum += dirs[2][0] * d[0] + dirs[2][1] * d[1] + dirs[2][2] * d[2]
  if (dotSum < 0) d = [-d[0], -d[1], -d[2]]
  const phi = Math.acos(Math.min(1, Math.abs(dotSum) / 3))
  if (!(phi > 0.005) || !(phi < 1.48)) return null

  // Anchor the axis at the samples' mean axial position, where the region is.
  let tMean = 0
  for (const id of ids) {
    const j = id * 3
    tMean +=
      (positions[j] - apex[0]) * d[0] +
      (positions[j + 1] - apex[1]) * d[1] +
      (positions[j + 2] - apex[2]) * d[2]
  }
  tMean /= 3
  const r = tMean * Math.tan(phi)
  if (!(r > 0) || !Number.isFinite(r)) return null
  return {
    px: apex[0] + tMean * d[0],
    py: apex[1] + tMean * d[1],
    pz: apex[2] + tMean * d[2],
    ax: d[0],
    ay: d[1],
    az: d[2],
    r,
    phi,
  }
}

/** Robust cone estimate on a local patch: score the normal-plane axis plus a
 *  batch of three-point-with-normals candidates by median absolute residual
 *  (LMedS), then refine on the consensus set. */
export function ransacCone(
  positions: Float32Array,
  normals: Float32Array,
  patch: Uint32Array,
  opts: { iterations?: number; seed?: number } = {},
): RansacConeResult | null {
  const core = ransacConsensus<Cone>(positions, patch, opts, (diag, rand) => {
    const n = patch.length
    // A radius wildly out of scale with the local patch is really a plane,
    // never the cone the user clicked.
    const plausible = (c: Cone) => c.r > diag * 0.005 && c.r <= diag * 60 && Math.abs(c.phi) < 1.48
    const normalAxis = coneAxisFromNormals(normals, patch)
    const fromNormals = normalAxis && fitConeOnAxis(positions, patch, normalAxis)
    return {
      initial: fromNormals && plausible(fromNormals) ? fromNormals : null,
      generate: () => {
        const i0 = patch[(rand() * n) | 0]
        const i1 = patch[(rand() * n) | 0]
        const i2 = patch[(rand() * n) | 0]
        if (i0 === i1 || i0 === i2 || i1 === i2) return null
        const c = coneFrom3(positions, normals, i0, i1, i2)
        return c && plausible(c) ? c : null
      },
      residual: coneResidual,
    }
  })
  if (!core) return null

  const refined = fitConeClipped(positions, core.inliers, core.model, 3)
  if (!refined) return null
  return {
    cone: refined.cone,
    inliers: refined.used,
    sigma: Math.max(refined.sigma, core.sigmaEst, 1e-9),
  }
}

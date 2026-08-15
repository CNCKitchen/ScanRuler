// SPDX-License-Identifier: AGPL-3.0-only
import type { Plane } from '../types'
import { symmetricEigen3 } from './linalg'
import { mulberry32 } from './ransac'

/** Signed distance of a point from the plane (positive on the normal side). */
export function planeResidual(p: Plane, x: number, y: number, z: number): number {
  return p.nx * x + p.ny * y + p.nz * z - p.d
}

/** Total-least-squares plane: the centroid, plus the direction the points
 *  scatter least along as the normal. Exact — this *is* the Gaussian best-fit
 *  for a plane, so no iterative refinement step is needed. */
export function fitPlaneTLS(positions: Float32Array, idx: ArrayLike<number>): Plane | null {
  const n = idx.length
  if (n < 3) return null

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

  let cxx = 0, cxy = 0, cxz = 0, cyy = 0, cyz = 0, czz = 0
  for (let i = 0; i < n; i++) {
    const j = idx[i] * 3
    const x = positions[j] - mx
    const y = positions[j + 1] - my
    const z = positions[j + 2] - mz
    cxx += x * x
    cxy += x * y
    cxz += x * z
    cyy += y * y
    cyz += y * z
    czz += z * z
  }

  const { values, vectors } = symmetricEigen3([cxx, cxy, cxz, cxy, cyy, cyz, cxz, cyz, czz])
  // Collinear points leave the normal free to spin around the line they lie
  // on: the two smallest scatter directions are then equally small.
  if (!(values[1] > 1e-12 * values[2]) || !(values[2] > 0)) return null

  const [nx, ny, nz] = vectors[0]
  if (!Number.isFinite(nx)) return null
  return { nx, ny, nz, d: nx * mx + ny * my + nz * mz }
}

export interface ClippedPlaneFit {
  plane: Plane
  /** RMS of the point-to-plane distances over the used points. */
  sigma: number
  used: Uint32Array
}

/** Gaussian best-fit with GOM-style "used points" clipping: fit, discard
 *  residuals beyond k·sigma, refit, until the point set is stable.
 *  k = 0 means use all points. */
export function fitPlaneClipped(
  positions: Float32Array,
  idx: Uint32Array | ArrayLike<number>,
  k: number,
): ClippedPlaneFit | null {
  let used: Uint32Array = idx instanceof Uint32Array ? idx : Uint32Array.from(idx as ArrayLike<number>)
  let result: ClippedPlaneFit | null = null

  for (let iter = 0; iter < 12; iter++) {
    const p = fitPlaneTLS(positions, used)
    if (!p) return result

    let sumSq = 0
    const res = new Float64Array(used.length)
    for (let i = 0; i < used.length; i++) {
      const j = used[i] * 3
      const e = planeResidual(p, positions[j], positions[j + 1], positions[j + 2])
      res[i] = e
      sumSq += e * e
    }
    const sigma = Math.sqrt(sumSq / used.length)
    result = { plane: p, sigma, used }

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

export interface RansacPlaneResult {
  plane: Plane
  inliers: Uint32Array
  /** Robust noise estimate (1.4826 · median absolute residual). */
  sigma: number
}

/** Robust plane estimate on a local patch: sample 3-point candidate planes,
 *  score by median absolute residual (LMedS — no threshold parameter needed),
 *  then refine on the consensus set with a 3-sigma clipped Gaussian fit. A
 *  patch straddling an edge would drag a plain least-squares plane off the
 *  surface the user clicked; the median score ignores the smaller side. */
export function ransacPlane(
  positions: Float32Array,
  patch: Uint32Array,
  opts: { iterations?: number; seed?: number } = {},
): RansacPlaneResult | null {
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
  let bestMedian = Infinity
  let best: Plane | null = null
  // Three sampled points must span a real triangle to define a plane; the
  // area of a sliver is what makes the normal noise-dominated.
  const minArea = diag * diag * 1e-4

  for (let it = 0; it < iterations; it++) {
    const i0 = patch[(rand() * n) | 0]
    const i1 = patch[(rand() * n) | 0]
    const i2 = patch[(rand() * n) | 0]
    if (i0 === i1 || i0 === i2 || i1 === i2) continue
    const a = i0 * 3, b = i1 * 3, c = i2 * 3
    const ux = positions[b] - positions[a]
    const uy = positions[b + 1] - positions[a + 1]
    const uz = positions[b + 2] - positions[a + 2]
    const vx = positions[c] - positions[a]
    const vy = positions[c + 1] - positions[a + 1]
    const vz = positions[c + 2] - positions[a + 2]
    let nx = uy * vz - uz * vy
    let ny = uz * vx - ux * vz
    let nz = ux * vy - uy * vx
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
    if (!(len > minArea)) continue
    nx /= len
    ny /= len
    nz /= len
    const p: Plane = {
      nx,
      ny,
      nz,
      d: nx * positions[a] + ny * positions[a + 1] + nz * positions[a + 2],
    }

    for (let i = 0; i < scoreN; i++) {
      const j = subset[i] * 3
      resid[i] = Math.abs(planeResidual(p, positions[j], positions[j + 1], positions[j + 2]))
    }
    const sorted = resid.slice().sort()
    const med = sorted[scoreN >> 1]
    if (med < bestMedian) {
      bestMedian = med
      best = p
    }
  }

  if (!best) return null
  const sigmaEst = 1.4826 * bestMedian
  const thr = Math.max(3 * sigmaEst, diag * 1e-5)

  let count = 0
  for (let i = 0; i < n; i++) {
    const j = patch[i] * 3
    if (Math.abs(planeResidual(best, positions[j], positions[j + 1], positions[j + 2])) <= thr) count++
  }
  if (count < 30) return null

  const inliers = new Uint32Array(count)
  let w = 0
  for (let i = 0; i < n; i++) {
    const j = patch[i] * 3
    if (Math.abs(planeResidual(best, positions[j], positions[j + 1], positions[j + 2])) <= thr) {
      inliers[w++] = patch[i]
    }
  }

  const refined = fitPlaneClipped(positions, inliers, 3)
  if (!refined) return null
  return {
    plane: refined.plane,
    inliers: refined.used,
    sigma: Math.max(refined.sigma, sigmaEst, 1e-9),
  }
}

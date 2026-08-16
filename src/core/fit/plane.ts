// SPDX-License-Identifier: AGPL-3.0-only
import type { Plane } from '../types'
import { clippedRefit } from './clip'
import { symmetricEigen3 } from './linalg'
import { ransacConsensus } from './ransac'

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

/** Gaussian best-fit with GOM-style "used points" clipping (see
 *  `clippedRefit`), each round an exact TLS fit. */
export function fitPlaneClipped(
  positions: Float32Array,
  idx: Uint32Array | ArrayLike<number>,
  k: number,
): ClippedPlaneFit | null {
  const r = clippedRefit<Plane>(positions, idx, k, (used) => fitPlaneTLS(positions, used), planeResidual)
  return r && { plane: r.model, sigma: r.sigma, used: r.used }
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
  const core = ransacConsensus<Plane>(positions, patch, opts, (diag, rand) => {
    const n = patch.length
    // Three sampled points must span a real triangle to define a plane; the
    // area of a sliver is what makes the normal noise-dominated.
    const minArea = diag * diag * 1e-4
    return {
      generate: () => {
        const i0 = patch[(rand() * n) | 0]
        const i1 = patch[(rand() * n) | 0]
        const i2 = patch[(rand() * n) | 0]
        if (i0 === i1 || i0 === i2 || i1 === i2) return null
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
        if (!(len > minArea)) return null
        nx /= len
        ny /= len
        nz /= len
        return {
          nx,
          ny,
          nz,
          d: nx * positions[a] + ny * positions[a + 1] + nz * positions[a + 2],
        }
      },
      residual: planeResidual,
    }
  })
  if (!core) return null

  const refined = fitPlaneClipped(positions, core.inliers, 3)
  if (!refined) return null
  return {
    plane: refined.plane,
    inliers: refined.used,
    sigma: Math.max(refined.sigma, core.sigmaEst, 1e-9),
  }
}

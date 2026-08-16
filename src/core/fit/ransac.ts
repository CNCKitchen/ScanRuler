// SPDX-License-Identifier: AGPL-3.0-only
import type { Sphere } from '../types'
import { solveLinear } from './linalg'
import { fitSphereClipped } from './sphere'

/** Deterministic PRNG so fits are reproducible for identical input. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface RansacConsensus<M> {
  model: M
  inliers: Uint32Array
  /** Robust noise estimate (1.4826 · median absolute residual). */
  sigmaEst: number
}

/** Shared scaffolding for the robust shape estimators (LMedS — no threshold
 *  parameter needed): every candidate is scored by its median absolute
 *  residual over an at-most-512-point strided subset of the patch, and the
 *  winner's consensus set is everything within 3·1.4826·median of it, floored
 *  at a hundred-thousandth of the patch diagonal so a perfectly clean patch
 *  does not gate on zero. What a candidate is and how one is sampled stays
 *  with each shape; `shape` receives the patch's bounding-box diagonal (for
 *  scale sanity checks) and the PRNG, and returns the candidate generator, an
 *  optional deterministic candidate to score before the sampled ones, and the
 *  signed residual. The caller refines the consensus set itself — plane,
 *  sphere and cylinder each have their own refinement. */
export function ransacConsensus<M>(
  positions: Float32Array,
  patch: Uint32Array,
  opts: { iterations?: number; seed?: number },
  shape: (diag: number, rand: () => number) => {
    initial?: M | null
    generate: () => M | null
    residual: (m: M, x: number, y: number, z: number) => number
  },
): RansacConsensus<M> | null {
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

  const { initial, generate, residual } = shape(diag, rand)

  const scoreN = Math.min(n, 512)
  const stride = n / scoreN
  const subset = new Uint32Array(scoreN)
  for (let i = 0; i < scoreN; i++) subset[i] = patch[Math.floor(i * stride)]

  // One scratch buffer serves every candidate: the residuals are not needed
  // after the median is read, so it can be sorted in place instead of copied.
  const resid = new Float64Array(scoreN)
  const medianResidual = (m: M): number => {
    for (let i = 0; i < scoreN; i++) {
      const j = subset[i] * 3
      resid[i] = Math.abs(residual(m, positions[j], positions[j + 1], positions[j + 2]))
    }
    resid.sort()
    return resid[scoreN >> 1]
  }

  let bestMedian = Infinity
  let best: M | null = null

  if (initial != null) {
    const med = medianResidual(initial)
    if (med < bestMedian) {
      bestMedian = med
      best = initial
    }
  }

  for (let it = 0; it < iterations; it++) {
    const m = generate()
    if (m === null) continue
    const med = medianResidual(m)
    if (med < bestMedian) {
      bestMedian = med
      best = m
    }
  }

  if (!best) return null
  const sigmaEst = 1.4826 * bestMedian
  const thr = Math.max(3 * sigmaEst, diag * 1e-5)

  let count = 0
  for (let i = 0; i < n; i++) {
    const j = patch[i] * 3
    const e = residual(best, positions[j], positions[j + 1], positions[j + 2])
    if (Math.abs(e) <= thr) count++
  }
  if (count < 30) return null

  const inliers = new Uint32Array(count)
  let w = 0
  for (let i = 0; i < n; i++) {
    const j = patch[i] * 3
    const e = residual(best, positions[j], positions[j + 1], positions[j + 2])
    if (Math.abs(e) <= thr) inliers[w++] = patch[i]
  }

  return { model: best, inliers, sigmaEst }
}

/** Exact sphere through 4 points (null when near-coplanar). */
function sphereFrom4(positions: Float32Array, i0: number, i1: number, i2: number, i3: number): Sphere | null {
  const p = (i: number, c: number) => positions[i * 3 + c]
  const x0 = p(i0, 0), y0 = p(i0, 1), z0 = p(i0, 2)
  const a = new Float64Array(9)
  const b = new Float64Array(3)
  const ids = [i1, i2, i3]
  for (let r = 0; r < 3; r++) {
    const qx = p(ids[r], 0) - x0
    const qy = p(ids[r], 1) - y0
    const qz = p(ids[r], 2) - z0
    a[r * 3] = 2 * qx
    a[r * 3 + 1] = 2 * qy
    a[r * 3 + 2] = 2 * qz
    b[r] = qx * qx + qy * qy + qz * qz
  }
  const c = solveLinear(3, a, b)
  if (!c) return null
  const r = Math.sqrt(c[0] * c[0] + c[1] * c[1] + c[2] * c[2])
  if (!Number.isFinite(r) || r <= 0) return null
  return { cx: x0 + c[0], cy: y0 + c[1], cz: z0 + c[2], r }
}

export interface RansacResult {
  sphere: Sphere
  inliers: Uint32Array
  /** Robust noise estimate (1.4826 · median absolute residual). */
  sigma: number
}

/** Robust sphere estimate on a local patch: sample 4-point candidate spheres,
 *  score by median absolute residual (LMedS — no threshold parameter needed),
 *  then refine on the consensus set with a 3-sigma clipped Gaussian fit. */
export function ransacSphere(
  positions: Float32Array,
  patch: Uint32Array,
  opts: { iterations?: number; seed?: number } = {},
): RansacResult | null {
  const core = ransacConsensus<Sphere>(positions, patch, opts, (diag, rand) => {
    const n = patch.length
    return {
      generate: () => {
        const i0 = patch[(rand() * n) | 0]
        const i1 = patch[(rand() * n) | 0]
        const i2 = patch[(rand() * n) | 0]
        const i3 = patch[(rand() * n) | 0]
        if (i0 === i1 || i0 === i2 || i0 === i3 || i1 === i2 || i1 === i3 || i2 === i3) return null
        const s = sphereFrom4(positions, i0, i1, i2, i3)
        if (!s) return null
        // A candidate wildly out of scale with the local patch is never the
        // sphere the user clicked.
        if (s.r > diag * 200 || s.r < diag * 0.02) return null
        return s
      },
      residual: (s, x, y, z) => {
        const dx = x - s.cx
        const dy = y - s.cy
        const dz = z - s.cz
        return Math.sqrt(dx * dx + dy * dy + dz * dz) - s.r
      },
    }
  })
  if (!core) return null

  const refined = fitSphereClipped(positions, core.inliers, 3)
  if (!refined) return null
  return {
    sphere: refined.sphere,
    inliers: refined.used,
    sigma: Math.max(refined.sigma, core.sigmaEst, 1e-9),
  }
}

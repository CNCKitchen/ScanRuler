// SPDX-License-Identifier: AGPL-3.0-only
import type { Vec3 } from '../types'

/** Gaussian elimination with partial pivoting; a is n×n row-major, mutated. */
export function solveLinear(n: number, a: Float64Array, b: Float64Array): Float64Array | null {
  let maxAbs = 0
  for (let i = 0; i < n * n; i++) maxAbs = Math.max(maxAbs, Math.abs(a[i]))
  const tiny = Math.max(maxAbs, 1) * 1e-13

  const x = b.slice()
  for (let col = 0; col < n; col++) {
    let pivotRow = col
    let best = Math.abs(a[col * n + col])
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(a[r * n + col])
      if (v > best) {
        best = v
        pivotRow = r
      }
    }
    if (best < tiny) return null
    if (pivotRow !== col) {
      for (let c = col; c < n; c++) {
        const t = a[col * n + c]
        a[col * n + c] = a[pivotRow * n + c]
        a[pivotRow * n + c] = t
      }
      const t = x[col]
      x[col] = x[pivotRow]
      x[pivotRow] = t
    }
    const piv = a[col * n + col]
    for (let r = col + 1; r < n; r++) {
      const f = a[r * n + col] / piv
      if (f === 0) continue
      for (let c = col; c < n; c++) a[r * n + c] -= f * a[col * n + c]
      x[r] -= f * x[col]
    }
  }
  for (let row = n - 1; row >= 0; row--) {
    let s = x[row]
    for (let c = row + 1; c < n; c++) s -= a[row * n + c] * x[c]
    x[row] = s / a[row * n + row]
  }
  return x
}

export interface Eigen3 {
  /** Eigenvalues in ascending order. */
  values: [number, number, number]
  /** Matching unit eigenvectors. */
  vectors: [Vec3, Vec3, Vec3]
}

/** Eigen decomposition of a symmetric 3×3 matrix (row-major, 9 entries) by
 *  cyclic Jacobi rotations. Plane and cylinder fitting both reduce to "which
 *  direction does this cloud of points / normals scatter least along", which
 *  is exactly the smallest eigenvector. */
export function symmetricEigen3(input: ArrayLike<number>): Eigen3 {
  const a = Float64Array.from(input, Number)
  const v = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1])
  const pairs: [number, number][] = [
    [0, 1],
    [0, 2],
    [1, 2],
  ]

  for (let sweep = 0; sweep < 32; sweep++) {
    const off = Math.abs(a[1]) + Math.abs(a[2]) + Math.abs(a[5])
    const diag = Math.abs(a[0]) + Math.abs(a[4]) + Math.abs(a[8])
    if (off <= 1e-18 * diag || off === 0) break
    for (const [p, q] of pairs) {
      const apq = a[p * 3 + q]
      if (apq === 0) continue
      // Rotation angle that zeroes the (p,q) entry.
      const theta = (a[q * 3 + q] - a[p * 3 + p]) / (2 * apq)
      const sign = theta >= 0 ? 1 : -1
      const t = sign / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
      const c = 1 / Math.sqrt(t * t + 1)
      const s = t * c
      for (let k = 0; k < 3; k++) {
        const akp = a[k * 3 + p]
        const akq = a[k * 3 + q]
        a[k * 3 + p] = c * akp - s * akq
        a[k * 3 + q] = s * akp + c * akq
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p * 3 + k]
        const aqk = a[q * 3 + k]
        a[p * 3 + k] = c * apk - s * aqk
        a[q * 3 + k] = s * apk + c * aqk
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k * 3 + p]
        const vkq = v[k * 3 + q]
        v[k * 3 + p] = c * vkp - s * vkq
        v[k * 3 + q] = s * vkp + c * vkq
      }
    }
  }

  const order = [0, 1, 2].sort((i, j) => a[i * 3 + i] - a[j * 3 + j])
  const values = order.map((i) => a[i * 3 + i]) as [number, number, number]
  const vectors = order.map((i) => normalize([v[i], v[3 + i], v[6 + i]])) as [Vec3, Vec3, Vec3]
  return { values, vectors }
}

export interface EigenN {
  /** Eigenvalues in ascending order. */
  values: number[]
  /** Matching unit eigenvectors, `vectors[i]` belonging to `values[i]`. */
  vectors: number[][]
}

/** Eigen decomposition of a symmetric n×n matrix (row-major) by cyclic Jacobi
 *  rotations — the same sweep as `symmetricEigen3`, for the sizes that one
 *  cannot serve. Absolute orientation needs the 4×4 case: Horn's closed-form
 *  solution reads the best-fit rotation off the largest eigenvector of a 4×4
 *  built from the point cross-covariance. */
export function symmetricEigenN(n: number, input: ArrayLike<number>): EigenN {
  const a = Float64Array.from(input, Number)
  const v = new Float64Array(n * n)
  for (let i = 0; i < n; i++) v[i * n + i] = 1

  for (let sweep = 0; sweep < 64; sweep++) {
    let off = 0
    let diag = 0
    for (let p = 0; p < n; p++) {
      diag += Math.abs(a[p * n + p])
      for (let q = p + 1; q < n; q++) off += Math.abs(a[p * n + q])
    }
    if (off === 0 || off <= 1e-18 * diag) break
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q]
        if (apq === 0) continue
        // Rotation angle that zeroes the (p,q) entry.
        const theta = (a[q * n + q] - a[p * n + p]) / (2 * apq)
        const sign = theta >= 0 ? 1 : -1
        const t = sign / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p]
          const akq = a[k * n + q]
          a[k * n + p] = c * akp - s * akq
          a[k * n + q] = s * akp + c * akq
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k]
          const aqk = a[q * n + k]
          a[p * n + k] = c * apk - s * aqk
          a[q * n + k] = s * apk + c * aqk
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k * n + p]
          const vkq = v[k * n + q]
          v[k * n + p] = c * vkp - s * vkq
          v[k * n + q] = s * vkp + c * vkq
        }
      }
    }
  }

  const order = Array.from({ length: n }, (_, i) => i).sort(
    (i, j) => a[i * n + i] - a[j * n + j],
  )
  return {
    values: order.map((i) => a[i * n + i]),
    vectors: order.map((i) => {
      const col: number[] = []
      let len = 0
      for (let k = 0; k < n; k++) {
        col.push(v[k * n + i])
        len += v[k * n + i] * v[k * n + i]
      }
      len = Math.sqrt(len)
      return len > 1e-20 ? col.map((x) => x / len) : col
    }),
  }
}

export function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2])
  if (!(len > 1e-20)) return [0, 0, 1]
  return [v[0] / len, v[1] / len, v[2] / len]
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/** Any two unit vectors completing `n` into a right-handed frame. */
export function orthoBasis(n: Vec3): [Vec3, Vec3] {
  const ax = Math.abs(n[0])
  const ay = Math.abs(n[1])
  const az = Math.abs(n[2])
  const helper: Vec3 = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1]
  const u = normalize(cross(n, helper))
  const v = normalize(cross(n, u))
  return [u, v]
}

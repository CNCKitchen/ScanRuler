// SPDX-License-Identifier: AGPL-3.0-only
import { cross, normalize, symmetricEigen3 } from '../fit/linalg'
import type { Vec3 } from '../types'
import { rigidApply, type Rigid } from './rigid'

export interface PrincipalFrame {
  centroid: Vec3
  /** Unit axes in descending order of scatter, right-handed. */
  axes: [Vec3, Vec3, Vec3]
  /** Scatter along each axis, descending — a flat plate has a near-zero third,
   *  a bar two near-equal smaller ones. */
  spread: [number, number, number]
}

/** Centroid and principal axes of a point cloud (every `stride`-th point). */
export function principalFrame(xyz: ArrayLike<number>, stride = 1): PrincipalFrame {
  const total = Math.floor(xyz.length / 3)
  let mx = 0, my = 0, mz = 0, n = 0
  for (let v = 0; v < total; v += stride) {
    mx += xyz[v * 3]
    my += xyz[v * 3 + 1]
    mz += xyz[v * 3 + 2]
    n++
  }
  if (n === 0) {
    return {
      centroid: [0, 0, 0],
      axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
      spread: [0, 0, 0],
    }
  }
  mx /= n; my /= n; mz /= n

  const c = new Float64Array(9)
  for (let v = 0; v < total; v += stride) {
    const x = xyz[v * 3] - mx
    const y = xyz[v * 3 + 1] - my
    const z = xyz[v * 3 + 2] - mz
    c[0] += x * x; c[1] += x * y; c[2] += x * z
    c[4] += y * y; c[5] += y * z
    c[8] += z * z
  }
  c[3] = c[1]; c[6] = c[2]; c[7] = c[5]
  for (let i = 0; i < 9; i++) c[i] /= n

  // symmetricEigen3 returns ascending; the dominant axis is last.
  const eig = symmetricEigen3(c)
  const a0 = normalize(eig.vectors[2])
  let a1 = eig.vectors[1]
  // Re-orthogonalise against a0, then complete right-handed, so the frame is a
  // proper rotation even when two eigenvalues are nearly equal and Jacobi has
  // returned a slightly skewed pair.
  const d = a0[0] * a1[0] + a0[1] * a1[1] + a0[2] * a1[2]
  a1 = normalize([a1[0] - d * a0[0], a1[1] - d * a0[1], a1[2] - d * a0[2]])
  const a2 = normalize(cross(a0, a1))

  return {
    centroid: [mx, my, mz],
    axes: [a0, a1, a2],
    spread: [
      Math.sqrt(Math.max(0, eig.values[2])),
      Math.sqrt(Math.max(0, eig.values[1])),
      Math.sqrt(Math.max(0, eig.values[0])),
    ],
  }
}

/** The rigid transform carrying one principal frame onto another. */
function frameToFrame(from: PrincipalFrame, fromAxes: [Vec3, Vec3, Vec3], to: PrincipalFrame): Rigid {
  const r = new Float64Array(9)
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] =
        to.axes[0][i] * fromAxes[0][j] +
        to.axes[1][i] * fromAxes[1][j] +
        to.axes[2][i] * fromAxes[2][j]
    }
  }
  const m: Rigid = { r, t: new Float64Array(3) }
  const rc = new Float64Array(3)
  rigidApply(m, from.centroid[0], from.centroid[1], from.centroid[2], rc)
  m.t[0] = to.centroid[0] - rc[0]
  m.t[1] = to.centroid[1] - rc[1]
  m.t[2] = to.centroid[2] - rc[2]
  return m
}

/**
 * Starting poses to try when nothing is known about how the scan is placed.
 *
 * Matching principal axes puts the two parts in the same attitude — but only
 * up to the 24 rotations of a cube, and every one of them has to be tried.
 *
 * Two things are undetermined. An eigenvector has no sign, since a1 and −a1
 * describe the same axis of scatter. And when two principal moments are close
 * their *order* is arbitrary, which is the case that actually bites: a part
 * whose bounding box is 112 × 91 × 102 is nearly cubic, so a partial scan of
 * it can easily rank its axes differently from the whole part, and then no
 * amount of sign flipping recovers the right pose — the axes have to be
 * permuted as well.
 *
 * Choosing which scan axis maps to the nominal's first (6 ways, counting sign)
 * and which to its second (4 remaining) fixes the third by right-handedness,
 * giving 24 candidates, of which exactly one is the part the right way up.
 *
 * All of this is only a starting guess. The scan is typically a *partial*
 * capture — a structured-light run sees maybe half the surface of a part with
 * bores and pockets — so its centroid and inertia are genuinely not the
 * nominal's, and the guess merely has to land in the right basin.
 */
export function preAlignCandidates(scan: PrincipalFrame, nominal: PrincipalFrame): Rigid[] {
  const signed: Vec3[] = []
  for (const axis of scan.axes) {
    signed.push(axis, [-axis[0], -axis[1], -axis[2]])
  }
  const out: Rigid[] = []
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 6; j++) {
      // Skip the same axis and its own negation: a1 must be a different axis.
      if ((i >> 1) === (j >> 1)) continue
      const a0 = signed[i]
      const a1 = signed[j]
      out.push(frameToFrame(scan, [a0, a1, normalize(cross(a0, a1))], nominal))
    }
  }
  return out
}

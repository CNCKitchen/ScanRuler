// SPDX-License-Identifier: AGPL-3.0-only
import { symmetricEigenN } from '../fit/linalg'
import type { Vec3 } from '../types'
import { identityRigid, rigidApply, rigidFromQuaternion, type Rigid } from './rigid'

export interface AbsoluteOrientation {
  transform: Rigid
  /** RMS distance left between the moved source points and their targets. */
  rms: number
  /** How well the picked points span a plane: the ratio of the second largest
   *  to the largest eigenvalue of their scatter, so 1 is an ideal spread and 0
   *  means they lie on a line — and three clicks along one edge leave the
   *  rotation about that edge completely unconstrained. */
  conditioning: number
}

/** Best-fit rigid transform taking `source` onto `target`, one point per pair.
 *
 *  Horn's closed-form absolute orientation: the optimal rotation is the
 *  eigenvector of the largest eigenvalue of a 4×4 built from the centred
 *  cross-covariance, read as a quaternion. Unlike the SVD route it can never
 *  return a reflection, which matters here because the user supplies only
 *  three or four hand-clicked pairs and a mirrored "solution" would look
 *  plausible right up until the deviation map came out inside-out.
 *
 *  Returns null for fewer than three pairs. */
export function absoluteOrientation(
  source: Vec3[],
  target: Vec3[],
): AbsoluteOrientation | null {
  const n = Math.min(source.length, target.length)
  if (n < 3) return null

  const ca: Vec3 = [0, 0, 0]
  const cb: Vec3 = [0, 0, 0]
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      ca[k] += source[i][k]
      cb[k] += target[i][k]
    }
  }
  for (let k = 0; k < 3; k++) {
    ca[k] /= n
    cb[k] /= n
  }

  // Cross-covariance S of the centred clouds, and the scatter of the source
  // alone (for the degeneracy check).
  let sxx = 0, sxy = 0, sxz = 0
  let syx = 0, syy = 0, syz = 0
  let szx = 0, szy = 0, szz = 0
  const scatter = new Float64Array(9)
  for (let i = 0; i < n; i++) {
    const ax = source[i][0] - ca[0]
    const ay = source[i][1] - ca[1]
    const az = source[i][2] - ca[2]
    const bx = target[i][0] - cb[0]
    const by = target[i][1] - cb[1]
    const bz = target[i][2] - cb[2]
    sxx += ax * bx; sxy += ax * by; sxz += ax * bz
    syx += ay * bx; syy += ay * by; syz += ay * bz
    szx += az * bx; szy += az * by; szz += az * bz
    const v = [ax, ay, az]
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) scatter[r * 3 + c] += v[r] * v[c]
  }

  const nMat = [
    sxx + syy + szz, syz - szy, szx - sxz, sxy - syx,
    syz - szy, sxx - syy - szz, sxy + syx, szx + sxz,
    szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy,
    sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz,
  ]
  const eig = symmetricEigenN(4, nMat)
  const q = eig.vectors[3] // largest eigenvalue last — ascending order
  const transform = rigidFromQuaternion(q[0], q[1], q[2], q[3])

  // t = b̄ − R·ā
  const ra = new Float64Array(3)
  rigidApply(transform, ca[0], ca[1], ca[2], ra)
  transform.t[0] = cb[0] - ra[0]
  transform.t[1] = cb[1] - ra[1]
  transform.t[2] = cb[2] - ra[2]

  let sum = 0
  const p = new Float64Array(3)
  for (let i = 0; i < n; i++) {
    rigidApply(transform, source[i][0], source[i][1], source[i][2], p)
    sum +=
      (p[0] - target[i][0]) ** 2 + (p[1] - target[i][1]) ** 2 + (p[2] - target[i][2]) ** 2
  }

  const s = symmetricEigenN(3, scatter).values
  const conditioning = s[2] > 1e-12 ? s[1] / s[2] : 0

  return { transform, rms: Math.sqrt(sum / n), conditioning }
}

/** Absolute orientation of two flat arrays of xyz triples, used inside ICP
 *  where the correspondences are already packed. Falls back to the identity
 *  when the solve degenerates. */
export function absoluteOrientationPacked(
  source: Float64Array,
  target: Float64Array,
  count: number,
): Rigid {
  const a: Vec3[] = []
  const b: Vec3[] = []
  for (let i = 0; i < count; i++) {
    a.push([source[i * 3], source[i * 3 + 1], source[i * 3 + 2]])
    b.push([target[i * 3], target[i * 3 + 1], target[i * 3 + 2]])
  }
  return absoluteOrientation(a, b)?.transform ?? identityRigid()
}

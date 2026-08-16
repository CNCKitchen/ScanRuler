// SPDX-License-Identifier: AGPL-3.0-only
import type { Vec3 } from '../types'

/** A rigid body motion `p ↦ R·p + t`, with R a proper rotation (det = +1).
 *
 *  R is row-major, so `r[row * 3 + col]`. Everything here is double precision
 *  on purpose: an alignment is accumulated over dozens of ICP increments, and
 *  float32 drift in the rotation shows up later as micrometres of deviation
 *  that are not on the part. */
export interface Rigid {
  r: Float64Array
  t: Float64Array
}

export function identityRigid(): Rigid {
  return { r: Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]), t: new Float64Array(3) }
}

export function cloneRigid(m: Rigid): Rigid {
  return { r: m.r.slice(), t: m.t.slice() }
}

/** Rotation from a unit quaternion given as (w, x, y, z). */
export function rigidFromQuaternion(w: number, x: number, y: number, z: number): Rigid {
  const n = Math.hypot(w, x, y, z)
  if (!(n > 1e-20)) return identityRigid()
  w /= n
  x /= n
  y /= n
  z /= n
  return {
    r: Float64Array.from([
      1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
      2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
      2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
    ]),
    t: new Float64Array(3),
  }
}

/** Rotation of `angle` radians about a (not necessarily unit) axis — the
 *  exponential map used to turn an ICP increment back into a rotation, and to
 *  build known transforms in tests. */
export function rigidFromAxisAngle(axis: Vec3, angle: number): Rigid {
  const len = Math.hypot(axis[0], axis[1], axis[2])
  if (!(len > 1e-20) || !(Math.abs(angle) > 1e-20)) return identityRigid()
  const half = angle / 2
  const s = Math.sin(half) / len
  return rigidFromQuaternion(Math.cos(half), axis[0] * s, axis[1] * s, axis[2] * s)
}

/** The rotation whose axis-angle vector is `w` (‖w‖ = angle), plus `t`. */
export function rigidFromTwist(w: Vec3, t: Vec3): Rigid {
  const angle = Math.hypot(w[0], w[1], w[2])
  const m = angle > 1e-20 ? rigidFromAxisAngle(w, angle) : identityRigid()
  m.t.set(t)
  return m
}

export function rigidApply(m: Rigid, x: number, y: number, z: number, out: Float64Array): void {
  const r = m.r
  out[0] = r[0] * x + r[1] * y + r[2] * z + m.t[0]
  out[1] = r[3] * x + r[4] * y + r[5] * z + m.t[1]
  out[2] = r[6] * x + r[7] * y + r[8] * z + m.t[2]
}

/** Rotate a direction (translation ignored) — normals move this way. */
export function rigidRotate(m: Rigid, x: number, y: number, z: number, out: Float64Array): void {
  const r = m.r
  out[0] = r[0] * x + r[1] * y + r[2] * z
  out[1] = r[3] * x + r[4] * y + r[5] * z
  out[2] = r[6] * x + r[7] * y + r[8] * z
}

/** `a ∘ b`: apply b first, then a. */
export function rigidCompose(a: Rigid, b: Rigid): Rigid {
  const r = new Float64Array(9)
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = a.r[i * 3] * b.r[j] + a.r[i * 3 + 1] * b.r[3 + j] + a.r[i * 3 + 2] * b.r[6 + j]
    }
  }
  const t = new Float64Array(3)
  rigidApply(a, b.t[0], b.t[1], b.t[2], t)
  return { r, t }
}

export function rigidInvert(m: Rigid): Rigid {
  // For a rotation, the inverse is the transpose.
  const r = Float64Array.from([
    m.r[0], m.r[3], m.r[6],
    m.r[1], m.r[4], m.r[7],
    m.r[2], m.r[5], m.r[8],
  ])
  const inv = { r, t: new Float64Array(3) }
  const t = new Float64Array(3)
  rigidRotate(inv, m.t[0], m.t[1], m.t[2], t)
  inv.t[0] = -t[0]
  inv.t[1] = -t[1]
  inv.t[2] = -t[2]
  return inv
}

/** Column-major 16-element form, ready for `THREE.Matrix4.fromArray`. */
export function rigidToColumnMajor(m: Rigid): number[] {
  const r = m.r
  return [
    r[0], r[3], r[6], 0,
    r[1], r[4], r[7], 0,
    r[2], r[5], r[8], 0,
    m.t[0], m.t[1], m.t[2], 1,
  ]
}

/** Transform a packed xyz array in place — baking an alignment into mesh
 *  vertices. Shared by the worker and the scene so both copies of the scan
 *  stay bit-identical. */
export function rigidApplyToPoints(m: Rigid, xyz: Float32Array): void {
  const r = m.r
  const t = m.t
  for (let i = 0; i < xyz.length; i += 3) {
    const x = xyz[i]
    const y = xyz[i + 1]
    const z = xyz[i + 2]
    xyz[i] = r[0] * x + r[1] * y + r[2] * z + t[0]
    xyz[i + 1] = r[3] * x + r[4] * y + r[5] * z + t[1]
    xyz[i + 2] = r[6] * x + r[7] * y + r[8] * z + t[2]
  }
}

/** Rotate a packed direction array in place (translation ignored) — normals. */
export function rigidRotateVectors(m: Rigid, xyz: Float32Array): void {
  const r = m.r
  for (let i = 0; i < xyz.length; i += 3) {
    const x = xyz[i]
    const y = xyz[i + 1]
    const z = xyz[i + 2]
    xyz[i] = r[0] * x + r[1] * y + r[2] * z
    xyz[i + 1] = r[3] * x + r[4] * y + r[5] * z
    xyz[i + 2] = r[6] * x + r[7] * y + r[8] * z
  }
}

/** Rotation magnitude in radians — how far a transform actually turns the
 *  part, used both as an ICP convergence test and to report an alignment.
 *
 *  From `atan2(sin, cos)` rather than `acos((tr − 1) / 2)`: near the identity
 *  the cosine is flat, so acos loses half its significant digits there and
 *  reports microradians of rotation for a transform that is exactly the
 *  identity — precisely the regime a convergence test lives in. */
export function rigidRotationAngle(m: Rigid): number {
  const r = m.r
  const sin = Math.hypot(r[7] - r[5], r[2] - r[6], r[3] - r[1]) / 2
  const cos = (r[0] + r[4] + r[8] - 1) / 2
  return Math.atan2(sin, cos)
}

/**
 * How far apart two transforms actually place a part, in millimetres: the
 * largest distance between `a(p)` and `b(p)` over a ball of `radius` about
 * `center` that contains the part.
 *
 * The tempting shortcut — rotation angle times radius, plus the difference in
 * translation — badly overstates it. A rotation about a point far from the
 * origin carries a large translation component purely as bookkeeping, so that
 * sum counts the same motion twice and reports millimetres of disagreement
 * between two transforms that place every point on the part within a micron
 * of each other.
 */
export function rigidDisagreement(a: Rigid, b: Rigid, center: Vec3, radius: number): number {
  // a(p) − b(p) = (Ra − Rb)·p + (ta − tb): affine in p, so the extreme over a
  // ball is the value at the centre plus the operator norm times the radius.
  const d = new Float64Array(9)
  for (let i = 0; i < 9; i++) d[i] = a.r[i] - b.r[i]
  const atCenter = Math.hypot(
    d[0] * center[0] + d[1] * center[1] + d[2] * center[2] + a.t[0] - b.t[0],
    d[3] * center[0] + d[4] * center[1] + d[5] * center[2] + a.t[1] - b.t[1],
    d[6] * center[0] + d[7] * center[1] + d[8] * center[2] + a.t[2] - b.t[2],
  )
  // ‖Ra − Rb‖₂ = 2·sin(θ/2) for the angle θ between the two rotations.
  const relative = rigidCompose(rigidInvert(a), b)
  return atCenter + 2 * Math.sin(rigidRotationAngle(relative) / 2) * radius
}

/** Nearest proper rotation to a 3×3 matrix, by Newton iteration towards
 *  orthogonality. ICP increments are exact rotations already, but the
 *  accumulated product drifts, and an R that is no longer orthogonal quietly
 *  scales the part. */
export function reorthonormalize(m: Rigid): Rigid {
  const r = m.r.slice()
  for (let iter = 0; iter < 12; iter++) {
    // Rᵢ₊₁ = ½ (R + R⁻ᵀ); for a near-rotation R⁻ᵀ ≈ R, so this converges fast.
    const det =
      r[0] * (r[4] * r[8] - r[5] * r[7]) -
      r[1] * (r[3] * r[8] - r[5] * r[6]) +
      r[2] * (r[3] * r[7] - r[4] * r[6])
    if (!(Math.abs(det) > 1e-12)) break
    // R⁻ᵀ = cofactor(R) / det
    const inv = [
      (r[4] * r[8] - r[5] * r[7]) / det,
      (r[5] * r[6] - r[3] * r[8]) / det,
      (r[3] * r[7] - r[4] * r[6]) / det,
      (r[2] * r[7] - r[1] * r[8]) / det,
      (r[0] * r[8] - r[2] * r[6]) / det,
      (r[1] * r[6] - r[0] * r[7]) / det,
      (r[1] * r[5] - r[2] * r[4]) / det,
      (r[2] * r[3] - r[0] * r[5]) / det,
      (r[0] * r[4] - r[1] * r[3]) / det,
    ]
    let delta = 0
    for (let i = 0; i < 9; i++) {
      const next = 0.5 * (r[i] + inv[i])
      delta += Math.abs(next - r[i])
      r[i] = next
    }
    if (delta < 1e-15) break
  }
  return { r, t: m.t.slice() }
}

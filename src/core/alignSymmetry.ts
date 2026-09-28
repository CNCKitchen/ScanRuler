// SPDX-License-Identifier: AGPL-3.0-only
// A pose put on the part's own symmetry.
//
// An alignment read off faces — by hand or by Auto-align — leaves a
// symmetric part a little off its middle: the zero point sits where a corner
// or a box centre put it, and the axes lean by whatever the faces were
// scanned off by. The mirror plane found by registration (core/symmetry.ts)
// is the part's own, averaged over the whole surface. So a pose is settled
// on it: the coordinate axis nearest the plane's normal is turned onto the
// normal, the other two are squared up again with the least change — what
// stands up stays up unless it is the axis that was turned — and the zero
// point is dropped onto the plane. The plane then is a coordinate plane of
// the part: a sketch on it is a sketch on the middle, a Mirror about it
// closes on itself.

import type { Rigid } from './deviation/rigid'
import type { Vec3 } from './types'
import { addScaled, cross, dot, normalize, scale, sub } from './vec'

/** How far the mirror image may stand off the scan, RMS, for the plane to
 *  settle a pose: looser than what a Mirror defaults to (SYMMETRY_MAX_RMS_MM)
 *  — a part symmetric but for a boss still has a middle worth zeroing on,
 *  and the note says when the match was loose. */
export const ALIGN_SYMMETRY_MAX_RMS_MM = 0.5

export interface SymmetryPose {
  axes: [Vec3, Vec3, Vec3]
  origin: Vec3
  /** Which axis the plane's normal became: 0, 1 or 2 for X, Y, Z. */
  axis: 0 | 1 | 2
  /** How far that axis was turned, degrees, and the zero point moved, mm. */
  tiltDeg: number
  shiftMm: number
}

/** The axes and the zero point a rigid motion `p ↦ R·p + t` gives the part,
 *  in the frame the part is in now: the rows of R, and the point that lands
 *  on 0, 0, 0. */
export function poseOfRigid(m: Rigid): { axes: [Vec3, Vec3, Vec3]; origin: Vec3 } {
  const row = (i: number): Vec3 => [m.r[i * 3], m.r[i * 3 + 1], m.r[i * 3 + 2]]
  const axes: [Vec3, Vec3, Vec3] = [row(0), row(1), row(2)]
  // R·o + t = 0, and R⁻¹ is Rᵀ.
  const origin: Vec3 = [0, 1, 2].map((c) => -(m.r[c] * m.t[0] + m.r[3 + c] * m.t[1] + m.r[6 + c] * m.t[2])) as Vec3
  return { axes, origin }
}

/** The pose with the symmetry plane as one of its coordinate planes, or null
 *  for a plane with no normal. */
export function poseOnSymmetry(axes: readonly [Vec3, Vec3, Vec3], origin: Vec3, plane: { normal: Vec3; point: Vec3 }): SymmetryPose | null {
  const n0 = normalize(plane.normal)
  if (!n0) return null
  let k: 0 | 1 | 2 = 0
  for (const i of [1, 2] as const) if (Math.abs(dot(axes[i], n0)) > Math.abs(dot(axes[k], n0))) k = i
  // A plane's normal has no sign of its own; the axis keeps the way it ran.
  const n = dot(axes[k], n0) < 0 ? scale(n0, -1) : n0
  const square = (v: Vec3, to: Vec3): Vec3 | null => normalize(addScaled(v, to, -dot(v, to)))
  let out: [Vec3, Vec3, Vec3] | null = null
  if (k === 2) {
    const x = square(axes[0], n)
    out = x && [x, cross(n, x), n]
  } else {
    // Up stays as near up as the normal lets it.
    const z = square(axes[2], n)
    out = z && (k === 0 ? [n, cross(z, n), z] : [cross(n, z), n, z])
  }
  if (!out) return null
  const off = dot(sub(origin, plane.point), n)
  return {
    axes: out,
    origin: addScaled(origin, n, -off),
    axis: k,
    tiltDeg: (Math.acos(Math.min(1, Math.abs(dot(axes[k], n0)))) * 180) / Math.PI,
    shiftMm: Math.abs(off),
  }
}

// SPDX-License-Identifier: AGPL-3.0-only
// Planes given by their geometry rather than by something the part already
// has: through three points, through a point square to a direction, and
// through the axis of a round face of a body — a compound chamfer's cutting
// plane, an angled section, a datum plane a drawing gives by coordinates.
// Pure; the commands turn the frame each gives into a plane the feature
// list keeps as it is (PlaneRef 'fitted'), taken where the points are now.

import { sketchFrameOn, type SectionFrame } from '../../../src/core/section/frame'
import type { Vec3 } from '../../../src/core/types'
import { addScaled, cross, dot, normalize, sub } from '../../../src/core/vec'

const len = (v: Vec3) => Math.hypot(v[0], v[1], v[2])

/**
 * The plane through three points: its normal by the right hand from the
 * first to the second to the third — (p2 − p1) × (p3 − p1) — or the other
 * way with `flip`. A sentence why not when the points lie on one line or two
 * are one.
 */
export function planeThroughPoints(points: readonly Vec3[], flip = false): { origin: Vec3; normal: Vec3 } | string {
  if (points.length !== 3) return 'A plane through points takes three of them.'
  const [p1, p2, p3] = points
  const a = sub(p2, p1)
  const b = sub(p3, p1)
  const la = len(a)
  const lb = len(b)
  const lc = len(sub(p3, p2))
  if (la < 1e-9 || lb < 1e-9 || lc < 1e-9) return 'Two of the three points are one point — give three points apart.'
  const n = cross(a, b)
  // The sine of the angle at the first point, from the triangle's area:
  // under a thousandth of a degree the three lie on one line.
  if (len(n) < Math.sin((1e-3 * Math.PI) / 180) * la * lb) return 'The three points lie on one line — no one plane runs through them; move one of them off the line through the other two.'
  const normal = normalize(flip ? [-n[0], -n[1], -n[2]] : n)!
  return { origin: p1, normal }
}

/** The plane through a point square to a direction, any length. */
export function planeFromNormal(point: Vec3, normal: Vec3): { origin: Vec3; normal: Vec3 } | string {
  const n = normalize(normal)
  if (!n || len(normal) < 1e-12) return 'The normal has no length — give a direction, [x, y, z].'
  return { origin: point, normal: n }
}

/**
 * The plane through an axis (a cylinder's or a cone's): through a point off
 * the axis, or turned about it from the radial plane's zero. u runs out
 * along the radius towards the point, v up the axis — the radial plane's
 * frame — the normal u × v.
 */
export function planeThroughAxis(axis: { origin: Vec3; dir: Vec3 }, through: Vec3 | null, radial: (axis: { origin: Vec3; dir: Vec3 }) => SectionFrame | null): SectionFrame | string {
  const up0 = normalize(axis.dir)
  if (!up0) return 'The face has no axis.'
  if (!through) return radial(axis) ?? 'The face has no axis.'
  // v along the axis, its sign as the radial plane takes it: towards the +
  // end of the coordinate axis it lies nearest.
  let k = 0
  for (let i = 1; i < 3; i++) if (Math.abs(up0[i]) > Math.abs(up0[k])) k = i
  const up: Vec3 = up0[k] < 0 ? [-up0[0], -up0[1], -up0[2]] : up0
  const w = sub(through, axis.origin)
  const out = addScaled(w, up, -dot(w, up))
  const u = normalize(out)
  if (!u || len(out) < 1e-6) return 'The point lies on the axis — give one off it, for the plane to run through.'
  // The sheet's zero on the axis, level with the point.
  return { origin: addScaled(axis.origin, up, dot(w, up)), normal: cross(u, up), basisU: u, basisV: up }
}

/** A plane's frame as a sketch takes it — the sheet's zero the part's
 *  origin projected onto it, u by `seedU` or the plane's own — moved
 *  `offset` along its normal. */
export function frameOfPlane(plane: { origin: Vec3; normal: Vec3 }, offset = 0, seedU?: Vec3): SectionFrame | null {
  const frame = sketchFrameOn(plane, seedU)
  return frame && (offset ? { ...frame, origin: addScaled(frame.origin, frame.normal, offset) } : frame)
}

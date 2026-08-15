// SPDX-License-Identifier: AGPL-3.0-only
import type { Vec3 } from './types'

/** Small Vec3 toolkit shared by the construction and dimension math. Plain
 *  tuples in, plain tuples out — nothing here allocates beyond its result. */

export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
export const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2])
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]
export const addScaled = (a: Vec3, b: Vec3, s: number): Vec3 => [
  a[0] + b[0] * s,
  a[1] + b[1] * s,
  a[2] + b[2] * s,
]
export const mid = (a: Vec3, b: Vec3): Vec3 => [
  (a[0] + b[0]) / 2,
  (a[1] + b[1]) / 2,
  (a[2] + b[2]) / 2,
]

/** Unit vector, or null for a zero-length input. */
export function normalize(a: Vec3): Vec3 | null {
  const l = len(a)
  if (l < 1e-12) return null
  return [a[0] / l, a[1] / l, a[2] / l]
}

/** Angle between two directions in degrees, 0–180. */
export function angleBetween(a: Vec3, b: Vec3): number {
  const c = Math.max(-1, Math.min(1, dot(a, b)))
  return (Math.acos(c) * 180) / Math.PI
}

/** Angle between two directions folded into 0–90° — for axes and other
 *  directions with no inherent front or back. */
export function acuteAngle(a: Vec3, b: Vec3): number {
  const c = Math.min(1, Math.abs(dot(a, b)))
  return (Math.acos(c) * 180) / Math.PI
}

/** Foot of the perpendicular from a point onto an infinite line. */
export function footOnLine(point: Vec3, origin: Vec3, dir: Vec3): Vec3 {
  return addScaled(origin, dir, dot(sub(point, origin), dir))
}

/** Signed parameter of the perpendicular foot along the line, from origin. */
export function paramOnLine(point: Vec3, origin: Vec3, dir: Vec3): number {
  return dot(sub(point, origin), dir)
}

/** The two ends of the shortest segment between two skew lines, plus their
 *  line parameters. Parallel lines have no unique one, so the first line's
 *  anchor is used. */
export function closestBetweenLines(
  p1: Vec3,
  d1: Vec3,
  p2: Vec3,
  d2: Vec3,
): { a: Vec3; b: Vec3; t1: number; t2: number } {
  const n = cross(d1, d2)
  if (len(n) < 1e-9) {
    return { a: p1, b: footOnLine(p1, p2, d2), t1: 0, t2: paramOnLine(p1, p2, d2) }
  }
  const w = sub(p2, p1)
  const d1d2 = dot(d1, d2)
  const det = 1 - d1d2 * d1d2
  const t1 = (dot(w, d1) - d1d2 * dot(w, d2)) / det
  const t2 = (d1d2 * dot(w, d1) - dot(w, d2)) / det
  return { a: addScaled(p1, d1, t1), b: addScaled(p2, d2, t2), t1, t2 }
}

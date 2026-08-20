// SPDX-License-Identifier: AGPL-3.0-only
// The handful of 2D vector operations the flat workspace leans on. Kept as
// plain functions over [x, y] tuples, like core/vec.ts does for 3D.

import type { Vec2 } from './types'

export const add2 = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]]
export const sub2 = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]]
export const scale2 = (a: Vec2, s: number): Vec2 => [a[0] * s, a[1] * s]
export const dot2 = (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1]
export const len2 = (a: Vec2): number => Math.hypot(a[0], a[1])
export const mid2 = (a: Vec2, b: Vec2): Vec2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]

/** The left-hand perpendicular — `dir` rotated a quarter turn CCW. */
export const perp2 = (a: Vec2): Vec2 => [-a[1], a[0]]

/** Cross product's z component — the signed area spanned by the two. */
export const cross2 = (a: Vec2, b: Vec2): number => a[0] * b[1] - a[1] * b[0]

export function normalize2(a: Vec2): Vec2 | null {
  const l = len2(a)
  if (!(l > 1e-12)) return null
  return [a[0] / l, a[1] / l]
}

/** Angle between two directions regardless of either's sign, 0–90°. */
export function acuteAngle2(a: Vec2, b: Vec2): number {
  const c = Math.abs(dot2(a, b)) / (len2(a) * len2(b))
  return (Math.acos(Math.min(1, c)) * 180) / Math.PI
}

/** Foot of the perpendicular from `p` onto the line through `origin` along
 *  unit `dir`, and how far along the line it lands. */
export function footOnLine2(p: Vec2, origin: Vec2, dir: Vec2): { foot: Vec2; t: number } {
  const t = dot2(sub2(p, origin), dir)
  return { foot: add2(origin, scale2(dir, t)), t }
}

// SPDX-License-Identifier: AGPL-3.0-only
// The axis-aligned box around a set of points: its centre, and half its
// diagonal — the two numbers the viewport reads off a scan it has just laid
// out (SceneManager modelCenter and modelSize), computed here for a session
// that has no viewport.

import type { Vec3 } from '../types'

export interface Bounds {
  min: Vec3
  max: Vec3
  center: Vec3
  /** Half the diagonal, never below a tenth of a micron — the size elements
   *  without one of their own are drawn at. */
  radius: number
}

export function boundsOf(positions: Float32Array, count = positions.length / 3): Bounds {
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (let v = 0; v < count; v++) {
    for (let k = 0; k < 3; k++) {
      const x = positions[v * 3 + k]
      if (x < min[k]) min[k] = x
      if (x > max[k]) max[k] = x
    }
  }
  if (count === 0) return { min: [0, 0, 0], max: [0, 0, 0], center: [0, 0, 0], radius: 1e-4 }
  const d = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2])
  return {
    min,
    max,
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    radius: Math.max(d / 2, 1e-4),
  }
}

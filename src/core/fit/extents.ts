// SPDX-License-Identifier: AGPL-3.0-only
import { orthoBasis } from './linalg'

/** Angles beyond which the coverage estimate stops sampling — plenty to
 *  resolve the widest gap in any real scan. */
const COVERAGE_SAMPLES = 20_000

/** How much of the way around the axis a fitted patch reaches, in degrees,
 *  plus the axial extent of the patch — shared by the cylinder and the cone,
 *  whose fits both rest on part of a surface of revolution. A scan only ever
 *  sees part of one; both numbers say how much of it this fit actually rests
 *  on. Coverage is 360° minus the widest empty gap, which — unlike counting
 *  occupied bins — does not shrink just because the mesh is coarse. */
export function axialExtents(
  positions: Float32Array,
  region: Uint32Array,
  c: { px: number; py: number; pz: number; ax: number; ay: number; az: number },
): { coverage: number; minT: number; maxT: number } {
  const [u, v] = orthoBasis([c.ax, c.ay, c.az])
  let minT = Infinity
  let maxT = -Infinity

  const step = Math.max(1, Math.ceil(region.length / COVERAGE_SAMPLES))
  const angles: number[] = []
  for (let i = 0; i < region.length; i++) {
    const j = region[i] * 3
    const qx = positions[j] - c.px
    const qy = positions[j + 1] - c.py
    const qz = positions[j + 2] - c.pz
    const t = qx * c.ax + qy * c.ay + qz * c.az
    if (t < minT) minT = t
    if (t > maxT) maxT = t
    if (i % step === 0) {
      const wu = qx * u[0] + qy * u[1] + qz * u[2]
      const wv = qx * v[0] + qy * v[1] + qz * v[2]
      angles.push(Math.atan2(wv, wu))
    }
  }
  if (angles.length < 2) return { coverage: 0, minT, maxT }

  angles.sort((a, b) => a - b)
  let widest = angles[0] + 2 * Math.PI - angles[angles.length - 1]
  for (let i = 1; i < angles.length; i++) {
    const gap = angles[i] - angles[i - 1]
    if (gap > widest) widest = gap
  }
  const coverage = Math.max(0, 360 - (widest * 180) / Math.PI)
  return { coverage, minT, maxT }
}

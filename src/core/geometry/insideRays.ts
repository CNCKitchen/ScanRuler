// SPDX-License-Identifier: AGPL-3.0-only
// firstHits for a point cloud, which has no triangles for a ray to meet: how
// far each ray of a grid runs to a point of the scan that looks back at it.
import type { MeshGraph } from '../types'
import { PointGrid } from './pointGrid'
import type { RayGrid } from './scanQa'

/** A point is within the ray's reach when it lies this many spacings off it. */
const REACH_SPACINGS = 1.5
/** A point looks back at the ray when its normal lies against the ray's
 *  direction by at least this (cos of the angle to the reverse direction). */
const FACING_BACK = -0.5
/** Points that look the same way as the ray, or along it, are skipped over —
 *  the wall of a rib, the rim of a hole — up to this many in one ray. */
const MAX_SKIPS = 64

const gridOf = new WeakMap<MeshGraph, PointGrid>()

/** How far each ray of `grid` runs to the first point of the cloud lying
 *  within REACH_SPACINGS of it whose normal faces back at the ray, row by row
 *  as firstHits lays them, NaN where there is none within `far`. The surface
 *  the rays start on lies behind them and is never met. */
export function insideRays(g: MeshGraph, grid: RayGrid): Float32Array {
  const { origin: o, dir, u, v, cell, cols, rows, far } = grid
  const out = new Float32Array(cols * rows).fill(Number.NaN)
  const len = Math.hypot(dir[0], dir[1], dir[2])
  if (!(len > 0) || g.vertexCount === 0) return out
  // Every cloud graph carries its spacing (buildPointGraph); a mesh has none.
  const spacing = g.spacing
  if (!(spacing && spacing > 0)) return out
  let points = gridOf.get(g)
  if (!points) {
    points = new PointGrid(g.positions, 2.5 * spacing)
    gridOf.set(g, points)
  }
  const d: [number, number, number] = [dir[0] / len, dir[1] / len, dir[2] / len]
  const { positions: p, normals: n } = g
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = (c + 0.5) * cell
      const b = (r + 0.5) * cell
      const ox = o[0] + a * u[0] + b * v[0], oy = o[1] + a * u[1] + b * v[1], oz = o[2] + a * u[2] + b * v[2]
      let from = 0
      for (let skip = 0; skip <= MAX_SKIPS && from <= far; skip++) {
        const j = points.nearestToRay(ox + from * d[0], oy + from * d[1], oz + from * d[2], d[0], d[1], d[2], REACH_SPACINGS * spacing, far - from)
        if (j < 0) break
        const t = (p[3 * j] - ox) * d[0] + (p[3 * j + 1] - oy) * d[1] + (p[3 * j + 2] - oz) * d[2]
        if (n[3 * j] * d[0] + n[3 * j + 1] * d[1] + n[3 * j + 2] * d[2] < FACING_BACK) {
          out[r * cols + c] = t
          break
        }
        from = Math.max(from, t) + 1e-6 * (far + 1)
      }
    }
  }
  return out
}

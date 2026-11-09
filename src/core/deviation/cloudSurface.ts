// SPDX-License-Identifier: AGPL-3.0-only
// A point cloud prepared for the closest-point queries ICP pairs a scan with,
// so a scan can be aligned onto a cloud as onto a mesh. A cloud has no faces
// to land on, so the nearest point stands in for its patch of surface: the
// query is projected onto that point's tangent plane and signed by its
// normal. Point-to-plane is what ICP minimises anyway, and the plane lets a
// sample sit between two points of the target without reading their spacing
// as a gap.
//
// The points sit in a k-d tree (pointKdTree.ts), not the uniform grid the
// rest of the cloud code uses: a grid opens every empty cell between a far
// query and the cloud, and an alignment that starts a part tens of
// millimetres off asks that of every sample. The tree shares scratch state
// between queries, so one CloudSurface must not be queried from two places
// at once. ICP pairs its
// samples one after another, and a cloud never goes to the helper workers
// (icpPool.ts), which rebuild a NominalSurface from its triangles.

import { PointKdTree } from '../geometry/pointKdTree'
import type { ClosestHit, ClosestSurface } from './surface'

/** Points a facing-aware query looks through for one facing its way. */
const FACING_CANDIDATES = 12

export class CloudSurface implements ClosestSurface {
  readonly positions: Float32Array
  readonly normals: Float32Array
  readonly bboxDiagonal: number
  private tree: PointKdTree
  /** Where the widening facing search starts at the least. */
  private spacing: number
  private near = new Int32Array(FACING_CANDIDATES)
  private around: number[] = []

  constructor(positions: Float32Array, normals: Float32Array, spacing: number) {
    this.positions = positions
    this.normals = normals
    this.tree = new PointKdTree(positions)
    this.spacing = spacing
    let x0 = Infinity, y0 = Infinity, z0 = Infinity
    let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i], y = positions[i + 1], z = positions[i + 2]
      if (!Number.isFinite(x + y + z)) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      if (z < z0) z0 = z
      if (z > z1) z1 = z
    }
    this.bboxDiagonal = x1 >= x0 ? Math.hypot(x1 - x0, y1 - y0, z1 - z0) : 0
  }

  closest(x: number, y: number, z: number, out: ClosestHit, maxDistance = Infinity): boolean {
    const j = this.tree.nearest(x, y, z, maxDistance)
    if (j < 0) return false
    this.fillHit(x, y, z, j, out)
    return true
  }

  /** The nearest point whose normal n satisfies `n · (nx, ny, nz) >= minDot`,
   *  within `maxDistance` (and never past the cloud's own diagonal). The 12
   *  nearest are tried first: on a surface facing the query's way that is
   *  the answer. Only when all of them face away — the near skin of a wall,
   *  with the one wanted on its far side — is the search widened, a radius
   *  at a time, until a facing point turns up. */
  closestFacing(
    x: number, y: number, z: number,
    nx: number, ny: number, nz: number,
    minDot: number,
    out: ClosestHit,
    maxDistance = Infinity,
  ): boolean {
    const near = this.near
    const count = this.tree.kNearestTo(x, y, z, FACING_CANDIDATES, maxDistance, near)
    const n = this.normals
    for (let a = 0; a < count; a++) {
      const j = near[a]
      const mx = n[3 * j], my = n[3 * j + 1], mz = n[3 * j + 2]
      const len = Math.hypot(mx, my, mz)
      if (!(len > 0)) continue
      if ((mx * nx + my * ny + mz * nz) / len < minDot) continue
      this.fillHit(x, y, z, j, out)
      return true
    }
    if (count < FACING_CANDIDATES) return false // everything within reach was looked at
    const reach = Math.min(maxDistance, this.bboxDiagonal)
    const p = this.positions
    const around = this.around
    // Every point within the 12th's distance faced away, so the answer lies
    // beyond it; each pass scans a ball twice as wide, and the nearest
    // facing point found in a ball is the nearest of all.
    const j12 = near[count - 1]
    let r = 2 * Math.max(Math.hypot(p[3 * j12] - x, p[3 * j12 + 1] - y, p[3 * j12 + 2] - z), this.spacing)
    for (;;) {
      const radius = Math.min(r, reach)
      this.tree.withinRadius(x, y, z, radius, around)
      let best = -1
      let bestD2 = Infinity
      for (const j of around) {
        const mx = n[3 * j], my = n[3 * j + 1], mz = n[3 * j + 2]
        const len = Math.hypot(mx, my, mz)
        if (!(len > 0) || (mx * nx + my * ny + mz * nz) / len < minDot) continue
        const dx = p[3 * j] - x, dy = p[3 * j + 1] - y, dz = p[3 * j + 2] - z
        const d2 = dx * dx + dy * dy + dz * dz
        if (d2 < bestD2) {
          bestD2 = d2
          best = j
        }
      }
      if (best >= 0) {
        this.fillHit(x, y, z, best, out)
        return true
      }
      if (radius >= reach) return false
      r *= 2
    }
  }

  /** The query projected onto point j's tangent plane. */
  private fillHit(x: number, y: number, z: number, j: number, out: ClosestHit): void {
    const p = this.positions
    const n = this.normals
    let nx = n[3 * j], ny = n[3 * j + 1], nz = n[3 * j + 2]
    const len = Math.hypot(nx, ny, nz)
    if (len > 0) {
      nx /= len; ny /= len; nz /= len
    } else {
      nx = 0; ny = 0; nz = 1
    }
    const side = (x - p[3 * j]) * nx + (y - p[3 * j + 1]) * ny + (z - p[3 * j + 2]) * nz
    out.distance = Math.abs(side)
    out.signed = side
    out.px = x - side * nx
    out.py = y - side * ny
    out.pz = z - side * nz
    out.nx = nx; out.ny = ny; out.nz = nz
    out.faceIndex = -1
  }
}

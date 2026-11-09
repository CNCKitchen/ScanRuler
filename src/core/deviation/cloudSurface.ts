// SPDX-License-Identifier: AGPL-3.0-only
// A point cloud prepared for the closest-point queries ICP pairs a scan with,
// so a scan can be aligned onto a cloud as onto a mesh. A cloud has no faces
// to land on, so the nearest point stands in for its patch of surface: the
// query is projected onto that point's tangent plane and signed by its
// normal. Point-to-plane is what ICP minimises anyway, and the plane lets a
// sample sit between two points of the target without reading their spacing
// as a gap.
//
// The grid behind it shares scratch buffers between queries, so one
// CloudSurface must not be queried from two places at once. ICP pairs its
// samples one after another, and a cloud never goes to the helper workers
// (icpPool.ts), which rebuild a NominalSurface from its triangles.

import { PointGrid } from '../geometry/pointGrid'
import type { ClosestHit, ClosestSurface } from './surface'

/** Points a facing-aware query looks through for one facing its way. */
const FACING_CANDIDATES = 12

export class CloudSurface implements ClosestSurface {
  readonly positions: Float32Array
  readonly normals: Float32Array
  readonly bboxDiagonal: number
  private grid: PointGrid
  private near = new Int32Array(FACING_CANDIDATES)

  constructor(positions: Float32Array, normals: Float32Array, spacing: number) {
    this.positions = positions
    this.normals = normals
    this.grid = new PointGrid(positions, 2 * spacing)
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
    const j = this.grid.nearest(x, y, z, maxDistance)
    if (j < 0) return false
    this.fillHit(x, y, z, j, out)
    return true
  }

  /** The nearest of the 12 points nearest the query whose normal n satisfies
   *  `n · (nx, ny, nz) >= minDot`. Twelve reach past the far skin of a thin
   *  wall at the cloud's own spacing, which is the case this query is for. */
  closestFacing(
    x: number, y: number, z: number,
    nx: number, ny: number, nz: number,
    minDot: number,
    out: ClosestHit,
    maxDistance = Infinity,
  ): boolean {
    const near = this.near
    const count = this.grid.kNearestTo(x, y, z, FACING_CANDIDATES, maxDistance, near)
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
    return false
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

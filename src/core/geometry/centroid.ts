// SPDX-License-Identifier: AGPL-3.0-only
// Where the middle of a scan is: the centroid of the volume the mesh
// encloses, summed over its triangles by the divergence theorem — exact for a
// closed mesh, and meaningless for an open one. Whether the mesh closes is
// measured alongside rather than assumed, and the surface's own centroid
// (area-weighted) is there for the scan that does not.
import type { Vec3 } from '../types'

export interface MeshCentroid {
  /** The centroid of the enclosed volume — null when the mesh is too open
   *  for one to exist. */
  volume: Vec3 | null
  /** The centroid of the surface itself, weighted by triangle area: what an
   *  open scan still has, and always a point on the part's own scale. */
  area: Vec3
  /** Whether the mesh closes well enough to enclose a volume. */
  closed: boolean
  /** The enclosed volume in mm³, unsigned; only meaningful when closed. */
  volumeMm3: number
}

/** How far the signed volume may change between two origins, as a fraction
 *  of itself, before the mesh counts as open. A closed mesh gives the same
 *  number from anywhere; a missing face changes it by the face's area times
 *  the shift, so a pinhole passes and an open bottom does not. */
const CLOSED_TOLERANCE = 0.01

export function meshCentroid(positions: Float32Array, indices: Uint32Array): MeshCentroid {
  const triangleCount = Math.floor(indices.length / 3)
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  let ax = 0, ay = 0, az = 0, areaSum = 0

  for (let t = 0; t < triangleCount; t++) {
    const a = indices[t * 3] * 3
    const b = indices[t * 3 + 1] * 3
    const c = indices[t * 3 + 2] * 3
    const ax0 = positions[a], ay0 = positions[a + 1], az0 = positions[a + 2]
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2]
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2]
    const ux = bx - ax0, uy = by - ay0, uz = bz - az0
    const vx = cx - ax0, vy = cy - ay0, vz = cz - az0
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    const area = Math.hypot(nx, ny, nz) / 2
    ax += ((ax0 + bx + cx) / 3) * area
    ay += ((ay0 + by + cy) / 3) * area
    az += ((az0 + bz + cz) / 3) * area
    areaSum += area
    for (const j of [a, b, c]) {
      const x = positions[j], y = positions[j + 1], z = positions[j + 2]
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      if (z < minZ) minZ = z
      if (z > maxZ) maxZ = z
    }
  }
  if (!(areaSum > 0)) {
    const mid: Vec3 = Number.isFinite(minX)
      ? [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2]
      : [0, 0, 0]
    return { volume: null, area: mid, closed: false, volumeMm3: 0 }
  }
  const area: Vec3 = [ax / areaSum, ay / areaSum, az / areaSum]
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ)

  // Signed volume and its first moment about the surface centroid, which
  // keeps the sums small, and the signed volume again about a second origin
  // a diagonal away in a direction no face is likely to be square to.
  const o1 = area
  const o2: Vec3 = [area[0] + diag, area[1] + 0.7 * diag, area[2] + 0.4 * diag]
  let v1 = 0, v2 = 0
  let mx = 0, my = 0, mz = 0
  for (let t = 0; t < triangleCount; t++) {
    const a = indices[t * 3] * 3
    const b = indices[t * 3 + 1] * 3
    const c = indices[t * 3 + 2] * 3
    v1 += tetraVolume(positions, a, b, c, o1)
    v2 += tetraVolume(positions, a, b, c, o2)
    const v = tetraVolume(positions, a, b, c, o1)
    // The centroid of a tetrahedron is the mean of its corners; with the
    // origin as the fourth corner that is (a + b + c) / 4 relative to it.
    mx += v * (positions[a] + positions[b] + positions[c] - 3 * o1[0]) / 4
    my += v * (positions[a + 1] + positions[b + 1] + positions[c + 1] - 3 * o1[1]) / 4
    mz += v * (positions[a + 2] + positions[b + 2] + positions[c + 2] - 3 * o1[2]) / 4
  }
  const closed = Math.abs(v1) > 0 && Math.abs(v1 - v2) <= CLOSED_TOLERANCE * Math.abs(v1)
  const volume: Vec3 | null = closed ? [o1[0] + mx / v1, o1[1] + my / v1, o1[2] + mz / v1] : null
  return { volume, area, closed, volumeMm3: Math.abs(v1) }
}

/** Signed volume of the tetrahedron the triangle spans with the origin. */
function tetraVolume(p: Float32Array, a: number, b: number, c: number, o: Vec3): number {
  const ax = p[a] - o[0], ay = p[a + 1] - o[1], az = p[a + 2] - o[2]
  const bx = p[b] - o[0], by = p[b + 1] - o[1], bz = p[b + 2] - o[2]
  const cx = p[c] - o[0], cy = p[c + 1] - o[1], cz = p[c + 2] - o[2]
  return (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6
}

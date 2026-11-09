// SPDX-License-Identifier: AGPL-3.0-only
// Where the middle of a scan is: the centroid of the volume the mesh
// encloses, summed over its triangles by the divergence theorem — exact for a
// closed mesh, and meaningless for an open one. Whether the mesh closes is
// measured alongside rather than assumed, and the surface's own centroid
// (area-weighted) is there for the scan that does not.
import type { Vec3 } from '../types'
import { extentOfIndexed } from './bounds'

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

/** The area of a mesh's surface: every triangle's, summed. */
export function triangleAreaSum(positions: Float32Array, indices: Uint32Array): number {
  let area = 0
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2]
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2]
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2
  }
  return area
}

export function meshCentroid(positions: Float32Array, indices: Uint32Array): MeshCentroid {
  const triangleCount = Math.floor(indices.length / 3)
  const { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } = extentOfIndexed(positions, indices.subarray(0, triangleCount * 3))
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
  // The volume read three ways — the flux of x, of y and of z through the
  // surface (divergence theorem, one coordinate at a time). Closed, the
  // three agree. Open, each misses the flux through the openings along its
  // own axis, which the shifted origin does not see when openings face
  // each other: a tube open at both ends shifts nothing, yet holds no
  // z-flux at all (issue 34).
  let fx = 0, fy = 0, fz = 0
  for (let t = 0; t < triangleCount; t++) {
    const a = indices[t * 3] * 3
    const b = indices[t * 3 + 1] * 3
    const c = indices[t * 3 + 2] * 3
    v1 += tetraVolume(positions, a, b, c, o1)
    v2 += tetraVolume(positions, a, b, c, o2)
    {
      const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2]
      const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2]
      // Twice the area vector, and the triangle's centroid about o1: the
      // flux of a field linear over the flat triangle is its value at the
      // centroid times the area vector.
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
      fx += (nx / 2) * ((positions[a] + positions[b] + positions[c]) / 3 - o1[0])
      fy += (ny / 2) * ((positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3 - o1[1])
      fz += (nz / 2) * ((positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3 - o1[2])
    }
    const v = tetraVolume(positions, a, b, c, o1)
    // The centroid of a tetrahedron is the mean of its corners; with the
    // origin as the fourth corner that is (a + b + c) / 4 relative to it.
    mx += v * (positions[a] + positions[b] + positions[c] - 3 * o1[0]) / 4
    my += v * (positions[a + 1] + positions[b + 1] + positions[c + 1] - 3 * o1[1]) / 4
    mz += v * (positions[a + 2] + positions[b + 2] + positions[c + 2] - 3 * o1[2]) / 4
  }
  const agrees = (f: number) => Math.abs(f - v1) <= CLOSED_TOLERANCE * Math.abs(v1)
  const closed = Math.abs(v1) > 0 && agrees(v2) && agrees(fx) && agrees(fy) && agrees(fz)
  const volume: Vec3 | null = closed ? [o1[0] + mx / v1, o1[1] + my / v1, o1[2] + mz / v1] : null
  return { volume, area, closed, volumeMm3: Math.abs(v1) }
}

/** Signed volume of the tetrahedron the triangle spans with the origin. */
function tetraVolume(p: Float32Array, a: number, b: number, c: number, o: Vec3): number {
  return tetraVolume6(p, a, b, c, o) / 6
}

const ORIGIN: Vec3 = [0, 0, 0]

/** Six times the signed volume of the tetrahedron the triangle at offsets
 *  a, b and c spans with `o` — summed over a closed mesh, six times what it
 *  encloses (the divergence theorem), positive when its triangles wind
 *  outward. The sixth left for the caller to take, where it likes. */
export function tetraVolume6(p: Float32Array, a: number, b: number, c: number, o: Vec3 = ORIGIN): number {
  const ax = p[a] - o[0], ay = p[a + 1] - o[1], az = p[a + 2] - o[2]
  const bx = p[b] - o[0], by = p[b + 1] - o[1], bz = p[b + 2] - o[2]
  const cx = p[c] - o[0], cy = p[c + 1] - o[1], cz = p[c + 2] - o[2]
  return ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)
}

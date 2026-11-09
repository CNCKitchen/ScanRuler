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
 *  the shift, so a pinhole passes and an open bottom does not. The holes'
 *  areas are vectors, though, and two can cancel: an open-ended tube's ends
 *  face opposite ways and leave the volume unchanged from any origin. So
 *  each rim's area is also taken on its own (openRimArea), and held to the
 *  same fraction. */
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
  const closed =
    Math.abs(v1) > 0 &&
    Math.abs(v1 - v2) <= CLOSED_TOLERANCE * Math.abs(v1) &&
    openRimArea(positions, indices, triangleCount) * diag <= CLOSED_TOLERANCE * Math.abs(v1)
  const volume: Vec3 | null = closed ? [o1[0] + mx / v1, o1[1] + my / v1, o1[2] + mz / v1] : null
  return { volume, area, closed, volumeMm3: Math.abs(v1) }
}

/**
 * The open rims' areas, each rim's on its own, summed: for each loop of
 * edges with one triangle alone on them, the length of the vector area it
 * bounds, |½ Σ a × b| over its edges — the area of the opening, flat or not,
 * whichever origin the sum is taken about. Zero for a closed mesh.
 */
function openRimArea(positions: Float32Array, indices: Uint32Array, triangleCount: number): number {
  let n = 0
  for (let i = 0; i < triangleCount * 3; i++) if (indices[i] >= n) n = indices[i] + 1
  // Every edge filed under its lower vertex as the higher one times two,
  // plus which way its triangle runs along it; an open edge is one filed
  // once. Uint32 entries hold that while n < 2^31.
  if (n >= 2 ** 31) return 0
  const start = new Uint32Array(n + 1)
  for (let t = 0; t < triangleCount; t++) {
    for (let e = 0; e < 3; e++) {
      const a = indices[t * 3 + e]
      const b = indices[t * 3 + ((e + 1) % 3)]
      if (a !== b) start[Math.min(a, b) + 1]++
    }
  }
  for (let v = 0; v < n; v++) start[v + 1] += start[v]
  const filed = new Uint32Array(start[n])
  const fill = start.slice(0, n)
  for (let t = 0; t < triangleCount; t++) {
    for (let e = 0; e < 3; e++) {
      const a = indices[t * 3 + e]
      const b = indices[t * 3 + ((e + 1) % 3)]
      if (a !== b) filed[fill[Math.min(a, b)]++] = a < b ? b * 2 : a * 2 + 1
    }
  }
  /** Open edges, each as [from, to] the way its triangle runs along it. */
  const ends: [number, number][] = []
  for (let lo = 0; lo < n; lo++) {
    const list = filed.subarray(start[lo], start[lo + 1])
    if (list.length === 0) continue
    list.sort()
    for (let i = 0; i < list.length; ) {
      const hi = list[i] >>> 1
      let j = i + 1
      while (j < list.length && list[j] >>> 1 === hi) j++
      if (j - i === 1) ends.push(list[i] & 1 ? [hi, lo] : [lo, hi])
      i = j
    }
  }
  if (ends.length === 0) return 0

  // Rims joined through shared vertices.
  const parent = new Map<number, number>()
  const find = (v: number): number => {
    let r = v
    while (parent.get(r) !== r) r = parent.get(r)!
    while (parent.get(v) !== r) {
      const next = parent.get(v)!
      parent.set(v, r)
      v = next
    }
    return r
  }
  for (const [a, b] of ends) {
    if (!parent.has(a)) parent.set(a, a)
    if (!parent.has(b)) parent.set(b, b)
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  // About a point of each rim, so the sums stay on the rim's own scale.
  const rims = new Map<number, { o: number; x: number; y: number; z: number }>()
  for (const [a, b] of ends) {
    const r = find(a)
    let rim = rims.get(r)
    if (!rim) rims.set(r, (rim = { o: a * 3, x: 0, y: 0, z: 0 }))
    const o = rim.o
    const ax = positions[a * 3] - positions[o], ay = positions[a * 3 + 1] - positions[o + 1], az = positions[a * 3 + 2] - positions[o + 2]
    const bx = positions[b * 3] - positions[o], by = positions[b * 3 + 1] - positions[o + 1], bz = positions[b * 3 + 2] - positions[o + 2]
    rim.x += (ay * bz - az * by) / 2
    rim.y += (az * bx - ax * bz) / 2
    rim.z += (ax * by - ay * bx) / 2
  }
  let area = 0
  for (const rim of rims.values()) area += Math.hypot(rim.x, rim.y, rim.z)
  return area
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

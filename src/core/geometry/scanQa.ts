// SPDX-License-Identifier: AGPL-3.0-only
// What a scan is like before anything is modelled on it: where it is open,
// how noisy it is, and where the first surface lies along an axis over a
// grid — a height map, and with one from each side the thickness through
// the part. A scan whose faces should be parallel and are a degree apart
// shows it here, before every fit on it misses by the lean.

import * as THREE from 'three'
import type { MeshBVH } from 'three-mesh-bvh'
import { symmetricEigen3 } from '../fit/linalg'
import type { MeshGraph, Vec3 } from '../types'
import { circleFromPoints } from '../fit/circle'
import { type MeshGap, type RimLoop } from './openEdges'

/** A grid of parallel rays: one per cell centre, the cell (c, r) starting
 *  at origin + (c + ½)·cell·u + (r + ½)·cell·v and running along `dir` (a
 *  unit vector square to u and v) for `far` mm. */
export interface RayGrid {
  origin: Vec3
  dir: Vec3
  u: Vec3
  v: Vec3
  cell: number
  cols: number
  rows: number
  far: number
}

/** The two axes across `axis`, in the order a grid lays them. */
export const acrossAxes = (axis: 0 | 1 | 2): [number, number] => (axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1])

/** How far each ray runs to the first surface it meets, row by row (row 0
 *  nearest the origin), NaN where it meets none within `far`. */
export function firstHits(bvh: MeshBVH, grid: RayGrid): Float32Array {
  const { origin: o, dir, u, v, cell, cols, rows, far } = grid
  const out = new Float32Array(cols * rows).fill(Number.NaN)
  const origin = new THREE.Vector3()
  const ray = new THREE.Ray(origin, new THREE.Vector3(dir[0], dir[1], dir[2]))
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = (c + 0.5) * cell
      const b = (r + 0.5) * cell
      origin.set(o[0] + a * u[0] + b * v[0], o[1] + a * u[1] + b * v[1], o[2] + a * u[2] + b * v[2])
      const hit = bvh.raycastFirst(ray, THREE.DoubleSide, 0, far)
      if (hit) out[r * cols + c] = hit.distance
    }
  }
  return out
}

/** The first hits with where on the scan they landed: per ray its
 *  distance (NaN for none), the three corners of the triangle it met
 *  (scan vertex numbers, NO_CORNER for none) and the hit's weight on each
 *  — what a value kept per vertex, the deviation say, is read at the hit
 *  by: Σ weight·value over the three. */
export const NO_CORNER = 0xffffffff

export function firstHitsAt(bvh: MeshBVH, positions: Float32Array, grid: RayGrid): { values: Float32Array; corners: Uint32Array; weights: Float32Array } {
  const { origin: o, dir, u, v, cell, cols, rows, far } = grid
  const n = cols * rows
  const values = new Float32Array(n).fill(Number.NaN)
  const corners = new Uint32Array(3 * n).fill(NO_CORNER)
  const weights = new Float32Array(3 * n)
  const origin = new THREE.Vector3()
  const ray = new THREE.Ray(origin, new THREE.Vector3(dir[0], dir[1], dir[2]))
  const tri = new THREE.Triangle()
  const bary = new THREE.Vector3()
  const at = (i: number, out: THREE.Vector3) => out.set(positions[3 * i], positions[3 * i + 1], positions[3 * i + 2])
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = (c + 0.5) * cell
      const b = (r + 0.5) * cell
      origin.set(o[0] + a * u[0] + b * v[0], o[1] + a * u[1] + b * v[1], o[2] + a * u[2] + b * v[2])
      const hit = bvh.raycastFirst(ray, THREE.DoubleSide, 0, far)
      if (!hit || !hit.face) continue
      const k = r * cols + c
      values[k] = hit.distance
      const { a: ia, b: ib, c: ic } = hit.face
      at(ia, tri.a)
      at(ib, tri.b)
      at(ic, tri.c)
      if (!tri.getBarycoord(hit.point, bary)) bary.set(1 / 3, 1 / 3, 1 / 3)
      corners[3 * k] = ia
      corners[3 * k + 1] = ib
      corners[3 * k + 2] = ic
      weights[3 * k] = bary.x
      weights[3 * k + 1] = bary.y
      weights[3 * k + 2] = bary.z
    }
  }
  return { values, corners, weights }
}

/** The direction most of a surface faces, either way along it — a plate's
 *  faces: the leading eigenvector of Σ n·nᵀ over the normals given, then
 *  again over the normals within 20° of it, so the sides fall out. */
export function dominantFacing(normals: Float32Array): Vec3 | null {
  const lead = (keep: (i: number) => boolean): Vec3 | null => {
    const m = new Float64Array(9)
    let n = 0
    for (let i = 0; i + 2 < normals.length; i += 3) {
      if (!keep(i)) continue
      const x = normals[i], y = normals[i + 1], z = normals[i + 2]
      m[0] += x * x; m[1] += x * y; m[2] += x * z
      m[4] += y * y; m[5] += y * z; m[8] += z * z
      n++
    }
    if (n < 3) return null
    m[3] = m[1]; m[6] = m[2]; m[7] = m[5]
    return symmetricEigen3(m).vectors[2]
  }
  const first = lead(() => true)
  if (!first) return null
  const cos = Math.cos((20 * Math.PI) / 180)
  return lead((i) => Math.abs(normals[i] * first[0] + normals[i + 1] * first[1] + normals[i + 2] * first[2]) >= cos) ?? first
}

/** A rim's best circle, where one holds: its centre, the axis square to
 *  the plane the rim lies in, the radius, and the rim's scatter off the
 *  circle (rms of the distance in 3D, mm). */
export interface RimCircle {
  center: Vec3
  axis: Vec3
  radius: number
  rms: number
}

/** A rim placed and numbered: `index` is its place among all the scan's
 *  rims, longest first — what scanRim takes back. */
export interface ScanRim extends MeshGap {
  index: number
  circle?: RimCircle
}

/** The fewest vertices round a rim for a circle to be read off it. */
const RIM_CIRCLE_MIN = 8
/** How far a rim may scatter off its circle and still be read as one, a
 *  share of the radius: a jagged scan edge round a hole stays well under
 *  it, a square opening (about 0.12) does not. */
const RIM_ROUND = 0.08

/** The rims of the scan, longest first, each with its loop. */
function rimsByLength(positions: Float32Array, loops: RimLoop[]): { loop: RimLoop; gap: MeshGap }[] {
  const out = loops.map((loop) => {
    const v = loop.vertices
    const lo = [Infinity, Infinity, Infinity]
    const hi = [-Infinity, -Infinity, -Infinity]
    const sum = [0, 0, 0]
    let length = 0
    for (let i = 0; i < v.length; i++) {
      for (let k = 0; k < 3; k++) {
        const x = positions[v[i] * 3 + k]
        sum[k] += x
        if (x < lo[k]) lo[k] = x
        if (x > hi[k]) hi[k] = x
      }
      if (i + 1 < v.length || loop.closed) {
        const a = v[i] * 3
        const b = v[(i + 1) % v.length] * 3
        length += Math.hypot(positions[a] - positions[b], positions[a + 1] - positions[b + 1], positions[a + 2] - positions[b + 2])
      }
    }
    const n = v.length
    const gap: MeshGap = { at: [sum[0] / n, sum[1] / n, sum[2] / n], edges: loop.triangles.length, size: Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]), length }
    return { loop, gap }
  })
  return out.sort((a, b) => b.gap.length - a.gap.length || a.loop.vertices[0] - b.loop.vertices[0])
}

/** The circle through a rim, where its vertices lie on one within
 *  RIM_ROUND of the radius; undefined otherwise. */
function rimCircle(positions: Float32Array, loop: RimLoop): RimCircle | undefined {
  if (!loop.closed || loop.vertices.length < RIM_CIRCLE_MIN) return undefined
  const points: Vec3[] = Array.from(loop.vertices, (v) => [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]])
  try {
    const c = circleFromPoints(points)
    if (!(c.sigma <= RIM_ROUND * c.radius)) return undefined
    return { center: c.center, axis: c.normal, radius: c.radius, rms: c.sigma }
  } catch {
    // Points in a line, or on top of each other: no circle.
    return undefined
  }
}

/** The open rims of the scan, longest first: how many, all their length,
 *  the `keep` longest, and up to `circles` more that a circle fits — the
 *  holes. Each rim answered with its circle where one holds. */
export function scanRims(positions: Float32Array, loops: RimLoop[], keep: number, circles = 12): { count: number; total: number; largest: ScanRim[]; circles: ScanRim[]; moreCircles: number } {
  const all = rimsByLength(positions, loops)
  const placed = (i: number): ScanRim => {
    const circle = rimCircle(positions, all[i].loop)
    return { ...all[i].gap, index: i, ...(circle ? { circle } : {}) }
  }
  const largest = all.slice(0, keep).map((_, i) => placed(i))
  const round: ScanRim[] = []
  for (let i = keep; i < all.length; i++) {
    const r = placed(i)
    if (r.circle) round.push(r)
  }
  return { count: all.length, total: all.reduce((s, g) => s + g.gap.length, 0), largest, circles: round.slice(0, circles), moreCircles: Math.max(0, round.length - circles) }
}

/** One rim by its number among the scan's rims (scanRims' index): its
 *  loop's vertices in order with their places, the corners of the
 *  triangle along each edge (three a vertex, the edge that leaves it), and
 *  its circle where one holds. Null past the last rim. */
export function scanRim(positions: Float32Array, indices: Uint32Array, loops: RimLoop[], index: number): { vertices: Uint32Array; positions: Float32Array; corners: Uint32Array; closed: boolean; length: number; circle?: RimCircle } | null {
  const all = rimsByLength(positions, loops)
  const r = all[index]
  if (!r) return null
  const v = r.loop.vertices
  const at = new Float32Array(v.length * 3)
  for (let i = 0; i < v.length; i++) at.set(positions.subarray(v[i] * 3, v[i] * 3 + 3), i * 3)
  const t = r.loop.triangles
  const corners = new Uint32Array(v.length * 3)
  for (let i = 0; i < v.length; i++) corners.set(indices.subarray(t[Math.min(i, t.length - 1)] * 3, t[Math.min(i, t.length - 1)] * 3 + 3), i * 3)
  const circle = rimCircle(positions, r.loop)
  return { vertices: Uint32Array.from(v), positions: at, corners, closed: r.loop.closed, length: r.gap.length, ...(circle ? { circle } : {}) }
}

/** How noisy the surface is: over a sample of vertices spread through the
 *  scan, a plane fitted to each one's two rings of neighbours, and the
 *  scatter off it (rms, mm) — its median, and the 90th percentile. Edges
 *  and rounds fit a plane badly; the median is the faces'. */
export function localNoise(g: MeshGraph, sample: number): { median: number; p90: number; sampled: number } {
  const step = Math.max(1, Math.floor(g.vertexCount / sample))
  const p = g.positions
  const rms: number[] = []
  const ring = new Set<number>()
  const cov = new Float64Array(9)
  for (let v = 0; v < g.vertexCount; v += step) {
    ring.clear()
    ring.add(v)
    for (let e = g.adjOffsets[v]; e < g.adjOffsets[v + 1]; e++) {
      const u = g.adjList[e]
      ring.add(u)
      for (let f = g.adjOffsets[u]; f < g.adjOffsets[u + 1] && ring.size < 48; f++) ring.add(g.adjList[f])
    }
    if (ring.size < 8) continue
    let cx = 0, cy = 0, cz = 0
    for (const u of ring) {
      cx += p[u * 3]
      cy += p[u * 3 + 1]
      cz += p[u * 3 + 2]
    }
    const n = ring.size
    cx /= n
    cy /= n
    cz /= n
    cov.fill(0)
    for (const u of ring) {
      const x = p[u * 3] - cx, y = p[u * 3 + 1] - cy, z = p[u * 3 + 2] - cz
      cov[0] += x * x
      cov[1] += x * y
      cov[2] += x * z
      cov[4] += y * y
      cov[5] += y * z
      cov[8] += z * z
    }
    cov[3] = cov[1]
    cov[6] = cov[2]
    cov[7] = cov[5]
    rms.push(Math.sqrt(Math.max(0, symmetricEigen3(cov).values[0]) / n))
  }
  rms.sort((a, b) => a - b)
  const at = (q: number) => (rms.length ? rms[Math.min(rms.length - 1, Math.floor(q * rms.length))] : 0)
  return { median: at(0.5), p90: at(0.9), sampled: rms.length }
}

/** What a mesh's triangles say it is: a CAD tessellation — flat facets,
 *  neighbouring triangles lying exactly in one plane, which a scanner's
 *  scatter never leaves — or a scan; and, for a CAD one, whether it is
 *  sparse: vertices only on its edges and rims, too far apart for a fit or
 *  a segmentation to find points inside its faces (issue 42). */
export interface Tessellation {
  cad: boolean
  sparse: boolean
  /** The share of the vertices looked at where two triangles sharing an
   *  edge out of the vertex lie exactly in one plane. */
  flat: number
  /** The vertices' spacing, mm: the square root of the area each has. */
  spacing: number
  /** The triangles' edges, mm: median and 90th percentile. */
  edgeP50: number
  edgeP90: number
  sampled: number
}

/** A CAD tessellation is one where at least this share of the vertices
 *  looked at have two neighbouring triangles exactly in one plane. */
const CAD_FLAT_SHARE = 0.5
/** And it is sparse where its vertices lie further apart than this share
 *  of the part's diagonal: 0.5 mm on a 75 mm part. */
export const SPARSE_SPACING = 1 / 150

/** The edge length a sparse tessellation is best densified to: about a
 *  hundredth of the part's diagonal, on a round number (0.5, 1, 2 …). */
export function densifyEdgeFor(diagonal: number): number {
  const raw = Math.max(diagonal / 100, 0.05)
  const p = 10 ** Math.floor(Math.log10(raw))
  const m = raw / p
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p
}

export function tessellationOf(g: MeshGraph, sample = 4000): Tessellation {
  const p = g.positions
  const n = g.vertexCount
  const tri = g.triangleCount
  // The area, and the edges of a spread of triangles.
  let area = 0
  const edges: number[] = []
  const stepT = Math.max(1, Math.floor(tri / 20000))
  let big = 0
  for (let i = 0; i < n * 3; i++) big = Math.max(big, Math.abs(p[i]))
  for (let t = 0; t < tri; t++) {
    const a = g.indices[t * 3] * 3, b = g.indices[t * 3 + 1] * 3, c = g.indices[t * 3 + 2] * 3
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2]
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2]
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2
    if (t % stepT === 0) edges.push(Math.hypot(ux, uy, uz), Math.hypot(p[c] - p[b], p[c + 1] - p[b + 1], p[c + 2] - p[b + 2]), Math.hypot(vx, vy, vz))
  }
  edges.sort((x, y) => x - y)
  const at = (q: number) => (edges.length ? edges[Math.min(edges.length - 1, Math.floor(q * edges.length))] : 0)
  // Two triangles in one plane to within the rounding of the file's
  // single-precision coordinates: a scan's scatter stands orders above it,
  // a CAD facet's points lie on it to the last bit.
  const tol = 2e-7 * (big + g.bboxDiag)
  const step = Math.max(1, Math.floor(n / sample))
  let looked = 0
  let flat = 0
  const ring: number[] = []
  for (let v = 0; v < n; v += step) {
    const vx = p[v * 3], vy = p[v * 3 + 1], vz = p[v * 3 + 2]
    // The ring's distinct points: a neighbour listed twice, or lying where
    // the vertex or another neighbour lies (a seam the file did not weld),
    // would be in any plane through them.
    ring.length = 0
    for (let e = g.adjOffsets[v]; e < g.adjOffsets[v + 1] && ring.length < 12; e++) {
      const u = g.adjList[e]
      const same = (w: number) => Math.abs(p[w * 3] - p[u * 3]) + Math.abs(p[w * 3 + 1] - p[u * 3 + 1]) + Math.abs(p[w * 3 + 2] - p[u * 3 + 2]) <= tol
      if (u === v || same(v) || ring.some(same)) continue
      ring.push(u)
    }
    if (ring.length < 3) continue
    // The triangles round the vertex: two of its neighbours joined by an
    // edge. Two that share an edge out of the vertex lie in one plane on a
    // CAD facet — the far corner of the one on the other's plane.
    const tris: [number, number][] = []
    for (let i = 0; i < ring.length; i++) {
      for (let e = g.adjOffsets[ring[i]]; e < g.adjOffsets[ring[i] + 1]; e++) {
        const j = ring.indexOf(g.adjList[e])
        if (j > i) tris.push([i, j])
      }
    }
    if (tris.length < 2) continue
    looked++
    let found = false
    for (let a = 0; a < tris.length && !found; a++) {
      const [i, j] = tris[a]
      const ax = p[ring[i] * 3] - vx, ay = p[ring[i] * 3 + 1] - vy, az = p[ring[i] * 3 + 2] - vz
      const bx = p[ring[j] * 3] - vx, by = p[ring[j] * 3 + 1] - vy, bz = p[ring[j] * 3 + 2] - vz
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx
      const l = Math.hypot(nx, ny, nz)
      // A sliver makes no plane to measure against.
      if (!(l > 1e-3 * Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz))) continue
      nx /= l
      ny /= l
      nz /= l
      for (let b = 0; b < tris.length && !found; b++) {
        if (b === a) continue
        const [k, m] = tris[b]
        // The other triangle on the edge out to ring[i] or ring[j].
        const far = k === i || k === j ? m : m === i || m === j ? k : -1
        if (far < 0 || far === i || far === j) continue
        const d = (p[ring[far] * 3] - vx) * nx + (p[ring[far] * 3 + 1] - vy) * ny + (p[ring[far] * 3 + 2] - vz) * nz
        if (Math.abs(d) <= tol) found = true
      }
    }
    if (found) flat++
  }
  const share = looked > 0 ? flat / looked : 0
  const spacing = n > 0 ? Math.sqrt(area / n) : 0
  const cad = looked >= 8 && share >= CAD_FLAT_SHARE
  return { cad, sparse: cad && spacing > SPARSE_SPACING * g.bboxDiag, flat: share, spacing, edgeP50: at(0.5), edgeP90: at(0.9), sampled: looked }
}

/** A plane z = a + b·u + c·v through the points, the worst of them left out
 *  round by round (past 2.5 robust sigma) — the faces of a plate read past
 *  its holes and bosses. Null with too few points. */
export function robustPlane(us: ArrayLike<number>, vs: ArrayLike<number>, zs: ArrayLike<number>): { a: number; b: number; c: number; used: number; rms: number } | null {
  let keep = Array.from({ length: zs.length }, (_, i) => i)
  let fit: { a: number; b: number; c: number } | null = null
  for (let round = 0; round < 4; round++) {
    if (keep.length < 6) return null
    // Normal equations about the kept points' mean, for a stable solve.
    let mu = 0, mv = 0, mz = 0
    for (const i of keep) {
      mu += us[i]
      mv += vs[i]
      mz += zs[i]
    }
    mu /= keep.length
    mv /= keep.length
    mz /= keep.length
    let suu = 0, suv = 0, svv = 0, suz = 0, svz = 0
    for (const i of keep) {
      const u = us[i] - mu, v = vs[i] - mv, z = zs[i] - mz
      suu += u * u
      suv += u * v
      svv += v * v
      suz += u * z
      svz += v * z
    }
    const det = suu * svv - suv * suv
    if (!(Math.abs(det) > 1e-12)) return null
    const b = (suz * svv - svz * suv) / det
    const c = (svz * suu - suz * suv) / det
    fit = { a: mz - b * mu - c * mv, b, c }
    const res = keep.map((i) => zs[i] - (fit!.a + b * us[i] + c * vs[i]))
    const sorted = res.map(Math.abs).sort((x, y) => x - y)
    const sigma = Math.max(1.4826 * sorted[sorted.length >> 1], 1e-6)
    const next = keep.filter((_, k) => Math.abs(res[k]) <= 2.5 * sigma)
    if (next.length === keep.length) break
    keep = next
  }
  if (!fit) return null
  let ss = 0
  for (const i of keep) ss += (zs[i] - (fit.a + fit.b * us[i] + fit.c * vs[i])) ** 2
  return { ...fit, used: keep.length, rms: Math.sqrt(ss / Math.max(1, keep.length)) }
}

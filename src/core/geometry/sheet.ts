// SPDX-License-Identifier: AGPL-3.0-only
// Whether a scan is a sheet: two skins close together over most of it, as a
// stamped or folded part is. Each sampled point looks along its inward
// normal for the other skin facing back, as the Wall Thickness workspace's
// ray does; the gauge is how far it found it, the share of the area that
// found one says how much of the part is sheet. A solid part's rays run
// past the reach, a single skin's find nothing.
//
// On a part made that way, what stands apart from its main walls — a tab
// bent in from one, a rib inside a shell — is gathered too: the walls are
// the largest flat surfaces, and scan farther than a few gauges from every
// one of them is something else to model.

import * as THREE from 'three'
import type { MeshBVH } from 'three-mesh-bvh'
import { orthoBasis, symmetricEigen3 } from '../fit/linalg'
import { vertexAreas } from '../fit/segment'
import type { MeshGraph, Vec3 } from '../types'

/** A cluster of scan standing apart from the part's main walls. */
export interface SheetApart {
  center: Vec3
  min: Vec3
  max: Vec3
  /** mm², both skins of it. */
  area: number
}

export interface SheetReading {
  /** Points a back skin was looked for from. */
  sampled: number
  /** How far it was looked for, mm. */
  reach: number
  /** The share of the area with the other skin facing back within reach. */
  twoSkins: number
  /** How far the other skin lay, over the points that found one, mm. */
  gauge: { p5: number; p50: number; p95: number } | null
  /** Only on a part mostly two skins (SHEET_SHARE) whose flat walls make most
   *  of it: what lies farther than reach from every main wall, the largest
   *  first. */
  apart?: { reach: number; walls: number; regions: SheetApart[]; more: number }
}

/** The least share of two skins that makes a part a sheet, or a thin shell. */
export const SHEET_SHARE = 0.5
/** A flat surface holding this share of the area at least is a main wall. */
const WALL_SHARE = 0.02
/** The main walls have to hold this share of the area for anything to be
 *  read as standing apart from them: a curved shell has none. */
const WALLS_COVER = 0.6
/** How far a wall's normals may lean off its plane, degrees. */
const WALL_DEG = 10
/** Walls are looked for over this many points. */
const WALL_SAMPLE = 3000
/** Candidates tried for each wall. */
const WALL_TRIES = 150
const WALLS_MAX = 24
/** Regions answered at most, and the fewest points one is made of. */
const APART_MAX = 6
const APART_LEAST = 6
/** How many surfaces a ray may pass before giving up on one facing back. */
const ATTEMPTS = 6
/** How squarely the other skin faces back, as the cosine: 30°. */
const FACING = Math.cos(Math.PI / 6)

/**
 * The sheet reading over `sample` points spread through the scan's
 * vertices, and with `apartSample` points what stands apart from its
 * walls. `noise` is the scan's median scatter, mm: a wall's points lie
 * within a few of it of its plane.
 */
export function sheetReading(g: MeshGraph, bvh: MeshBVH, opts: { sample: number; apartSample: number; noise: number }): SheetReading {
  const { positions: p, normals: nrm, vertexCount: V } = g
  const areas = vertexAreas(g)
  const reach = Math.min(6, Math.max(1, 0.05 * g.bboxDiag))
  const near = Math.max(1e-6, g.bboxDiag * 1e-5)
  const ray = new THREE.Ray()
  const step = Math.max(1, Math.floor(V / opts.sample))
  const gauges: number[] = []
  let all = 0
  let paired = 0
  let sampled = 0
  for (let v = 0; v < V; v += step) {
    const nx = nrm[v * 3], ny = nrm[v * 3 + 1], nz = nrm[v * 3 + 2]
    const l = Math.hypot(nx, ny, nz)
    if (!(l > 0)) continue
    sampled++
    all += areas[v]
    ray.origin.set(p[v * 3], p[v * 3 + 1], p[v * 3 + 2])
    ray.direction.set(-nx / l, -ny / l, -nz / l)
    const d = backSkin(bvh, ray, near, reach)
    if (d === null) continue
    paired += areas[v]
    gauges.push(d)
  }
  gauges.sort((a, b) => a - b)
  const pct = (q: number) => gauges[Math.min(gauges.length - 1, Math.floor(q * gauges.length))]
  const twoSkins = all > 0 ? paired / all : 0
  const out: SheetReading = { sampled, reach, twoSkins, gauge: gauges.length >= 12 ? { p5: pct(0.05), p50: pct(0.5), p95: pct(0.95) } : null }
  if (twoSkins < SHEET_SHARE || !out.gauge) return out
  const apart = apartFromWalls(g, areas, opts.apartSample, Math.max(1.5, 5 * out.gauge.p50, 0.01 * g.bboxDiag), Math.max(0.05, 3 * opts.noise))
  if (apart) out.apart = apart
  return out
}

/** How far along the ray the first surface facing back at it lies — the
 *  other skin — within `far`; null for none. Surfaces facing the way the
 *  ray started from are the near skin's own and are stepped past. */
function backSkin(bvh: MeshBVH, ray: THREE.Ray, near: number, far: number): number | null {
  let start = near
  for (let k = 0; k < ATTEMPTS; k++) {
    const hit = bvh.raycastFirst(ray, THREE.DoubleSide, start, far)
    if (!hit || !hit.face) return null
    // The ray runs into the material, against the outward normal: the
    // other skin's outward normal runs with it.
    if (hit.face.normal.dot(ray.direction) >= FACING) return hit.distance
    start = hit.distance + near
  }
  return null
}

interface Wall {
  normal: Vec3
  d: number
  u: Vec3
  v: Vec3
  lo: [number, number]
  hi: [number, number]
}

/** The scan's flat walls over the sample, the largest first, each with
 *  its extent in its own plane; and the share of the area they hold. */
function wallsOf(P: Float64Array, N: Float64Array, W: Float64Array, tol: number): { walls: Wall[]; covered: number } {
  const n = W.length
  const free = new Uint8Array(n).fill(1)
  const total = W.reduce((s, w) => s + w, 0)
  const cos = Math.cos((WALL_DEG * Math.PI) / 180)
  const on = (i: number, nn: Vec3, d: number) =>
    Math.abs(N[i * 3] * nn[0] + N[i * 3 + 1] * nn[1] + N[i * 3 + 2] * nn[2]) >= cos && Math.abs(P[i * 3] * nn[0] + P[i * 3 + 1] * nn[1] + P[i * 3 + 2] * nn[2] - d) <= tol
  const walls: Wall[] = []
  let covered = 0
  while (walls.length < WALLS_MAX) {
    const left: number[] = []
    for (let i = 0; i < n; i++) if (free[i]) left.push(i)
    if (left.length < 3) break
    let best = 0
    let bestPlane: { normal: Vec3; d: number } | null = null
    const stride = Math.max(1, Math.floor(left.length / WALL_TRIES))
    for (let t = 0; t < left.length; t += stride) {
      const c = left[t]
      const nn: Vec3 = [N[c * 3], N[c * 3 + 1], N[c * 3 + 2]]
      const d = P[c * 3] * nn[0] + P[c * 3 + 1] * nn[1] + P[c * 3 + 2] * nn[2]
      let s = 0
      for (const i of left) if (on(i, nn, d)) s += W[i]
      if (s > best) {
        best = s
        bestPlane = { normal: nn, d }
      }
    }
    if (!bestPlane || best < WALL_SHARE * total) break
    // Fitted again over the points it holds, and those counted again.
    const held = left.filter((i) => on(i, bestPlane!.normal, bestPlane!.d))
    const plane = planeThrough(P, held) ?? bestPlane
    let share = 0
    const [u, v] = orthoBasis(plane.normal)
    const lo: [number, number] = [Infinity, Infinity]
    const hi: [number, number] = [-Infinity, -Infinity]
    for (const i of left) {
      if (!on(i, plane.normal, plane.d)) continue
      free[i] = 0
      share += W[i]
      const a = P[i * 3] * u[0] + P[i * 3 + 1] * u[1] + P[i * 3 + 2] * u[2]
      const b = P[i * 3] * v[0] + P[i * 3 + 1] * v[1] + P[i * 3 + 2] * v[2]
      lo[0] = Math.min(lo[0], a)
      lo[1] = Math.min(lo[1], b)
      hi[0] = Math.max(hi[0], a)
      hi[1] = Math.max(hi[1], b)
    }
    if (share < WALL_SHARE * total) break
    walls.push({ ...plane, u, v, lo, hi })
    covered += share / total
  }
  return { walls, covered }
}

/** The least-squares plane through the points. */
function planeThrough(P: Float64Array, idx: readonly number[]): { normal: Vec3; d: number } | null {
  if (idx.length < 3) return null
  let cx = 0, cy = 0, cz = 0
  for (const i of idx) {
    cx += P[i * 3]
    cy += P[i * 3 + 1]
    cz += P[i * 3 + 2]
  }
  cx /= idx.length
  cy /= idx.length
  cz /= idx.length
  const cov = new Float64Array(9)
  for (const i of idx) {
    const x = P[i * 3] - cx, y = P[i * 3 + 1] - cy, z = P[i * 3 + 2] - cz
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
  const normal = symmetricEigen3(cov).vectors[0]
  return { normal, d: cx * normal[0] + cy * normal[1] + cz * normal[2] }
}

/**
 * What stands apart from the scan's main walls: over `sample` points, those
 * farther than `reach` from every wall — off its plane, or past its extent
 * — gathered into clusters of points within a few spacings of each other.
 * Null where the walls hold too little of the part to say.
 */
function apartFromWalls(g: MeshGraph, areas: Float32Array, sample: number, reach: number, tol: number): SheetReading['apart'] | null {
  const V = g.vertexCount
  const step = Math.max(1, Math.floor(V / sample))
  const n = Math.ceil(V / step)
  const P = new Float64Array(n * 3)
  const N = new Float64Array(n * 3)
  const W = new Float64Array(n)
  let k = 0
  for (let v = 0; v < V; v += step, k++) {
    const l = Math.hypot(g.normals[v * 3], g.normals[v * 3 + 1], g.normals[v * 3 + 2]) || 1
    for (let j = 0; j < 3; j++) {
      P[k * 3 + j] = g.positions[v * 3 + j]
      N[k * 3 + j] = g.normals[v * 3 + j] / l
    }
    W[k] = areas[v]
  }
  // The walls are looked for over every so many of the points.
  const every = Math.max(1, Math.floor(n / WALL_SAMPLE))
  const m = Math.ceil(n / every)
  const sP = new Float64Array(m * 3)
  const sN = new Float64Array(m * 3)
  const sW = new Float64Array(m)
  for (let i = 0, j = 0; i < n; i += every, j++) {
    for (let c = 0; c < 3; c++) {
      sP[j * 3 + c] = P[i * 3 + c]
      sN[j * 3 + c] = N[i * 3 + c]
    }
    sW[j] = W[i]
  }
  const { walls, covered } = wallsOf(sP, sN, sW, tol)
  if (covered < WALLS_COVER) return null
  const total = vertexTotal(areas)
  const weight = total / W.reduce((s, w) => s + w, 0)
  const off: number[] = []
  for (let i = 0; i < n; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2]
    const kept = walls.some((w) => {
      if (Math.abs(x * w.normal[0] + y * w.normal[1] + z * w.normal[2] - w.d) > reach) return false
      const a = x * w.u[0] + y * w.u[1] + z * w.u[2]
      const b = x * w.v[0] + y * w.v[1] + z * w.v[2]
      return a >= w.lo[0] - reach && a <= w.hi[0] + reach && b >= w.lo[1] - reach && b <= w.hi[1] + reach
    })
    if (!kept) off.push(i)
  }
  // Points within a few spacings of each other are one cluster.
  const link = 3 * Math.sqrt(total / n)
  const cellOf = (i: number) => [Math.floor(P[i * 3] / link), Math.floor(P[i * 3 + 1] / link), Math.floor(P[i * 3 + 2] / link)]
  const key = (a: number, b: number, c: number) => `${a},${b},${c}`
  const grid = new Map<string, number[]>()
  for (const i of off) {
    const [a, b, c] = cellOf(i)
    const kk = key(a, b, c)
    const list = grid.get(kk)
    if (list) list.push(i)
    else grid.set(kk, [i])
  }
  const seen = new Set<number>()
  const regions: SheetApart[] = []
  const least = 2 * reach * reach
  for (const s of off) {
    if (seen.has(s)) continue
    seen.add(s)
    const members = [s]
    for (let h = 0; h < members.length; h++) {
      const i = members[h]
      const [a, b, c] = cellOf(i)
      for (let da = -1; da <= 1; da++) for (let db = -1; db <= 1; db++) for (let dc = -1; dc <= 1; dc++) {
        for (const j of grid.get(key(a + da, b + db, c + dc)) ?? []) {
          if (seen.has(j)) continue
          if (Math.hypot(P[i * 3] - P[j * 3], P[i * 3 + 1] - P[j * 3 + 1], P[i * 3 + 2] - P[j * 3 + 2]) > link) continue
          seen.add(j)
          members.push(j)
        }
      }
    }
    if (members.length < APART_LEAST) continue
    let area = 0
    const c: Vec3 = [0, 0, 0]
    const min: Vec3 = [Infinity, Infinity, Infinity]
    const max: Vec3 = [-Infinity, -Infinity, -Infinity]
    for (const i of members) {
      const w = W[i] * weight
      area += w
      for (let j = 0; j < 3; j++) {
        c[j] += P[i * 3 + j] * w
        min[j] = Math.min(min[j], P[i * 3 + j])
        max[j] = Math.max(max[j], P[i * 3 + j])
      }
    }
    if (!(area >= least)) continue
    regions.push({ center: [c[0] / area, c[1] / area, c[2] / area], min, max, area })
  }
  regions.sort((a, b) => b.area - a.area)
  return { reach, walls: walls.length, regions: regions.slice(0, APART_MAX), more: Math.max(0, regions.length - APART_MAX) }
}

function vertexTotal(areas: Float32Array): number {
  let s = 0
  for (let i = 0; i < areas.length; i++) s += areas[i]
  return s
}

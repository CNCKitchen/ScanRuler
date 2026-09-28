// SPDX-License-Identifier: AGPL-3.0-only
// A first alignment proposed from the scan alone.
//
// A machined or printed part says where its axes are: most of its surface is
// flat faces square to one another, and walls — flat or round — that run along
// one of those directions. So the search here is a vote of the surface's
// normals rather than a fit of anything. Every vertex votes its share of the
// area into a histogram over the directions of space (a normal and its
// opposite are the same direction: the two sides of a plate vote together),
// the peaks of the histogram are the directions the part's faces are square
// to, and a direction every wall's normal is perpendicular to — the pole of a
// great circle of votes — is the axis of a turned or extruded part. Frames are
// put together from those candidates and judged by how much of the surface
// they explain, and the winner is settled on the normals themselves: the one
// rotation that best lays every face's normal on its axis, so the two walls of
// a drafted pocket, leaning a degree each way, average onto the direction they
// were drawn about instead of one of them winning.
//
// None of this needs a closed mesh — half a part votes the same directions as
// the whole one — and none of it needs the scan thinned first: it is a handful
// of passes over the vertices.
//
// A scan is rarely whole, and what is missing is evidence too. Where the scan
// ends in a flat rim — the mouth of a housing, the edge a part was cut off at
// on the table — the face that would close it is a face of the part, and
// often its largest: the one it rests on, which the scanner never saw. Such
// an opening votes as the face it stands for, with the area it spans. Without
// it a housing's chamfers can outvote the frame its missing base belongs to.
//
// Which of the frame's directions is up is a separate question, answered from
// what a scan shows of how the part stood. A closed part is laid on its
// largest flat face, the way a slicer lays a part on the bed, a turned part on
// an end of its axis — and the side a scan is open on weighs in beside the
// faces, by how much of that side of the box the opening covers: an open scan
// is open where it sat. How open it is, and which way, is the scan's vector
// area — the sum of its triangles' areas along their normals, which is zero
// for a closed surface and otherwise exactly the area of the openings, seen
// along the direction they face, however ragged their edges.
//
// The principal axes of the point cloud are the fallback, and only that — a
// cube has none, and one lug on the side of a channel turns them by degrees.

import { rigidFromQuaternion, type Rigid } from './deviation/rigid'
import { symmetricEigen3, symmetricEigenN } from './fit/linalg'
import type { MeshGraph, Vec3 } from './types'
import { addScaled, cross, dot, normalize } from './vec'

export type AutoAlignMethod = 'planes' | 'axis' | 'principal'

/** How the side the part stands on was told: the side an open scan is open
 *  on, the largest flat face, the better end of the main axis, or — with
 *  nothing else to go by — the flattest way to lay the bounding box. */
export type AutoAlignBase = 'open-side' | 'face' | 'axis-end' | 'extent'

export interface AutoAlignResult {
  /** The part's directions that become +X, +Y and +Z: unit, right-handed, in
   *  the frame the scan is in now. */
  axes: [Vec3, Vec3, Vec3]
  /** The point that becomes 0, 0, 0 — on the plane the part stands on, under
   *  the middle of its box, or on the main axis where there is one. */
  origin: Vec3
  method: AutoAlignMethod
  base: AutoAlignBase
  /** Share of the surface whose normal lies along one of the axes. */
  planeShare: number
  /** Share of the surface that is wall running along one of the axes without
   *  facing another — bores, shafts, the rounds of an extrusion. */
  wallShare: number
  /** Whether the origin was put on a common axis of the round walls. */
  onAxis: boolean
}

/** Bins along one edge of a cube-map face. With the equal-angle warp a bin is
 *  90° / 64 ≈ 1.4° wide. */
const BINS = 64
/** A normal this close to a direction votes for it. */
const CAP_DEG = 4
/** A normal this close to square to a direction is a wall running along it. */
const BAND_DEG = 4
/** A peak holding less of the surface than this is not a direction of the part. */
const MIN_MODE_SHARE = 0.015
/** Two candidate directions this far from square can still be one frame — a
 *  drafted wall, a face the scan caught badly. */
const SQUARE_TOL_DEG = 5
/** What a wall counts for beside a face: a wall says its axis lies somewhere
 *  in a plane, a face says where. */
const WALL_WORTH = 0.5
/** Frames scoring within this of the best are told apart by their box. */
const SCORE_TIE = 0.03
/** What a side of the box being open counts for beside a flat face when the
 *  part is stood up: a side wholly open outweighs any face — no face is half
 *  the surface — and one a quarter open counts like a face of an eighth. */
const OPEN_WORTH = 0.5
/** The openings face a side when they face within this of it. */
const OPEN_FACING_DEG = 35

const rad = (deg: number) => (deg * Math.PI) / 180

// ---------------------------------------------------------------------------
// What the mesh is read into

/** The surface as weighted samples: a point, the way the surface faces there,
 *  and the area it stands for.
 *
 *  The first `vertexCount` samples are the mesh's vertices, each with its
 *  normal averaged over the neighbourhood — a scan's triangle is a fraction of
 *  a millimetre across and its noise turns the normal by degrees, which would
 *  smear every peak. A vertex stands for a third of every triangle on it —
 *  unless it lies on an edge of the part, where its normal is a blend of the
 *  faces meeting there and points along none of them. The triangles on such a
 *  vertex vote for themselves instead, as samples of their own at their
 *  middles; a twelve-triangle cube out of CAD votes that way entirely. */
interface Prepared {
  count: number
  pos: Float32Array
  normals: Float32Array
  weight: Float64Array
  total: number
  /** The scan's vector area, Σ area · normal: nothing for a closed surface,
   *  for an open one as long as the openings are large seen along it, and
   *  pointing away from them. */
  vectorArea: Vec3
  /** The open edges of the scan, loop by loop, largest first. */
  openings: Opening[]
}

interface Opening {
  /** Area the loop spans, as a share of the scan's surface. */
  share: number
  /** The normal of the plane the loop lies in, when it lies in one — a rim,
   *  not the ragged edge where the scanner lost the surface. */
  normal: Vec3 | null
}

/** An opening spanning less of the surface than this is a hole, not a side. */
const MIN_OPENING_SHARE = 0.03
/** A loop is flat when it leaves its plane by less than this share of its size. */
const FLAT_LOOP = 0.02

/** A vertex with a triangle on it facing further than this from the vertex's
 *  own normal lies on an edge of the part. Scan noise turns a triangle by a
 *  few degrees, an edge by tens. Normals are not averaged across this either. */
const EDGE_DEG = 30

function prepare(g: MeshGraph, smoothing: number): Prepared {
  const { positions: p, indices, vertexCount } = g
  const area = new Float64Array(vertexCount)
  let total = 0
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2]
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2]
    const third = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 6
    if (!(third > 0)) continue
    total += 3 * third
    area[indices[t]] += third
    area[indices[t + 1]] += third
    area[indices[t + 2]] += third
  }

  const { vectorArea, openings } = readOpenings(g, total)

  const cosEdge = Math.cos(rad(EDGE_DEG))
  const onEdge = new Uint8Array(vertexCount)
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2]
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2]
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const l = Math.hypot(nx, ny, nz)
    if (!(l > 0)) continue
    for (const o of [a, b, c])
      if (nx * g.normals[o] + ny * g.normals[o + 1] + nz * g.normals[o + 2] < cosEdge * l) onEdge[o / 3] = 1
  }

  let normals = g.normals
  for (let pass = 0; pass < smoothing; pass++) {
    const out = new Float32Array(normals.length)
    for (let v = 0; v < vertexCount; v++) {
      const w = 2 * area[v]
      let x = normals[v * 3] * w, y = normals[v * 3 + 1] * w, z = normals[v * 3 + 2] * w
      for (let i = g.adjOffsets[v]; i < g.adjOffsets[v + 1]; i++) {
        const n = g.adjList[i]
        // Not across an edge of the part: a neighbour on the next face would
        // lean this normal towards it, and a leaning normal reads as a wall.
        if (onEdge[n]) continue
        const along =
          normals[n * 3] * normals[v * 3] + normals[n * 3 + 1] * normals[v * 3 + 1] + normals[n * 3 + 2] * normals[v * 3 + 2]
        if (along < cosEdge) continue
        x += normals[n * 3] * area[n]
        y += normals[n * 3 + 1] * area[n]
        z += normals[n * 3 + 2] * area[n]
      }
      const l = Math.hypot(x, y, z)
      if (l > 0) {
        out[v * 3] = x / l
        out[v * 3 + 1] = y / l
        out[v * 3 + 2] = z / l
      } else {
        out[v * 3] = normals[v * 3]
        out[v * 3 + 1] = normals[v * 3 + 1]
        out[v * 3 + 2] = normals[v * 3 + 2]
      }
    }
    normals = out
  }

  // Hand every triangle's area to its vertices, and to a sample of its own
  // for the ones that lie on an edge.
  const vertexWeight = new Float64Array(vertexCount)
  const own: number[] = []
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2]
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2]
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const l = Math.hypot(nx, ny, nz)
    if (!(l > 0)) continue
    nx /= l
    ny /= l
    nz /= l
    const third = l / 6
    let kept = 0
    for (const o of [a, b, c]) {
      if (onEdge[o / 3]) kept += third
      else vertexWeight[o / 3] += third
    }
    if (kept > 0)
      own.push((p[a] + p[b] + p[c]) / 3, (p[a + 1] + p[b + 1] + p[c + 1]) / 3, (p[a + 2] + p[b + 2] + p[c + 2]) / 3, nx, ny, nz, kept)
  }
  const extra = own.length / 7
  const count = vertexCount + extra
  const pos = new Float32Array(count * 3)
  const sampleNormals = new Float32Array(count * 3)
  const weight = new Float64Array(count)
  pos.set(p.subarray(0, vertexCount * 3))
  sampleNormals.set(normals.subarray(0, vertexCount * 3))
  weight.set(vertexWeight)
  for (let i = 0; i < extra; i++) {
    const k = vertexCount + i
    pos[k * 3] = own[i * 7]
    pos[k * 3 + 1] = own[i * 7 + 1]
    pos[k * 3 + 2] = own[i * 7 + 2]
    sampleNormals[k * 3] = own[i * 7 + 3]
    sampleNormals[k * 3 + 1] = own[i * 7 + 4]
    sampleNormals[k * 3 + 2] = own[i * 7 + 5]
    weight[k] = own[i * 7 + 6]
  }
  return { count, pos, normals: sampleNormals, weight, total, vectorArea, openings }
}

/** The scan's open edges. An edge inside the surface is shared by two
 *  triangles, so the neighbour at its far end is listed twice; on an open edge
 *  it is listed once. Taken the way its triangle runs, the open edges of one
 *  loop sum — ½ Σ a × b — to the vector area of the surface they bound
 *  (Stokes), so each loop's span and facing come without walking it in order. */
function readOpenings(g: MeshGraph, total: number): { vectorArea: Vec3; openings: Opening[] } {
  const { positions: p, indices } = g
  const once = (a: number, b: number): boolean => {
    let seen = 0
    for (let i = g.adjOffsets[a]; i < g.adjOffsets[a + 1]; i++) if (g.adjList[i] === b) seen++
    return seen === 1
  }
  const edges: number[] = []
  const vectorArea: Vec3 = [0, 0, 0]
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2]
    const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2]
    const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2]
    vectorArea[0] += (uy * vz - uz * vy) / 2
    vectorArea[1] += (uz * vx - ux * vz) / 2
    vectorArea[2] += (ux * vy - uy * vx) / 2
    if (once(a, b)) edges.push(a, b)
    if (once(b, c)) edges.push(b, c)
    if (once(c, a)) edges.push(c, a)
  }

  // Loops are the connected sets of open edges.
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
  for (const v of edges) if (!parent.has(v)) parent.set(v, v)
  for (let e = 0; e < edges.length; e += 2) parent.set(find(edges[e]), find(edges[e + 1]))

  // Per loop: its vector area, and the scatter of its edges' middles by
  // length — what says whether it lies in a plane.
  interface Loop { area: Vec3; length: number; mean: Vec3; second: Float64Array }
  const loops = new Map<number, Loop>()
  // Measured from a point of the part, so the cross products stay small.
  const o: Vec3 = [p[0], p[1], p[2]]
  for (let e = 0; e < edges.length; e += 2) {
    const a = edges[e] * 3, b = edges[e + 1] * 3
    const root = find(edges[e])
    let loop = loops.get(root)
    if (!loop) loops.set(root, (loop = { area: [0, 0, 0], length: 0, mean: [0, 0, 0], second: new Float64Array(9) }))
    const ax = p[a] - o[0], ay = p[a + 1] - o[1], az = p[a + 2] - o[2]
    const bx = p[b] - o[0], by = p[b + 1] - o[1], bz = p[b + 2] - o[2]
    loop.area[0] += (ay * bz - az * by) / 2
    loop.area[1] += (az * bx - ax * bz) / 2
    loop.area[2] += (ax * by - ay * bx) / 2
    const l = Math.hypot(bx - ax, by - ay, bz - az)
    const m = [(ax + bx) / 2, (ay + by) / 2, (az + bz) / 2]
    loop.length += l
    for (let i = 0; i < 3; i++) {
      loop.mean[i] += l * m[i]
      for (let j = 0; j < 3; j++) loop.second[i * 3 + j] += l * m[i] * m[j]
    }
  }

  const openings: Opening[] = []
  for (const loop of loops.values()) {
    const share = Math.hypot(...loop.area) / total
    if (share < MIN_OPENING_SHARE || !(loop.length > 0)) continue
    const c = new Float64Array(9)
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        c[i * 3 + j] = loop.second[i * 3 + j] / loop.length - (loop.mean[i] / loop.length) * (loop.mean[j] / loop.length)
    const e = symmetricEigen3(c)
    const flat = Math.sqrt(Math.max(0, e.values[0])) <= FLAT_LOOP * Math.sqrt(Math.max(0, e.values[2]))
    openings.push({ share, normal: flat ? e.vectors[0] : null })
  }
  openings.sort((a, b) => b.share - a.share)
  return { vectorArea, openings }
}

/** The votes: unit directions and the share of the surface behind each. */
interface Votes {
  dirs: Float64Array
  share: Float64Array
  count: number
  /** The votes of the surface itself come first; from here on they are the
   *  flat openings, each standing for the face that would close it. */
  scanned: number
}

/** The histogram over directions, a normal and its opposite in one bin: three
 *  faces of a cube map, warped so the bins subtend near-equal angles. */
function vote(pre: Prepared): Votes {
  const size = 3 * BINS * BINS
  const w = new Float64Array(size)
  const sx = new Float64Array(size), sy = new Float64Array(size), sz = new Float64Array(size)
  const n = pre.normals
  const warp = (4 / Math.PI) * 0.5 * BINS
  for (let v = 0; v < pre.count; v++) {
    const a = pre.weight[v]
    if (!(a > 0)) continue
    let x = n[v * 3], y = n[v * 3 + 1], z = n[v * 3 + 2]
    const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z)
    const face = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2
    const major = face === 0 ? x : face === 1 ? y : z
    if (major === 0) continue
    if (major < 0) {
      x = -x
      y = -y
      z = -z
    }
    const m = Math.abs(major)
    const s = face === 0 ? y : x
    const t = face === 2 ? y : z
    const i = Math.min(BINS - 1, Math.floor(Math.atan(s / m) * warp + BINS / 2))
    const j = Math.min(BINS - 1, Math.floor(Math.atan(t / m) * warp + BINS / 2))
    const bin = (face * BINS + i) * BINS + j
    w[bin] += a
    sx[bin] += a * x
    sy[bin] += a * y
    sz[bin] += a * z
  }
  let count = 0
  for (let b = 0; b < size; b++) if (w[b] > 0) count++
  const rims = pre.openings.filter((o) => o.normal !== null)
  const dirs = new Float64Array((count + rims.length) * 3)
  const share = new Float64Array(count + rims.length)
  let k = 0
  for (let b = 0; b < size; b++) {
    if (!(w[b] > 0)) continue
    const l = Math.hypot(sx[b], sy[b], sz[b])
    if (!(l > 0)) continue
    dirs[k * 3] = sx[b] / l
    dirs[k * 3 + 1] = sy[b] / l
    dirs[k * 3 + 2] = sz[b] / l
    share[k] = w[b] / pre.total
    k++
  }
  const scanned = k
  for (const rim of rims) {
    dirs.set(rim.normal!, k * 3)
    share[k] = rim.share
    k++
  }
  return { dirs, share, count: k, scanned }
}

// ---------------------------------------------------------------------------
// Candidate directions

interface Mode {
  dir: Vec3
  share: number
}

/** Climb from a direction to the peak it stands on: the mean of the votes
 *  within the cap, again from there, until it stops moving. */
function climb(votes: Votes, start: Vec3, cosCap: number): Mode {
  let d = start
  let share = 0
  for (let iter = 0; iter < 12; iter++) {
    let x = 0, y = 0, z = 0
    share = 0
    for (let b = 0; b < votes.count; b++) {
      const c = votes.dirs[b * 3] * d[0] + votes.dirs[b * 3 + 1] * d[1] + votes.dirs[b * 3 + 2] * d[2]
      if (Math.abs(c) < cosCap) continue
      const s = c < 0 ? -votes.share[b] : votes.share[b]
      x += s * votes.dirs[b * 3]
      y += s * votes.dirs[b * 3 + 1]
      z += s * votes.dirs[b * 3 + 2]
      share += votes.share[b]
    }
    const next = normalize([x, y, z])
    if (!next) break
    const moved = 1 - dot(next, d)
    d = next
    if (moved < 1e-12) break
  }
  return { dir: d, share }
}

function findModes(votes: Votes): Mode[] {
  const cosCap = Math.cos(rad(CAP_DEG))
  const cosSame = Math.cos(rad(2 * CAP_DEG))
  const order = Array.from({ length: votes.count }, (_, b) => b).sort((a, b) => votes.share[b] - votes.share[a])
  const modes: Mode[] = []
  for (const b of order.slice(0, 80)) {
    if (modes.length >= 12) break
    const seed: Vec3 = [votes.dirs[b * 3], votes.dirs[b * 3 + 1], votes.dirs[b * 3 + 2]]
    if (modes.some((m) => Math.abs(dot(m.dir, seed)) > cosSame)) continue
    const mode = climb(votes, seed, cosCap)
    if (mode.share < MIN_MODE_SHARE) continue
    if (modes.some((m) => Math.abs(dot(m.dir, mode.dir)) > cosSame)) continue
    modes.push(mode)
  }
  return modes.sort((a, b) => b.share - a.share)
}

/** The direction the walls run along: the one the normals that belong to no
 *  face direction are all square to. Null when the surface left over is
 *  little, or is a blob whose normals point everywhere. */
function findPole(votes: Votes, modes: Mode[]): Vec3 | null {
  const cosCap = Math.cos(rad(CAP_DEG))
  const free = new Uint8Array(votes.count)
  let freeShare = 0
  for (let b = 0; b < votes.count; b++) {
    const d: Vec3 = [votes.dirs[b * 3], votes.dirs[b * 3 + 1], votes.dirs[b * 3 + 2]]
    if (modes.some((m) => Math.abs(dot(m.dir, d)) >= cosCap)) continue
    free[b] = 1
    freeShare += votes.share[b]
  }
  if (freeShare < 0.1) return null
  let pole: Vec3 | null = null
  for (let iter = 0; iter < 4; iter++) {
    const gate = pole ? Math.sin(rad(iter < 2 ? 15 : 8)) : Infinity
    const s = new Float64Array(9)
    for (let b = 0; b < votes.count; b++) {
      if (!free[b]) continue
      const x = votes.dirs[b * 3], y = votes.dirs[b * 3 + 1], z = votes.dirs[b * 3 + 2]
      if (pole && Math.abs(x * pole[0] + y * pole[1] + z * pole[2]) > gate) continue
      const w = votes.share[b]
      s[0] += w * x * x; s[1] += w * x * y; s[2] += w * x * z
      s[4] += w * y * y; s[5] += w * y * z
      s[8] += w * z * z
    }
    s[3] = s[1]; s[6] = s[2]; s[7] = s[5]
    pole = symmetricEigen3(s).vectors[0]
  }
  if (!pole) return null
  const sinBand = Math.sin(rad(BAND_DEG))
  let band = 0
  for (let b = 0; b < votes.count; b++) {
    if (!free[b]) continue
    const c = votes.dirs[b * 3] * pole[0] + votes.dirs[b * 3 + 1] * pole[1] + votes.dirs[b * 3 + 2] * pole[2]
    if (Math.abs(c) <= sinBand) band += votes.share[b]
  }
  // Normals pointing everywhere leave sin(band) of themselves in any band.
  return band >= 0.12 && band >= 3 * sinBand * freeShare ? pole : null
}

// ---------------------------------------------------------------------------
// Frames

type Triad = [Vec3, Vec3, Vec3]

interface FrameScore {
  caps: [number, number, number]
  walls: [number, number, number]
  score: number
}

function scoreFrame(votes: Votes, f: Triad, count = votes.count): FrameScore {
  const cosCap = Math.cos(rad(CAP_DEG))
  const sinBand = Math.sin(rad(BAND_DEG))
  const caps: [number, number, number] = [0, 0, 0]
  const walls: [number, number, number] = [0, 0, 0]
  for (let b = 0; b < count; b++) {
    const x = votes.dirs[b * 3], y = votes.dirs[b * 3 + 1], z = votes.dirs[b * 3 + 2]
    const c0 = Math.abs(x * f[0][0] + y * f[0][1] + z * f[0][2])
    const c1 = Math.abs(x * f[1][0] + y * f[1][1] + z * f[1][2])
    const c2 = Math.abs(x * f[2][0] + y * f[2][1] + z * f[2][2])
    if (c0 >= cosCap) caps[0] += votes.share[b]
    else if (c1 >= cosCap) caps[1] += votes.share[b]
    else if (c2 >= cosCap) caps[2] += votes.share[b]
    else if (c0 <= sinBand) walls[0] += votes.share[b]
    else if (c1 <= sinBand) walls[1] += votes.share[b]
    else if (c2 <= sinBand) walls[2] += votes.share[b]
  }
  const score = caps[0] + caps[1] + caps[2] + WALL_WORTH * (walls[0] + walls[1] + walls[2])
  return { caps, walls, score }
}

/** What speaks for one direction on its own: the faces square to it and the
 *  walls along it. */
function evidence(votes: Votes, d: Vec3): number {
  const cosCap = Math.cos(rad(CAP_DEG))
  const sinBand = Math.sin(rad(BAND_DEG))
  let sum = 0
  for (let b = 0; b < votes.count; b++) {
    const c = Math.abs(votes.dirs[b * 3] * d[0] + votes.dirs[b * 3 + 1] * d[1] + votes.dirs[b * 3 + 2] * d[2])
    if (c >= cosCap) sum += votes.share[b]
    else if (c <= sinBand) sum += WALL_WORTH * votes.share[b]
  }
  return sum
}

/** A thinned set of vertices, for the questions that only need the part's
 *  overall shape. */
function strideOf(vertexCount: number, wanted: number): number {
  return Math.max(1, Math.floor(vertexCount / wanted))
}

function boxVolume(g: MeshGraph, f: Triad): number {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  const p = g.positions
  const step = strideOf(g.vertexCount, 40000)
  for (let v = 0; v < g.vertexCount; v += step) {
    for (let k = 0; k < 3; k++) {
      const h = p[v * 3] * f[k][0] + p[v * 3 + 1] * f[k][1] + p[v * 3 + 2] * f[k][2]
      if (h < lo[k]) lo[k] = h
      if (h > hi[k]) hi[k] = h
    }
  }
  return (hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2])
}

/** A direction square to `d1` for a part that offers none of its own: the
 *  long way of its outline seen along `d1`, or — for an outline as wide as it
 *  is long — the present X, so a round part is not spun for no reason. */
function fallbackSecond(g: MeshGraph, d1: Vec3): Vec3 {
  const seed = Math.abs(d1[0]) < 0.9 ? ([1, 0, 0] as Vec3) : ([0, 1, 0] as Vec3)
  const u = normalize(addScaled(seed, d1, -dot(seed, d1)))!
  const v = cross(d1, u)
  const p = g.positions
  const step = strideOf(g.vertexCount, 40000)
  let n = 0, mu = 0, mv = 0
  for (let i = 0; i < g.vertexCount; i += step) {
    mu += p[i * 3] * u[0] + p[i * 3 + 1] * u[1] + p[i * 3 + 2] * u[2]
    mv += p[i * 3] * v[0] + p[i * 3 + 1] * v[1] + p[i * 3 + 2] * v[2]
    n++
  }
  mu /= n
  mv /= n
  let suu = 0, suv = 0, svv = 0
  for (let i = 0; i < g.vertexCount; i += step) {
    const a = p[i * 3] * u[0] + p[i * 3 + 1] * u[1] + p[i * 3 + 2] * u[2] - mu
    const b = p[i * 3] * v[0] + p[i * 3 + 1] * v[1] + p[i * 3 + 2] * v[2] - mv
    suu += a * a
    suv += a * b
    svv += b * b
  }
  const mean = (suu + svv) / 2
  const diff = Math.hypot((suu - svv) / 2, suv)
  if (mean > 0 && (mean + diff) / Math.max(mean - diff, 1e-30) > 1.2) {
    const angle = 0.5 * Math.atan2(2 * suv, suu - svv)
    return normalize(addScaled(scaleVec(u, Math.cos(angle)), v, Math.sin(angle)))!
  }
  return u
}

const scaleVec = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]

function principalTriad(g: MeshGraph): Triad {
  const p = g.positions
  const step = strideOf(g.vertexCount, 40000)
  let n = 0
  const m = [0, 0, 0]
  for (let v = 0; v < g.vertexCount; v += step) {
    m[0] += p[v * 3]; m[1] += p[v * 3 + 1]; m[2] += p[v * 3 + 2]
    n++
  }
  const c = new Float64Array(9)
  for (let v = 0; v < g.vertexCount; v += step) {
    const x = p[v * 3] - m[0] / n, y = p[v * 3 + 1] - m[1] / n, z = p[v * 3 + 2] - m[2] / n
    c[0] += x * x; c[1] += x * y; c[2] += x * z
    c[4] += y * y; c[5] += y * z
    c[8] += z * z
  }
  c[3] = c[1]; c[6] = c[2]; c[7] = c[5]
  const e = symmetricEigen3(c).vectors
  return [e[2], e[1], cross(e[2], e[1])]
}

// ---------------------------------------------------------------------------
// Settling the frame on the normals themselves

/** The rotation that best carries the unit vectors summed into `s` onto the
 *  axes they were summed for — Horn's closed form, as in absoluteOrientation,
 *  on directions instead of points. `s` is row-major, s[i][k] the i component
 *  of everything that should become axis k. */
function bestRotation(s: Float64Array): Rigid {
  const sxx = s[0], sxy = s[1], sxz = s[2]
  const syx = s[3], syy = s[4], syz = s[5]
  const szx = s[6], szy = s[7], szz = s[8]
  const nMat = [
    sxx + syy + szz, syz - szy, szx - sxz, sxy - syx,
    syz - szy, sxx - syy - szz, sxy + syx, szx + sxz,
    szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy,
    sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz,
  ]
  const q = symmetricEigenN(4, nMat).vectors[3]
  return rigidFromQuaternion(q[0], q[1], q[2], q[3])
}

/** One round of laying the faces' normals on the axes: every normal within
 *  `capDeg` of an axis pulls the frame, by the area behind it. With faces on
 *  only one axis that axis is set and the other two are squared up to it. */
function settleOnFaces(pre: Prepared, f: Triad, capDeg: number): Triad {
  const cosCap = Math.cos(rad(capDeg))
  const s = new Float64Array(9)
  const held = [0, 0, 0]
  const n = pre.normals
  for (let v = 0; v < pre.count; v++) {
    const w = pre.weight[v]
    if (!(w > 0)) continue
    const x = n[v * 3], y = n[v * 3 + 1], z = n[v * 3 + 2]
    for (let k = 0; k < 3; k++) {
      const c = x * f[k][0] + y * f[k][1] + z * f[k][2]
      if (Math.abs(c) < cosCap) continue
      const sw = c < 0 ? -w : w
      s[k] += sw * x
      s[3 + k] += sw * y
      s[6 + k] += sw * z
      held[k] += w
      break
    }
  }
  const live = [0, 1, 2].filter((k) => held[k] >= 0.005 * pre.total)
  if (live.length === 0) return f
  if (live.length === 1) {
    const k = live[0]
    const d = normalize([s[k], s[3 + k], s[6 + k]])
    return d ? squareUp(f, k, d) : f
  }
  const r = bestRotation(s).r
  return [
    [r[0], r[1], r[2]],
    [r[3], r[4], r[5]],
    [r[6], r[7], r[8]],
  ]
}

/** The frame with axis `k` replaced by `d` and the other two turned the least
 *  that makes them square to it again. */
function squareUp(f: Triad, k: number, d: Vec3): Triad {
  const a = (k + 1) % 3, b = (k + 2) % 3
  const da = normalize(addScaled(f[a], d, -dot(f[a], d))) ?? normalize(cross(f[b], d))!
  const out: Triad = [f[0], f[1], f[2]]
  out[k] = d
  out[a] = da
  out[b] = cross(d, da)
  return out
}

/** One round of setting the main axis square to its walls: the direction the
 *  normals of everything running along it scatter least along. */
function settleOnWalls(pre: Prepared, f: Triad, k: number, bandDeg: number): Triad {
  const sinBand = Math.sin(rad(bandDeg))
  const cosCap = Math.cos(rad(CAP_DEG))
  const a = (k + 1) % 3, b = (k + 2) % 3
  const s = new Float64Array(9)
  const n = pre.normals
  for (let v = 0; v < pre.count; v++) {
    const w = pre.weight[v]
    if (!(w > 0)) continue
    const x = n[v * 3], y = n[v * 3 + 1], z = n[v * 3 + 2]
    if (Math.abs(x * f[k][0] + y * f[k][1] + z * f[k][2]) > sinBand) continue
    // A flat face of the frame is a wall too, but it has already had its say.
    if (Math.abs(x * f[a][0] + y * f[a][1] + z * f[a][2]) >= cosCap) continue
    if (Math.abs(x * f[b][0] + y * f[b][1] + z * f[b][2]) >= cosCap) continue
    s[0] += w * x * x; s[1] += w * x * y; s[2] += w * x * z
    s[4] += w * y * y; s[5] += w * y * z
    s[8] += w * z * z
  }
  s[3] = s[1]; s[6] = s[2]; s[7] = s[5]
  if (s[0] + s[4] + s[8] <= 0) return f
  let d = symmetricEigen3(s).vectors[0]
  if (dot(d, f[k]) < 0) d = scaleVec(d, -1)
  return squareUp(f, k, d)
}

// ---------------------------------------------------------------------------
// Which way up, and where zero is

interface Standing {
  axes: Triad
  origin: Vec3
  base: AutoAlignBase
  onAxis: boolean
}

function stand(g: MeshGraph, pre: Prepared, f: Triad, mainAxis: number | null): Standing {
  const p = pre.pos
  const n = pre.normals
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (let v = 0; v < g.vertexCount; v++) {
    // Every vertex a triangle uses, whatever it was left to vote with.
    if (g.adjOffsets[v + 1] === g.adjOffsets[v]) continue
    for (let k = 0; k < 3; k++) {
      const h = p[v * 3] * f[k][0] + p[v * 3 + 1] * f[k][1] + p[v * 3 + 2] * f[k][2]
      if (h < lo[k]) lo[k] = h
      if (h > hi[k]) hi[k] = h
    }
  }
  const eps = 0.01 * g.bboxDiag
  const cosFacing = Math.cos(rad(15))
  // Per side of the box (axis k, low side 0 or high side 1): the flat surface
  // lying on it and facing out of it, and the height that surface averages.
  const face = [0, 0, 0, 0, 0, 0]
  const level = [0, 0, 0, 0, 0, 0]
  for (let v = 0; v < pre.count; v++) {
    const w = pre.weight[v]
    if (!(w > 0)) continue
    for (let k = 0; k < 3; k++) {
      const h = p[v * 3] * f[k][0] + p[v * 3 + 1] * f[k][1] + p[v * 3 + 2] * f[k][2]
      const c = n[v * 3] * f[k][0] + n[v * 3 + 1] * f[k][1] + n[v * 3 + 2] * f[k][2]
      if (h - lo[k] <= eps && -c >= cosFacing) {
        face[k * 2] += w
        level[k * 2] += w * h
      }
      if (hi[k] - h <= eps && c >= cosFacing) {
        face[k * 2 + 1] += w
        level[k * 2 + 1] += w * h
      }
    }
  }
  /** How far a side already points down — a nudge between equals, so a part
   *  that lies nearly right is not turned over for the sake of it. */
  const down = (side: number) => {
    const k = side >> 1
    return (side & 1 ? -1 : 1) * f[k][2]
  }
  const best = (sides: number[], worth: (side: number) => number) =>
    sides.reduce((a, b) => (worth(b) > worth(a) ? b : a))
  const all = [0, 1, 2, 3, 4, 5]

  // How much of each side of the box the scan's openings cover. The missing
  // surface faces the way the vector area does not; a side counts as the open
  // one only when the openings face it rather than a neighbour of it.
  const openArea = Math.hypot(...pre.vectorArea)
  const cosOpen = Math.cos(rad(OPEN_FACING_DEG))
  const open = all.map((s) => {
    const k = s >> 1
    if (!(openArea >= MIN_OPENING_SHARE * pre.total)) return 0
    const facing = ((s & 1 ? -1 : 1) * dot(pre.vectorArea, f[k])) / openArea
    if (facing < cosOpen) return 0
    const sideArea = (hi[(k + 1) % 3] - lo[(k + 1) % 3]) * (hi[(k + 2) % 3] - lo[(k + 2) % 3])
    return sideArea > 0 ? Math.min(1, (openArea * facing) / sideArea) : 0
  })
  /** What speaks for standing the part on a side: the flat face on it, as a
   *  share of the surface, and the opening on it, as a share of the side. */
  const worth = (s: number) => (face[s] / pre.total) * (1 + 0.15 * down(s)) + OPEN_WORTH * open[s]

  let base: AutoAlignBase
  let side: number
  if (mainAxis !== null) {
    side = best([mainAxis * 2, mainAxis * 2 + 1], (s) => worth(s) + 1e-9 * down(s))
    base = OPEN_WORTH * open[side] > face[side] / pre.total ? 'open-side' : 'axis-end'
  } else {
    side = best(all, worth)
    if (OPEN_WORTH * open[side] > face[side] / pre.total) base = 'open-side'
    else if (face[side] >= 0.02 * pre.total) base = 'face'
    else {
      base = 'extent'
      const thin = [0, 1, 2].reduce((a, b) => (hi[b] - lo[b] < hi[a] - lo[a] ? b : a))
      side = best([thin * 2, thin * 2 + 1], down)
    }
  }

  const kz = side >> 1
  // The side the part stands on faces −Z.
  const z = scaleVec(f[kz], side & 1 ? -1 : 1)
  const ka = (kz + 1) % 3, kb = (kz + 2) % 3
  const kx = hi[ka] - lo[ka] >= hi[kb] - lo[kb] ? ka : kb
  let x = f[kx]
  const lean = Math.abs(x[0]) > 1e-6 ? x[0] : x[1]
  if (lean < 0) x = scaleVec(x, -1)
  const y = cross(z, x)

  // Zero: the height of the face the part stands on (or the lowest point,
  // without one), under the middle of the box.
  const ky = 3 - kz - kx
  const height = face[side] >= 0.01 * pre.total ? level[side] / face[side] : side & 1 ? hi[kz] : lo[kz]
  let origin: Vec3 = [0, 0, 0]
  origin = addScaled(origin, f[kz], height)
  origin = addScaled(origin, f[kx], (lo[kx] + hi[kx]) / 2)
  origin = addScaled(origin, f[ky], (lo[ky] + hi[ky]) / 2)

  let onAxis = false
  if (mainAxis === kz) {
    const at = axisPoint(pre, g.bboxDiag, z, x, y)
    if (at) {
      origin = addScaled(addScaled(scaleVec(f[kz], height), x, at[0]), y, at[1])
      onAxis = true
    }
  }
  return { axes: [x, y, z], origin, base, onAxis }
}

/** Where the common axis of the round walls crosses the X–Y plane: every
 *  wall normal, carried through its vertex, is a line through that axis, and
 *  the point nearest all those lines is a 2 × 2 solve. Null when the lines do
 *  not meet — walls that are flat, or bores that are side by side. */
function axisPoint(pre: Prepared, size: number, z: Vec3, x: Vec3, y: Vec3): [number, number] | null {
  const sinBand = Math.sin(rad(6))
  const cosCap = Math.cos(rad(CAP_DEG))
  const p = pre.pos
  const n = pre.normals
  let a00 = 0, a01 = 0, a11 = 0, b0 = 0, b1 = 0, sum = 0
  const pass = (solve: [number, number] | null): number => {
    let miss = 0
    for (let v = 0; v < pre.count; v++) {
      const w = pre.weight[v]
      if (!(w > 0)) continue
      const nx0 = n[v * 3], ny0 = n[v * 3 + 1], nz0 = n[v * 3 + 2]
      if (Math.abs(nx0 * z[0] + ny0 * z[1] + nz0 * z[2]) > sinBand) continue
      let u = nx0 * x[0] + ny0 * x[1] + nz0 * x[2]
      let t = nx0 * y[0] + ny0 * y[1] + nz0 * y[2]
      if (Math.abs(u) >= cosCap || Math.abs(t) >= cosCap) continue
      const l = Math.hypot(u, t)
      u /= l
      t /= l
      const cu = p[v * 3] * x[0] + p[v * 3 + 1] * x[1] + p[v * 3 + 2] * x[2]
      const cv = p[v * 3] * y[0] + p[v * 3 + 1] * y[1] + p[v * 3 + 2] * y[2]
      if (solve) {
        // Distance from the point to the line through (cu, cv) along (u, t).
        const d = (solve[0] - cu) * -t + (solve[1] - cv) * u
        miss += w * d * d
        continue
      }
      // I − n nᵀ, the projector across the line.
      const p00 = 1 - u * u, p01 = -u * t, p11 = 1 - t * t
      a00 += w * p00; a01 += w * p01; a11 += w * p11
      b0 += w * (p00 * cu + p01 * cv)
      b1 += w * (p01 * cu + p11 * cv)
      sum += w
    }
    return miss
  }
  pass(null)
  const det = a00 * a11 - a01 * a01
  if (!(sum > 0.05 * pre.total) || Math.abs(det) < 1e-9 * sum * sum) return null
  const at: [number, number] = [(a11 * b0 - a01 * b1) / det, (a00 * b1 - a01 * b0) / det]
  const rms = Math.sqrt(pass(at) / sum)
  return rms <= 0.02 * size ? at : null
}

// ---------------------------------------------------------------------------

export interface AutoAlignOptions {
  /** Passes of neighbourhood averaging over the vertex normals. */
  smoothing?: number
}

/** Propose the coordinate system of a scan — see the head of this file. */
export function autoAlign(g: MeshGraph, opts: AutoAlignOptions = {}): AutoAlignResult {
  if (g.vertexCount < 4 || g.triangleCount < 4) throw new Error('Too little surface to align.')
  const pre = prepare(g, opts.smoothing ?? 2)
  if (!(pre.total > 0)) throw new Error('Too little surface to align.')
  const votes = vote(pre)
  const modes = findModes(votes)
  const pole = findPole(votes, modes)

  // Candidate directions, the pole folded into a face direction it agrees
  // with — the end faces of a shaft and its wall name the same axis.
  const cosSame = Math.cos(rad(CAP_DEG))
  const candidates: Vec3[] = modes.map((m) => m.dir)
  if (pole && !candidates.some((c) => Math.abs(dot(c, pole)) >= cosSame)) candidates.push(pole)

  let method: AutoAlignMethod = 'principal'
  let frame: Triad = principalTriad(g)
  let mainAxis: number | null = null
  let planeShare = 0
  let wallShare = 0

  if (candidates.length > 0) {
    const sinTol = Math.sin(rad(SQUARE_TOL_DEG))
    const frames: { f: Triad; s: FrameScore }[] = []
    const worth = (d: Vec3) => evidence(votes, d)
    const firsts = candidates.length > 5 ? candidates.slice().sort((a, b) => worth(b) - worth(a)).slice(0, 5) : candidates
    for (const d1 of firsts) {
      const seconds = candidates.filter((c) => c !== d1 && Math.abs(dot(c, d1)) <= sinTol)
      if (seconds.length === 0) seconds.push(fallbackSecond(g, d1))
      for (const c of seconds) {
        const d2 = normalize(addScaled(c, d1, -dot(c, d1)))
        if (!d2) continue
        const f: Triad = [d1, d2, cross(d1, d2)]
        frames.push({ f, s: scoreFrame(votes, f) })
      }
    }
    if (frames.length > 0) {
      const top = Math.max(...frames.map((c) => c.s.score))
      const close = frames.filter((c) => c.s.score >= top - SCORE_TIE)
      const won = close.length === 1 ? close[0] : close.reduce((a, b) => (boxVolume(g, b.f) < boxVolume(g, a.f) ? b : a))
      frame = won.f
      method = 'planes'
      // A main axis: walls along one direction that outweigh the faces on the
      // other two — a shaft, a bush, an extrusion with a curved outline.
      const k = [0, 1, 2].reduce((a, b) => (won.s.walls[b] > won.s.walls[a] ? b : a))
      const others = won.s.caps[(k + 1) % 3] + won.s.caps[(k + 2) % 3]
      if (won.s.walls[k] >= 0.2 && won.s.walls[k] >= 2 * others) {
        method = 'axis'
        mainAxis = k
      }
      if (mainAxis !== null) {
        frame = settleOnWalls(pre, frame, mainAxis, 8)
        frame = settleOnWalls(pre, frame, mainAxis, BAND_DEG)
        // The faces clock the part about its axis; the axis stays the walls'.
        frame = squareUp(settleOnFaces(pre, frame, 3), mainAxis, frame[mainAxis])
      } else {
        frame = settleOnFaces(pre, frame, 6)
        frame = settleOnFaces(pre, frame, 3)
      }
      // What is reported is the surface that was scanned, not what stands in
      // for the rest of it.
      const settled = scoreFrame(votes, frame, votes.scanned)
      planeShare = settled.caps[0] + settled.caps[1] + settled.caps[2]
      wallShare = settled.walls[0] + settled.walls[1] + settled.walls[2]
    }
  }

  const standing = stand(g, pre, frame, mainAxis)
  return { ...standing, method, planeShare, wallShare }
}

/** The transform the proposal stands for: its axes onto the global ones, its
 *  origin onto zero. */
export function autoAlignRigid(a: Pick<AutoAlignResult, 'axes' | 'origin'>): Rigid {
  const r = new Float64Array(9)
  const t = new Float64Array(3)
  for (let k = 0; k < 3; k++) {
    r[k * 3] = a.axes[k][0]
    r[k * 3 + 1] = a.axes[k][1]
    r[k * 3 + 2] = a.axes[k][2]
    t[k] = -dot(a.axes[k], a.origin)
  }
  return { r, t }
}

/** The proposal as the picks of a 3-2-1 alignment, so it opens in the same
 *  editor a hand-made one does and every choice in it can still be changed:
 *  three points on the plane the part stands on (facing down), two along X,
 *  and the zero point. `reach` is how far apart the points are put. */
export function autoAlignPicks(
  a: Pick<AutoAlignResult, 'axes' | 'origin'>,
  reach: number,
): { primary: Vec3[]; primaryNormals: Vec3[]; secondary: Vec3[]; origin: Vec3 } {
  const [x, y, z] = a.axes
  const downward = scaleVec(z, -1)
  const primary = [0, 120, 240].map((deg) =>
    addScaled(addScaled(a.origin, x, reach * Math.cos(rad(deg))), y, reach * Math.sin(rad(deg))),
  )
  return {
    primary,
    primaryNormals: [downward, downward, downward],
    secondary: [addScaled(a.origin, x, -reach), addScaled(a.origin, x, reach)],
    origin: a.origin,
  }
}

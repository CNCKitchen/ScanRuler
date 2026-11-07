// SPDX-License-Identifier: AGPL-3.0-only
// The scan cut with a plane: everything on one side of it taken off, and the
// part closed flat where the plane went through it.
//
// What it is for: the turntable or the table a part was scanned standing on,
// scanned with it; a flat bottom for a part that is to be printed; a part cut
// in two, to model each half on its own.
//
// Each triangle is clipped against the plane the way a polygon is clipped
// against a window — the corners on the side that stays kept, and a new corner
// wherever an edge crosses — which leaves a triangle or a quad of it, taken as
// one or two triangles. A crossing point is made once per mesh edge and shared
// by both triangles on it, so the cut rim is joined up and the mesh stays one
// surface. A corner that lies on the plane already, to the float's own
// precision, is taken as on it rather than a sliver's width to one side.
//
// The rim the cut leaves is the mesh's open edges that lie on the plane.
// Where the plane crosses the part all the way round they close into loops,
// and each face they bound is closed with a flat one — a tube cut across gets
// a ring, not a disc. Where the scan is open across the plane — a hole in the
// wall right at the cut — the rim comes in stretches; short gaps between
// them are bridged across the plane so the face still closes, and the hole
// above the bridge is left for Fill holes. A stretch with no short way round
// — a sheet that never closed — stays open, and the count says so.

import type { Vec3 } from '../../../src/core/types'
import { orthoBasis } from '../../../src/core/fit/linalg'
import { clipCrossed, compactEdit, edgeCrossings, type EditedMesh } from './edit'
import { fillPlanarLoops } from './planar'

export interface CutReport {
  /** Triangles of the scan taken off whole, and those the plane cut across. */
  removed: number
  split: number
  /** Loops where the plane goes all the way round the part, closed with a
   *  flat face, and the triangles the faces took. */
  capped: number
  capTriangles: number
  /** Gaps in the cut rim — holes in the scan the plane crossed — bridged
   *  across the plane so the cap could close. */
  bridged: number
  /** Stretches of the cut rim that do not close, left open. */
  open: number
}

/**
 * Cut the mesh with the plane through `origin` square to `normal`, taking off
 * everything on the side `normal` points to. `cap` closes the part flat where
 * the plane crosses it.
 */
export function cutMesh(
  positions: Float32Array,
  indices: Uint32Array,
  vertexCount: number,
  origin: Vec3,
  normal: Vec3,
  cap: boolean,
): EditedMesh & { report: CutReport } {
  const plane = planeSides(positions, indices, vertexCount, origin, normal)
  if (!plane.anyGoes) throw new Error('The plane cuts nothing off — all of the scan is on the side that stays.')
  if (!plane.anyStays) throw new Error('Nothing of the scan is on the side that stays — flip the side to keep.')
  const { out, all, onPlane, removed, split } = clip(positions, indices, vertexCount, plane, false)

  let capped = 0
  let capTriangles = 0
  let open = 0
  let bridged = 0
  if (cap) {
    const c = capOf(out, all, onPlane, plane.n)
    capped = c.capped
    capTriangles = c.triangles.length / 3
    open = c.open.length
    bridged = c.bridged
    for (const v of c.triangles) out.push(v)
  }

  const edited = compactEdit(all, Uint32Array.from(out), vertexCount)
  return { ...edited, report: { removed, split, capped, capTriangles, open, bridged } }
}

export interface CutPreview {
  /** Whether the plane has scan on both sides of it — otherwise there is
   *  nothing to cut, and nothing else here. */
  cuts: boolean
  /** The flat faces the cut would be closed with, nine floats a triangle,
   *  and the stretches of its rim left open, six floats an edge — in the
   *  scan's coordinates. */
  cap: Float32Array
  open: Float32Array
  /** How many faces close, gaps are bridged, and stretches stay open. */
  capped: number
  bridged: number
  openStretches: number
}

/**
 * What cutMesh with `cap` would close the part with, and what of the cut it
 * would leave open — for the part to be shown cut as it will be, before it
 * is. Only the triangles at the plane are clipped: the rest of the scan
 * stays or goes whole, and has nothing to say about the rim.
 */
export function cutPreview(
  positions: Float32Array,
  indices: Uint32Array,
  vertexCount: number,
  origin: Vec3,
  normal: Vec3,
): CutPreview {
  const plane = planeSides(positions, indices, vertexCount, origin, normal)
  const none = new Float32Array(0)
  if (!plane.anyGoes || !plane.anyStays) return { cuts: false, cap: none, open: none, capped: 0, bridged: 0, openStretches: 0 }
  const { out, all, onPlane } = clip(positions, indices, vertexCount, plane, true)
  const c = capOf(out, all, onPlane, plane.n)
  const cap = new Float32Array(c.triangles.length * 3)
  c.triangles.forEach((v, k) => cap.set(all.subarray(v * 3, v * 3 + 3), k * 3))
  const segments: number[] = []
  for (const stretch of c.open) {
    for (let k = 0; k + 1 < stretch.length; k++) {
      const a = stretch[k] * 3
      const b = stretch[k + 1] * 3
      segments.push(all[a], all[a + 1], all[a + 2], all[b], all[b + 1], all[b + 2])
    }
  }
  return { cuts: true, cap, open: new Float32Array(segments), capped: c.capped, bridged: c.bridged, openStretches: c.open.length }
}

export interface PlaneSides {
  n: Vec3
  /** Each vertex's height over the plane, and its side: +1 goes, −1 stays,
   *  0 on it — within a few units of the last place of the largest
   *  coordinate. */
  s: Float64Array
  side: Int8Array
  anyGoes: boolean
  anyStays: boolean
}

export function planeSides(positions: Float32Array, indices: Uint32Array, vertexCount: number, origin: Vec3, normal: Vec3): PlaneSides {
  const len = Math.hypot(normal[0], normal[1], normal[2])
  if (!(len > 0)) throw new Error('The cut plane has no direction.')
  const n: Vec3 = [normal[0] / len, normal[1] / len, normal[2] / len]
  let largest = 0
  for (let i = 0; i < positions.length; i++) largest = Math.max(largest, Math.abs(positions[i]))
  const eps = Math.max(largest * 5e-7, 1e-9)
  const s = new Float64Array(vertexCount)
  const side = new Int8Array(vertexCount)
  for (let v = 0; v < vertexCount; v++) {
    const d =
      (positions[v * 3] - origin[0]) * n[0] +
      (positions[v * 3 + 1] - origin[1]) * n[1] +
      (positions[v * 3 + 2] - origin[2]) * n[2]
    s[v] = d
    side[v] = d > eps ? 1 : d < -eps ? -1 : 0
  }
  let anyGoes = false
  let anyStays = false
  for (let i = 0; i < indices.length; i++) {
    if (side[indices[i]] > 0) anyGoes = true
    else if (side[indices[i]] < 0) anyStays = true
  }
  return { n, s, side, anyGoes, anyStays }
}

/**
 * The mesh clipped to the side that stays: the triangles kept, the new
 * corners where edges cross (after the old vertices, in `all`), and which
 * points lie on the plane — snapped exactly onto it, so a cap is flat.
 * `atPlane` keeps only the triangles with an edge on the plane, which is
 * all a rim is made of.
 */
export function clip(positions: Float32Array, indices: Uint32Array, vertexCount: number, plane: PlaneSides, atPlane: boolean) {
  const { n, s, side } = plane
  const { crossing, extra } = edgeCrossings(positions, vertexCount, (p, q) => s[p] / (s[p] - s[q]))

  const out: number[] = []
  let removed = 0
  let split = 0
  const poly: number[] = []
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2]
    const sa = side[a], sb = side[b], sc = side[c]
    if (sa <= 0 && sb <= 0 && sc <= 0) {
      if (!atPlane || (sa === 0 ? 1 : 0) + (sb === 0 ? 1 : 0) + (sc === 0 ? 1 : 0) >= 2) out.push(a, b, c)
      continue
    }
    if (sa >= 0 && sb >= 0 && sc >= 0) {
      removed++
      continue
    }
    split++
    clipCrossed([a, b, c], side, crossing, poly, out)
  }

  // Every point of the cut exactly on the plane, so the cap is flat.
  const all = new Float32Array(positions.length + extra.length)
  all.set(positions)
  all.set(extra, positions.length)
  const total = all.length / 3
  const onPlane = new Uint8Array(total)
  for (let v = 0; v < vertexCount; v++) {
    if (side[v] !== 0) continue
    onPlane[v] = 1
    all[v * 3] -= s[v] * n[0]
    all[v * 3 + 1] -= s[v] * n[1]
    all[v * 3 + 2] -= s[v] * n[2]
  }
  for (let v = vertexCount; v < total; v++) onPlane[v] = 1
  return { out, all, onPlane, removed, split }
}

/** The flat faces closing the rim the cut left in `triangles`, and the
 *  stretches of it that do not close. */
function capOf(triangles: number[], all: Float32Array, onPlane: Uint8Array, n: Vec3) {
  const rim = planeRim(triangles, onPlane)
  const joined = bridgeStretches(rim.stretches, all)
  const loops = [...rim.loops, ...joined.loops]
  let capped = 0
  let faces: number[] = []
  if (loops.length > 0) {
    const [u, v] = orthoBasis(n)
    const fill = fillPlanarLoops(all, loops, u, v)
    capped = fill.faces
    faces = fill.triangles
  }
  return { triangles: faces, capped, bridged: joined.bridged, open: joined.open }
}

/** A gap bridged across the plane may be at most this share of the loop it
 *  closes: a hole in a wall the plane crosses is a few millimetres of a rim
 *  that goes all round the part, where the chord across a sheet that was
 *  never closed is as long as the sheet. */
const MAX_BRIDGE_SHARE = 0.1

/**
 * Where the scan is open across the plane — a hole in its wall at the cut —
 * the rim comes in stretches, each ending where the hole begins. Each
 * stretch's end is joined to the nearest start of another, or of itself,
 * across the plane, until the loop closes; a loop whose gaps add up to no
 * more than a tenth of it is capped like any other. The cap then runs
 * straight across under each hole, which is left open above it for Fill
 * holes to close. A loop with longer gaps is a sheet that never closed, and
 * its stretches are left open.
 */
function bridgeStretches(
  stretches: number[][],
  positions: Float32Array,
): { loops: number[][]; bridged: number; open: number[][] } {
  const dist = (a: number, b: number) =>
    Math.hypot(
      positions[a * 3] - positions[b * 3],
      positions[a * 3 + 1] - positions[b * 3 + 1],
      positions[a * 3 + 2] - positions[b * 3 + 2],
    )
  const used = stretches.map(() => false)
  const loops: number[][] = []
  let bridged = 0
  const open: number[][] = []
  for (let i = 0; i < stretches.length; i++) {
    if (used[i]) continue
    used[i] = true
    const loop = [...stretches[i]]
    const pieces = [i]
    let gaps = 0
    let gapLength = 0
    for (;;) {
      const tail = loop[loop.length - 1]
      let best = dist(tail, loop[0])
      let next = -1
      for (let j = 0; j < stretches.length; j++) {
        if (used[j]) continue
        const d = dist(tail, stretches[j][0])
        if (d < best) {
          best = d
          next = j
        }
      }
      gaps++
      gapLength += best
      if (next < 0) break
      used[next] = true
      loop.push(...stretches[next])
      pieces.push(next)
    }
    let perimeter = 0
    for (let k = 0; k < loop.length; k++) perimeter += dist(loop[k], loop[(k + 1) % loop.length])
    if (loop.length >= 3 && gapLength <= MAX_BRIDGE_SHARE * perimeter) {
      loops.push(loop)
      bridged += gaps
    } else {
      for (const k of pieces) open.push(stretches[k])
    }
  }
  return { loops, bridged, open }
}

/**
 * The open edges of `triangles` that lie on the plane — both ends marked in
 * `onPlane` — walked into closed loops in the direction the triangles have
 * them, and the stretches that come to an end without closing, each from its
 * start.
 */
function planeRim(triangles: number[], onPlane: Uint8Array): { loops: number[][]; stretches: number[][] } {
  // Directed edges between points on the plane, and how often each is had.
  const uses = new Map<string, number>()
  const key = (a: number, b: number) => `${a},${b}`
  for (let t = 0; t < triangles.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = triangles[t + k]
      const b = triangles[t + ((k + 1) % 3)]
      if (!onPlane[a] || !onPlane[b]) continue
      uses.set(key(a, b), (uses.get(key(a, b)) ?? 0) + 1)
    }
  }
  const next = new Map<number, number[]>()
  const incoming = new Map<number, number>()
  for (const [k, count] of uses) {
    if (count !== 1) continue
    const [a, b] = k.split(',').map(Number)
    if (uses.has(key(b, a))) continue
    const list = next.get(a)
    if (list) list.push(b)
    else next.set(a, [b])
    incoming.set(b, (incoming.get(b) ?? 0) + 1)
  }

  const loops: number[][] = []
  const stretches: number[][] = []
  const take = (a: number): number | undefined => {
    const list = next.get(a)
    const b = list?.pop()
    if (list && list.length === 0) next.delete(a)
    return b
  }
  // The heads of stretches that do not close first — nothing leads into
  // them — so each open stretch is walked, and counted, once.
  const heads = [...next.keys()].filter((v) => !incoming.has(v))
  while (next.size > 0) {
    let start = heads.pop()
    while (start !== undefined && !next.has(start)) start = heads.pop()
    if (start === undefined) start = next.keys().next().value as number
    const path: number[] = [start]
    const at = new Map<number, number>([[start, 0]])
    let a = start
    for (;;) {
      const b = take(a)
      if (b === undefined) {
        if (path.length >= 2) stretches.push(path)
        break
      }
      const seen = at.get(b)
      if (seen !== undefined) {
        const loop = path.slice(seen)
        if (loop.length >= 3) loops.push(loop)
        for (const v of loop) at.delete(v)
        path.length = seen
        if (path.length === 0) break
        // Carry on from where the loop closed: it is on the path again.
        at.set(b, path.length)
        path.push(b)
        a = b
        continue
      }
      at.set(b, path.length)
      path.push(b)
      a = b
    }
  }
  return { loops, stretches }
}

// SPDX-License-Identifier: AGPL-3.0-only
// Cutting the scan with a plane: the polylines where its triangles cross it.
//
// Every triangle that straddles the plane contributes one segment, with an
// end on each of the two edges the plane passes through. Neighbouring
// triangles share an edge and so share the end on it — the point is computed
// once per mesh edge and referenced by both, which is what lets the segments
// be linked into chains by identity rather than by hunting for nearby ends.
// On a welded, manifold mesh every such point belongs to exactly two
// segments, so the chains come out as simple paths (open where the scan has a
// hole or an edge) and loops (closed where it does not). A loop is written
// with its first point repeated at the end, so a polyline drawn through it
// closes and a fit fed the whole chain gets the whole rim.
//
// Pure typed-array code, no DOM: the worker feeds it the welded scan, the
// tests feed it synthetic meshes.

import type { EdgeChains } from '../flat/edges'
import type { Vec2 } from '../flat/types'
import { rigidApplyToPoints, type Rigid } from '../deviation/rigid'
import type { Vec3 } from '../types'
import type { SectionFrame } from './frame'

export interface SectionCut {
  /** x,y,z per point, chain by chain, in the scan's own coordinates. */
  points: Float32Array
  /** Chain c covers point indices [offsets[c], offsets[c+1]). */
  offsets: Uint32Array
}

export interface SliceOptions {
  /** Chains shorter than this, in millimetres of path length, are dropped —
   *  the specks a noisy scan cuts into, which no fit could use. */
  minLength?: number
}

const emptyCut = (): SectionCut => ({ points: new Float32Array(0), offsets: new Uint32Array(1) })

/**
 * Cut an indexed mesh with the plane through `origin` with normal `normal`.
 *
 * A vertex is on the plane's positive side when its signed distance is zero
 * or more, so a triangle either lies wholly on one side or has exactly two
 * edges crossing. A vertex sitting exactly on the plane is one point rather
 * than two coincident ones — both edges into it resolve to the vertex itself
 * — so the chain runs through it instead of breaking there.
 */
export function sliceMesh(
  positions: Float32Array,
  indices: Uint32Array,
  origin: Vec3,
  normal: Vec3,
  opts: SliceOptions = {},
): SectionCut {
  const vertexCount = positions.length / 3
  const triangleCount = indices.length / 3
  if (vertexCount === 0 || triangleCount === 0) return emptyCut()
  const nl = Math.hypot(normal[0], normal[1], normal[2])
  if (!(nl > 0)) return emptyCut()
  const nx = normal[0] / nl
  const ny = normal[1] / nl
  const nz = normal[2] / nl
  const d0 = nx * origin[0] + ny * origin[1] + nz * origin[2]

  // Signed distance of every vertex from the plane, once.
  const dist = new Float32Array(vertexCount)
  for (let i = 0; i < vertexCount; i++) {
    dist[i] = nx * positions[i * 3] + ny * positions[i * 3 + 1] + nz * positions[i * 3 + 2] - d0
  }

  // Intersection points, one per crossed mesh edge (or per vertex lying on
  // the plane), and the segments between them as pairs of point indices.
  const pts: number[] = []
  const edgePoint = new Map<number, number>()
  const vertexPoint = new Map<number, number>()
  const onVertex = (i: number): number => {
    let idx = vertexPoint.get(i)
    if (idx !== undefined) return idx
    idx = pts.length / 3
    pts.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2])
    vertexPoint.set(i, idx)
    return idx
  }
  const onEdge = (i: number, j: number): number => {
    const di = dist[i]
    const dj = dist[j]
    if (di === 0) return onVertex(i)
    if (dj === 0) return onVertex(j)
    const key = i < j ? i * vertexCount + j : j * vertexCount + i
    let idx = edgePoint.get(key)
    if (idx !== undefined) return idx
    // The two distances have opposite signs here, so the denominator is never
    // zero and t lies strictly inside (0, 1).
    const t = di / (di - dj)
    idx = pts.length / 3
    pts.push(
      positions[i * 3] + t * (positions[j * 3] - positions[i * 3]),
      positions[i * 3 + 1] + t * (positions[j * 3 + 1] - positions[i * 3 + 1]),
      positions[i * 3 + 2] + t * (positions[j * 3 + 2] - positions[i * 3 + 2]),
    )
    edgePoint.set(key, idx)
    return idx
  }

  const segs: number[] = []
  for (let t = 0; t < triangleCount; t++) {
    const a = indices[t * 3]
    const b = indices[t * 3 + 1]
    const c = indices[t * 3 + 2]
    const sa = dist[a] >= 0
    const sb = dist[b] >= 0
    const sc = dist[c] >= 0
    if (sa === sb && sb === sc) continue
    let p = -1
    let q = -1
    if (sa !== sb) p = onEdge(a, b)
    if (sb !== sc) {
      const r = onEdge(b, c)
      if (p < 0) p = r
      else q = r
    }
    if (sc !== sa) {
      const r = onEdge(c, a)
      if (p < 0) p = r
      else q = r
    }
    // Both ends on the same vertex is a triangle touching the plane at a
    // corner — a point, not a segment.
    if (p < 0 || q < 0 || p === q) continue
    segs.push(p, q)
  }

  const pointCount = pts.length / 3
  const segCount = segs.length / 2
  if (segCount === 0) return emptyCut()

  // Which segments meet at each point. Two on a manifold mesh; a non-manifold
  // edge can bring more, and the walk simply takes the first unused one.
  const adj: number[][] = new Array(pointCount)
  for (let i = 0; i < pointCount; i++) adj[i] = []
  for (let s = 0; s < segCount; s++) {
    adj[segs[s * 2]].push(s)
    adj[segs[s * 2 + 1]].push(s)
  }

  const used = new Uint8Array(segCount)
  const chains: number[][] = []
  const walk = (start: number, first: number) => {
    const chain = [start]
    let cur = start
    let s = first
    for (;;) {
      used[s] = 1
      const other = segs[s * 2] === cur ? segs[s * 2 + 1] : segs[s * 2]
      chain.push(other)
      cur = other
      let next = -1
      for (const cand of adj[cur]) {
        if (!used[cand]) {
          next = cand
          break
        }
      }
      if (next < 0) break
      s = next
    }
    chains.push(chain)
  }
  // Open runs first, from their ends, so a whole path comes out as one walk;
  // whatever is left is loops, which a walk from anywhere closes on its own —
  // the last step lands back on the start point.
  for (let p = 0; p < pointCount; p++) {
    if (adj[p].length === 1 && !used[adj[p][0]]) walk(p, adj[p][0])
  }
  for (let s = 0; s < segCount; s++) {
    if (!used[s]) walk(segs[s * 2], s)
  }

  const minLength = opts.minLength ?? 0
  const kept = chains.filter((chain) => {
    if (minLength <= 0) return true
    let l = 0
    for (let i = 1; i < chain.length; i++) {
      const a = chain[i - 1] * 3
      const b = chain[i] * 3
      l += Math.hypot(pts[b] - pts[a], pts[b + 1] - pts[a + 1], pts[b + 2] - pts[a + 2])
    }
    return l >= minLength
  })

  let total = 0
  for (const c of kept) total += c.length
  const points = new Float32Array(total * 3)
  const offsets = new Uint32Array(kept.length + 1)
  let at = 0
  kept.forEach((chain, ci) => {
    offsets[ci] = at
    for (const p of chain) {
      points[at * 3] = pts[p * 3]
      points[at * 3 + 1] = pts[p * 3 + 1]
      points[at * 3 + 2] = pts[p * 3 + 2]
      at++
    }
  })
  offsets[kept.length] = at
  return { points, offsets }
}

/** How many chains and points a cut holds — for the panel's readout. */
export function cutSummary(cut: SectionCut): { chains: number; points: number } {
  return { chains: Math.max(0, cut.offsets.length - 1), points: cut.points.length / 3 }
}

/** The cut carried through a rigid motion of the scan — the points move with
 *  the part they were cut from, so nothing has to be cut again. */
export function transformCut(cut: SectionCut, m: Rigid): SectionCut {
  const points = cut.points.slice()
  rigidApplyToPoints(m, points)
  return { points, offsets: cut.offsets }
}

/**
 * The cut laid flat: every point as (u, v) millimetres in the frame of the
 * cutting plane — the same shape the flatbed edge detector produces, so the
 * 2D workspace snaps to, fits on and measures it exactly as it does a scan
 * image's edges, with the sheet already in millimetres.
 */
export function projectCut(cut: SectionCut, frame: SectionFrame): EdgeChains {
  const n = cut.points.length / 3
  const points = new Float32Array(n * 2)
  const [ox, oy, oz] = frame.origin
  const [ux, uy, uz] = frame.basisU
  const [vx, vy, vz] = frame.basisV
  for (let i = 0; i < n; i++) {
    const x = cut.points[i * 3] - ox
    const y = cut.points[i * 3 + 1] - oy
    const z = cut.points[i * 3 + 2] - oz
    points[i * 2] = x * ux + y * uy + z * uz
    points[i * 2 + 1] = x * vx + y * vy + z * vz
  }
  return { points, offsets: cut.offsets }
}

/** The extent of laid-flat chains, or null when there are none. */
export function chainBounds(chains: EdgeChains): { min: Vec2; max: Vec2 } | null {
  const n = chains.points.length / 2
  if (n === 0) return null
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (let i = 0; i < n; i++) {
    const x = chains.points[i * 2]
    const y = chains.points[i * 2 + 1]
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  return { min: [x0, y0], max: [x1, y1] }
}

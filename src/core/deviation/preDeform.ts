// SPDX-License-Identifier: AGPL-3.0-only
// A modelled part moved the opposite way to how it came out. A part that is
// printed, moulded or cast comes out warped; the deviation map says by how
// much, and the deformation animation shows which way. Here the same motion is
// applied backwards to the model itself — every vertex of the model moves by
// minus the scale times the smoothed deformation — so that making the
// pre-deformed model, with the same process, is expected to bring the part
// out true. The scale is 1 for a correction by exactly the measured error;
// more is for a process whose warp does not repeat in full.
//
// The model is cut finer first, because the motion is a field and a coarse
// tessellation cannot follow it: a flat face of two triangles can only tilt.
// The cut is a bisection of every edge longer than the density asked for,
// done edge by edge rather than triangle by triangle, so two triangles that
// share an edge cut it alike. The mesh stays as watertight as it came, which
// a slicer is going to care about, where cutting each triangle on its own
// leaves T-junctions that a moved vertex then opens into cracks.

import { niceFloor } from '../field/stats'
import { deflectionField, type DeflectionOptions } from './deflection'
import { rigidApply, rigidInvert, rigidRotate, type Rigid } from './rigid'

/** The most triangles a pre-deformed model is cut into: past it the cut stops
 *  at the last pass that fits. An STL is 50 bytes a triangle: 100 MB. */
export const MAX_PREDEFORM_TRIANGLES = 2_000_000

/** The compensation runs from a tenth of the measured deformation (a process
 *  whose warp comes out only partly the same each time) to ten times it. */
export const MIN_PREDEFORM_SCALE = 0.1
export const MAX_PREDEFORM_SCALE = 10

/** The edge length to cut to until the user picks one: a hundredth of the
 *  part's bounding-box diagonal — the length the motion is smoothed over (see
 *  DEFLECTION_SMOOTHING), so the cut is as fine as the field it moves by has
 *  detail, and no finer. */
export function suggestPreDeformEdge(diagonal: number): number {
  return diagonal > 0 ? niceFloor(diagonal / 100) : 1
}

/** Vertex numbers key an edge as `low * EDGE_KEY + high`: exact in a double
 *  for meshes up to 2^26 vertices. */
const EDGE_KEY = 67_108_864

export interface RefinedMesh {
  positions: Float32Array
  indices: Uint32Array
}

/**
 * The mesh with every edge longer than `maxEdge` bisected, again and again
 * until none is. Shared edges are cut alike, so a closed mesh closed stays
 * closed. Each pass is counted before it is made, and if it would take the
 * mesh past `cap` triangles the cut stops with the last pass that fit and
 * says so, with the longest edge that is left.
 *
 * A long thin triangle is the costly case: cutting both its long edges
 * leaves three triangles for the one, every pass, and it is the halved
 * length that pays for it — a bar 200 mm long cut to 1.5 mm makes some six
 * thousand triangles of each of its long faces' two. So the count is exact
 * and asked for, not estimated.
 */
export function refineMesh(
  positions: Float32Array,
  indices: Uint32Array,
  maxEdge: number,
  cap = MAX_PREDEFORM_TRIANGLES,
): RefinedMesh & { capped: boolean; longest: number } {
  // Grown by hand: a plain array of numbers a few million long is heavier
  // than the typed one it ends as.
  let P = new Float32Array(Math.max(positions.length * 2, 64))
  P.set(positions)
  let nv = positions.length / 3
  let tri = indices
  let capped = false
  const maxEdge2 = maxEdge * maxEdge
  const dd = (a: number, b: number): number => {
    const dx = P[a * 3] - P[b * 3], dy = P[a * 3 + 1] - P[b * 3 + 1], dz = P[a * 3 + 2] - P[b * 3 + 2]
    return dx * dx + dy * dy + dz * dz
  }
  const key = (a: number, b: number): number => (a < b ? a * EDGE_KEY + b : b * EDGE_KEY + a)

  for (let pass = 0; pass < 64; pass++) {
    // Which edges split is decided before any triangle is cut, from the
    // lengths as they stand: both sides of an edge see the same answer.
    const split = new Set<number>()
    for (let t = 0; t < tri.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const a = tri[t + e], b = tri[t + ((e + 1) % 3)]
        if (dd(a, b) > maxEdge2) split.add(key(a, b))
      }
    }
    if (split.size === 0) break
    const PIECES = [1, 2, 3, 4]
    let count = 0
    for (let t = 0; t < tri.length; t += 3) {
      const k = (split.has(key(tri[t], tri[t + 1])) ? 1 : 0) + (split.has(key(tri[t + 1], tri[t + 2])) ? 1 : 0) + (split.has(key(tri[t + 2], tri[t])) ? 1 : 0)
      count += PIECES[k]
    }
    if (count > cap) {
      capped = true
      break
    }

    const mid = new Map<number, number>()
    const midpoint = (a: number, b: number): number => {
      const k = key(a, b)
      let m = mid.get(k)
      if (m !== undefined) return m
      m = nv++
      if (nv * 3 > P.length) {
        const grown = new Float32Array(P.length * 2)
        grown.set(P)
        P = grown
      }
      for (let i = 0; i < 3; i++) P[m * 3 + i] = (P[a * 3 + i] + P[b * 3 + i]) / 2
      mid.set(k, m)
      return m
    }
    const out = new Uint32Array(count * 3)
    let o = 0
    const put = (a: number, b: number, c: number): void => {
      out[o++] = a
      out[o++] = b
      out[o++] = c
    }
    for (let t = 0; t < tri.length; t += 3) {
      let a = tri[t], b = tri[t + 1], c = tri[t + 2]
      const sa = split.has(key(a, b)), sb = split.has(key(b, c)), sc = split.has(key(c, a))
      const cuts = (sa ? 1 : 0) + (sb ? 1 : 0) + (sc ? 1 : 0)
      if (cuts === 0) {
        put(a, b, c)
      } else if (cuts === 3) {
        const mab = midpoint(a, b), mbc = midpoint(b, c), mca = midpoint(c, a)
        put(a, mab, mca)
        put(mab, b, mbc)
        put(mca, mbc, c)
        put(mab, mbc, mca)
      } else if (cuts === 1) {
        // Turned so that the cut edge is a→b; the winding is kept.
        if (sb) [a, b, c] = [b, c, a]
        else if (sc) [a, b, c] = [c, a, b]
        const m = midpoint(a, b)
        put(a, m, c)
        put(m, b, c)
      } else {
        // Turned so that the cut edges are p→q and q→r.
        let p = a, q = b, r = c
        if (sb && sc) [p, q, r] = [b, c, a]
        else if (sc && sa) [p, q, r] = [c, a, b]
        const m1 = midpoint(p, q), m2 = midpoint(q, r)
        // The corner at q is cut off whole; the quad p, m1, m2, r is split
        // along its shorter diagonal, which keeps its pieces from slivers.
        put(m1, q, m2)
        if (dd(m1, r) <= dd(p, m2)) {
          put(p, m1, r)
          put(m1, m2, r)
        } else {
          put(p, m1, m2)
          put(p, m2, r)
        }
      }
    }
    tri = out
  }
  let longest = 0
  for (let t = 0; t < tri.length; t += 3) {
    for (let e = 0; e < 3; e++) longest = Math.max(longest, dd(tri[t + e], tri[t + ((e + 1) % 3)]))
  }
  return {
    positions: P.slice(0, nv * 3),
    indices: tri === indices ? Uint32Array.from(indices) : tri,
    capped,
    longest: Math.sqrt(longest),
  }
}

export interface PreDeformOptions extends Omit<DeflectionOptions, 'positions'> {
  /** The model's mesh, in the model's own frame. */
  model: RefinedMesh
  /** Where the scan's vertices are, in the scan's frame: what the readings
   *  were taken at, and the field is smoothed over. */
  scanPositions: Float32Array
  /** Takes the scan into the model's frame — the alignment the map was
   *  measured under. The field lives in the scan's. */
  transform: Rigid
  /** How many times the measured deformation is undone. 1 is exactly it. */
  scale: number
  /** The longest edge left in the model, mm. */
  maxEdge: number
  /** The model already cut to that edge, where it has been (see refineMesh):
   *  worked out once for the count beside the slider and again for the file. */
  refined?: RefinedMesh & { capped: boolean; longest: number }
}

export interface PreDeformed extends RefinedMesh {
  /** Vertices the field said nothing at — no measured scan within a cell of
   *  them — and so were not moved. */
  unmoved: number
  /** The most any vertex moved, mm. */
  maxMove: number
  /** The cut stopped short of the edge asked for, at the triangle cap. */
  capped: boolean
  /** The longest edge left in the cut, mm. */
  longest: number
}

/**
 * The model, cut to `maxEdge` and with every vertex moved against the scan's
 * deformation: `p − scale · d(p)`, d being the smoothed offset of the scan off
 * the ideal surface (see deflection.ts), read at the place the vertex has in
 * the scan's frame and turned into the model's.
 *
 * Throws where there is nothing to move by — no measured point, or no
 * smoothing grid — rather than hand back the model unchanged as if it were a
 * result.
 */
export function preDeform(values: Float32Array, directions: Int8Array, o: PreDeformOptions): PreDeformed {
  const field = deflectionField(values, directions, { ...o, positions: o.scanPositions })
  if (!field) throw new Error('The map has no measured points to deform by.')
  const cut = o.refined ?? refineMesh(o.model.positions, o.model.indices, o.maxEdge)
  const toScan = rigidInvert(o.transform)
  const at = new Float64Array(3)
  const d = new Float64Array(3)
  const n = cut.positions.length / 3
  const moved = new Float32Array(cut.positions)
  let unmoved = 0
  let maxMove2 = 0
  for (let v = 0; v < n; v++) {
    rigidApply(toScan, cut.positions[v * 3], cut.positions[v * 3 + 1], cut.positions[v * 3 + 2], at)
    if (!field.sample(at[0], at[1], at[2], at)) {
      unmoved++
      continue
    }
    // The field's vector is in the scan's frame; the model is in the other.
    rigidRotate(o.transform, at[0], at[1], at[2], d)
    const dx = -o.scale * d[0], dy = -o.scale * d[1], dz = -o.scale * d[2]
    moved[v * 3] += dx
    moved[v * 3 + 1] += dy
    moved[v * 3 + 2] += dz
    const m2 = dx * dx + dy * dy + dz * dz
    if (m2 > maxMove2) maxMove2 = m2
  }
  return { positions: moved, indices: cut.indices, unmoved, maxMove: Math.sqrt(maxMove2), capped: cut.capped, longest: cut.longest }
}

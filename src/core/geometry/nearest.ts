// SPDX-License-Identifier: AGPL-3.0-only
// A place on the scan named without a click: a vertex by its number, or the
// vertex nearest a point. A click hands a fit the three corners of the
// triangle under the cursor (see App's handlePick); a vertex has no triangle
// of its own, so the first triangle it is a corner of stands in — one of the
// triangles a click right on that vertex would have landed in.

import type { MeshGraph, Vec3 } from '../types'

export interface ScanSpot {
  /** The scan vertex — what a fit's seeds and a project file hold. */
  vertex: number
  /** Where it is, in the frame the scan is measured in now. */
  point: Vec3
  /** The surface normal there, pointing out of the part. */
  normal: Vec3
  /** A triangle the vertex is a corner of: the seed a click would give. */
  triangle: [number, number, number]
  /** How far the vertex is from the point asked about; 0 for a vertex asked
   *  for by its number. */
  distance: number
}

/** The vertex nearest `p` among the first `vertexCount` of `positions`, by a
 *  pass over all of them — a few milliseconds on a scan of a million points,
 *  and asked once per command. */
export function nearestVertex(positions: Float32Array, vertexCount: number, p: Vec3): { vertex: number; distance: number } {
  let best = -1
  let bestD2 = Infinity
  for (let v = 0; v < vertexCount; v++) {
    const dx = positions[v * 3] - p[0]
    const dy = positions[v * 3 + 1] - p[1]
    const dz = positions[v * 3 + 2] - p[2]
    const d2 = dx * dx + dy * dy + dz * dz
    if (d2 < bestD2) {
      bestD2 = d2
      best = v
    }
  }
  return { vertex: best, distance: Math.sqrt(bestD2) }
}

/** The first triangle `v` is a corner of, or null for a vertex no triangle
 *  uses. */
export function triangleOf(indices: Uint32Array, v: number): [number, number, number] | null {
  for (let t = 0; t + 2 < indices.length; t += 3) {
    if (indices[t] === v || indices[t + 1] === v || indices[t + 2] === v) {
      return [indices[t], indices[t + 1], indices[t + 2]]
    }
  }
  return null
}

/** The spot on the scan a location names: a vertex by number, or the vertex
 *  nearest a point. Throws, with a sentence for the user, when there is none. */
export function scanSpot(graph: MeshGraph, at: { vertex: number } | { point: Vec3 }): ScanSpot {
  let vertex: number
  let distance = 0
  if ('vertex' in at) {
    vertex = at.vertex
    if (!Number.isInteger(vertex) || vertex < 0 || vertex >= graph.vertexCount) {
      throw new Error(`The scan has no vertex ${at.vertex} — it has ${graph.vertexCount} (0 to ${graph.vertexCount - 1}).`)
    }
  } else {
    if (!at.point.every(Number.isFinite)) throw new Error('The point is not three finite numbers.')
    const hit = nearestVertex(graph.positions, graph.vertexCount, at.point)
    vertex = hit.vertex
    distance = hit.distance
  }
  const triangle = triangleOf(graph.indices, vertex)
  if (!triangle) throw new Error(`Vertex ${vertex} is not a corner of any triangle of the scan.`)
  const p = graph.positions
  const n = graph.normals
  return {
    vertex,
    point: [p[vertex * 3], p[vertex * 3 + 1], p[vertex * 3 + 2]],
    normal: [n[vertex * 3], n[vertex * 3 + 1], n[vertex * 3 + 2]],
    triangle,
    distance,
  }
}

// SPDX-License-Identifier: AGPL-3.0-only
// The scan's vertices inside a box, facing a direction if asked — how an
// agent reads the scan's own points without exporting the whole cloud and
// slicing it elsewhere: the points on a face, their normals, how many there
// are. Pure typed-array code over the mesh graph, run in the worker.

import type { MeshGraph, Vec3 } from '../types'

export interface VertexQuery {
  /** The box, in the frame the scan is measured in now. */
  min: Vec3
  max: Vec3
  /** Keep only vertices whose outward normal lies within the angle of
   *  `dir` — the cosine of that angle; left out, every vertex in the box. */
  normal?: { dir: Vec3; cosLimit: number }
  /** At most this many vertices come back: past it every k-th of those
   *  that match is kept, spread evenly through the box. */
  limit: number
}

export interface VertexQueryResult {
  /** The vertices kept, ascending. */
  vertices: Uint32Array
  /** How many matched before the limit thinned them. */
  matched: number
  /** Every k-th matching vertex was kept — 1 when all were. */
  step: number
}

/** The vertices the query names. */
export function queryVertices(graph: MeshGraph, q: VertexQuery): VertexQueryResult {
  const p = graph.positions
  const n = graph.normals
  const [x0, y0, z0] = q.min
  const [x1, y1, z1] = q.max
  let dx = 0, dy = 0, dz = 0, cosLimit = -2
  if (q.normal) {
    const l = Math.hypot(q.normal.dir[0], q.normal.dir[1], q.normal.dir[2])
    if (l > 0) {
      dx = q.normal.dir[0] / l
      dy = q.normal.dir[1] / l
      dz = q.normal.dir[2] / l
      cosLimit = q.normal.cosLimit
    }
  }
  const hits = new Uint32Array(graph.vertexCount)
  let matched = 0
  for (let v = 0; v < graph.vertexCount; v++) {
    const x = p[v * 3], y = p[v * 3 + 1], z = p[v * 3 + 2]
    if (x < x0 || x > x1 || y < y0 || y > y1 || z < z0 || z > z1) continue
    if (cosLimit > -2 && n[v * 3] * dx + n[v * 3 + 1] * dy + n[v * 3 + 2] * dz < cosLimit) continue
    hits[matched++] = v
  }
  const limit = Math.max(1, Math.floor(q.limit))
  if (matched <= limit) return { vertices: hits.slice(0, matched), matched, step: 1 }
  const step = Math.ceil(matched / limit)
  const kept = new Uint32Array(Math.ceil(matched / step))
  let w = 0
  for (let i = 0; i < matched; i += step) kept[w++] = hits[i]
  return { vertices: kept.slice(0, w), matched, step }
}

/** The positions and normals of the given vertices, gathered, three
 *  numbers a vertex. */
export function gatherVertices(graph: MeshGraph, vertices: Uint32Array): { positions: Float32Array; normals: Float32Array } {
  const positions = new Float32Array(vertices.length * 3)
  const normals = new Float32Array(vertices.length * 3)
  for (let i = 0; i < vertices.length; i++) {
    const v = vertices[i] * 3
    positions[i * 3] = graph.positions[v]
    positions[i * 3 + 1] = graph.positions[v + 1]
    positions[i * 3 + 2] = graph.positions[v + 2]
    normals[i * 3] = graph.normals[v]
    normals[i * 3 + 1] = graph.normals[v + 1]
    normals[i * 3 + 2] = graph.normals[v + 2]
  }
  return { positions, normals }
}

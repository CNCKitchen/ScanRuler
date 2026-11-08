// SPDX-License-Identifier: AGPL-3.0-only
// What every edit of the scan hands back: the mesh as it is to be, on the
// vertices it still uses, and where each old vertex went. Anything marked on
// the scan by vertex — a hand-marked surface, a deviation map's scope, a
// fitted surface's region — is renumbered through the map, so it stays on the
// same spots of the part (see useMeshWorkspace).

import { round125 } from './round125'

export interface EditedMesh {
  positions: Float32Array
  indices: Uint32Array
  /** Every old vertex's new number, or −1 for one that went. */
  vertexMap: Int32Array
}

/**
 * The mesh on the vertices its triangles use. `positions` holds the old
 * vertices and then any the edit made, which number on from `vertexCount`;
 * the old ones kept come first in their own order, the new ones after them in
 * theirs — so the map keeps the order, and ascending lists stay ascending.
 */
export function compactEdit(positions: Float32Array, indices: Uint32Array, vertexCount: number): EditedMesh {
  const total = positions.length / 3
  const remap = new Int32Array(total).fill(-1)
  for (let i = 0; i < indices.length; i++) remap[indices[i]] = 0
  let n = 0
  for (let v = 0; v < total; v++) if (remap[v] === 0) remap[v] = n++
  const outPositions = new Float32Array(n * 3)
  for (let v = 0; v < total; v++) {
    const w = remap[v]
    if (w < 0) continue
    outPositions[w * 3] = positions[v * 3]
    outPositions[w * 3 + 1] = positions[v * 3 + 1]
    outPositions[w * 3 + 2] = positions[v * 3 + 2]
  }
  const outIndices = new Uint32Array(indices.length)
  for (let i = 0; i < indices.length; i++) outIndices[i] = remap[indices[i]]
  return { positions: outPositions, indices: outIndices, vertexMap: remap.slice(0, vertexCount) }
}

/**
 * The corners a clip adds where edges cross its level: made once per edge
 * and shared by both triangles on it, numbered on from `vertexCount`, their
 * coordinates gathered in `extra`. `along(p, q)` is how far from p towards
 * q the edge crosses.
 */
export function edgeCrossings(positions: Float32Array, vertexCount: number, along: (p: number, q: number) => number): { crossing(p: number, q: number): number; extra: number[] } {
  const extra: number[] = []
  const crossings = new Map<number, number>()
  const crossing = (p: number, q: number): number => {
    const key = p < q ? p * vertexCount + q : q * vertexCount + p
    const known = crossings.get(key)
    if (known !== undefined) return known
    const t = along(p, q)
    for (let k = 0; k < 3; k++) extra.push(positions[p * 3 + k] + t * (positions[q * 3 + k] - positions[p * 3 + k]))
    const id = vertexCount + extra.length / 3 - 1
    crossings.set(key, id)
    return id
  }
  return { crossing, extra }
}

/** A triangle the level crosses, cut to what lies at or below it — its
 *  corners there and the crossings between — and fanned into `out`. `poly`
 *  is scratch. */
export function clipCrossed(corners: ArrayLike<number>, side: Int8Array, crossing: (p: number, q: number) => number, poly: number[], out: number[]): void {
  poly.length = 0
  for (let k = 0; k < 3; k++) {
    const p = corners[k]
    const q = corners[(k + 1) % 3]
    if (side[p] <= 0) poly.push(p)
    if (side[p] * side[q] < 0) poly.push(crossing(p, q))
  }
  for (let k = 1; k + 1 < poly.length; k++) out.push(poly[0], poly[k], poly[k + 1])
}

/** The triangles a hand marking takes: those with all three corners marked —
 *  the rule the marking's tint on the part follows (see geometry/region), so
 *  what goes is exactly what was coloured. 1 for each, and how many. */
export function markedTriangles(
  indices: Uint32Array,
  vertices: Uint32Array,
  vertexCount: number,
): { mask: Uint8Array; count: number } {
  const marked = new Uint8Array(vertexCount)
  for (let i = 0; i < vertices.length; i++) if (vertices[i] < vertexCount) marked[vertices[i]] = 1
  const mask = new Uint8Array(indices.length / 3)
  let count = 0
  for (let t = 0; t < mask.length; t++) {
    if (marked[indices[t * 3]] && marked[indices[t * 3 + 1]] && marked[indices[t * 3 + 2]]) {
      mask[t] = 1
      count++
    }
  }
  return { mask, count }
}

/** Two edits' vertex maps as one: where each vertex before the first went
 *  after the second — −1 for one either took. */
export function composeVertexMaps(first: Int32Array, second: Int32Array): Int32Array {
  const out = new Int32Array(first.length)
  for (let v = 0; v < first.length; v++) {
    const mid = first[v]
    out[v] = mid >= 0 && mid < second.length ? second[mid] : -1
  }
  return out
}

/** An edited copy's distance from the scan it was made from, summed up: the
 *  colour range it is drawn over — the 99th percentile of the distance, on
 *  the 1-2-5 steps — the furthest and the RMS of the points the scan had, and
 *  how many points an edit made, with no scan under them to measure. */
export interface CopyDeviationStats {
  range: number
  maxAbs: number
  rms: number
  measured: number
  added: number
}

export function summarizeCopyDeviation(values: Float32Array): CopyDeviationStats {
  const abs: number[] = []
  let sq = 0
  let maxAbs = 0
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (!Number.isFinite(v)) continue
    const a = Math.abs(v)
    abs.push(a)
    sq += a * a
    if (a > maxAbs) maxAbs = a
  }
  const measured = abs.length
  const sorted = Float64Array.from(abs).sort()
  const p99 = measured ? sorted[Math.min(measured - 1, Math.floor(measured * 0.99))] : 0
  return {
    range: round125(Math.max(p99, 0.001)),
    maxAbs,
    rms: measured ? Math.sqrt(sq / measured) : 0,
    measured,
    added: values.length - measured,
  }
}

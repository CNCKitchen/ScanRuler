// SPDX-License-Identifier: AGPL-3.0-only
// Mean curvature at every vertex of a scan, for colouring it: where a flat
// turns into a round and a round into a freeform blend is where the borders
// of surface regions are put, and on a bare grey scan that line is guessed.
//
// The reading is the cotangent Laplacian's — the mesh's own discrete mean
// curvature normal, Δx = −2H·n, over each vertex's own share of the surface,
// which holds on an uneven triangulation where an average of the normal
// curvatures towards each neighbour does not — signed by the vertex normal the
// graph already turned outward: positive on a convex round, negative in a
// fillet's hollow, in 1/mm (a cylinder of radius R reads 1/2R, a sphere 1/R).
//
// A scan's noise is larger than its curvature at the scale of one triangle:
// 0.02 mm of scatter on 0.3 mm edges reads as ±0.4 /mm, a round of 2 mm as
// 0.25. But the noise is a vertex pushed out between neighbours pushed in —
// it all but cancels over a patch — so the raw reading is averaged over the
// neighbours a few times, and what is left is the shape.

import { BLUE_CAP_RGB, RED_CAP_RGB, type FieldScale } from '../field/colormap'

/** Passes of neighbour averaging over the raw reading. Four reach about two
 *  rings, enough to put a scan's scatter under a 2 mm round without washing
 *  the round into the flats beside it. */
export const CURVATURE_SMOOTHING = 4

export interface CurvatureGraph {
  positions: Float32Array
  indices: Uint32Array
  normals: Float32Array
  adjOffsets: Uint32Array
  adjList: Uint32Array
  vertexCount: number
}

/** Mean curvature per vertex, 1/mm, convex positive; NaN on the rim of an
 *  open scan, where the surface has no other side to be curved against, and
 *  on a vertex no triangle with an area uses. */
export function meanCurvature(graph: CurvatureGraph, smoothing = CURVATURE_SMOOTHING): Float32Array {
  const { positions: p, indices, normals, adjOffsets, adjList, vertexCount } = graph
  // Σ (cot α + cot β)(x_w − x_v) over a vertex's edges, gathered a triangle
  // at a time: each corner's cotangent belongs to the edge across from it.
  const lap = new Float64Array(vertexCount * 3)
  const area = new Float64Array(vertexCount)
  for (let t = 0; t < indices.length; t += 3) {
    const i0 = indices[t]
    const i1 = indices[t + 1]
    const i2 = indices[t + 2]
    const a = i0 * 3
    const b = i1 * 3
    const c = i2 * 3
    const abx = p[b] - p[a], aby = p[b + 1] - p[a + 1], abz = p[b + 2] - p[a + 2]
    const acx = p[c] - p[a], acy = p[c + 1] - p[a + 1], acz = p[c + 2] - p[a + 2]
    const bcx = p[c] - p[b], bcy = p[c + 1] - p[b + 1], bcz = p[c + 2] - p[b + 2]
    const nx = aby * acz - abz * acy
    const ny = abz * acx - abx * acz
    const nz = abx * acy - aby * acx
    const twice = Math.sqrt(nx * nx + ny * ny + nz * nz)
    if (!(twice > 1e-20)) continue
    // A sliver's cotangents run to thousands and one of them would own the
    // vertex; held to ±20 (an angle of 3°) it is one poor triangle among six.
    const cot = (dot: number) => Math.max(-20, Math.min(20, dot / twice))
    const cotA = cot(abx * acx + aby * acy + abz * acz)
    const cotB = cot(-(abx * bcx + aby * bcy + abz * bcz))
    const cotC = cot(acx * bcx + acy * bcy + acz * bcz)
    // Edge bc lies across from a, ca from b, ab from c.
    lap[b] += cotA * bcx; lap[b + 1] += cotA * bcy; lap[b + 2] += cotA * bcz
    lap[c] -= cotA * bcx; lap[c + 1] -= cotA * bcy; lap[c + 2] -= cotA * bcz
    lap[a] += cotB * acx; lap[a + 1] += cotB * acy; lap[a + 2] += cotB * acz
    lap[c] -= cotB * acx; lap[c + 1] -= cotB * acy; lap[c + 2] -= cotB * acz
    lap[a] += cotC * abx; lap[a + 1] += cotC * aby; lap[a + 2] += cotC * abz
    lap[b] -= cotC * abx; lap[b + 1] -= cotC * aby; lap[b + 2] -= cotC * abz
    // Each corner's share of the triangle is what lies nearer to it than to
    // the other two (Meyer et al.'s mixed area) — a third each reads a ball
    // 14 % too round at a vertex five triangles meet at. The Voronoi share
    // of an obtuse triangle falls outside it, so that one is split by halves.
    const dA = abx * acx + aby * acy + abz * acz
    const dB = -(abx * bcx + aby * bcy + abz * bcz)
    const dC = acx * bcx + acy * bcy + acz * bcz
    if (dA < 0 || dB < 0 || dC < 0) {
      const quarter = twice / 8
      area[i0] += dA < 0 ? 2 * quarter : quarter
      area[i1] += dB < 0 ? 2 * quarter : quarter
      area[i2] += dC < 0 ? 2 * quarter : quarter
    } else {
      const ab2 = abx * abx + aby * aby + abz * abz
      const ac2 = acx * acx + acy * acy + acz * acz
      const bc2 = bcx * bcx + bcy * bcy + bcz * bcz
      area[i0] += (ab2 * dC + ac2 * dB) / (8 * twice)
      area[i1] += (ab2 * dC + bc2 * dA) / (8 * twice)
      area[i2] += (ac2 * dB + bc2 * dA) / (8 * twice)
    }
  }

  let values = new Float32Array(vertexCount)
  for (let v = 0; v < vertexCount; v++) {
    // The adjacency lists a neighbour once per shared triangle: twice inside
    // the surface, once along its rim — so the ids of an inner vertex's
    // neighbours cancel under exclusive-or, and a rim vertex's do not.
    let x = 0
    for (let k = adjOffsets[v]; k < adjOffsets[v + 1]; k++) x ^= adjList[k]
    if (x !== 0 || !(area[v] > 1e-20)) {
      values[v] = NaN
      continue
    }
    const along = lap[v * 3] * normals[v * 3] + lap[v * 3 + 1] * normals[v * 3 + 1] + lap[v * 3 + 2] * normals[v * 3 + 2]
    // Δx = Σ / 2A and H = −Δx·n / 2.
    values[v] = -along / (4 * area[v])
  }

  for (let pass = 0; pass < smoothing; pass++) {
    const next = new Float32Array(vertexCount)
    for (let v = 0; v < vertexCount; v++) {
      if (Number.isNaN(values[v])) {
        next[v] = NaN
        continue
      }
      let sum = values[v]
      let n = 1
      for (let k = adjOffsets[v]; k < adjOffsets[v + 1]; k++) {
        const w = values[adjList[k]]
        if (Number.isNaN(w)) continue
        sum += w
        n++
      }
      next[v] = sum / n
    }
    values = next
  }
  return values
}

/** The scale a curvature map is read at: the curvature nine vertices in ten
 *  stay under, so the flats and the gentle blends spread over the ramp and
 *  the sharp edges run off its ends into the caps — an edge drawn dark is an
 *  edge found. Never under the curvature of a round as large as the part
 *  (`size`, its bounding diagonal), which on a block of flats would stretch
 *  the noise over the whole ramp. */
export function curvatureRange(values: Float32Array, size: number): number {
  // A sample is enough for a percentile, and a sort of two million is not
  // what a key in the view bar should cost.
  const step = Math.max(1, Math.floor(values.length / 50_000))
  const sample: number[] = []
  for (let v = 0; v < values.length; v += step) {
    const x = Math.abs(values[v])
    if (!Number.isNaN(x)) sample.push(x)
  }
  const floor = size > 0 ? 2 / size : 1e-3
  if (sample.length === 0) return floor
  sample.sort((a, b) => a - b)
  return Math.max(floor, sample[Math.min(sample.length - 1, Math.floor(sample.length * 0.9))])
}

/** How a curvature map is read as colour: about zero like a deviation, the
 *  flats on the ramp's green, a convex round towards red and a hollow
 *  towards blue, whatever is sharper than the range in the dark caps. The
 *  rim of an open scan is NaN and stays bare. */
export function curvatureScale(range: number): FieldScale {
  return { low: -range, high: range, bands: null, validMin: -Infinity, validMax: Infinity, capLow: BLUE_CAP_RGB, capHigh: RED_CAP_RGB }
}

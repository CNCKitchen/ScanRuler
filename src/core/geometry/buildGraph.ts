// SPDX-License-Identifier: AGPL-3.0-only
// What a parsed file becomes before anything is measured on it, scan and
// reference alike: one indexed mesh, welded and rid of degenerate triangles,
// with vertex adjacency for region growing, and normals turned the right way
// out where that can be told. A broken file is refused here with a message,
// rather than read past the end of a buffer further on.

import type { MeshGraph, ParsedMesh } from '../types'
import { weldTriangleSoup, filterDegenerateTriangles } from './weld'
import { buildAdjacency } from './adjacency'
import { computeVertexNormals, orientNormalsOutward } from './normals'
import { extentOf } from './bounds'

export function buildMeshGraph(parsed: ParsedMesh, onProgress?: (text: string) => void): MeshGraph {
  if (parsed.positions.length === 0 || parsed.positions.length % 3 !== 0 ||
      (parsed.kind === 'soup' && parsed.positions.length % 9 !== 0)) {
    throw new Error('The file contains incomplete vertex or triangle coordinates.')
  }
  for (const coordinate of parsed.positions) {
    if (!Number.isFinite(coordinate)) throw new Error('The file contains non-finite vertex coordinates.')
  }
  if (parsed.indices) {
    if (parsed.indices.length % 3 !== 0) throw new Error('The file contains incomplete triangle indices.')
    for (const index of parsed.indices) {
      if (index >= parsed.positions.length / 3) throw new Error('The file references vertices that do not exist.')
    }
  }
  let positions: Float32Array
  let indices: Uint32Array

  if (parsed.kind === 'soup') {
    const welded = weldTriangleSoup(parsed.positions, onProgress)
    positions = welded.positions
    indices = welded.indices
  } else {
    positions = parsed.positions
    indices = parsed.indices ?? new Uint32Array(0)
  }

  indices = filterDegenerateTriangles(indices)
  if (indices.length === 0) {
    throw new Error('The file contains no usable triangles.')
  }
  const vertexCount = positions.length / 3
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] >= vertexCount) throw new Error('The file references vertices that do not exist.')
  }

  onProgress?.('Building surface topology…')
  const { offsets, list } = buildAdjacency(indices, vertexCount)
  onProgress?.('Computing normals…')
  const normals = computeVertexNormals(positions, indices)
  if (!parsed.keepWinding) orientNormalsOutward(positions, indices, normals)

  const { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } = extentOf(positions)
  const bboxDiag = Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2)

  return {
    positions,
    indices,
    normals,
    adjOffsets: offsets,
    adjList: list,
    vertexCount,
    triangleCount: indices.length / 3,
    bboxDiag,
  }
}

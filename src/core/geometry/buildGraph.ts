// SPDX-License-Identifier: AGPL-3.0-only
import type { MeshGraph, ParsedMesh } from '../types'
import { weldTriangleSoup, filterDegenerateTriangles } from './weld'
import { buildAdjacency } from './adjacency'
import { computeVertexNormals, orientNormalsOutward } from './normals'

export function buildMeshGraph(parsed: ParsedMesh, onProgress?: (text: string) => void): MeshGraph {
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
    throw new Error('The file contains no usable triangles — point clouds are not supported yet.')
  }
  const vertexCount = positions.length / 3
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] >= vertexCount) throw new Error('The file references vertices that do not exist.')
  }

  onProgress?.('Building surface topology…')
  const { offsets, list } = buildAdjacency(indices, vertexCount)
  onProgress?.('Computing normals…')
  const normals = computeVertexNormals(positions, indices)
  orientNormalsOutward(positions, indices, normals)

  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let v = 0; v < positions.length; v += 3) {
    const x = positions[v], y = positions[v + 1], z = positions[v + 2]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
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

/** Output of a file parser. STL produces a triangle soup (9 floats per
 *  triangle); PLY/OBJ are already indexed. */
export interface ParsedMesh {
  kind: 'soup' | 'indexed'
  positions: Float32Array
  indices?: Uint32Array
}

/** Indexed mesh plus everything the fitting pipeline needs: per-vertex
 *  normals and a CSR vertex-adjacency graph for region growing. */
export interface MeshGraph {
  positions: Float32Array
  indices: Uint32Array
  normals: Float32Array
  adjOffsets: Uint32Array
  adjList: Uint32Array
  vertexCount: number
  triangleCount: number
  bboxDiag: number
}

/** 0 = use all points, otherwise the k in "discard residuals beyond k·sigma". */
export type SigmaPreset = 0 | 1 | 2 | 3

/** v1 ships Gaussian best-fit; Chebyshev / min-circumscribed / max-inscribed
 *  slot in here later. */
export type FitMethodId = 'gaussian'

export interface FitSettings {
  method: FitMethodId
  sigma: SigmaPreset
}

export interface Sphere {
  cx: number
  cy: number
  cz: number
  r: number
}

export interface SphereFitOutput {
  center: [number, number, number]
  radius: number
  sigma: number
  usedPoints: number
  regionSize: number
  region: Uint32Array
}

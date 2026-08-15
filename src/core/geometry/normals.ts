// SPDX-License-Identifier: AGPL-3.0-only
/** Area-weighted per-vertex normals (unnormalized cross products summed,
 *  then normalized). Orientation follows the triangle winding; the fitting
 *  code only uses |dot|, so inverted meshes still work. */
export function computeVertexNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length)
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3
    const b = indices[t + 1] * 3
    const c = indices[t + 2] * 3
    const abx = positions[b] - positions[a]
    const aby = positions[b + 1] - positions[a + 1]
    const abz = positions[b + 2] - positions[a + 2]
    const acx = positions[c] - positions[a]
    const acy = positions[c + 1] - positions[a + 1]
    const acz = positions[c + 2] - positions[a + 2]
    const nx = aby * acz - abz * acy
    const ny = abz * acx - abx * acz
    const nz = abx * acy - aby * acx
    normals[a] += nx
    normals[a + 1] += ny
    normals[a + 2] += nz
    normals[b] += nx
    normals[b + 1] += ny
    normals[b + 2] += nz
    normals[c] += nx
    normals[c + 1] += ny
    normals[c + 2] += nz
  }
  for (let v = 0; v < normals.length; v += 3) {
    const len = Math.sqrt(normals[v] ** 2 + normals[v + 1] ** 2 + normals[v + 2] ** 2)
    if (len > 1e-20) {
      normals[v] /= len
      normals[v + 1] /= len
      normals[v + 2] /= len
    } else {
      normals[v + 2] = 1
    }
  }
  return normals
}

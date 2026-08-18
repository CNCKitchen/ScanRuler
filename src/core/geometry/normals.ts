// SPDX-License-Identifier: AGPL-3.0-only
/** Area-weighted per-vertex normals (unnormalized cross products summed,
 *  then normalized). Orientation follows the triangle winding — see
 *  `orientNormalsOutward` for how an inside-out mesh is put right. */
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

/**
 * Put an inside-out mesh right, in place: flip every normal and reverse every
 * triangle's winding when the winding decisively encloses its volume
 * inside-out. The alignment code matches surfaces by the *signed* dot of scan
 * and nominal normals, and wall thickness casts into the material along them,
 * so an STL exported with reversed winding would silently fail both.
 *
 * The winding must turn with the normals: the viewer draws the scan
 * double-sided, and for double-sided materials three.js takes the lit side
 * from gl_FrontFacing — the winding — negating the vertex normal on back
 * faces. Corrected normals over uncorrected winding would therefore be
 * negated right back on every visible fragment, leaving the whole part lit
 * from behind (uniformly dark, ambient only).
 *
 * The test is the signed volume about the centroid: origin-independent for a
 * closed mesh, and anchoring at the centroid keeps an open scan's spurious
 * contribution small. A scan too open to give a decisive signal (a single
 * sheet has none) is left exactly as wound.
 */
export function orientNormalsOutward(
  positions: Float32Array,
  indices: Uint32Array,
  normals: Float32Array,
): boolean {
  const vcount = positions.length / 3
  if (vcount === 0) return false
  let cx = 0, cy = 0, cz = 0
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let v = 0; v < positions.length; v += 3) {
    const x = positions[v], y = positions[v + 1], z = positions[v + 2]
    cx += x; cy += y; cz += z
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  cx /= vcount; cy /= vcount; cz /= vcount

  let vol6 = 0
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3
    const ax = positions[a] - cx, ay = positions[a + 1] - cy, az = positions[a + 2] - cz
    const bx = positions[b] - cx, by = positions[b + 1] - cy, bz = positions[b + 2] - cz
    const px = positions[c] - cx, py = positions[c + 1] - cy, pz = positions[c + 2] - cz
    vol6 += ax * (by * pz - bz * py) + ay * (bz * px - bx * pz) + az * (bx * py - by * px)
  }

  const bboxVol = (maxX - minX) * (maxY - minY) * (maxZ - minZ)
  // Decisive means the enclosed volume is a real fraction of the bounding box;
  // below that the mesh is a sheet and its orientation is not knowable.
  if (!(bboxVol > 0) || vol6 >= -6e-3 * bboxVol) return false
  for (let v = 0; v < normals.length; v++) normals[v] = -normals[v]
  for (let t = 0; t < indices.length; t += 3) {
    const tmp = indices[t + 1]
    indices[t + 1] = indices[t + 2]
    indices[t + 2] = tmp
  }
  return true
}

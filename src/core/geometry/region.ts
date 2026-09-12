// SPDX-License-Identifier: AGPL-3.0-only
// The triangles a marked surface consists of: the ones with all three
// corners in the marking. That is the rule the tint on the part follows (see
// viewer/paintTint), so what a search is confined to is exactly what is
// coloured — a triangle with one corner outside the marking is bare on
// screen and out of the search alike.

/** The triangle index reduced to the triangles whose three corners are all
 *  among `vertices`, in their original order. */
export function trianglesWithin(
  indices: Uint32Array,
  vertices: Uint32Array,
  vertexCount: number,
): Uint32Array {
  const inside = new Uint8Array(vertexCount)
  for (let i = 0; i < vertices.length; i++) if (vertices[i] < vertexCount) inside[vertices[i]] = 1
  let count = 0
  for (let t = 0; t + 2 < indices.length; t += 3) {
    if (inside[indices[t]] && inside[indices[t + 1]] && inside[indices[t + 2]]) count++
  }
  const out = new Uint32Array(count * 3)
  let w = 0
  for (let t = 0; t + 2 < indices.length; t += 3) {
    if (inside[indices[t]] && inside[indices[t + 1]] && inside[indices[t + 2]]) {
      out[w] = indices[t]
      out[w + 1] = indices[t + 1]
      out[w + 2] = indices[t + 2]
      w += 3
    }
  }
  return out
}

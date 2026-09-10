// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The per-vertex "corner slot" the viewport's mesh mode is drawn from.
 *
 * Drawing the triangle edges of a million-triangle scan as lines means a
 * second index buffer three times the size of the first and a second pass
 * over the whole part every frame — and at any distance where the triangles
 * are smaller than a pixel, a solid block of line colour. The viewport draws
 * the edges inside the surface shader instead: a fragment that knows how far
 * it is from the nearest edge of its own triangle can darken itself there,
 * in the same pass that shades it, at no extra draw call and one byte per
 * vertex of extra geometry.
 *
 * What a fragment gets for free is its barycentric position, *if* the three
 * corners of every triangle carry three different one-hot attributes. Indexed
 * geometry shares vertices between triangles, so the attribute has to be
 * chosen per vertex such that no triangle sees the same value twice — a
 * proper colouring of the vertex graph. Eight colours ("slots") are more than
 * a scan's vertices ever need in practice: a greedy pass in vertex order
 * hands each vertex the lowest slot none of its already-coloured neighbours
 * holds, and only a vertex whose coloured neighbours already cover all eight
 * is forced to share. Where one is, the triangles around it lose an edge or
 * two, not the picture; see wireConflicts for the count.
 *
 * Computed in the mesh worker at load, beside the normals: it walks the same
 * adjacency the fitting needs anyway and costs a few tens of milliseconds on
 * the largest scan, against a second or more for a pass over the index
 * buffer on the render thread the first time the mode is switched on.
 */

/** How many distinct slots there are. Eight is what two vec4 varyings carry. */
export const WIRE_SLOT_COUNT = 8

const UNSET = 255

/**
 * A slot per vertex, 0–7, such that (nearly) every triangle's three corners
 * differ. Adjacency in CSR form, as buildAdjacency makes it; neighbours listed
 * more than once are harmless.
 */
export function wireSlots(
  adjOffsets: Uint32Array,
  adjList: Uint32Array,
  vertexCount: number,
): Uint8Array {
  const slots = new Uint8Array(vertexCount).fill(UNSET)
  // Which slots this vertex's coloured neighbours hold, as a stamp per slot
  // rather than a set that would have to be cleared per vertex.
  const stamped = new Uint32Array(WIRE_SLOT_COUNT)
  const counts = new Uint32Array(WIRE_SLOT_COUNT)
  for (let v = 0; v < vertexCount; v++) {
    const stamp = v + 1
    const end = adjOffsets[v + 1]
    for (let i = adjOffsets[v]; i < end; i++) {
      const s = slots[adjList[i]]
      if (s !== UNSET) stamped[s] = stamp
    }
    let pick = UNSET
    for (let s = 0; s < WIRE_SLOT_COUNT; s++) {
      if (stamped[s] !== stamp) {
        pick = s
        break
      }
    }
    if (pick === UNSET) {
      // Every slot is taken around this vertex. Share the one fewest
      // neighbours hold, so the fewest triangles lose an edge.
      counts.fill(0)
      for (let i = adjOffsets[v]; i < end; i++) counts[slots[adjList[i]]]++
      pick = 0
      for (let s = 1; s < WIRE_SLOT_COUNT; s++) if (counts[s] < counts[pick]) pick = s
    }
    slots[v] = pick
  }
  return slots
}

/** How many triangles have two corners in the same slot — the ones the shader
 *  cannot draw every edge of. Zero on any ordinary mesh; a diagnostic, not
 *  something the viewport needs. */
export function wireConflicts(indices: Uint32Array, slots: Uint8Array): number {
  let n = 0
  for (let t = 0; t < indices.length; t += 3) {
    const a = slots[indices[t]]
    const b = slots[indices[t + 1]]
    const c = slots[indices[t + 2]]
    if (a === b || b === c || a === c) n++
  }
  return n
}

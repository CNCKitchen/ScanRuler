// SPDX-License-Identifier: AGPL-3.0-only
/** Vertex-to-vertex adjacency in CSR form (offsets + flat neighbor list).
 *  Neighbors may appear more than once (once per shared triangle); BFS
 *  visited-checks make that harmless and deduplication isn't worth a pass. */
export function buildAdjacency(
  indices: Uint32Array,
  vertexCount: number,
): { offsets: Uint32Array; list: Uint32Array } {
  const offsets = new Uint32Array(vertexCount + 1)
  for (let t = 0; t < indices.length; t += 3) {
    offsets[indices[t] + 1] += 2
    offsets[indices[t + 1] + 1] += 2
    offsets[indices[t + 2] + 1] += 2
  }
  for (let v = 0; v < vertexCount; v++) offsets[v + 1] += offsets[v]

  const list = new Uint32Array(offsets[vertexCount])
  const cursor = offsets.slice(0, vertexCount)
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]
    const b = indices[t + 1]
    const c = indices[t + 2]
    list[cursor[a]++] = b
    list[cursor[a]++] = c
    list[cursor[b]++] = a
    list[cursor[b]++] = c
    list[cursor[c]++] = a
    list[cursor[c]++] = b
  }
  return { offsets, list }
}

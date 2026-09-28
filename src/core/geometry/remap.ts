// SPDX-License-Identifier: AGPL-3.0-only
// Vertex numbers carried from one version of a mesh to the next. An edit that
// takes vertices out, or renumbers them, hands back a map from each old
// vertex to its new number — -1 for one that went — and everything held by
// vertex number goes through it.

/** A set of vertices renumbered through `vertexMap`, the ones that went left
 *  out. Ascending in, ascending out: the map keeps the order. */
export function remapVertices(ids: Uint32Array, vertexMap: Int32Array): Uint32Array {
  let n = 0
  for (let i = 0; i < ids.length; i++) if (ids[i] < vertexMap.length && vertexMap[ids[i]] >= 0) n++
  const out = new Uint32Array(n)
  let o = 0
  for (let i = 0; i < ids.length; i++) {
    const w = ids[i] < vertexMap.length ? vertexMap[ids[i]] : -1
    if (w >= 0) out[o++] = w
  }
  return out
}

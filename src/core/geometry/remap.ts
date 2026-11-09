// SPDX-License-Identifier: AGPL-3.0-only
// Vertex numbers carried from one version of a mesh to the next. An edit that
// takes vertices out, or renumbers them, hands back a map from each old
// vertex to its new number — -1 for one that went — and everything held by
// vertex number goes through it.

/** A set of vertices renumbered through `vertexMap`, the ones that went left
 *  out. Ascending in, ascending out. A map that makes one vertex of several
 *  (exact duplicates welded as a cloud is read) may send two to one number,
 *  or out of order: the set is then sorted and each number kept once. */
export function remapVertices(ids: Uint32Array, vertexMap: Int32Array): Uint32Array {
  let n = 0
  for (let i = 0; i < ids.length; i++) if (ids[i] < vertexMap.length && vertexMap[ids[i]] >= 0) n++
  const out = new Uint32Array(n)
  let o = 0
  let ascending = true
  for (let i = 0; i < ids.length; i++) {
    const w = ids[i] < vertexMap.length ? vertexMap[ids[i]] : -1
    if (w < 0) continue
    if (o > 0 && w <= out[o - 1]) ascending = false
    out[o++] = w
  }
  if (ascending) return out
  out.sort()
  let k = 0
  for (let i = 0; i < out.length; i++) if (k === 0 || out[i] !== out[k - 1]) out[k++] = out[i]
  return out.slice(0, k)
}

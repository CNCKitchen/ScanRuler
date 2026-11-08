// SPDX-License-Identifier: AGPL-3.0-only
// Densify: a mesh's triangles cut until no edge is longer than a maximum,
// the surface unchanged — every new vertex the middle of an edge, so it lies
// on the facet it was cut from. What an STL exported from CAD needs before
// it is measured like a scan: such a mesh has vertices only on its edges and
// rims, none inside its faces, and a fit or a segmentation looking for
// points on a face finds none (issue 42).
//
// Pass by pass, every edge longer than the maximum gets one vertex in its
// middle, shared by the two triangles on it, and each triangle is cut by how
// many of its edges were: in two, in three (the quad left over cut across
// its shorter diagonal) or in four. The cuts on either side of an edge meet,
// so the mesh stays as closed as it was — no T-junction, no new rim. The
// new edges are half as long or shorter but for the one from a long edge's
// middle to the corner across it, which the next pass cuts in turn.

/** What a densify did. */
export interface DensifyReport {
  maxEdge: number
  trianglesBefore: number
  triangles: number
  /** Vertices it added, all edges' middles. */
  added: number
  /** The longest edge left, mm. */
  longest: number
  passes: number
}

/** The most triangles a densify makes before it gives up and says so. */
export const DENSIFY_MAX_TRIANGLES = 20_000_000
const MAX_PASSES = 48

/**
 * The mesh with every edge cut down to `maxEdge` or shorter. The vertices
 * stay where they are, numbered as they were (`vertexMap` the identity); the
 * new ones follow them. Throws when the result would pass
 * DENSIFY_MAX_TRIANGLES — a maximum too small for the part.
 */
export function densifyMesh(
  positions: Float32Array,
  indices: Uint32Array,
  vertexCount: number,
  maxEdge: number,
  progress?: (text: string) => void,
): { positions: Float32Array; indices: Uint32Array; vertexMap: Int32Array; report: DensifyReport } {
  if (!(maxEdge > 0)) throw new Error('Give a maximum edge length above zero.')
  const trianglesBefore = Math.floor(indices.length / 3)
  // Positions grow by the middles; a typed array doubled as needed.
  let pos = new Float64Array(Math.max(vertexCount * 3 * 2, 64))
  for (let i = 0; i < vertexCount * 3; i++) pos[i] = positions[i]
  let count = vertexCount
  const grow = (need: number) => {
    if (need <= pos.length) return
    const next = new Float64Array(Math.max(need, pos.length * 2))
    next.set(pos)
    pos = next
  }
  let tris = Uint32Array.from(indices.subarray(0, trianglesBefore * 3))
  const max2 = maxEdge * maxEdge
  const len2 = (a: number, b: number) => {
    const dx = pos[a * 3] - pos[b * 3]
    const dy = pos[a * 3 + 1] - pos[b * 3 + 1]
    const dz = pos[a * 3 + 2] - pos[b * 3 + 2]
    return dx * dx + dy * dy + dz * dz
  }
  let passes = 0
  for (; passes < MAX_PASSES; passes++) {
    const n = tris.length / 3
    // The middles of this pass's long edges, by the edge.
    const middles = new Map<number, number>()
    const key = (a: number, b: number) => (a < b ? a * 0x100000000 + b : b * 0x100000000 + a)
    const middle = (a: number, b: number): number => {
      const k = key(a, b)
      const had = middles.get(k)
      if (had !== undefined) return had
      grow((count + 1) * 3)
      for (let j = 0; j < 3; j++) pos[count * 3 + j] = (pos[a * 3 + j] + pos[b * 3 + j]) / 2
      middles.set(k, count)
      return count++
    }
    // How many triangles this pass makes, to size the next list and to stop
    // short of a mesh too large.
    let made = 0
    const longMask = new Uint8Array(n)
    for (let t = 0; t < n; t++) {
      const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2]
      const m = (len2(a, b) > max2 ? 1 : 0) | (len2(b, c) > max2 ? 2 : 0) | (len2(c, a) > max2 ? 4 : 0)
      longMask[t] = m
      const k = (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1)
      made += k + 1
    }
    if (made === n) break
    if (made > DENSIFY_MAX_TRIANGLES) throw new Error(`Cut that fine the mesh would pass ${(DENSIFY_MAX_TRIANGLES / 1e6).toFixed(0)} million triangles — give a longer maximum edge.`)
    progress?.(`Densifying — pass ${passes + 1}, ${made.toLocaleString('en-US')} triangles…`)
    const out = new Uint32Array(made * 3)
    let o = 0
    const put = (x: number, y: number, z: number) => {
      out[o++] = x
      out[o++] = y
      out[o++] = z
    }
    for (let t = 0; t < n; t++) {
      const m = longMask[t]
      let a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2]
      if (m === 0) {
        put(a, b, c)
        continue
      }
      if (m === 7) {
        const ab = middle(a, b), bc = middle(b, c), ca = middle(c, a)
        put(a, ab, ca)
        put(ab, b, bc)
        put(ca, bc, c)
        put(ab, bc, ca)
        continue
      }
      // Turned so the long edges come first round the triangle, the winding
      // kept: one long edge is a–b; two are a–b and b–c.
      const ones = (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1)
      const turn = ones === 1 ? (m === 1 ? 0 : m === 2 ? 1 : 2) : m === 3 ? 0 : m === 6 ? 1 : 2
      for (let r = 0; r < turn; r++) [a, b, c] = [b, c, a]
      const ab = middle(a, b)
      if (ones === 1) {
        put(a, ab, c)
        put(ab, b, c)
        continue
      }
      const bc = middle(b, c)
      put(ab, b, bc)
      // The quad a, ab, bc, c cut across its shorter diagonal.
      if (len2(a, bc) <= len2(ab, c)) {
        put(a, ab, bc)
        put(a, bc, c)
      } else {
        put(a, ab, c)
        put(ab, bc, c)
      }
    }
    tris = out
  }
  let longest = 0
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t], b = tris[t + 1], c = tris[t + 2]
    longest = Math.max(longest, len2(a, b), len2(b, c), len2(c, a))
  }
  const vertexMap = new Int32Array(vertexCount)
  for (let v = 0; v < vertexCount; v++) vertexMap[v] = v
  return {
    positions: Float32Array.from(pos.subarray(0, count * 3)),
    indices: tris,
    vertexMap,
    report: { maxEdge, trianglesBefore, triangles: tris.length / 3, added: count - vertexCount, longest: Math.sqrt(longest), passes },
  }
}

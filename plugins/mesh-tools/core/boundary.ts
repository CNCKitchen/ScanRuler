// SPDX-License-Identifier: AGPL-3.0-only
// The mesh's open edges, as the loops they run in: the rim of every hole, and
// the border of every sheet that does not close.
//
// An edge is open when exactly one triangle has it. On a mesh whose triangles
// all turn the same way — every scan this reads — that triangle walks it in
// one direction and nothing walks it back, so each open edge is a half-edge
// with a direction, and following them head to tail goes round a rim. Where
// two rims touch at one vertex the walk can go either way on; it takes the
// first and closes a loop the moment it comes back to a vertex already on
// its path, so every loop it hands over is simple — no vertex twice — which
// is what a patch across it needs.

/** Every vertex's outgoing half-edges: the triangle corners it is the first
 *  of, in CSR form — the edge's other end, and the third corner of the
 *  triangle that has it. */
export interface HalfEdges {
  offsets: Uint32Array
  to: Uint32Array
  third: Uint32Array
}

export function halfEdges(indices: Uint32Array, vertexCount: number): HalfEdges {
  const offsets = new Uint32Array(vertexCount + 1)
  for (let i = 0; i < indices.length; i++) offsets[indices[i] + 1]++
  for (let v = 0; v < vertexCount; v++) offsets[v + 1] += offsets[v]
  const to = new Uint32Array(indices.length)
  const third = new Uint32Array(indices.length)
  const cursor = offsets.slice(0, vertexCount)
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]
    const b = indices[t + 1]
    const c = indices[t + 2]
    let h = cursor[a]++
    to[h] = b
    third[h] = c
    h = cursor[b]++
    to[h] = c
    third[h] = a
    h = cursor[c]++
    to[h] = a
    third[h] = b
  }
  return { offsets, to, third }
}

/** Which half-edges are open: their edge is had by no other triangle, either
 *  way round. */
function openHalfEdges(he: HalfEdges): Uint8Array {
  const { offsets, to } = he
  const open = new Uint8Array(to.length)
  const vertexCount = offsets.length - 1
  for (let a = 0; a < vertexCount; a++) {
    for (let h = offsets[a]; h < offsets[a + 1]; h++) {
      const b = to[h]
      let uses = 0
      for (let k = offsets[a]; k < offsets[a + 1]; k++) if (to[k] === b) uses++
      if (uses > 1) continue
      let back = false
      for (let k = offsets[b]; k < offsets[b + 1]; k++) {
        if (to[k] === a) {
          back = true
          break
        }
      }
      if (!back) open[h] = 1
    }
  }
  return open
}

/** How many edges of the mesh no other triangle has, either way round. */
export function openEdgeCount(indices: Uint32Array, vertexCount: number): number {
  let n = 0
  for (const open of openHalfEdges(halfEdges(indices, vertexCount))) n += open
  return n
}

/** One rim. */
export interface BoundaryLoop {
  /** Its vertices in the direction its open half-edges run: vertices[i] →
   *  vertices[i + 1], and the last back to the first, is each an edge of
   *  exactly one triangle, walked that way by it. */
  vertices: Uint32Array
  /** The third corner of that triangle, edge by edge. */
  opposite: Uint32Array
}

export interface Boundary {
  loops: BoundaryLoop[]
  /** Open edges that close no loop — a tangle where the triangles do not
   *  agree which way they turn. Left as they are. */
  stray: number
}

/** Every rim of the mesh, as simple closed loops. */
export function boundaryLoops(indices: Uint32Array, vertexCount: number, he = halfEdges(indices, vertexCount)): Boundary {
  const { offsets, to, third } = he
  const open = openHalfEdges(he)
  const taken = new Uint8Array(to.length)
  // Where each vertex stands on the path being walked, or −1.
  const at = new Int32Array(vertexCount).fill(-1)
  const loops: BoundaryLoop[] = []
  let stray = 0

  const nextOpen = (v: number): number => {
    for (let h = offsets[v]; h < offsets[v + 1]; h++) if (open[h] && !taken[h]) return h
    return -1
  }

  for (let start = 0; start < to.length; start++) {
    if (!open[start] || taken[start]) continue
    const path: number[] = []
    const opp: number[] = []
    let h = start
    // The half-edge's tail: the vertex whose list holds it.
    let a = tailOf(offsets, h)
    for (;;) {
      taken[h] = 1
      at[a] = path.length
      path.push(a)
      opp.push(third[h])
      const b = to[h]
      if (at[b] >= 0) {
        // Back on the path: what lies from there on is a loop.
        const from = at[b]
        if (path.length - from >= 3) {
          loops.push({ vertices: Uint32Array.from(path.slice(from)), opposite: Uint32Array.from(opp.slice(from)) })
        } else {
          stray += path.length - from
        }
        for (let i = from; i < path.length; i++) at[path[i]] = -1
        path.length = from
        opp.length = from
        if (path.length === 0) break
      }
      const next = nextOpen(b)
      if (next < 0) {
        // A dead end: the open edges here do not close.
        stray += path.length
        for (const v of path) at[v] = -1
        break
      }
      h = next
      a = b
    }
  }
  return { loops, stray }
}

/** The vertex whose outgoing list holds half-edge `h`. */
function tailOf(offsets: Uint32Array, h: number): number {
  let lo = 0
  let hi = offsets.length - 2
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (offsets[mid] <= h) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Across a rim, mm: the longest span between two of its points — the
 *  diameter of a round hole, where a bounding box would read it √2 too
 *  large on the slant. Found by sweeping to the furthest point and from
 *  there to the furthest again, which is exact for the round and oval rims
 *  holes have and never reads a rim larger than it is. */
export function loopSize(positions: Float32Array, loop: Uint32Array): number {
  const furthest = (from: number): [number, number] => {
    const f = loop[from] * 3
    let best = from
    let bestD = 0
    for (let i = 0; i < loop.length; i++) {
      const v = loop[i] * 3
      const d = (positions[v] - positions[f]) ** 2 + (positions[v + 1] - positions[f + 1]) ** 2 + (positions[v + 2] - positions[f + 2]) ** 2
      if (d > bestD) {
        bestD = d
        best = i
      }
    }
    return [best, Math.sqrt(bestD)]
  }
  const [a] = furthest(0)
  const [b, ab] = furthest(a)
  const [, bc] = furthest(b)
  return Math.max(ab, bc)
}

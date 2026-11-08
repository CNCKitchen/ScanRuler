// SPDX-License-Identifier: AGPL-3.0-only
// Where a mesh is open: the edges with one triangle alone, gathered into
// the gaps they bound — a face a STEP conversion dropped, a hole in a scan
// — each with a place to point at. For a message that says where a
// problem lies rather than that there is one.

import type { Vec3 } from '../types'

export interface MeshGap {
  /** The middle of the gap's rim, mm. */
  at: Vec3
  /** How many open edges bound it. */
  edges: number
  /** The diagonal of the box round its rim, mm. */
  size: number
  /** The rim's length along its open edges, mm. */
  length: number
}

/** A key for the undirected edge between vertices a and b of a mesh of
 *  `n` vertices: the lower times n plus the higher, exact while n² stays
 *  under 2^53 (94 million vertices). The lower times 2^32 was not past
 *  vertex 2^21: edges ran into each other on scans over 2.1 M vertices. */
export const edgeKey = (n: number) => (a: number, b: number) => (a < b ? a * n + b : b * n + a)

/** The number of vertices a mesh's triangles name: one past the highest. */
function vertexCount(indices: Uint32Array): number {
  let n = 0
  for (let i = 0; i < indices.length; i++) if (indices[i] >= n) n = indices[i] + 1
  return n
}

/** The gaps of a welded mesh — rims of open edges joined through their
 *  vertices — largest first, at most `maxGaps` of them. */
export function meshGaps(positions: Float32Array | Float64Array, indices: Uint32Array, maxGaps = 3): MeshGap[] {
  // A directed edge a→b counted; an undirected edge with one triangle on
  // it alone is open.
  const seen = new Map<number, number>()
  const n = Math.max(positions.length / 3, vertexCount(indices))
  const key = edgeKey(n)
  for (let t = 0; t + 2 < indices.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = indices[t + k]
      const b = indices[t + ((k + 1) % 3)]
      if (a === b) continue
      const e = key(a, b)
      seen.set(e, (seen.get(e) ?? 0) + 1)
    }
  }
  const open: [number, number][] = []
  for (const [e, count] of seen) {
    if (count !== 1) continue
    const a = Math.floor(e / n)
    open.push([a, e - a * n])
  }
  if (open.length === 0) return []
  // Rims joined through shared vertices: union-find over the open edges'
  // vertices.
  const parent = new Map<number, number>()
  const find = (v: number): number => {
    let r = v
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!
    let x = v
    while (parent.get(x) !== undefined && parent.get(x) !== r) {
      const next = parent.get(x)!
      parent.set(x, r)
      x = next
    }
    return r
  }
  for (const [a, b] of open) {
    if (!parent.has(a)) parent.set(a, a)
    if (!parent.has(b)) parent.set(b, b)
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  const groups = new Map<number, { edges: number; length: number; vertices: Set<number> }>()
  for (const [a, b] of open) {
    const r = find(a)
    const g = groups.get(r) ?? { edges: 0, length: 0, vertices: new Set<number>() }
    g.edges++
    g.length += Math.hypot(positions[a * 3] - positions[b * 3], positions[a * 3 + 1] - positions[b * 3 + 1], positions[a * 3 + 2] - positions[b * 3 + 2])
    g.vertices.add(a)
    g.vertices.add(b)
    groups.set(r, g)
  }
  const gaps: MeshGap[] = []
  for (const g of groups.values()) {
    const lo = [Infinity, Infinity, Infinity]
    const hi = [-Infinity, -Infinity, -Infinity]
    const sum = [0, 0, 0]
    for (const v of g.vertices) {
      for (let k = 0; k < 3; k++) {
        const x = positions[v * 3 + k]
        sum[k] += x
        if (x < lo[k]) lo[k] = x
        if (x > hi[k]) hi[k] = x
      }
    }
    const n = g.vertices.size
    gaps.push({ at: [sum[0] / n, sum[1] / n, sum[2] / n], edges: g.edges, size: Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]), length: g.length })
  }
  gaps.sort((a, b) => b.edges - a.edges)
  return gaps.slice(0, maxGaps)
}

/** One rim walked round in order: its vertices one after another along
 *  the open edges, and for each edge the triangle it is the open side of
 *  (edge i runs from vertices[i] to vertices[i + 1], the last one back to
 *  the first when the rim closes). */
export interface RimLoop {
  vertices: Uint32Array
  triangles: Uint32Array
  /** Whether the walk came back to where it started. A rim that runs into
   *  a vertex with no open edge left to go on by — a dangling run of open
   *  edges — is walked as far as it goes and left open. */
  closed: boolean
}

/** The rims of a welded mesh, each walked round in order. The open edges
 *  are followed through the vertices they share, whichever way their
 *  triangles wind them — a scan's triangles are not always wound alike —
 *  each edge once; the walks start at the ends of runs that do not close,
 *  then anywhere. Two rims that touch at a vertex may come out as one loop
 *  through it, a figure of eight. Pure topology: the vertices' places are
 *  read by the caller. */
export function rimLoops(indices: Uint32Array): RimLoop[] {
  const seen = new Map<number, number>()
  const key = edgeKey(vertexCount(indices))
  for (let t = 0; t + 2 < indices.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = indices[t + k]
      const b = indices[t + ((k + 1) % 3)]
      if (a === b) continue
      const e = key(a, b)
      seen.set(e, (seen.get(e) ?? 0) + 1)
    }
  }
  // The open edges, each listed at both its ends.
  const edges: { a: number; b: number; tri: number; used: boolean }[] = []
  const at = new Map<number, number[]>()
  for (let t = 0; t + 2 < indices.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = indices[t + k]
      const b = indices[t + ((k + 1) % 3)]
      if (a === b || seen.get(key(a, b)) !== 1) continue
      const id = edges.length
      edges.push({ a, b, tri: t / 3, used: false })
      for (const v of [a, b]) {
        const list = at.get(v) ?? []
        list.push(id)
        at.set(v, list)
      }
    }
  }
  const loops: RimLoop[] = []
  const walk = (start: number) => {
    for (;;) {
      const first = at.get(start)!.find((id) => !edges[id].used)
      if (first === undefined) return
      const vertices: number[] = [start]
      const triangles: number[] = []
      let id: number | undefined = first
      let v = start
      let closed = false
      while (id !== undefined) {
        const e: { a: number; b: number; tri: number; used: boolean } = edges[id]
        e.used = true
        triangles.push(e.tri)
        v = e.a === v ? e.b : e.a
        if (v === start) {
          closed = true
          break
        }
        vertices.push(v)
        id = at.get(v)!.find((x) => !edges[x].used)
      }
      loops.push({ vertices: Uint32Array.from(vertices), triangles: Uint32Array.from(triangles), closed })
    }
  }
  for (const [v, list] of at) if (list.length % 2 === 1) walk(v)
  for (const v of at.keys()) walk(v)
  return loops
}

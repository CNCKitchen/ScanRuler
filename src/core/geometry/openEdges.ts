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
}

/** The gaps of a welded mesh — rims of open edges joined through their
 *  vertices — largest first, at most `maxGaps` of them. */
export function meshGaps(positions: Float32Array | Float64Array, indices: Uint32Array, maxGaps = 3): MeshGap[] {
  // A directed edge a→b counted; an undirected edge with one triangle on
  // it alone is open.
  const seen = new Map<number, number>()
  const key = (a: number, b: number) => (a < b ? a * 4_294_967_296 + b : b * 4_294_967_296 + a)
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
  for (const [e, n] of seen) {
    if (n !== 1) continue
    const a = Math.floor(e / 4_294_967_296)
    open.push([a, e - a * 4_294_967_296])
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
  const groups = new Map<number, { edges: number; vertices: Set<number> }>()
  for (const [a, b] of open) {
    const r = find(a)
    const g = groups.get(r) ?? { edges: 0, vertices: new Set<number>() }
    g.edges++
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
    gaps.push({ at: [sum[0] / n, sum[1] / n, sum[2] / n], edges: g.edges, size: Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) })
  }
  gaps.sort((a, b) => b.edges - a.edges)
  return gaps.slice(0, maxGaps)
}

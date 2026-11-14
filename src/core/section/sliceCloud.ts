// SPDX-License-Identifier: AGPL-3.0-only
// A section through a point cloud. A cloud has no triangles for a plane to
// cut, so the cut is read off the points near it: those within a band of
// 1.5 spacings either side of the plane are laid onto it, gathered into
// cells two spacings across (one point each, their mean — which also
// averages the band's width away), and the cells joined into chains. The
// joining is a shortest-links tree over cells near one another; each piece
// of it is read as its longest path, which runs the length of a wall's
// trace and drops the stubs a noisy band grows to its side. A path whose
// ends meet again is a loop, closed as sliceMesh closes one — its first
// point repeated at its end.
//
// Each point's side, the way out of the material in the plane, is the
// cloud's own normals averaged over the cell and laid into the plane; zero
// where the wall lies too flat in the plane to say (the normals all but
// square to it), as a mesh cut gives zero where its triangles disagree.

import type { Vec3 } from '../types'
import type { SectionCut, SliceOptions } from './slice'

/** Half the band's width, in spacings. */
const BAND_SPACINGS = 1.5
/** A cell's width, in spacings. */
const CELL_SPACINGS = 2
/** Cells within this many cells of each other are joined. */
const LINK_CELLS = 2.5
/** A path is a loop only when it has this many cells and its ends lie
 *  within a link of each other. */
const LOOP_MIN_CELLS = 8
/** Cells whose sides lie further apart than this (cos of the angle) are
 *  the two faces of a wall, never joined. */
const OPPOSED = -0.5
/** A side shorter than this, laid into the plane, says nothing. */
const MIN_SIDE = 0.2

const emptyCut = (): SectionCut => ({ points: new Float32Array(0), offsets: new Uint32Array(1), normals: new Float32Array(0) })

/** Cut the cloud `positions` (normals `normals`, typical spacing `spacing`,
 *  mm) with the plane through `origin` with normal `normal`. The answer has
 *  the shape sliceMesh's has. */
export function sliceCloud(
  positions: Float32Array,
  normals: Float32Array,
  spacing: number,
  origin: Vec3,
  normal: Vec3,
  opts: SliceOptions = {},
): SectionCut {
  const count = Math.floor(positions.length / 3)
  const nl = Math.hypot(normal[0], normal[1], normal[2])
  if (count === 0 || !(nl > 0) || !(spacing > 0)) return emptyCut()
  const n: Vec3 = [normal[0] / nl, normal[1] / nl, normal[2] / nl]
  // A basis in the plane.
  const pick: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  const u = normalise(cross(n, pick))
  const v = cross(n, u)
  const band = BAND_SPACINGS * spacing
  const cell = CELL_SPACINGS * spacing

  // The band's points, laid on the plane and gathered into cells.
  const cells = new Map<string, number>()
  const sumA: number[] = []
  const sumB: number[] = []
  const sumN: number[] = []
  const hits: number[] = []
  for (let i = 0; i < count; i++) {
    const dx = positions[i * 3] - origin[0]
    const dy = positions[i * 3 + 1] - origin[1]
    const dz = positions[i * 3 + 2] - origin[2]
    const d = dx * n[0] + dy * n[1] + dz * n[2]
    if (!(Math.abs(d) <= band)) continue
    const a = dx * u[0] + dy * u[1] + dz * u[2]
    const b = dx * v[0] + dy * v[1] + dz * v[2]
    const key = `${Math.floor(a / cell)},${Math.floor(b / cell)}`
    let c = cells.get(key)
    if (c === undefined) {
      c = hits.length
      cells.set(key, c)
      sumA.push(0)
      sumB.push(0)
      sumN.push(0, 0, 0)
      hits.push(0)
    }
    sumA[c] += a
    sumB[c] += b
    hits[c]++
    const nx = normals[i * 3], ny = normals[i * 3 + 1], nz = normals[i * 3 + 2]
    const along = nx * n[0] + ny * n[1] + nz * n[2]
    sumN[c * 3] += nx - along * n[0]
    sumN[c * 3 + 1] += ny - along * n[1]
    sumN[c * 3 + 2] += nz - along * n[2]
  }
  const m = hits.length
  if (m === 0) return emptyCut()
  const sa = new Float64Array(m)
  const sb = new Float64Array(m)
  for (let c = 0; c < m; c++) {
    sa[c] = sumA[c] / hits[c]
    sb[c] = sumB[c] / hits[c]
  }

  // Each cell's side, unit, or null where it says nothing.
  const side = (c: number): [number, number, number] | null => {
    const x = sumN[c * 3] / hits[c], y = sumN[c * 3 + 1] / hits[c], z = sumN[c * 3 + 2] / hits[c]
    const l = Math.hypot(x, y, z)
    return l >= MIN_SIDE ? [x / l, y / l, z / l] : null
  }
  const opposed = (c: number, o: number): boolean => {
    const p = side(c)
    const q = side(o)
    return p !== null && q !== null && p[0] * q[0] + p[1] * q[1] + p[2] * q[2] < OPPOSED
  }

  // Links between cells near one another, shortest first, and the tree
  // they make (Kruskal).
  const reach = LINK_CELLS * cell
  const span = Math.ceil(LINK_CELLS)
  const links: { a: number; b: number; d: number }[] = []
  for (const [key, c] of cells) {
    const [ia, ib] = key.split(',').map(Number)
    for (let ka = -span; ka <= span; ka++) {
      for (let kb = -span; kb <= span; kb++) {
        const o = cells.get(`${ia + ka},${ib + kb}`)
        if (o === undefined || o <= c) continue
        const d = Math.hypot(sa[o] - sa[c], sb[o] - sb[c])
        // Two faces of a thin wall lie near each other but face apart: never
        // one chain across the wall.
        if (d <= reach && !opposed(c, o)) links.push({ a: c, b: o, d })
      }
    }
  }
  links.sort((x, y) => x.d - y.d)
  const parent = new Int32Array(m)
  for (let c = 0; c < m; c++) parent[c] = c
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }
  const tree: { to: number; d: number }[][] = Array.from({ length: m }, () => [])
  for (const l of links) {
    const ra = find(l.a)
    const rb = find(l.b)
    if (ra === rb) continue
    parent[ra] = rb
    tree[l.a].push({ to: l.b, d: l.d })
    tree[l.b].push({ to: l.a, d: l.d })
  }

  // Each piece of the tree read as its longest path: the farthest cell from
  // any cell is one end, the farthest from that the other.
  const dist = new Float64Array(m).fill(-1)
  const from = new Int32Array(m).fill(-1)
  const farthest = (start: number, seen: number[]): number => {
    for (const s of seen) {
      dist[s] = -1
      from[s] = -1
    }
    seen.length = 0
    dist[start] = 0
    const stack = [start]
    seen.push(start)
    let best = start
    while (stack.length > 0) {
      const c = stack.pop()!
      if (dist[c] > dist[best]) best = c
      for (const e of tree[c]) {
        if (dist[e.to] >= 0) continue
        dist[e.to] = dist[c] + e.d
        from[e.to] = c
        seen.push(e.to)
        stack.push(e.to)
      }
    }
    return best
  }
  const done = new Uint8Array(m)
  const paths: number[][] = []
  const seen: number[] = []
  for (let c = 0; c < m; c++) {
    if (done[c]) continue
    const a = farthest(c, seen)
    for (const s of seen) done[s] = 1
    const size = seen.length
    const b = farthest(a, seen)
    const path: number[] = []
    for (let x = b; x >= 0; x = from[x]) path.push(x)
    // A loop when its ends lie within a link of each other. A slit under
    // about three spacings is finer than the cells read (two spacings
    // across), and closes; one wider stays open.
    const ends = Math.hypot(sa[a] - sa[b], sb[a] - sb[b])
    if (size >= LOOP_MIN_CELLS && path.length >= LOOP_MIN_CELLS && ends <= reach) path.push(path[0])
    paths.push(path)
  }

  const minLength = opts.minLength ?? 0
  const kept = paths.filter((p) => {
    if (p.length < 2) return false
    if (minLength <= 0) return true
    let l = 0
    for (let i = 1; i < p.length; i++) l += Math.hypot(sa[p[i]] - sa[p[i - 1]], sb[p[i]] - sb[p[i - 1]])
    return l >= minLength
  })

  let total = 0
  for (const p of kept) total += p.length
  const points = new Float32Array(total * 3)
  const sides = new Float32Array(total * 3)
  const offsets = new Uint32Array(kept.length + 1)
  let at = 0
  kept.forEach((p, pi) => {
    offsets[pi] = at
    for (const c of p) {
      for (let k = 0; k < 3; k++) points[at * 3 + k] = origin[k] + sa[c] * u[k] + sb[c] * v[k]
      const sx = sumN[c * 3] / hits[c], sy = sumN[c * 3 + 1] / hits[c], sz = sumN[c * 3 + 2] / hits[c]
      const l = Math.hypot(sx, sy, sz)
      if (l >= MIN_SIDE) {
        sides[at * 3] = sx / l
        sides[at * 3 + 1] = sy / l
        sides[at * 3 + 2] = sz / l
      }
      at++
    }
  })
  offsets[kept.length] = at
  return { points, offsets, normals: sides }
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function normalise(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2])
  return [a[0] / l, a[1] / l, a[2] / l]
}

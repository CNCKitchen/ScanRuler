// SPDX-License-Identifier: AGPL-3.0-only
// A surface out of a scalar field on a grid, by marching tetrahedra: each
// cube of the grid cut into the six tetrahedra of Kuhn's triangulation, so
// neighbouring cubes cut their shared face alike and the surface closes; one
// vertex on each grid edge the field crosses, shared by every triangle on
// that edge. Shell's inner wall is made this way. Wrap's skin is made tile by
// tile by marching cubes (CUBE_TRIANGLES), which closes the same way with
// half the triangles. Both drop the specks the grid leaves.

import { vertexComponents } from '../../../src/core/geometry/unionFind'
import { tetraVolume6 } from '../../../src/core/geometry/centroid'

/** The six tetrahedra of a cube, Kuhn's: each runs from the cube's lowest
 *  corner to its highest along the edges in one order of the axes, so two
 *  cubes side by side cut their shared face the same way. Corners by bits —
 *  1 is +X, 2 +Y, 4 +Z. Every edge of them runs from a corner to one with
 *  more bits set, so it is the lower corner and one of seven directions. */
export const TETS: readonly (readonly [number, number, number, number])[] = [
  [0, 1, 3, 7],
  [0, 1, 5, 7],
  [0, 2, 3, 7],
  [0, 2, 6, 7],
  [0, 4, 5, 7],
  [0, 4, 6, 7],
]

/** A cube's twelve edges, each from a corner (bits as in TETS) along +X,
 *  +Y or +Z — the bit it adds. */
export const CUBE_EDGE_FROM: readonly number[] = []
export const CUBE_EDGE_DIR: readonly number[] = []
for (const dir of [1, 2, 4]) {
  for (let a = 0; a < 8; a++) {
    if (a & dir) continue
    ;(CUBE_EDGE_FROM as number[]).push(a)
    ;(CUBE_EDGE_DIR as number[]).push(dir)
  }
}

/**
 * Marching cubes' triangles for each of the 256 ways a cube's corners can
 * lie above zero (bit c of the case for corner c), by cube edge — three a
 * triangle, each facing the corners above zero.
 *
 * Made here rather than copied: on each face of the cube the edges the
 * field crosses are joined in twos, and where a face has all four crossed —
 * two corners above zero across from each other — each of those two is cut
 * off on its own. That rule reads only the face's own four corners, so the
 * two cubes either side of it join the same edges and the surface closes,
 * every edge of it between two triangles. The joins on the six faces close
 * up into loops round the cube, each laid out as a fan of triangles. Each
 * join runs with the corners above zero on its left, seen from outside the
 * cube, so every loop runs round them anticlockwise and its triangles face
 * them.
 *
 * Against marching tetrahedra on the same grid, half the vertices and half
 * the triangles — and everything after the march costs by those.
 */
export const CUBE_TRIANGLES: readonly Uint8Array[] = (() => {
  const at = (c: number) => [c & 1, (c >> 1) & 1, (c >> 2) & 1]
  const edgeOf = (a: number, b: number) => {
    const lo = Math.min(a, b), dir = Math.abs(a - b)
    for (let e = 0; e < 12; e++) if (CUBE_EDGE_FROM[e] === lo && CUBE_EDGE_DIR[e] === dir) return e
    throw new Error('not a cube edge')
  }
  const middle = (e: number) => {
    const p = at(CUBE_EDGE_FROM[e])
    const d = at(CUBE_EDGE_DIR[e])
    return [p[0] + d[0] / 2, p[1] + d[1] / 2, p[2] + d[2] / 2]
  }
  const faces: { corners: number[]; normal: number[] }[] = []
  for (let ax = 0; ax < 3; ax++) {
    const bit = 1 << ax, u = 1 << ((ax + 1) % 3), v = 1 << ((ax + 2) % 3)
    for (const side of [0, 1]) {
      const base = side ? bit : 0
      const normal = [0, 0, 0]
      normal[ax] = side ? 1 : -1
      faces.push({ corners: [base, base | u, base | u | v, base | v], normal })
    }
  }
  const table: Uint8Array[] = []
  for (let c = 0; c < 256; c++) {
    const above = (k: number) => (c >> k) & 1
    const next = new Int8Array(12).fill(-1)
    const join = (from: number, to: number, corner: number, normal: number[]) => {
      // From → to with `corner`, above zero, on the left seen from outside.
      const a = middle(from), b = middle(to), p = at(corner)
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
      const wx = p[0] - a[0], wy = p[1] - a[1], wz = p[2] - a[2]
      const left = (uy * wz - uz * wy) * normal[0] + (uz * wx - ux * wz) * normal[1] + (ux * wy - uy * wx) * normal[2]
      if (left > 0) next[from] = to
      else next[to] = from
    }
    for (const { corners: q, normal } of faces) {
      const crossed: number[] = []
      for (let i = 0; i < 4; i++) if (above(q[i]) !== above(q[(i + 1) % 4])) crossed.push(i)
      if (crossed.length === 2) {
        const corner = q.find((k) => above(k))!
        join(edgeOf(q[crossed[0]], q[(crossed[0] + 1) % 4]), edgeOf(q[crossed[1]], q[(crossed[1] + 1) % 4]), corner, normal)
      } else if (crossed.length === 4) {
        for (let i = 0; i < 4; i++) {
          if (!above(q[i])) continue
          join(edgeOf(q[(i + 3) % 4], q[i]), edgeOf(q[i], q[(i + 1) % 4]), q[i], normal)
        }
      }
    }
    const tris: number[] = []
    const seen = new Uint8Array(12)
    for (let e = 0; e < 12; e++) {
      if (next[e] < 0 || seen[e]) continue
      const loop: number[] = []
      for (let x = e; !seen[x]; x = next[x]) {
        seen[x] = 1
        loop.push(x)
      }
      // The fan from a corner of the loop whose diagonals never lie in a
      // face of the cube: the cube on the other side of that face could
      // draw the same one, and the edge would have four triangles.
      const n = loop.length
      const sharesFace = (a: number, b: number) => {
        const pa = middle(a), pb = middle(b)
        return pa.some((x, k) => (x === 0 || x === 1) && x === pb[k])
      }
      let apex = -1
      for (let s = 0; s < n && apex < 0; s++) {
        let fine = true
        for (let i = 2; i < n - 1 && fine; i++) if (sharesFace(loop[s], loop[(s + i) % n])) fine = false
        if (fine) apex = s
      }
      if (apex < 0) throw new Error(`cube case ${c}: no fan`)
      for (let i = 1; i + 1 < n; i++) tris.push(loop[apex], loop[(apex + i) % n], loop[(apex + i + 1) % n])
    }
    table.push(Uint8Array.from(tris))
  }
  return table
})()

/** A Float32Array or Uint32Array that grows as it is written. */
export class Grow<T extends Float32Array | Uint32Array | Float64Array | Uint8Array> {
  length = 0
  constructor(public data: T) {}
  push(x: number): void {
    if (this.length === this.data.length) {
      const bigger = new (this.data.constructor as { new (n: number): T })(this.data.length * 2)
      bigger.set(this.data)
      this.data = bigger
    }
    this.data[this.length++] = x
  }
  done(): T {
    return this.data.slice(0, this.length) as T
  }
}

/**
 * The surface where `field` crosses zero, by marching tetrahedra: one vertex
 * on each grid edge it crosses, shared by every triangle on that edge, and
 * every triangle facing the side where the field is positive.
 */
export function marchTetrahedra(
  field: Float32Array,
  nx: number,
  ny: number,
  nz: number,
  ox: number,
  oy: number,
  oz: number,
  h: number,
): { positions: Float32Array; indices: Uint32Array } {
  const plane = nx * ny
  const total = plane * nz
  const corner = [0, 1, nx, nx + 1, plane, plane + 1, plane + nx, plane + nx + 1]
  const positions = new Grow(new Float32Array(1 << 16))
  const middles = new Grow(new Float32Array(1 << 16))
  const indices = new Grow(new Uint32Array(1 << 16))
  const onEdge = new Map<number, number>()
  const px = (g: number) => ox + (g % nx) * h
  const py = (g: number) => oy + (((g / nx) | 0) % ny) * h
  const pz = (g: number) => oz + ((g / plane) | 0) * h

  const vertexOn = (a: number, b: number): number => {
    const key = a < b ? a * total + b : b * total + a
    let id = onEdge.get(key)
    if (id !== undefined) return id
    const fa = field[a]
    const fb = field[b]
    const s = fa / (fa - fb)
    id = positions.length / 3
    positions.push(px(a) + s * (px(b) - px(a)))
    positions.push(py(a) + s * (py(b) - py(a)))
    positions.push(pz(a) + s * (pz(b) - pz(a)))
    middles.push((px(a) + px(b)) / 2)
    middles.push((py(a) + py(b)) / 2)
    middles.push((pz(a) + pz(b)) / 2)
    onEdge.set(key, id)
    return id
  }
  const emit = emitter(() => middles.data, indices)

  const g = new Int32Array(8)
  const pos: number[] = []
  const neg: number[] = []
  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const origin = i + nx * j + plane * k
        let above = 0
        for (let c = 0; c < 8; c++) {
          g[c] = origin + corner[c]
          if (field[g[c]] > 0) above++
        }
        if (above === 0 || above === 8) continue
        for (const tet of TETS) {
          pos.length = 0
          neg.length = 0
          for (const c of tet) (field[g[c]] > 0 ? pos : neg).push(g[c])
          if (pos.length === 0 || neg.length === 0) continue
          // Which way is out of the material: from the corners below zero
          // to those above.
          let dx = 0, dy = 0, dz = 0
          for (const p of pos) {
            dx += px(p) / pos.length
            dy += py(p) / pos.length
            dz += pz(p) / pos.length
          }
          for (const q of neg) {
            dx -= px(q) / neg.length
            dy -= py(q) / neg.length
            dz -= pz(q) / neg.length
          }
          tetSurface(pos, neg, vertexOn, emit, dx, dy, dz)
        }
      }
    }
  }
  return { positions: positions.done(), indices: indices.done() }
}

/** A triangle `a, b, c` pushed onto `indices`, wound to face `dx, dy, dz` —
 *  read off `reference`, three floats a vertex: the middle of the grid edge
 *  each vertex lies on. Those never coincide, where the vertices themselves
 *  can — two on edges that meet at a grid point the field is zero at — and
 *  the triangle through the middles faces the way the true one does
 *  whatever the field (the sign of the tetrahedron's own volume decides
 *  both). */
export function emitter(reference: () => Float32Array, indices: Grow<Uint32Array>) {
  return (a: number, b: number, c: number, dx: number, dy: number, dz: number): void => {
    const p = reference()
    const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2]
    const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2]
    const dot = (uy * vz - uz * vy) * dx + (uz * vx - ux * vz) * dy + (ux * vy - uy * vx) * dz
    indices.push(a)
    if (dot >= 0) {
      indices.push(b)
      indices.push(c)
    } else {
      indices.push(c)
      indices.push(b)
    }
  }
}

/** The surface through one tetrahedron whose corners `pos` lie above zero
 *  and `neg` at or below it: a triangle cutting off a lone corner, or a quad
 *  between two and two. */
export function tetSurface(
  pos: readonly number[],
  neg: readonly number[],
  vertexOn: (a: number, b: number) => number,
  emit: (a: number, b: number, c: number, dx: number, dy: number, dz: number) => void,
  dx: number,
  dy: number,
  dz: number,
): void {
  if (pos.length === 1 || neg.length === 1) {
    const [lone, others] = pos.length === 1 ? [pos[0], neg] : [neg[0], pos]
    emit(vertexOn(lone, others[0]), vertexOn(lone, others[1]), vertexOn(lone, others[2]), dx, dy, dz)
  } else {
    const a = vertexOn(pos[0], neg[0])
    const b = vertexOn(pos[0], neg[1])
    const c = vertexOn(pos[1], neg[1])
    const d = vertexOn(pos[1], neg[0])
    emit(a, b, c, dx, dy, dz)
    emit(a, c, d, dx, dy, dz)
  }
}

/**
 * A marched surface's pieces without those enclosing less than `minVolume`:
 * the triangles kept (and 1 for each in `kept`), and how many pieces they
 * make. `facing` is which way
 * the pieces kept face — `in` for a cavity's wall, whose volume is negative,
 * `out` for a skin round a solid.
 */
export function dropSpecks(
  positions: Float32Array,
  indices: Uint32Array,
  minVolume: number,
  facing: 'in' | 'out' = 'in',
): { indices: Uint32Array; pieces: number; kept: Uint8Array } {
  const sign = facing === 'in' ? -1 : 1
  // The roots are only keys here, so which corner's root wins does not matter.
  const { find } = vertexComponents(indices, positions.length / 3)
  const volume = new Map<number, number>()
  for (let t = 0; t < indices.length; t += 3) {
    const v = tetraVolume6(positions, indices[t] * 3, indices[t + 1] * 3, indices[t + 2] * 3)
    const root = find(indices[t])
    volume.set(root, (volume.get(root) ?? 0) + v / 6)
  }
  let pieces = 0
  for (const v of volume.values()) if (sign * v >= minVolume) pieces++
  const out = new Grow(new Uint32Array(Math.max(16, indices.length)))
  const kept = new Uint8Array(indices.length / 3)
  for (let t = 0; t < indices.length; t += 3) {
    if (sign * (volume.get(find(indices[t])) ?? 0) < minVolume) continue
    kept[t / 3] = 1
    out.push(indices[t])
    out.push(indices[t + 1])
    out.push(indices[t + 2])
  }
  return { indices: out.done(), pieces, kept }
}

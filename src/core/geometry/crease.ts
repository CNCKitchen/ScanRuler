// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Crease-aware shading normals: sharp edges drawn sharp.
 *
 * The viewer shades with one normal per welded vertex, the area-weighted sum
 * of the faces that meet there (see normals.ts). On a scan that is right: the
 * surface is dense and smooth, and one normal per vertex is what a smooth
 * surface has. On a low-poly mesh out of a CAD system it is wrong at every
 * edge: a cube's corner gets a normal pointing out of the corner, and each of
 * its flat faces shades as a gradient from that corner inward, so a box
 * looks like a pillow and a hole looks like a dent (issue #5).
 *
 * The fix is the one every modelling tool ships as "auto smooth": a vertex on
 * a sharp edge is drawn as two vertices, one per side, each with the normal of
 * its own side. Around each vertex the incident triangles are grouped by
 * walking from triangle to triangle across the edges whose dihedral is under
 * the crease angle; each group beyond the first becomes a copy of the vertex,
 * appended after the mesh's own vertices with the group's normal. Nothing
 * else changes: the triangles keep their count and order, so a face index
 * from a raycast still names the same triangle, and the first vertexCount
 * entries of every array are still the mesh's own vertices in their own
 * order, which is what every region, marking and field is keyed by. Only the
 * index buffer names copies, and `copyOf` says which vertex each copy is.
 *
 * Two guards keep this off a scan where it would do harm. A noisy scan has
 * sharp edges everywhere — every triangle that noise has tipped past the
 * angle against its neighbour — and splitting them all speckles the surface
 * and multiplies the vertex list. So the scan is only split when it looks
 * like a tessellation (see looksTessellated), unless the operator says
 * otherwise; and whatever they say, a split that would add more than the
 * budget is not made at all.
 */

import { computeVertexNormals } from './normals'

/** What the operator asked for the scan: split when it looks like CAD, always,
 *  or never. The reference is always split — it is CAD. */
export type CreaseMode = 'auto' | 'on' | 'off'

/** The dihedral angle from which an edge counts as sharp, in degrees. The
 *  default of every modelling tool's auto-smooth; a 12° step between the
 *  facets of a coarse cylinder stays smooth, a 45° chamfer breaks. */
export const CREASE_ANGLE_DEG = 30

/** The share of a mesh's edges that must be dead flat for it to count as a
 *  tessellation — see looksTessellated. */
export const TESSELLATED_SHARE = 0.1

/** An edge is flat when the faces either side of it agree to within this,
 *  in degrees. Float32 coordinates round a planar face's triangles a few
 *  millionths of a degree apart; scanner noise tips adjacent triangles a
 *  tenth of a degree or more, even on the cleanest scan of a flat. */
const FLAT_DEG = 0.01

/** How many copies a split may append before it is abandoned: never more
 *  than the mesh's own vertex count, and any small mesh fits whole. A copy
 *  costs what a vertex costs in the viewer — position, normal, colour, tint,
 *  paint, corner slot — so this bounds the split at doubling the mesh. */
export function creaseBudget(vertexCount: number): number {
  return Math.max(250_000, vertexCount)
}

export interface CreaseSplit {
  /** The mesh's vertices followed by the copies. */
  positions: Float32Array
  /** Per vertex and copy, the normal of the side it is on. */
  normals: Float32Array
  /** The same triangles, with the corners on a crease pointing at copies. */
  indices: Uint32Array
  /** The corner slots, each copy wearing its vertex's. A copy shares every
   *  triangle corner its vertex would have, so the colouring still holds. */
  wireSlots: Uint8Array
  /** The vertex each copy stands in for: copy `vertexCount + k` is vertex
   *  `copyOf[k]`. Empty when nothing was split. */
  copyOf: Uint32Array
}

/** What became of the split, for the status line. */
export interface CreaseReport {
  /** Copies appended to the vertex list; 0 when nothing needed splitting. */
  added: number
  /** Why no split was made, or null when one was (added may still be 0):
   *  the operator said never, the mesh looked like a scan under Auto, or the
   *  split would have gone past the budget. */
  skipped: 'off' | 'scan' | 'budget' | null
}

/** Per-triangle normals, unnormalized: the cross product of two edges, whose
 *  length is twice the area. In doubles — the flatness test looks for
 *  agreement to a hundredth of a degree, closer than a float holds. */
function faceNormals(positions: Float32Array, indices: Uint32Array): Float64Array {
  const out = new Float64Array(indices.length)
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3
    const abx = positions[b] - positions[a]
    const aby = positions[b + 1] - positions[a + 1]
    const abz = positions[b + 2] - positions[a + 2]
    const acx = positions[c] - positions[a]
    const acy = positions[c + 1] - positions[a + 1]
    const acz = positions[c + 2] - positions[a + 2]
    out[t] = aby * acz - abz * acy
    out[t + 1] = abz * acx - abx * acz
    out[t + 2] = abx * acy - aby * acx
  }
  return out
}

/** Vertex-to-triangle incidence in CSR form. */
function vertexTriangles(
  indices: Uint32Array,
  vertexCount: number,
): { offsets: Uint32Array; list: Uint32Array } {
  const offsets = new Uint32Array(vertexCount + 1)
  for (let i = 0; i < indices.length; i++) offsets[indices[i] + 1]++
  for (let v = 0; v < vertexCount; v++) offsets[v + 1] += offsets[v]
  const list = new Uint32Array(indices.length)
  const cursor = offsets.slice(0, vertexCount)
  for (let i = 0; i < indices.length; i++) list[cursor[indices[i]]++] = (i / 3) | 0
  return { offsets, list }
}

/** The cosine of the angle between two face normals, or 1 when either face
 *  is a degenerate sliver with no direction — a sliver joins whatever it
 *  touches rather than cutting a crease through a flat. */
function cosBetween(fn: Float64Array, ti: number, tj: number): number {
  const i = ti * 3, j = tj * 3
  const li = fn[i] * fn[i] + fn[i + 1] * fn[i + 1] + fn[i + 2] * fn[i + 2]
  const lj = fn[j] * fn[j] + fn[j + 1] * fn[j + 1] + fn[j + 2] * fn[j + 2]
  if (li < 1e-30 || lj < 1e-30) return 1
  return (fn[i] * fn[j] + fn[i + 1] * fn[j + 1] + fn[i + 2] * fn[j + 2]) / Math.sqrt(li * lj)
}

/**
 * Walk the edges around every vertex, calling `edge` once per pair of
 * triangles that share an edge with it — each interior edge is therefore
 * seen twice, once from either end, which nothing here minds. `stamp` and
 * `first` are scratch over the vertices: a corner seen for the first time
 * around this vertex is remembered, and the next triangle around the same
 * vertex that reaches it shares the edge.
 */
function forEachFanEdge(
  indices: Uint32Array,
  fan: { offsets: Uint32Array; list: Uint32Array },
  vertexCount: number,
  edge: (v: number, fi: number, fj: number) => void,
): void {
  const stamp = new Uint32Array(vertexCount)
  const first = new Uint32Array(vertexCount)
  const { offsets, list } = fan
  for (let v = 0; v < vertexCount; v++) {
    const begin = offsets[v], end = offsets[v + 1]
    if (end - begin < 2) continue
    const mark = v + 1
    for (let k = begin; k < end; k++) {
      const t = list[k] * 3
      for (let c = 0; c < 3; c++) {
        const w = indices[t + c]
        if (w === v) continue
        if (stamp[w] === mark) edge(v, first[w], k - begin)
        else {
          stamp[w] = mark
          first[w] = k - begin
        }
      }
    }
  }
}

/**
 * The share of the mesh's edges whose two faces are dead flat against each
 * other. A tessellated CAD part is full of them — every planar face is a
 * fan of coplanar triangles — while a scan has practically none, because
 * noise puts every edge at some small angle. That is the one signal that
 * tells the two apart without looking at the file name or the triangle
 * count, and it is what Auto goes on.
 */
export function coplanarShare(positions: Float32Array, indices: Uint32Array): number {
  const vertexCount = positions.length / 3
  const fn = faceNormals(positions, indices)
  const fan = vertexTriangles(indices, vertexCount)
  const flat = Math.cos((FLAT_DEG * Math.PI) / 180)
  let edges = 0
  let coplanar = 0
  forEachFanEdge(indices, fan, vertexCount, (v, fi, fj) => {
    const begin = fan.offsets[v]
    edges++
    if (cosBetween(fn, fan.list[begin + fi], fan.list[begin + fj]) >= flat) coplanar++
  })
  return edges === 0 ? 0 : coplanar / edges
}

/** Whether a mesh reads as a tessellation of exact surfaces rather than a
 *  scan — the call Auto makes. */
export function looksTessellated(positions: Float32Array, indices: Uint32Array): boolean {
  return coplanarShare(positions, indices) >= TESSELLATED_SHARE
}

/**
 * Split the vertices on sharp edges, one copy per smooth side beyond the
 * first. Null when the split would append more than `budget` copies — the
 * mesh is then shown as it was, smooth everywhere, rather than doubled.
 * `angleDeg` is the dihedral from which an edge is sharp.
 */
export function splitCreases(
  positions: Float32Array,
  indices: Uint32Array,
  wireSlots: Uint8Array,
  angleDeg = CREASE_ANGLE_DEG,
  budget = creaseBudget(positions.length / 3),
): CreaseSplit | null {
  const vertexCount = positions.length / 3
  const fn = faceNormals(positions, indices)
  const fan = vertexTriangles(indices, vertexCount)
  const smooth = Math.cos((angleDeg * Math.PI) / 180)
  const { offsets, list } = fan

  // Union-find over the triangles around one vertex, scratch sized to the
  // widest fan. Pairs sharing an edge are joined when the edge is smooth.
  let parent = new Uint32Array(64)
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  // Pass one: group the fans. The group of a corner is written into `group`
  // (per corner, the root's fan slot) so the copies can be dealt out after
  // the walk without repeating it.
  const stamp = new Uint32Array(vertexCount)
  const first = new Uint32Array(vertexCount)
  const groupOfCorner = new Uint32Array(indices.length)
  for (let v = 0; v < vertexCount; v++) {
    const begin = offsets[v], end = offsets[v + 1]
    const k = end - begin
    if (k < 2) continue
    if (parent.length < k) parent = new Uint32Array(k * 2)
    for (let i = 0; i < k; i++) parent[i] = i
    const mark = v + 1
    for (let i = 0; i < k; i++) {
      const t = list[begin + i] * 3
      for (let c = 0; c < 3; c++) {
        const w = indices[t + c]
        if (w === v) continue
        if (stamp[w] === mark) {
          const j = first[w]
          if (cosBetween(fn, list[begin + i], list[begin + j]) >= smooth) {
            const ri = find(i), rj = find(j)
            if (ri !== rj) parent[ri] = rj
          }
        } else {
          stamp[w] = mark
          first[w] = i
        }
      }
    }
    for (let i = 0; i < k; i++) {
      const t = list[begin + i] * 3
      const c = indices[t] === v ? 0 : indices[t + 1] === v ? 1 : 2
      groupOfCorner[t + c] = find(i)
    }
  }

  // Pass two: deal out the copies. Around each vertex the group holding its
  // first triangle keeps the vertex; every other group gets a copy, in the
  // order the groups are first met.
  const copies: number[] = []
  const newIndices = indices.slice()
  let slots = new Int32Array(64)
  for (let v = 0; v < vertexCount; v++) {
    const begin = offsets[v], end = offsets[v + 1]
    const k = end - begin
    if (k < 2) continue
    if (slots.length < k) slots = new Int32Array(k * 2)
    slots.fill(-1, 0, k)
    let keep = -1
    for (let i = 0; i < k; i++) {
      const t = list[begin + i] * 3
      const c = indices[t] === v ? 0 : indices[t + 1] === v ? 1 : 2
      const g = groupOfCorner[t + c]
      if (keep < 0) keep = g
      if (g === keep) continue
      if (slots[g] < 0) {
        if (copies.length >= budget) return null
        slots[g] = vertexCount + copies.length
        copies.push(v)
      }
      newIndices[t + c] = slots[g]
    }
  }

  const added = copies.length
  const copyOf = Uint32Array.from(copies)
  const newPositions = new Float32Array((vertexCount + added) * 3)
  newPositions.set(positions)
  const newSlots = new Uint8Array(vertexCount + added)
  newSlots.set(wireSlots)
  for (let k = 0; k < added; k++) {
    const v = copyOf[k] * 3
    const d = (vertexCount + k) * 3
    newPositions[d] = positions[v]
    newPositions[d + 1] = positions[v + 1]
    newPositions[d + 2] = positions[v + 2]
    newSlots[vertexCount + k] = wireSlots[copyOf[k]]
  }
  // With the sides parted, the plain per-vertex sum is each side's own
  // normal — and the mesh's winding was put outward when it was built, so
  // the sums point the right way.
  const normals = computeVertexNormals(newPositions, newIndices)
  return { positions: newPositions, normals, indices: newIndices, wireSlots: newSlots, copyOf }
}

/**
 * The split a load makes, given what the operator asked for: `on` splits,
 * `off` does not, and `auto` splits only a mesh that looks tessellated. Null
 * with the reason when no split was made.
 */
export function creaseFor(
  mode: CreaseMode,
  positions: Float32Array,
  indices: Uint32Array,
  wireSlots: Uint8Array,
): { split: CreaseSplit | null; report: CreaseReport } {
  if (mode === 'off') return { split: null, report: { added: 0, skipped: 'off' } }
  if (mode === 'auto' && !looksTessellated(positions, indices)) {
    return { split: null, report: { added: 0, skipped: 'scan' } }
  }
  const split = splitCreases(positions, indices, wireSlots)
  if (!split) return { split: null, report: { added: 0, skipped: 'budget' } }
  return { split, report: { added: split.copyOf.length, skipped: null } }
}

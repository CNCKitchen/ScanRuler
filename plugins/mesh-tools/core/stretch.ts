// SPDX-License-Identifier: AGPL-3.0-only
// Stretch: the part cut across a direction at one place, the side past the
// cut moved out along it, and the cut's own cross-section extruded across
// the gap — a spacer lengthened without widening its ends, two holes moved
// apart without changing their size. A negative amount takes a slab that
// thick out instead, past the cut, and closes the part up again.
//
// Lengthening: the mesh is split where the plane crosses it, so every
// triangle lies wholly on one side. The rim where the two sides meet is
// doubled — the side short of the cut keeps it, the side past it takes the
// copy along — and a ribbon of triangles joins each edge of the rim to its
// copy: the cross-section, extruded. Nothing else changes shape, so a closed
// part stays closed, and every triangle faces the way it did.
//
// Shortening: the mesh is split at the cut and again the amount past it.
// What lies between is flattened onto the cut and what lies past is moved
// back, and the points the flattening lays on one another are joined. Where
// the cross-section is the same at both ends — the plain middle of a spacer
// — the two rims meet and the slab is simply gone; where it is not, the
// flattened slab stays as a flat step between them, so the part is still
// closed.
//
// One piece alone: of the mesh past the cut, only the piece the point picked
// is on moves — one leg of a U, one pin of several — and the others stay.
// A face lying in the plane of the cut stays with the side short of it, and
// joins nothing: it is the top of the base the legs stand on.
//
// Lengthening, no vertex goes and none is renumbered: the copies of the rim
// come after them, so whatever is marked on the part by vertex stays on it.
// Shortening, the points joined go into the one with the lowest number.

import type { Vec3 } from '../../../src/core/types'
import { middleOffset } from './cutPlane'
import { compactEdit, type EditedMesh } from './edit'

export interface StretchSettings {
  /** The direction stretched along, through `origin`: the cut's place is
   *  measured along it from there, mm. Need not be of unit length. */
  origin: Vec3
  dir: Vec3
  /** Where the part is cut, mm along the direction — null for through its
   *  middle. */
  at: number | null
  /** How far the side past the cut moves out, mm: the length of the section
   *  put in — or, negative, of the slab taken out. */
  amount: number
  /** Only the piece of the part past the cut that this point is on, in the
   *  mesh's frame, moves. */
  piece?: Vec3 | null
}

export interface StretchReport {
  /** Where the part was cut, mm along the direction, and by how much it
   *  grew. */
  at: number
  amount: number
  /** How far the part reaches along the direction, before and after. */
  extent: { min: number; max: number }
  newExtent: { min: number; max: number }
  /** The middle of the rim the cut leaves on the side short of it — where a
   *  grip on the cut stands — or null where the side that moves does not
   *  touch the cut. */
  centre: Vec3 | null
  /** Triangles split by the cut, and those the section put in brought. */
  split: number
  added: number
  /** Only one piece moved. */
  piece: boolean
  /** How many pieces the part past the cut falls into there — two for a U
   *  cut across both legs. With one, there is no piece to pick. */
  pieces: number
}

/** Each triangle's part in the stretch: 0 where it was, 2 the section put
 *  in (or, shortening, the slab flattened onto the cut), 3 moved with the
 *  side past the cut. */
export type StretchSlab = 0 | 2 | 3

export interface StretchResult extends EditedMesh {
  report: StretchReport
  /** Each triangle's slab — what the preview tints, and how a point picked
   *  on it is taken back to where it was (see unstretch). */
  slab: Uint8Array
  /** Where the cut meets the part, as the stretch leaves it: the outline of
   *  the cross-section on the cut — and, lengthening, again where the
   *  section put in ends — as segments, six floats each. What the preview
   *  draws on the part. */
  rim: Float32Array
}

/** Where a point at `s` along the direction, on a triangle of the slab
 *  `slab`, was before the stretch: the section put in was all at the cut. */
export function unstretch(s: number, slab: number, at: number, amount: number): number {
  if (slab === 3) return s - amount
  if (slab === 2) return at
  return s
}

/** A place along the direction as a person would have typed it: on a 1-2-5
 *  step of about a thousandth of the part's reach (see middleOffset). */
export function typedPlace(s: number, reach: number): number {
  return middleOffset(s, reach / 10)
}

/**
 * Where a plane across the direction at `at` meets the mesh as it stands —
 * the outline of the cross-section there, as segments, six floats each —
 * and the middle of it. Nothing is split or moved: one pass over the
 * triangles, quick enough to follow a hand dragging the cut, frame by
 * frame, where a stretch worked out in full is not.
 */
export function cutOutline(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  origin: Vec3,
  dir: Vec3,
  at: number,
): { segments: Float32Array; centre: Vec3 | null } {
  const len = Math.hypot(dir[0], dir[1], dir[2])
  if (!(len > 0)) return { segments: new Float32Array(0), centre: null }
  const nx = dir[0] / len, ny = dir[1] / len, nz = dir[2] / len
  const level = at + origin[0] * nx + origin[1] * ny + origin[2] * nz
  const out: number[] = []
  const d = [0, 0, 0]
  const p: number[] = []
  let cx = 0, cy = 0, cz = 0
  for (let t = 0; t + 2 < indices.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const v = indices[t + k] * 3
      d[k] = positions[v] * nx + positions[v + 1] * ny + positions[v + 2] * nz - level
    }
    if ((d[0] > 0 && d[1] > 0 && d[2] > 0) || (d[0] < 0 && d[1] < 0 && d[2] < 0)) continue
    p.length = 0
    for (let k = 0; k < 3 && p.length < 6; k++) {
      const a = indices[t + k] * 3, b = indices[t + ((k + 1) % 3)] * 3
      const da = d[k], db = d[(k + 1) % 3]
      if (da === 0) p.push(positions[a], positions[a + 1], positions[a + 2])
      else if (da * db < 0) {
        const f = da / (da - db)
        p.push(positions[a] + f * (positions[b] - positions[a]), positions[a + 1] + f * (positions[b + 1] - positions[a + 1]), positions[a + 2] + f * (positions[b + 2] - positions[a + 2]))
      }
    }
    if (p.length !== 6) continue
    out.push(...p)
    cx += p[0] + p[3]
    cy += p[1] + p[4]
    cz += p[2] + p[5]
  }
  const n = out.length / 3
  return { segments: new Float32Array(out), centre: n > 0 ? [cx / n, cy / n, cz / n] : null }
}

export function stretchMesh(positions: Float32Array, indices: Uint32Array, vertexCount: number, settings: StretchSettings): StretchResult {
  const len = Math.hypot(settings.dir[0], settings.dir[1], settings.dir[2])
  if (!(len > 0)) throw new Error('The direction to stretch along has none.')
  const n: Vec3 = [settings.dir[0] / len, settings.dir[1] / len, settings.dir[2] / len]
  const o = settings.origin
  const amount = settings.amount
  if (!Number.isFinite(amount)) throw new Error('The amount has to be a number.')

  // Every vertex's place along the direction, and the part's reach.
  const used = new Uint8Array(vertexCount)
  for (let i = 0; i < indices.length; i++) used[indices[i]] = 1
  const place: number[] = new Array(vertexCount)
  let min = Infinity
  let max = -Infinity
  let largest = 0
  for (let v = 0; v < vertexCount; v++) {
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2]
    const s = (x - o[0]) * n[0] + (y - o[1]) * n[1] + (z - o[2]) * n[2]
    place[v] = s
    if (!used[v]) continue
    if (s < min) min = s
    if (s > max) max = s
    largest = Math.max(largest, Math.abs(x), Math.abs(y), Math.abs(z))
  }
  if (!(max >= min)) throw new Error('There is no mesh to stretch.')
  const reach = max - min
  if (!(reach > 0)) throw new Error('The part is flat across that direction — there is nothing along it to stretch.')

  const at = settings.at ?? middleOffset((min + max) / 2, reach)
  if (!Number.isFinite(at)) throw new Error('The cut’s place has to be a number.')
  if (!(at > min && at < max)) throw new Error('The cut lies off the part — place it across the part.')
  const out = amount < 0 ? at - amount : at
  if (!(out < max)) throw new Error('That takes out everything past the cut — take out less than the part reaches past it.')

  // A point this close to a plane is on it: put there, rather than leaving a
  // sliver of a triangle between it and the plane — a micrometre on a part a
  // decimetre long.
  const snap = Math.max(largest * 5e-7, 1e-5 * reach, 1e-9)
  const levels = amount < 0 ? [at, out] : [at]
  const pos: number[] = Array.from(positions.subarray(0, vertexCount * 3))
  for (let v = 0; v < vertexCount; v++) {
    for (const level of levels) {
      const d = place[v] - level
      if (d !== 0 && Math.abs(d) <= snap) {
        place[v] = level
        pos[v * 3] -= d * n[0]
        pos[v * 3 + 1] -= d * n[1]
        pos[v * 3 + 2] -= d * n[2]
      }
    }
  }

  let tris = indices
  let split = 0
  for (const level of levels) {
    const cut = splitAt(pos, place, tris, level)
    tris = cut.indices
    if (level === at) split = cut.split
  }

  // The triangles that move: those past the cut — one corner at least past
  // it, none short of it — or of those, the piece picked.
  const triCount = tris.length / 3
  const past = new Uint8Array(triCount)
  for (let t = 0; t < triCount; t++) {
    const a = place[tris[t * 3]], b = place[tris[t * 3 + 1]], c = place[tris[t * 3 + 2]]
    if (a >= at && b >= at && c >= at && (a > at || b > at || c > at)) past[t] = 1
  }
  const pieceAt = settings.piece ?? null
  const joined = piecesPast(place.length, tris, past)
  const moving = pieceAt ? pieceOf(pos, tris, past, joined.root, at, pieceAt, n, o, place.length) : past

  // Where the cut's rim is, on the side that stays.
  let centre: Vec3 | null = null
  {
    const seen = new Uint8Array(place.length)
    let cx = 0, cy = 0, cz = 0, k = 0
    for (let t = 0; t < triCount; t++) {
      if (!moving[t]) continue
      for (let j = 0; j < 3; j++) {
        const v = tris[t * 3 + j]
        if (place[v] !== at || seen[v]) continue
        seen[v] = 1
        cx += pos[v * 3]
        cy += pos[v * 3 + 1]
        cz += pos[v * 3 + 2]
        k++
      }
    }
    if (k > 0) centre = [cx / k, cy / k, cz / k]
  }

  // The outline: the edges on the cut between a triangle that moves and one
  // that stays, where the cross-section is — on the side that stays, and
  // lengthening, its copy moved out with the rest.
  const rimSegments: number[] = []
  {
    const fixedEdges = new Set<string>()
    for (let t = 0; t < triCount; t++) {
      if (moving[t]) continue
      for (let k = 0; k < 3; k++) {
        const a = tris[t * 3 + k], b = tris[t * 3 + ((k + 1) % 3)]
        if (place[a] === at && place[b] === at) fixedEdges.add(`${a}:${b}`)
      }
    }
    const shifts = amount > 0 ? [0, amount] : [0]
    for (let t = 0; t < triCount; t++) {
      if (!moving[t]) continue
      for (let k = 0; k < 3; k++) {
        const a = tris[t * 3 + k], b = tris[t * 3 + ((k + 1) % 3)]
        if (place[a] !== at || place[b] !== at || !fixedEdges.has(`${b}:${a}`)) continue
        for (const d of shifts) {
          for (const v of [a, b]) rimSegments.push(pos[v * 3] + d * n[0], pos[v * 3 + 1] + d * n[1], pos[v * 3 + 2] + d * n[2])
        }
      }
    }
  }

  const result = amount < 0
    ? shorten(pos, place, tris, moving, vertexCount, at, -amount, n, snap)
    : lengthen(pos, place, tris, moving, vertexCount, amount, n)

  let newMin = Infinity
  let newMax = -Infinity
  const p = result.positions
  for (let i = 0; i < result.indices.length; i++) {
    const v = result.indices[i] * 3
    const s = (p[v] - o[0]) * n[0] + (p[v + 1] - o[1]) * n[1] + (p[v + 2] - o[2]) * n[2]
    if (s < newMin) newMin = s
    if (s > newMax) newMax = s
  }
  return {
    ...result,
    rim: new Float32Array(rimSegments),
    report: {
      at,
      amount,
      extent: { min, max },
      newExtent: { min: newMin, max: newMax },
      centre,
      split,
      added: result.added,
      piece: Boolean(pieceAt),
      pieces: joined.count,
    },
  }
}

/**
 * Lengthened: the moving triangles' rim on the cut doubled, the copy moved
 * with them by `amount`, and each edge of the rim joined to its copy by two
 * triangles. With nothing to put in, the mesh as split.
 */
function lengthen(pos: number[], place: number[], tris: Uint32Array, moving: Uint8Array, vertexCount: number, amount: number, n: Vec3) {
  const total = place.length
  const triCount = tris.length / 3
  const movingVert = new Uint8Array(total)
  const fixedVert = new Uint8Array(total)
  for (let t = 0; t < triCount; t++) {
    const mark = moving[t] ? movingVert : fixedVert
    mark[tris[t * 3]] = mark[tris[t * 3 + 1]] = mark[tris[t * 3 + 2]] = 1
  }
  // The rim: points both sides use, each given a copy for the side moving.
  const copyOf = new Int32Array(total).fill(-1)
  let next = total
  if (amount > 0) {
    for (let v = 0; v < total; v++) {
      if (!movingVert[v] || !fixedVert[v]) continue
      copyOf[v] = next++
      pos.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2])
    }
  }
  // The rim's edges as the side that stays runs them.
  const fixedEdges = new Set<number>()
  if (amount > 0) {
    for (let t = 0; t < triCount; t++) {
      if (moving[t]) continue
      for (let k = 0; k < 3; k++) {
        const a = tris[t * 3 + k], b = tris[t * 3 + ((k + 1) % 3)]
        if (copyOf[a] >= 0 && copyOf[b] >= 0) fixedEdges.add(a * total + b)
      }
    }
  }
  const out: number[] = []
  const slab: number[] = []
  let added = 0
  for (let t = 0; t < triCount; t++) {
    const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2]
    if (!moving[t]) {
      out.push(a, b, c)
      slab.push(0)
      continue
    }
    const m = (v: number) => (copyOf[v] >= 0 ? copyOf[v] : v)
    out.push(m(a), m(b), m(c))
    slab.push(3)
    // Where an edge of it is on the rim, with the side that stays across
    // it: the section between the edge and its copy, wound so each of its
    // edges runs against its neighbour's.
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      if (copyOf[p] < 0 || copyOf[q] < 0 || !fixedEdges.has(q * total + p)) continue
      out.push(p, q, copyOf[q], p, copyOf[q], copyOf[p])
      slab.push(2, 2)
      added += 2
    }
  }
  const positions = new Float32Array(pos)
  if (amount !== 0) {
    for (let v = 0; v < next; v++) {
      const moves = v >= total || (movingVert[v] && copyOf[v] < 0 && !fixedVert[v])
      if (!moves) continue
      positions[v * 3] += amount * n[0]
      positions[v * 3 + 1] += amount * n[1]
      positions[v * 3 + 2] += amount * n[2]
    }
  }
  const vertexMap = new Int32Array(vertexCount)
  for (let v = 0; v < vertexCount; v++) vertexMap[v] = v
  return { positions, indices: Uint32Array.from(out), vertexMap, slab: Uint8Array.from(slab), added }
}

/**
 * Shortened by `by`: the moving triangles' points from the cut to `by` past
 * it laid on the cut, those further moved back by `by`, and the edges that
 * came to nothing collapsed — into the lower-numbered end — the triangles
 * on them dropped.
 */
function shorten(pos: number[], place: number[], tris: Uint32Array, moving: Uint8Array, vertexCount: number, at: number, by: number, n: Vec3, snap: number) {
  const total = place.length
  const triCount = tris.length / 3
  const moves = new Uint8Array(total)
  for (let t = 0; t < triCount; t++) if (moving[t]) moves[tris[t * 3]] = moves[tris[t * 3 + 1]] = moves[tris[t * 3 + 2]] = 1
  const onCut = new Uint8Array(total)
  for (let v = 0; v < total; v++) {
    if (!moves[v]) continue
    const s = place[v]
    const d = s <= at + by ? at - s : -by
    pos[v * 3] += d * n[0]
    pos[v * 3 + 1] += d * n[1]
    pos[v * 3 + 2] += d * n[2]
    if (s <= at + by) onCut[v] = 1
  }

  // The edges the flattening shrank to nothing, collapsed — each only where
  // the two points' neighbours are the edge's own two triangles' far
  // corners and no more, so the part stays a closed surface with no edge
  // shared three ways. What is left of the slab lies flat on the cut.
  const root = new Int32Array(total)
  for (let v = 0; v < total; v++) root[v] = v
  const find = (v: number): number => {
    while (root[v] !== v) {
      root[v] = root[root[v]]
      v = root[v]
    }
    return v
  }
  const corner = Uint32Array.from(tris)
  const alive = new Uint8Array(triCount).fill(1)
  const around = new Map<number, number[]>()
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const v = corner[t * 3 + k]
      if (!onCut[v]) continue
      const list = around.get(v)
      if (list) list.push(t)
      else around.set(v, [t])
    }
  }
  const neighbours = (v: number): Set<number> => {
    const out = new Set<number>()
    for (const t of around.get(v) ?? []) {
      if (!alive[t]) continue
      for (let k = 0; k < 3; k++) if (corner[t * 3 + k] !== v) out.add(corner[t * 3 + k])
    }
    return out
  }
  const near = (a: number, b: number) => {
    const dx = pos[a * 3] - pos[b * 3], dy = pos[a * 3 + 1] - pos[b * 3 + 1], dz = pos[a * 3 + 2] - pos[b * 3 + 2]
    return dx * dx + dy * dy + dz * dz <= snap * snap
  }
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      if (!alive[t]) break
      const p = corner[t * 3 + k], q = corner[t * 3 + ((k + 1) % 3)]
      if (!onCut[p] || !onCut[q] || p === q || !near(p, q)) continue
      // Keep the lower number.
      const [u, v] = p < q ? [p, q] : [q, p]
      const nu = neighbours(u)
      const nv = neighbours(v)
      const both: number[] = []
      for (const w of (around.get(v) ?? [])) {
        if (!alive[w]) continue
        const c = [corner[w * 3], corner[w * 3 + 1], corner[w * 3 + 2]]
        if (c.includes(u)) both.push(c.find((x) => x !== u && x !== v)!)
      }
      let shared = 0
      for (const w of nu) if (nv.has(w)) shared++
      if (shared !== both.length || both.some((w) => !nu.has(w) || !nv.has(w))) continue
      // v into u: its triangles on the edge go, the rest take u.
      const list = around.get(u)!
      for (const w of around.get(v) ?? []) {
        if (!alive[w]) continue
        let hasU = false
        for (let j = 0; j < 3; j++) if (corner[w * 3 + j] === u) hasU = true
        if (hasU) {
          alive[w] = 0
          continue
        }
        for (let j = 0; j < 3; j++) if (corner[w * 3 + j] === v) corner[w * 3 + j] = u
        list.push(w)
      }
      around.delete(v)
      root[v] = u
    }
  }

  const out: number[] = []
  const slab: number[] = []
  for (let t = 0; t < triCount; t++) {
    if (!alive[t]) continue
    const a = corner[t * 3], b = corner[t * 3 + 1], c = corner[t * 3 + 2]
    out.push(a, b, c)
    slab.push(!moving[t] ? 0 : onCut[a] && onCut[b] && onCut[c] ? 2 : 3)
  }
  const compact = compactEdit(new Float32Array(pos), Uint32Array.from(out), vertexCount)
  // A point joined into another goes where that one went.
  const vertexMap = new Int32Array(vertexCount)
  for (let v = 0; v < vertexCount; v++) {
    const r = find(v)
    vertexMap[v] = r < vertexCount ? compact.vertexMap[r] : -1
  }
  return { positions: compact.positions, indices: compact.indices, vertexMap, slab: Uint8Array.from(slab), added: 0 }
}

/**
 * The triangles split where they cross the plane at `level` along the
 * direction: each one the plane goes through is cut into the part short of
 * it and the part past it, the corners made on the plane shared by the
 * triangles either side of the edge they are on. Their places and positions
 * go on the end of `place` and `pos`.
 */
function splitAt(pos: number[], place: number[], indices: Uint32Array, level: number): { indices: Uint32Array; split: number } {
  const sideOf = (v: number) => (place[v] < level ? -1 : place[v] > level ? 1 : 0)
  const crossings = new Map<string, number>()
  const crossing = (p: number, q: number): number => {
    const key = p < q ? `${p}:${q}` : `${q}:${p}`
    const known = crossings.get(key)
    if (known !== undefined) return known
    const t = (level - place[p]) / (place[q] - place[p])
    const id = place.length
    for (let k = 0; k < 3; k++) pos.push(pos[p * 3 + k] + t * (pos[q * 3 + k] - pos[p * 3 + k]))
    place.push(level)
    crossings.set(key, id)
    return id
  }
  const out: number[] = []
  const short: number[] = []
  const past: number[] = []
  let split = 0
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2]
    const sa = sideOf(a), sb = sideOf(b), sc = sideOf(c)
    if ((sa <= 0 && sb <= 0 && sc <= 0) || (sa >= 0 && sb >= 0 && sc >= 0)) {
      out.push(a, b, c)
      continue
    }
    split++
    // Round the triangle, each corner to the side or sides it is on and a
    // corner made wherever an edge crosses: two polygons, each wound as the
    // triangle was, and each convex — fanned from its first corner.
    short.length = 0
    past.length = 0
    const corners = [a, b, c]
    const sides = [sa, sb, sc]
    for (let k = 0; k < 3; k++) {
      const p = corners[k], q = corners[(k + 1) % 3]
      const sp = sides[k], sq = sides[(k + 1) % 3]
      if (sp <= 0) short.push(p)
      if (sp >= 0) past.push(p)
      if (sp * sq < 0) {
        const x = crossing(p, q)
        short.push(x)
        past.push(x)
      }
    }
    for (const poly of [short, past]) for (let k = 1; k + 1 < poly.length; k++) out.push(poly[0], poly[k], poly[k + 1])
  }
  return { indices: Uint32Array.from(out), split }
}

/** The pieces the triangles past the cut fall into, by the vertices they
 *  share: each vertex's piece, and how many there are. */
function piecesPast(total: number, tris: Uint32Array, past: Uint8Array): { root: (v: number) => number; count: number } {
  const parent = new Int32Array(total)
  for (let v = 0; v < total; v++) parent[v] = v
  const root = (v: number): number => {
    while (parent[v] !== v) {
      parent[v] = parent[parent[v]]
      v = parent[v]
    }
    return v
  }
  for (let t = 0; t < past.length; t++) {
    if (!past[t]) continue
    const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2]
    parent[root(b)] = root(a)
    parent[root(c)] = root(a)
  }
  const roots = new Set<number>()
  for (let t = 0; t < past.length; t++) if (past[t]) roots.add(root(tris[t * 3]))
  return { root, count: roots.size }
}

/**
 * Of the triangles past the cut, the piece the point `at` picked: the part
 * joined to the vertex nearest the point's foot on the cut — so a point
 * picked anywhere along a leg picks that leg. A triangle lying in the cut
 * is not past it, and joins nothing.
 */
function pieceOf(
  pos: number[],
  tris: Uint32Array,
  past: Uint8Array,
  root: (v: number) => number,
  cut: number,
  at: Vec3,
  n: Vec3,
  o: Vec3,
  total: number,
): Uint8Array {
  const triCount = tris.length / 3
  const inPart = new Uint8Array(total)
  for (let t = 0; t < triCount; t++) if (past[t]) inPart[tris[t * 3]] = inPart[tris[t * 3 + 1]] = inPart[tris[t * 3 + 2]] = 1
  const s = (at[0] - o[0]) * n[0] + (at[1] - o[1]) * n[1] + (at[2] - o[2]) * n[2]
  const foot: Vec3 = [at[0] + (cut - s) * n[0], at[1] + (cut - s) * n[1], at[2] + (cut - s) * n[2]]
  let seed = -1
  let best = Infinity
  for (let v = 0; v < total; v++) {
    if (!inPart[v]) continue
    const dx = pos[v * 3] - foot[0], dy = pos[v * 3 + 1] - foot[1], dz = pos[v * 3 + 2] - foot[2]
    const d = dx * dx + dy * dy + dz * dz
    if (d < best) {
      best = d
      seed = v
    }
  }
  if (seed < 0) throw new Error('Nothing of the part lies past the cut there — pick the piece to stretch.')
  const piece = root(seed)
  const moving = new Uint8Array(triCount)
  for (let t = 0; t < triCount; t++) if (past[t] && root(tris[t * 3]) === piece) moving[t] = 1
  return moving
}

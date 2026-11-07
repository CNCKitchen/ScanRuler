// SPDX-License-Identifier: AGPL-3.0-only
// A body's edges drawn along its own triangles. The kernel samples an edge
// for drawing by itself (kernel.ts edges) and meshes the faces beside it by
// themselves, and the two meet only at some of their points: between them
// a line over a round face dips under the shading by up to a chord's sag
// and is drawn in dashes. The faces' meshes do agree with one another —
// the kernel puts the nodes along an edge once and both faces take them —
// so the lines are taken off the faces instead: a side of a triangle that
// no other triangle has is on its face's outline, and is the edge's chord
// exactly as the faces have it. Drawn there, a line lies on the surface
// all along, and the faces' polygon offset alone keeps it in front of
// them: nothing is drawn nearer the camera than it is, so nothing hidden
// just behind a rim shows through it.
//
// Not every outline is an edge of the part's shape. A round face that goes
// the whole way round meets itself along a seam, which the kernel needs
// where the face's parameters start over and a CAD system on another
// kernel does not have; and a face a boolean cut in two where it lay on
// one surface is two faces, with an edge between them where the part is
// one smooth surface. Neither is drawn, as no CAD system draws them. A
// tangent edge — a round running into a flat — is a real edge of the
// shape, drawn, dimmed or left out as the operator sets it, the choice
// Onshape and SolidWorks offer. How the faces meet is read off the mesh:
// the faces either side of an outline side each have their own vertices
// there, carrying each face's own surface normal turned outward
// (kernel.ts surfaceNormals), so a side whose partner is of the same face
// is a seam and one whose normals agree with its partner's is tangent.

/** An edge as the drawing needs it — EdgeInfo's fields. */
export interface OutlinedEdge {
  hash: number
  faces: readonly number[]
  polyline: Float32Array
}

/** How the faces either side of an edge meet: at an angle (`sharp`);
 *  smoothly, one surface running into another (`tangent`); smoothly on one
 *  surface cut in two faces (`split`); or one face meeting itself where it
 *  closes round (`seam`). The last two are drawn by no CAD system. */
export type EdgeJoin = 'sharp' | 'tangent' | 'split' | 'seam'

/** How the tangent edges are drawn: as the sharp ones, fainter, or not at
 *  all — then a round's outline is its silhouette. */
export type TangentEdges = 'visible' | 'dimmed' | 'removed'

const JOINS: readonly EdgeJoin[] = ['sharp', 'tangent', 'split', 'seam']
const SHARP = 0
const TANGENT = 1
const SPLIT = 2
const SEAM = 3

/** Two faces whose normals agree this closely at both ends of a side meet
 *  tangent there. A round or a tangent relation is out by far less; a
 *  draft of half a degree is an edge to see. */
const TANGENT_COS = Math.cos((0.25 * Math.PI) / 180)

/** Whether two faces, by hash, lie on one surface — see topo.ts
 *  onOneSurface. */
export type OneSurface = (a: number, b: number) => boolean

/** Every side of the triangles that one triangle alone has, as triples:
 *  its two vertices and the triangle. The kernel gives each face vertices
 *  of its own, so no side is shared across an edge and these are the
 *  faces' outlines — every edge of the body, a periodic face's seam among
 *  them (its two sides are different vertices in one place). A side with
 *  no length — the pole of a sphere — is left out. */
function outlineSides(positions: ArrayLike<number>, indices: ArrayLike<number>): number[] {
  const n = positions.length / 3
  // A side by its two vertices, the lower first: the triangle that has it,
  // or -1 once a second one does.
  const owner = new Map<number, number>()
  const triangles = Math.floor(indices.length / 3)
  for (let t = 0; t < triangles; t++) {
    for (let k = 0; k < 3; k++) {
      const a = indices[t * 3 + k]
      const b = indices[t * 3 + ((k + 1) % 3)]
      const key = a < b ? a * n + b : b * n + a
      owner.set(key, owner.has(key) ? -1 : t)
    }
  }
  const out: number[] = []
  for (const [key, t] of owner) {
    if (t < 0) continue
    const a = Math.floor(key / n)
    const b = key - a * n
    if (positions[a * 3] === positions[b * 3] && positions[a * 3 + 1] === positions[b * 3 + 1] && positions[a * 3 + 2] === positions[b * 3 + 2]) continue
    out.push(a, b, t)
  }
  return out
}

/** A side by where it lies, either way round — the faces on either side of
 *  an edge have the same nodes there, each in its own vertices. */
function placeKey(positions: ArrayLike<number>, a: number, b: number): string {
  const at = (v: number) => `${Math.round(positions[v * 3] * 1e5)},${Math.round(positions[v * 3 + 1] * 1e5)},${Math.round(positions[v * 3 + 2] * 1e5)}`
  const ka = at(a)
  const kb = at(b)
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`
}

function pushSide(out: number[], positions: ArrayLike<number>, a: number, b: number): void {
  out.push(positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2], positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2])
}

const distance2 = (p: ArrayLike<number>, a: number, b: number) => (p[a * 3] - p[b * 3]) ** 2 + (p[a * 3 + 1] - p[b * 3 + 1]) ** 2 + (p[a * 3 + 2] - p[b * 3 + 2]) ** 2
const normalsCos = (n: ArrayLike<number>, a: number, b: number) => n[a * 3] * n[b * 3] + n[a * 3 + 1] * n[b * 3 + 1] + n[a * 3 + 2] * n[b * 3 + 2]

/** The outline sides (outlineSides' triples), each one's place and how the
 *  faces meet there, and the sides at each place. */
interface Sides {
  sides: number[]
  keys: string[]
  /** Each side's join, an index into JOINS. */
  joins: Uint8Array
  places: Map<string, number[]>
}

/**
 * The outline sides, each with how the faces meet along it, from the side
 * of the face across that lies in the same place: of the same face, a
 * seam; with the normals at both ends agreeing, tangent — or a split where
 * `oneSurface` says the two faces lie on one surface; else sharp. A side
 * with no partner (an open edge of a sheet) or more than one is sharp.
 * Without the triangles' faces a seam is not told from a tangent side, and
 * without normals every side but a seam is sharp.
 */
function readSides(positions: ArrayLike<number>, normals: ArrayLike<number> | null, indices: ArrayLike<number>, faceHash: ArrayLike<number> | null, oneSurface?: OneSurface, tangentCos = TANGENT_COS): Sides {
  const sides = outlineSides(positions, indices)
  const count = sides.length / 3
  const keys = new Array<string>(count)
  const places = new Map<string, number[]>()
  for (let s = 0; s < count; s++) {
    const key = placeKey(positions, sides[s * 3], sides[s * 3 + 1])
    keys[s] = key
    const list = places.get(key)
    if (list) list.push(s)
    else places.set(key, [s])
  }
  const joins = new Uint8Array(count)
  for (const list of places.values()) {
    if (list.length !== 2) continue
    const [s, t] = list
    const fs = faceHash ? faceHash[sides[s * 3 + 2]] : null
    const ft = faceHash ? faceHash[sides[t * 3 + 2]] : null
    let join = SHARP
    if (fs !== null && fs === ft) join = SEAM
    else if (normals) {
      const a = sides[s * 3]
      const b = sides[s * 3 + 1]
      // The partner's vertices at a's place and at b's.
      let ta = sides[t * 3]
      let tb = sides[t * 3 + 1]
      if (distance2(positions, a, ta) > distance2(positions, a, tb)) [ta, tb] = [tb, ta]
      if (normalsCos(normals, a, ta) >= tangentCos && normalsCos(normals, b, tb) >= tangentCos) join = oneSurface && fs !== null && ft !== null && oneSurface(fs, ft) ? SPLIT : TANGENT
    }
    joins[s] = join
    joins[t] = join
  }
  return { sides, keys, joins, places }
}

/** The faces' outlines as segments, XYZ XYZ each, every place once: all of
 *  the body's edges as its faces were meshed, seams and splits too. */
export function outlineSegments(positions: ArrayLike<number>, indices: ArrayLike<number>): Float32Array {
  const sides = outlineSides(positions, indices)
  const seen = new Set<string>()
  const out: number[] = []
  for (let i = 0; i < sides.length; i += 3) {
    const key = placeKey(positions, sides[i], sides[i + 1])
    if (seen.has(key)) continue
    seen.add(key)
    pushSide(out, positions, sides[i], sides[i + 1])
  }
  return new Float32Array(out)
}

/** The lines a body is drawn with at rest, as segments (XYZ XYZ each),
 *  every place once: its sharp edges and its tangent ones apart, for the
 *  tangent ones to be drawn as the operator sets. Seams and splits are
 *  left out. */
export function restSegments(positions: ArrayLike<number>, normals: ArrayLike<number>, indices: ArrayLike<number>, faceHash: ArrayLike<number> | null, oneSurface?: OneSurface): { sharp: Float32Array; tangent: Float32Array } {
  const { sides, joins, places } = readSides(positions, normals, indices, faceHash, oneSurface)
  const sharp: number[] = []
  const tangent: number[] = []
  for (const [s] of places.values()) {
    const join = joins[s]
    if (join === SHARP) pushSide(sharp, positions, sides[s * 3], sides[s * 3 + 1])
    else if (join === TANGENT) pushSide(tangent, positions, sides[s * 3], sides[s * 3 + 1])
  }
  return { sharp: new Float32Array(sharp), tangent: new Float32Array(tangent) }
}

/** The squared distance from a point to a polyline, or `limit` once it is
 *  plain that it is no nearer. */
function polylineDistance2(p: Float32Array, x: number, y: number, z: number, limit: number): number {
  let best = limit
  for (let i = 0; i + 5 < p.length; i += 3) {
    const ax = p[i], ay = p[i + 1], az = p[i + 2]
    const dx = p[i + 3] - ax, dy = p[i + 4] - ay, dz = p[i + 5] - az
    const ll = dx * dx + dy * dy + dz * dz
    let t = ll > 0 ? ((x - ax) * dx + (y - ay) * dy + (z - az) * dz) / ll : 0
    t = t < 0 ? 0 : t > 1 ? 1 : t
    const ex = ax + dx * t - x, ey = ay + dy * t - y, ez = az + dz * t - z
    const d = ex * ex + ey * ey + ez * ez
    if (d < best) best = d
  }
  return best
}

/** A polyline as segments, XYZ XYZ each. */
function polylineSegments(p: Float32Array): Float32Array {
  const out = new Float32Array(Math.max(0, p.length - 3) * 2)
  for (let i = 0, o = 0; i + 5 < p.length; i += 3, o += 6) out.set(p.subarray(i, i + 6), o)
  return out
}

/** Each edge's share of the outlines and how the faces meet along it, by
 *  the edge's hash. */
export interface EdgeShares {
  /** Its share as segments, XYZ XYZ each. */
  segments: Map<number, Float32Array>
  /** What most of its share says; an edge given no share is sharp. */
  joins: Map<number, EdgeJoin>
}

/**
 * Each edge's share of the faces' outlines and how its faces meet: an
 * outline side goes to the edge of its face — by the triangle's face hash
 * — whose sampled polyline passes nearest the side's middle. An edge given
 * no side keeps its polyline, cut into segments, and is taken for sharp.
 * `tangentCos`: how closely the normals agree for a tangent join — a
 * quarter of a degree, as the viewport draws, by default.
 */
export function edgeShares(positions: ArrayLike<number>, normals: ArrayLike<number> | null, indices: ArrayLike<number>, faceHash: ArrayLike<number>, edges: readonly OutlinedEdge[], oneSurface?: OneSurface, tangentCos = TANGENT_COS): EdgeShares {
  // The edges round each face, each with the box round its polyline — a
  // face with many edges passes over most of them on the box alone.
  interface Candidate { hash: number; p: Float32Array; lo: [number, number, number]; hi: [number, number, number] }
  const round = new Map<number, Candidate[]>()
  for (const e of edges) {
    const p = e.polyline
    if (p.length < 6) continue
    const lo: [number, number, number] = [Infinity, Infinity, Infinity]
    const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i + 2 < p.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        if (p[i + k] < lo[k]) lo[k] = p[i + k]
        if (p[i + k] > hi[k]) hi[k] = p[i + k]
      }
    }
    const c = { hash: e.hash, p, lo, hi }
    for (const f of new Set(e.faces)) {
      const list = round.get(f)
      if (list) list.push(c)
      else round.set(f, [c])
    }
  }
  const { sides, keys, joins } = readSides(positions, normals, indices, faceHash, oneSurface, tangentCos)
  const taken = new Map<number, number[]>()
  // Each edge's sides counted by join.
  const votes = new Map<number, number[]>()
  const seen = new Set<string>()
  for (let s = 0; s < keys.length; s++) {
    const candidates = round.get(faceHash[sides[s * 3 + 2]])
    if (!candidates) continue
    const a = sides[s * 3] * 3
    const b = sides[s * 3 + 1] * 3
    const mx = (positions[a] + positions[b]) / 2
    const my = (positions[a + 1] + positions[b + 1]) / 2
    const mz = (positions[a + 2] + positions[b + 2]) / 2
    let best = Infinity
    let which: number | null = null
    for (const c of candidates) {
      const bx = Math.max(c.lo[0] - mx, 0, mx - c.hi[0])
      const by = Math.max(c.lo[1] - my, 0, my - c.hi[1])
      const bz = Math.max(c.lo[2] - mz, 0, mz - c.hi[2])
      if (bx * bx + by * by + bz * bz >= best) continue
      const d = polylineDistance2(c.p, mx, my, mz, best)
      if (d < best) {
        best = d
        which = c.hash
      }
    }
    if (which === null) continue
    let count = votes.get(which)
    if (!count) votes.set(which, (count = [0, 0, 0, 0]))
    count[joins[s]]++
    const key = `${which}:${keys[s]}`
    if (seen.has(key)) continue
    seen.add(key)
    let out = taken.get(which)
    if (!out) taken.set(which, (out = []))
    pushSide(out, positions, sides[s * 3], sides[s * 3 + 1])
  }
  const segments = new Map<number, Float32Array>()
  const joinOf = new Map<number, EdgeJoin>()
  for (const e of edges) {
    const own = taken.get(e.hash)
    if (own) segments.set(e.hash, new Float32Array(own))
    else if (e.polyline.length >= 6) segments.set(e.hash, polylineSegments(e.polyline))
    const count = votes.get(e.hash)
    // A tie goes to the join drawn the plainest: sharp before tangent.
    joinOf.set(e.hash, count ? JOINS[count.indexOf(Math.max(...count))] : 'sharp')
  }
  return { segments, joins: joinOf }
}

/** Each edge's share of the faces' outlines, as segments (XYZ XYZ each),
 *  by the edge's hash — edgeShares' segments. */
export function edgeSegments(positions: ArrayLike<number>, indices: ArrayLike<number>, faceHash: ArrayLike<number>, edges: readonly OutlinedEdge[]): Map<number, Float32Array> {
  return edgeShares(positions, null, indices, faceHash, edges).segments
}

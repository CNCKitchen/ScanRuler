// SPDX-License-Identifier: AGPL-3.0-only
// Faces and edges picked by a query (Where) — every face or edge of a body
// that answers its terms: a box, a point it runs through, a kind, a size,
// the feature that made it, the faces either side. The commands run it on
// the topology of the build as it stands; a feature given one keeps it
// (StoredWhere, beside the fingerprints of what it found), and the builder
// runs it again on the body as it stands before the feature, so a sketch
// redrawn under a round still rounds the edges the query names — a fifth
// side's too. The fingerprints are the fallback, for a query that finds
// nothing on the part as it stands, and for a project saved before.
//
// Here, not in the commands, because the build runs in the worker: what
// the commands read off the page — the feature a madeBy names, how faces
// meet along an edge (sharp) — is asked of the caller (WhereAsk).

import { CommandError } from '../../../src/commands/types'
import type { Vec3 } from '../../../src/core/types'
import type { EdgeInfo, FaceInfo } from './buildTypes'
import { type EdgeFingerprint, type FaceFingerprint, matchEdge, matchFace, type MatchTolerance } from './topo'

const invalid = (text: string): never => {
  throw new CommandError('invalid_input', text)
}

/** A feature as a query names it: by name or by id. */
type FeatureRef = number | string

/** The faces and edges a query is run on. */
export interface WhereTopology {
  faces: readonly FaceInfo[]
  edges: readonly EdgeInfo[]
}

/** What faces and edges are asked for, of all a body has. */
export interface Where {
  box?: { min: Vec3; max: Vec3 }
  near?: { at: Vec3; radius: number }
  /** Edges whose curve passes within `within` mm (0.01 by default) of
   *  the point, anywhere along them. */
  through?: { at: Vec3; within?: number }
  kind?: string
  between?: Vec3[]
  withinDeg?: number
  madeBy?: FeatureRef
  minLength?: number
  maxLength?: number
  minArea?: number
  maxArea?: number
  radius?: number
  diameter?: number
  sizeWithin?: number
  /** The two faces either side of an edge, by their index in
   *  reverse.body.describe; for a face query, those faces. */
  faces?: number[]
  /** What answers all the rest less these: another query, or indices. */
  exclude?: Where | number[]
  /** With faces: [i] on an edge query — the edges of face i's outer
   *  boundary, or those round its holes. */
  loop?: 'outer' | 'inner'
  /** Circle edges, and round faces, whose axis lies on this line within
   *  `within` mm (0.05 by default), parallel within a degree. */
  coaxial?: { at: Vec3; dir: Vec3; within?: number }
  /** A pick that may name nothing: it then adds nothing, and the
   *  answer's picked says which missed, in place of the change failing. */
  optional?: boolean
  /** Only edges whose two faces meet at an angle — not tangent, as a
   *  round's seams meet the faces either side. */
  sharp?: boolean
  /** With sharp: the angle the faces must meet at, degrees — SHARP_DEG
   *  by default. Given alone it asks sharp too. */
  sharpDeg?: number
  /** Edges between a face one feature made and a face another made —
   *  the roots where a pattern's blades meet the dish. */
  sides?: { madeBy: FeatureRef[] }
  /** The same terms wrapped once more, as reverse.body.describe's input
   *  holds them — taken as the query itself (unwrapped). */
  where?: Where
}

/** What a query asks of where it is run. */
export interface WhereAsk {
  /** The id of the feature a madeBy names — refused where none is. */
  featureId: (ref: FeatureRef) => number
  /** Whether an edge, by its index, runs between faces that meet at more
   *  than `deg` degrees — what sharp keeps; null where that cannot be read
   *  here. */
  sharp: (deg: number) => ((i: number) => boolean) | null
}

/** The angle, degrees, two faces meet at for sharp to keep their edge by
 *  default: a profile fitted to a drawing's points or a scan meets the
 *  faces either side a few tenths of a degree off tangent, and is no edge
 *  to round. The viewport draws an edge from a quarter of a degree. */
export const SHARP_DEG = 1

/** A pick that is a query — every face or edge that answers it — rather
 *  than an index or a fingerprint: an object with no fingerprint's place
 *  in it. */
export const isWhere = (pick: unknown): pick is Where => typeof pick === 'object' && pick !== null && !('mid' in pick) && !('centroid' in pick)

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A pick or a query given wrapped — { where: { sides: … } }, as
 *  reverse.body.describe takes it — as the query itself, with any terms
 *  beside where kept; refused where a term stands both in it and beside
 *  it. A pick as it came otherwise. */
export function unwrapped<T>(pick: T, what: 'face' | 'edge'): T {
  if (!isPlain(pick) || !('where' in pick)) return pick
  const { where, ...rest } = pick
  const written = what === 'edge' ? 'edges: [{ sides: { madeBy: [...] } }]' : 'faces: [{ madeBy: … }]'
  if (!isPlain(where)) return invalid(`A ${what} pick is the query itself — ${written} — and where in it is ${JSON.stringify(where)}, no query.`)
  const twice = Object.keys(rest).filter((k) => k in where)
  if (twice.length) invalid(`A ${what} pick is the query itself — ${written} — and ${twice.join(', ')} stand${twice.length === 1 ? 's' : ''} both in where and beside it: give each once, with no where.`)
  return unwrapped({ ...rest, ...where } as T, what)
}

/** How far off parallel a coaxial pick's axis may lean, radians. */
const COAXIAL_ANGLE = Math.PI / 180

/** How far a coaxial pick's axis may stand off the line unless told, mm. */
const COAXIAL_MM = 0.05

/** How far a point lies from the line through `at` along `dir`. */
function offLine(p: Vec3, at: Vec3, dir: Vec3): number {
  const l = Math.hypot(dir[0], dir[1], dir[2]) || 1
  const d: Vec3 = [p[0] - at[0], p[1] - at[1], p[2] - at[2]]
  const c: Vec3 = [d[1] * dir[2] - d[2] * dir[1], d[2] * dir[0] - d[0] * dir[2], d[0] * dir[1] - d[1] * dir[0]]
  return Math.hypot(c[0], c[1], c[2]) / l
}

const parallel = (a: Vec3, b: Vec3) => {
  const t = angleBetween(a, b)
  return Math.min(t, Math.PI - t) <= COAXIAL_ANGLE
}

/** Whether a round face's axis lies on the query's line: a cylinder's,
 *  cone's or torus's axis along it, a sphere's centre on it. */
function faceCoaxial(f: FaceInfo, c: NonNullable<Where['coaxial']>): boolean {
  const fp = f.fingerprint
  const within = c.within ?? COAXIAL_MM
  if (!fp.center) return false
  if (fp.kind === 'sphere') return offLine(fp.center, c.at, c.dir) <= within
  if (fp.kind !== 'cylinder' && fp.kind !== 'cone' && fp.kind !== 'torus') return false
  return parallel(fp.dir, c.dir) && offLine(fp.center, c.at, c.dir) <= within
}

/** Whether a circle edge winds round the query's line: square to it, and
 *  every point of it its radius off it — three points of a circle in a
 *  plane square to the line, equally far from it, put its centre on it. */
function edgeCoaxial(e: EdgeInfo, c: NonNullable<Where['coaxial']>): boolean {
  const fp = e.fingerprint
  if (fp.kind !== 'circle' || fp.radius === undefined || !parallel(fp.dir, c.dir)) return false
  const within = c.within ?? COAXIAL_MM
  const points: Vec3[] = [fp.mid, e.ends[0], e.ends[1]]
  const n = e.polyline.length / 3
  for (const k of [0.25, 0.5, 0.75]) {
    const i = Math.floor(k * (n - 1))
    if (n > 2) points.push([e.polyline[3 * i], e.polyline[3 * i + 1], e.polyline[3 * i + 2]])
  }
  return points.every((p) => Math.abs(offLine(p, c.at, c.dir) - fp.radius!) <= within)
}

/** Whether an edge runs round a round face on the query's line — one of
 *  `rounds`, the faces faceCoaxial takes, by hash: a bore's rim where it
 *  meets a curved face is no circle, but it bounds the bore. Not its seam,
 *  the bore's own face on both sides, nor a straight side of a part round,
 *  which runs along the axis, not round it. */
function edgeRoundsCoaxial(e: EdgeInfo, rounds: ReadonlySet<number>): boolean {
  const faces = new Set(e.faces)
  return e.fingerprint.kind !== 'line' && faces.size === 2 && [...faces].some((h) => rounds.has(h))
}

/** The edges of a flat face's boundary, as loops: the edges round it
 *  joined end to end, the loop whose extent in the face's plane holds the
 *  others' the outer one, the rest round its holes. By index. */
function faceLoops(t: WhereTopology, faceIndex: number, body: { name: string }): { outer: number[]; inner: number[] } {
  const face = t.faces[faceIndex]
  if (!face) throw new CommandError('not_found', `${body.name} has no face ${faceIndex} — it has ${t.faces.length}; reverse.body.describe lists them.`)
  const fp = face.fingerprint
  if (fp.kind !== 'plane') invalid(`loop reads a flat face’s boundary — face ${faceIndex} of ${body.name} is a ${fp.kind}.`)
  const edges = t.edges.flatMap((e, i) => (e.faces.includes(face.hash) ? [i] : []))
  // Joined end to end: ends within a micron are one point.
  const parent = edges.map((_, k) => k)
  const root = (k: number): number => (parent[k] === k ? k : (parent[k] = root(parent[k])))
  const near = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= 1e-3
  for (let a = 0; a < edges.length; a++)
    for (let b = a + 1; b < edges.length; b++) {
      const ea = t.edges[edges[a]].ends, eb = t.edges[edges[b]].ends
      if (ea.some((p) => eb.some((q) => near(p, q)))) parent[root(a)] = root(b)
    }
  const loops = new Map<number, number[]>()
  edges.forEach((i, k) => (loops.get(root(k)) ?? loops.set(root(k), []).get(root(k))!).push(i))
  // Each loop's extent in the face's plane.
  const n = fp.dir
  const u = Math.abs(n[0]) < 0.9 ? [0, -n[2], n[1]] : [-n[2], 0, n[0]]
  const ul = Math.hypot(u[0], u[1], u[2]) || 1
  const U: Vec3 = [u[0] / ul, u[1] / ul, u[2] / ul]
  const V: Vec3 = [n[1] * U[2] - n[2] * U[1], n[2] * U[0] - n[0] * U[2], n[0] * U[1] - n[1] * U[0]]
  const extent = (loop: number[]) => {
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity
    const take = (p: ArrayLike<number>, o = 0) => {
      const a = p[o] * U[0] + p[o + 1] * U[1] + p[o + 2] * U[2]
      const b = p[o] * V[0] + p[o + 1] * V[1] + p[o + 2] * V[2]
      u0 = Math.min(u0, a), u1 = Math.max(u1, a), v0 = Math.min(v0, b), v1 = Math.max(v1, b)
    }
    for (const i of loop) {
      const e = t.edges[i]
      for (let o = 0; o + 2 < e.polyline.length; o += 3) take(e.polyline, o)
      take(e.ends[0]), take(e.ends[1]), take(e.fingerprint.mid)
    }
    return (u1 - u0) * (v1 - v0)
  }
  const ranked = [...loops.values()].map((l) => ({ l, size: extent(l) })).sort((a, b) => b.size - a.size)
  return { outer: ranked[0]?.l ?? [], inner: ranked.slice(1).flatMap((r) => r.l) }
}

/** Whether an edge, by its index, runs between a face the one feature made
 *  and a face the other made, either way round — both the one feature's,
 *  where it is named twice. A pattern's copies count as made by what made
 *  the faces they copy. */
function sidesMadeBy(sides: NonNullable<Where['sides']>, t: WhereTopology, ask: WhereAsk): (i: number) => boolean {
  if (!Array.isArray(sides.madeBy) || sides.madeBy.length !== 2 || !sides.madeBy.every((r) => typeof r === 'string' || typeof r === 'number')) invalid('sides.madeBy names two features: the edges between a face of the one and a face of the other ({ madeBy: ["Blade", "Dish"] }).')
  const [a, b] = sides.madeBy.map((r) => ask.featureId(r))
  const origin = new Map(t.faces.map((f) => [f.hash, f.fingerprint.origin]))
  return (i) => {
    const faces = [...new Set(t.edges[i].faces)]
    const [p, q] = faces.length === 1 ? [faces[0], faces[0]] : faces
    if (faces.length > 2 || p === undefined) return false
    const [x, y] = [origin.get(p), origin.get(q)]
    return (x === a && y === b) || (x === b && y === a)
  }
}

/** The indices of a body's faces, or edges, a query names — every term
 *  held to, its loop read off the face named, less what it excludes. */
export function whereIndices(given: Where, t: WhereTopology, body: { name: string }, what: 'face' | 'edge', ask: WhereAsk): number[] {
  const w = unwrapped(given, what)
  const madeBy = w.madeBy !== undefined ? ask.featureId(w.madeBy) : null
  const sides = sidesOf(w, t.faces, body)
  let hits: number[]
  if (what === 'face') {
    if (w.sides) invalid('sides picks edges — those between faces two features made; for faces give madeBy.')
    // A loop is of edges: the face it names stands for itself here.
    hits = t.faces.flatMap((f, i) => (facePasses(f, w, madeBy, sides) ? [i] : []))
  } else {
    let inLoop: Set<number> | null = null
    if (w.loop) {
      if (w.faces?.length !== 1) invalid('loop reads one face’s boundary — give that face alone in faces ({ faces: [i], loop: "outer" }).')
      const loops = faceLoops(t, w.faces![0], body)
      inLoop = new Set(w.loop === 'outer' ? loops.outer : loops.inner)
    }
    // Coaxial: the round faces on the line too, whose edges round it are.
    const rounds = w.coaxial ? new Set(t.faces.filter((f) => faceCoaxial(f, w.coaxial!)).map((f) => f.hash)) : undefined
    hits = t.edges.flatMap((e, i) => ((!inLoop || inLoop.has(i)) && edgePasses(e, w, madeBy, sides, rounds) ? [i] : []))
    if (w.sides) hits = hits.filter(sidesMadeBy(w.sides, t, ask))
    // Sharp: only the edges whose faces meet at an angle — not a round's
    // seams, which match a radius as the edge it rounded did.
    if (w.sharp || w.sharpDeg !== undefined) {
      const sharp = ask.sharp(w.sharpDeg ?? SHARP_DEG)
      if (!sharp) invalid(`sharp reads how the faces meet off ${body.name}’s mesh, and there is none for it here — pick without sharp, by through or near.`)
      hits = hits.filter((i) => sharp!(i))
    }
  }
  if (w.exclude !== undefined) {
    const gone = new Set(Array.isArray(w.exclude) ? w.exclude : whereIndices(w.exclude, t, body, what, ask))
    hits = hits.filter((i) => !gone.has(i))
  }
  return hits
}

const angleBetween =(a: Vec3, b: Vec3): number => {
  const la = Math.hypot(a[0], a[1], a[2]), lb = Math.hypot(b[0], b[1], b[2])
  if (!(la > 0 && lb > 0)) return Math.PI
  return Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb))))
}

const inBox = (p: Vec3, w: Where): boolean =>
  (!w.box || (p[0] >= w.box.min[0] && p[0] <= w.box.max[0] && p[1] >= w.box.min[1] && p[1] <= w.box.max[1] && p[2] >= w.box.min[2] && p[2] <= w.box.max[2])) &&
  (!w.near || Math.hypot(p[0] - w.near.at[0], p[1] - w.near.at[1], p[2] - w.near.at[2]) <= w.near.radius)

/** How far an edge may pass from a through point unless told, mm: its
 *  drawn polyline stands off a curve by the drawing chord, a few microns. */
const THROUGH_MM = 0.01

/** How far a point lies from the polyline drawn for an edge, or from its
 *  ends where it has none. */
function offPolyline(e: EdgeInfo, p: Vec3): number {
  const q = e.polyline
  if (q.length < 6) return Math.min(...e.ends.map((x) => Math.hypot(x[0] - p[0], x[1] - p[1], x[2] - p[2])))
  let best = Infinity
  for (let i = 0; i + 5 < q.length; i += 3) {
    const ax = q[i], ay = q[i + 1], az = q[i + 2]
    const dx = q[i + 3] - ax, dy = q[i + 4] - ay, dz = q[i + 5] - az
    const l2 = dx * dx + dy * dy + dz * dz
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy + (p[2] - az) * dz) / l2)) : 0
    best = Math.min(best, Math.hypot(ax + t * dx - p[0], ay + t * dy - p[1], az + t * dz - p[2]))
  }
  return best
}

/** How far a point lies from an edge: exactly for a line (its two ends)
 *  and a circle (its middle, ends, axis and radius give the centre), from
 *  the drawn polyline otherwise — which stands off a curve by the drawing
 *  chord, tens of microns on a large arc. */
function offEdge(e: EdgeInfo, p: Vec3): number {
  const fp = e.fingerprint
  const [a, b] = e.ends
  if (fp.kind === 'line') {
    const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const l2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2]
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2]) / l2)) : 0
    return Math.hypot(a[0] + t * d[0] - p[0], a[1] + t * d[1] - p[1], a[2] + t * d[2] - p[2])
  }
  const coarse = offPolyline(e, p)
  if (fp.kind !== 'circle' || fp.radius === undefined) return coarse
  const r = fp.radius
  const m = fp.mid
  const n = fp.dir
  const ln = Math.hypot(n[0], n[1], n[2]) || 1
  const ax: Vec3 = [n[0] / ln, n[1] / ln, n[2] / ln]
  // the centre: half way to the seam on a whole circle, else a radius from
  // the middle towards the chord's middle
  let c: Vec3
  if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-6) c = [(m[0] + a[0]) / 2, (m[1] + a[1]) / 2, (m[2] + a[2]) / 2]
  else {
    const k: Vec3 = [(a[0] + b[0]) / 2 - m[0], (a[1] + b[1]) / 2 - m[1], (a[2] + b[2]) / 2 - m[2]]
    const lk = Math.hypot(k[0], k[1], k[2]) || 1
    c = [m[0] + (r * k[0]) / lk, m[1] + (r * k[1]) / lk, m[2] + (r * k[2]) / lk]
  }
  const v: Vec3 = [p[0] - c[0], p[1] - c[1], p[2] - c[2]]
  const h = v[0] * ax[0] + v[1] * ax[1] + v[2] * ax[2]
  const rho = Math.hypot(v[0] - h * ax[0], v[1] - h * ax[1], v[2] - h * ax[2])
  const exact = Math.hypot(rho - r, h)
  // the nearest point of the whole circle must lie on this stretch of it
  return coarse < exact + 0.1 * r + 0.05 ? exact : coarse
}

/** Whether a radius answers the query's radius or diameter, within
 *  sizeWithin — 2 % of it, 0.05 mm at least, unless given. */
function sizePasses(radius: number | undefined, w: Where): boolean {
  const want = w.radius ?? (w.diameter !== undefined ? w.diameter / 2 : undefined)
  if (want === undefined) return true
  if (radius === undefined) return false
  return Math.abs(radius - want) <= (w.sizeWithin ?? Math.max(0.05, 0.02 * want))
}

/** The faces a query's `faces` names, by hash, among the faces of the
 *  body it is run on as reverse.body.describe lists them — null with no
 *  such term; refused for an index the body has not got. */
export function sidesOf(w: Where, faces: readonly FaceInfo[], body: { name: string }): number[] | null {
  if (!w.faces) return null
  return w.faces.map((i) => {
    const f = faces[i]
    if (!f) throw new CommandError('not_found', `${body.name} has no face ${i} — it has ${faces.length}; reverse.body.describe lists them.`)
    return f.hash
  })
}

export function facePasses(f: FaceInfo, w: Where, madeBy: number | null, sides: readonly number[] | null = null): boolean {
  if (w.through) invalid('through picks edges — the edge a point lies on; for a face give near, box or its fingerprint.')
  const fp = f.fingerprint
  const within = ((w.withinDeg ?? 10) * Math.PI) / 180
  if (sides && !sides.includes(f.hash)) return false
  if (!inBox(fp.centroid, w)) return false
  if (w.kind !== undefined && fp.kind !== w.kind) return false
  if (madeBy !== null && fp.origin !== madeBy) return false
  if (w.minArea !== undefined && fp.area < w.minArea) return false
  if (w.maxArea !== undefined && fp.area > w.maxArea) return false
  if (!sizePasses(fp.radius, w)) return false
  if (w.between && !w.between.some((n) => angleBetween(fp.dir, n) <= within)) return false
  if (w.coaxial && !faceCoaxial(f, w.coaxial)) return false
  return true
}

export function edgePasses(e: EdgeInfo, w: Where, madeBy: number | null, sides: readonly number[] | null = null, rounds?: ReadonlySet<number>): boolean {
  const fp = e.fingerprint
  const within = ((w.withinDeg ?? 10) * Math.PI) / 180
  // Between the faces named: each of them on one side of it.
  if (sides && !sides.every((h) => e.faces.includes(h))) return false
  if (!inBox(fp.mid, w)) return false
  if (w.through && offEdge(e, w.through.at) > (w.through.within ?? THROUGH_MM)) return false
  if (w.kind !== undefined && fp.kind !== w.kind) return false
  if (madeBy !== null && fp.origin !== madeBy) return false
  if (w.minLength !== undefined && fp.length < w.minLength) return false
  if (w.maxLength !== undefined && fp.length > w.maxLength) return false
  if (!sizePasses(fp.radius, w)) return false
  if (w.between && !w.between.every((n) => fp.faces.some((f) => angleBetween(f.dir, n) <= within))) return false
  if (w.coaxial && !edgeCoaxial(e, w.coaxial) && !(rounds && edgeRoundsCoaxial(e, rounds))) return false
  return true
}

// ---- sharp, read off the surfaces ---------------------------------------------------

/** Whether an edge runs between faces that meet at more than `deg`
 *  degrees, read off the faces' own surfaces at its middle and a quarter of
 *  the way from each end, rather than off a mesh — where the build runs a
 *  query, there is none. `normals` gives a face's unit normals, by its hash, at the points
 *  of it nearest those asked (the kernel's faceNormals); their sign does
 *  not count, the kernel leaving a reversed face's unturned. An edge with
 *  one face, or more than two, is sharp, as the viewport draws it; a seam,
 *  one face meeting itself, is not. */
export function sharpBySurfaces(e: EdgeInfo, normals: (faceHash: number, points: readonly Vec3[]) => readonly Vec3[], deg = SHARP_DEG): boolean {
  const tangentCos = Math.cos((deg * Math.PI) / 180)
  const faces = [...new Set(e.faces)]
  if (e.faces.length < 2 || faces.length > 2) return true
  if (faces.length === 1) return false
  const points: Vec3[] = [e.fingerprint.mid]
  const n = e.polyline.length / 3
  if (n > 2)
    for (const k of [0.25, 0.75]) {
      const i = Math.round(k * (n - 1))
      points.push([e.polyline[3 * i], e.polyline[3 * i + 1], e.polyline[3 * i + 2]])
    }
  const a = normals(faces[0], points)
  const b = normals(faces[1], points)
  return points.some((_, i) => !a[i] || !b[i] || Math.abs(a[i][0] * b[i][0] + a[i][1] * b[i][1] + a[i][2] * b[i][2]) < tangentCos)
}

// ---- queries a feature keeps -----------------------------------------------------------

/** A query as a feature keeps it, to be run again at build: madeBy and
 *  sides by feature id, and what it named by index — the faces either side,
 *  the face whose loop it reads, what it excludes — by their fingerprints:
 *  an index names a face of the part as it stood when the query was given,
 *  and the next build may number them otherwise. */
export interface StoredWhere extends Omit<Where, 'madeBy' | 'sides' | 'faces' | 'exclude' | 'where'> {
  madeBy?: number
  sides?: { madeBy: number[] }
  faces?: FaceFingerprint[]
  exclude?: StoredWhere | { prints: (FaceFingerprint | EdgeFingerprint)[] }
}

/** A query a feature keeps, and what it found when it was given — the
 *  fingerprints the feature's own list holds for it too. While all of
 *  those are still in that list the query stands; an edit by hand that
 *  took one of them out lets it go, and the list is the pick from then
 *  on. */
export interface StoredPick<F> {
  where: StoredWhere
  found: F[]
}

/** A query made ready to keep, on the topology it was run on: features by
 *  id, indices by fingerprint. */
export function storedWhere(given: Where, t: WhereTopology, what: 'face' | 'edge', featureId: (ref: FeatureRef) => number): StoredWhere {
  const { madeBy, sides, faces, exclude, where: _where, ...rest } = unwrapped(given, what)
  void _where
  const face = (i: number): FaceFingerprint => {
    const f = t.faces[i]
    if (!f) throw new CommandError('not_found', `There is no face ${i} — the body has ${t.faces.length}; reverse.body.describe lists them.`)
    return f.fingerprint
  }
  const out: StoredWhere = { ...rest }
  if (madeBy !== undefined) out.madeBy = featureId(madeBy)
  if (sides) out.sides = { madeBy: sides.madeBy.map(featureId) }
  if (faces) out.faces = faces.map(face)
  if (Array.isArray(exclude)) out.exclude = { prints: exclude.map((i) => (what === 'face' ? face(i) : t.edges[i]?.fingerprint)).filter((p): p is FaceFingerprint | EdgeFingerprint => p !== undefined) }
  else if (exclude !== undefined) out.exclude = storedWhere(exclude, t, what, featureId)
  return out
}

/** A kept query as it is run on a topology: its fingerprints found there
 *  again, by index — null where a face it names by one is not found (the
 *  query cannot be read on this body). An exclusion not found is gone,
 *  and excludes nothing. */
function whereOn(s: StoredWhere, t: WhereTopology, what: 'face' | 'edge', tol: MatchTolerance): Where | null {
  const { faces, exclude, ...rest } = s
  const out: Where = { ...rest }
  if (faces) {
    const prints = t.faces.map((f) => f.fingerprint)
    const at = faces.map((f) => matchFace(f, prints, tol))
    if (at.some((i) => i === null)) return null
    out.faces = at as number[]
  }
  if (exclude && 'prints' in exclude) {
    const faceOf = t.faces.map((f) => f.fingerprint)
    const edgeOf = t.edges.map((e) => e.fingerprint)
    out.exclude = exclude.prints.flatMap((p) => {
      const i = what === 'face' ? matchFace(p as FaceFingerprint, faceOf, tol) : matchEdge(p as EdgeFingerprint, edgeOf, tol)
      return i === null ? [] : [i]
    })
  } else if (exclude) {
    const inner = whereOn(exclude, t, what, tol)
    if (!inner) return null
    out.exclude = inner
  }
  return out
}

/** A kept query run on a body as it stands, by index — null where it
 *  cannot be read there (a face it names is gone, a term refused). */
export function runStoredWhere(s: StoredWhere, t: WhereTopology, body: { name: string }, what: 'face' | 'edge', sharp: WhereAsk['sharp'], tol: MatchTolerance): number[] | null {
  const w = whereOn(s, t, what, tol)
  if (!w) return null
  try {
    return whereIndices(w, t, body, what, { featureId: (ref) => (typeof ref === 'number' ? ref : Number.NaN), sharp })
  } catch (e) {
    if (e instanceof CommandError) return null
    throw e
  }
}

/** Two fingerprints the same, by value — as a file holds them. */
const samePrint = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** The kept queries of a feature that still stand on its list of
 *  fingerprints — each whose finds are all in it still, each on a
 *  fingerprint of its own — and the fingerprints left over, picked one by
 *  one. `same` says a find is still in the list: by value, or — for the
 *  build — as near as the fingerprints match, since the panel puts a pick
 *  it reopens on the face or edge it finds now, under that one's own. */
export function livePicks<F>(prints: readonly F[], picks: readonly StoredPick<F>[] | undefined, same: (found: F, print: F) => boolean = samePrint): { live: StoredPick<F>[]; rest: F[] } {
  if (!picks?.length) return { live: [], rest: [...prints] }
  const claimed = new Set<number>()
  const live: StoredPick<F>[] = []
  for (const p of picks) {
    const mine: number[] = []
    for (const f of p.found) {
      const exact = prints.findIndex((x, i) => !claimed.has(i) && !mine.includes(i) && samePrint(f, x))
      const i = exact >= 0 ? exact : prints.findIndex((x, i) => !claimed.has(i) && !mine.includes(i) && same(f, x))
      if (i < 0) break
      mine.push(i)
    }
    if (mine.length < p.found.length) continue
    live.push(p)
    for (const i of mine) claimed.add(i)
  }
  return { live, rest: prints.filter((_, i) => !claimed.has(i)) }
}

/** A kept query in words, for a row that says it found nothing: its terms,
 *  what it named by fingerprint counted. */
export function whereWords(s: StoredWhere): string {
  const terms = Object.entries(s).map(([k, v]) => (k === 'faces' && Array.isArray(v) ? `faces: ${v.length}` : k === 'exclude' ? 'exclude' : `${k}: ${JSON.stringify(v)}`))
  return `{ ${terms.join(', ')} }`
}

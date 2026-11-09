// SPDX-License-Identifier: AGPL-3.0-only
// The closed regions of a sketch, for picking the way CAD does: the sketch
// is a planar graph, the operator clicks the regions to use, and an inner
// loop nobody picked becomes a hole. The graph is built the plain way —
// every crossing and every end lying on another piece found on the exact
// lines and arcs, each piece split there and sampled to short straight
// segments between, the segments knitted into half-edges at shared
// vertices — and its faces traced with the region on the left, so a
// bounded region comes out counter-clockwise and the outside of a
// component clockwise. Dangling pieces and bridges between loops belong to
// no region and are pruned. Each face keeps, along its boundary, which
// entity every stretch came from and over what parameter range, so the
// profile handed to the kernel is the exact line, arc or spline and not
// the samples.

import type { FlatSplineFit, Vec2 } from '../../../src/core/flat/types'
import { cross2, len2, sub2 } from '../../../src/core/flat/vec2'
import { arcPoint, type Sketch } from './sketch'
import { isClosed, nearestOnSpline, splineAt, splineCurve, splineDerivAt, splineEnd, splineSamples, splineStretch } from './sketchSpline'
import { makeUnionFind } from '../../../src/core/geometry/unionFind'
import { signedArea2 } from '../../../src/core/flat/vec2'

/** A stretch of one entity's boundary: the line's parameter 0–1, the angle
 *  along an arc or circle, or a spline's own parameter (sketchSpline.ts),
 *  from `t0` to `t1` in the loop's direction. */
export interface RegionPiece {
  entity: number
  t0: number
  t1: number
  /** Where the stretch starts and ends — the graph's shared vertices, so
   *  two stretches that meet meet exactly, whatever the solver left between
   *  the pieces' own ends. */
  p0: Vec2
  p1: Vec2
}

export interface RegionLoop {
  pieces: RegionPiece[]
  /** The loop as sampled, for drawing and for hit tests. */
  polygon: Vec2[]
}

export interface Region {
  /** Stable across rebuilds of the same sketch: a hash of the outer loop's
   *  entities and its centroid, so a pick survives a solve. */
  key: string
  outer: RegionLoop
  holes: RegionLoop[]
  area: number
  /** A point inside the region and outside its holes, for the label. */
  inside: Vec2
}

/** A closed loop of exact geometry in the sketch plane — what one face is
 *  bounded by, to be lifted into the part. */
export type ProfilePiece2 =
  | { kind: 'line'; a: Vec2; b: Vec2 }
  | { kind: 'arc'; a: Vec2; m: Vec2; b: Vec2 }
  | { kind: 'circle'; c: Vec2; r: number }
  /** A stretch of a spline as a clamped cubic B-spline (see sketchSpline.ts). */
  | { kind: 'spline'; poles: Vec2[]; knots: number[]; mults: number[] }

const ARC_SAMPLES_PER_TURN = 72
/** Where a spline is sampled before any split, per segment. */
const SPLINE_SAMPLES_PER_SEGMENT = 16
/** Vertices this close are one vertex: two microns, a hundred times what a
 *  solved coincidence leaves between two ends and far under anything a
 *  sketch would mean as two different points. */
const SNAP = 2e-3
/** How far off a line the far end of one only touching it end to end may
 *  be and still lie along it: a solver's hair, a twentieth of SNAP. */
const TOUCH_HAIR = 1e-4

/** A piece as the graph takes it: a line from `a` to `b`, its parameter
 *  0–1, an arc run counter-clockwise from `t0` through `sweep`, its
 *  parameter the angle — a circle is an arc of a whole turn — or a spline,
 *  its parameter its own from 0 to `end`. */
type Curve =
  | { kind: 'line'; entity: number; a: Vec2; b: Vec2 }
  | { kind: 'arc'; entity: number; c: Vec2; r: number; t0: number; sweep: number }
  | { kind: 'spline'; entity: number; fit: FlatSplineFit; end: number }

const TURN = 2 * Math.PI

/** The pieces that bound regions: construction left out. */
function curvesOf(sketch: Pick<Sketch, 'entities'>): Curve[] {
  const out: Curve[] = []
  for (const e of sketch.entities) {
    if (e.construction) continue
    if (e.kind === 'line') {
      if (len2(sub2(e.b, e.a)) > SNAP) out.push({ kind: 'line', entity: e.id, a: e.a, b: e.b })
    } else if (e.kind === 'arc' || e.kind === 'circle') {
      const t0 = e.kind === 'arc' ? e.start : 0
      const sweep = e.kind === 'arc' ? Math.min(Math.abs(e.sweep), TURN) : TURN
      out.push({ kind: 'arc', entity: e.id, c: e.c, r: e.r, t0, sweep })
    } else if (e.kind === 'spline' && e.pts.length >= 2) {
      const fit = splineCurve(e)
      if (fit.length > SNAP) out.push({ kind: 'spline', entity: e.id, fit, end: splineEnd(fit) })
    }
  }
  alignCollinear(out.filter((c): c is Extract<Curve, { kind: 'line' }> => c.kind === 'line'))
  return out
}

/** Two lines drawn along one line — both ends of the shorter within SNAP
 *  of the longer's line, and their stretches overlapping or touching — are
 *  taken to lie on the longer's line: the shorter's ends move onto it. Two
 *  sides put on the same datum come back from the solver a hair apart, and
 *  left so, the stretch of one that runs on past the other's end sits a
 *  hair off the shared stretch. Lifted into a body, that is a face a hair
 *  out of plane with its neighbour — two faces to the kernel where the
 *  drawing has one, which no shell or later face pick can take as one. The
 *  sketch itself is not touched: only the graph's copy of the ends. */
function alignCollinear(curves: Extract<Curve, { kind: 'line' }>[]): void {
  const lines = curves.slice().sort((x, y) => len2(sub2(y.b, y.a)) - len2(sub2(x.b, x.a)))
  for (let i = 0; i < lines.length; i++) {
    const a = lines[i]
    const d = sub2(a.b, a.a)
    const len = len2(d)
    if (len <= SNAP) continue
    const u: Vec2 = [d[0] / len, d[1] / len]
    for (let j = i + 1; j < lines.length; j++) {
      const b = lines[j]
      const w0 = sub2(b.a, a.a)
      const w1 = sub2(b.b, a.a)
      // Off the line by more than the snap at either end: another line.
      if (Math.abs(cross2(u, w0)) > SNAP || Math.abs(cross2(u, w1)) > SNAP) continue
      const s0 = w0[0] * u[0] + w0[1] * u[1]
      const s1 = w1[0] * u[0] + w1[1] * u[1]
      // Along the line but wholly beyond an end of it: a different stretch
      // of the same line, which shares nothing with this one.
      if (Math.max(s0, s1) < -SNAP || Math.min(s0, s1) > len + SNAP) continue
      // Only touching end to end, it is the same line only within a
      // solver's hair: a bend of a tenth of a degree between two sides of
      // one outline (a polyline round a curve) leaves the far end within
      // SNAP of the line too, and moved onto it, it parts from the side
      // after it.
      const overlap = Math.min(Math.max(s0, s1), len) - Math.max(Math.min(s0, s1), 0)
      if (overlap <= SNAP && (Math.abs(cross2(u, w0)) > TOUCH_HAIR || Math.abs(cross2(u, w1)) > TOUCH_HAIR)) continue
      b.a = [a.a[0] + u[0] * s0, a.a[1] + u[1] * s0]
      b.b = [a.a[0] + u[0] * s1, a.a[1] + u[1] * s1]
    }
  }
}

function pointAt(c: Curve, t: number): Vec2 {
  if (c.kind === 'spline') return splineAt(c.fit, t)
  return c.kind === 'line' ? [c.a[0] + (c.b[0] - c.a[0]) * t, c.a[1] + (c.b[1] - c.a[1]) * t] : arcPoint(c, t)
}

/** The way a piece runs on at t, per unit of its parameter. */
function derivAt(c: Curve, t: number): Vec2 {
  if (c.kind === 'spline') return splineDerivAt(c.fit, t)
  if (c.kind === 'line') return sub2(c.b, c.a)
  return [-c.r * Math.sin(t), c.r * Math.cos(t)]
}

/** The ends a piece has — none for a circle or a closed spline, whose seam
 *  is no point of the drawing. */
function endsOf(c: Curve): Vec2[] {
  if (c.kind === 'line') return [c.a, c.b]
  if (c.kind === 'spline') return c.fit.closed ? [] : [splineAt(c.fit, 0), splineAt(c.fit, c.end)]
  return c.sweep >= TURN ? [] : [arcPoint(c, c.t0), arcPoint(c, c.t0 + c.sweep)]
}

/**
 * Where a point lies on a piece, as the piece's parameter, when it lies on
 * the piece within SNAP; else null. `interior` asks for a point clear of
 * both ends by more than SNAP — an end lying on another piece, which
 * splits it there; otherwise a point within SNAP of an end, either side,
 * is the end itself — two pieces meeting at a shared corner meet there,
 * not a rounding error beside it.
 */
function paramOn(c: Curve, p: Vec2, interior: boolean): number | null {
  if (c.kind === 'line') {
    const d = sub2(c.b, c.a)
    const len = len2(d)
    const w = sub2(p, c.a)
    if (Math.abs(cross2(d, w)) / len > SNAP) return null
    const t = (w[0] * d[0] + w[1] * d[1]) / (len * len)
    if (Math.abs(t) * len <= SNAP) return interior ? null : 0
    if (Math.abs(1 - t) * len <= SNAP) return interior ? null : 1
    return t > 0 && t < 1 ? t : null
  }
  if (c.kind === 'spline') {
    const near = nearestOnSpline(c.fit, p, 8)
    if (near.dist > SNAP) return null
    if (!c.fit.closed) {
      if (len2(sub2(p, splineAt(c.fit, 0))) <= SNAP) return interior ? null : 0
      if (len2(sub2(p, splineAt(c.fit, c.end))) <= SNAP) return interior ? null : c.end
    }
    return near.t
  }
  const w = sub2(p, c.c)
  if (Math.abs(len2(w) - c.r) > SNAP) return null
  const rel = (((Math.atan2(w[1], w[0]) - c.t0) % TURN) + TURN) % TURN
  if (c.sweep >= TURN) return c.t0 + rel
  if (Math.min(rel, TURN - rel) * c.r <= SNAP) return interior ? null : c.t0
  if (Math.abs(c.sweep - rel) * c.r <= SNAP) return interior ? null : c.t0 + c.sweep
  return rel < c.sweep ? c.t0 + rel : null
}

/** Where a line meets a circle: none, two points, or — passing within
 *  SNAP of tangent — the one point it touches at, so a line put tangent
 *  to an arc meets it once and leaves no sliver a hair wide between. */
function lineMeetsCircle(l: Extract<Curve, { kind: 'line' }>, c: Extract<Curve, { kind: 'arc' }>): Vec2[] {
  const d = sub2(l.b, l.a)
  const len = len2(d)
  const u: Vec2 = [d[0] / len, d[1] / len]
  const w = sub2(c.c, l.a)
  const s = w[0] * u[0] + w[1] * u[1]
  const h = Math.abs(cross2(u, w))
  if (Math.abs(h - c.r) <= SNAP) return [[l.a[0] + u[0] * s, l.a[1] + u[1] * s]]
  if (h > c.r) return []
  const k = Math.sqrt(c.r * c.r - h * h)
  return [
    [l.a[0] + u[0] * (s - k), l.a[1] + u[1] * (s - k)],
    [l.a[0] + u[0] * (s + k), l.a[1] + u[1] * (s + k)],
  ]
}

/** Where two circles meet, touching within SNAP counted as one point. Two
 *  on one centre meet nowhere: where two arcs of one circle overlap, their
 *  ends lying on each other split them. */
function circleMeetsCircle(p: Extract<Curve, { kind: 'arc' }>, q: Extract<Curve, { kind: 'arc' }>): Vec2[] {
  const v = sub2(q.c, p.c)
  const d = len2(v)
  if (d <= SNAP) return []
  const u: Vec2 = [v[0] / d, v[1] / d]
  const at = (x: number, y: number): Vec2 => [p.c[0] + u[0] * x - u[1] * y, p.c[1] + u[1] * x + u[0] * y]
  if (Math.abs(d - (p.r + q.r)) <= SNAP) return [at(p.r, 0)]
  if (Math.abs(d - Math.abs(p.r - q.r)) <= SNAP) return [at(p.r >= q.r ? p.r : -p.r, 0)]
  if (d > p.r + q.r || d < Math.abs(p.r - q.r)) return []
  const x = (d * d + p.r * p.r - q.r * q.r) / (2 * d)
  const y = Math.sqrt(Math.max(0, p.r * p.r - x * x))
  return [at(x, y), at(x, -y)]
}

/**
 * Where a spline crosses another piece, on the exact curves: the samples of
 * the two cross somewhere near each crossing, and Newton's method on the
 * two parameters together takes it from there to where the curves
 * themselves meet. A touch that does not cross — a curve grazing a line —
 * is not found here; where it matters, at a joint, it is an end of one on
 * the other, which the ends' own test finds.
 */
function curveMeetings(a: Curve, b: Curve): [number, number][] {
  const sa = gridOf(a).map((t) => ({ t, p: pointAt(a, t) }))
  const sb = gridOf(b).map((t) => ({ t, p: pointAt(b, t) }))
  const out: [number, number][] = []
  for (let i = 0; i + 1 < sa.length; i++) {
    const p0 = sa[i].p
    const p1 = sa[i + 1].p
    const da = sub2(p1, p0)
    for (let j = 0; j + 1 < sb.length; j++) {
      const q0 = sb[j].p
      const q1 = sb[j + 1].p
      if (Math.max(q0[0], q1[0]) < Math.min(p0[0], p1[0]) - SNAP || Math.min(q0[0], q1[0]) > Math.max(p0[0], p1[0]) + SNAP) continue
      if (Math.max(q0[1], q1[1]) < Math.min(p0[1], p1[1]) - SNAP || Math.min(q0[1], q1[1]) > Math.max(p0[1], p1[1]) + SNAP) continue
      const db = sub2(q1, q0)
      const denom = cross2(da, db)
      if (Math.abs(denom) <= 1e-18) continue
      const w = sub2(q0, p0)
      const s = cross2(w, db) / denom
      const u = cross2(w, da) / denom
      // A crossing of the samples, a little slack either side: the exact
      // crossing lies near it, perhaps in the next span over.
      if (s < -0.25 || s > 1.25 || u < -0.25 || u > 1.25) continue
      let ta = sa[i].t + (sa[i + 1].t - sa[i].t) * Math.min(Math.max(s, 0), 1)
      let tb = sb[j].t + (sb[j + 1].t - sb[j].t) * Math.min(Math.max(u, 0), 1)
      for (let it = 0; it < 12; it++) {
        const f = sub2(pointAt(a, ta), pointAt(b, tb))
        if (len2(f) < 1e-12) break
        const ja = derivAt(a, ta)
        const jb = derivAt(b, tb)
        // Solve [ja, −jb] [dta, dtb] = −f.
        const det = -ja[0] * jb[1] + jb[0] * ja[1]
        if (Math.abs(det) < 1e-18) break
        ta += (f[0] * jb[1] - jb[0] * f[1]) / det
        tb += (ja[0] * f[1] - f[0] * ja[1]) / det
      }
      const at = pointAt(a, ta)
      if (len2(sub2(at, pointAt(b, tb))) > SNAP / 10) continue
      const pa = paramOn(a, at, false)
      const pb = paramOn(b, at, false)
      if (pa === null || pb === null) continue
      // Found again from the next span over: the same crossing.
      if (out.some(([x]) => len2(sub2(pointAt(a, x), at)) <= SNAP)) continue
      out.push([pa, pb])
    }
  }
  return out
}

/** Where two pieces cross or touch, on their exact geometry, as the
 *  parameter on each. */
function meetings(a: Curve, b: Curve): [number, number][] {
  if (a.kind === 'spline' || b.kind === 'spline') return curveMeetings(a, b)
  let points: Vec2[]
  if (a.kind === 'line' && b.kind === 'line') {
    const da = sub2(a.b, a.a)
    const db = sub2(b.b, b.a)
    const denom = cross2(da, db)
    // Parallel: two lines along one line share their ends, if anything.
    if (Math.abs(denom) <= 1e-12 * len2(da) * len2(db)) return []
    const s = cross2(sub2(b.a, a.a), db) / denom
    points = [[a.a[0] + da[0] * s, a.a[1] + da[1] * s]]
  } else if (a.kind === 'line' && b.kind === 'arc') points = lineMeetsCircle(a, b)
  else if (a.kind === 'arc' && b.kind === 'line') points = lineMeetsCircle(b, a)
  else points = circleMeetsCircle(a as Extract<Curve, { kind: 'arc' }>, b as Extract<Curve, { kind: 'arc' }>)
  const out: [number, number][] = []
  for (const p of points) {
    const ta = paramOn(a, p, false)
    const tb = paramOn(b, p, false)
    if (ta !== null && tb !== null) out.push([ta, tb])
  }
  return out
}

function boxOf(c: Curve): [number, number, number, number] {
  if (c.kind === 'arc') return [c.c[0] - c.r - SNAP, c.c[1] - c.r - SNAP, c.c[0] + c.r + SNAP, c.c[1] + c.r + SNAP]
  if (c.kind === 'spline') {
    // Round the samples, with room for the curve's bulge between them.
    const pts = splineSamples(c.fit, SPLINE_SAMPLES_PER_SEGMENT).map((s) => s.p)
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    const pad = SNAP + 0.01 * c.fit.length
    return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad]
  }
  return [
    Math.min(c.a[0], c.b[0]) - SNAP,
    Math.min(c.a[1], c.b[1]) - SNAP,
    Math.max(c.a[0], c.b[0]) + SNAP,
    Math.max(c.a[1], c.b[1]) + SNAP,
  ]
}

/** Where a piece is sampled before any split: a line at its ends, an arc
 *  or a circle every few degrees. */
function gridOf(c: Curve): number[] {
  if (c.kind === 'line') return [0, 1]
  if (c.kind === 'spline') return splineSamples(c.fit, SPLINE_SAMPLES_PER_SEGMENT).map((s) => s.t)
  const n = Math.max(4, Math.ceil((ARC_SAMPLES_PER_TURN * c.sweep) / TURN))
  return Array.from({ length: n + 1 }, (_, i) => (i === n ? c.t0 + c.sweep : c.t0 + (c.sweep * i) / n))
}

interface Edge {
  a: number
  b: number
  piece: RegionPiece
  /** The angles it leaves `a` and `b` at — see leaving. */
  leave: [number, number]
}

/**
 * The way a piece leaves the point at parameter `t`, running on with the
 * parameter or back against it, as an angle: its tangent, turned the way it
 * bends over SNAP of its length. Two pieces leaving a vertex along one
 * tangent — a fillet and the line it runs into, an arc touching another —
 * come in the order they part in, which the first chord of each, a few
 * degrees long and inside its arc by a hair, does not tell.
 */
function leaving(c: Curve, t: number, forward: boolean): number {
  if (c.kind === 'line') {
    const d = forward ? sub2(c.b, c.a) : sub2(c.a, c.b)
    return Math.atan2(d[1], d[0])
  }
  if (c.kind === 'spline') {
    // The chord SNAP long the way it runs: its tangent, turned as it bends.
    const speed = Math.max(len2(splineDerivAt(c.fit, t)), 1e-9)
    const step = (forward ? 1 : -1) * (SNAP / speed)
    const d = sub2(splineAt(c.fit, t + step), splineAt(c.fit, t))
    return Math.atan2(d[1], d[0])
  }
  const bend = SNAP / (2 * c.r)
  const angle = forward ? t + Math.PI / 2 + bend : t - Math.PI / 2 - bend
  return Math.atan2(Math.sin(angle), Math.cos(angle))
}

/**
 * Build the vertices and edges: each piece split where it crosses another
 * and where another's end lies on it, then sampled between, and near
 * points one vertex. The splits are found on the exact lines and arcs, not
 * on the samples: an arc's chords run inside it — by 28 microns on a
 * 30 mm radius — and a line put on an arc with a coincidence, ending on the
 * arc and not on a chord, would otherwise dangle a hair short of it and
 * bound no region; drawn on past it, it would cross a chord a hair inside,
 * and the face lifted from the region would take that corner, off the arc,
 * for its own and step beside the edge the arc came from.
 */
function buildGraph(curves: Curve[]): { vertices: Vec2[]; edges: Edge[] } {
  const splits: number[][] = curves.map(gridOf)
  const boxes = curves.map(boxOf)
  for (let i = 0; i < curves.length; i++) {
    const a = curves[i]
    const [ax0, ay0, ax1, ay1] = boxes[i]
    for (let j = i + 1; j < curves.length; j++) {
      const b = curves[j]
      const [bx0, by0, bx1, by1] = boxes[j]
      if (bx1 < ax0 || bx0 > ax1 || by1 < ay0 || by0 > ay1) continue
      for (const [ta, tb] of meetings(a, b)) {
        splits[i].push(ta)
        splits[j].push(tb)
      }
      // An end of one lying on the other — a T-junction the solver left a
      // hair short of touching, or two outlines drawn along one line — is
      // a vertex of the other as well. Otherwise the one that runs on past
      // the other's end leaves a sliver between them, a hair high and as
      // long as their overlap, and the face beside it takes the sliver in.
      for (const p of endsOf(b)) {
        const t = paramOn(a, p, true)
        if (t !== null) splits[i].push(t)
      }
      for (const p of endsOf(a)) {
        const t = paramOn(b, p, true)
        if (t !== null) splits[j].push(t)
      }
    }
  }
  const vertices: Vec2[] = []
  const grid = new Map<string, number[]>()
  // A cell as wide as SNAP: the eight round one hold every vertex within
  // SNAP. Half as wide, an end 1–2 µm off the vertex it meets could sit two
  // cells over, never merge, and leave its region open (issue 34).
  const cell = SNAP
  const vertexOf = (p: Vec2): number => {
    const cx = Math.floor(p[0] / cell)
    const cy = Math.floor(p[1] / cell)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(`${cx + dx},${cy + dy}`)
        if (!bucket) continue
        for (const v of bucket) if (len2(sub2(vertices[v], p)) <= SNAP) return v
      }
    }
    const v = vertices.length
    vertices.push([p[0], p[1]])
    const key = `${cx},${cy}`
    const bucket = grid.get(key)
    if (bucket) bucket.push(v)
    else grid.set(key, [v])
    return v
  }
  const edges: Edge[] = []
  curves.forEach((c, i) => {
    const ts = Array.from(new Set(splits[i])).sort((x, y) => x - y)
    // The points between them run from the first, so a stretch the splits
    // left shorter than SNAP closes up onto the vertex before it.
    let a = vertexOf(pointAt(c, ts[0]))
    let t0 = ts[0]
    for (let k = 1; k < ts.length; k++) {
      const b = vertexOf(pointAt(c, ts[k]))
      if (a === b) continue
      edges.push({
        a,
        b,
        piece: { entity: c.entity, t0, t1: ts[k], p0: vertices[a], p1: vertices[b] },
        leave: [leaving(c, t0, true), leaving(c, ts[k], false)],
      })
      a = b
      t0 = ts[k]
    }
  })
  // Two stretches drawn over each other — the sides of two outlines along
  // one line — are one edge between the same two vertices. The later one
  // goes: kept, the face between them would be a sliver of no width that
  // the trace still walks round.
  const seen = new Set<string>()
  const unique = edges.filter((e) => {
    const key = e.a < e.b ? `${e.a}-${e.b}` : `${e.b}-${e.a}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return { vertices, edges: unique }
}

/** Drop dangling edges — those ending at a vertex nothing else reaches —
 *  until none are left. */
function pruneDangling(edges: Edge[]): Edge[] {
  let live = edges.slice()
  for (;;) {
    const degree = new Map<number, number>()
    for (const e of live) {
      degree.set(e.a, (degree.get(e.a) ?? 0) + 1)
      degree.set(e.b, (degree.get(e.b) ?? 0) + 1)
    }
    const kept = live.filter((e) => (degree.get(e.a) ?? 0) > 1 && (degree.get(e.b) ?? 0) > 1)
    if (kept.length === live.length) return kept
    live = kept
  }
}

interface Half {
  edge: number
  from: number
  to: number
  /** The angle it leaves `from` at. */
  angle: number
}

interface TracedLoop {
  halves: Half[]
  polygon: Vec2[]
  area: number
}

export function pointInPolygon(p: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside
  }
  return inside
}

/** Trace every face of the graph, the face on the left of each half-edge.
 *  Returns null when an edge was found to be a bridge (both its sides in
 *  the same face) — the caller removes it and traces again. */
function trace(vertices: readonly Vec2[], edges: Edge[]): TracedLoop[] | number {
  const halves: Half[] = []
  edges.forEach((e, i) => {
    halves.push({ edge: i, from: e.a, to: e.b, angle: e.leave[0] })
    halves.push({ edge: i, from: e.b, to: e.a, angle: e.leave[1] })
  })
  const outgoing = new Map<number, number[]>()
  halves.forEach((h, i) => {
    const list = outgoing.get(h.from)
    if (list) list.push(i)
    else outgoing.set(h.from, [i])
  })
  for (const list of outgoing.values()) list.sort((x, y) => halves[x].angle - halves[y].angle)
  // The half-edge that follows h round the face on its left: at h's head,
  // the outgoing edge just clockwise of h's twin.
  const next = (hi: number): number => {
    const h = halves[hi]
    const twin = hi ^ 1
    const list = outgoing.get(h.to)!
    const k = list.indexOf(twin)
    return list[(k - 1 + list.length) % list.length]
  }
  const used = new Uint8Array(halves.length)
  const loops: TracedLoop[] = []
  for (let start = 0; start < halves.length; start++) {
    if (used[start]) continue
    const loop: Half[] = []
    const seenEdges = new Set<number>()
    let h = start
    for (let guard = 0; guard <= halves.length; guard++) {
      used[h] = 1
      const half = halves[h]
      if (seenEdges.has(half.edge)) return half.edge // a bridge: both sides in one face
      seenEdges.add(half.edge)
      loop.push(half)
      h = next(h)
      if (h === start) break
    }
    const polygon = loop.map((x) => vertices[x.from])
    loops.push({ halves: loop, polygon, area: signedArea2(polygon) })
  }
  return loops
}

/** Merge a loop's half-edges into the stretches of one entity each. */
function piecesOf(loop: TracedLoop, edges: Edge[], sketch: Pick<Sketch, 'entities'>): RegionPiece[] {
  const raw: RegionPiece[] = loop.halves.map((h) => {
    const e = edges[h.edge]
    const forward = h.from === e.a
    return forward
      ? { ...e.piece }
      : { entity: e.piece.entity, t0: e.piece.t1, t1: e.piece.t0, p0: e.piece.p1, p1: e.piece.p0 }
  })
  // A closed spline's parameter runs 0 to its period and on round: a
  // stretch running over its first point goes on past the period (or back
  // under 0) rather than stopping there.
  const periods = new Map<number, number>()
  for (const e of sketch.entities) if (e.kind === 'spline' && isClosed(e)) periods.set(e.id, e.pts.length)
  /** How far `t` lies on from `end` round a closed spline: 0 where they
   *  are one place, a whole period across its seam. */
  const across = (entity: number, end: number, t: number): number | null => {
    if (Math.abs(end - t) < 1e-9) return 0
    const period = periods.get(entity)
    if (period === undefined) return null
    const turns = Math.round((end - t) / period)
    return turns !== 0 && Math.abs(end - t - turns * period) < 1e-9 ? turns * period : null
  }
  const merged: RegionPiece[] = []
  for (const p of raw) {
    const last = merged[merged.length - 1]
    const shift = last && last.entity === p.entity ? across(p.entity, last.t1, p.t0) : null
    if (last && shift !== null) {
      last.t1 = p.t1 + shift
      last.p1 = p.p1
    } else merged.push({ ...p })
  }
  // A loop that starts mid-entity: its first and last stretches are one.
  if (merged.length > 1) {
    const first = merged[0]
    const last = merged[merged.length - 1]
    const shift = first.entity === last.entity ? across(first.entity, last.t1, first.t0) : null
    if (shift !== null) {
      first.t0 = last.t0 - shift
      first.p0 = last.p0
      merged.pop()
    }
  }
  // Drop stretches of nothing.
  return merged.filter((p) => {
    const e = sketch.entities.find((x) => x.id === p.entity)
    return e && Math.abs(p.t1 - p.t0) > 1e-9
  })
}

function centroid(poly: readonly Vec2[]): Vec2 {
  let x = 0
  let y = 0
  for (const p of poly) {
    x += p[0]
    y += p[1]
  }
  return [x / poly.length, y / poly.length]
}

/** A point inside the polygon and outside the holes: the centroid if it
 *  serves, else the midpoint of the widest horizontal crossing through the
 *  polygon's vertical middle. */
function insidePoint(outer: readonly Vec2[], holes: readonly Vec2[][]): Vec2 {
  const ok = (p: Vec2) => pointInPolygon(p, outer) && !holes.some((h) => pointInPolygon(p, h))
  const c = centroid(outer)
  if (ok(c)) return c
  let y0 = Infinity
  let y1 = -Infinity
  for (const p of outer) {
    y0 = Math.min(y0, p[1])
    y1 = Math.max(y1, p[1])
  }
  for (const f of [0.5, 0.33, 0.66, 0.2, 0.8, 0.1, 0.9]) {
    const y = y0 + (y1 - y0) * f
    const xs: number[] = []
    const rings = [outer, ...holes]
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]
        const b = ring[(i + 1) % ring.length]
        if (a[1] > y !== b[1] > y) xs.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]))
      }
    }
    xs.sort((p, q) => p - q)
    let best: Vec2 | null = null
    let bestW = 0
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const mid: Vec2 = [(xs[i] + xs[i + 1]) / 2, y]
      const w = xs[i + 1] - xs[i]
      if (w > bestW && ok(mid)) {
        bestW = w
        best = mid
      }
    }
    if (best) return best
  }
  return c
}

/** The closed regions of the sketch, largest first. */
export function findRegions(sketch: Pick<Sketch, 'entities'>): Region[] {
  const curves = curvesOf(sketch)
  if (curves.length === 0) return []
  const { vertices, edges: all } = buildGraph(curves)
  let edges = pruneDangling(all)
  let loops: TracedLoop[] = []
  for (let guard = 0; guard < 64; guard++) {
    const result = trace(vertices, edges)
    if (typeof result === 'number') {
      edges = pruneDangling(edges.filter((_, i) => i !== result))
      continue
    }
    loops = result
    break
  }
  // A face of no area is two stretches lying on each other — a sliver a
  // crossing of two nearly coincident pieces leaves — and not a region.
  const faces = loops.filter((l) => l.area > 1e-4)
  const outers = loops.filter((l) => l.area < -1e-4)
  // A clockwise loop is the outside of a component; inside another
  // component's face it is a hole of the smallest such face.
  // A face of the loop's own component is never its host, and sharing an
  // edge is not the test: where two outlines cross, the face in the
  // middle touches the outside at corners only, and the probe — a corner
  // of the outside — lies on its boundary.
  const { find, union } = makeUnionFind(vertices.length)
  for (const l of loops) for (const h of l.halves) union(h.from, h.to)
  const holesOf = new Map<TracedLoop, TracedLoop[]>()
  for (const o of outers) {
    const probe = o.polygon[0]
    const component = find(o.halves[0].from)
    let host: TracedLoop | null = null
    for (const f of faces) {
      if (find(f.halves[0].from) === component) continue
      if (pointInPolygon(probe, f.polygon) && (!host || f.area < host.area)) host = f
    }
    if (host) {
      const list = holesOf.get(host)
      if (list) list.push(o)
      else holesOf.set(host, [o])
    }
  }
  const regions: Region[] = faces.map((f) => {
    const holes = holesOf.get(f) ?? []
    const outerPieces = piecesOf(f, edges, sketch)
    const ids = Array.from(new Set(outerPieces.map((p) => p.entity))).sort((a, b) => a - b)
    const c = centroid(f.polygon)
    // The middle of a shape drawn about an axis is a rounding error either
    // side of it: no sign, so the key does not turn with the error.
    const at = (x: number) => (Math.abs(x) < 0.005 ? '0.00' : x.toFixed(2))
    return {
      key: `${ids.join('.')}@${at(c[0])},${at(c[1])}`,
      outer: { pieces: outerPieces, polygon: f.polygon },
      holes: holes.map((h) => ({ pieces: piecesOf(h, edges, sketch), polygon: h.polygon })),
      area: f.area - holes.reduce((s, h) => s + Math.abs(h.area), 0),
      inside: insidePoint(
        f.polygon,
        holes.map((h) => h.polygon),
      ),
    }
  })
  return regions.sort((a, b) => b.area - a.area)
}

/** What a region's key was made of: the entities round its outer loop and
 *  where its middle was. Null for a key not of this shape. */
export function parseRegionKey(key: string): { ids: number[]; centroid: Vec2 } | null {
  const at = key.lastIndexOf('@')
  if (at < 0) return null
  const ids = key
    .slice(0, at)
    .split('.')
    .map(Number)
    .filter((n) => Number.isFinite(n))
  const [x, y] = key.slice(at + 1).split(',').map(Number)
  if (ids.length === 0 || !Number.isFinite(x) || !Number.isFinite(y)) return null
  return { ids, centroid: [x, y] }
}

/**
 * The region a key names in the sketch as it stands now. A pick is a
 * fingerprint, not a pointer: the sketch under it is edited — a corner
 * dragged, a dimension typed, a side replaced — and the same face has to
 * come back. The same key first; then the face bounded by the same pieces
 * (its middle moved); then the face the old middle now lies in that shares
 * pieces with the old one (a side was swapped); then the face sharing most
 * of its pieces, if at least half. Null when nothing of it is left.
 */
export function matchRegion(key: string, regions: readonly Region[]): Region | null {
  const exact = regions.find((r) => r.key === key)
  if (exact) return exact
  const was = parseRegionKey(key)
  if (!was) return null
  const wasIds = new Set(was.ids)
  const idsOf = (r: Region) => new Set(r.outer.pieces.map((p) => p.entity))
  const shared = (ids: Set<number>) => {
    let n = 0
    for (const id of ids) if (wasIds.has(id)) n++
    return n
  }
  const dist = (r: Region) => len2(sub2(centroid(r.outer.polygon), was.centroid))
  const same = regions.filter((r) => {
    const ids = idsOf(r)
    return ids.size === wasIds.size && shared(ids) === ids.size
  })
  if (same.length > 0) return same.sort((a, b) => dist(a) - dist(b))[0]
  const under = regions
    .filter((r) => pointInPolygon(was.centroid, r.outer.polygon) && !r.holes.some((h) => pointInPolygon(was.centroid, h.polygon)))
    .map((r) => ({ r, n: shared(idsOf(r)) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || a.r.area - b.r.area)
  if (under.length > 0) return under[0].r
  let best: { r: Region; score: number } | null = null
  for (const r of regions) {
    const ids = idsOf(r)
    const n = shared(ids)
    const score = n / (ids.size + wasIds.size - n)
    if (score >= 0.5 && (!best || score > best.score || (score === best.score && dist(r) < dist(best.r)))) best = { r, score }
  }
  return best?.r ?? null
}

/** The regions a list of keys names now, each once, in the keys' order —
 *  see matchRegion. */
export function matchRegions(keys: readonly string[], regions: readonly Region[]): Region[] {
  const out: Region[] = []
  for (const key of keys) {
    const r = matchRegion(key, regions)
    if (r && !out.includes(r)) out.push(r)
  }
  return out
}

/** The regions a pick kept as it was given (RegionPick, features.ts)
 *  names in the sketch as it stands: every region, the largest, or each
 *  key's region (matchRegion) and each point's (regionAt), each once —
 *  null where one of them names nothing now, or the sketch has none. */
export function regionsByPick(given: 'all' | 'largest' | readonly (string | { at: Vec2 })[], regions: readonly Region[]): Region[] | null {
  if (regions.length === 0) return null
  if (given === 'all') return [...regions]
  if (given === 'largest') return [regions.reduce((a, b) => (b.area > a.area ? b : a))]
  const out: Region[] = []
  for (const p of given) {
    const r = typeof p === 'string' ? matchRegion(p, regions) : regionAt(regions, p.at)
    if (!r) return null
    if (!out.includes(r)) out.push(r)
  }
  return out
}

/** How finely a region is sampled for regionByPlace: a grid this many
 *  points a side over its box. */
const PLACE_SAMPLES = 24

/**
 * The region of a sketch as it stands that lies where `was` did: the one
 * covering the most of it, and at least `share` of it — what an edit that
 * remade every piece round a region left in its place, which matchRegion,
 * going by the pieces, cannot find. The cover is sampled on a grid over
 * the old region, holes left out. Null where none covers enough; the
 * regions in `skip` (picked already) are not offered.
 */
export function regionByPlace(was: Region, regions: readonly Region[], skip: ReadonlySet<Region> = new Set(), share = 0.5): Region | null {
  const inside = (r: Region, p: Vec2) => pointInPolygon(p, r.outer.polygon) && !r.holes.some((h) => pointInPolygon(p, h.polygon))
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (const [x, y] of was.outer.polygon) {
    x0 = Math.min(x0, x), x1 = Math.max(x1, x), y0 = Math.min(y0, y), y1 = Math.max(y1, y)
  }
  const points: Vec2[] = []
  for (let i = 0; i < PLACE_SAMPLES; i++)
    for (let j = 0; j < PLACE_SAMPLES; j++) {
      const p: Vec2 = [x0 + ((i + 0.5) / PLACE_SAMPLES) * (x1 - x0), y0 + ((j + 0.5) / PLACE_SAMPLES) * (y1 - y0)]
      if (inside(was, p)) points.push(p)
    }
  if (points.length === 0) points.push(was.inside)
  let best: { r: Region; cover: number } | null = null
  for (const r of regions) {
    if (skip.has(r)) continue
    const cover = points.filter((p) => inside(r, p)).length / points.length
    if (cover >= share && (!best || cover > best.cover)) best = { r, cover }
  }
  return best?.r ?? null
}

/** The keys of a list of picks that name nothing in the sketch now, or a
 *  region an earlier key of the list already names — picks an edit of the
 *  sketch took away, in the keys' order. */
export function lostPicks(keys: readonly string[], regions: readonly Region[]): string[] {
  const taken = new Set<Region>()
  const lost: string[] = []
  for (const key of keys) {
    const r = matchRegion(key, regions)
    if (!r || taken.has(r)) lost.push(key)
    else taken.add(r)
  }
  return lost
}

/** The regions a region fell into when its sketch was edited: those whose
 *  inside lies in it and that are bounded by at least one of its pieces.
 *  A line drawn across a picked face leaves two faces, both its parts; a
 *  circle drawn inside it is a hole in it, and the circle's own face, bound
 *  by none of its pieces, no part of it. */
export function splitParts(was: Region, now: readonly Region[]): Region[] {
  const ids = new Set(was.outer.pieces.map((p) => p.entity))
  const within = (p: Vec2) => pointInPolygon(p, was.outer.polygon) && !was.holes.some((h) => pointInPolygon(p, h.polygon))
  return now.filter((r) => within(r.inside) && r.outer.pieces.some((p) => ids.has(p.entity)))
}

/** The region under a point: the smallest whose outline holds it and none
 *  of whose holes does. */
export function regionAt(regions: readonly Region[], p: Vec2): Region | null {
  let best: Region | null = null
  for (const r of regions) {
    if (!pointInPolygon(p, r.outer.polygon)) continue
    if (r.holes.some((h) => pointInPolygon(p, h.polygon))) continue
    if (!best || r.area < best.area) best = r
  }
  return best
}

/**
 * Picked regions that share a stretch of their boundary merged into one —
 * a circle and two bars drawn across it, nine regions picked, are one
 * outline to the kernel: one face, one prism, no fuse and no seams where
 * the pieces crossed. The stretches the regions share run both ways round
 * them (each loop is traced with its region on the left), and cancel; what
 * is left is linked end to end into loops, a stretch of one piece running
 * on into the next of the same piece made one again. The stretches are cut
 * first at every end any of them has on the same piece, so a region whose
 * side runs on past a crossing still shares the part it shares. Regions
 * that touch at a corner only are left apart, and so is a group whose
 * stretches do not link into one outer loop — a closed spline's stretches
 * run over its seam, and are not merged either. Regions sharing nothing
 * come back as they were.
 */
export function mergeRegions(regions: readonly Region[], sketch: Pick<Sketch, 'entities'>): Region[] {
  if (regions.length < 2) return [...regions]
  const kind = new Map(sketch.entities.map((e) => [e.id, e]))
  const loopsOf = (r: Region) => [r.outer, ...r.holes]
  // The regions on each piece: the ones that may share a stretch of it.
  const { find, union } = makeUnionFind(regions.length)
  const touching = new Map<number, Set<number>>()
  regions.forEach((r, i) => {
    for (const l of loopsOf(r)) for (const p of l.pieces) {
      const e = kind.get(p.entity)
      if (e?.kind === 'spline' && isClosed(e)) continue
      const list = touching.get(p.entity) ?? new Set<number>()
      list.add(i)
      touching.set(p.entity, list)
    }
  })
  const out: Region[] = []
  const groups = new Map<number, number[]>()
  // Regions are joined where one runs a stretch the other runs back.
  for (const [entity, ids] of touching) {
    if (ids.size < 2) continue
    const list = [...ids]
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) if (find(list[a]) !== find(list[b]) && shareStretch(regions[list[a]], regions[list[b]], entity)) union(list[a], list[b])
    }
  }
  regions.forEach((_, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), i]))
  for (const ids of groups.values()) {
    const group = ids.map((i) => regions[i])
    const merged = ids.length > 1 ? mergedOf(group, sketch) : null
    if (merged) out.push(merged)
    else out.push(...group)
  }
  return out
}

/** Whether two regions run a stretch of one piece both ways: some of it in
 *  one, back in the other. */
function shareStretch(a: Region, b: Region, entity: number): boolean {
  const of = (r: Region) => [r.outer, ...r.holes].flatMap((l) => l.pieces.filter((p) => p.entity === entity))
  for (const p of of(a)) {
    for (const q of of(b)) {
      if (Math.sign(p.t1 - p.t0) === Math.sign(q.t1 - q.t0)) continue
      const lo = Math.max(Math.min(p.t0, p.t1), Math.min(q.t0, q.t1))
      const hi = Math.min(Math.max(p.t0, p.t1), Math.max(q.t0, q.t1))
      if (hi - lo > 1e-9) return true
    }
  }
  return false
}

/** One region of a group that share stretches (mergeRegions), or null
 *  where its stretches do not link into one outer loop and its holes. */
function mergedOf(group: readonly Region[], sketch: Pick<Sketch, 'entities'>): Region | null {
  const stretches = group.flatMap((r) => [r.outer, ...r.holes].flatMap((l) => l.pieces))
  // Every end a stretch has on a piece, where it is: the graph's own
  // vertex, so pieces cut there meet exactly.
  const cuts = new Map<number, Map<number, Vec2>>()
  const cutAt = (entity: number, t: number, p: Vec2) => {
    const m = cuts.get(entity) ?? new Map<number, Vec2>()
    for (const known of m.keys()) if (Math.abs(known - t) < 1e-9) return
    m.set(t, p)
    cuts.set(entity, m)
  }
  for (const s of stretches) {
    cutAt(s.entity, s.t0, s.p0)
    cutAt(s.entity, s.t1, s.p1)
  }
  // The stretches cut at every end on their piece, and each bit counted:
  // +1 run forward, −1 back. What both regions run cancels.
  const bits = new Map<string, { entity: number; lo: number; hi: number; net: number }>()
  for (const s of stretches) {
    const [lo, hi] = s.t0 < s.t1 ? [s.t0, s.t1] : [s.t1, s.t0]
    const ts = [...cuts.get(s.entity)!.keys()].filter((t) => t > lo + 1e-9 && t < hi - 1e-9)
    const at = [lo, ...ts.sort((x, y) => x - y), hi]
    for (let i = 0; i + 1 < at.length; i++) {
      const key = `${s.entity}:${at[i].toFixed(9)}`
      const bit = bits.get(key) ?? { entity: s.entity, lo: at[i], hi: at[i + 1], net: 0 }
      bit.net += s.t1 > s.t0 ? 1 : -1
      bits.set(key, bit)
    }
  }
  const pointAt = (entity: number, t: number): Vec2 => {
    for (const [known, p] of cuts.get(entity)!) if (Math.abs(known - t) < 1e-9) return p
    return [NaN, NaN]
  }
  const left: RegionPiece[] = []
  for (const b of bits.values()) {
    if (b.net === 0) continue
    if (Math.abs(b.net) > 1) return null
    const [t0, t1] = b.net > 0 ? [b.lo, b.hi] : [b.hi, b.lo]
    left.push({ entity: b.entity, t0, t1, p0: pointAt(b.entity, t0), p1: pointAt(b.entity, t1) })
  }
  // Linked end to end: each stretch on to the one that starts where it
  // ends — the one, or the merge is not made.
  const near = (a: Vec2, b: Vec2) => len2(sub2(a, b)) <= SNAP
  const used = new Set<RegionPiece>()
  const loops: RegionPiece[][] = []
  for (const start of left) {
    if (used.has(start)) continue
    const loop = [start]
    used.add(start)
    for (let guard = 0; guard <= left.length; guard++) {
      const last = loop[loop.length - 1]
      if (near(last.p1, start.p0)) break
      const next = left.filter((p) => !used.has(p) && near(p.p0, last.p1))
      if (next.length !== 1) return null
      loop.push(next[0])
      used.add(next[0])
    }
    if (!near(loop[loop.length - 1].p1, start.p0)) return null
    loops.push(joinedRuns(loop, sketch))
  }
  const traced = loops.map((pieces) => {
    const polygon = loopSamples(pieces, sketch)
    return { pieces, polygon, area: signedArea2(polygon) }
  })
  const outers = traced.filter((l) => l.area > 1e-4)
  if (outers.length !== 1) return null
  const holes = traced.filter((l) => l.area < -1e-4)
  const largest = group.reduce((a, b) => (b.area > a.area ? b : a))
  return {
    key: group.map((r) => r.key).join('+'),
    outer: { pieces: outers[0].pieces, polygon: outers[0].polygon },
    holes: holes.map((h) => ({ pieces: h.pieces, polygon: h.polygon })),
    area: group.reduce((s, r) => s + r.area, 0),
    inside: largest.inside,
  }
}

/** A loop's stretches with each run along one piece made one stretch: the
 *  next starting where the last ends on the same piece, the same way —
 *  round a circle's seam too — so no seam is left where a piece crossing
 *  it was merged away. */
function joinedRuns(loop: readonly RegionPiece[], sketch: Pick<Sketch, 'entities'>): RegionPiece[] {
  const kind = new Map(sketch.entities.map((e) => [e.id, e.kind]))
  /** How far `t` lies on from `end` on the piece: 0 where they are one
   *  place, a whole turn across a circle's seam; null where they are not. */
  const across = (entity: number, end: number, t: number): number | null => {
    if (Math.abs(end - t) < 1e-9) return 0
    if (kind.get(entity) !== 'circle') return null
    const turns = Math.round((end - t) / (2 * Math.PI))
    return turns !== 0 && Math.abs(end - t - turns * 2 * Math.PI) < 1e-9 ? turns * 2 * Math.PI : null
  }
  const sameWay = (a: RegionPiece, b: RegionPiece) => Math.sign(a.t1 - a.t0) === Math.sign(b.t1 - b.t0)
  const out: RegionPiece[] = []
  for (const p of loop) {
    const last = out[out.length - 1]
    const shift = last && last.entity === p.entity && sameWay(last, p) ? across(p.entity, last.t1, p.t0) : null
    if (last && shift !== null) {
      last.t1 = p.t1 + shift
      last.p1 = p.p1
    } else out.push({ ...p })
  }
  if (out.length > 1) {
    const first = out[0]
    const last = out[out.length - 1]
    const shift = first.entity === last.entity && sameWay(first, last) ? across(first.entity, last.t1, first.t0) : null
    if (shift !== null) {
      first.t0 = last.t0 - shift
      first.p0 = last.p0
      out.pop()
    }
  }
  return out
}

/** Points round a loop of stretches, for its area and its hit tests: each
 *  stretch's start, and points along an arc or a spline. */
function loopSamples(pieces: readonly RegionPiece[], sketch: Pick<Sketch, 'entities'>): Vec2[] {
  const out: Vec2[] = []
  for (const p of pieces) {
    const e = sketch.entities.find((x) => x.id === p.entity)
    out.push(p.p0)
    if (e?.kind === 'arc' || e?.kind === 'circle') {
      const n = Math.max(2, Math.ceil((Math.abs(p.t1 - p.t0) / TURN) * ARC_SAMPLES_PER_TURN))
      for (let i = 1; i < n; i++) out.push(arcPoint(e, p.t0 + ((p.t1 - p.t0) * i) / n))
    } else if (e?.kind === 'spline') {
      const fit = splineCurve(e)
      for (let i = 1; i < SPLINE_SAMPLES_PER_SEGMENT; i++) out.push(splineAt(fit, p.t0 + ((p.t1 - p.t0) * i) / SPLINE_SAMPLES_PER_SEGMENT))
    }
  }
  return out
}

/** A loop's stretches as exact geometry, each ending exactly where the
 *  next begins: the ends are the graph's vertices, the middle of an arc is
 *  the arc's own — so a fillet the solver left a micron short of its side
 *  is drawn through the shared corner and still round. */
export function loopGeometry(loop: RegionLoop, sketch: Pick<Sketch, 'entities'>): ProfilePiece2[] {
  const out: ProfilePiece2[] = []
  for (const p of loop.pieces) {
    const e = sketch.entities.find((x) => x.id === p.entity)
    if (!e) continue
    if (e.kind === 'line') {
      out.push({ kind: 'line', a: p.p0, b: p.p1 })
    } else if (e.kind === 'arc' || e.kind === 'circle') {
      if (loop.pieces.length === 1 && Math.abs(Math.abs(p.t1 - p.t0) - 2 * Math.PI) < 1e-6) {
        out.push({ kind: 'circle', c: e.c, r: e.r })
      } else {
        out.push({ kind: 'arc', a: p.p0, m: arcPoint(e, (p.t0 + p.t1) / 2), b: p.p1 })
      }
    } else if (e.kind === 'spline') {
      // The stretch itself, its ends on the graph's vertices as a line's are.
      const stretch = splineStretch(splineCurve(e), p.t0, p.t1)
      if (!stretch) continue
      stretch.poles[0] = [p.p0[0], p.p0[1]]
      stretch.poles[stretch.poles.length - 1] = [p.p1[0], p.p1[1]]
      out.push({ kind: 'spline', ...stretch })
    }
  }
  return out
}

/** A feature's picks as they stood before an edit of their sketch: the
 *  sketch, and each picked region's key, area and a point inside it. */
export interface PicksSeen {
  sketchId: number
  regions: { key: string; area: number; inside: Vec2 }[]
}

/** How a feature's picks stand, to be told against after an edit. */
export const picksSeen = (sketchId: number, regions: readonly Region[]): PicksSeen => ({ sketchId, regions: regions.map((r) => ({ key: r.key, area: r.area, inside: r.inside })) })

/** A pick grown by more than this share of its area in an edit is said. */
const GREW_SHARE = 0.01

/**
 * What an edit of a sketch says of a feature on it whose picked region
 * grew: it now covers another feature's pick on the same sketch — a point
 * inside that pick as it was lies in it, and the two named different
 * regions then — or its area went up by more than 1 %. Either is a
 * junction come apart: a piece's end slid off the piece it ended on, and
 * two regions became one without a word. Null when neither, or with no
 * picks before to go by.
 */
export function picksGrew(name: string, was: PicksSeen | undefined, now: readonly Region[], others: readonly { name: string; seen: PicksSeen }[]): string | null {
  if (!was || now.length === 0) return null
  const before = was.regions.reduce((a, r) => a + r.area, 0)
  const after = now.reduce((a, r) => a + r.area, 0)
  const keys = new Set(was.regions.map((r) => r.key))
  const fmt = (x: number) => x.toFixed(1)
  const at = (p: Vec2) => `(${fmt(p[0])}, ${fmt(p[1])})`
  const holds = (r: Region, p: Vec2) => pointInPolygon(p, r.outer.polygon) && !r.holes.some((h) => pointInPolygon(p, h.polygon))
  for (const r of now) {
    const taken = others.filter((o) => o.seen.sketchId === was.sketchId && o.seen.regions.some((x) => !keys.has(x.key) && holds(r, x.inside)))
    if (taken.length === 0) continue
    const parts = taken.map((o) => `${o.name} ${fmt(o.seen.regions.reduce((a, x) => a + x.area, 0))}`).join(' + ')
    // units-ok: build message, also the agent's answer.
    return `${name}’s region at ${at(r.inside)} now takes in ${taken.map((o) => `${o.name}’s`).join(' and ')} (${name} ${fmt(before)} + ${parts} mm²): a junction came apart — a piece’s end slid off the piece it ended on (the sketch’s offPiece says which). Hold it there, or pick the regions again.`
  }
  // units-ok: build message, also the agent's answer.
  if (before > 0 && after > before * (1 + GREW_SHARE)) return `${name}’s region at ${at(now[0].inside)} grew from ${fmt(before)} to ${fmt(after)} mm²: a junction may have come apart — a piece’s end slid off the piece it ended on (the sketch’s offPiece says which). Pick the region again if the sketch was meant to grow.`
  return null
}

/**
 * What a feature's row says when a region it picks is one another extrude
 * or revolve on the same sketch picks too — after an edit, two regions that
 * ran into one, each feature's pick taken over to the merged region: a
 * junction come apart. Null when no region is picked twice.
 */
export function samePick(name: string, mine: readonly Region[], others: readonly { name: string; regions: readonly Region[] }[]): string | null {
  for (const r of mine) {
    const also = others.filter((o) => o.regions.includes(r))
    if (also.length === 0) continue
    // units-ok: build message, also the agent's answer.
    return `${name} picks the same region of its sketch as ${also.map((o) => o.name).join(' and ')} (at (${r.inside[0].toFixed(1)}, ${r.inside[1].toFixed(1)}), ${r.area.toFixed(1)} mm²): if two regions ran into one, a junction came apart — a piece’s end slid off the piece it ended on (the sketch’s offPiece says which). Hold it there, or pick the regions again.`
  }
  return null
}

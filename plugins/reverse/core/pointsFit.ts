// SPDX-License-Identifier: AGPL-3.0-only
// Sketch pieces fitted to points typed in — a corner's profile read off a
// drawing's table, seven points where a slice has seven hundred. The fitter
// the slice chains go through (segment.ts) was made for dense, noisy runs:
// it reads a chain's spacing and scatter off it, and an arc wants five
// points at least. So the typed points are first laid along a smooth curve
// through them — a centripetal Catmull–Rom, which neither loops nor cusps
// between points spaced unevenly — and that dense run is cut as a slice is.
// The curve between the points is only a guess, though, and the pieces cut
// from it sit on the guess rather than on the points. So the pieces are
// then fitted again to the typed points alone, joined as the cut joined
// them: a chain of lines and arcs end to end as one path — where it starts,
// the way it sets off, each piece's length and curvature — from several
// starts, the best kept; anything else by the solver on a sheet of its own.
// Where an end of the chain lies on the side of the points' box — the end
// of a corner on the part's flat side — and the fit carries past that side,
// the end is held on its point running along it, as the outline does
// there. What the sketch keeps behind each piece is the piece itself
// sampled densely: the solve then holds the fit where it was settled, and
// the deviation is read at the typed points only.

import { solveLinear } from '../../../src/core/fit/linalg'
import { mulberry32 } from '../../../src/core/fit/ransac'
import type { Vec2 } from '../../../src/core/flat/types'
import type { PlacedSegment } from './segment'
import { addConstraint, addEntity, anchorPoint, arcAngleOf, type AnchorAt, cloneSketch, constraintEntities, entityOf, entityPolyline, nearestOnEntity, type Sketch, type SketchEntity, unwindAngle } from './sketch'
import { splineCurve, splineSamples } from './sketchSpline'
import { solveSketch } from './solver'

/** The scatter typed points are given: half the last place of a drawing's
 *  hundredths. It weighs them against the relations, and is the floor of
 *  what a candidate relation is measured in. */
export const POINTS_SCATTER_MM = 0.005
/** The tolerance the smooth run through typed points is cut at, unless
 *  one is given, mm — and a thousandth of the points' span, where that is
 *  more: the run between the points is a guess, and cut at a slice's own
 *  tolerance it comes out in more pieces than the outline has. */
export const POINTS_TOLERANCE_MM = 0.1

/** The tolerance a chain of typed points is cut at by default. */
export function pointsTolerance(points: readonly Vec2[]): number {
  const box = boxOf(points)
  return Math.max(POINTS_TOLERANCE_MM, 1e-3 * Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1]))
}

/** How far past the points' box a fit may run before it is said to leave
 *  it, mm — and before an end on that box's side is held along it. */
export const OVERSHOOT_MM = 0.001
/** About how far apart the points of the smooth run through the typed
 *  points lie, mm — and the most points it has: a run of a metre is not
 *  sampled every twentieth of a millimetre. */
const DENSE_MM = 0.05
const DENSE_MAX = 600
/** The fewest points the run has between two typed points. */
const DENSE_PER_SPAN = 12
/** How densely a piece is sampled for the points kept behind it, mm, and
 *  the fewest and the most it keeps (the solver reads 240 at most). */
const KEPT_MM = 0.05
const KEPT_MIN = 16
const KEPT_MAX = 200
/** How many times the typed points are shared out among the pieces again
 *  and the pieces settled on them. */
const ROUNDS = 4

/** A side of a box on the sheet: past the most u, the least u, the most v,
 *  the least v. */
export type BoxSide = 'u+' | 'u-' | 'v+' | 'v-'

/** The box round some points. */
export function boxOf(points: readonly Vec2[]): { min: Vec2; max: Vec2 } {
  const min: Vec2 = [Infinity, Infinity]
  const max: Vec2 = [-Infinity, -Infinity]
  for (const p of points) {
    min[0] = Math.min(min[0], p[0])
    min[1] = Math.min(min[1], p[1])
    max[0] = Math.max(max[0], p[0])
    max[1] = Math.max(max[1], p[1])
  }
  return { min, max }
}

/**
 * A dense run along a centripetal Catmull–Rom through the points, in order
 * — round to the first point again, and ending on it, when closed. An open
 * run's ends carry on along their first and last chords. Each span between
 * two typed points is sampled by its length, DENSE_PER_SPAN points at the
 * fewest; every typed point is on the run.
 */
export function pointsInterpolant(points: readonly Vec2[], closed: boolean): Vec2[] {
  const n = points.length
  if (n < 2) return points.map((p): Vec2 => [p[0], p[1]])
  const at = (i: number): Vec2 => {
    if (closed) return points[((i % n) + n) % n]
    if (i < 0) return [2 * points[0][0] - points[1][0], 2 * points[0][1] - points[1][1]]
    if (i >= n) return [2 * points[n - 1][0] - points[n - 2][0], 2 * points[n - 1][1] - points[n - 2][1]]
    return points[i]
  }
  const spans = closed ? n : n - 1
  let total = 0
  for (let i = 0; i < spans; i++) total += Math.hypot(at(i + 1)[0] - at(i)[0], at(i + 1)[1] - at(i)[1])
  const step = Math.max(DENSE_MM, total / DENSE_MAX)
  const knot = (a: Vec2, b: Vec2) => Math.max(Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])), 1e-9)
  const out: Vec2[] = []
  for (let i = 0; i < spans; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)]
    const t1 = knot(p0, p1)
    const t2 = t1 + knot(p1, p2)
    const t3 = t2 + knot(p2, p3)
    const count = Math.max(DENSE_PER_SPAN, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step))
    // Barry and Goldman's pyramid, the knots at 0, t1, t2, t3.
    const lerp = (a: Vec2, b: Vec2, ta: number, tb: number, t: number): Vec2 => {
      const w = (t - ta) / (tb - ta)
      return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w]
    }
    for (let k = 0; k < count; k++) {
      const t = t1 + ((t2 - t1) * k) / count
      const a1 = lerp(p0, p1, 0, t1, t)
      const a2 = lerp(p1, p2, t1, t2, t)
      const a3 = lerp(p2, p3, t2, t3, t)
      out.push(k === 0 ? [p1[0], p1[1]] : lerp(lerp(a1, a2, 0, t2, t), lerp(a2, a3, t1, t3, t), t1, t2, t))
    }
  }
  const last = closed ? points[0] : points[n - 1]
  out.push([last[0], last[1]])
  return out
}

/** How far each typed point lies off the nearest of the pieces — the
 *  pieces themselves, not the lines and circles they run on — mm, in the
 *  points' order. */
export function deviationsAt(pieces: readonly SketchEntity[], points: readonly Vec2[]): number[] {
  return points.map((p) => (pieces.length === 0 ? Infinity : Math.min(...pieces.map((e) => nearestOnEntity(e, p).dist))))
}

/** Where pieces run past the box of the points the furthest: how far, mm,
 *  past which side, and where — null where they keep within OVERSHOOT_MM
 *  of it. */
export function overshootOf(pieces: readonly SketchEntity[], points: readonly Vec2[]): { mm: number; side: BoxSide; at: Vec2 } | null {
  const box = boxOf(points)
  let worst: { mm: number; side: BoxSide; at: Vec2 } | null = null
  for (const e of pieces) {
    for (const p of entityPolyline(e, 720)) {
      const past: [BoxSide, number][] = [
        ['u+', p[0] - box.max[0]],
        ['u-', box.min[0] - p[0]],
        ['v+', p[1] - box.max[1]],
        ['v-', box.min[1] - p[1]],
      ]
      for (const [side, mm] of past) if (mm > OVERSHOOT_MM && mm > (worst?.mm ?? 0)) worst = { mm, side, at: [p[0], p[1]] }
    }
  }
  return worst
}

/** The points a piece keeps behind it once fitted to typed points: the
 *  piece itself, sampled evenly along it. */
export function samplesOf(e: SketchEntity): Vec2[] {
  if (e.kind === 'line') {
    const len = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1])
    const n = Math.min(KEPT_MAX, Math.max(KEPT_MIN, Math.ceil(len / KEPT_MM)))
    return Array.from({ length: n + 1 }, (_, i): Vec2 => [e.a[0] + ((e.b[0] - e.a[0]) * i) / n, e.a[1] + ((e.b[1] - e.a[1]) * i) / n])
  }
  if (e.kind === 'arc' || e.kind === 'circle') {
    const sweep = e.kind === 'arc' ? e.sweep : 2 * Math.PI
    const start = e.kind === 'arc' ? e.start : 0
    const n = Math.min(KEPT_MAX, Math.max(KEPT_MIN, Math.ceil((Math.abs(sweep) * e.r) / KEPT_MM)))
    const last = e.kind === 'arc' ? n : n - 1
    return Array.from({ length: last + 1 }, (_, i): Vec2 => [e.c[0] + e.r * Math.cos(start + (sweep * i) / n), e.c[1] + e.r * Math.sin(start + (sweep * i) / n)])
  }
  if (e.kind === 'spline') {
    const fit = splineCurve(e)
    const spans = Math.max(1, e.closed ? e.pts.length : e.pts.length - 1)
    const per = Math.max(4, Math.floor(KEPT_MAX / spans))
    const out = splineSamples(fit, per).map((s): Vec2 => [s.p[0], s.p[1]])
    return e.closed ? out.slice(0, -1) : out
  }
  return []
}

/** A piece with one end moved along its own line or circle to the foot of
 *  `p` — the line or the circle as it is. A spline's end is its own. */
function endTo(e: SketchEntity, at: AnchorAt, p: Vec2): SketchEntity {
  if (e.kind === 'line') {
    const dx = e.b[0] - e.a[0]
    const dy = e.b[1] - e.a[1]
    const ll = dx * dx + dy * dy
    if (!(ll > 0)) return e
    const t = ((p[0] - e.a[0]) * dx + (p[1] - e.a[1]) * dy) / ll
    const foot: Vec2 = [e.a[0] + dx * t, e.a[1] + dy * t]
    return at === 'a' ? { ...e, a: foot } : at === 'b' ? { ...e, b: foot } : e
  }
  if (e.kind !== 'arc') return e
  const two = 2 * Math.PI
  const angle = arcAngleOf(e, p)
  if (at === 'a') {
    const end = e.start + e.sweep
    const sweep = unwindAngle(end, angle) - angle
    return sweep > 1e-9 && sweep < two - 1e-9 ? { ...e, start: angle, sweep } : e
  }
  if (at === 'b') {
    const sweep = unwindAngle(angle, e.start) - e.start
    return sweep > 1e-9 && sweep < two - 1e-9 ? { ...e, sweep } : e
  }
  return e
}

/** One end of a chain fitted to typed points: the piece and anchor it is,
 *  and the typed point it stands for. */
interface ChainEnd {
  end: 'start' | 'end'
  piece: number
  at: AnchorAt
  point: Vec2
}

/** An end of the chain held along a side of the points' box, as the answer
 *  says it. */
export interface HeldAlong {
  end: 'start' | 'end'
  side: BoxSide
}

/** Which side of the box an end's point lies on, the end piece carrying
 *  past it the furthest — null where it lies on none, or the piece keeps
 *  within the box there. */
function sidePassed(e: SketchEntity, p: Vec2, box: { min: Vec2; max: Vec2 }): BoxSide | null {
  const on: [BoxSide, boolean, (q: Vec2) => number][] = [
    ['u+', p[0] >= box.max[0], (q) => q[0] - box.max[0]],
    ['u-', p[0] <= box.min[0], (q) => box.min[0] - q[0]],
    ['v+', p[1] >= box.max[1], (q) => q[1] - box.max[1]],
    ['v-', p[1] <= box.min[1], (q) => box.min[1] - q[1]],
  ]
  const line = entityPolyline(e, 720)
  let best: { side: BoxSide; mm: number } | null = null
  for (const [side, isOn, past] of on) {
    if (!isOn) continue
    const mm = Math.max(...line.map(past))
    if (mm > OVERSHOOT_MM && mm > (best?.mm ?? 0)) best = { side, mm }
  }
  return best?.side ?? null
}

/** An end held on its point, running along the side of the box the point
 *  lies on, on the sheet of its own: a fixed construction line along that
 *  side from the point, the end on its start and an arc or a spline
 *  tangent to it there — so the piece touches the side where the outline
 *  meets it and turns back. A line's end is only held on the point. */
function holdAlong(scratch: Sketch, end: ChainEnd, side: BoxSide): void {
  const e = entityOf(scratch, end.piece)!
  const upright = side === 'u+' || side === 'u-'
  const p = end.point
  const guide = addEntity(scratch, { kind: 'line', a: [p[0], p[1]], b: upright ? [p[0], p[1] + 1] : [p[0] + 1, p[1]], construction: true, fixed: true })
  addConstraint(scratch, { kind: 'coincident', p: { entity: e.id, at: end.at }, q: { entity: guide, at: 'a' } })
  if (e.kind === 'arc' || e.kind === 'spline') addConstraint(scratch, { kind: 'tangent', a: e.id, b: guide })
}

// ---- a joined chain fitted as a path ------------------------------------------
//
// A chain whose pieces all meet end to end is a path: where it starts, the
// way it sets off, and for each piece how far it runs and how it bends (an
// arc's curvature, signed, a line's none) — and at a corner, how far the
// way turns there. Fitted so, a piece's ends slide along with its
// neighbours' and the tangencies hold by themselves; each typed point is
// measured to the nearest piece itself, not the line or circle it runs on,
// so a point is never held by a piece it lies past the end of. Levenberg–
// Marquardt, the Jacobian by finite differences: a path has a few dozen
// numbers at most.

/** A piece of a path: a line or an arc, its curvature (1/mm, positive
 *  turning left), its length, and the turn at a corner before it. */
interface PathPiece {
  kind: 'line' | 'arc'
  k: number
  s: number
  turn: number
}

/** A path as it is walked: each piece laid as a sketch piece, the anchor
 *  it is walked from and to, and its ends and the way it runs at them. */
interface Walked {
  e: SketchEntity
  from: 'a' | 'b'
  to: 'a' | 'b'
  p0: Vec2
  p1: Vec2
  h0: number
  h1: number
}

/** A curvature this small is a straight run, as far as walking it goes. */
const FLAT_K = 1e-9
/** The flattest an arc of a path is fitted, 1/mm: a radius of 100 m. */
const FLATTEST_K = 1e-5
/** What a held thing weighs against a typed point's miss, by the steps it
 *  is weighed in at. */
const PATH_HOLD_STEPS = [1, 30, 1e3]
/** How finely a piece is read for running past a side of the box it is
 *  kept within, steps a full turn. */
const WITHIN_STEPS = 240
/** How far a path's whole turn may come off the cut's, radians. */
const TURN_SLACK = Math.PI / 4
/** The Levenberg–Marquardt steps a path fit is allowed at each weight. */
const PATH_ITERATIONS = 150
/** A tangent or a joint to a piece already there is held where the chain
 *  sets off within this of that piece's way, degrees — as corners take it
 *  (corners.ts). */
const LAND_TANGENT_DEG = 20

/** A path's pieces laid down from `start`, setting off at `heading`. */
function walk(start: Vec2, heading: number, pieces: readonly PathPiece[], ids: readonly number[]): Walked[] {
  const out: Walked[] = []
  let p = start
  let h = heading
  pieces.forEach((q, i) => {
    h += q.turn
    const h1 = h + (q.kind === 'arc' ? q.k * q.s : 0)
    let w: Walked
    if (q.kind === 'line' || Math.abs(q.k) < FLAT_K) {
      const end: Vec2 = [p[0] + q.s * Math.cos(h), p[1] + q.s * Math.sin(h)]
      const e: SketchEntity = q.kind === 'line' ? { id: ids[i], kind: 'line', a: p, b: end } : { id: ids[i], kind: 'arc', c: [p[0] - Math.sin(h) / FLAT_K, p[1] + Math.cos(h) / FLAT_K], r: 1 / FLAT_K, start: h - Math.PI / 2, sweep: q.s * FLAT_K }
      w = { e, from: 'a', to: 'b', p0: p, p1: end, h0: h, h1: h }
    } else {
      const c: Vec2 = [p[0] - Math.sin(h) / q.k, p[1] + Math.cos(h) / q.k]
      const end: Vec2 = [c[0] + Math.sin(h1) / q.k, c[1] - Math.cos(h1) / q.k]
      const r = 1 / Math.abs(q.k)
      const sweep = Math.abs(q.k * q.s)
      w =
        q.k > 0
          ? { e: { id: ids[i], kind: 'arc', c, r, start: h - Math.PI / 2, sweep }, from: 'a', to: 'b', p0: p, p1: end, h0: h, h1 }
          : { e: { id: ids[i], kind: 'arc', c, r, start: h1 + Math.PI / 2, sweep }, from: 'b', to: 'a', p0: p, p1: end, h0: h, h1 }
    }
    out.push(w)
    p = w.p1
    h = h1
  })
  return out
}

/** How far a point lies off a walked path, signed by the side of it (left
 *  positive): to the nearest of its pieces. */
function offPath(path: readonly Walked[], q: Vec2): number {
  let best = Infinity
  let signed = 0
  for (const w of path) {
    const { point, dist } = nearestOnEntity(w.e, q)
    if (dist >= best) continue
    best = dist
    // The way the piece runs at its foot.
    let t: Vec2
    if (w.e.kind === 'arc') {
      const rx = point[0] - w.e.c[0]
      const ry = point[1] - w.e.c[1]
      t = w.from === 'a' ? [-ry, rx] : [ry, -rx]
    } else t = [Math.cos(w.h0), Math.sin(w.h0)]
    const side = t[0] * (q[1] - point[1]) - t[1] * (q[0] - point[0])
    signed = side < 0 ? -dist : dist
  }
  return signed
}

/** The difference of two angles, brought into (−π, π]. */
function angleOff(a: number, b: number): number {
  let d = (a - b) % (2 * Math.PI)
  if (d <= -Math.PI) d += 2 * Math.PI
  if (d > Math.PI) d -= 2 * Math.PI
  return d
}

/** What a path's ends are held to: a point, and the way it runs there —
 *  or, for a free end, the typed point it stops at: the path neither runs
 *  on past its foot nor stops short of it. */
interface PathEnd {
  point?: Vec2
  heading?: number
  stop?: Vec2
}

/** A path to fit: its pieces as they were cut, where it starts and sets
 *  off, which joints are corners (corner[i]: the one before piece i; on a
 *  closed path corner[0] is where it closes), whether it closes, what its
 *  ends are held to, and lines held level or upright (by index). */
interface PathFit {
  start: Vec2
  heading: number
  pieces: PathPiece[]
  corner: boolean[]
  closed: boolean
  head: PathEnd
  tail: PathEnd
  level: Map<number, 'horizontal' | 'vertical'>
  /** Sides of the points' box the path is kept within: those an end is
   *  held along. */
  within?: { box: { min: Vec2; max: Vec2 }; sides: BoxSide[] }
}

/** The numbers a path is fitted by, and the path back from them. */
function pathParams(f: PathFit): { x: number[]; read: (x: ArrayLike<number>) => { start: Vec2; heading: number; pieces: PathPiece[] } } {
  const x: number[] = []
  const freeStart = !f.head.point
  const freeHeading = f.head.heading === undefined
  if (freeStart) x.push(f.start[0], f.start[1])
  if (freeHeading) x.push(f.heading)
  const slots = f.pieces.map((q, i) => {
    const at = x.length
    if (q.kind === 'arc') x.push(q.k)
    x.push(q.s)
    const corner = i > 0 && f.corner[i]
    if (corner) x.push(q.turn)
    return { at, corner }
  })
  return {
    x,
    read: (xs) => {
      let k = 0
      const start: Vec2 = freeStart ? [xs[k++], xs[k++]] : f.head.point!
      const heading = freeHeading ? xs[k++] : f.head.heading!
      const pieces = f.pieces.map((q, i): PathPiece => {
        let j = slots[i].at
        // An arc stays one: flat as it may come, never straight.
        const raw = q.kind === 'arc' ? xs[j++] : 0
        const kk = q.kind === 'arc' ? (raw < 0 ? -1 : 1) * Math.max(Math.abs(raw), FLATTEST_K) : 0
        const s = xs[j++]
        const turn = slots[i].corner ? xs[j++] : 0
        return { kind: q.kind, k: kk, s, turn }
      })
      return { start, heading, pieces }
    },
  }
}

/**
 * A path fitted to typed points: each point's miss off the path, and —
 * weighed far above them — what its ends are held to, a closed path meeting
 * itself (tangent, where its closing joint is no corner), the level and
 * upright lines, the sides it is kept within, its whole turn kept about
 * the start's, and every piece kept longer than nothing. Returns the
 * fitted path, laid down, the numbers it was laid from, and what it
 * misses by (the sum of the squares).
 */
function fitPath(f: PathFit, points: readonly Vec2[], ids: readonly number[]): { walked: Walked[]; start: Vec2; heading: number; pieces: PathPiece[]; cost: number } {
  const { x: x0, read } = pathParams(f)
  const total = f.pieces.reduce((a, q) => a + q.s, 0)
  const scale = Math.max(total / Math.max(1, f.pieces.length), 1e-3)
  const shortest = Math.max(1e-3, total * 1e-4)
  const turning = f.pieces.reduce((a, q) => a + q.turn + (q.kind === 'arc' ? q.k * q.s : 0), 0)
  const residuals = (xs: ArrayLike<number>, hold: number): number[] => {
    const { start, heading, pieces } = read(xs)
    const path = walk(start, heading, pieces, ids)
    const out = points.map((q) => offPath(path, q))
    const first = path[0]
    const last = path[path.length - 1]
    if (f.head.stop) out.push((f.head.stop[0] - first.p0[0]) * Math.cos(first.h0) + (f.head.stop[1] - first.p0[1]) * Math.sin(first.h0))
    if (f.tail.stop) out.push((last.p1[0] - f.tail.stop[0]) * Math.cos(last.h1) + (last.p1[1] - f.tail.stop[1]) * Math.sin(last.h1))
    if (f.tail.point) out.push(hold * (last.p1[0] - f.tail.point[0]), hold * (last.p1[1] - f.tail.point[1]))
    if (f.tail.heading !== undefined) out.push(hold * scale * angleOff(last.h1, f.tail.heading))
    if (f.closed) {
      out.push(hold * (last.p1[0] - start[0]), hold * (last.p1[1] - start[1]))
      if (!f.corner[0]) out.push(hold * scale * angleOff(last.h1, heading))
    }
    for (const [i, kind] of f.level) {
      const h = path[i].h0
      out.push(hold * scale * (kind === 'horizontal' ? Math.sin(h) : Math.cos(h)))
    }
    if (f.within) {
      const { box, sides } = f.within
      for (const w of path) {
        let past = 0
        for (const p of entityPolyline(w.e, WITHIN_STEPS)) for (const side of sides) past = Math.max(past, side === 'u+' ? p[0] - box.max[0] : side === 'u-' ? box.min[0] - p[0] : side === 'v+' ? p[1] - box.max[1] : box.min[1] - p[1])
        out.push(hold * Math.max(0, past))
      }
    }
    // The way the path turns all along, kept to what the cut turned: the
    // points do not tell a path from one that loops round between them.
    const turned = pieces.reduce((a, q) => a + q.turn + (q.kind === 'arc' ? q.k * q.s : 0), 0)
    out.push(hold * scale * Math.max(0, Math.abs(turned - turning) - TURN_SLACK))
    for (const q of pieces) out.push(q.s < shortest ? hold * (shortest - q.s) : 0)
    for (const q of pieces) {
      const sweep = Math.abs(q.k * q.s)
      out.push(sweep > 2 * Math.PI - 0.01 ? hold * scale * (sweep - 2 * Math.PI + 0.01) : 0)
    }
    return out
  }
  const cost = (r: readonly number[]) => r.reduce((a, v) => a + v * v, 0)
  const n = x0.length
  let x = Float64Array.from(x0)
  let c = Infinity
  // The holds weighed in by steps, the path settling on its points first:
  // weighed in all at once they leave it in the first valley it meets.
  for (const hold of PATH_HOLD_STEPS) {
    let r = residuals(x, hold)
    c = cost(r)
    let lambda = 1e-3
    for (let it = 0; it < PATH_ITERATIONS && n > 0; it++) {
      const m = r.length
      const jac = new Float64Array(m * n)
      for (let j = 0; j < n; j++) {
        const h = 1e-7 * Math.max(1, Math.abs(x[j]))
        const xp = Float64Array.from(x)
        xp[j] += h
        const rp = residuals(xp, hold)
        for (let i = 0; i < m; i++) jac[i * n + j] = (rp[i] - r[i]) / h
      }
      const jtj = new Float64Array(n * n)
      const jtr = new Float64Array(n)
      for (let i = 0; i < m; i++) {
        for (let a = 0; a < n; a++) {
          const ja = jac[i * n + a]
          if (ja === 0) continue
          jtr[a] -= ja * r[i]
          for (let b = 0; b < n; b++) jtj[a * n + b] += ja * jac[i * n + b]
        }
      }
      let stepped = false
      for (let tries = 0; tries < 10; tries++) {
        const a = Float64Array.from(jtj)
        for (let d = 0; d < n; d++) a[d * n + d] += lambda * Math.max(jtj[d * n + d], 1e-12)
        const dx = solveLinear(n, a, Float64Array.from(jtr))
        if (!dx) {
          lambda *= 10
          continue
        }
        const xn = x.map((v, j) => v + dx[j])
        const rn = residuals(xn, hold)
        const cn = cost(rn)
        if (Number.isFinite(cn) && cn < c) {
          const gain = c - cn
          x = xn
          r = rn
          c = cn
          lambda = Math.max(lambda / 3, 1e-9)
          stepped = gain > 1e-14 * Math.max(c, 1e-12)
          break
        }
        lambda *= 10
      }
      if (!stepped) break
    }
  }
  const { start, heading, pieces } = read(x)
  return { walked: walk(start, heading, pieces, ids), start, heading, pieces, cost: c }
}

/** How many other starts a path is fitted from, besides the cut's: the
 *  misses of a path have several valleys — three tangent arcs through a
 *  corner come out a near-circle with flat ends, or flatter ends and a
 *  tighter middle — and one start finds the one it lies in. */
const PATH_STARTS = 16
/** The work the starts are allowed, in typed points times pieces times
 *  numbers fitted: past it, fewer starts. */
const PATH_WORK = 40_000

/**
 * fitPath from the start given and from others about it — every piece of
 * the same curvature, the turn shared out evenly; and each piece's
 * curvature scaled by up to four times either way, its length by up to
 * about half, at random (seeded, so a fit comes out the same every time) —
 * the one that misses the points least kept.
 */
function bestPath(f: PathFit, points: readonly Vec2[], ids: readonly number[]): ReturnType<typeof fitPath> {
  let best = fitPath(f, points, ids)
  const total = f.pieces.reduce((a, q) => a + q.s, 0)
  const arcs = f.pieces.filter((q) => q.kind === 'arc')
  const turn = arcs.reduce((a, q) => a + q.k * q.s, 0)
  const arcLength = arcs.reduce((a, q) => a + q.s, 0)
  const numbers = pathParams(f).x.length
  const starts = Math.max(4, Math.min(PATH_STARTS, Math.floor(PATH_WORK / Math.max(1, points.length * f.pieces.length * numbers))))
  const rand = mulberry32(0x5eed + f.pieces.length)
  const tries: PathPiece[][] = []
  if (arcs.length > 1 && arcLength > 0) tries.push(f.pieces.map((q) => (q.kind === 'arc' ? { ...q, k: turn / arcLength } : q)))
  while (tries.length < starts) {
    const scaled = f.pieces.map((q) => ({ ...q, k: q.kind === 'arc' ? q.k * Math.exp((rand() * 2 - 1) * Math.log(4)) : 0, s: q.s * Math.exp((rand() * 2 - 1) * 0.5) }))
    const sum = scaled.reduce((a, q) => a + q.s, 0)
    tries.push(scaled.map((q) => ({ ...q, s: (q.s * total) / sum })))
  }
  for (const pieces of tries) {
    const fit = fitPath({ ...f, pieces }, points, ids)
    if (fit.cost < best.cost) best = fit
  }
  return best
}

// ---- the chain fitted to its points -------------------------------------------

/** The way a piece leaves through one of its ends, an angle: along a line,
 *  round an arc, along a spline's last chord. */
function outwardAt(e: SketchEntity, at: AnchorAt): number | null {
  if (e.kind === 'line') return at === 'b' ? Math.atan2(e.b[1] - e.a[1], e.b[0] - e.a[0]) : at === 'a' ? Math.atan2(e.a[1] - e.b[1], e.a[0] - e.b[0]) : null
  if (e.kind === 'arc') return at === 'b' ? e.start + e.sweep + Math.PI / 2 : at === 'a' ? e.start - Math.PI / 2 : null
  if (e.kind === 'spline' && !e.closed && (at === 'a' || at === 'b')) {
    const line = entityPolyline(e, 720)
    const [p, q] = at === 'b' ? [line[line.length - 2], line[line.length - 1]] : [line[1], line[0]]
    return Math.atan2(q[1] - p[1], q[0] - p[0])
  }
  return null
}

/** A chain's end joined to a piece already there: the chain's piece and
 *  anchor at that end, the piece and the end of it joined, where, whether
 *  held tangent there (collinear, two lines), and the relations that hold
 *  it, by id. */
export interface PointsLanding {
  end: 'start' | 'end'
  piece: number
  at: AnchorAt
  on: number
  onAt: 'a' | 'b'
  point: Vec2
  tangent: boolean
  constraints: number[]
}

/** What fitting a chain's pieces to its typed points did: the chain's
 *  pieces in order as they now run, the ends held along a side of the
 *  points' box, and the ends joined to pieces already there. */
export interface PointsRefit {
  order: PlacedSegment[]
  held: HeldAlong[]
  landed: PointsLanding[]
}

/** The end of a piece of `among` nearest `p` within `reach`, or null. */
function endNear(sketch: Sketch, among: readonly number[], p: Vec2, reach: number): { on: number; onAt: 'a' | 'b'; point: Vec2 } | null {
  let best: { on: number; onAt: 'a' | 'b'; point: Vec2; d: number } | null = null
  for (const id of among) {
    const e = entityOf(sketch, id)
    if (!e || e.construction || (e.kind !== 'line' && e.kind !== 'arc' && !(e.kind === 'spline' && !e.closed))) continue
    for (const at of ['a', 'b'] as const) {
      const q = anchorPoint(e, at)
      const d = Math.hypot(q[0] - p[0], q[1] - p[1])
      if (d <= reach && d < (best?.d ?? Infinity)) best = { on: id, onAt: at, point: [q[0], q[1]], d }
    }
  }
  return best ? { on: best.on, onAt: best.onAt, point: best.point } : null
}

/** The way a run of pieces sets off at its first piece's `from`, and runs
 *  at its last piece's `to`. */
const setsOff = (e: SketchEntity, from: AnchorAt) => (outwardAt(e, from) ?? 0) + Math.PI
const runsOut = (e: SketchEntity, to: AnchorAt) => outwardAt(e, to) ?? 0

/** Whether two pieces are joined end to end, or held tangent. */
function joined(sketch: Sketch, a: number, b: number): boolean {
  return sketch.constraints.some((c) => c.kind === 'coincident' && ((c.p.entity === a && c.q.entity === b) || (c.p.entity === b && c.q.entity === a)))
}
function tangentTo(sketch: Sketch, a: number, b: number): boolean {
  return sketch.constraints.some((c) => c.kind === 'tangent' && ((c.a === a && c.b === b) || (c.a === b && c.b === a)))
}

/** A chain as a path to fit — null unless it is lines and arcs, each
 *  joined to the next. A joint is a corner where no tangency holds it; a
 *  closed chain's closing joint, where the cut left it open, is a corner
 *  unless the chain runs on through it within LAND_TANGENT_DEG. */
function pathOf(sketch: Sketch, order: readonly PlacedSegment[], closed: boolean): PathFit | null {
  const es = order.map((o) => entityOf(sketch, o.id))
  if (es.length === 0 || es.some((e) => !e || (e.kind !== 'line' && e.kind !== 'arc'))) return null
  const pieces: PathPiece[] = []
  const corner: boolean[] = []
  let was = 0
  for (let i = 0; i < es.length; i++) {
    const e = es[i]!
    const o = order[i]
    if (i > 0 && !joined(sketch, order[i - 1].id, o.id)) return null
    const h0 = setsOff(e, o.from)
    const tangent = i > 0 && tangentTo(sketch, order[i - 1].id, o.id)
    corner.push(i > 0 && !tangent)
    const turn = i > 0 && !tangent ? angleOff(h0, was) : 0
    if (e.kind === 'line') pieces.push({ kind: 'line', k: 0, s: Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]), turn })
    else if (e.kind === 'arc') pieces.push({ kind: 'arc', k: (o.from === 'a' ? 1 : -1) / e.r, s: e.r * e.sweep, turn })
    was = runsOut(e, o.to)
  }
  const first = es[0]!
  const heading = setsOff(first, order[0].from)
  if (closed) {
    const last = es[es.length - 1]!
    const lastId = order[order.length - 1].id
    corner[0] = joined(sketch, lastId, order[0].id) ? !tangentTo(sketch, lastId, order[0].id) : Math.abs(angleOff(heading, runsOut(last, order[order.length - 1].to))) > (LAND_TANGENT_DEG * Math.PI) / 180
  }
  const level = new Map<number, 'horizontal' | 'vertical'>()
  order.forEach((o, i) => {
    for (const c of sketch.constraints) if ((c.kind === 'horizontal' || c.kind === 'vertical') && c.entity === o.id) level.set(i, c.kind)
  })
  const start = anchorPoint(first, order[0].from)
  return { start: [start[0], start[1]], heading, pieces, corner, closed, head: {}, tail: {}, level }
}

/** The heading along a side of the box nearest `h`. */
function alongSide(side: BoxSide, h: number): number {
  const ways = side === 'u+' || side === 'u-' ? [Math.PI / 2, -Math.PI / 2] : [0, Math.PI]
  return Math.abs(angleOff(h, ways[0])) <= Math.abs(angleOff(h, ways[1])) ? ways[0] : ways[1]
}

/**
 * The pieces of a chain cut from the smooth run through typed points
 * (pointsInterpolant), fitted again to the typed points themselves. An end
 * of an open chain whose typed point lies within `share` of an end of a
 * piece of `landOn` (the sketch's pieces from before) is joined to it —
 * coincident, and tangent where the chain sets off within LAND_TANGENT_DEG
 * of that piece's way (collinear, two lines). A chain of lines and arcs
 * joined end to end is fitted as a path (fitPath), its ends free, joined,
 * or — where a free end's point lies on a side of the points' box and its
 * piece carries past it — held on its point running along that side; any
 * other on a sheet of its own by the solver, its points shared out among
 * its pieces. The settled pieces go on `sketch` each with itself sampled
 * behind it (samplesOf) at `scatter`.
 */
export function refitOnPoints(sketch: Sketch, order: readonly PlacedSegment[], closed: boolean, points: readonly Vec2[], opts: { landOn?: readonly number[]; share?: number; scatter?: number } = {}): PointsRefit {
  const scatter = opts.scatter ?? POINTS_SCATTER_MM
  const ids = order.map((o) => o.id)
  const own = new Set(ids)
  const n = points.length
  const box = boxOf(points)
  // The ends that land on the pieces already there.
  const landings: Omit<PointsLanding, 'constraints'>[] = []
  if (!closed && order.length > 0 && n > 1 && (opts.share ?? 0) > 0) {
    for (const end of ['start', 'end'] as const) {
      const o = end === 'start' ? order[0] : order[order.length - 1]
      const at = end === 'start' ? o.from : o.to
      const near = endNear(sketch, (opts.landOn ?? []).filter((id) => !own.has(id)), end === 'start' ? points[0] : points[n - 1], opts.share!)
      if (!near || landings.some((l) => l.on === near.on && l.onAt === near.onAt)) continue
      const e = entityOf(sketch, o.id)!
      const way = outwardAt(entityOf(sketch, near.on)!, near.onAt) ?? 0
      const chain = end === 'start' ? setsOff(e, at) : runsOut(e, at)
      const want = end === 'start' ? way : way + Math.PI
      landings.push({ end, piece: o.id, at, ...near, tangent: Math.abs(angleOff(chain, want)) <= (LAND_TANGENT_DEG * Math.PI) / 180 })
    }
  }
  const landedAt = (end: 'start' | 'end') => landings.find((l) => l.end === end)
  const held: HeldAlong[] = []
  let placed: PlacedSegment[] = order.map((o) => ({ ...o }))
  const f = pathOf(sketch, order, closed)
  if (f) {
    for (const end of closed ? [] : (['start', 'end'] as const)) {
      const l = landedAt(end)
      const hold: PathEnd = end === 'start' ? f.head : f.tail
      if (!l) hold.stop = end === 'start' ? points[0] : points[n - 1]
      else {
        hold.point = l.point
        if (l.tangent) {
          const way = outwardAt(entityOf(sketch, l.on)!, l.onAt) ?? 0
          hold.heading = end === 'start' ? way : way + Math.PI
        }
      }
    }
    let fit = bestPath(f, points, ids)
    // A free end carrying past the side of the box its point lies on is
    // held on the point, running along that side, and the path fitted again
    // from where it got to — kept within that side all along.
    let more = false
    for (const end of closed ? [] : (['start', 'end'] as const)) {
      if (landedAt(end)) continue
      const w = end === 'start' ? fit.walked[0] : fit.walked[fit.walked.length - 1]
      const point = end === 'start' ? points[0] : points[n - 1]
      const side = sidePassed(w.e, point, box)
      if (!side) continue
      const hold: PathEnd = end === 'start' ? f.head : f.tail
      hold.point = point
      hold.heading = alongSide(side, end === 'start' ? w.h0 : w.h1)
      delete hold.stop
      held.push({ end, side })
      more = true
    }
    if (more) fit = bestPath({ ...f, start: fit.start, heading: fit.heading, pieces: fit.pieces, within: { box, sides: held.map((h) => h.side) } }, points, ids)
    // The pieces put as the path lays them, and their joints held again by
    // the anchors they now run between.
    const laid = new Map(fit.walked.map((w) => [w.e.id, w]))
    sketch.entities = sketch.entities.map((e) => {
      const s = laid.get(e.id)?.e
      if (e.kind === 'line' && s?.kind === 'line') return { ...e, a: s.a, b: s.b }
      if (e.kind === 'arc' && s?.kind === 'arc') return { ...e, c: s.c, r: s.r, start: s.start, sweep: s.sweep }
      return e
    })
    placed = order.map((o) => ({ ...o, from: laid.get(o.id)!.from, to: laid.get(o.id)!.to }))
    sketch.constraints = sketch.constraints.filter((c) => !((c.kind === 'coincident' || c.kind === 'tangent') && constraintEntities(c).every((id) => own.has(id))))
    const joints = closed ? placed.length : placed.length - 1
    for (let i = 0; i < joints; i++) {
      const p = placed[i]
      const q = placed[(i + 1) % placed.length]
      if (p.id === q.id) continue
      addConstraint(sketch, { kind: 'coincident', p: { entity: p.id, at: p.to }, q: { entity: q.id, at: q.from } })
      const kinds = [entityOf(sketch, p.id)!.kind, entityOf(sketch, q.id)!.kind]
      if (!f.corner[(i + 1) % placed.length] && kinds.includes('arc')) addConstraint(sketch, { kind: 'tangent', a: p.id, b: q.id })
    }
  } else held.push(...refitOnSheet(sketch, order, closed, points, landings, scatter))
  // The ends landed held there.
  const landed: PointsLanding[] = landings.map((l) => {
    const o = placed.find((x) => x.id === l.piece)!
    const at = l.end === 'start' ? o.from : o.to
    const e = entityOf(sketch, l.piece)!
    const t = entityOf(sketch, l.on)!
    const constraints = [addConstraint(sketch, { kind: 'coincident', p: { entity: l.piece, at }, q: { entity: l.on, at: l.onAt } })]
    if (l.tangent) constraints.push(e.kind === 'line' && t.kind === 'line' ? addConstraint(sketch, { kind: 'collinear', line: e.id, on: { line: t.id } }) : addConstraint(sketch, { kind: 'tangent', a: e.id, b: t.id }))
    return { ...l, at, constraints }
  })
  // The pieces with themselves sampled behind them.
  sketch.entities = sketch.entities.map((e) => (own.has(e.id) && e.kind !== 'point' ? ({ ...e, points: samplesOf(e), scatter } as SketchEntity) : e))
  return { order: placed, held, landed }
}

/**
 * A chain that is no path — a spline, pieces left unjoined — fitted to its
 * typed points by the solver, on a sheet of its own: its pieces, the
 * relations among them, the pieces its landings join held fixed, each
 * typed point given to the piece it lies nearest and the pieces settled on
 * them, again while points change pieces. A free end of an open chain is
 * run to the foot of its point; one carrying past the side of the box its
 * point lies on is held on the point along that side. The settled geometry
 * goes on `sketch`. Returns the ends held.
 */
function refitOnSheet(sketch: Sketch, order: readonly PlacedSegment[], closed: boolean, points: readonly Vec2[], landings: readonly Omit<PointsLanding, 'constraints'>[], scatter: number): HeldAlong[] {
  const ids = order.map((o) => o.id)
  const own = new Set(ids)
  const others = new Set(landings.map((l) => l.on))
  const scratch: Sketch = cloneSketch({
    entities: sketch.entities.filter((e) => own.has(e.id) || others.has(e.id)).map((e) => (own.has(e.id) ? e : { ...e, fixed: true })),
    constraints: sketch.constraints.filter((c) => constraintEntities(c).every((id) => own.has(id))),
    nextId: sketch.nextId,
  })
  for (const l of landings) {
    addConstraint(scratch, { kind: 'coincident', p: { entity: l.piece, at: l.at }, q: { entity: l.on, at: l.onAt } })
    if (l.tangent && !(entityOf(scratch, l.piece)!.kind === 'line' && entityOf(scratch, l.on)!.kind === 'line')) addConstraint(scratch, { kind: 'tangent', a: l.piece, b: l.on })
  }
  const pieces = () => ids.map((id) => entityOf(scratch, id)!)
  const ends: ChainEnd[] = []
  if (!closed && order.length > 0 && points.length > 1) {
    const first = order[0]
    const last = order[order.length - 1]
    if (!landings.some((l) => l.end === 'start')) ends.push({ end: 'start', piece: first.id, at: first.from, point: points[0] })
    if (!landings.some((l) => l.end === 'end')) ends.push({ end: 'end', piece: last.id, at: last.to, point: points[points.length - 1] })
  }
  const box = boxOf(points)
  const held: HeldAlong[] = []
  let shares = ''
  for (let round = 0; round < ROUNDS; round++) {
    // Each typed point to the piece it lies nearest.
    const near = points.map((p) => {
      const d = pieces().map((e) => nearestOnEntity(e, p).dist)
      return ids[d.indexOf(Math.min(...d))]
    })
    const key = near.join(',')
    if (key === shares) break
    shares = key
    for (const e of scratch.entities) {
      if (!own.has(e.id) || e.kind === 'point') continue
      ;(e as { points?: Vec2[] }).points = points.filter((_, i) => near[i] === e.id).map((p): Vec2 => [p[0], p[1]])
      ;(e as { scatter?: number }).scatter = scatter
    }
    // Settled; the free ends run to their points; an end carrying past its
    // side of the box held along it, and settled again.
    for (let pass = 0; pass < 2; pass++) {
      solveSketch(scratch)
      for (const end of ends) {
        const i = scratch.entities.findIndex((e) => e.id === end.piece)
        if (!held.some((h) => h.end === end.end)) scratch.entities[i] = endTo(scratch.entities[i], end.at, end.point)
      }
      let more = false
      for (const end of ends) {
        if (held.some((h) => h.end === end.end)) continue
        const side = sidePassed(entityOf(scratch, end.piece)!, end.point, box)
        if (!side) continue
        holdAlong(scratch, end, side)
        held.push({ end: end.end, side })
        more = true
      }
      if (!more) break
    }
  }
  sketch.entities = sketch.entities.map((e) => {
    const s = own.has(e.id) ? entityOf(scratch, e.id) : undefined
    if (e.kind === 'line' && s?.kind === 'line') return { ...e, a: s.a, b: s.b }
    if (e.kind === 'arc' && s?.kind === 'arc') return { ...e, c: s.c, r: s.r, start: s.start, sweep: s.sweep }
    if (e.kind === 'circle' && s?.kind === 'circle') return { ...e, c: s.c, r: s.r }
    if (e.kind === 'spline' && s?.kind === 'spline') return { ...e, pts: s.pts }
    return e
  })
  return held
}

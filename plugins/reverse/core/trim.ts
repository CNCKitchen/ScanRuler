// SPDX-License-Identifier: AGPL-3.0-only
// Trim, as a CAD sketcher has it: a click on a line, an arc or a circle
// takes away the stretch of it between the two nearest places other pieces
// cross it (or the piece's own end, where nothing crosses on that side). A
// piece nothing crosses goes whole. A stretch taken from the middle leaves
// two pieces; a circle opened becomes an arc.
//
// What holds the pieces after the cut, decided once for every case:
// - An end that stays where it was keeps every relation on it.
// - An end the cut moved loses what held it where it was (its coincidences,
//   point-ons, symmetries and the dimensions measured from it) and is held
//   instead where it now lies: coincident with the cutting piece's end when
//   it was cut there, otherwise on that piece (point-on).
// - What a piece's shape is held by stays with it: level, upright, parallel,
//   square, an angle, tangent, concentric, equal, a radius or a diameter, a
//   Fix, construction. What named the length of a line the cut shortened
//   goes — its length dimension, an equal with another line: it named the
//   length the cut just changed, and would pull the line back. A line's
//   middle moves with its ends: what held it goes too.
// - A stretch cut from the middle leaves the piece's start part as the
//   piece itself; the far part is a new piece that takes over the relations
//   of the piece's far end, and is held in line with the first part
//   (collinear) or on its circle (concentric and equal) — the two stay one
//   line, or one round, as they were.
// - Another piece's point held on the trimmed piece stays held on its line
//   or circle; one held within it (bounded) follows to the part it lies on,
//   and one left on the stretch taken away is held on the line only.
// - A fitted piece keeps the slice points along what is left of it; the far
//   part of a split takes those along it.
// A spline is not trimmed, nor is a piece projected from the part — it
// follows the part.

import type { Vec2 } from '../../../src/core/flat/types'
import { add2, dot2, len2, scale2, sub2 } from '../../../src/core/flat/vec2'
import {
  addConstraint,
  addEntity,
  type Anchor,
  anchorPoint,
  arcPoint,
  type Constraint,
  constraintEntities,
  endsOf,
  entityOf,
  entityPolyline,
  type Sketch,
  type SketchArc,
  type SketchCircle,
  type SketchEntity,
  type SketchLine,
  unwindAngle,
} from './sketch'

/** How close two points are one, mm. */
const TOL = 1e-6
const TWO_PI = 2 * Math.PI

/** A place another piece crosses the one trimmed: where along it (a line's
 *  t from a to b, 0–1; a round piece's angle from its start, radians), the
 *  point, and what it is held to there. */
interface Crossing {
  s: number
  p: Vec2
  /** The cutting piece's end it lies on, or the piece itself. */
  hold: Anchor | { piece: number }
}

/** A carrier: a line through two points (a segment), or a circle. */
type Carrier = { kind: 'line'; a: Vec2; b: Vec2 } | { kind: 'round'; c: Vec2; r: number }

function carrierPoints(x: Carrier, y: Carrier): Vec2[] {
  if (x.kind === 'line' && y.kind === 'line') {
    const d1 = sub2(x.b, x.a)
    const d2 = sub2(y.b, y.a)
    const den = d1[0] * d2[1] - d1[1] * d2[0]
    if (Math.abs(den) < 1e-12 * Math.max(1, dot2(d1, d1) * dot2(d2, d2))) return []
    const w = sub2(y.a, x.a)
    const t = (w[0] * d2[1] - w[1] * d2[0]) / den
    return [add2(x.a, scale2(d1, t))]
  }
  if (x.kind === 'round' && y.kind === 'round') {
    const dv = sub2(y.c, x.c)
    const d = len2(dv)
    if (d < TOL || d > x.r + y.r + TOL || d < Math.abs(x.r - y.r) - TOL) return []
    const along = (d * d + x.r * x.r - y.r * y.r) / (2 * d)
    const h2 = x.r * x.r - along * along
    const u = scale2(dv, 1 / d)
    const foot = add2(x.c, scale2(u, along))
    if (h2 <= TOL * TOL) return [foot]
    const h = Math.sqrt(h2)
    const n: Vec2 = [-u[1], u[0]]
    return [add2(foot, scale2(n, h)), sub2(foot, scale2(n, h))]
  }
  const line = x.kind === 'line' ? x : (y as Extract<Carrier, { kind: 'line' }>)
  const round = x.kind === 'round' ? x : (y as Extract<Carrier, { kind: 'round' }>)
  const d = sub2(line.b, line.a)
  const dd = dot2(d, d)
  if (dd < 1e-24) return []
  const f = sub2(line.a, round.c)
  const b = dot2(f, d) / dd
  const c = (dot2(f, f) - round.r * round.r) / dd
  const disc = b * b - c
  if (disc < -1e-12) return []
  if (disc <= 1e-12) return [add2(line.a, scale2(d, -b))]
  const root = Math.sqrt(disc)
  return [add2(line.a, scale2(d, -b - root)), add2(line.a, scale2(d, -b + root))]
}

/** Where along a line a point lies: 0 at a, 1 at b. */
function lineT(l: Pick<SketchLine, 'a' | 'b'>, p: Vec2): number {
  const d = sub2(l.b, l.a)
  const dd = dot2(d, d)
  return dd > 0 ? dot2(sub2(p, l.a), d) / dd : 0
}

/** How far round from an arc's start a point lies, radians, 0 to 2π. */
function arcS(e: Pick<SketchArc, 'c' | 'start'>, p: Vec2): number {
  return unwindAngle(Math.atan2(p[1] - e.c[1], p[0] - e.c[0]), e.start) - e.start
}

/** Whether a point on a piece's carrier lies on the piece itself, within the
 *  tolerance past its ends. */
function onPiece(e: SketchEntity, p: Vec2): boolean {
  if (e.kind === 'line') {
    const l = len2(sub2(e.b, e.a))
    const t = lineT(e, p)
    return t >= -TOL / Math.max(l, TOL) && t <= 1 + TOL / Math.max(l, TOL)
  }
  if (e.kind === 'arc') {
    const s = arcS(e, p)
    const slack = TOL / Math.max(e.r, TOL)
    return s <= e.sweep + slack || s >= TWO_PI - slack
  }
  return e.kind === 'circle'
}

/** The pieces of a cutting piece as carriers with their own extents: a line
 *  or a round piece is one; a spline is its drawn polyline, a line per
 *  stretch. */
function cutterParts(f: SketchEntity): { carrier: Carrier; on: (p: Vec2) => boolean }[] {
  if (f.kind === 'line') return [{ carrier: { kind: 'line', a: f.a, b: f.b }, on: (p) => onPiece(f, p) }]
  if (f.kind === 'arc' || f.kind === 'circle') return [{ carrier: { kind: 'round', c: f.c, r: f.r }, on: (p) => onPiece(f, p) }]
  if (f.kind !== 'spline') return []
  const pts = entityPolyline(f, 384)
  const out: { carrier: Carrier; on: (p: Vec2) => boolean }[] = []
  for (let i = 0; i + 1 < pts.length; i++) {
    const seg = { a: pts[i], b: pts[i + 1] }
    const l = len2(sub2(seg.b, seg.a))
    if (l < 1e-12) continue
    out.push({ carrier: { kind: 'line', ...seg }, on: (p) => { const t = lineT(seg, p); return t >= -TOL / l && t <= 1 + TOL / l } })
  }
  return out
}

/** Where along the trimmed piece a point lies. */
function sOf(e: SketchLine | SketchArc | SketchCircle, p: Vec2): number {
  if (e.kind === 'line') return lineT(e, p)
  if (e.kind === 'arc') return arcS(e, p)
  return arcS({ c: e.c, start: 0 }, p)
}

/** Every place another piece crosses `e`, in order along it, its own ends
 *  left out — one per place, held to a cutting piece's end where one lies
 *  there. */
export function crossingsOf(sketch: Pick<Sketch, 'entities'>, e: SketchLine | SketchArc | SketchCircle): Crossing[] {
  const own: Carrier = e.kind === 'line' ? { kind: 'line', a: e.a, b: e.b } : { kind: 'round', c: e.c, r: e.r }
  const size = e.kind === 'line' ? len2(sub2(e.b, e.a)) : e.r
  const end = e.kind === 'line' ? 1 : e.kind === 'arc' ? e.sweep : TWO_PI
  // Clear of the piece's own ends by a hair, in its own measure.
  const slack = TOL / Math.max(size, TOL)
  const found: Crossing[] = []
  for (const f of sketch.entities) {
    if (f.id === e.id || f.kind === 'point') continue
    const fEnds = endsOf(f).map((at) => ({ at, p: f.kind === 'line' ? (at === 'a' ? f.a : f.b) : f.kind === 'arc' ? arcPoint(f, at === 'a' ? f.start : f.start + f.sweep) : f.kind === 'spline' ? (at === 'a' ? f.pts[0] : f.pts[f.pts.length - 1]) : ([0, 0] as Vec2) }))
    for (const part of cutterParts(f)) {
      for (const p of carrierPoints(own, part.carrier)) {
        if (!part.on(p) || !onPiece(e, p)) continue
        let s = sOf(e, p)
        if (e.kind !== 'line' && s > TWO_PI - slack) s = 0
        if (e.kind === 'circle' ? false : s <= slack || s >= end - slack) continue
        if (found.some((x) => len2(sub2(x.p, p)) < 10 * TOL)) continue
        const atEnd = fEnds.find((x) => len2(sub2(x.p, p)) < 10 * TOL)
        found.push({ s, p, hold: atEnd ? { entity: f.id, at: atEnd.at } : { piece: f.id } })
      }
    }
  }
  return found.sort((x, y) => x.s - y.s)
}

/** What a click at `spot` on piece `id` would take away: the stretch between
 *  the crossings either side of it — `from` and `to` along the piece, null
 *  at the piece's own start or end — and the stretch as a polyline to draw.
 *  `whole` when nothing bounds it on either side. A sentence why not, for a
 *  piece that cannot be trimmed. */
export interface TrimPlan {
  piece: number
  whole: boolean
  from: Crossing | null
  to: Crossing | null
  /** The stretch taken away, sheet mm, to light under the cursor. */
  stretch: Vec2[]
}

export function trimPlan(sketch: Pick<Sketch, 'entities'>, id: number, spot: Vec2): TrimPlan | string {
  const e = entityOf(sketch, id)
  if (!e) return 'That piece is gone.'
  if (e.kind === 'spline') return 'A spline is not trimmed — move its end, or delete it.'
  if (e.kind === 'point') return 'A point has nothing to trim.'
  if (e.projected) return 'A projected piece follows the part — it is not trimmed.'
  const cuts = crossingsOf(sketch, e)
  const s0 = sOf(e, spot)
  if (e.kind === 'circle') {
    if (cuts.length < 2) return { piece: id, whole: true, from: null, to: null, stretch: entityPolyline(e, 96) }
    // The crossings either side round the circle, the turn wrapped.
    const after = cuts.find((c) => c.s > s0) ?? cuts[0]
    const before = [...cuts].reverse().find((c) => c.s < s0) ?? cuts[cuts.length - 1]
    const start = before.s
    const sweep = (((after.s - before.s) % TWO_PI) + TWO_PI) % TWO_PI || TWO_PI
    return { piece: id, whole: false, from: before, to: after, stretch: roundStretch(e, start, sweep) }
  }
  const end = e.kind === 'line' ? 1 : e.sweep
  const clicked = e.kind === 'arc' && s0 > end ? (s0 - end < TWO_PI - s0 ? end : 0) : Math.min(Math.max(s0, 0), end)
  const from = [...cuts].reverse().find((c) => c.s < clicked) ?? null
  const to = cuts.find((c) => c.s > clicked) ?? null
  const lo = from ? from.s : 0
  const hi = to ? to.s : end
  const stretch: Vec2[] = e.kind === 'line' ? [add2(e.a, scale2(sub2(e.b, e.a), lo)), add2(e.a, scale2(sub2(e.b, e.a), hi))] : roundStretch(e, e.start + lo, hi - lo)
  return { piece: id, whole: !from && !to, from, to, stretch }
}

function roundStretch(e: { c: Vec2; r: number }, start: number, sweep: number): Vec2[] {
  const n = Math.max(2, Math.ceil((96 * sweep) / TWO_PI))
  return Array.from({ length: n + 1 }, (_, i) => arcPoint(e, start + (sweep * i) / n))
}

/** What a trim did: the piece taken away whole, shortened at its start or
 *  its end, opened (a circle made an arc), or cut in two — then the new
 *  piece's id — and the relations and dimensions it took off. */
export interface TrimResult {
  piece: number
  done: 'removed' | 'start' | 'end' | 'opened' | 'split'
  made?: number
  dropped: number[]
}

/**
 * Trim piece `id` at `spot` (see the head of this file for what holds the
 * pieces afterwards). Changes the sketch in place; the caller solves it.
 * Returns what was done, or why nothing was.
 */
export function trimAt(sketch: Sketch, id: number, spot: Vec2): TrimResult | string {
  const plan = trimPlan(sketch, id, spot)
  if (typeof plan === 'string') return plan
  const e = entityOf(sketch, id) as SketchLine | SketchArc | SketchCircle
  const before = new Set(sketch.constraints.map((c) => c.id))
  const dropped = () => [...before].filter((c) => !sketch.constraints.some((x) => x.id === c))
  if (plan.whole) {
    sketch.entities = sketch.entities.filter((x) => x.id !== id)
    sketch.constraints = sketch.constraints.filter((c) => !constraintEntities(c).includes(id))
    return { piece: id, done: 'removed', dropped: dropped() }
  }
  const replace = (next: SketchEntity) => (sketch.entities = sketch.entities.map((x) => (x.id === id ? next : x)))
  const hold = (end: Anchor, at: Crossing) => {
    if ('entity' in at.hold) addConstraint(sketch, { kind: 'coincident', p: end, q: at.hold })
    else {
      const f = entityOf(sketch, at.hold.piece)
      if (f?.kind === 'line') addConstraint(sketch, { kind: 'pointOn', p: end, on: { line: f.id } })
      else if (f) addConstraint(sketch, { kind: 'pointOn', p: end, on: { curve: f.id } })
    }
  }

  if (e.kind === 'circle') {
    // Opened: the arc runs on from where the stretch taken ends, round to
    // where it began.
    const from = plan.to!
    const to = plan.from!
    const start = Math.atan2(from.p[1] - e.c[1], from.p[0] - e.c[0])
    const sweep = (((to.s - from.s) % TWO_PI) + TWO_PI) % TWO_PI || TWO_PI
    const { kind: _k, ...rest } = e
    void _k
    replace({ ...rest, kind: 'arc', start, sweep, ...(e.points ? { points: e.points.filter((p) => arcS({ c: e.c, start }, p) <= sweep) } : {}) })
    hold({ entity: id, at: 'a' }, from)
    hold({ entity: id, at: 'b' }, to)
    return { piece: id, done: 'opened', dropped: dropped() }
  }

  const at = (s: number): Vec2 => (e.kind === 'line' ? add2(e.a, scale2(sub2(e.b, e.a), s)) : arcPoint(e, e.start + s))
  const end = e.kind === 'line' ? 1 : e.sweep
  const pointsWithin = (lo: number, hi: number) => (e.points ? e.points.filter((p) => { const s = sOf(e, p); return s >= lo && s <= hi }) : undefined)
  const withPart = (lo: number, hi: number): SketchLine | SketchArc => {
    const pts = pointsWithin(lo, hi)
    const base = { ...e, ...(pts ? { points: pts } : {}) } as SketchLine | SketchArc
    return base.kind === 'line' ? { ...base, a: at(lo), b: at(hi) } : { ...base, start: e.kind === 'arc' ? e.start + lo : 0, sweep: hi - lo }
  }
  // The middle of a line moves with any cut of it, and what named its
  // length names the length the cut changed — a length, an equal.
  const middleGoes = (c: Constraint) =>
    e.kind === 'line' && (anchorsIn(c).some((x) => x.entity === id && x.at === 'center') || (c.kind === 'length' && c.entity === id) || (c.kind === 'equal' && (c.a === id || c.b === id)))
  if (!plan.from || !plan.to) {
    // From the start, or to the end: one end moves.
    const moved: 'a' | 'b' = plan.from ? 'b' : 'a'
    replace(plan.from ? withPart(0, plan.from.s) : withPart(plan.to!.s, end))
    sketch.constraints = sketch.constraints.filter((c) => !anchorsIn(c).some((x) => x.entity === id && x.at === moved) && !middleGoes(c))
    rehomeBounded(sketch, id, null)
    hold({ entity: id, at: moved }, (plan.from ?? plan.to)!)
    return { piece: id, done: moved === 'a' ? 'start' : 'end', dropped: dropped() }
  }

  // From the middle: the piece keeps its start part, a new piece the far part.
  const far = withPart(plan.to.s, end)
  replace(withPart(0, plan.from.s))
  const { id: _id, ...made } = far
  void _id
  const other = addEntity(sketch, made as Parameters<typeof addEntity>[1])
  // What held the far end now holds the new piece's far end; what held the
  // middle goes, and a length the cut changed.
  const keep: Constraint[] = []
  for (const c of sketch.constraints) {
    if (middleGoes(c)) continue
    if (anchorsIn(c).some((x) => x.entity === id && x.at === 'b')) {
      keep.push(moveAnchor(c, id, 'b', other))
      continue
    }
    keep.push(c)
  }
  sketch.constraints = keep
  rehomeBounded(sketch, id, other)
  hold({ entity: id, at: 'b' }, plan.from)
  hold({ entity: other, at: 'a' }, plan.to)
  // The two parts stay one line, or one round.
  if (e.kind === 'line') addConstraint(sketch, { kind: 'collinear', line: other, on: { line: id } })
  else {
    addConstraint(sketch, { kind: 'concentric', a: other, b: id })
    addConstraint(sketch, { kind: 'equal', a: other, b: id })
  }
  return { piece: id, done: 'split', made: other, dropped: dropped() }
}

/** The anchors a relation holds. */
function anchorsIn(c: Constraint): Anchor[] {
  const out: Anchor[] = []
  for (const k of ['p', 'q'] as const) {
    const v = (c as unknown as Record<string, unknown>)[k] as Anchor | undefined
    if (v && typeof v === 'object' && 'entity' in v && 'at' in v) out.push(v)
  }
  return out
}

/** A relation with one anchor of a piece moved to another piece's. */
function moveAnchor(c: Constraint, from: number, at: string, to: number): Constraint {
  const copy = JSON.parse(JSON.stringify(c)) as Constraint & Record<string, unknown>
  for (const k of ['p', 'q']) {
    const v = copy[k] as Anchor | undefined
    if (v && typeof v === 'object' && v.entity === from && v.at === at) v.entity = to
  }
  return copy
}

/** Points of other pieces held within the trimmed piece (a bounded
 *  point-on): those on its far part, after a split, held within that part;
 *  those left on the stretch taken away held on its line or circle only. */
function rehomeBounded(sketch: Sketch, id: number, other: number | null): void {
  const piece = entityOf(sketch, id)
  const second = other === null ? null : entityOf(sketch, other)
  sketch.constraints = sketch.constraints.map((c) => {
    if (c.kind !== 'pointOn' || !c.bounded) return c
    const on = 'line' in c.on ? c.on.line : 'curve' in c.on ? c.on.curve : null
    if (on !== id || !piece) return c
    const owner = entityOf(sketch, c.p.entity)
    if (!owner) return c
    const p = anchorPoint(owner, c.p.at)
    if (onPiece(piece, p)) return c
    if (second && onPiece(second, p)) return { ...c, on: 'line' in c.on ? { line: second.id } : { curve: second.id } }
    const { bounded: _b, ...rest } = c
    void _b
    return rest
  })
}


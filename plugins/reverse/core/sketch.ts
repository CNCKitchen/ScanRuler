// SPDX-License-Identifier: AGPL-3.0-only
// The sketch of the Reverse engineer workspace: lines, arcs, circles,
// splines and points on a plane, the relations and dimensions between them, and the
// slice points a fitted piece was measured on. Everything here is plain data
// in sheet millimetres — the (u, v) of the section frame the sketch lies on
// — so a sketch saves as JSON, solves on the main thread (see solver.ts) and
// is stood up in the part by the build (see build.ts) through the frame.
//
// A piece is either *fitted*, with the slice points it was segmented from
// kept beside it as soft data the solver keeps pulling it towards, or
// *free*, drawn by hand with nothing behind it but a weak wish to stay where
// it was drawn. Relations and typed dimensions are hard: the solver meets
// them exactly or reports that it cannot.

import type { Vec2 } from '../../../src/core/flat/types'
import { add2, dot2, len2, normalize2, scale2, sub2 } from '../../../src/core/flat/vec2'
import type { DatumPlane } from './datums'
import { isClosed, nearestOnSpline, splineAt, splineCurve, splineEnd, splineSamples } from './sketchSpline'
import type { EdgeFingerprint } from './topo'

export type EntityKind = 'line' | 'arc' | 'circle' | 'spline' | 'point'

/** What a projected piece was taken from: an edge of a body, by its
 *  fingerprint, or a piece of another sketch. The build takes it again
 *  from there every time it runs, so the piece follows the part through
 *  an edit of an earlier feature (see build.ts placeSketch). */
export type ProjectionSource = { body: number; edge: EdgeFingerprint } | { sketch: number; entity: number }

/** One of the two ends of a line, an arc or an open spline, the one point a
 *  point or a circle stands for (its centre), or a spline's fit point by its
 *  place among them (`p1`, `p2`, …) — an open spline's first and last are
 *  its ends, `a` and `b`; a closed one has fit points only, from `p0`. */
export type AnchorAt = 'a' | 'b' | 'center' | `p${number}`

export interface SketchLine {
  id: number
  kind: 'line'
  a: Vec2
  b: Vec2
  /** The slice points the piece was fitted to, or none for free geometry. */
  points?: Vec2[]
  /** The scatter of those points, millimetres — the weight the soft data
   *  carries against the constraints. */
  scatter?: number
  /** Whether the piece is locked where it is. */
  fixed?: boolean
  /** Whether the piece was projected from a body's edge or another
   *  sketch's piece (see project.ts): fixed where it landed, drawn in a
   *  colour of its own, there to hang relations on and to close profiles
   *  with. */
  projected?: boolean
  /** Where a projected piece was taken from, when it follows it — a
   *  projection saved before projections followed the part has none: a
   *  face's outline is given its edges by the next build that finds them
   *  where it lies, anything else stays where it landed. */
  source?: ProjectionSource
  /** Whether the piece is drawn for construction only — a mirror line, an
   *  axis — and takes no part in the regions. */
  construction?: boolean
}

/** An arc runs counter-clockwise from `start` through `sweep` radians;
 *  anchor `a` is at `start`, anchor `b` at `start + sweep`. */
export interface SketchArc {
  id: number
  kind: 'arc'
  c: Vec2
  r: number
  start: number
  sweep: number
  points?: Vec2[]
  scatter?: number
  fixed?: boolean
  projected?: boolean
  source?: ProjectionSource
  construction?: boolean
}

export interface SketchCircle {
  id: number
  kind: 'circle'
  c: Vec2
  r: number
  points?: Vec2[]
  scatter?: number
  fixed?: boolean
  projected?: boolean
  source?: ProjectionSource
  construction?: boolean
}

/** A curve through fit points (see sketchSpline.ts): `pts` in order, the
 *  curve smooth through every one, and back round to the first when
 *  `closed`. Its ends are natural — the curve runs on straight past them —
 *  unless a tangent relation holds one, when the direction it leaves its
 *  first point by (`startDir`) or arrives at its last by (`endDir`),
 *  radians, is the solver's to find. */
export interface SketchSpline {
  id: number
  kind: 'spline'
  pts: Vec2[]
  closed?: boolean
  startDir?: number
  endDir?: number
  points?: Vec2[]
  scatter?: number
  fixed?: boolean
  projected?: boolean
  source?: ProjectionSource
  construction?: boolean
}

export interface SketchPoint {
  id: number
  kind: 'point'
  p: Vec2
  fixed?: boolean
  projected?: boolean
  source?: ProjectionSource
  construction?: boolean
}

export type SketchEntity = SketchLine | SketchArc | SketchCircle | SketchSpline | SketchPoint

export interface Anchor {
  entity: number
  at: AnchorAt
}

/** Where the operator dragged a dimension's number to, told against what
 *  the dimension measures so it follows the pieces when they move (see
 *  dimLayout.ts): a length's or a distance's line `off` square to the
 *  measured stretch with the number `along` it from the middle; a radius's
 *  leader or a diameter's line at the angle `off` with the number `along` it
 *  from the centre; an angle's arc of radius `off` with the number at the
 *  angle `along`. */
export interface DimPlace {
  off: number
  along: number
}

/** The relations and dimensions. A dimension is a relation with a value —
 *  the same hard equation to the solver, shown differently by the panel.
 *  `inferred` marks a relation the sketcher added on its own while a piece
 *  was drawn — a line drawn nearly level made horizontal — the same
 *  equation as one asked for, shown as a chip the operator can take off. */
export type Constraint = { inferred?: boolean; place?: DimPlace } & (
  | { id: number; kind: 'coincident'; p: Anchor; q: Anchor }
  | { id: number; kind: 'horizontal'; entity: number }
  | { id: number; kind: 'vertical'; entity: number }
  | { id: number; kind: 'parallel'; a: number; b: number }
  | { id: number; kind: 'perpendicular'; a: number; b: number }
  /** A line tangent to an arc or a circle, or two of those tangent to each
   *  other. */
  | { id: number; kind: 'tangent'; a: number; b: number }
  | { id: number; kind: 'concentric'; a: number; b: number }
  /** Two lines of one length, or two arcs or circles of one radius — what
   *  keeps a polygon's sides alike and a row of holes one size. */
  | { id: number; kind: 'equal'; a: number; b: number }
  /** An anchor held on a piece rather than at its end: on a line, on an
   *  arc's or a circle's rim, or on the line one of the part's coordinate
   *  planes cuts the sheet in — a coincidence of a point with a piece, as
   *  CAD makes one when a point and an edge are picked. `bounded` keeps
   *  the point within the piece — between a line's ends, within an arc's
   *  sweep — not on the line or circle it runs on past them: a T-junction
   *  that stays one when the piece is shortened. Without it, as before. */
  | { id: number; kind: 'pointOn'; p: Anchor; on: OnTarget; bounded?: boolean }
  /** A line lying along another line, or along a coordinate plane's line
   *  in the sheet — both its ends on it: a coincidence of two lines. */
  | { id: number; kind: 'collinear'; line: number; on: Exclude<OnTarget, { curve: number }> }
  /** Two anchors mirror images across a sheet axis, a sketch line, or one
   *  of the part's coordinate planes — the line it cuts the sheet in, read
   *  off the frame when solved (see datums.ts). */
  | { id: number; kind: 'symmetric'; p: Anchor; q: Anchor; about: 'x' | 'y' | { line: number } | { datum: DatumPlane } }
  /** A line's length. */
  | { id: number; kind: 'length'; entity: number; value: number; expr?: string }
  /** Between two anchors, from an anchor to a line (perpendicular), or
   *  from an anchor to one of the part's coordinate planes — to the line
   *  the plane cuts the sheet in (see datums.ts). */
  | { id: number; kind: 'distance'; p: Anchor; q: Anchor | { line: number } | { datum: DatumPlane }; value: number; expr?: string }
  | { id: number; kind: 'radius'; entity: number; value: number; expr?: string }
  /** A circle's or an arc's diameter — what a full circle is dimensioned
   *  by, as a drawing gives a hole or a boss; the solver holds the radius at
   *  half of it. */
  | { id: number; kind: 'diameter'; entity: number; value: number; expr?: string }
  /** Between two lines, degrees, 0–180 as the lines' directions read. */
  | { id: number; kind: 'angle'; a: number; b: number; value: number; expr?: string }
)

export type ConstraintKind = Constraint['kind']

/** What a point or a line is held on: a line of the sketch, a round
 *  piece's rim, or a coordinate plane's line in the sheet. */
export type OnTarget = { line: number } | { curve: number } | { datum: DatumPlane }

/** How far off level or upright a drawn line may be and still be meant
 *  so, degrees — a hand on a mouse misses by a degree or two; a line
 *  drawn at five is a line drawn at five. */
export const INFER_AXIS_DEG = 3

/** The relation a line drawn from `a` to `b` was meant to have: horizontal
 *  within INFER_AXIS_DEG of the sheet's X, vertical within it of Y, or
 *  none. A line too short to have a direction gets none. */
export function axisRelationOf(a: Vec2, b: Vec2, degrees = INFER_AXIS_DEG): 'horizontal' | 'vertical' | null {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const l = Math.hypot(dx, dy)
  if (!(l > 1e-9)) return null
  const limit = Math.sin((degrees * Math.PI) / 180)
  if (Math.abs(dy) / l <= limit) return 'horizontal'
  if (Math.abs(dx) / l <= limit) return 'vertical'
  return null
}

/** `Omit` over each member of a union rather than over their intersection —
 *  what the inputs to addEntity and addConstraint are. */
export type WithoutId<T> = T extends { id: number } ? Omit<T, 'id'> : never
export type EntityInput = WithoutId<SketchEntity>
export type ConstraintInput = WithoutId<Constraint>

export const DIMENSION_KINDS: readonly ConstraintKind[] = ['length', 'distance', 'radius', 'diameter', 'angle']

export function isDimension(c: Constraint): c is Extract<Constraint, { value: number }> {
  return 'value' in c
}

/** A piece's Fix where the sketch shows its relations — a row in the list,
 *  a glyph on the sheet, selected and removed as a relation is. The Fix
 *  itself is the piece's flag (`fixed`), what the solver reads; it is shown
 *  under an id of its own that no relation has: negative, from the piece's.
 *  A projected piece is fixed by the part, not by a Fix, and has none. */
export const fixId = (entity: number): number => -1 - entity

/** The piece whose Fix an id from fixId stands for, or null for a relation's
 *  or a dimension's own id. */
export const fixedEntityOf = (id: number): number | null => (id < 0 ? -1 - id : null)

/** The pieces fixed by a Fix, in the sketch's order. */
export const fixedPieces = (sketch: Sketch): SketchEntity[] => sketch.entities.filter((e) => e.fixed && !e.projected)

/** The sketch as stored: its pieces and what holds them. */
export interface Sketch {
  entities: SketchEntity[]
  constraints: Constraint[]
  nextId: number
}

export function emptySketch(): Sketch {
  return { entities: [], constraints: [], nextId: 1 }
}

// ---- geometry of a piece ---------------------------------------------------

export function arcPoint(arc: Pick<SketchArc, 'c' | 'r'>, angle: number): Vec2 {
  return [arc.c[0] + arc.r * Math.cos(angle), arc.c[1] + arc.r * Math.sin(angle)]
}

/** Which of a spline's fit points an anchor names, or null for one it does
 *  not have. */
export function splinePointIndex(e: Pick<SketchSpline, 'pts' | 'closed'>, at: AnchorAt): number | null {
  const n = e.pts.length
  const closed = isClosed(e)
  if (at === 'a') return closed ? null : 0
  if (at === 'b') return closed ? null : n - 1
  if (at === 'center') return null
  const i = Number(at.slice(1))
  if (!Number.isInteger(i) || i < 0 || i >= n) return null
  return closed || (i > 0 && i < n - 1) ? i : null
}

/** The anchor a spline's fit point is named by. */
export function splineAnchor(e: Pick<SketchSpline, 'pts' | 'closed'>, i: number): AnchorAt {
  if (!isClosed(e) && i === 0) return 'a'
  if (!isClosed(e) && i === e.pts.length - 1) return 'b'
  return `p${i}`
}

/** Where an anchor lies. */
export function anchorPoint(e: SketchEntity, at: AnchorAt): Vec2 {
  switch (e.kind) {
    case 'line':
      return at === 'b' ? e.b : at === 'a' ? e.a : [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2]
    case 'arc':
      return at === 'a' ? arcPoint(e, e.start) : at === 'b' ? arcPoint(e, e.start + e.sweep) : e.c
    case 'circle':
      return e.c
    case 'spline': {
      const i = splinePointIndex(e, at)
      if (i !== null) return e.pts[i]
      // A spline has no centre; what asks for one is given its middle.
      const fit = splineCurve(e)
      return splineAt(fit, splineEnd(fit) / 2)
    }
    case 'point':
      return e.p
  }
}

/** The anchors an entity offers: a spline's are its fit points, its ends
 *  first. */
export function anchorsOf(e: SketchEntity): AnchorAt[] {
  if (e.kind === 'line' || e.kind === 'arc') return ['a', 'b']
  if (e.kind === 'spline') {
    if (isClosed(e)) return e.pts.map((_, i) => `p${i}` as AnchorAt)
    return ['a', 'b', ...e.pts.slice(1, -1).map((_, i) => `p${i + 1}` as AnchorAt)]
  }
  return ['center']
}

/** The ends of a piece — a line's, an arc's or an open spline's two, where
 *  one piece of a chain meets the next; none for anything else. */
export function endsOf(e: SketchEntity): ('a' | 'b')[] {
  if (e.kind === 'line' || e.kind === 'arc') return ['a', 'b']
  if (e.kind === 'spline' && !isClosed(e)) return ['a', 'b']
  return []
}

/** A line's unit direction, a to b — or null for a degenerate line. */
export function lineDir(l: SketchLine): Vec2 | null {
  return normalize2(sub2(l.b, l.a))
}

export function lineLength(l: SketchLine): number {
  return len2(sub2(l.b, l.a))
}

/** The foot of a point on a line's carrier, and how far along a → b it lies
 *  as a fraction of the length. */
function lineFoot(l: SketchLine, p: Vec2): { foot: Vec2; t: number } {
  const ab = sub2(l.b, l.a)
  const ll = dot2(ab, ab)
  const t = ll > 0 ? dot2(sub2(p, l.a), ab) / ll : 0
  return { foot: add2(l.a, scale2(ab, t)), t }
}

/** The angle of a point about an arc's centre, from +u. */
export function arcAngleOf(arc: Pick<SketchArc, 'c'>, p: Vec2): number {
  return Math.atan2(p[1] - arc.c[1], p[0] - arc.c[0])
}

/** `angle` brought into [start, start + 2π). */
export function unwindAngle(angle: number, start: number): number {
  const two = 2 * Math.PI
  let a = (angle - start) % two
  if (a < 0) a += two
  return start + a
}

/** The point on an entity closest to `p`, and its distance — for picking. */
export function nearestOnEntity(e: SketchEntity, p: Vec2): { point: Vec2; dist: number } {
  switch (e.kind) {
    case 'point':
      return { point: e.p, dist: len2(sub2(p, e.p)) }
    case 'line': {
      const { foot, t } = lineFoot(e, p)
      const clamped = t < 0 ? e.a : t > 1 ? e.b : foot
      return { point: clamped, dist: len2(sub2(p, clamped)) }
    }
    case 'circle': {
      const d = normalize2(sub2(p, e.c)) ?? [1, 0]
      const point = add2(e.c, scale2(d, e.r))
      return { point, dist: len2(sub2(p, point)) }
    }
    case 'arc': {
      const angle = unwindAngle(arcAngleOf(e, p), e.start)
      if (angle - e.start <= e.sweep) {
        const point = arcPoint(e, angle)
        return { point, dist: len2(sub2(p, point)) }
      }
      const a = arcPoint(e, e.start)
      const b = arcPoint(e, e.start + e.sweep)
      const da = len2(sub2(p, a))
      const db = len2(sub2(p, b))
      return da <= db ? { point: a, dist: da } : { point: b, dist: db }
    }
    case 'spline': {
      const near = nearestOnSpline(splineCurve(e), p)
      return { point: near.point, dist: near.dist }
    }
  }
}

/** The polyline a piece draws as, `steps` segments per full turn of arc. */
export function entityPolyline(e: SketchEntity, steps = 96): Vec2[] {
  switch (e.kind) {
    case 'point':
      return [e.p]
    case 'line':
      return [e.a, e.b]
    case 'circle':
    case 'arc': {
      const start = e.kind === 'arc' ? e.start : 0
      const sweep = e.kind === 'arc' ? e.sweep : 2 * Math.PI
      const n = Math.max(2, Math.ceil((steps * Math.abs(sweep)) / (2 * Math.PI)))
      const out: Vec2[] = []
      for (let i = 0; i <= n; i++) out.push(arcPoint(e, start + (sweep * i) / n))
      return out
    }
    case 'spline':
      return splineSamples(splineCurve(e), Math.max(4, Math.round(steps / 6))).map((s) => s.p)
  }
}

/** The extent of the sketch's pieces (and their slice points), or null. */
export function sketchBounds(sketch: Pick<Sketch, 'entities'>): { min: Vec2; max: Vec2 } | null {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  const take = (p: Vec2) => {
    if (p[0] < x0) x0 = p[0]
    if (p[0] > x1) x1 = p[0]
    if (p[1] < y0) y0 = p[1]
    if (p[1] > y1) y1 = p[1]
  }
  for (const e of sketch.entities) {
    for (const p of entityPolyline(e, 32)) take(p)
    if ('points' in e && e.points) for (const p of e.points) take(p)
  }
  return Number.isFinite(x0) ? { min: [x0, y0], max: [x1, y1] } : null
}

// ---- the sketch as a whole --------------------------------------------------

export function entityOf(sketch: Pick<Sketch, 'entities'>, id: number): SketchEntity | undefined {
  return sketch.entities.find((e) => e.id === id)
}

/** The ids a constraint refers to. */
export function constraintEntities(c: Constraint): number[] {
  switch (c.kind) {
    case 'coincident':
    case 'symmetric': {
      const ids = [c.p.entity, c.q.entity]
      if (c.kind === 'symmetric' && typeof c.about === 'object' && 'line' in c.about) ids.push(c.about.line)
      return ids
    }
    case 'horizontal':
    case 'vertical':
    case 'length':
    case 'radius':
    case 'diameter':
      return [c.entity]
    case 'parallel':
    case 'perpendicular':
    case 'tangent':
    case 'concentric':
    case 'equal':
    case 'angle':
      return [c.a, c.b]
    case 'distance':
      return 'datum' in c.q ? [c.p.entity] : [c.p.entity, 'line' in c.q ? c.q.line : c.q.entity]
    case 'pointOn':
      return 'datum' in c.on ? [c.p.entity] : [c.p.entity, 'line' in c.on ? c.on.line : c.on.curve]
    case 'collinear':
      return 'datum' in c.on ? [c.line] : [c.line, c.on.line]
  }
}

/** Where a coincidence joins an end of a spline to another piece: the
 *  spline's end and the other's anchor, or null. A spline is held tangent
 *  there and nowhere else — along its length it has no one direction to
 *  hold. */
export function splineJoint(sketch: Pick<Sketch, 'constraints'>, spline: number, other: number): { end: 'a' | 'b'; at: AnchorAt } | null {
  for (const c of sketch.constraints) {
    if (c.kind !== 'coincident') continue
    for (const [mine, theirs] of [
      [c.p, c.q],
      [c.q, c.p],
    ]) {
      if (mine.entity === spline && theirs.entity === other && (mine.at === 'a' || mine.at === 'b') && theirs.at !== 'center') return { end: mine.at, at: theirs.at }
    }
  }
  return null
}

/** Add an entity, handing back its id. */
export function addEntity(sketch: Sketch, entity: EntityInput): number {
  const id = sketch.nextId++
  sketch.entities.push({ ...entity, id } as SketchEntity)
  return id
}

export function addConstraint(sketch: Sketch, constraint: ConstraintInput): number {
  const id = sketch.nextId++
  sketch.constraints.push({ ...constraint, id } as Constraint)
  return id
}

/** Remove entities and every constraint that referred to them. */
export function removeEntities(sketch: Sketch, ids: readonly number[]): void {
  const gone = new Set(ids)
  sketch.entities = sketch.entities.filter((e) => !gone.has(e.id))
  sketch.constraints = sketch.constraints.filter((c) => !constraintEntities(c).some((id) => gone.has(id)))
}

export function removeConstraint(sketch: Sketch, id: number): void {
  sketch.constraints = sketch.constraints.filter((c) => c.id !== id)
}

/** Whether a relation of this kind can be put on the given entities — the
 *  panel's enabling rule, and the check before one is added. */
export function relationTakes(kind: ConstraintKind, entities: readonly SketchEntity[]): boolean {
  const kinds = entities.map((e) => e.kind)
  const round = (k: EntityKind) => k === 'arc' || k === 'circle'
  // A spline is held tangent where one of its ends meets the other piece;
  // the panel and the commands check for the joint (splineJoint).
  const curved = (k: EntityKind) => round(k) || k === 'spline'
  switch (kind) {
    case 'horizontal':
    case 'vertical':
      return entities.length >= 1 && kinds.every((k) => k === 'line')
    case 'parallel':
    case 'perpendicular':
    case 'angle':
      return entities.length === 2 && kinds.every((k) => k === 'line')
    case 'tangent':
      return entities.length === 2 && kinds.some(curved) && kinds.every((k) => k === 'line' || curved(k)) && !(kinds.includes('circle') && kinds.includes('spline'))
    case 'concentric':
      return entities.length === 2 && kinds.every(round)
    case 'equal':
      return entities.length === 2 && (kinds.every((k) => k === 'line') || kinds.every(round))
    case 'length':
      return entities.length === 1 && kinds[0] === 'line'
    case 'radius':
    case 'diameter':
      return entities.length === 1 && round(kinds[0])
    case 'coincident':
    case 'symmetric':
    case 'distance':
    case 'pointOn':
    case 'collinear':
      // These take anchors, not whole entities — the panel builds them.
      return false
  }
}

/** A deep copy, for a draft to work on. */
export function cloneSketch(sketch: Sketch): Sketch {
  return JSON.parse(JSON.stringify(sketch)) as Sketch
}

/** A rectangle from two opposite corners: four lines, horizontal and
 *  vertical, coincident at the corners. What a hand-drawn box is. */
export function addRectangle(sketch: Sketch, p: Vec2, q: Vec2): number[] {
  const x0 = Math.min(p[0], q[0])
  const x1 = Math.max(p[0], q[0])
  const y0 = Math.min(p[1], q[1])
  const y1 = Math.max(p[1], q[1])
  const corners: Vec2[] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]
  const ids = corners.map((c, i) =>
    addEntity(sketch, { kind: 'line', a: c, b: corners[(i + 1) % 4] }),
  )
  for (let i = 0; i < 4; i++) {
    addConstraint(sketch, {
      kind: 'coincident',
      p: { entity: ids[i], at: 'b' },
      q: { entity: ids[(i + 1) % 4], at: 'a' },
    })
    addConstraint(sketch, { kind: i % 2 === 0 ? 'horizontal' : 'vertical', entity: ids[i], inferred: true })
  }
  return ids
}

/** A rectangle at any angle, from its four corners in order round it: four
 *  lines coincident at the corners, the opposite sides parallel and the
 *  first two square — five freedoms, a rectangle's. Its first side is
 *  inferred level or upright when drawn nearly so. The ids run round from
 *  the side between the first two corners given. */
export function addTurnedRectangle(sketch: Sketch, corners: readonly Vec2[]): number[] {
  const ids = corners.map((c, i) => addEntity(sketch, { kind: 'line', a: c, b: corners[(i + 1) % 4] }))
  for (let i = 0; i < 4; i++) {
    addConstraint(sketch, { kind: 'coincident', p: { entity: ids[i], at: 'b' }, q: { entity: ids[(i + 1) % 4], at: 'a' } })
  }
  const axis = axisRelationOf(corners[0], corners[1])
  if (axis) {
    // Level or upright, it is the rectangle the two-corner way draws.
    for (let i = 0; i < 4; i++) {
      const even = i % 2 === 0
      addConstraint(sketch, { kind: even === (axis === 'horizontal') ? 'horizontal' : 'vertical', entity: ids[i], inferred: true })
    }
    return ids
  }
  addConstraint(sketch, { kind: 'parallel', a: ids[0], b: ids[2] })
  addConstraint(sketch, { kind: 'parallel', a: ids[1], b: ids[3] })
  addConstraint(sketch, { kind: 'perpendicular', a: ids[0], b: ids[1] })
  return ids
}

/** A rectangle's centre, as the construction a centre-drawn rectangle
 *  carries: its two diagonals, end to corner, and a point where they
 *  cross — what the centre is held by and dimensioned from. The rectangle's
 *  lines run round from `lines[0]`, each from its corner (`a`). Returns the
 *  centre point's id. */
export function addRectangleCentre(sketch: Sketch, lines: readonly number[]): number {
  const corner = (i: number): Vec2 => {
    const e = entityOf(sketch, lines[i])
    return e?.kind === 'line' ? e.a : [0, 0]
  }
  const diagonals = [
    [0, 2],
    [1, 3],
  ].map(([i, j]) => {
    const id = addEntity(sketch, { kind: 'line', a: corner(i), b: corner(j), construction: true })
    addConstraint(sketch, { kind: 'coincident', p: { entity: id, at: 'a' }, q: { entity: lines[i], at: 'a' } })
    addConstraint(sketch, { kind: 'coincident', p: { entity: id, at: 'b' }, q: { entity: lines[j], at: 'a' } })
    return id
  })
  const a = corner(0)
  const b = corner(2)
  const centre = addEntity(sketch, { kind: 'point', p: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], construction: true })
  for (const line of diagonals) addConstraint(sketch, { kind: 'pointOn', p: { entity: centre, at: 'center' }, on: { line } })
  return centre
}

/** The arc through three points — start `p`, end `q`, passing through `r`
 *  — as an entity's centre, radius, start angle and sweep. `startsAtP` says
 *  whether anchor 'a' is at `p` (the arc runs counter-clockwise from p) or
 *  at `q`. Null when the points are collinear. */
export function arcThrough(
  p: Vec2,
  q: Vec2,
  r: Vec2,
): { c: Vec2; r: number; start: number; sweep: number; startsAtP: boolean } | null {
  const ax = p[0], ay = p[1], bx = q[0], by = q[1], cx = r[0], cy = r[1]
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
  if (Math.abs(d) < 1e-9) return null
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d
  const c: Vec2 = [ux, uy]
  const radius = Math.hypot(ax - ux, ay - uy)
  const thetaP = Math.atan2(ay - uy, ax - ux)
  const thetaQ = Math.atan2(by - uy, bx - ux)
  const thetaR = Math.atan2(cy - uy, cx - ux)
  const two = 2 * Math.PI
  const ccwPQ = ((thetaQ - thetaP) % two + two) % two
  const ccwPR = ((thetaR - thetaP) % two + two) % two
  // Counter-clockwise from p reaches r before q: the arc runs p → q that way.
  if (ccwPR <= ccwPQ) return { c, r: radius, start: thetaP, sweep: ccwPQ, startsAtP: true }
  return { c, r: radius, start: thetaQ, sweep: two - ccwPQ, startsAtP: false }
}

// ---- polygons, patterns and the relations a drawing implies -----------------

/** How a polygon is sized against its construction circle: its corners on
 *  the circle (inscribed), or its sides touching it (circumscribed) — the
 *  circle's diameter then the width across flats, a hex nut's size. */
export type PolygonFit = 'inscribed' | 'circumscribed'

/** The most sides a polygon is drawn with. */
export const POLYGON_MAX_SIDES = 64

/** A regular polygon's corners, in order counter-clockwise, about `centre`:
 *  `at` is a corner for an inscribed one, the middle of a side for a
 *  circumscribed one. Null with under three sides or no size. */
export function polygonCorners(centre: Vec2, at: Vec2, sides: number, fit: PolygonFit): Vec2[] | null {
  const n = Math.round(sides)
  if (!(n >= 3 && n <= POLYGON_MAX_SIDES)) return null
  const d = sub2(at, centre)
  const r = len2(d)
  if (!(r > 1e-9)) return null
  const half = Math.PI / n
  // A circumscribed polygon's corner lies half a side's turn round from the
  // middle of the side clicked, further out by 1 / cos of that turn.
  const radius = fit === 'inscribed' ? r : r / Math.cos(half)
  const start = Math.atan2(d[1], d[0]) - (fit === 'inscribed' ? 0 : half)
  const out: Vec2[] = []
  for (let i = 0; i < n; i++) {
    const t = start + (2 * Math.PI * i) / n
    out.push([centre[0] + radius * Math.cos(t), centre[1] + radius * Math.sin(t)])
  }
  return out
}

/** A regular polygon as CAD draws one: its corners on a construction
 *  circle and its sides all one length. Circumscribed, a second circle is
 *  drawn inside it, about the same centre and touching a side — the width
 *  across flats, what it is then dimensioned by. (Every side held tangent
 *  to that circle, as the obvious way has it, is singular where it is met:
 *  a tangency and a side's middle on the circle say one thing to first
 *  order, and with equal sides alone a polygon of an even count of them
 *  leans into alternating angles.) Its turn is left to a relation or a
 *  dimension on a side. The lines, from the corner clicked round (from the
 *  side clicked, circumscribed); `circle`, the circle it is sized by — the
 *  corners' inscribed, the inner one circumscribed; `rim`, the corners'. */
export function addPolygon(sketch: Sketch, centre: Vec2, at: Vec2, sides: number, fit: PolygonFit): { lines: number[]; circle: number; rim: number } | null {
  const corners = polygonCorners(centre, at, sides, fit)
  if (!corners) return null
  const n = corners.length
  // The pieces first, sides then circles, so they take ids in a run.
  const lines = corners.map((p, i) => addEntity(sketch, { kind: 'line', a: p, b: corners[(i + 1) % n] }))
  const rim = addEntity(sketch, { kind: 'circle', c: [centre[0], centre[1]], r: len2(sub2(corners[0], centre)), construction: true })
  const flats = fit === 'circumscribed' ? addEntity(sketch, { kind: 'circle', c: [centre[0], centre[1]], r: len2(sub2(at, centre)), construction: true }) : null
  for (let i = 0; i < n; i++) {
    addConstraint(sketch, { kind: 'coincident', p: { entity: lines[i], at: 'b' }, q: { entity: lines[(i + 1) % n], at: 'a' } })
    addConstraint(sketch, { kind: 'pointOn', p: { entity: lines[i], at: 'a' }, on: { curve: rim } })
    if (i > 0) addConstraint(sketch, { kind: 'equal', a: lines[0], b: lines[i] })
  }
  if (flats === null) return { lines, circle: rim, rim }
  addConstraint(sketch, { kind: 'concentric', a: flats, b: rim })
  addConstraint(sketch, { kind: 'tangent', a: lines[0], b: flats })
  return { lines, circle: flats, rim }
}

/** How pieces are repeated: along one or two directions in steps — a row,
 *  a grid — or round a centre. */
export type SketchPatternSpec =
  | {
      kind: 'rectangular'
      /** The step from one copy to the next along the first direction, and
       *  how many there are in all, the originals counted. */
      step: Vec2
      count: number
      /** A second direction, for a grid. */
      step2?: Vec2
      count2?: number
    }
  | {
      kind: 'circular'
      centre: Vec2
      count: number
      /** The angle the copies span, degrees, counter-clockwise: 360 for a
       *  full turn, which then holds `count` evenly — one less spacing
       *  than an open span. */
      angleDeg: number
    }

/** Where every copy a pattern makes goes, the originals left out: a turn
 *  about a centre, then a move. */
function patternPlacements(spec: SketchPatternSpec): { move: Vec2; turn: number; about: Vec2 }[] {
  const out: { move: Vec2; turn: number; about: Vec2 }[] = []
  if (spec.kind === 'rectangular') {
    const n1 = Math.max(1, Math.round(spec.count))
    const n2 = spec.step2 ? Math.max(1, Math.round(spec.count2 ?? 1)) : 1
    for (let j = 0; j < n2; j++) {
      for (let i = 0; i < n1; i++) {
        if (i === 0 && j === 0) continue
        const v: Vec2 = spec.step2 ? scale2(spec.step2, j) : [0, 0]
        out.push({ move: add2(scale2(spec.step, i), v), turn: 0, about: [0, 0] })
      }
    }
    return out
  }
  const n = Math.max(1, Math.round(spec.count))
  const full = Math.abs(Math.abs(spec.angleDeg) - 360) < 1e-9
  const step = n > 1 ? (spec.angleDeg * Math.PI) / 180 / (full ? n : n - 1) : 0
  for (let i = 1; i < n; i++) out.push({ move: [0, 0], turn: step * i, about: spec.centre })
  return out
}

/** A point carried by one of a pattern's placements. */
function placePoint(p: Vec2, at: { move: Vec2; turn: number; about: Vec2 }): Vec2 {
  const cos = Math.cos(at.turn)
  const sin = Math.sin(at.turn)
  const d = sub2(p, at.about)
  return add2(add2(at.about, [d[0] * cos - d[1] * sin, d[0] * sin + d[1] * cos]), at.move)
}

/** A relation or a dimension naming other pieces: a copy of it with every
 *  piece it names put through `id`. */
export function renumbered(c: ConstraintInput, id: (old: number) => number): ConstraintInput {
  const copy = JSON.parse(JSON.stringify(c)) as Record<string, unknown>
  for (const k of ['entity', 'a', 'b', 'line']) if (typeof copy[k] === 'number') copy[k] = id(copy[k] as number)
  for (const k of ['p', 'q', 'on', 'about']) {
    const v = copy[k] as { entity?: number; line?: number; curve?: number } | undefined
    if (typeof v !== 'object' || v === null) continue
    if (v.entity !== undefined) v.entity = id(v.entity)
    if (v.line !== undefined) v.line = id(v.line)
    if (v.curve !== undefined) v.curve = id(v.curve)
  }
  return copy as unknown as ConstraintInput
}

/**
 * Copies of the pieces given, as a pattern lays them: every copy a piece of
 * its own, with the relations and dimensions that hold the pieces among
 * themselves copied onto it — a copied rectangle is a rectangle of the same
 * size, dimensioned the same, its dimensions reading the same expressions.
 * What ties a piece to anything outside the set (another piece, a
 * coordinate plane, a sheet axis, a Fix) stays with the original. A copy
 * turned by a quarter has its horizontals and verticals swapped; turned
 * by anything else that is not a half turn, its sides held level or
 * upright are held parallel and square to one another instead, so it
 * keeps its shape where the pattern turned it.
 * Construction pieces are copied as construction. Returns the ids of the
 * new pieces, copy by copy, in the order the pieces were given.
 */
export function patternPieces(sketch: Sketch, ids: readonly number[], spec: SketchPatternSpec): number[][] {
  const set = new Set(ids)
  const pieces = sketch.entities.filter((e) => set.has(e.id))
  if (pieces.length === 0) return []
  const inner = sketch.constraints.filter((c) => {
    if (!constraintEntities(c).every((id) => set.has(id))) return false
    if ((c.kind === 'distance' && 'datum' in c.q) || ((c.kind === 'pointOn' || c.kind === 'collinear') && 'datum' in c.on)) return false
    if (c.kind === 'symmetric' && (typeof c.about !== 'object' || 'datum' in c.about)) return false
    return true
  })
  const copies: number[][] = []
  for (const at of patternPlacements(spec)) {
    const place = (p: Vec2) => placePoint(p, at)
    const map = new Map<number, number>()
    for (const e of pieces) {
      const base = e.construction ? { construction: true } : {}
      const made: EntityInput =
        e.kind === 'line'
          ? { kind: 'line', a: place(e.a), b: place(e.b), ...base }
          : e.kind === 'arc'
            ? { kind: 'arc', c: place(e.c), r: e.r, start: e.start + at.turn, sweep: e.sweep, ...base }
            : e.kind === 'circle'
              ? { kind: 'circle', c: place(e.c), r: e.r, ...base }
              : e.kind === 'spline'
                ? {
                    kind: 'spline',
                    pts: e.pts.map(place),
                    ...(e.closed ? { closed: true } : {}),
                    ...(e.startDir !== undefined ? { startDir: e.startDir + at.turn } : {}),
                    ...(e.endDir !== undefined ? { endDir: e.endDir + at.turn } : {}),
                    ...base,
                  }
                : { kind: 'point', p: place(e.p), ...base }
      map.set(e.id, addEntity(sketch, made))
    }
    const id = (old: number) => map.get(old)!
    // The turn in quarters, where it is a whole number of them.
    const q = at.turn / (Math.PI / 2)
    const quarters = Math.abs(q - Math.round(q)) < 1e-9 ? ((Math.round(q) % 4) + 4) % 4 : null
    const square: Extract<Constraint, { kind: 'horizontal' | 'vertical' }>[] = []
    for (const c of inner) {
      const { id: _id, place: _place, ...rest } = c
      void _id
      void _place
      if (c.kind === 'horizontal' || c.kind === 'vertical') {
        if (quarters === null) {
          square.push(c)
          continue
        }
        if (quarters % 2 === 1) (rest as { kind: string }).kind = c.kind === 'horizontal' ? 'vertical' : 'horizontal'
      }
      addConstraint(sketch, renumbered(rest as ConstraintInput, id))
    }
    // Turned off the axes: each side that was level or upright parallel
    // or square to the first such side.
    const first = square[0]
    for (const c of square.slice(1)) {
      if (c.entity === first.entity) continue
      addConstraint(sketch, { kind: c.kind === first.kind ? 'parallel' : 'perpendicular', a: id(first.entity), b: id(c.entity), ...(c.inferred ? { inferred: true } : {}) })
    }
    copies.push(pieces.map((e) => id(e.id)))
  }
  return copies
}

/** Ends this close are one corner — the distance a closed region is found
 *  across (regions.ts), far under anything a sketch would mean as two
 *  points. */
export const TOUCH_MM = 2e-3

/**
 * The relations a sketch drawn by hand would have been given as it was
 * drawn, put on pieces handed in as coordinates: a coincidence where two
 * ends meet — the ends of lines and arcs within TOUCH_MM of each other,
 * joined only where no chain of coincidences joins them already — and
 * horizontal or vertical on a line lying exactly level or upright that has
 * neither. With `pieces`, only what touches one of those. A line in
 * `shaped` is a side of a shape its own relations hold — a polygon's, a
 * rectangle's — which a level of its own would say twice. Marked inferred,
 * as the panel marks its own. Returns how many were added.
 */
export function inferRelations(sketch: Sketch, pieces?: ReadonlySet<number>, shaped?: ReadonlySet<number>): number {
  const ends: { anchor: Anchor; p: Vec2 }[] = []
  for (const e of sketch.entities) for (const at of endsOf(e)) ends.push({ anchor: { entity: e.id, at }, p: anchorPoint(e, at) })
  const key = (a: Anchor) => `${a.entity}:${a.at}`
  const parent = new Map<string, string>()
  const find = (k: string): string => {
    let r = k
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!
    parent.set(k, r)
    return r
  }
  for (const c of sketch.constraints) if (c.kind === 'coincident') parent.set(find(key(c.p)), find(key(c.q)))
  // Ends bucketed by where they lie, so a sketch of thousands of pieces
  // compares neighbours only.
  const size = TOUCH_MM * 4
  const grid = new Map<string, number[]>()
  ends.forEach((e, i) => {
    const k = `${Math.floor(e.p[0] / size)},${Math.floor(e.p[1] / size)}`
    const list = grid.get(k)
    if (list) list.push(i)
    else grid.set(k, [i])
  })
  let added = 0
  ends.forEach((e, i) => {
    const cx = Math.floor(e.p[0] / size)
    const cy = Math.floor(e.p[1] / size)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (j <= i) continue
          const f = ends[j]
          if (f.anchor.entity === e.anchor.entity) continue
          if (pieces && !pieces.has(e.anchor.entity) && !pieces.has(f.anchor.entity)) continue
          if (len2(sub2(e.p, f.p)) > TOUCH_MM) continue
          if (find(key(e.anchor)) === find(key(f.anchor))) continue
          addConstraint(sketch, { kind: 'coincident', p: e.anchor, q: f.anchor, inferred: true })
          parent.set(find(key(e.anchor)), find(key(f.anchor)))
          added++
        }
      }
    }
  })
  for (const e of sketch.entities) {
    if (e.kind !== 'line' || e.construction || (pieces && !pieces.has(e.id)) || shaped?.has(e.id)) continue
    if (sketch.constraints.some((c) => (c.kind === 'horizontal' || c.kind === 'vertical') && c.entity === e.id)) continue
    const axis = axisRelationOf(e.a, e.b, 1e-6)
    if (!axis) continue
    addConstraint(sketch, { kind: axis, entity: e.id, inferred: true })
    added++
  }
  return added
}

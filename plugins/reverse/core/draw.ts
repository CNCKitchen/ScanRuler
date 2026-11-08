// SPDX-License-Identifier: AGPL-3.0-only
// What the drawing tools of the sketch work out before a piece is made: the
// arc that leaves a chain's last end tangent to the piece before it, and the
// dimension two clicks of the Dimension tool ask for. No store, no sheet —
// the store calls these with what was clicked.

import type { Vec2 } from '../../../src/core/flat/types'
import { add2, cross2, dot2, len2, perp2, scale2, sub2 } from '../../../src/core/flat/vec2'
import { anchorPoint, anchorsOf, entityOf, lineDir, nearestOnEntity, pickPointsOf, type Anchor, type AnchorAt, type ConstraintInput, type PolygonFit, type Sketch, type SketchEntity } from './sketch'
import { traceNear, traceOf, type DatumPlane, type DatumTrace } from './datums'
import { measureDimension } from './solver'

/** The direction a piece runs on in past one of its ends — what a tangent
 *  arc begun there leaves along. Null for a piece without ends. */
export function outwardTangent(e: SketchEntity, at: AnchorAt): Vec2 | null {
  if (e.kind === 'line') {
    const d = lineDir(e)
    if (!d || at === 'center') return null
    return at === 'b' ? d : scale2(d, -1)
  }
  if (e.kind === 'arc') {
    if (at === 'center') return null
    // Counter-clockwise past the end, clockwise back past the start.
    const theta = at === 'b' ? e.start + e.sweep : e.start
    const ccw: Vec2 = [-Math.sin(theta), Math.cos(theta)]
    return at === 'b' ? ccw : scale2(ccw, -1)
  }
  return null
}

/**
 * The arc from `p` to `q` that leaves `p` along the unit direction `t` — the
 * one a line tool draws when the hand presses on the chain's last end and
 * drags. In the entity's terms: an arc runs counter-clockwise, so
 * `startsAtP` says whether anchor 'a' lies at `p` or at `q`. Null when `q`
 * lies straight ahead or on `p`, where no arc is tangent.
 */
export function tangentArc(p: Vec2, t: Vec2, q: Vec2): { c: Vec2; r: number; start: number; sweep: number; startsAtP: boolean } | null {
  const pq = sub2(q, p)
  const l = len2(pq)
  if (!(l > 1e-9)) return null
  const n = perp2(t)
  const h = dot2(pq, n)
  if (Math.abs(h) < 1e-6 * l) return null
  // The centre lies square to the tangent, as far off as puts q on the rim.
  const signed = (l * l) / (2 * h)
  const c = add2(p, scale2(n, signed))
  const two = 2 * Math.PI
  const thetaP = Math.atan2(p[1] - c[1], p[0] - c[0])
  const thetaQ = Math.atan2(q[1] - c[1], q[0] - c[0])
  const ccw = (from: number, to: number) => (((to - from) % two) + two) % two
  // Centre on the left: the hand goes round counter-clockwise from p.
  return signed > 0
    ? { c, r: signed, start: thetaP, sweep: ccw(thetaP, thetaQ), startsAtP: true }
    : { c, r: -signed, start: thetaQ, sweep: ccw(thetaQ, thetaP), startsAtP: false }
}

/** What the Dimension tool has under a click: a whole piece, a point — an
 *  end of a line or an arc, a point piece, an arc's centre — or one of the
 *  part's coordinate planes, clicked on the line it cuts the sheet in. A
 *  line's middle or a round piece's quadrant is a point that lies on its
 *  piece (`of`): it stands for the piece (see paired) except beside another
 *  point, so a line clicked at its middle is still its length, and two
 *  lines clicked so still their angle. */
export type DimPick = { kind: 'piece'; id: number } | { kind: 'point'; anchor: Anchor; of?: number } | { kind: 'datum'; plane: DatumPlane }

/**
 * A pick as the pair it is in reads it: a line's middle or a quadrant (a
 * point `of` a piece) is that point beside a point of the sketch's own — an
 * end, a centre, a point piece — and its piece beside anything else: a
 * piece, a plane, another middle or quadrant, or nothing (one pick alone).
 */
export function paired(p: DimPick, other: DimPick | null): DimPick {
  if (p.kind !== 'point' || p.of === undefined) return p
  return other?.kind === 'point' && other.of === undefined ? { kind: 'point', anchor: p.anchor } : { kind: 'piece', id: p.of }
}

/** The pick at a spot on the sheet: an end within reach wins over the piece
 *  it ends, as the smaller target; a centre is taken through its piece; a
 *  coordinate plane's line is taken last, where nothing of the sketch is. */
export function dimPickAt(sketch: Sketch, spot: Vec2, radius: number, datums: readonly DatumTrace[] = []): DimPick | null {
  let point: Anchor | null = null
  let pointD = radius * 0.75
  for (const e of sketch.entities) {
    if (e.kind === 'circle') continue
    for (const at of anchorsOf(e)) {
      const d = len2(sub2(anchorPoint(e, at), spot))
      if (d <= pointD) {
        pointD = d
        point = { entity: e.id, at }
      }
    }
  }
  if (point) return { kind: 'point', anchor: point }
  // A line's middle, an arc's centre, a round piece's quadrants: points to
  // dimension from too, as CAD offers them — within a smaller reach than an
  // end's, so a click on a line near its middle is still the line, as it
  // reads under the cursor (the point is lit when it is what is taken).
  const extra = pickPointAt(sketch, spot, radius * PICK_POINT_REACH)
  if (extra) {
    // An arc's centre is a point of its own; a middle or a quadrant lies on
    // its piece.
    const on = entityOf(sketch, extra.entity)?.kind === 'arc' && extra.at === 'center' ? undefined : extra.entity
    return { kind: 'point', anchor: extra, ...(on !== undefined ? { of: on } : {}) }
  }
  let piece: SketchEntity | null = null
  let pieceD = radius
  for (const e of sketch.entities) {
    const { dist } = nearestOnEntity(e, spot)
    if (dist <= pieceD) {
      pieceD = dist
      piece = e
    }
  }
  if (piece) return { kind: 'piece', id: piece.id }
  const datum = traceNear(datums, spot, radius)
  return datum ? { kind: 'datum', plane: datum.plane } : null
}

/** The share of the hand's reach within which a line's middle, an arc's
 *  centre or a quadrant is picked rather than the piece it lies on. */
const PICK_POINT_REACH = 0.45

/** The nearest of the pieces' pick points (pickPointsOf) within `reach`. */
export function pickPointAt(sketch: Sketch, spot: Vec2, reach: number): Anchor | null {
  let best: Anchor | null = null
  let bestD = reach
  for (const e of sketch.entities) {
    for (const at of pickPointsOf(e)) {
      const d = len2(sub2(anchorPoint(e, at), spot))
      if (d <= bestD) {
        bestD = d
        best = { entity: e.id, at }
      }
    }
  }
  return best
}

/** What the Coincident relation has under a click: as the Dimension tool's
 *  pick, with a circle's centre a point too — a centre is what a circle
 *  is held by. */
export function relPickAt(sketch: Sketch, spot: Vec2, radius: number, datums: readonly DatumTrace[] = []): DimPick | null {
  let centre: Anchor | null = null
  let centreD = radius * 0.75
  for (const e of sketch.entities) {
    if (e.kind !== 'circle') continue
    const d = len2(sub2(e.c, spot))
    if (d <= centreD) {
      centreD = d
      centre = { entity: e.id, at: 'center' }
    }
  }
  const pick = dimPickAt(sketch, spot, radius, datums)
  // A centre within reach wins over the rim it is inside of, as an end
  // wins over its line.
  if (centre && (!pick || pick.kind !== 'point')) return { kind: 'point', anchor: centre }
  return pick
}

/**
 * The relation two picks make coincident, as CAD reads the pair: two
 * points meet; a point lies on a line, on a round piece's rim or on a
 * coordinate plane's line; a line lies along another line or along a
 * plane's line. A pair that makes none — two round pieces, two planes, a
 * round piece and a line — says why in a sentence.
 */
export function coincidentFor(sketch: Sketch, firstPick: DimPick, secondPick: DimPick): ConstraintInput | string {
  const first = paired(firstPick, secondPick)
  const second = paired(secondPick, firstPick)
  const piece = (p: DimPick) => (p.kind === 'piece' ? (entityOf(sketch, p.id) ?? null) : null)
  const round = (e: SketchEntity | null) => e !== null && (e.kind === 'arc' || e.kind === 'circle')
  const same = (a: DimPick, b: DimPick) => (a.kind === 'point' && b.kind === 'point' ? a.anchor.entity === b.anchor.entity : a.kind === 'piece' && b.kind === 'piece' ? a.id === b.id : a.kind === 'point' && b.kind === 'piece' ? a.anchor.entity === b.id : a.kind === 'piece' && b.kind === 'point' ? a.id === b.anchor.entity : a.kind === 'datum' && b.kind === 'datum' && a.plane === b.plane)
  if (same(first, second)) return 'Pick two different things to make coincident.'
  // A point pick, whichever came first, and what it lies on.
  const point = first.kind === 'point' ? first : second.kind === 'point' ? second : null
  const other = point === first ? second : first
  if (point) {
    if (other.kind === 'point') return { kind: 'coincident', p: point.anchor, q: other.anchor }
    if (other.kind === 'datum') return { kind: 'pointOn', p: point.anchor, on: { datum: other.plane } }
    const e = piece(other)
    if (!e) return 'That piece is gone.'
    if (e.kind === 'line') return { kind: 'pointOn', p: point.anchor, on: { line: e.id } }
    if (round(e) || e.kind === 'spline') return { kind: 'pointOn', p: point.anchor, on: { curve: e.id } }
    // A point piece: its one point.
    return { kind: 'coincident', p: point.anchor, q: { entity: e.id, at: 'center' } }
  }
  if (first.kind === 'datum' && second.kind === 'datum') return 'Two coordinate planes cannot be made coincident.'
  // Two pieces, or a piece and a plane.
  const a = piece(first)
  const b = piece(second)
  const line = a?.kind === 'line' ? a : b?.kind === 'line' ? b : null
  const rest = line === a ? (second.kind === 'datum' ? second : b) : first.kind === 'datum' ? first : a
  if (a?.kind === 'point' || b?.kind === 'point') {
    const pt = a?.kind === 'point' ? a : b!
    const onto = a?.kind === 'point' ? second : first
    return coincidentFor(sketch, { kind: 'point', anchor: { entity: pt.id, at: 'center' } }, onto)
  }
  if (a?.kind === 'spline' || b?.kind === 'spline') return 'A spline is joined by its ends or its fit points — pick one of those, then what it lies on.'
  if (!line) return round(a) && round(b) ? 'Two round pieces are held by Tangent or Concentric, not Coincident.' : 'Coincident takes a point, a line, or a coordinate plane’s line.'
  if (!rest) return 'That piece is gone.'
  if ('kind' in rest && rest.kind === 'datum') return { kind: 'collinear', line: line.id, on: { datum: rest.plane } }
  const e = rest as SketchEntity
  if (e.kind === 'line') return { kind: 'collinear', line: line.id, on: { line: e.id } }
  if (round(e)) return 'A line and a round piece are held by Tangent, not Coincident — or pick an end of the line.'
  return 'Coincident takes a point, a line, or a coordinate plane’s line.'
}

/** Two lines closer to parallel than this are dimensioned by the distance
 *  between them, not by an angle of next to nothing. */
const PARALLEL_DEG = 2

/**
 * The dimension the picks ask for, at the value measured now. One pick: a
 * line's length, an arc's radius, a circle's diameter. Two: between parallel lines
 * their distance, between other lines their angle, from a point or a round
 * piece's centre to a line the perpendicular distance, between two points
 * or centres the distance; from a point, a centre or a line lying parallel
 * to it to a coordinate plane the distance to the plane. Null when nothing
 * applies — a point alone, a plane alone.
 */
export function dimensionFor(sketch: Sketch, firstPick: DimPick, secondPick: DimPick | null, datums: readonly DatumTrace[] = []): ConstraintInput | null {
  const first = paired(firstPick, secondPick)
  const second = secondPick && paired(secondPick, firstPick)
  const piece = (p: DimPick) => (p.kind === 'piece' ? (entityOf(sketch, p.id) ?? null) : null)
  if (first.kind === 'datum' || second?.kind === 'datum') {
    const plane = first.kind === 'datum' ? first : second?.kind === 'datum' ? second : null
    const other = first.kind === 'datum' ? second : first
    if (!plane || !other || other.kind === 'datum') return null
    const trace = traceOf(datums, plane.plane)
    if (!trace) return null
    let p: Anchor | null = null
    if (other.kind === 'point') p = other.anchor
    else {
      const e = piece(other)
      if (e?.kind === 'line') {
        // A line is a distance from the plane only where it runs along it.
        const d = lineDir(e)
        if (!d || Math.abs(dot2(d, trace.n)) > Math.sin((PARALLEL_DEG * Math.PI) / 180)) return null
        p = { entity: e.id, at: 'a' }
      } else if (e && e.kind !== 'spline') p = { entity: e.id, at: 'center' }
    }
    if (!p) return null
    const v = measureDimension(sketch, 'distance', p, { datum: plane.plane }, datums)
    return v === null || v < 1e-6 ? null : { kind: 'distance', p, q: { datum: plane.plane }, value: v }
  }
  /** The pick as a point: itself, or a round piece's centre. */
  const pointOf = (p: DimPick): Anchor | null => {
    if (p.kind === 'point') return p.anchor
    const e = piece(p)
    return e && e.kind !== 'line' && e.kind !== 'spline' ? { entity: e.id, at: 'center' } : null
  }
  const a = piece(first)
  if (!second || (second.kind === 'piece' && first.kind === 'piece' && second.id === first.id)) {
    if (a?.kind === 'line') {
      const v = measureDimension(sketch, 'length', a)
      return v === null ? null : { kind: 'length', entity: a.id, value: v }
    }
    // A full circle is a hole or a boss, given by its diameter as a drawing
    // gives it; an arc — a round corner, a slot's end — by its radius.
    if (a?.kind === 'circle') return { kind: 'diameter', entity: a.id, value: 2 * a.r }
    if (a?.kind === 'arc') return { kind: 'radius', entity: a.id, value: a.r }
    return null
  }
  const b = piece(second)
  if (a?.kind === 'line' && b?.kind === 'line') {
    const da = lineDir(a)
    const db = lineDir(b)
    if (!da || !db) return null
    if (Math.abs(cross2(da, db)) < Math.sin((PARALLEL_DEG * Math.PI) / 180)) {
      const p: Anchor = { entity: a.id, at: 'a' }
      const v = measureDimension(sketch, 'distance', p, { line: b.id })
      return v === null ? null : { kind: 'distance', p, q: { line: b.id }, value: v }
    }
    const v = measureDimension(sketch, 'angle', a, b)
    return v === null ? null : { kind: 'angle', a: a.id, b: b.id, value: v }
  }
  const line = a?.kind === 'line' ? a : b?.kind === 'line' ? b : null
  if (line) {
    const p = pointOf(a?.kind === 'line' ? second : first)
    // An end of the line itself is no distance from it.
    if (!p || p.entity === line.id) return null
    const v = measureDimension(sketch, 'distance', p, { line: line.id })
    // A corner the line shares lies on it just the same.
    return v === null || v < 1e-6 ? null : { kind: 'distance', p, q: { line: line.id }, value: v }
  }
  const p = pointOf(first)
  const q = pointOf(second)
  if (!p || !q || (p.entity === q.entity && p.at === q.at)) return null
  const v = measureDimension(sketch, 'distance', p, q)
  return v === null || v < 1e-9 ? null : { kind: 'distance', p, q, value: v }
}

/** Whether a first pick is a dimension by itself the moment it is made — a
 *  round piece's radius or diameter, a line's length — or waits for a second click, as
 *  a point and a coordinate plane do. */
export function dimensionIsImmediate(sketch: Sketch, given: DimPick): boolean {
  const pick = paired(given, null)
  if (pick.kind !== 'piece') return false
  const e = entityOf(sketch, pick.id)
  return e?.kind === 'arc' || e?.kind === 'circle' || e?.kind === 'line'
}

// ---- the ways a rectangle, a circle and an arc are drawn ---------------------

/** A rectangle from two opposite corners, from its centre and a corner, or
 *  from one side's two ends and a click where the opposite side lies — the
 *  one way that draws it at an angle. */
export type RectangleMode = 'corners' | 'center' | 'threePoint'
/** A circle from its centre and a point on the rim, from the two ends of a
 *  diameter, or through three points on the rim. */
export type CircleMode = 'center' | 'twoPoint' | 'threePoint'
/** An arc from its two ends and a point it passes through, or from its
 *  centre, its start and where it ends. */
export type ArcMode = 'threePoint' | 'center'
/** A polygon from its centre and a corner (inscribed in its circle), or
 *  from its centre and the middle of a side (circumscribed — the circle's
 *  diameter the width across flats). */
export type PolygonMode = PolygonFit

export interface DrawModes {
  rectangle: RectangleMode
  circle: CircleMode
  arc: ArcMode
  polygon: PolygonMode
}

export const DEFAULT_DRAW_MODES: DrawModes = { rectangle: 'corners', circle: 'center', arc: 'threePoint', polygon: 'inscribed' }

/** How many clicks a drawing tool takes, in the mode it is in. */
export function drawClicks(tool: string, modes: DrawModes): number {
  if (tool === 'arc') return 3
  if (tool === 'polygon') return 2
  if (tool === 'rectangle') return modes.rectangle === 'threePoint' ? 3 : 2
  if (tool === 'circle') return modes.circle === 'threePoint' ? 3 : 2
  return 2
}

const SAME = 1e-9

/** A rectangle's four corners, in order round it, from the clicks of its
 *  mode; the first is the first click's for the two-corner and three-point
 *  ways, and the clicked corner is the third for the centre way. Null when
 *  it would have no area. */
export function rectangleCorners(mode: RectangleMode, clicks: readonly Vec2[]): Vec2[] | null {
  const [p, q, r] = clicks
  if (!p || !q) return null
  if (mode === 'threePoint') {
    const side = sub2(q, p)
    const l = len2(side)
    if (!r || l < SAME) return null
    const n = perp2(scale2(side, 1 / l))
    const h = dot2(sub2(r, p), n)
    if (Math.abs(h) < SAME) return null
    const across = scale2(n, h)
    return [p, q, add2(q, across), add2(p, across)]
  }
  // The centre way mirrors the clicked corner through the centre.
  const a = mode === 'center' ? sub2(scale2(p, 2), q) : p
  const b = q
  if (Math.abs(a[0] - b[0]) < SAME || Math.abs(a[1] - b[1]) < SAME) return null
  return [a, [b[0], a[1]], b, [a[0], b[1]]]
}

/** A circle from the clicks of its mode, or null when three points lie on a
 *  line or two coincide. */
export function circleFrom(mode: CircleMode, clicks: readonly Vec2[]): { c: Vec2; r: number } | null {
  const [p, q, s] = clicks
  if (!p || !q) return null
  if (mode === 'threePoint') {
    const through = s ? circleThrough(p, q, s) : null
    return through
  }
  const r = mode === 'twoPoint' ? len2(sub2(q, p)) / 2 : len2(sub2(q, p))
  if (r < SAME) return null
  return { c: mode === 'twoPoint' ? scale2(add2(p, q), 0.5) : p, r }
}

/** The circle through three points, or null when they lie on a line. */
function circleThrough(p: Vec2, q: Vec2, s: Vec2): { c: Vec2; r: number } | null {
  const d = 2 * cross2(sub2(q, p), sub2(s, p))
  if (Math.abs(d) < SAME) return null
  const qp = sub2(q, p)
  const sp = sub2(s, p)
  const q2 = dot2(qp, qp)
  const s2 = dot2(sp, sp)
  const c: Vec2 = [p[0] + (sp[1] * q2 - qp[1] * s2) / d, p[1] + (qp[0] * s2 - sp[0] * q2) / d]
  return { c, r: len2(sub2(p, c)) }
}

/** An arc from its centre, its start and a click where it ends: the circle
 *  through the start about the centre, from the start round to the end's
 *  direction the shorter way — the way the cursor went, for any arc up to a
 *  half circle; a longer one is drawn through three points. `startsAtP` as
 *  arcThrough has it: whether anchor 'a' is at the start. Null when the
 *  start is on the centre or the end on the start. */
export function arcAbout(c: Vec2, start: Vec2, end: Vec2): { c: Vec2; r: number; start: number; sweep: number; startsAtP: boolean } | null {
  const r = len2(sub2(start, c))
  const towards = sub2(end, c)
  if (r < SAME || len2(towards) < SAME) return null
  const from = Math.atan2(start[1] - c[1], start[0] - c[0])
  const to = Math.atan2(towards[1], towards[0])
  const two = 2 * Math.PI
  const ccw = (((to - from) % two) + two) % two
  if (ccw < 1e-9 || two - ccw < 1e-9) return null
  // Counter-clockwise the shorter way, the start is anchor 'a'; clockwise
  // the arc is the same piece run from the end's side.
  return ccw <= Math.PI ? { c, r, start: from, sweep: ccw, startsAtP: true } : { c, r, start: to, sweep: two - ccw, startsAtP: false }
}

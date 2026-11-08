// SPDX-License-Identifier: AGPL-3.0-only
// A sketch dimension as a drawing carries it, the way Onshape and Fusion put
// it on the sheet: extension lines off the two measured points, a dimension
// line between them with a filled arrow at each end, the number written
// along the line in a gap left for it; a radius as a leader with its arrow on
// the rim; a diameter as a line through the centre, an arrow on the rim at
// each end; an angle as an arc between the two lines. The number is where the
// operator dragged it (Constraint.place), or where the layout puts it.
//
// Two steps, both pure. dimShape reads the sketch: what is measured and where
// the number sits, in sheet millimetres. dimStrokes turns that into lines and
// arrowheads for one zoom — the arrows, the gaps and the overshoot are sized
// in screen pixels, so the strokes are made again when the zoom changes and
// the shape is not.

import type { Vec2 } from '../../../src/core/flat/types'
import { add2, dot2, len2, normalize2, perp2, scale2, sub2 } from '../../../src/core/flat/vec2'
import type { DimShape } from '../../../src/core/flat/dimStrokes'
import { traceFoot, traceOf, type DatumTrace } from './datums'
import { anchorPoint, entityOf, lineDir, sketchBounds, type Constraint, type DimPlace, type DistanceAxis, type Sketch } from './sketch'

export type Dimension = Extract<Constraint, { value: number }>

export { dimStrokes, type DimShape, type DimStrokes } from '../../../src/core/flat/dimStrokes'

/** Where a distance between two points is pulled to by the hand, as CAD
 *  reads it: square above or below the two, within their span along u, it
 *  measures along u ('x', their ΔX); beside them, within their span along v,
 *  along v ('y'); anywhere else straight across (undefined). Two points level
 *  offer no ΔY to pull to, two upright no ΔX. */
export function distanceAxisAt(p: Vec2, q: Vec2, at: Vec2): DistanceAxis | undefined {
  const [x0, x1] = p[0] <= q[0] ? [p[0], q[0]] : [q[0], p[0]]
  const [y0, y1] = p[1] <= q[1] ? [p[1], q[1]] : [q[1], p[1]]
  const tiny = 1e-6 * Math.max(1, x1 - x0 + (y1 - y0))
  const inX = at[0] >= x0 && at[0] <= x1
  const inY = at[1] >= y0 && at[1] <= y1
  if (inX && !inY && x1 - x0 > tiny) return 'x'
  if (inY && !inX && y1 - y0 > tiny) return 'y'
  return undefined
}

/** The two anchors' points a distance between two points runs between, or
 *  null for any other dimension. */
export function distanceEnds(c: Dimension, sketch: Sketch): [Vec2, Vec2] | null {
  if (c.kind !== 'distance' || !('entity' in c.q)) return null
  const p = entityOf(sketch, c.p.entity)
  const q = entityOf(sketch, c.q.entity)
  return p && q ? [anchorPoint(p, c.p.at), anchorPoint(q, c.q.at)] : null
}

/** The two points a length or a distance is measured between. */
function measuredPoints(c: Dimension, sketch: Sketch, datums: readonly DatumTrace[]): [Vec2, Vec2] | null {
  if (c.kind === 'length') {
    const e = entityOf(sketch, c.entity)
    return e?.kind === 'line' ? [e.a, e.b] : null
  }
  if (c.kind !== 'distance') return null
  const p = entityOf(sketch, c.p.entity)
  if (!p) return null
  const a = anchorPoint(p, c.p.at)
  if ('datum' in c.q) {
    const trace = traceOf(datums, c.q.datum)
    return trace ? [a, traceFoot(trace, a)] : null
  }
  if ('line' in c.q) {
    const l = entityOf(sketch, c.q.line)
    if (!l || l.kind !== 'line') return null
    const n = perp2(lineDir(l) ?? [1, 0])
    return [a, sub2(a, scale2(n, dot2(sub2(a, l.a), n)))]
  }
  const q = entityOf(sketch, c.q.entity)
  return q ? [a, anchorPoint(q, c.q.at)] : null
}

/** The angle's arc as it stands: from the first line's direction
 *  counter-clockwise by the angle the solver reads, 0–180°, which ends on the
 *  second line's carrier — so the arc drawn is the angle the number says. */
function angleSector(c: Extract<Dimension, { kind: 'angle' }>, sketch: Sketch) {
  const a = entityOf(sketch, c.a)
  const b = entityOf(sketch, c.b)
  if (!a || !b || a.kind !== 'line' || b.kind !== 'line') return null
  const da = lineDir(a)
  const db = lineDir(b)
  if (!da || !db) return null
  const cross = da[0] * db[1] - da[1] * db[0]
  // The rays meet where the carriers cross, or at the first line's middle.
  let vertex: Vec2 = [(a.a[0] + a.b[0]) / 2, (a.a[1] + a.b[1]) / 2]
  if (Math.abs(cross) > 1e-9) {
    const w = sub2(b.a, a.a)
    vertex = add2(a.a, scale2(da, (w[0] * db[1] - w[1] * db[0]) / cross))
  }
  const turn = Math.atan2(cross, dot2(da, db))
  const sweep = ((turn % Math.PI) + Math.PI) % Math.PI
  const lines: [[Vec2, Vec2], [Vec2, Vec2]] = [[a.a, a.b], [b.a, b.b]]
  return { vertex, a0: Math.atan2(da[1], da[0]), sweep, lines, shorter: Math.min(len2(sub2(a.b, a.a)), len2(sub2(b.b, b.a))) }
}

/**
 * What a dimension measures and where its number sits. `lift` is how far the
 * layout stands a number off its piece when the operator has not placed it —
 * sheet millimetres, a few percent of the sketch. Null when what the
 * dimension hangs on is gone.
 */
export function dimShape(c: Dimension, sketch: Sketch, datums: readonly DatumTrace[], lift: number): DimShape | null {
  const place: DimPlace | undefined = c.place
  if (c.kind === 'diameter') {
    const e = entityOf(sketch, c.entity)
    if (!e || (e.kind !== 'arc' && e.kind !== 'circle')) return null
    const angle = place ? place.off : e.kind === 'arc' ? e.start + e.sweep / 2 : Math.PI / 4
    return { kind: 'diameter', c: e.c, r: e.r, angle, reach: place ? Math.max(0, place.along) : e.r + 2 * lift }
  }
  if (c.kind === 'radius') {
    const e = entityOf(sketch, c.entity)
    if (!e || (e.kind !== 'arc' && e.kind !== 'circle')) return null
    const span = e.kind === 'arc' ? { start: e.start, sweep: e.sweep } : null
    return {
      kind: 'radius',
      c: e.c,
      r: e.r,
      angle: place ? place.off : span ? span.start + span.sweep / 2 : Math.PI / 4,
      reach: place ? Math.max(0, place.along) : e.r + 2 * lift,
      span,
    }
  }
  if (c.kind === 'angle') {
    const s = angleSector(c, sketch)
    if (!s) return null
    const radius = place ? Math.max(place.off, 1e-6) : Math.max(lift, Math.min(0.35 * s.shorter, 4 * lift))
    return { kind: 'angle', vertex: s.vertex, a0: s.a0, sweep: s.sweep, radius, at: place ? place.along : s.a0 + s.sweep / 2, lines: s.lines }
  }
  const ends = measuredPoints(c, sketch, datums)
  if (!ends) return null
  if (c.kind === 'distance' && c.axis && 'entity' in c.q) {
    // Along an axis: the line through the first point, along u or v, the
    // second point brought onto it square — its extension line standing
    // off by however far it lies off the first's level.
    const [a, b] = ends
    const k = c.axis === 'x' ? 0 : 1
    const sign = b[k] - a[k] < 0 ? -1 : 1
    const d: Vec2 = c.axis === 'x' ? [sign, 0] : [0, sign]
    const n = perp2(d)
    const q: Vec2 = c.axis === 'x' ? [b[0], a[1]] : [a[0], b[1]]
    return { kind: 'linear', p: a, q, d, n, off: place ? place.off : 0, along: place ? place.along : 0, lift: [0, dot2(sub2(b, q), n)] }
  }
  const d = normalize2(sub2(ends[1], ends[0]))
  if (!d) return null
  const n = perp2(d)
  // A line's length stands off the line, on the side away from the rest of
  // the sketch; a distance is drawn where it is measured until it is dragged
  // aside.
  let off = 0
  if (place) off = place.off
  else if (c.kind === 'length') {
    const b = sketchBounds(sketch)
    const middle: Vec2 = b ? [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2] : ends[0]
    off = dot2(sub2(middle, ends[0]), n) > 1e-9 ? -lift : lift
  }
  return { kind: 'linear', p: ends[0], q: ends[1], d, n, off, along: place ? place.along : 0 }
}

/** The place a number dragged to the sheet point `at` takes. */
export function dimPlaceAt(c: Dimension, sketch: Sketch, at: Vec2, datums: readonly DatumTrace[]): DimPlace | null {
  const shape = dimShape(c, sketch, datums, 1)
  if (!shape) return null
  if (shape.kind === 'linear') {
    const mid: Vec2 = [(shape.p[0] + shape.q[0]) / 2, (shape.p[1] + shape.q[1]) / 2]
    const w = sub2(at, mid)
    return { off: dot2(w, shape.n), along: dot2(w, shape.d) }
  }
  const centre = shape.kind === 'angle' ? shape.vertex : shape.c
  const w = sub2(at, centre)
  const reach = len2(w)
  if (!(reach > 1e-9)) return null
  const angle = Math.atan2(w[1], w[0])
  return shape.kind === 'angle' ? { off: reach, along: angle } : { off: angle, along: reach }
}

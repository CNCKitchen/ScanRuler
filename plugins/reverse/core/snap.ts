// SPDX-License-Identifier: AGPL-3.0-only
// Where a click or a dragged point on the sketch sheet lands: on the end or
// the centre of a piece already there (and is then held to it by a
// coincidence), on the sheet's zero (held to the axes that cross there), on
// the middle of a line, an arc's centre or a quadrant of a round piece's rim
// (held there the same way), on a dashed tracking line along X or Y from a
// point the hand passed over lately or where two of them cross, on one of
// the part's coordinate planes, on the body of a drawn or a projected piece
// (held on it by a point-on relation), on a point of the slice the scan cut,
// on the body of a piece fitted to the slice, or on the grid — in that
// order, each within the hand's reach — or exactly where the cursor is when
// nothing is near, or when snapping is switched off with Ctrl held, as
// Fusion has it. Everything of the sketch's own holds what lands on it, as
// every CAD sketcher infers a coincidence from a snap; a tracking line, the
// slice and the grid are places only. The grid is offered only when the
// operator switched grid snapping on; the grid is otherwise there to read
// against.

import type { Vec2 } from '../../../src/core/flat/types'
import { len2, sub2 } from '../../../src/core/flat/vec2'
import { anchorPoint, anchorsOf, nearestOnEntity, pickPointsOf, type Anchor, type Sketch } from './sketch'
import { traceFoot, traceNear, traceOffset, type DatumPlane, type DatumTrace } from './datums'

/** What there is to snap to besides the sketch itself. */
export interface SnapContext {
  /** The slice chains under the sketch, sheet millimetres. */
  chains?: readonly (readonly Vec2[])[] | null
  /** The grid's spacing at the current zoom, or none. */
  grid?: number | null
  /** The part's coordinate planes as the lines they cut the sheet in —
   *  the axes a profile is drawn on, as every CAD sketcher snaps to. */
  datums?: readonly DatumTrace[] | null
  /** Snapping switched off for this pick — Ctrl held. */
  off?: boolean
  /** Points the hand passed over lately — an end, a centre, a middle, the
   *  zero — newest first: a dashed line runs from each along the sheet's X
   *  and Y, and a point is placed on one, or where two cross, to stand
   *  level or upright with it (see trackingSnap). */
  track?: readonly Vec2[]
}

/** The share of the hand's reach within which the middle of a line is taken. */
const MIDPOINT_REACH = 0.5
/** The share of the hand's reach within which a coordinate plane's line is
 *  taken: less than an end's, so an end drawn near the axis is still the
 *  end that was meant. */
const DATUM_REACH = 0.75

export type SnapKind = 'anchor' | 'origin' | 'midpoint' | 'quadrant' | 'track' | 'datum' | 'edge' | 'entity' | 'grid'

/** The share of the hand's reach within which a tracking line is taken:
 *  less than a coordinate plane's, as a line nothing is held to. */
const TRACK_REACH = 0.5

/** A tracking line the point landed on: from the tracked point to where
 *  the point lies, along X or Y. */
export interface TrackGuide {
  from: Vec2
  to: Vec2
}

/**
 * The point on the tracking lines nearest the spot: where a vertical line
 * through one tracked point crosses a horizontal one through another (or the
 * same) when both are within `reach`; otherwise the foot on the nearer one.
 * Null when none is within reach. The guides are what to draw, dashed.
 */
export function trackingSnap(track: readonly Vec2[], spot: Vec2, reach: number): { point: Vec2; guides: TrackGuide[] } | null {
  let upright: Vec2 | null = null
  let uprightD = reach
  let level: Vec2 | null = null
  let levelD = reach
  for (const t of track) {
    const dx = Math.abs(spot[0] - t[0])
    const dy = Math.abs(spot[1] - t[1])
    // A line through the point the hand is on is no guide to it.
    if (dx <= reach && dy <= reach) continue
    if (dx < uprightD) {
      uprightD = dx
      upright = t
    }
    if (dy < levelD) {
      levelD = dy
      level = t
    }
  }
  if (upright && level) {
    const point: Vec2 = [upright[0], level[1]]
    return { point, guides: [{ from: upright, to: point }, { from: level, to: point }] }
  }
  if (upright) {
    const point: Vec2 = [upright[0], spot[1]]
    return { point, guides: [{ from: upright, to: point }] }
  }
  if (level) {
    const point: Vec2 = [spot[0], level[1]]
    return { point, guides: [{ from: level, to: point }] }
  }
  return null
}

export interface SnapResult {
  point: Vec2
  /** The anchor the point landed on, when it landed on one that can hold
   *  a coincidence — a line's or an arc's end, an arc's or a circle's
   *  centre. */
  anchor: Anchor | null
  /** The coordinate plane whose line the point landed on, when it did —
   *  held there by a point-on relation, as an end is held to an anchor. */
  datum?: DatumPlane
  /** The piece whose body the point landed on, when it did — held on it
   *  by a point-on relation. */
  piece?: number
  /** The coordinate planes whose lines cross at the sheet's zero, when the
   *  point landed there — held at the crossing by a point-on relation to
   *  each. Empty when no plane's line runs through the zero. */
  origin?: DatumPlane[]
  /** The tracking lines the point landed on, to draw — a place only, held
   *  by nothing, as the grid is. */
  guides?: TrackGuide[]
  kind: SnapKind | null
}

/** What a drawn or dragged end is held to after a snap: the anchor it
 *  landed on, the coordinate plane's line it landed on, the piece whose
 *  body it landed on, the sheet's zero by the planes crossing there — or
 *  nothing. */
export type SnapHold = Anchor | { datum: DatumPlane } | { piece: number } | { origin: DatumPlane[] }

export function snapHold(r: SnapResult): SnapHold | null {
  if (r.anchor) return r.anchor
  if (r.datum) return { datum: r.datum }
  if (r.piece !== undefined) return { piece: r.piece }
  if (r.origin && r.origin.length > 0) return { origin: r.origin }
  return null
}

/**
 * Snap a sheet point. `exclude` names pieces that are not snapped to — the
 * one being dragged, which would otherwise snap to itself.
 */
export function snapSketchPoint(
  sketch: Sketch,
  spot: Vec2,
  radius: number,
  ctx: SnapContext = {},
  exclude?: ReadonlySet<number>,
): SnapResult {
  if (ctx.off) return { point: spot, anchor: null, kind: null }

  // The ends and centres of the pieces already there — a circle's centre
  // too: what lands on it is held there, as a hole's centre is held on the
  // line it is placed along.
  let best: SnapResult | null = null
  let bestD = radius
  for (const e of sketch.entities) {
    if (exclude?.has(e.id)) continue
    for (const at of anchorsOf(e)) {
      const p = anchorPoint(e, at)
      const d = len2(sub2(p, spot))
      if (d <= bestD) {
        bestD = d
        best = { point: p, anchor: { entity: e.id, at }, kind: 'anchor' }
      }
    }
  }
  if (best) return best

  // The sheet's zero — the part's origin projected onto the plane, as the
  // sketch rule puts it: a point to start a profile on, as every CAD
  // sketcher offers it. A point that lands there is held there by the
  // coordinate planes whose lines cross at it, as Fusion's origin point
  // holds a coincidence; a zero no plane's line runs through is a place
  // only.
  if (len2(spot) <= radius) {
    const origin = (ctx.datums ?? []).filter((t) => Math.abs(traceOffset(t, [0, 0])) < 1e-6).map((t) => t.plane)
    return { point: [0, 0], anchor: null, origin, kind: 'origin' }
  }

  // The middle of a line, an arc's centre, an arc's or a circle's quadrant
  // (pickPointsOf): an end that lands there is held to it, as CAD's
  // midpoint relation holds it — the line's 'center' anchor is its middle,
  // a quadrant's its own (q0…q3). They reach less far than an end: a line
  // fitted to the slice has slice points all along it, and those are what
  // is wanted beside its middle.
  let midD = radius * MIDPOINT_REACH
  for (const e of sketch.entities) {
    if (exclude?.has(e.id)) continue
    for (const at of pickPointsOf(e)) {
      const p = anchorPoint(e, at)
      const d = len2(sub2(p, spot))
      if (d <= midD) {
        midD = d
        best = { point: p, anchor: { entity: e.id, at }, kind: e.kind === 'line' ? 'midpoint' : at === 'center' ? 'anchor' : 'quadrant' }
      }
    }
  }
  if (best) return best

  // A tracking line along X or Y from a point the hand passed over, or
  // where two cross: the point stands level or upright with it. A place
  // only — nothing holds it there but where it was put.
  if (ctx.track && ctx.track.length > 0) {
    const tracked = trackingSnap(ctx.track, spot, radius * TRACK_REACH)
    if (tracked) return { point: tracked.point, anchor: null, kind: 'track', guides: tracked.guides }
  }

  // A coordinate plane's line: the foot of the spot on it, held there.
  if (ctx.datums && ctx.datums.length > 0) {
    const trace = traceNear(ctx.datums, spot, radius * DATUM_REACH)
    if (trace) return { point: traceFoot(trace, spot), anchor: null, datum: trace.plane, kind: 'datum' }
  }

  // The body of a piece: what lands on it is held on it — a line drawn
  // from the side of another starts a T, and stays one. A piece drawn by
  // hand or projected from the part is taken before the slice: it is what
  // was meant there, and the scan's points run along a body's edge a hair
  // off it — the edge, not the scan, is what a new piece is to be held to.
  // A piece fitted to the slice lies among its own points, which are what
  // a free piece is drawn along beside it: it is taken after them.
  const fitted = (e: Sketch['entities'][number]) => 'points' in e && e.points !== undefined && e.points.length > 0
  const onBody = (pieces: (e: Sketch['entities'][number]) => boolean): SnapResult | null => {
    let found: SnapResult | null = null
    for (const e of sketch.entities) {
      if (exclude?.has(e.id) || e.kind === 'point' || !pieces(e)) continue
      const { point, dist } = nearestOnEntity(e, spot)
      if (dist <= bestD) {
        bestD = dist
        found = { point, anchor: null, piece: e.id, kind: 'entity' }
      }
    }
    return found
  }
  best = onBody((e) => !fitted(e))
  if (best) return best

  // A point of the slice: what a free piece is usually drawn along.
  if (ctx.chains) {
    for (const chain of ctx.chains) {
      for (const p of chain) {
        const d = len2(sub2(p, spot))
        if (d <= bestD) {
          bestD = d
          best = { point: p, anchor: null, kind: 'edge' }
        }
      }
    }
    if (best) return best
  }

  best = onBody(fitted)
  if (best) return best

  // The grid, last: it is there to steady a hand, not to fight the scan.
  if (ctx.grid && ctx.grid > 0) {
    const g = ctx.grid
    const p: Vec2 = [Math.round(spot[0] / g) * g, Math.round(spot[1] / g) * g]
    if (len2(sub2(p, spot)) <= radius) return { point: p, anchor: null, kind: 'grid' }
  }
  return { point: spot, anchor: null, kind: null }
}

// SPDX-License-Identifier: AGPL-3.0-only
// The sketch editor's machinery, below the store's actions: a dimension held
// while it is placed, the draft solved and its regions found again after
// every change, a chain fitted, the corner tools' drafts, and what the
// cursor is over on the sheet.

import { FitError } from '../../../src/core/fit/errors'
import type { Vec2 } from '../../../src/core/flat/types'
import { len2, sub2 } from '../../../src/core/flat/vec2'
import { alignToAxes, mergeAlignedLines } from '../core/axisAlign'
import type { EdgeInfo } from '../core/build'
import { CORNER_GAP_MM, inferCorners } from '../core/corners'
import { type DatumPlane, type DatumTrace, datumTraces, traceNear } from '../core/datums'
import { dimPlaceAt } from '../core/dimLayout'
import { dimensionFor, type DimPick, dimPickAt, outwardTangent, relPickAt } from '../core/draw'
import { chamferLines, cornerLinesAt, filletLines } from '../core/filletCorner'
import type { FitOptions } from '../core/fitOptions'
import { symmetricPairs } from '../core/mirrorRelation'
import { findRegions } from '../core/regions'
import { arcsOfChain, chainStatistics, detailLevels, type PlacedSegment, placeSegments, segmentChain } from '../core/segment'
import { pointsInterpolant, type PointsRefit, pointsTolerance, refitOnPoints } from '../core/pointsFit'
import { landEnd, type ShareCarrier, shareChain, type ShareReport, takeShared } from '../core/shareFit'
import { fitPointsAlong } from '../core/sketchSpline'
import { addConstraint, addEntity, type Anchor, type AnchorAt, anchorPoint, anchorsOf, cloneSketch, endsOf, type ConstraintInput, emptySketch, type EntityInput, entityOf, isDimension, nearestOnEntity, removeConstraint, type Sketch, type SketchEntity, splineAnchor } from '../core/sketch'
import type { SnapHold } from '../core/snap'
import { type Pull, type SolveReport, solveSketch } from '../core/solver'
import type { ExtrudeDraft, SketchDraft } from './reTypes'

export const MAX_HISTORY = 40

/** A tool with nothing in hand: no half-placed points, no chain, no pick. */
/** The Dimension tool's pick put down once the dimension it holds is
 *  settled — its number typed or confirmed, or the dimension removed. The
 *  piece in hand is held only for a second click to pair with; after that
 *  the next click is a new dimension. Empty when `id` is not the one in
 *  hand. */
export function dimensionDone(d: SketchDraft, id: number): Partial<SketchDraft> {
  if (!d.dimPick && d.dimMade == null) return {}
  return d.dimMade === id || d.selectedConstraint === id ? { dimPick: null, dimMade: null, dimFrom: null } : {}
}

export const toolIdle = () => ({ pending: [] as Vec2[], snaps: [] as (SnapHold | null)[], chain: null, dimPick: null, dimMade: null, dimFrom: null, relPicks: [] as DimPick[] })

/** The draft with a new dimension in hand, its number following the cursor
 *  until a click puts it down (see SketchDraft.dimMade). `pick` is the one
 *  click that made it, kept for a second to pair with; null once it has
 *  its two. */
export function holdDimension(d: SketchDraft, c: ConstraintInput, pick: DimPick | null): SketchDraft {
  const before = cloneSketch(d.sketch)
  const id = addConstraint(d.sketch, c)
  return { ...settle({ ...d, selection: [], dimPick: pick, dimMade: id, dimFrom: before }, before), selectedConstraint: id }
}

/** The dimension in hand taken back, as if it had never been made: a
 *  dimension is made where it is put down. The step that made it is undone
 *  while it is still the last; after other changes it is removed as a step
 *  of its own. */
export function dropDimension(d: SketchDraft): SketchDraft {
  const id = d.dimMade
  if (id == null) return d
  const idle = { dimPick: null, dimMade: null, dimFrom: null, selectedConstraint: d.selectedConstraint === id ? null : d.selectedConstraint }
  const last = d.history.at(-1)
  if (last && last === d.dimFrom) return settle({ ...d, ...idle, sketch: last, history: d.history.slice(0, -1) })
  const before = cloneSketch(d.sketch)
  removeConstraint(d.sketch, id)
  return settle({ ...d, ...idle }, before)
}

/** The dimension in hand put down: its number where `spot` is, or where the
 *  layout puts it, and opened for typing. It goes into the step that made
 *  it — where a number is written changes nothing the solver reads. */
export function putDownDimension(d: SketchDraft, spot: Vec2 | null): SketchDraft {
  const id = d.dimMade
  const held = id == null ? undefined : d.sketch.constraints.find((c) => c.id === id)
  if (!held || !isDimension(held)) return { ...d, dimPick: null, dimMade: null, dimFrom: null }
  const place = spot ? dimPlaceAt(held, d.sketch, spot, datumTraces(d.frame)) : null
  if (place) d.sketch.constraints = d.sketch.constraints.map((c) => (c.id === id ? { ...c, place } : c))
  return { ...d, dimPick: null, dimMade: null, dimFrom: null, selectedConstraint: held.id, dimFocus: (d.dimFocus ?? 0) + 1, error: null }
}

/** What a click with the Dimension tool pairs the pick in hand with: the
 *  distance or the angle between the two — or null for the same piece
 *  again, or two no dimension runs between. */
export function dimensionPair(d: SketchDraft, first: DimPick, pick: DimPick | null): ConstraintInput | null {
  if (!pick || (pick.kind === 'piece' && first.kind === 'piece' && pick.id === first.id)) return null
  return dimensionFor(d.sketch, first, pick, datumTraces(d.frame))
}

/** Whether an anchor is already held where a snap would hold it: the
 *  relation is not added twice, and an end joined to a piece's end is not
 *  held on the piece's body as well — it is on the body through the end. */
function heldBy(sketch: Sketch, p: Anchor, hold: SnapHold): boolean {
  const same = (a: Anchor, b: Anchor) => a.entity === b.entity && a.at === b.at
  const cs = sketch.constraints
  if ('datum' in hold) return cs.some((c) => c.kind === 'pointOn' && 'datum' in c.on && c.on.datum === hold.datum && same(c.p, p))
  if ('origin' in hold) return hold.origin.every((plane) => heldBy(sketch, p, { datum: plane }))
  if ('piece' in hold) {
    if (p.entity === hold.piece) return true
    const round = entityOf(sketch, hold.piece)?.kind !== 'line'
    // A round piece's centre is not on its rim.
    const onIt = (q: Anchor) => q.entity === hold.piece && !(round && q.at === 'center')
    return cs.some(
      (c) =>
        (c.kind === 'pointOn' && same(c.p, p) && (('line' in c.on && c.on.line === hold.piece) || ('curve' in c.on && c.on.curve === hold.piece))) ||
        (c.kind === 'coincident' && ((same(c.p, p) && onIt(c.q)) || (same(c.q, p) && onIt(c.p)))),
    )
  }
  return cs.some((c) => c.kind === 'coincident' && ((same(c.p, p) && same(c.q, hold)) || (same(c.q, p) && same(c.p, hold))))
}

/** Whether a snap landed on an end or a centre — what a rim or a far side
 *  can be made to run through. */
export const isAnchor = (hold: SnapHold): hold is Anchor => 'entity' in hold

/** Hold a drawn or dragged end where it snapped: to an anchor by a
 *  coincidence, to a coordinate plane's line or a piece's body by a
 *  point-on relation, to the sheet's zero by one to each plane's line
 *  crossing there — as a CAD sketcher infers the relation from the snap.
 *  Nothing is added where the end is held so already. */
export function holdAt(sketch: Sketch, p: Anchor, hold: SnapHold): void {
  if (heldBy(sketch, p, hold)) return
  if ('datum' in hold) addConstraint(sketch, { kind: 'pointOn', p, on: { datum: hold.datum } })
  else if ('origin' in hold) for (const plane of hold.origin) holdAt(sketch, p, { datum: plane })
  else if ('piece' in hold) {
    const e = entityOf(sketch, hold.piece)
    if (!e) return
    if (e.kind === 'line') addConstraint(sketch, { kind: 'pointOn', p, on: { line: e.id } })
    else if (e.kind === 'arc' || e.kind === 'circle' || e.kind === 'spline') addConstraint(sketch, { kind: 'pointOn', p, on: { curve: e.id } })
    else addConstraint(sketch, { kind: 'coincident', p, q: { entity: e.id, at: 'center' } })
  } else addConstraint(sketch, { kind: 'coincident', p, q: hold })
}

/** Where a tangent arc would start under a press with the Line tool: the
 *  chain's last end, with the direction the piece before it runs on in —
 *  or null when the press is not on it. Exported for the stage, which lets
 *  the press through to the sketch there and draws the arc as it is
 *  dragged. */
export function chainArcStart(d: SketchDraft | null, spot: Vec2, radius: number): { p: Vec2; t: Vec2 } | null {
  if (!d || d.tool !== 'line' || !d.chain || d.pending.length !== 1) return null
  const e = entityOf(d.sketch, d.chain.entity)
  const t = e ? outwardTangent(e, d.chain.at) : null
  if (!e || !t) return null
  const p = anchorPoint(e, d.chain.at)
  return len2(sub2(p, spot)) <= radius ? { p, t } : null
}

/** What lies under a hand on the sheet with the Select tool: an end or a
 *  centre to drag, a piece to carry, or nothing. Exported for the cursor. */
export function dragHandleAt(sketch: Sketch, spot: Vec2, radius: number): { entity: number; at: AnchorAt | 'body' } | null {
  let best: { entity: number; at: AnchorAt | 'body' } | null = null
  let bestD = radius
  for (const e of sketch.entities) {
    for (const at of anchorsOf(e)) {
      const d = len2(sub2(anchorPoint(e, at), spot))
      if (d <= bestD) {
        bestD = d
        best = { entity: e.id, at }
      }
    }
  }
  if (best) return best
  const piece = pieceNear(sketch, spot, radius)
  return piece ? { entity: piece.id, at: 'body' } : null
}

/** The draft with its sketch solved and its regions found again — what
 *  every change ends with. `pull` is the hand on a dragged point; `quick`
 *  is one step of a drag, solved briefly from where the sketch stands
 *  and with the regions left as they were — the planar graph is found
 *  again when the hand lets go, not on every frame. */
export function settle(d: SketchDraft, before?: Sketch, pull?: readonly Pull[], quick = false): SketchDraft {
  if (before) d = { ...d, future: [] }
  const history = before ? [...d.history.slice(-(MAX_HISTORY - 1)), before] : d.history
  let report: SolveReport | null = null
  try {
    report = solveSketch(d.sketch, { ...(pull ? { pull } : {}), quick, datums: datumTraces(d.frame) })
  } catch (e) {
    return { ...d, history, error: e instanceof Error ? e.message : String(e) }
  }
  const found = quick ? d.found : findRegions(d.sketch)
  // A drag's quick step does not work out which pieces are loose: the
  // last full solve's answer stands until the hand lets go.
  if (quick && d.report) report = { ...report, underConstrained: d.report.underConstrained }
  return { ...d, history, report, found, error: null }
}

/** Whether a click at `spot` with the Spline tool closes the curve: back on
 *  its first point, with three points down already. */
export function splineClosesAt(pending: readonly Vec2[], spot: Vec2, radius: number): boolean {
  return pending.length >= 3 && len2(sub2(spot, pending[0])) <= radius
}

/**
 * The draft with the Spline tool's points made a spline — closed round to
 * its first point, or open — each point held where it snapped, as a drawn
 * end is; a closed one's first point is held by its first click's snap.
 * With fewer than two points down, nothing is made and the tool is idle
 * again.
 */
export function splineDraft(d: SketchDraft, closed: boolean): SketchDraft {
  const pts = d.pending.map((p): Vec2 => [p[0], p[1]])
  if (pts.length < 2 || (closed && pts.length < 3)) return { ...d, ...toolIdle(), error: null }
  const before = cloneSketch(d.sketch)
  const id = addEntity(d.sketch, { kind: 'spline', pts, ...(closed ? { closed: true } : {}) })
  const e = entityOf(d.sketch, id)
  if (e?.kind === 'spline') (d.snaps ?? []).forEach((hold, i) => hold && i < pts.length && holdAt(d.sketch, { entity: id, at: splineAnchor(e, i) }, hold))
  return { ...settle({ ...d, ...toolIdle() }, before), selection: [] }
}

/** The draft with the corner between two lines rounded: the radius
 *  dimension comes out selected, so its field takes the typing, and the last
 *  radius typed in this sketch is the one the next round starts with. */
export function filletDraft(d: SketchDraft, lineA: number, lineB: number): SketchDraft {
  const before = cloneSketch(d.sketch)
  let last: number | undefined
  for (const c of d.sketch.constraints) if (c.kind === 'radius' && entityOf(d.sketch, c.entity)?.kind === 'arc') last = c.value
  // filletLines changes nothing when it refuses: a last radius that does
  // not fit this corner gives way to the corner's own.
  let made = filletLines(d.sketch, lineA, lineB, last)
  if (typeof made === 'string' && last !== undefined) made = filletLines(d.sketch, lineA, lineB)
  if (typeof made === 'string') return { ...d, selection: [], error: made }
  return { ...settle({ ...d, selection: [] }, before), selectedConstraint: made.dimension }
}

/** The draft with the corner between two lines cut off straight: the first
 *  of the two distances comes out selected for typing, and the next chamfer
 *  in this sketch starts with the last setback that fitted. */
export function chamferDraft(d: SketchDraft, lineA: number, lineB: number): SketchDraft {
  const before = cloneSketch(d.sketch)
  let made = chamferLines(d.sketch, lineA, lineB, d.lastChamfer)
  if (typeof made === 'string' && d.lastChamfer !== undefined) made = chamferLines(d.sketch, lineA, lineB)
  if (typeof made === 'string') return { ...d, selection: [], error: made }
  return { ...settle({ ...d, selection: [], lastChamfer: made.setback }, before), selectedConstraint: made.dimensions[0] }
}

/** One chain cut into pieces and put on the sketch the way the options say.
 *  Returns why not, when the chain could not be fitted. */
export function fitChain(
  sketch: Sketch,
  fitted: SketchDraft['fitted'],
  index: number,
  chain: readonly Vec2[],
  tolerance: number | null,
  options: FitOptions,
): string | null {
  if (options.spline) {
    // One spline along the whole chain, its points behind it: no corners to
    // join, so the chain is recorded as one open piece.
    const { scatter, closed, points } = chainStatistics(chain)
    const count = Math.max(closed ? 3 : 2, Math.round(options.spline))
    if (points.length < 2 * count) return `The chain has ${points.length} points — too few for a spline through ${count}, two a fit point at least.`
    const pts = fitPointsAlong(points, count, closed)
    if (!pts) return 'The chain has no length to lay a spline along.'
    const id = addEntity(sketch, { kind: 'spline', pts, ...(closed ? { closed: true } : {}), points, scatter: Math.max(tolerance ?? scatter, 1e-3) })
    fitted[index] = { order: [{ id, from: closed ? 'p0' : 'a', to: closed ? 'p0' : 'b' }], closed: false }
    return null
  }
  try {
    const cut = options.arcs ? arcsOfChain(chain, options.arcs, tolerance !== null ? { tolerance } : {}) : segmentChain(chain, { detail: options.detail, ...(tolerance !== null ? { tolerance } : {}) })
    let order = placeSegments(sketch, cut)
    // Lines are laid along the axes before the corners are made, so the
    // corners are where the level lines cross — and the pieces of one wall,
    // level and in line, are made the one line they are.
    if (options.alignAxes) {
      alignToAxes(sketch, order.map((p) => p.id), { degrees: options.alignDegrees, diagonals: options.alignDiagonals })
      order = mergeAlignedLines(sketch, order, cut.closed, 2 * detailLevels(cut.tolerance).wave)
    }
    fitted[index] = { order, closed: cut.closed }
    if (options.joinCorners) inferCorners(sketch, order, cut.closed, CORNER_GAP_MM)
    return null
  } catch (e) {
    if (!(e instanceof FitError)) throw e
    return e.message
  }
}

/** A chain fitted onto the pieces the sketch already holds (core/shareFit.ts):
 *  what of it lies along one of `pieces` within `share` mm is that piece's
 *  — its points join a fitted piece's — and the rest is fitted in open
 *  runs, each end landed on the piece it reaches. A chain none of whose
 *  points are any piece's is fitted as fitChain fits it. What was shared
 *  and landed goes into `report`; the error of a run that did not fit is
 *  returned, the others fitted all the same. */
export function fitChainShared(
  sketch: Sketch,
  fitted: SketchDraft['fitted'],
  index: number,
  chain: readonly Vec2[],
  tolerance: number | null,
  options: FitOptions,
  pieces: readonly ShareCarrier[],
  share: number,
  report: ShareReport,
): string | null {
  const split = shareChain(chain, pieces, { share })
  if (split.whole) return fitChain(sketch, fitted, index, chain, tolerance, options)
  takeShared(sketch, split.shared)
  for (const s of split.shared) report.shared.push({ piece: s.piece, points: s.points.length, offMm: s.offMm })
  report.corners += split.corners
  const runs: PlacedSegment[][] = []
  const out: ShareReport['chains'][number] = []
  let error: string | null = null
  split.runs.forEach((r, k) => {
    const one: SketchDraft['fitted'] = {}
    const why = fitChain(sketch, one, 0, r.points, tolerance, options)
    const f = one[0]
    if (!f || f.order.length === 0) {
      error = why ?? error
      out.push({ order: null, points: r.points.length, skipped: why ?? 'It did not fit.', from: r.from, to: r.to })
      return
    }
    const first = f.order[0]
    const last = f.order[f.order.length - 1]
    for (const [end, on] of [[{ entity: first.id, at: first.from }, r.from], [{ entity: last.id, at: last.to }, r.to]] as const) {
      if (on === null) continue
      const landed = landEnd(sketch, end, on, share)
      if (landed) report.junctions.push({ chain: index, run: k, ...landed })
    }
    runs.push(f.order)
    out.push({ order: f.order, points: r.points.length, from: r.from, to: r.to })
  })
  fitted[index] = { order: [], closed: false, runs, share }
  report.chains[index] = out
  return error
}

/** A chain of points typed in — read off a drawing, not a slice — fitted
 *  as fitChain fits a slice's chain, then fitted again to the points
 *  themselves (core/pointsFit.ts): the cut made on a smooth run through
 *  them — at `tolerance`, or pointsTolerance — the pieces settled on the
 *  points alone, an end landing on a piece
 *  of `landOn` within `share` mm joined to it. Returns the chain's pieces in
 *  order and what the refit did, or why it could not be fitted. */
export function fitPointsChain(
  sketch: Sketch,
  points: readonly Vec2[],
  closed: boolean,
  tolerance: number | null,
  options: FitOptions,
  land: { landOn: readonly number[]; share: number },
): (PointsRefit & { closed: boolean }) | string {
  const one: SketchDraft['fitted'] = {}
  const why = fitChain(sketch, one, 0, pointsInterpolant(points, closed), tolerance ?? pointsTolerance(points), options)
  const f = one[0]
  if (!f || f.order.length === 0) return why ?? 'It did not fit.'
  return { ...refitOnPoints(sketch, f.order, closed, points, land), closed }
}

/** A stored edge pick before it is found again on the body: the
 *  fingerprint alone, with no hash, no polyline and no ends yet. */
export function unplacedEdge(fingerprint: EdgeInfo['fingerprint']): EdgeInfo {
  return { hash: -1, fingerprint, faces: [], ends: [fingerprint.mid, fingerprint.mid], endTangents: [fingerprint.dir, fingerprint.dir], polyline: new Float32Array(0) }
}

/** An empty sketch, or one holding the pieces it is to open with. */
export function seededSketch(seed?: readonly EntityInput[]): Sketch {
  const sketch = emptySketch()
  for (const e of seed ?? []) addEntity(sketch, e)
  return sketch
}

/** The result an extrude pulled from a face has while it still follows the
 *  direction: outward joins the body, inward cuts it. */
export function faceExtrudeOp(d: ExtrudeDraft): ExtrudeDraft {
  if (!d.fromFace?.opAuto) return d
  const e = d.extent
  const outward = e.kind === 'distance' ? e.to + e.from >= 0 : true
  return { ...d, op: outward ? 'join' : 'cut' }
}

/** The nearest piece to a spot within reach, or null. */
/** Symmetric between two pieces about a sketch line or one of the part's
 *  coordinate planes, on the line it cuts the sheet in: the draft with the
 *  relation added and settled, or with why it was not. */
export function holdSymmetric(d: SketchDraft, a: SketchEntity, b: SketchEntity, axis: SketchEntity | DatumTrace): SketchDraft {
  const pairs = symmetricPairs(a, b, axis)
  if (typeof pairs === 'string') return { ...d, error: pairs }
  const before = cloneSketch(d.sketch)
  const about = 'plane' in axis ? { datum: axis.plane } : { line: axis.id }
  for (const pair of pairs) addConstraint(d.sketch, { kind: 'symmetric', ...pair, about })
  return settle({ ...d }, before)
}

export function pieceNear(sketch: Sketch, spot: Vec2, radius: number): SketchEntity | null {
  let best: SketchEntity | null = null
  let bestD = radius
  for (const e of sketch.entities) {
    const { dist } = nearestOnEntity(e, spot)
    if (dist <= bestD) {
      bestD = dist
      best = e
    }
  }
  return best
}

/** The nearest anchor of any piece within reach — what a drawn end snaps
 *  to, and is then held to by a coincidence. Exported for the stage, whose
 *  rubber-band preview snaps the same way the click will. */
export function anchorNear(sketch: Sketch, spot: Vec2, radius: number, except?: number): { anchor: Anchor; point: Vec2 } | null {
  let best: { anchor: Anchor; point: Vec2 } | null = null
  let bestD = radius
  for (const e of sketch.entities) {
    if (e.id === except) continue
    for (const at of anchorsOf(e)) {
      if (e.kind === 'circle' && at === 'center') continue
      const p = anchorPoint(e, at)
      const d = len2(sub2(p, spot))
      if (d <= bestD) {
        bestD = d
        best = { anchor: { entity: e.id, at }, point: p }
      }
    }
  }
  return best
}

/** What a click would take in the sketch: pieces, an end or a centre, or a
 *  coordinate plane's line — see sketchHoverAt. */
export interface SketchHover {
  pieces: number[]
  point: Vec2 | null
  datum: DatumPlane | null
}

/** What a click at a spot would take with the tool in hand, lit under the
 *  cursor before the click as CAD lights what it is about to pick: the
 *  piece for the arrow and a relation, the piece, end or plane a
 *  dimension or a coincidence takes, the two lines of a corner a round or
 *  a chamfer goes into. Null over nothing, and for the drawing tools, whose
 *  cursor shows its own snap. Mirrors sketchClick's picking. */
export function sketchHoverAt(d: SketchDraft, spot: Vec2, radius: number): SketchHover | null {
  const traces = datumTraces(d.frame)
  const piece = (id: number): SketchHover => ({ pieces: [id], point: null, datum: null })
  const fromPick = (pick: DimPick | null): SketchHover | null => {
    if (!pick) return null
    if (pick.kind === 'piece') return piece(pick.id)
    if (pick.kind === 'datum') return { pieces: [], point: null, datum: pick.plane }
    const e = entityOf(d.sketch, pick.anchor.entity)
    return e ? { pieces: [], point: anchorPoint(e, pick.anchor.at), datum: null } : null
  }
  switch (d.tool) {
    case 'select': {
      if (d.pending.length > 0) return null
      const hit = pieceNear(d.sketch, spot, radius)
      return hit ? piece(hit.id) : null
    }
    case 'dimension': {
      const pick = dimPickAt(d.sketch, spot, radius, traces)
      // With a dimension in hand only what it would pair with is lit; a
      // click anywhere else puts it down.
      if (d.dimMade != null) return d.dimPick && dimensionPair(d, d.dimPick, pick) ? fromPick(pick) : null
      return fromPick(pick)
    }
    case 'relation': {
      if (!d.armedRelation) return null
      if (d.armedRelation === 'coincident') return fromPick(relPickAt(d.sketch, spot, radius, traces))
      const hit = pieceNear(d.sketch, spot, radius)
      if (hit) return piece(hit.id)
      const trace = d.armedRelation === 'symmetric' && d.selection.length === 2 ? traceNear(traces, spot, radius) : null
      return trace ? { pieces: [], point: null, datum: trace.plane } : null
    }
    case 'fillet':
    case 'chamfer': {
      const corner = anchorNear(d.sketch, spot, radius)
      const lines = corner ? cornerLinesAt(d.sketch, corner.anchor) : null
      if (corner && lines) return { pieces: [...lines], point: corner.point, datum: null }
      const hit = pieceNear(d.sketch, spot, radius)
      return hit?.kind === 'line' ? piece(hit.id) : null
    }
    default:
      return null
  }
}

/** The two selected pieces' anchors nearest each other. */
export function nearestEnds(a: SketchEntity, b: SketchEntity): [Anchor, Anchor] | null {
  let best: [Anchor, Anchor] | null = null
  let bestD = Infinity
  // A spline joins by its ends, not by a fit point along it.
  const joinable = (e: SketchEntity): AnchorAt[] => (e.kind === 'spline' ? endsOf(e) : anchorsOf(e))
  for (const pa of joinable(a)) {
    if (a.kind === 'circle') continue
    for (const pb of joinable(b)) {
      if (b.kind === 'circle') continue
      const d = len2(sub2(anchorPoint(a, pa), anchorPoint(b, pb)))
      if (d < bestD) {
        bestD = d
        best = [
          { entity: a.id, at: pa },
          { entity: b.id, at: pb },
        ]
      }
    }
  }
  return best
}

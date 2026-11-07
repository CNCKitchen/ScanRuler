// SPDX-License-Identifier: AGPL-3.0-only
// Sketches as the commands take them in: shapes drawn into the sketch
// editor's draft, a whole sketch put down from its JSON, the slice of the
// scan fitted into lines and arcs, and bodies' edges and outlines projected
// onto the sketch's plane.

import { invalid, waitFor } from '../../../src/commands/core/common'
import { findSection } from '../../../src/commands/core/section'
import { commandHost } from '../../../src/commands/host'
import { errorMessage } from '../../../src/commands/types'
import { EDGE_MIN_FEATURE_MM } from '../../../src/core/flat/edges'
import type { Vec2 } from '../../../src/core/flat/types'
import { round4 } from '../../../src/core/round'
import type { SectionFrame } from '../../../src/core/section/frame'
import { FACING_DEG, sidedChains, type SidedChains, type SideRule } from '../../../src/core/section/skin'
import { projectCut, projectCutNormals, type SectionCut } from '../../../src/core/section/slice'
import type { Vec3 } from '../../../src/core/types'
import { addScaled, dot, sub } from '../../../src/core/vec'
import { CommandError } from '../../../src/plugins/api'
import { useStore } from '../../../src/state/store'
import { acceptCandidates, type AcceptRule } from '../core/accept'
import { boxMissed, chainAt, chainsSpan, joinChainEnds, type JoinedChain, pickChain, runsKept, sideOf, unjoined, type WithinBox, withinOnSheet } from '../core/chainOutline'
import { datumTraces } from '../core/datums'
import { evaluateFor } from '../core/expression'
import { FACE_SLICE_INSET_MM, type PlaneRef, type SketchFeature } from '../core/features'
import { findRegions } from '../core/regions'
import { resolvePlaneFrame } from '../core/resolve'
import { filletLines } from '../core/filletCorner'
import { DEFAULT_FIT_OPTIONS, type FitOptions, sanitizeFitOptions } from '../core/fitOptions'
import { pastPiece, SHARE_MM, type ShareReport } from '../core/shareFit'
import { detached } from '../core/drag'
import { sketchResidual } from '../core/intent'
import { dimensionKind } from '../core/parameters'
import { curveMoved, projectEdge, projectFaceOutline, projectSketchEntity, retakeMoved } from '../core/project'
import { arcsOfChain, chainsOfEdges, segmentChain } from '../core/segment'
import { splineCurve, splineSamples } from '../core/sketchSpline'
import { type BoxSide, deviationsAt, type HeldAlong, overshootOf } from '../core/pointsFit'
import { fitPointsChain } from '../state/reSketchDraft'
import { addConstraint, addEntity, addPolygon, anchorPoint, arcPoint, arcThrough, addRectangle, addRectangleCentre, addTurnedRectangle, type AnchorAt, anchorsOf, cloneSketch, type Constraint, constraintEntities, type ConstraintInput, type ConstraintKind, DIMENSION_KINDS, emptySketch, endsOf, type EntityInput, entityOf, inferRelations, patternPieces, POLYGON_MAX_SIDES, type PolygonFit, relationTakes, renumbered, type Sketch, type SketchArc, type SketchEntity, type SketchPatternSpec, type SketchSpline, splineJoint, splinePointIndex, TOUCH_MM } from '../core/sketch'
import { insetChains, insetKeeps, likeStation, runFactsWords, STATION_FOLD_HELP, stationFaults, type StationLoop, stationLoop } from '../core/stations'
import { measureDimension, type Pull } from '../core/solver'
import { bodyNamed, type EdgePickIn, edgesPicked, facePicked, type FacePickIn, type Json, re, type Ref, sketchNamed, topologyOf } from './reCommandCore'
import type { ReverseSession } from './reSession'
import { throughBand, type ThroughIn, throughOn, type ThroughOut } from './reThrough'

const KEPT_ON_PIECES = ['points', 'scatter'] as const

/** The points of a piece a constraint may name: its ends, and an arc's
 *  centre too, which the panel's own dimensions measure from (anchorPoint
 *  reads it; the snapping offers the ends alone). */
const pointsOf = (e: SketchEntity): AnchorAt[] => (e.kind === 'arc' ? [...anchorsOf(e), 'center'] : anchorsOf(e))

/** "a line", "an arc". */
const aPiece = (kind: string) => `${/^[aeiou]/.test(kind) ? 'an' : 'a'} ${kind}`

/** What a sketch handed in made beyond the pieces it listed: each shape's
 *  pieces by what they are, each pattern's copies, how many relations
 *  were inferred, and the new ends moved onto the sketch's own. */
interface SketchMade {
  shapes: Record<string, unknown>[]
  patterns: number[][][]
  inferred: number
  snapped?: SnappedEnd[]
  /** The ids given to the pieces handed in without one, in their order. */
  ids?: number[]
  /** Each ellipse drawn, and how far its spline lies off a true one. */
  ellipses?: EllipseOut[]
}

/** An ellipse as the answer says it: its spline, how many points, and the
 *  most it lies off the ellipse it stands for, mm. */
interface EllipseOut {
  piece: number
  points: number
  deviationMm: number
}

/** A new piece's end moved onto another end — one the sketch had, or
 *  another new piece's: which, onto what, how far (mm); `fixed` where the
 *  piece moved was given fixed. */
interface SnappedEnd {
  piece: number
  at: 'a' | 'b'
  to: { piece: number; at: 'a' | 'b' }
  by: number
  fixed?: true
}

/** A new piece's end this close to one place where other ends lie — and to
 *  no other — is moved onto it: an end taken from an answer rounded, or an
 *  accept that moved the old end, misses by a few hundredths, and the
 *  infer (TOUCH_MM) would leave the corner open. A gap this small is never
 *  meant, so a piece given fixed moves too; a polyline's last corner this
 *  close to its first closes on it. */
export const SNAP_MM = 0.05

/** The ends of the pieces new to a sketch (all but `held`, the ones it had
 *  as they were) moved onto the other pieces' ends — the sketch's own, and
 *  each other's — each within SNAP_MM of a single place where one or more
 *  of them meet; an end two such places are near is left, and so is one
 *  already on another end (within TOUCH_MM). Free pieces move first, so
 *  of two new ends a free one goes to a fixed one, and a later one to an
 *  earlier; a fixed piece's end moves only where no free one came to it.
 *  A line's end moves, a spline's end point, and an arc is drawn again
 *  through the moved end, its other end and its middle. Returns what
 *  moved. */
function snapNewEnds(entities: SketchEntity[], held: ReadonlySet<number>): SnappedEnd[] {
  const snapped: SnappedEnd[] = []
  if (entities.every((e) => held.has(e.id))) return snapped
  // Every end as it lies now, by piece — kept up as ends move.
  const ends = new Map(entities.map((e) => [e.id, endsOf(e).map((at) => ({ piece: e.id, at, p: anchorPoint(e, at) }))]))
  const all = () => [...ends.values()].flat()
  for (const fixedPass of [false, true]) {
    // The last drawn first: of two new ends, the later goes to the earlier.
    for (let i = entities.length - 1; i >= 0; i--) {
      const e = entities[i]
      if (held.has(e.id) || Boolean(e.fixed) !== fixedPass) continue
      for (const at of endsOf(e)) {
        const now = entities[i]
        const p = anchorPoint(now, at)
        const near = all()
          .filter((o) => o.piece !== e.id && Math.abs(o.p[0] - p[0]) <= SNAP_MM && Math.abs(o.p[1] - p[1]) <= SNAP_MM)
          .map((o) => ({ o, d: Math.hypot(o.p[0] - p[0], o.p[1] - p[1]) }))
          .filter((n) => n.d <= SNAP_MM)
          .sort((x, y) => x.d - y.d)
        if (near.length === 0 || near[0].d <= TOUCH_MM) continue
        const to = near[0].o
        if (near.some((n) => Math.hypot(n.o.p[0] - to.p[0], n.o.p[1] - to.p[1]) > TOUCH_MM)) continue
        const moved = withEndAt(now, at, to.p)
        if (!moved) continue
        entities[i] = moved
        ends.set(e.id, endsOf(moved).map((x) => ({ piece: e.id, at: x, p: anchorPoint(moved, x) })))
        snapped.push({ piece: e.id, at, to: { piece: to.piece, at: to.at }, by: round4(near[0].d), ...(e.fixed ? { fixed: true as const } : {}) })
      }
    }
  }
  snapped.sort((x, y) => x.piece - y.piece || (x.at < y.at ? -1 : 1))
  return snapped
}

/** Whether two pieces lie alike — the same kind and numbers, the slice
 *  points kept on a fitted piece aside. */
function sameGeometry(x: SketchEntity, y: SketchEntity): boolean {
  const plain = (e: SketchEntity): string => {
    const o = Object.fromEntries(Object.entries(e).filter(([k]) => !(KEPT_ON_PIECES as readonly string[]).includes(k)).sort(([a], [b]) => (a < b ? -1 : 1)))
    return JSON.stringify(o)
  }
  return plain(x) === plain(y)
}

/** A polyline's corners as drawn: a last corner within SNAP_MM of the
 *  first — or on it, with closed — is that corner, and the polyline closes
 *  on it instead of running a line too short to mean anything back to it.
 *  `closedOn` where it did. */
function polylineClosing(sh: Json): { sh: Json; closedOn: boolean } {
  if (sh.kind !== 'polyline' || !Array.isArray(sh.points)) return { sh, closedOn: false }
  const pts = sh.points as Vec2[]
  if (pts.length < 4) return { sh, closedOn: false }
  const [first, last] = [pts[0], pts[pts.length - 1]]
  if (Math.hypot(last[0] - first[0], last[1] - first[1]) > SNAP_MM) return { sh, closedOn: false }
  return { sh: { ...sh, points: pts.slice(0, -1), closed: true }, closedOn: true }
}

/** A piece with one end at `p`, the rest as it was — null for an arc that
 *  would not keep its ends' names. */
function withEndAt(e: SketchEntity, at: 'a' | 'b', p: Vec2): SketchEntity | null {
  if (e.kind === 'line') return at === 'a' ? { ...e, a: [p[0], p[1]] } : { ...e, b: [p[0], p[1]] }
  if (e.kind === 'spline') {
    const pts = e.pts.map((q) => [q[0], q[1]] as Vec2)
    pts[at === 'a' ? 0 : pts.length - 1] = [p[0], p[1]]
    return { ...e, pts }
  }
  if (e.kind !== 'arc') return null
  const a = at === 'a' ? p : anchorPoint(e, 'a')
  const b = at === 'b' ? p : anchorPoint(e, 'b')
  const arc = arcThrough(a, b, arcPoint(e, e.start + e.sweep / 2))
  return arc && arc.startsAtP ? { ...e, c: arc.c, r: arc.r, start: arc.start, sweep: arc.sweep } : null
}

/** How many fit points an ellipse is drawn through, unless told. */
const ELLIPSE_POINTS = 16
/** How many places along each span of its spline an ellipse's deviation is
 *  read at. */
const ELLIPSE_READ = 24

/** How far a point on a sheet lies from an ellipse about the origin with
 *  half axes a along u and b along v: the nearest place on it found by
 *  Newton's method from the point's own parameter. */
function offEllipse(p: Vec2, a: number, b: number): number {
  let t = Math.atan2(p[1] / b, p[0] / a)
  for (let i = 0; i < 8; i++) {
    const e: Vec2 = [a * Math.cos(t) - p[0], b * Math.sin(t) - p[1]]
    const d: Vec2 = [-a * Math.sin(t), b * Math.cos(t)]
    const dd: Vec2 = [-a * Math.cos(t), -b * Math.sin(t)]
    const slope = d[0] * d[0] + d[1] * d[1] + e[0] * dd[0] + e[1] * dd[1]
    if (!(slope > 0)) break
    t -= (e[0] * d[0] + e[1] * d[1]) / slope
  }
  return Math.hypot(a * Math.cos(t) - p[0], b * Math.sin(t) - p[1])
}

/** The most a closed spline drawn for an ellipse lies off it, mm: in the
 *  ellipse's own frame, at places along every span. */
function ellipseDeviation(pts: readonly Vec2[], center: Vec2, a: number, b: number, turn: number): number {
  const [c, s] = [Math.cos(turn), Math.sin(turn)]
  let most = 0
  for (const { p } of splineSamples(splineCurve({ pts, closed: true }), ELLIPSE_READ)) {
    const d: Vec2 = [p[0] - center[0], p[1] - center[1]]
    most = Math.max(most, offEllipse([d[0] * c + d[1] * s, -d[0] * s + d[1] * c], a, b))
  }
  return most
}

/** A round within this of half a rectangle's shorter side is that half:
 *  the rectangle is a slot. */
const ROUND_FITS_MM = 1e-6

/** A rectangle rounded at half its shorter side: a slot along the longer
 *  one — a circle when the sides are equal — its round dimensioned.
 *  `turn` takes a point of the rectangle as it lies unturned to where the
 *  turned one has it. */
function slotOfRectangle(scratch: Sketch, lo: Vec2, hi: Vec2, turn: (p: Vec2) => Vec2, where: string): Record<string, number | number[]> {
  const w = hi[0] - lo[0]
  const h = hi[1] - lo[1]
  const r = Math.min(w, h) / 2
  const m: Vec2 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2]
  if (Math.abs(w - h) <= 2 * ROUND_FITS_MM) {
    const circle = addEntity(scratch, { kind: 'circle', c: turn(m), r })
    addConstraint(scratch, { kind: 'diameter', entity: circle, value: 2 * r })
    return { circle }
  }
  const along = w > h
  const from: Vec2 = along ? [lo[0] + r, m[1]] : [m[0], lo[1] + r]
  const to: Vec2 = along ? [hi[0] - r, m[1]] : [m[0], hi[1] - r]
  const roles = drawShape(scratch, { kind: 'slot', from: turn(from), to: turn(to), width: 2 * r }, where)
  addConstraint(scratch, { kind: 'radius', entity: (roles.ends as number[])[0], value: r })
  return roles
}

/** A shape's points on the sketch's sheet: with world: true, world
 *  [x, y, z] taken square onto the plane into its [u, v] — as
 *  reverse.plane.describe { point } reads them; [u, v] as given otherwise. */
function onSheet(sh: Json, frame: SectionFrame, where: string): Json {
  const toSheet = (p: unknown, key: string): Vec2 => {
    const q = p as number[]
    if (sh.world === true) {
      if (q.length !== 3) invalid(`${where}: ${key} — with world: true a point is [x, y, z] in the world, mm.`) // units-ok: a command's error — the commands take and answer mm
      const d = sub(q as Vec3, frame.origin)
      return [dot(d, frame.basisU), dot(d, frame.basisV)]
    }
    if (q.length !== 2) invalid(`${where}: ${key} is [u, v] on the sketch’s sheet — give world: true to hand it world points [x, y, z].`)
    return q as Vec2
  }
  const out: Json = { ...sh }
  for (const k of ['center', 'from', 'to']) if (Array.isArray(sh[k])) out[k] = toSheet(sh[k], k)
  if (Array.isArray(sh.points)) out.points = (sh.points as unknown[]).map((p, i) => toSheet(p, `points[${i}]`))
  return out
}

/** The sizes each kind of shape takes by an expression (exprs). */
const SHAPE_EXPR_SLOTS: Record<string, readonly string[]> = { circle: ['radius'], rectangle: ['width', 'height', 'radius'], slot: ['width', 'length'], polygon: ['radius'] }

/** A shape's exprs read, its points on the sheet already: each checked and
 *  worked out on the parameters as they stand, and the shape's numbers set
 *  to what they come to — what it is drawn at; a rectangle's width or
 *  height its size, or `to` moved off `from`; a slot's length `to` moved
 *  along from → to. The expressions by field, for shapeDimensions. A fixed
 *  shape takes none: its pieces are locked, and nothing would follow. A
 *  point takes none either: a world point is put on the sheet by a
 *  projection that mixes x, y and z, and the sketch's distances are
 *  unsigned, so no one dimension follows one coordinate. */
function shapeSized(sh: Json, where: string): { drawn: Json; exprs: Record<string, string> } {
  const given = sh.exprs as Record<string, unknown> | undefined
  if (given === undefined || given === null) return { drawn: sh, exprs: {} }
  const slots = SHAPE_EXPR_SLOTS[String(sh.kind)] ?? []
  const exprs: Record<string, string> = {}
  for (const [k, v] of Object.entries(given)) {
    if (['from', 'to', 'center', 'points'].includes(k))
      invalid(`${where}: exprs.${k} — a point takes no expression: ${sh.world === true ? 'a world point lands on the sheet by a projection, and ' : ''}the sketch's distances are unsigned, so no one dimension follows a coordinate. Hold the point with a relation — constraints: [{ kind: "distance", p: { entity, at }, q: { datum: "yz" }, expr }] holds it off a coordinate plane the sketch plane is square to — or move the sketch's plane by its own offset expression.`)
    if (!slots.includes(k)) invalid(`${where}: exprs.${k} — ${slots.length > 0 ? `a ${String(sh.kind)} takes expressions for ${slots.join(', ')}` : `a ${String(sh.kind)} takes no expressions`}.`)
    if (typeof v !== 'string' || !v.trim()) invalid(`${where}: exprs.${k} is an expression — a string: "w", "d/2 + 0.5".`)
    exprs[k] = (v as string).trim()
  }
  if (Object.keys(exprs).length === 0) return { drawn: sh, exprs }
  if (sh.fixed === true) invalid(`${where}: exprs and fixed — fixed locks every piece where it is, so nothing could follow the expression. Leave fixed out: the shape's own relations keep its form and the dimensions its size; hold it in place with a relation (a coincident, or a distance to a datum).`)
  const scope = re().parameterTable.scope
  const value = (k: string): number => {
    const r = evaluateFor(exprs[k], 'length', scope)
    if (!r.ok) return invalid(`${where}: exprs.${k} “${exprs[k]}” — ${r.error}`)
    // units-ok: a command's error — the commands take and answer mm
    if (!(r.value > 0)) invalid(`${where}: exprs.${k} “${exprs[k]}” comes to ${round4(r.value)} mm — a size is above zero.`)
    return r.value
  }
  const drawn: Json = { ...sh }
  const p = (k: string) => sh[k] as Vec2 | undefined
  switch (sh.kind) {
    case 'circle':
    case 'polygon':
      drawn.radius = value('radius')
      break
    case 'rectangle': {
      const w = exprs.width !== undefined ? value('width') : undefined
      const h = exprs.height !== undefined ? value('height') : undefined
      if (exprs.radius !== undefined) drawn.radius = value('radius')
      if (w === undefined && h === undefined) break
      const center = p('center')
      const size = sh.size as Vec2 | undefined
      const from = p('from')
      const to = p('to')
      const away = (a: number, b: number | undefined) => (b === undefined || b >= a ? 1 : -1)
      if (center) {
        if (!size && (w === undefined || h === undefined)) invalid(`${where}: about a center a rectangle takes size, or both exprs.width and exprs.height.`)
        drawn.size = [w ?? size![0], h ?? size![1]]
      } else if (from) {
        if (!to && (w === undefined || h === undefined)) invalid(`${where}: from a corner a rectangle takes to, or both exprs.width and exprs.height.`)
        drawn.to = [w !== undefined ? from[0] + away(from[0], to?.[0]) * w : to![0], h !== undefined ? from[1] + away(from[1], to?.[1]) * h : to![1]]
      }
      break
    }
    case 'slot': {
      if (exprs.width !== undefined) drawn.width = value('width')
      if (exprs.length === undefined) break
      const length = value('length')
      const [from, to] = [p('from'), p('to')]
      if (p('center')) drawn.length = length
      else if (from && to) {
        const d = Math.hypot(to[0] - from[0], to[1] - from[1])
        if (!(d > 1e-9)) invalid(`${where}: from and to are one point — no way along them for exprs.length.`)
        drawn.to = [from[0] + ((to[0] - from[0]) / d) * length, from[1] + ((to[1] - from[1]) / d) * length]
      }
      break
    }
  }
  return { drawn, exprs }
}

/** The dimensions that hold a drawn shape's sizes to their expressions:
 *  added to its own sheet, to be numbered with its relations — and
 *  following the parameters as any dimension does. A circle's or a
 *  polygon's radius on the circle it is sized on; a slot's width as its
 *  rounds' diameter, its length centre to centre; a rectangle's width and
 *  height as the distance across its sides, its corners' radius on the
 *  rounds' own dimensions. */
function shapeDimensions(scratch: Sketch, kind: string, roles: Record<string, number | number[]>, exprs: Record<string, string>, where: string): void {
  if (Object.keys(exprs).length === 0) return
  const dim = (c: ConstraintInput) => addConstraint(scratch, c)
  switch (kind) {
    case 'circle':
    case 'polygon':
      dim({ kind: 'radius', entity: roles.circle as number, value: 0, expr: exprs.radius })
      return
    case 'slot': {
      const [to, from] = roles.ends as number[]
      if (exprs.width) dim({ kind: 'diameter', entity: to, value: 0, expr: exprs.width })
      if (exprs.length) dim({ kind: 'distance', p: { entity: to, at: 'center' }, q: { entity: from, at: 'center' }, value: 0, expr: exprs.length })
      return
    }
    case 'rectangle': {
      // Rounded at half its shorter side it was drawn as a slot (or a
      // circle): a slot's sizes are not a rectangle's.
      if (!roles.sides || roles.ends || roles.circle) invalid(`${where}: rounded at half its shorter side the rectangle is drawn as a slot — give it as a slot, with exprs { width, length }.`)
      const sides = roles.sides as number[]
      if (exprs.width) dim({ kind: 'distance', p: { entity: sides[1], at: 'a' }, q: { line: sides[3] }, value: 0, expr: exprs.width })
      if (exprs.height) dim({ kind: 'distance', p: { entity: sides[2], at: 'a' }, q: { line: sides[0] }, value: 0, expr: exprs.height })
      if (exprs.radius) {
        const rounds = new Set((roles.rounds as number[] | undefined) ?? [])
        for (const c of scratch.constraints) if (c.kind === 'radius' && rounds.has(c.entity)) c.expr = exprs.radius
      }
      return
    }
  }
}

/** A shape of the input drawn as the panel's tool draws it, into a sketch
 *  of its own — its pieces numbered in the order they are made. Its pieces
 *  by what they are, by those numbers. */
function drawShape(scratch: Sketch, sh: Json, where: string): Record<string, number | number[]> {
  const v2 = (k: string) => sh[k] as Vec2 | undefined
  const turn = ((sh.angleDeg as number | undefined) ?? 0) * (Math.PI / 180)
  const turned = (p: Vec2, about: Vec2): Vec2 => {
    const d: Vec2 = [p[0] - about[0], p[1] - about[1]]
    return [about[0] + d[0] * Math.cos(turn) - d[1] * Math.sin(turn), about[1] + d[0] * Math.sin(turn) + d[1] * Math.cos(turn)]
  }
  switch (sh.kind) {
    case 'rectangle': {
      const center = v2('center')
      const size = v2('size')
      const from = v2('from')
      const to = v2('to')
      let lo: Vec2
      let hi: Vec2
      if (center && size) {
        if (!(Math.abs(size[0]) > 0 && Math.abs(size[1]) > 0)) invalid(`${where}: a rectangle needs a width and a height.`)
        lo = [center[0] - Math.abs(size[0]) / 2, center[1] - Math.abs(size[1]) / 2]
        hi = [center[0] + Math.abs(size[0]) / 2, center[1] + Math.abs(size[1]) / 2]
      } else if (from && to) {
        if (Math.abs(to[0] - from[0]) < 1e-9 || Math.abs(to[1] - from[1]) < 1e-9) invalid(`${where}: from and to lie on a level or upright line — the rectangle has no area.`)
        lo = [Math.min(from[0], to[0]), Math.min(from[1], to[1])]
        hi = [Math.max(from[0], to[0]), Math.max(from[1], to[1])]
      } else return invalid(`${where}: a rectangle takes from and to, or center and size.`)
      const about: Vec2 = center ?? from!
      const radius = sh.radius as number | undefined
      // The most a round takes is half the shorter side, measured before
      // any corner is cut back; at that the rectangle is a slot (a circle,
      // square), and drawn as one.
      const half = Math.min(hi[0] - lo[0], hi[1] - lo[1]) / 2
      if (radius !== undefined && radius > half + ROUND_FITS_MM) invalid(`${where}: the corners do not round at ${radius} mm — half the shorter side, ${round4(half)} mm, is the most a round takes (a slot).`) // units-ok: a command's error — the commands take and answer mm
      if (radius !== undefined && radius > half - ROUND_FITS_MM) return slotOfRectangle(scratch, lo, hi, (p) => turned(p, about), where)
      const corners: Vec2[] = [lo, [hi[0], lo[1]], hi, [lo[0], hi[1]]]
      const sides = turn === 0 ? addRectangle(scratch, lo, hi) : addTurnedRectangle(scratch, corners.map((c) => turned(c, about)))
      const roles: Record<string, number | number[]> = center ? { sides, center: addRectangleCentre(scratch, sides) } : { sides }
      if (radius !== undefined) {
        // Each corner rounded as the sketch's own Round does it: the sides
        // cut back, an arc tangent to both, its radius dimensioned.
        const rounds: number[] = []
        for (let i = 0; i < 4; i++) {
          const made = filletLines(scratch, sides[i], sides[(i + 1) % 4], radius, half + ROUND_FITS_MM)
          if (typeof made === 'string') invalid(`${where}: the corners do not round at ${radius} mm — ${made}`) // units-ok: a command's error — the commands take and answer mm
          rounds.push((made as { arc: number }).arc)
        }
        roles.rounds = rounds
        // The diagonals end where the sides now start — at the tangent
        // points, which lie about the same centre as the corners did — so
        // a shape fixed where it is still meets its own coincidences.
        for (const c of scratch.constraints) {
          if (c.kind !== 'coincident') continue
          const diagonal = entityOf(scratch, c.p.entity)
          const side = entityOf(scratch, c.q.entity)
          if (diagonal?.kind !== 'line' || !diagonal.construction || !side) continue
          const to = anchorPoint(side, c.q.at)
          if (c.p.at === 'a') diagonal.a = [to[0], to[1]]
          else diagonal.b = [to[0], to[1]]
        }
      }
      return roles
    }
    case 'slot': {
      const width = sh.width as number
      const r = width / 2
      let from = v2('from')
      let to = v2('to')
      const center = v2('center')
      if (center && typeof sh.length === 'number') {
        const half = (sh.length as number) / 2
        from = [center[0] - half * Math.cos(turn), center[1] - half * Math.sin(turn)]
        to = [center[0] + half * Math.cos(turn), center[1] + half * Math.sin(turn)]
      }
      if (!from || !to) return invalid(`${where}: a slot takes from and to, or center and length.`)
      const d: Vec2 = [to[0] - from[0], to[1] - from[1]]
      const len = Math.hypot(d[0], d[1])
      if (!(len > 1e-9)) invalid(`${where}: from and to are one point — a slot that short is a circle.`)
      if (!(r > 0)) invalid(`${where}: a slot needs a width.`)
      const u: Vec2 = [d[0] / len, d[1] / len]
      const n: Vec2 = [-u[1], u[0]]
      const off = (q: Vec2, k: number): Vec2 => [q[0] + n[0] * r * k, q[1] + n[1] * r * k]
      // Round the loop: the left side out, the round at `to` (from its
      // right-hand end counter-clockwise through the far end), the right
      // side back, the round at `from`.
      const left = addEntity(scratch, { kind: 'line', a: off(from, 1), b: off(to, 1) })
      const endTo = addEntity(scratch, { kind: 'arc', c: to, r, start: Math.atan2(-n[1], -n[0]), sweep: Math.PI })
      const right = addEntity(scratch, { kind: 'line', a: off(to, -1), b: off(from, -1) })
      const endFrom = addEntity(scratch, { kind: 'arc', c: from, r, start: Math.atan2(n[1], n[0]), sweep: Math.PI })
      addConstraint(scratch, { kind: 'coincident', p: { entity: left, at: 'b' }, q: { entity: endTo, at: 'b' } })
      addConstraint(scratch, { kind: 'coincident', p: { entity: endTo, at: 'a' }, q: { entity: right, at: 'a' } })
      addConstraint(scratch, { kind: 'coincident', p: { entity: right, at: 'b' }, q: { entity: endFrom, at: 'b' } })
      addConstraint(scratch, { kind: 'coincident', p: { entity: endFrom, at: 'a' }, q: { entity: left, at: 'a' } })
      for (const [a, b] of [[left, endTo], [right, endTo], [right, endFrom], [left, endFrom]]) addConstraint(scratch, { kind: 'tangent', a, b })
      addConstraint(scratch, { kind: 'equal', a: endTo, b: endFrom })
      return { sides: [left, right], ends: [endTo, endFrom] }
    }
    case 'polygon': {
      const center = v2('center')!
      const r = sh.radius as number
      const made = addPolygon(scratch, center, [center[0] + r * Math.cos(turn), center[1] + r * Math.sin(turn)], sh.sides as number, (sh.fit as PolygonFit | undefined) ?? 'inscribed')
      if (!made) return invalid(`${where}: a polygon takes 3 to ${POLYGON_MAX_SIDES} sides and a radius.`)
      return made.circle === made.rim ? { sides: made.lines, circle: made.circle } : { sides: made.lines, circle: made.circle, rim: made.rim }
    }
    case 'polyline': {
      const pts = sh.points as Vec2[]
      const closed = Boolean(sh.closed)
      if (closed && pts.length < 3) invalid(`${where}: a closed polyline needs three corners or more.`)
      const n = closed ? pts.length : pts.length - 1
      const lines: number[] = []
      for (let i = 0; i < n; i++) {
        const a = pts[i]
        const b = pts[(i + 1) % pts.length]
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-9) invalid(`${where}: corners ${i} and ${(i + 1) % pts.length} are one point.`)
        lines.push(addEntity(scratch, { kind: 'line', a, b }))
      }
      for (let i = 0; i + 1 < lines.length; i++) addConstraint(scratch, { kind: 'coincident', p: { entity: lines[i], at: 'b' }, q: { entity: lines[i + 1], at: 'a' } })
      if (closed) addConstraint(scratch, { kind: 'coincident', p: { entity: lines[lines.length - 1], at: 'b' }, q: { entity: lines[0], at: 'a' } })
      return { lines }
    }
    case 'ellipse': {
      const center = v2('center')!
      const [a, b] = [sh.a as number, sh.b as number]
      const n = (sh.points as number | undefined) ?? ELLIPSE_POINTS
      if (!(a > 0 && b > 0)) invalid(`${where}: an ellipse needs both half axes above zero.`)
      const pts = Array.from({ length: n }, (_, k): Vec2 => {
        const t = (2 * Math.PI * k) / n
        return turned([center[0] + a * Math.cos(t), center[1] + b * Math.sin(t)], center)
      })
      return { spline: addEntity(scratch, { kind: 'spline', pts, closed: true }) }
    }
    case 'circle': {
      const r = sh.radius as number | undefined
      if (!(typeof r === 'number' && r > 0)) return invalid(`${where}: a circle takes a radius — or exprs.radius.`)
      return { circle: addEntity(scratch, { kind: 'circle', c: v2('center')!, r }) }
    }
    default:
      return invalid(`${where}: there is no shape “${String(sh.kind)}”.`)
  }
}

/** A sketch as handed in, made one the store takes: its shapes drawn into
 *  pieces, its ids checked, every constraint naming pieces it has and that
 *  take it, every dimension given its number — its expression's, or what
 *  the pieces measure now — its patterns laid, the relations a drawing
 *  implies inferred unless asked not to, and the slice points of a fitted
 *  piece kept from the sketch it replaces. */
export function sketchOf(input: Json, frame: SketchFeature['frame'], stored?: Sketch, opts: { snap?: boolean } = {}): { sketch: Sketch; made: SketchMade } {
  const entities = ((input.entities as Json[] | undefined) ?? []).map((e) => {
    const was = stored?.entities.find((x) => x.id === e.id && x.kind === e.kind)
    const kept = was ? Object.fromEntries(KEPT_ON_PIECES.filter((k) => k in was && !(k in e)).map((k) => [k, (was as unknown as Json)[k]])) : {}
    return { ...e, ...kept } as unknown as SketchEntity
  })
  const ids = new Set<number>()
  const listed = (input.entities as Json[] | undefined) ?? []
  // Where free ids start in the sketch handed back, for the refusals to say.
  // Pieces and relations share one run: past every piece, every relation
  // handed in, and where the sketch's own run stood.
  const free = () => Math.max(stored?.nextId ?? 1, ...[...ids].map((id) => id + 1), ...listed.map((e) => (typeof e.id === 'number' ? e.id + 1 : 0)), ...((input.constraints as Json[] | undefined) ?? []).map((c) => (typeof c.id === 'number' ? c.id + 1 : 0)))
  const taken = (id: number, what: string) => {
    const relation = stored?.constraints.some((c) => c.id === id)
    // What holds it, where the sketch did not: a relation handed in with
    // the pieces — the same call's own.
    const givenRelation = !relation && ((input.constraints as Json[] | undefined) ?? []).some((c) => c.id === id)
    const by = relation ? ' by a relation or a dimension — pieces and relations share one run of ids' : givenRelation ? ' by a relation or a dimension given with it — pieces and relations share one run of ids' : ''
    return `${what}: the id ${id} is taken${by}. Ids from ${free()} up are free — or leave a piece’s id out, and it is given one.`
  }
  for (const e of entities) {
    if (typeof e.id !== 'number') continue
    if (ids.has(e.id)) invalid(taken(e.id, `Two pieces share the id ${e.id}`))
    ids.add(e.id)
  }
  const constraintIds = new Set(((input.constraints as Json[] | undefined) ?? []).flatMap((c) => (typeof c.id === 'number' ? [c.id] : [])))
  for (const e of entities) if (typeof e.id === 'number' && constraintIds.has(e.id)) invalid(taken(e.id, `The piece ${e.id}`))
  // A piece handed in without an id takes the next free one, in the order
  // listed — past every id given, so none it takes is one named later.
  const unnamed: number[] = []
  for (const e of entities) {
    if (typeof e.id === 'number') continue
    e.id = free()
    ids.add(e.id)
    unnamed.push(e.id)
  }
  // The sides of the rectangles and polygons, which their own relations
  // hold square — and their copies, laid by the patterns below.
  const shaped = new Set<number>()
  // The shapes, each drawn on a sheet of its own and its pieces brought
  // over under the run of ids it asked for; their relations join the
  // constraints, to be checked and numbered with them.
  const made: SketchMade = { shapes: [], patterns: [], inferred: 0, ...(unnamed.length > 0 ? { ids: unnamed } : {}) }
  const shapeConstraints: Json[] = []
  ;((input.shapes as Json[] | undefined) ?? []).forEach((sh, i) => {
    const where = `shapes[${i}] (${String(sh.kind)})`
    const scratch = emptySketch()
    const sized = shapeSized(onSheet(sh, frame, where), where)
    const { sh: drawn, closedOn } = polylineClosing(sized.drawn)
    const roles = drawShape(scratch, drawn, where)
    shapeDimensions(scratch, String(sh.kind), roles, sized.exprs, where)
    const start = typeof sh.id === 'number' ? sh.id : free()
    const map = new Map(scratch.entities.map((e, k) => [e.id, start + k]))
    const id = (old: number) => map.get(old)!
    for (const e of scratch.entities) {
      const at = id(e.id)
      if (ids.has(at) || constraintIds.has(at)) invalid(taken(at, `${where}: its pieces take the ids ${start} to ${start + scratch.entities.length - 1}, and`))
      ids.add(at)
      if (sh.kind !== 'polyline') shaped.add(at)
      entities.push({ ...e, id: at, ...(sh.fixed ? { fixed: true } : {}), ...(sh.construction ? { construction: true } : {}) })
    }
    for (const c of scratch.constraints) {
      const { id: _id, ...rest } = c
      void _id
      shapeConstraints.push(renumbered(rest as ConstraintInput, id) as unknown as Json)
    }
    const out = Object.fromEntries(Object.entries(roles).map(([k, v]) => [k, Array.isArray(v) ? v.map(id) : id(v)]))
    made.shapes.push({ index: i, kind: sh.kind, ...out, ...(closedOn ? { closedOn: 'first corner' } : {}) })
    if (sh.kind === 'ellipse') {
      const pts = (scratch.entities[0] as SketchSpline).pts
      made.ellipses = [...(made.ellipses ?? []), { piece: id(scratch.entities[0].id), points: pts.length, deviationMm: Number(ellipseDeviation(pts, drawn.center as Vec2, drawn.a as number, drawn.b as number, (((drawn.angleDeg as number | undefined) ?? 0) * Math.PI) / 180).toPrecision(3)) }]
    }
  })
  if (entities.length === 0) invalid('The sketch has no pieces — give it entities or shapes, or fit it to the scan (fit).')
  if (opts.snap) {
    // What the sketch had and comes back as it was stays; what is new, or
    // handed in changed, is joined to it and to each other.
    const held = new Set(entities.filter((e) => stored?.entities.some((x) => x.id === e.id && sameGeometry(x, e))).map((e) => e.id))
    const snapped = snapNewEnds(entities, held)
    if (snapped.length > 0) made.snapped = snapped
  }
  for (const e of entities) {
    if (e.kind !== 'spline') continue
    const pts = (e.pts ?? []) as Vec2[]
    if (pts.length < (e.closed ? 3 : 2)) invalid(`The spline ${e.id} needs ${e.closed ? 'three fit points at least to close' : 'two fit points at least'} — it has ${pts.length}.`)
    pts.forEach((p, i) => {
      const q = pts[(i + 1) % pts.length]
      if ((i + 1 < pts.length || e.closed) && Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-9) invalid(`The spline ${e.id}: fit points ${i} and ${(i + 1) % pts.length} are one point.`)
    })
  }
  const piece = (id: number, where: string, kinds?: SketchEntity['kind'][]): SketchEntity => {
    const e = entities.find((x) => x.id === id)
    if (!e) invalid(`${where}: there is no piece ${id}.`)
    if (kinds && !kinds.includes(e!.kind)) invalid(`${where}: piece ${id} is ${aPiece(e!.kind)}, and this takes ${kinds.map(aPiece).join(' or ')}.`)
    return e!
  }
  const anchor = (a: { entity: number; at: string }, where: string) => {
    const e = piece(a.entity, where)
    if (!pointsOf(e).includes(a.at as AnchorAt)) invalid(`${where}: ${aPiece(e.kind)} has no point “${a.at}” — it has ${pointsOf(e).join(', ')}.`)
  }
  const given = (input.constraints as Json[] | undefined) ?? []
  let next = Math.max(0, ...ids) + 1
  for (const c of given) if (typeof c.id === 'number') next = Math.max(next, c.id + 1)
  const scope = re().parameterTable.scope
  const datums = datumTraces(frame)
  const sketch: Sketch = { entities, constraints: [], nextId: 0 }
  const all = [...given.map((c, i) => ({ raw: c, where: `constraints[${i}] (${String(c.kind)})` })), ...shapeConstraints.map((c) => ({ raw: c, where: `a shape’s ${String(c.kind)}` }))]
  for (const { raw, where } of all) {
    const c = { ...raw, id: typeof raw.id === 'number' ? raw.id : next++ } as unknown as Constraint & Json
    if (ids.has(c.id)) invalid(`${where}: the id ${c.id} is a piece’s — pieces and constraints share one run of ids. Ids from ${free()} up are free.`)
    ids.add(c.id)
    const k = c.kind as ConstraintKind
    if (['horizontal', 'vertical', 'parallel', 'perpendicular', 'tangent', 'concentric', 'equal', 'length', 'radius', 'diameter', 'angle'].includes(k)) {
      const named = constraintEntities(c).map((id) => piece(id, where))
      // Two lines are tangent only where they run on in line: what was
      // meant is a relation of lines, or a round between them.
      if (k === 'tangent' && named.every((e) => e.kind === 'line')) invalid(`${where}: two lines are not tangent — use parallel or collinear, or add.rounds (reverse.sketch.edit) to blend the kink between them with the scan’s round.`)
      if (!relationTakes(k, named)) invalid(`${where}: does not apply to ${named.map((e) => aPiece(e.kind)).join(' and ')}.`)
    }
    if (c.kind === 'coincident' || c.kind === 'symmetric') {
      anchor(c.p, where)
      anchor(c.q, where)
    }
    if (c.kind === 'pointOn') {
      anchor(c.p, where)
      if ('line' in c.on) piece(c.on.line, where, ['line'])
      if ('curve' in c.on) piece(c.on.curve, where, ['arc', 'circle', 'spline'])
    }
    if (c.kind === 'collinear') {
      piece(c.line, where, ['line'])
      if ('line' in c.on) piece(c.on.line, where, ['line'])
    }
    if (c.kind === 'symmetric' && typeof c.about === 'object' && 'line' in c.about) piece(c.about.line, where, ['line'])
    if (c.kind === 'distance') {
      anchor(c.p, where)
      if ('entity' in c.q) anchor(c.q, where)
      else if ('line' in c.q) piece(c.q.line, where, ['line'])
    }
    // A dimension by its kind: one handed in with only an expression has
    // no value yet.
    if (DIMENSION_KINDS.includes(c.kind) && (c.kind === 'length' || c.kind === 'radius' || c.kind === 'diameter' || c.kind === 'angle' || c.kind === 'distance')) {
      if (c.expr) {
        const r = evaluateFor(c.expr, dimensionKind(c.kind), scope)
        if (!r.ok) invalid(`${where}: “${c.expr}” — ${r.error}`)
        c.value = r.ok ? r.value : 0
      } else if (typeof c.value !== 'number') {
        const e = (id: number) => piece(id, where)
        const measured =
          c.kind === 'length' || c.kind === 'radius' || c.kind === 'diameter'
            ? measureDimension(sketch, c.kind, e(c.entity))
            : c.kind === 'angle'
              ? measureDimension(sketch, 'angle', e(c.a), e(c.b))
              : measureDimension(sketch, 'distance', c.p, c.q, datums)
        if (measured === null) invalid(`${where}: give it a value — the pieces do not measure one.`)
        c.value = measured!
      }
    }
    sketch.constraints.push(c)
  }
  sketch.nextId = Math.max(next, ...ids) + 1
  // A spline is held tangent where an end of it meets the other piece: the
  // coincidence there has to be among the constraints too.
  for (const c of sketch.constraints) {
    if (c.kind !== 'tangent') continue
    const [a, b] = [entityOf(sketch, c.a), entityOf(sketch, c.b)]
    const spline = a?.kind === 'spline' ? a : b?.kind === 'spline' ? b : null
    const other = spline === a ? b : a
    if (spline && other && !splineJoint(sketch, spline.id, other.id)) invalid(`constraints (tangent ${c.id}): the spline ${spline.id} is held tangent where one of its ends (a or b) meets ${other.id} — add the coincident there.`)
  }
  // The patterns, on the pieces and the relations as they now stand.
  ;((input.patterns as Json[] | undefined) ?? []).forEach((p, i) => {
    const where = `patterns[${i}] (${String(p.kind)})`
    const pieces = p.pieces as number[]
    for (const id of pieces) piece(id, where)
    const spec: SketchPatternSpec =
      p.kind === 'circular'
        ? { kind: 'circular', centre: p.center as Vec2, count: p.count as number, angleDeg: (p.angleDeg as number | undefined) ?? 360 }
        : { kind: 'rectangular', step: p.step as Vec2, count: p.count as number, ...(p.step2 ? { step2: p.step2 as Vec2, count2: (p.count2 as number | undefined) ?? 1 } : {}) }
    const copies = patternPieces(sketch, pieces, spec)
    for (const copy of copies) copy.forEach((id, k) => shaped.has(pieces[k]) && shaped.add(id))
    made.patterns.push(copies)
  })
  // What the sketch held before keeps the relations it had: only the
  // pieces new to it are joined where they meet.
  if (input.infer !== false) made.inferred = inferRelations(sketch, stored ? new Set(sketch.entities.filter((e) => !stored.entities.some((x) => x.id === e.id)).map((e) => e.id)) : undefined, shaped)
  return { sketch, made }
}

/** What a sketch handed in made, as the answer says it — left out where
 *  it made nothing past what was listed. */
export const madeOut = (m: SketchMade) => ({
  ...(m.ids ? { ids: m.ids } : {}),
  ...(m.shapes.length > 0 ? { shapes: m.shapes } : {}),
  ...(m.patterns.length > 0 ? { patterns: m.patterns.map((copies) => ({ copies })) } : {}),
  ...(m.inferred > 0 ? { inferred: m.inferred } : {}),
  ...(m.snapped ? { snapped: m.snapped } : {}),
  ...(m.ellipses ? { ellipses: m.ellipses } : {}),
})

/** putSketch for a sketch a fit landed runs in (fit.junctions): where it
 *  does not solve, the landing whose relations miss the most is let go —
 *  its relations taken out of `sketch`, the junction said free — and the
 *  sketch put again, until it solves or no landing is among what it
 *  misses; then refused as putSketch refuses. */
export function putLanded(sketch: Sketch, fit: FitDraftOut | undefined, pull?: readonly Pull[]) {
  for (;;) {
    try {
      return putSketch(sketch, pull)
    } catch (e) {
      const unmet = new Map((re().sketchDraft?.report?.unmet ?? []).map((u) => [u.id, u.residual]))
      const worst = (fit?.junctions ?? [])
        .filter((j) => j.held !== 'free' && (j.constraints ?? []).some((id) => unmet.has(id)))
        .map((j) => ({ j, miss: Math.max(...j.constraints!.map((id) => unmet.get(id) ?? 0)) }))
        .sort((x, y) => y.miss - x.miss)[0]
      if (!(e instanceof CommandError) || !worst) throw e
      sketch.constraints = sketch.constraints.filter((c) => !worst.j.constraints!.includes(c.id))
      worst.j.held = 'free'
      delete worst.j.constraints
    }
  }
}

/** The sketch being drawn given `sketch`, solved — or refused, the box
 *  shut, when it does not solve. Returns what the solve said. */
export function putSketch(sketch: Sketch, pull?: readonly Pull[]) {
  re().setSketch(sketch, pull)
  const d = re().sketchDraft!
  if (d.error) throw new CommandError('failed', `The sketch does not solve: ${d.error}`)
  const r = d.report
  if (r && !r.ok) {
    const unmet = r.unmet.map((u) => {
      const c = d.sketch.constraints.find((x) => x.id === u.id)
      return `${u.id}${c ? ` (${c.kind})` : ''} off by ${u.residual.toPrecision(3)}`
    })
    throw new CommandError('failed', `The sketch does not solve — its constraints contradict each other or cannot all be met: ${unmet.join('; ')}. Take one out or change a value.`)
  }
  // How the fitted pieces sit on their points after the solve — what a
  // relation or a dimension cost the fit.
  const fit = sketchResidual(d.sketch.entities)
  return r ? { ok: r.ok, underConstrained: r.underConstrained, redundant: r.redundant, ...(fit ? { fit } : {}) } : null
}

export interface FitIn {
  /** Points typed in, [u, v] mm on the sketch's sheet — one chain, or a
   *  list of chains — fitted in place of the scan's cut. */
  points?: Vec2[] | Vec2[][]
  /** The typed points' chains each a loop. */
  closed?: boolean
  chains?: 'all' | 'largest' | number[] | { at: Vec2 }
  within?: WithinBox
  skin?: SideRule['skin']
  facing?: { dir: Vec2; withinDeg?: number }
  closeGaps?: number
  arcs?: number
  spline?: number
  detail?: number
  tolerance?: number
  alignAxes?: boolean
  alignDegrees?: number
  joinCorners?: boolean
  accept?: AcceptRule
  like?: Ref
  /** mm off the sketch's plane along its normal the scan is cut at. */
  level?: number
  /** mm: slice points this near a piece already there are that piece's
   *  (core/shareFit.ts); SHARE_MM by default, 0 for none. */
  share?: number
  /** The taper the extrude from this sketch will have, degrees, signed as
   *  its draftDeg: the chains are moved for it (draftOffsetDraft). */
  draftDeg?: number
  /** The scan seen through square onto the plane, in a band of heights
   *  about it, in place of the scan cut there (reThrough.ts). */
  through?: ThroughIn
}

/** The fit as asked for, and the chains it runs on — cut before the box
 *  is opened, the cut being the worker's. */
export interface PreparedFit {
  chains: Vec2[][]
  /** Each point's verdict on the side skin or facing asks for, by the
   *  point; none when neither is asked. */
  side?: Map<Vec2, boolean>
  fit: FitIn
  /** The sketch's frame, which a within in the world is read in. */
  frame?: SectionFrame
  options: FitOptions
  /** The station the run is fitted like (fit.like): its name, its sketch
   *  and its profile. */
  like?: { name: string; sketch: Sketch; loop: StationLoop }
  /** The chains of typed points fitted in place of the cut (fit.points). */
  given?: GivenChain[]
  /** Seen through (fit.through): whether each chain is a hole, by its
   *  index, and what the see-through read. */
  holes?: boolean[]
  through?: ThroughOut
}

/** A chain of points typed in, as a fit takes it: in order, a loop's
 *  first point not repeated at its end. */
export interface GivenChain {
  points: Vec2[]
  closed: boolean
}

/** What each fitted chain became: its pieces by id and kind — or, for a
 *  chain a fit of every chain could not fit, its points and why
 *  (skipped). A chain is named by its index in the outline; run is its
 *  place among the runs in the box (within) or on the side asked (skin,
 *  facing), joined the chains closeGaps
 *  made it of, bridged the gaps it bridged. */
export interface FittedOut {
  chain: number
  /** Seen through (fit.through): the chain is a hole in another. */
  hole?: boolean
  run?: number
  joined?: number[]
  bridged?: { gaps: number; largest: number }
  closed?: boolean
  /** Its pieces by id and kind — an arc's or a circle's radius too, for a
   *  chain of typed points. */
  pieces?: { id: number; kind: string; r?: number }[]
  /** A chain whose pieces close more than one region: it crosses itself. */
  crosses?: { regions: number; areas: number[] }
  /** A chain fitted open: its pieces' two free ends, the gap between
   *  them, and — the whole chain open, not a run a box or a side cut — the
   *  closeGaps a fit again would close it with (openOut). */
  open?: { ends: [Vec2, Vec2]; gap: number; tryCloseGaps?: number }
  /** Fitted like a station (fit.like): its name; reversed, the run taken
   *  from its far end; runs, how many it chose the longest of. */
  like?: { sketch: string; reversed?: boolean; runs?: number }
  warning?: string
  points?: number
  skipped?: string
  /** For chains: { at } — the rule that named the chain (on it, the
   *  smallest closed one round it, else the nearest), its area (mm², 0
   *  open) and how many closed chains lie round the point. */
  pickedBy?: 'on' | 'round' | 'nearest'
  area?: number
  enclosing?: number
  /** The level the chain was cut at (fit.level), mm off the plane. */
  level?: number
  /** A run of a chain that lies along the sketch's pieces elsewhere
   *  (fit.share): its place among the chain's runs, and the pieces its
   *  start and its end reach — junctions says where each landed. */
  part?: number
  reaches?: { start?: number; end?: number }
  /** Every point of the chain lies along a piece the sketch has: nothing
   *  of it is new. */
  drawn?: true
  /** A chain of typed points (fit.points): the most any of them lies off
   *  the pieces, mm, and each one's miss, worst first (point: its index in
   *  the chain); whether the pieces run past the box round the points, how
   *  far, past which side, where — false where they keep within it; and
   *  the ends held running along the side their point lies on. */
  maxDeviation?: number
  deviations?: { point: number; mm: number }[]
  overshoot?: { mm: number; side: BoxSide; at: Vec2 } | false
  heldAlong?: HeldAlong[]
}

/** A run's end landed on a piece already there, as the answer gives it:
 *  the run by its place in fitted, which end of it (its piece and anchor),
 *  the piece it landed on, where, and how it is held — on that piece's end
 *  (coincident; collinear where the run carries the line on), on the piece
 *  within it (a bounded pointOn), or free: let go, the sketch not solving
 *  with it held — the end left open where it lies. */
export interface JunctionOut {
  run: number
  end: { piece: number; at: string }
  on: number
  at: Vec2
  held: 'end' | 'on' | 'free'
  collinear?: true
  /** Held tangent to the piece there too (a chain of typed points). */
  tangent?: true
  /** The relations that hold it, by id — to take out with remove. */
  constraints?: number[]
}

/** The stretches of the outline taken as pieces already there: each piece,
 *  how many points it took, how far off it they lay — the run-out between
 *  levels — and the level they were cut at. */
export interface SharedOut {
  piece: number
  points: number
  offMm: { mean: number; max: number }
  level: number
}

/** What a fit made, as the answer gives it: each chain's pieces (fitted),
 *  and — where it landed on the pieces already there — what it shared,
 *  where its runs' ends landed, and how many points were corners drawn
 *  already. */
export interface FitDraftOut {
  fitted: FittedOut[]
  shared?: SharedOut[]
  junctions?: JunctionOut[]
  corners?: number
  /** What a fit seen through read (fit.through). */
  through?: ThroughOut
  /** The chains of typed points, by their place in fitted: the points and
   *  the pieces — what givenOut reads them again on once the sketch is
   *  solved for good. Not for the answer. */
  given?: { fitted: number; points: Vec2[]; pieces: number[] }[]
}

const fitOptionsOf = (fit: FitIn): FitOptions => ({
  ...sanitizeFitOptions({
    ...DEFAULT_FIT_OPTIONS,
    ...(fit.detail !== undefined ? { detail: fit.detail } : {}),
    ...(fit.alignAxes !== undefined ? { alignAxes: fit.alignAxes } : {}),
    ...(fit.alignDegrees !== undefined ? { alignDegrees: fit.alignDegrees } : {}),
    ...(fit.joinCorners !== undefined ? { joinCorners: fit.joinCorners } : {}),
  }),
  ...(fit.arcs !== undefined ? { arcs: fit.arcs } : {}),
  ...(fit.spline !== undefined ? { spline: fit.spline } : {}),
})

/** A section's cut, waited for where the worker is still taking it. */
export async function sectionCut(id: number): Promise<SectionCut> {
  findSection(id)
  const sec = await waitFor(() => {
    const x = useStore.getState().sections.find((z) => z.id === id)
    return x?.cut || x?.message ? x : null
  }, 'the section to be cut', 60_000)
  if (!sec.cut) throw new CommandError('failed', sec.message ?? 'The section has no cut.')
  return sec.cut
}

/** The scan cut on a plane: a section's own cut, or the scan cut there now
 *  — off a section by its offset, a hair inside a face, as the panel cuts
 *  it (FACE_SLICE_INSET_MM). At a `level`, the scan is cut that far along
 *  the normal off the plane instead: another level of the part, laid on
 *  the same sheet. */
async function cutOn(plane: PlaneRef, frame: SectionFrame, level?: number): Promise<SectionCut> {
  if (plane.kind === 'section' && !plane.offset && level === undefined) return sectionCut(plane.id)
  if (!useStore.getState().fileName) throw new CommandError('no_scan', 'There is no scan to fit the sketch to — the outline is the scan cut at the plane.')
  const worker = commandHost().session.clientRef.current
  if (!worker) throw new CommandError('unavailable', 'The mesh worker is not running.')
  const off = level ?? (plane.kind === 'fitted' || plane.kind === 'bodyFace' ? -FACE_SLICE_INSET_MM : 0)
  return worker.section(addScaled(frame.origin, frame.normal, off), frame.normal, EDGE_MIN_FEATURE_MM)
}

/** The scan's outline on a plane, as the sketch's slice chains in the
 *  frame's [u, v] (cutOn). */
export async function chainsOn(plane: PlaneRef, frame: SectionFrame, level?: number): Promise<Vec2[][]> {
  return chainsOfEdges(projectCut(await cutOn(plane, frame, level), frame))
}

/** A cut laid flat in a frame with the side the material is on at every
 *  point — what skin and facing read. */
export function sidedOf(cut: SectionCut, frame: SectionFrame): SidedChains {
  const normals = projectCutNormals(cut, frame)
  if (!normals) throw new CommandError('failed', 'This cut does not carry which side the material is on — it was taken before cuts did. Move the section a hair (or cut it again) and ask again.')
  return sidedChains(projectCut(cut, frame), normals)
}

/** The scan's outline on a plane with each point's side (cutOn, sidedOf). */
export async function sidedOn(plane: PlaneRef, frame: SectionFrame, level?: number): Promise<SidedChains> {
  return sidedOf(await cutOn(plane, frame, level), frame)
}

/** Where chains lie on their sheet, in words: "u a…b, v c…d". */
export function cutSpanWords(chains: readonly (readonly Vec2[])[]): string {
  const span = chainsSpan(chains)
  return span ? `u ${round4(span.min[0])}…${round4(span.max[0])}, v ${round4(span.min[1])}…${round4(span.max[1])}` : 'nothing'
}

/** A within as handed in, checked: a box on the command's sheet —
 *  { min, max }, [u, v] mm — or in the world — { world: { min, max } },
 *  [x, y, z] mm. A box of world corners given as a sheet box is refused
 *  with where the cut lies (`span`). */
export function withinOf(raw: unknown, where: string, span?: () => string): WithinBox | undefined {
  if (raw === undefined) return undefined
  const w = raw as { min?: number[]; max?: number[]; world?: { min?: number[]; max?: number[] } }
  if (w.world !== undefined) {
    if (w.min !== undefined || w.max !== undefined) invalid(`${where}: give min and max ([u, v] on the sheet) or world: { min, max } ([x, y, z]) — not both.`)
    if (w.world.min?.length !== 3 || w.world.max?.length !== 3) invalid(`${where}.world: min and max are [x, y, z] in the world, mm.`) // units-ok: a command's error — the commands take and answer mm
    return { world: { min: w.world.min as Vec3, max: w.world.max as Vec3 } }
  }
  if (w.min?.length !== 2 || w.max?.length !== 2) invalid(`${where}: min and max are [u, v] on the sheet, mm — a box in the world goes as ${where}: { world: { min: [x, y, z], max: [x, y, z] } }${span ? `; the cut spans ${span()} on the sheet` : ''}.`) // units-ok: a command's error — the commands take and answer mm
  return { min: w.min as Vec2, max: w.max as Vec2 }
}

/** The side skin and facing ask for, as the core reads it; null when
 *  neither is asked. */
export function sideRuleOf(skin: SideRule['skin'] | undefined, facing: { dir: Vec2; withinDeg?: number } | undefined): SideRule | null {
  if (!skin && !facing) return null
  if (facing && !(Math.hypot(facing.dir[0], facing.dir[1]) > 0)) invalid('facing.dir: give a direction on the sheet, not [0, 0].')
  return { ...(skin ? { skin } : {}), ...(facing ? { facing: { dir: facing.dir, withinDeg: facing.withinDeg ?? FACING_DEG } } : {}) }
}

/** The fit a sketch asks for, prepared: its plane's chains cut. Undefined
 *  for a sketch that asks for none. */
export async function prepareFit(s: ReverseSession, plane: PlaneRef, fit: FitIn | undefined): Promise<PreparedFit | undefined> {
  if (!fit) return undefined
  const given = givenOf(fit)
  const like = fit.like !== undefined ? likeOf(fit) : undefined
  const frame = plane.kind === 'bodyFace' || plane.kind === 'fitted' ? plane.frame : resolvePlaneFrame(plane, s.resolveContext())
  if (!frame) throw new CommandError('not_found', 'That plane is not there any more.')
  // Typed points need no scan: nothing is cut.
  if (given) return { chains: [], given, fit, frame, options: fitOptionsOf(fit) }
  const rule = sideRuleOf(fit.skin, fit.facing)
  if (fit.level !== undefined && !Number.isFinite(fit.level)) invalid('fit.level: mm along the sketch’s normal from its plane.') // units-ok: a command's error — the commands take and answer mm
  if (fit.through !== undefined && fit.through !== false) {
    if (rule) invalid('fit.through sees the sheet square on, with no side to it — leave skin and facing out; within keeps to part of it.')
    const seen = await throughOn(frame, throughBand(fit.through, fit.level, 'fit.through'), { tolerance: fit.tolerance, within: withinOf(fit.within, 'fit.within') })
    // A grid widened past the tolerance traces coarser than asked: the
    // pieces follow the trace to its own steps, no closer.
    const f = fit.tolerance !== undefined && fit.tolerance < seen.through.cell ? { ...fit, tolerance: seen.through.cell } : fit
    return { chains: seen.chains, holes: seen.holes, through: seen.through, fit: f, frame, options: fitOptionsOf(f), ...(like ? { like } : {}) }
  }
  if (!rule) return { chains: await chainsOn(plane, frame, fit.level), fit, frame, options: fitOptionsOf(fit), ...(like ? { like } : {}) }
  const sided = await sidedOn(plane, frame, fit.level)
  return { chains: sided.chains, side: sideOf(sided, rule), fit, frame, options: fitOptionsOf(fit), ...(like ? { like } : {}) }
}

/** What a fit to typed points does not take: what reads the scan's cut. */
const NOT_WITH_POINTS = ['chains', 'within', 'skin', 'facing', 'level', 'draftDeg', 'closeGaps', 'like', 'through'] as const

/** A fit's typed points as chains — one list of [u, v], or a list of them
 *  — checked: refused beside what reads the scan's cut, a chain of too few
 *  points, a point twice in a row. A chain whose last point is its first
 *  (within SNAP_MM) is closed on it. Undefined for a fit of the scan. */
export function givenOf(fit: FitIn): GivenChain[] | undefined {
  if (fit.points === undefined) {
    if (fit.closed !== undefined) invalid('fit.closed goes with fit.points: it closes the chains of typed points — a fit of the scan reads which chains close off the cut.')
    return undefined
  }
  const asked = NOT_WITH_POINTS.filter((k) => fit[k] !== undefined)
  if (asked.length > 0) invalid(`fit.points is fitted in place of the scan’s cut, and ${asked.join(', ')} ${asked.length === 1 ? 'reads' : 'read'} the cut — leave ${asked.length === 1 ? 'it' : 'them'} out.${asked.includes('chains') ? ' Several chains of points go in points as a list of lists.' : ''}${asked.includes('closeGaps') ? ' A loop of points takes closed: true.' : ''}`)
  const raw = fit.points as unknown[]
  const isPoint = (p: unknown) => Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === 'number')
  const one = raw.length > 0 && raw.every(isPoint)
  const lists = (one ? [raw] : raw) as unknown[][]
  if (lists.length === 0) invalid('fit.points: give the points, [[u, v], …] mm on the sketch’s sheet — or a list of such chains.') // units-ok: a command's error — the commands take and answer mm
  return lists.map((list, i) => {
    const where = one ? 'fit.points' : `fit.points[${i}]`
    if (!Array.isArray(list) || !list.every(isPoint)) invalid(`${where}: each point is [u, v], mm on the sketch’s sheet — one chain as [[u, v], …], several as [[[u, v], …], …].`) // units-ok: a command's error — the commands take and answer mm
    const pts = (list as Vec2[]).map((p): Vec2 => [p[0], p[1]])
    if (!pts.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))) invalid(`${where}: a point is not a number.`)
    let closed = fit.closed === true
    if (pts.length >= 4 && Math.hypot(pts[pts.length - 1][0] - pts[0][0], pts[pts.length - 1][1] - pts[0][1]) <= SNAP_MM) {
      pts.pop()
      closed = true
    }
    if (pts.length < (closed ? 3 : 2)) invalid(`${where}: ${closed ? 'a loop takes three points at least' : 'a chain takes two points at least'} — it has ${pts.length}.`)
    pts.forEach((p, k) => {
      const q = pts[(k + 1) % pts.length]
      if ((k + 1 < pts.length || closed) && Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-9) invalid(`${where}: points ${k} and ${(k + 1) % pts.length} are one point.`)
    })
    return { points: pts, closed }
  })
}

/** The station a fit asks to be fitted like, its profile read — refused
 *  with the cut's own options, which the station's pieces stand in for. */
function likeOf(fit: FitIn): NonNullable<PreparedFit['like']> {
  if (fit.arcs !== undefined || fit.spline !== undefined) invalid('fit.like takes its pieces from the sketch it names — leave arcs and spline out.')
  const f = sketchNamed(fit.like!)
  const loop = stationLoop(f.sketch, f.name)
  if (typeof loop === 'string') invalid(`fit.like: ${loop}`)
  return { name: f.name, sketch: f.sketch, loop: loop as StationLoop }
}

/** How much over its gap a closeGaps offered to close an open chain is:
 *  the ends the scan's hole left lie a little further apart than the
 *  fitted pieces' do. */
const CLOSE_GAPS_OVER = 1.2

/** A fitted chain left open, as its answer says it: the free ends of its
 *  first and last pieces, the gap between them and — `whole`, the chain
 *  itself open rather than a run a box or a side cut from it, which is
 *  open by asking — the closeGaps to fit it again with, about the gap: a
 *  hole in the scan where the outline should close, bridged by a straight
 *  run (core/chainOutline.ts). */
function openOut(sketch: Sketch, order: readonly { id: number; from: AnchorAt; to: AnchorAt }[], whole: boolean): Pick<FittedOut, 'open'> {
  const first = order.length > 0 ? entityOf(sketch, order[0].id) : undefined
  const last = order.length > 0 ? entityOf(sketch, order[order.length - 1].id) : undefined
  if (!first || !last) return {}
  const a = anchorPoint(first, order[0].from)
  const b = anchorPoint(last, order[order.length - 1].to)
  const gap = Math.hypot(b[0] - a[0], b[1] - a[1])
  const r = (p: Vec2): Vec2 => [round4(p[0]) + 0, round4(p[1]) + 0]
  return { open: { ends: [r(a), r(b)], gap: round4(gap), ...(whole && gap > 0 ? { tryCloseGaps: Math.ceil(gap * CLOSE_GAPS_OVER * 10) / 10 } : {}) } }
}

/** The sketch in hand given the fitted pieces, as Fit all chains gives
 *  them — the chains asked for (by index, the largest, the one round a
 *  point), their ends joined across the gaps closeGaps allows first and
 *  only their runs in the box where within says and on the side skin or
 *  facing asks for, at the options asked for — and what each chain
 *  became. A fit of every chain skips one it
 *  cannot fit and says why; one asked for by name fails the fit. */
export function fitDraft(p: PreparedFit): FittedOut[] {
  return fitDraftShared(p).fitted
}

/** fitDraft, and what the fit shared with the pieces the sketch already
 *  held: on a sketch with pieces, every chain lands on them
 *  (core/shareFit.ts, within fit.share mm) — what lies along one is that
 *  piece's, and only the rest is fitted, as open runs whose ends land on
 *  the pieces they reach. */
export function fitDraftShared(p: PreparedFit): FitDraftOut {
  if (p.given) return fitGiven(p, p.given)
  if (p.chains.length === 0) invalid('The scan is not cut on this plane — there is no chain to fit.')
  const asked = p.fit.chains ?? 'all'
  const joined = p.fit.closeGaps ? joinChainEnds(p.chains, p.fit.closeGaps) : unjoined(p.chains)
  // A point names its chain by one of three rules; the answer says which.
  const at = typeof asked === 'object' && !Array.isArray(asked) ? chainAt(joined, asked.at) : null
  const pickedOut = at ? { pickedBy: at.by, area: round4(at.area), enclosing: at.enclosing } : {}
  let picked: number[]
  if (asked === 'all') picked = joined.map((_, i) => i)
  else if (Array.isArray(asked)) {
    for (const c of asked) if (!p.chains[c]) invalid(`The outline has no chain ${c} — it has ${p.chains.length} (0 to ${p.chains.length - 1}).`)
    picked = [...new Set(asked.map((c) => pickChain(joined, c)))]
  } else picked = [at ? at.index : pickChain(joined, asked)]
  const within = withinOf(p.fit.within, 'fit.within', () => cutSpanWords(p.chains))
  if (within && 'world' in within && !p.frame) invalid('fit.within.world: a box in the world is read on the sketch’s plane, and this fit has none.')
  const boxed = !within ? {} : p.frame ? withinOnSheet(within, p.frame) : { box: within as { min: Vec2; max: Vec2 } }
  const work: { chain: Vec2[]; of: JoinedChain; run?: number }[] = picked.flatMap((i) =>
    within || p.side ? runsKept(joined[i].chain, { ...boxed, side: p.side }).map((chain, run) => ({ chain, of: joined[i], run })) : [{ chain: joined[i].chain, of: joined[i] }],
  )
  if (work.length === 0) {
    // The box alone catching nothing says where the cut is.
    if (within && picked.every((i) => runsKept(joined[i].chain, boxed).length === 0)) invalid(`fit.within: ${boxMissed(within, picked.map((i) => joined[i].chain), p.frame, 'the sketch’s sheet')}`)
    if (p.side) invalid(`No run of the outline lies ${within ? 'in the box (within) and ' : ''}on the side asked (skin, facing) — four points at least. Read the cut with reverse.section.fit and the same skin or facing first.`)
    invalid('No run of the outline lies in the box (within) — four points in it at least. [u, v] are the sketch’s.')
  }
  const levelOut = p.fit.level !== undefined ? { level: p.fit.level } : {}
  const seen = p.through ? { through: p.through } : {}
  if (p.like) return { fitted: [{ ...fitLike(p, work), ...pickedOut, ...levelOut }], ...seen }
  if (p.fit.tolerance !== undefined) re().setSketchTolerance(p.fit.tolerance)
  const share = p.fit.share ?? SHARE_MM
  const chains = work.map((w) => w.chain)
  // What each chain shared, by its index here, over the fits made.
  const report: ShareReport = { chains: {}, shared: [], junctions: [], corners: 0 }
  const keep = () => {
    const r = re().sketchDraft!.shareReport
    if (!r) return
    Object.assign(report.chains, r.chains)
    report.shared.push(...r.shared)
    report.junctions.push(...r.junctions)
    report.corners += r.corners
  }
  if (asked === 'all') {
    re().autoFit(chains, 'all', p.options, share)
    keep()
  } else
    chains.forEach((_, i) => {
      re().autoFit(chains, i, p.options, share)
      keep()
    })
  const d = re().sketchDraft!
  const missing = work.filter((_, i) => !d.fitted[i]).length
  if (d.error && (asked !== 'all' || missing === work.length)) throw new CommandError('failed', `The outline could not be fitted: ${d.error}`)
  // Each chain's place in the answer, and each of its runs' where it was
  // fitted onto the pieces there: what junctions name.
  const fitted: FittedOut[] = []
  const runAt = new Map<string, number>()
  work.forEach((w, i) => {
    const named = {
      chain: w.of.from[0],
      ...(p.holes ? { hole: p.holes[w.of.from[0]] } : {}),
      ...(w.run !== undefined ? { run: w.run } : {}),
      ...(w.of.from.length > 1 ? { joined: w.of.from } : {}),
      ...(w.of.gaps > 0 ? { bridged: { gaps: w.of.gaps, largest: round4(w.of.largest) } } : {}),
      ...pickedOut,
      ...levelOut,
    }
    const runs = report.chains[i]
    if (runs) {
      if (runs.length === 0) fitted.push({ ...named, drawn: true, pieces: [] })
      runs.forEach((r, k) => {
        const reaches = { ...(r.from !== null ? { start: r.from } : {}), ...(r.to !== null ? { end: r.to } : {}) }
        const part = { ...named, part: k, ...(Object.keys(reaches).length > 0 ? { reaches } : {}) }
        if (!r.order) {
          fitted.push({ ...part, points: r.points, skipped: r.skipped })
          return
        }
        runAt.set(`${i}:${k}`, fitted.length)
        const areas = crossing(d.sketch, r.order)
        fitted.push({
          ...part,
          closed: false,
          pieces: r.order.map((o) => ({ id: o.id, kind: entityOf(d.sketch, o.id)?.kind ?? 'gone' })),
          ...(areas ? { crosses: { regions: areas.length, areas }, warning: crossingWords(areas) } : {}),
        })
      })
      return
    }
    const f = d.fitted[i]
    if (!f) {
      fitted.push({ ...named, points: w.chain.length, skipped: whyNot(w.chain, d.tolerance, p.options) })
      return
    }
    const areas = crossing(d.sketch, f.order)
    // A chain fitted as one closed spline is closed by the curve itself.
    const closedSpline = f.order.some((o) => {
      const e = entityOf(d.sketch, o.id)
      return e?.kind === 'spline' && Boolean(e.closed)
    })
    const closed = f.closed || closedSpline
    fitted.push({
      ...named,
      closed,
      pieces: f.order.map((o) => ({ id: o.id, kind: entityOf(d.sketch, o.id)?.kind ?? 'gone' })),
      ...(areas ? { crosses: { regions: areas.length, areas }, warning: crossingWords(areas) } : {}),
      ...(closed ? {} : openOut(d.sketch, f.order, w.run === undefined)),
    })
  })
  if (Object.keys(report.chains).length === 0) return { fitted, ...seen }
  // The shared stretches piece by piece, over every chain.
  const byPiece = new Map<number, { points: number; sum: number; max: number }>()
  for (const x of report.shared) {
    const had = byPiece.get(x.piece) ?? { points: 0, sum: 0, max: 0 }
    byPiece.set(x.piece, { points: had.points + x.points, sum: had.sum + x.offMm.mean * x.points, max: Math.max(had.max, x.offMm.max) })
  }
  const shared = [...byPiece].map(([piece, x]): SharedOut => ({ piece, points: x.points, offMm: { mean: round4(x.sum / x.points), max: round4(x.max) }, level: p.fit.level ?? 0 }))
  const junctions = report.junctions.flatMap((j): JunctionOut[] => {
    const run = runAt.get(`${j.chain}:${j.run}`)
    if (run === undefined) return []
    // Where the end lies once solved.
    const e = entityOf(d.sketch, j.end.entity)
    const solved = e ? anchorPoint(e, j.end.at) : j.at
    return [{ run, end: { piece: j.end.entity, at: j.end.at }, on: j.on, at: [round4(solved[0]), round4(solved[1])], held: j.held, ...(j.collinear ? { collinear: true as const } : {}), ...(j.held !== 'free' ? { constraints: j.constraints } : {}) }]
  })
  return { fitted, shared, ...(junctions.length > 0 ? { junctions } : {}), ...(report.corners > 0 ? { corners: report.corners } : {}), ...seen }
}

/** How many of a chain's typed points the answer gives the miss of, worst
 *  first. */
const DEVIATIONS_LISTED = 20

/** A chain of typed points read on its pieces as they lie in `sketch`: the
 *  most any point misses them by, each point's miss worst first, and
 *  whether they run past the box round the points. */
function givenReading(sketch: Pick<Sketch, 'entities'>, points: readonly Vec2[], ids: readonly number[]): Pick<FittedOut, 'maxDeviation' | 'deviations' | 'overshoot'> {
  const pieces = ids.flatMap((id) => {
    const e = entityOf(sketch, id)
    return e ? [e] : []
  })
  const miss = deviationsAt(pieces, points)
  const deviations = miss.map((mm, point) => ({ point, mm: round4(mm) })).sort((a, b) => b.mm - a.mm || a.point - b.point)
  const past = overshootOf(pieces, points)
  return {
    maxDeviation: deviations[0]?.mm ?? 0,
    deviations: deviations.slice(0, DEVIATIONS_LISTED),
    overshoot: past ? { mm: round4(past.mm), side: past.side, at: [round4(past.at[0]) + 0, round4(past.at[1]) + 0] } : false,
  }
}

/**
 * The sketch in hand given the chains of typed points fitted (fit.points):
 * each as a slice's chain is cut — arcs, spline, detail, alignAxes,
 * joinCorners as asked — then fitted to its points themselves
 * (fitPointsChain, core/pointsFit.ts), an end on the end of a piece the
 * sketch held before within share mm joined to it. No scan is read. A
 * chain that does not fit fails the fit, by its index.
 */
function fitGiven(p: PreparedFit, given: readonly GivenChain[]): FitDraftOut {
  if (p.fit.tolerance !== undefined) re().setSketchTolerance(p.fit.tolerance)
  const sketch = cloneSketch(re().sketchDraft!.sketch)
  const landOn = sketch.entities.map((e) => e.id)
  const share = p.fit.share ?? SHARE_MM
  const fitted: FittedOut[] = []
  const junctions: JunctionOut[] = []
  const reads: NonNullable<FitDraftOut['given']> = []
  given.forEach((g, i) => {
    const made = fitPointsChain(sketch, g.points, g.closed, p.fit.tolerance ?? null, p.options, { landOn, share })
    if (typeof made === 'string') throw new CommandError('failed', `fit.points${given.length > 1 ? `[${i}]` : ''} could not be fitted: ${made}`)
    const ids = made.order.map((o) => o.id)
    for (const l of made.landed) {
      const lines = entityOf(sketch, l.piece)?.kind === 'line' && entityOf(sketch, l.on)?.kind === 'line'
      junctions.push({ run: fitted.length, end: { piece: l.piece, at: l.at }, on: l.on, at: [round4(l.point[0]) + 0, round4(l.point[1]) + 0], held: 'end', ...(l.tangent ? (lines ? { collinear: true as const } : { tangent: true as const }) : {}), constraints: l.constraints })
    }
    reads.push({ fitted: fitted.length, points: g.points, pieces: ids })
    fitted.push({ chain: i, closed: g.closed, points: g.points.length, pieces: ids.map((id) => ({ id, kind: entityOf(sketch, id)?.kind ?? 'gone' })), ...(made.held.length > 0 ? { heldAlong: made.held } : {}) })
  })
  re().setSketch(sketch)
  const d = re().sketchDraft!
  if (d.error) throw new CommandError('failed', `The points could not be fitted: ${d.error}`)
  const out: FitDraftOut = { fitted, ...(junctions.length > 0 ? { junctions } : {}), given: reads }
  givenOut(out, d.sketch)
  return out
}

/** A fit's chains of typed points read again on the sketch as it now lies
 *  — once it is solved for good, the relations given beside the fit and
 *  those accepted held: each chain's misses and overshoot (givenReading),
 *  and its arcs' and circles' radii. Nothing for a fit of the scan. */
export function givenOut(fit: FitDraftOut | undefined, sketch: Pick<Sketch, 'entities'> | undefined): void {
  if (!fit?.given || !sketch) return
  for (const g of fit.given) {
    const f = fit.fitted[g.fitted]
    if (!f) continue
    Object.assign(f, givenReading(sketch, g.points, g.pieces))
    f.pieces = (f.pieces ?? []).map((x) => {
      const e = entityOf(sketch, x.id)
      return e && (e.kind === 'arc' || e.kind === 'circle') ? { ...x, r: round4(e.r) } : x
    })
  }
}

/** The sketch in hand given the scan's run fitted like a station (fit.like,
 *  core/stations.ts): the longest of the runs kept — a fit of one skin
 *  keeps one, and a scrap beside it is not the profile — cut into the
 *  station's pieces in their order, under the station's ids where the
 *  sketch has none yet, its drawn pieces and relations copied. */
function fitLike(p: PreparedFit, work: { chain: Vec2[]; of: JoinedChain; run?: number }[]): FittedOut {
  const like = p.like!
  const w = work.reduce((a, b) => (b.chain.length > a.chain.length ? b : a))
  const made = likeStation(like.sketch, like.loop, w.chain, p.fit.tolerance)
  // What the refusal decided on — the run's ends, what was bridged.
  const facts = () => runFactsWords(like.loop, { run: w.chain, joined: w.of, chains: p.chains, runs: work.length, fit: p.fit })
  if (typeof made === 'string') throw new CommandError('failed', `The run could not be fitted like ${like.name}: ${made}${facts()}`)
  const held = re().sketchDraft!.sketch
  const station = held.entities.length === 0 ? made.sketch : clearOf(held, made.sketch)
  re().setSketch({ entities: [...held.entities, ...station.entities], constraints: [...held.constraints, ...station.constraints], nextId: Math.max(held.nextId, station.nextId) })
  const d = re().sketchDraft!
  if (d.error) throw new CommandError('failed', `The station fitted like ${like.name} does not solve: ${d.error}`)
  // The solve holds the template's tangencies, and can fold a piece the
  // fit left whole — a short floor between two arcs pulled to nothing or
  // run backwards: read again as it lies now.
  const ids = station.entities.map((e) => e.id)
  const folds = stationFaults(like.sketch, like.loop, d.sketch, ids)
  if (folds.length > 0) throw new CommandError('failed', `The station fitted like ${like.name} folds once solved: ${folds.join('; ')} — ${STATION_FOLD_HELP}${facts()}`)
  const areas = crossing(d.sketch, station.entities)
  return {
    chain: w.of.from[0],
    ...(w.run !== undefined ? { run: w.run } : {}),
    ...(w.of.from.length > 1 ? { joined: w.of.from } : {}),
    ...(w.of.gaps > 0 ? { bridged: { gaps: w.of.gaps, largest: round4(w.of.largest) } } : {}),
    closed: like.loop.closed,
    pieces: station.entities.map((e) => ({ id: e.id, kind: e.kind })),
    like: { sketch: like.name, ...(made.reversed ? { reversed: true } : {}), ...(work.length > 1 ? { runs: work.length } : {}) },
    ...(areas ? { crosses: { regions: areas.length, areas }, warning: crossingWords(areas) } : {}),
  }
}

/** A sketch's pieces and relations renumbered from where `held` leaves off,
 *  to go in beside what it holds. */
function clearOf(held: Sketch, add: Sketch): Sketch {
  let next = held.nextId
  const ids = new Map(add.entities.map((e) => [e.id, next++]))
  const entities = add.entities.map((e) => ({ ...e, id: ids.get(e.id)! }))
  const constraints = add.constraints.map((c) => {
    const { id: _id, ...rest } = c
    void _id
    return { ...renumbered(rest as ConstraintInput, (old) => ids.get(old) ?? old), id: next++ } as Constraint
  })
  return { entities, constraints, nextId: next }
}

/** A whole profile moved inward, as a sketch takes it: by mm (outward when
 *  negative), of another sketch's profile in place of this one's, the
 *  pieces to keep where they lie. */
export interface InsetIn {
  by: number
  of?: Ref
  keep?: number[]
}

/** The sketch in hand moved inward, each closed chain on its own
 *  (core/stations.ts insetChains), and solved: what the inset did, for the
 *  answer, and the solve. */
export function insetDraft(inset: InsetIn) {
  const d = re().sketchDraft!
  const own = d.sketch.entities.filter((e) => !e.construction && e.kind !== 'point').map((e) => e.id)
  for (const id of inset.keep ?? []) if (!own.includes(id)) invalid(`inset.keep: the profile has no piece ${id} — it has ${own.join(', ')}.`)
  const given = inset.keep ? new Set(inset.keep) : undefined
  const out = insetChains(d.sketch, { by: inset.by, ...(given ? { keep: () => given } : {}), datums: datumTraces(d.frame), name: d.name })
  if (typeof out === 'string') throw new CommandError('failed', `inset: ${out}`)
  const solve = putSketch(out.sketch)
  return {
    solve,
    inset: {
      by: inset.by,
      moved: out.moved.length,
      kept: out.kept,
      ...(out.chains.length > 1 ? { chains: out.chains.map((c) => c.pieces) } : {}),
      ...(out.open.length > 0 ? { open: out.open } : {}),
      ...(out.dropped.length > 0 ? { dropped: out.dropped } : {}),
    },
  }
}

/** What draftOffsetDraft answers. */
export interface DraftOffsetOut {
  draftDeg: number
  level: number
  /** level·tan(draftDeg): how far the wall lies inside where the taper
   *  starts at the sketch's plane. */
  mm: number
  /** Each chain moved, by its pieces: mm outward (negative: inward). */
  chains?: { pieces: number[]; outMm: number }[]
  open?: number[][]
  dropped?: { id: number; kind: string }[]
  /** Nothing was moved, and why. */
  notMoved?: string
  note: string
}

/**
 * The chains a fit just made moved for the taper it says the extrude will
 * have (fit.draftDeg). A wall cut at fit.level lies level·tan(draftDeg) inside
 * where the taper leaves the sketch's plane, so the outline laid on the plane
 * is that much short: each closed chain goes out by it — a chain inside
 * another, a hole of its region, whose sides lean the other way, in by it —
 * with its slice points, moved with it, so what reads them later reads the
 * same fit. Pieces the sketch had before stay. All or nothing: where a chain
 * cannot move the fit stands as it was, and the answer says why, and the
 * number.
 */
export function draftOffsetDraft(fit: FitIn | undefined, out: FitDraftOut | undefined): { solve?: ReturnType<typeof putSketch>; draftOffset?: DraftOffsetOut } {
  if (fit?.draftDeg === undefined || !out) return {}
  const [draftDeg, level] = [fit.draftDeg, fit.level ?? 0]
  const x = Math.abs(level) * Math.tan((draftDeg * Math.PI) / 180)
  const said = { draftDeg, level, mm: round4(x) }
  // units-ok: the answer's note, for the agent — in millimetres always.
  if (Math.abs(x) < 1e-6) return { draftOffset: { ...said, note: draftDeg === 0 ? 'A draft of 0 leaves the wall where it was cut: nothing moved.' : 'The cut is at the plane (no fit.level), where the taper starts: nothing moved.' } }
  const d = re().sketchDraft!
  const was = d.sketch
  const undone = (why: string): { draftOffset: DraftOffsetOut } => ({
    // units-ok: the answer's note, for the agent — in millimetres always.
    draftOffset: { ...said, notMoved: why, note: `The chains stay as fitted, at the cut: extruded from this plane at draftDeg ${draftDeg} the wall lands ${Math.abs(said.mm)} mm off the scan. Allow for it by hand: draw the chain ${Math.abs(said.mm)} mm ${x > 0 ? 'out' : 'in'}, or cut the scan at the plane instead (no level).` },
  })
  const only = new Set(out.fitted.flatMap((c) => (c.pieces ?? []).map((p) => p.id)))
  if (only.size === 0) return undone('every wall of this level lies along pieces the sketch has (shared): the fit made no piece to move.')
  const moved = insetChains(was, {
    by: (depth) => (depth % 2 === 0 ? -x : x),
    only,
    keep: (loop) => new Set([...insetKeeps(loop, was), ...loop.pieces.filter((p) => p.fitted && !only.has(p.id)).map((p) => p.id)]),
    keepPoints: true,
    datums: datumTraces(d.frame),
    name: d.name,
  })
  if (typeof moved === 'string') return undone(moved)
  let solve: ReturnType<typeof putSketch>
  try {
    solve = putSketch(moved.sketch)
  } catch (e) {
    if (!(e instanceof CommandError)) throw e
    putSketch(was)
    return undone(e.message)
  }
  return {
    solve,
    draftOffset: {
      ...said,
      chains: moved.chains.map((c) => ({ pieces: c.pieces, outMm: round4(-c.by) })),
      ...(moved.open.length > 0 ? { open: moved.open } : {}),
      ...(moved.dropped.length > 0 ? { dropped: moved.dropped } : {}),
      // units-ok: the answer's note, for the agent — in millimetres always.
      note: `Moved for the taper: extrude from this plane with draftDeg ${draftDeg}, toward level ${level}, and the wall passes through the cut made there — off by ${Math.abs(said.mm)} mm otherwise. A chain inside another moved as a hole of its region; to cut it as a pocket, fit it without the chain round it.${moved.open.length > 0 ? ' Open chains (open) stayed: they have no inside to move from.' : ''}`,
    },
  }
}

/** The regions a fitted chain's own pieces close, when more than one: the
 *  chain crosses itself — a fit that cut a corner short, or an outline
 *  folded back on itself — their areas largest first. Null for a chain
 *  that closes one region or none. */
function crossing(sketch: Sketch, order: readonly { id: number }[]): number[] | null {
  const ids = new Set(order.map((o) => o.id))
  const regions = findRegions({ entities: sketch.entities.filter((e) => ids.has(e.id)) })
  return regions.length > 1 ? regions.map((r) => round4(r.area)) : null
}

// units-ok: the commands' refusal, for the agent — in millimetres always.
const crossingWords = (areas: readonly number[]) => `profile crosses itself: 1 chain → ${areas.length} regions (areas ${areas.join(', ')} mm²)`

/** The first fitted chain of the sketch in hand that crosses itself, in
 *  words, or null. */
function crossingOnDraft(): string | null {
  const d = re().sketchDraft!
  for (const f of Object.values(d.fitted)) {
    for (const order of [f.order, ...(f.runs ?? [])]) {
      const areas = crossing(d.sketch, order)
      if (areas) return `${crossingWords(areas)} — the chain of pieces ${order.map((o) => o.id).join(', ')}`
    }
  }
  return null
}

/** Why a chain does not fit, as the cut says it. */
function whyNot(chain: readonly Vec2[], tolerance: number | null, options: FitOptions): string {
  const tol = tolerance !== null ? { tolerance } : {}
  if (options.spline) return `A spline through ${Math.round(options.spline)} points needs twice as many slice points on the chain — it has ${chain.length}.`
  try {
    if (options.arcs) arcsOfChain(chain, options.arcs, tol)
    else segmentChain(chain, { detail: options.detail, ...tol })
    return 'It did not fit.'
  } catch (e) {
    return errorMessage(e)
  }
}

/** The candidates a fit asks to accept, taken on the sketch in hand —
 *  solved already — and the sketch put again; what was accepted and left,
 *  for the answer, the left ones capped (`leftCount` says how many), and
 *  the move limit the trials were held to, and the note where a whole kind
 *  was left for moving. */
export function acceptOnDraft(rule: AcceptRule | undefined) {
  if (!rule) return {}
  // Relations taken on an outline that is not one would hold a wrong
  // shape: the fit is put right first.
  const crossed = crossingOnDraft()
  if (crossed) throw new CommandError('failed', `accept is refused: the ${crossed}. Fit it again so it closes one region — closeGaps, within, a lower detail or a tolerance — or fit without accept and read the fitted pieces first.`)
  const d = re().sketchDraft!
  const sketch = cloneSketch(d.sketch)
  const { accepted, left, maxMoveMm, note } = acceptCandidates(sketch, datumTraces(d.frame), rule)
  const solve = putSketch(sketch)
  const shown = left.filter((l) => l.why !== 'kind').slice(0, ACCEPT_LEFT_SHOWN)
  return { solve, accept: { accepted, left: shown, ...(left.length > shown.length ? { leftCount: left.length } : {}), maxMoveMm, ...(note ? { note } : {}) } }
}

/** How many candidates left an answer lists. */
const ACCEPT_LEFT_SHOWN = 20

/** The input's pieces and relations over what the sketch in hand holds —
 *  as sketch.edit lays new pieces over a sketch. */
export const overDraft = (input: Json): Json => {
  const held = re().sketchDraft!.sketch
  return { ...input, entities: [...held.entities, ...((input.entities as Json[] | undefined) ?? [])], constraints: [...held.constraints, ...((input.constraints as Json[] | undefined) ?? [])] }
}

/** What a sketch asks to have projected, as the input names it. */
export type ProjectIn = { body: Ref; edge: EdgePickIn } | { body: Ref; face: FacePickIn } | { sketch: Ref; pieces?: number[] }

/** A projected piece, as the answer lists it. */
export interface ProjectedOut {
  id: number
  kind: string
  from: string
}

/** The sketch in hand given the pieces projected into it — a body's
 *  edges, a face's outline, another sketch's pieces — as the Project
 *  tool's clicks give them: fixed where they land, each following its
 *  source (project.ts). `at` is where the sketch stands in the feature
 *  list: a sketch further down is not there yet where this one is built,
 *  so its pieces are taken as they lie and follow nothing. */
export function projectDraft(s: ReverseSession, items: readonly ProjectIn[], at: number, exclude?: number): { projected: ProjectedOut[]; skipped: number } {
  const d = re().sketchDraft!
  const frame = d.frame
  const entities: EntityInput[] = []
  const from: string[] = []
  let skipped = 0
  items.forEach((item, i) => {
    const where = `project[${i}]`
    if ('sketch' in item) {
      const f = sketchNamed(item.sketch)
      if (f.id === exclude) invalid(`${where}: a sketch does not project into itself.`)
      const index = re().features.findIndex((x) => x.id === f.id)
      const follow = index >= 0 && index < at
      const pieces = item.pieces
        ? item.pieces.map((id) => {
            const e = entityOf(f.sketch, id)
            if (!e) invalid(`${where}: ${f.name} has no piece ${id}.`)
            return e!
          })
        : f.sketch.entities
      for (const e of pieces) {
        const p = projectSketchEntity(e, f.frame, frame)
        if (!p) {
          skipped++
          continue
        }
        entities.push(follow ? { ...p, source: { sketch: f.id, entity: e.id } } : p)
        from.push(`piece ${e.id} of ${f.name}`)
      }
      return
    }
    const body = bodyNamed(item.body)
    if ('face' in item) {
      const face = facePicked(s, body, item.face)
      const edges = topologyOf(s, body).edges.filter((e) => e.faces.includes(face.hash))
      if (edges.length === 0) invalid(`${where}: that face of ${body.name} has no edges to project — pick it by its index in reverse.body.describe.`)
      const made = projectFaceOutline(edges, frame, body.id)
      skipped += made.skipped
      for (const e of made.entities) {
        entities.push(e)
        from.push(`the outline of a face of ${body.name}`)
      }
      return
    }
    for (const e of edgesPicked(s, body, [item.edge])) {
      const p = e.hash >= 0 ? projectEdge(e, frame) : null
      if (!p) {
        skipped++
        continue
      }
      entities.push({ ...p, source: { body: body.id, edge: e.fingerprint } })
      from.push(`an edge of ${body.name}`)
    }
  })
  if (entities.length === 0) invalid(`Nothing projects onto this plane${skipped > 0 ? ` — ${skipped} piece${skipped === 1 ? ' lies' : 's lie'} at a slant to it or end on` : ''}.`)
  const before = new Set(d.sketch.entities.map((e) => e.id))
  re().projectInto(entities)
  const now = re().sketchDraft!.sketch.entities.filter((e) => !before.has(e.id))
  return { projected: now.map((e, i) => ({ id: e.id, kind: e.kind, from: from[i] ?? 'the part' })), skipped }
}

/** What reverse.sketch.edit's set gives each kind of piece; a spline's fit
 *  points besides, by the names its anchors go by. */
const SET_FIELDS: Record<SketchEntity['kind'], readonly string[]> = { line: ['a', 'b'], arc: ['c', 'r', 'start', 'sweep', 'a', 'b'], circle: ['c', 'r'], spline: ['pts'], point: ['p'] }

/** The fields set takes for a piece. */
const setFieldsOf = (e: SketchEntity): string[] => (e.kind === 'spline' ? [...SET_FIELDS.spline, ...anchorsOf(e)] : [...SET_FIELDS[e.kind]])

/** What a set moved: the pieces, those it took off their slice points, the
 *  places it put them (what the solve pulls towards) and the radii asked of
 *  circles, which no anchor says. */
export interface PiecesSet {
  pieces: number[]
  detached: number[]
  pull: Pull[]
  radii: { piece: number; r: number }[]
}

/** An arc through new ends, counter-clockwise from `a` to `b` as it ran: with
 *  the sweep it has, or, at a radius given, its bulge the same way round. A
 *  reason where it cannot be. */
function arcWithEnds(e: SketchArc, a: Vec2, b: Vec2, radius: number | undefined): SketchArc | string {
  const d: Vec2 = [b[0] - a[0], b[1] - a[1]]
  const chord = Math.hypot(d[0], d[1])
  if (!(chord > 1e-9)) return 'its ends are one point'
  if (radius !== undefined && chord > 2 * radius + 1e-9) return `its ends lie ${round4(chord)} mm apart, too far for a radius of ${radius} mm` // units-ok: a command's error — the commands take and answer mm
  if (radius === undefined && e.sweep > 2 * Math.PI - 1e-6) return 'it is a full turn, with no ends to give — give c and r'
  const half = radius === undefined ? e.sweep / 2 : e.sweep > Math.PI ? Math.PI - Math.asin(Math.min(1, chord / (2 * radius))) : Math.asin(Math.min(1, chord / (2 * radius)))
  const r = radius ?? chord / (2 * Math.sin(half))
  // The centre lies left of a to b for under half a turn, right of it past.
  const h = r * Math.cos(half)
  const c: Vec2 = [(a[0] + b[0]) / 2 - (d[1] / chord) * h, (a[1] + b[1]) / 2 + (d[0] / chord) * h]
  return { ...e, c, r, start: Math.atan2(a[1] - c[1], a[0] - c[0]), sweep: 2 * half }
}

/** A piece with the fields of a set, and the anchors they put somewhere. */
function pieceSet(e: SketchEntity, given: Json, where: string): { next: SketchEntity; at: AnchorAt[] } {
  const pointOf = (k: string): Vec2 => {
    const p = given[k]
    if (!Array.isArray(p) || p.length !== 2 || !p.every((v) => typeof v === 'number' && Number.isFinite(v))) invalid(`${where}.${k}: expected [u, v], mm.`) // units-ok: a command's error — the commands take and answer mm
    return [(p as number[])[0], (p as number[])[1]]
  }
  const numberOf = (k: string): number => {
    const v = given[k]
    if (typeof v !== 'number' || !Number.isFinite(v)) invalid(`${where}.${k}: expected a number.`)
    return v as number
  }
  const radiusOf = (): number | undefined => {
    if (given.r === undefined) return undefined
    const r = numberOf('r')
    if (!(r > 0)) invalid(`${where}.r: a radius is above zero.`)
    return r
  }
  switch (e.kind) {
    case 'line': {
      const next = { ...e, ...(given.a !== undefined ? { a: pointOf('a') } : {}), ...(given.b !== undefined ? { b: pointOf('b') } : {}) }
      if (Math.hypot(next.b[0] - next.a[0], next.b[1] - next.a[1]) < 1e-9) invalid(`${where}: its ends would be one point.`)
      return { next, at: (['a', 'b'] as const).filter((k) => given[k] !== undefined) }
    }
    case 'circle':
      return { next: { ...e, ...(given.c !== undefined ? { c: pointOf('c') } : {}), r: radiusOf() ?? e.r }, at: given.c !== undefined ? ['center'] : [] }
    case 'point':
      return { next: { ...e, p: pointOf('p') }, at: ['center'] }
    case 'arc': {
      if (given.a !== undefined || given.b !== undefined) {
        const mixed = ['c', 'start', 'sweep'].filter((k) => given[k] !== undefined)
        if (mixed.length > 0) invalid(`${where}: give an arc its ends (a, b, r if you like) or its circle (c, r, start, sweep) — not ${mixed.join(', ')} with its ends.`)
        const arc = arcWithEnds(e, given.a !== undefined ? pointOf('a') : anchorPoint(e, 'a'), given.b !== undefined ? pointOf('b') : anchorPoint(e, 'b'), radiusOf())
        if (typeof arc === 'string') return invalid(`${where}: ${arc}.`)
        return { next: arc, at: ['a', 'b', 'center'] }
      }
      const sweep = given.sweep !== undefined ? numberOf('sweep') : e.sweep
      if (!(sweep > 0 && sweep <= 2 * Math.PI + 1e-9)) invalid(`${where}.sweep: radians counter-clockwise, above zero, a full turn at most.`)
      return { next: { ...e, ...(given.c !== undefined ? { c: pointOf('c') } : {}), r: radiusOf() ?? e.r, start: given.start !== undefined ? numberOf('start') : e.start, sweep }, at: ['a', 'b', 'center'] }
    }
    case 'spline': {
      if (given.pts !== undefined) {
        const named = Object.keys(given).filter((k) => k !== 'pts')
        if (named.length > 0) invalid(`${where}: give pts, the whole list, or fit points by name — not ${named.join(', ')} with pts.`)
        if (!Array.isArray(given.pts) || !given.pts.every((p) => Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === 'number' && Number.isFinite(v)))) invalid(`${where}.pts: expected a list of [u, v], mm.`) // units-ok: a command's error — the commands take and answer mm
        const next = { ...e, pts: (given.pts as Vec2[]).map((p): Vec2 => [p[0], p[1]]) }
        return { next, at: anchorsOf(next) }
      }
      const at = Object.keys(given) as AnchorAt[]
      const pts = e.pts.map((q): Vec2 => [q[0], q[1]])
      for (const name of at) pts[splinePointIndex(e, name)!] = pointOf(name)
      return { next: { ...e, pts }, at }
    }
  }
}

/** The pieces of a sketch moved where reverse.sketch.edit's set puts them,
 *  by id, each keeping its id and every relation on it. A fitted piece lets
 *  its slice points go, as one dragged does: left on it, they would pull it
 *  back. A projected piece follows what it was taken from, and is refused. */
export function setPieces(sketch: Sketch, set: Record<string, Json>, name: string): PiecesSet {
  const done: PiecesSet = { pieces: [], detached: [], pull: [], radii: [] }
  for (const [key, given] of Object.entries(set)) {
    const where = `set.${key}`
    const id = Number(key)
    const e = Number.isInteger(id) ? entityOf(sketch, id) : undefined
    if (!e) throw new CommandError('not_found', `${name} has no piece ${key}.`)
    if (given === null || typeof given !== 'object' || Array.isArray(given)) invalid(`${where}: expected the fields to change — ${aPiece(e.kind)} has ${setFieldsOf(e).join(', ')}.`)
    if (Object.keys(given).length === 0) invalid(`${where}: nothing to change — ${aPiece(e.kind)} has ${setFieldsOf(e).join(', ')}.`)
    if (e.projected) throw new CommandError('invalid_state', `${where}: piece ${id} is projected and follows what it was taken from. Move that, or take it out (remove) and draw a piece of your own.`)
    for (const k of Object.keys(given)) if (!setFieldsOf(e).includes(k)) invalid(`${where}.${k}: not a known field — ${aPiece(e.kind)} has ${setFieldsOf(e).join(', ')}.`)
    const { next, at } = pieceSet(e, given, where)
    if (sameGeometry(e, next)) continue
    const moved = detached(next)
    sketch.entities = sketch.entities.map((x) => (x.id === id ? moved : x))
    done.pieces.push(id)
    if ('points' in e && e.points && e.points.length > 0) done.detached.push(id)
    for (const a of at) done.pull.push({ anchor: { entity: id, at: a }, to: anchorPoint(moved, a) })
    if (moved.kind === 'circle' && given.r !== undefined) done.radii.push({ piece: id, r: moved.r })
  }
  return done
}

/** What a set answers: the pieces moved and those let off their slice points,
 *  and where the solve left one short of where it was put, with why. */
export function piecesSetOut(done: PiecesSet, sketch: Sketch | undefined) {
  const left = (id: number) => (sketch ? entityOf(sketch, id) : undefined)
  const short = [
    ...done.pull.flatMap(({ anchor, to }) => {
      const e = left(anchor.entity)
      const p = e ? anchorPoint(e, anchor.at) : to
      const mm = Math.hypot(p[0] - to[0], p[1] - to[1])
      return mm > TOUCH_MM ? [{ piece: anchor.entity, at: anchor.at as string, mm: round4(mm) }] : []
    }),
    ...done.radii.flatMap(({ piece, r }) => {
      const e = left(piece)
      const mm = e?.kind === 'circle' ? Math.abs(e.r - r) : 0
      return mm > TOUCH_MM ? [{ piece, at: 'r', mm: round4(mm) }] : []
    }),
  ]
  return {
    pieces: done.pieces,
    ...(done.detached.length > 0 ? { detached: done.detached } : {}),
    // units-ok: the answer's warning, for the agent — in millimetres always.
    ...(short.length > 0 ? { short, shortSay: 'The solve left these short of where set put them, mm: a relation or a dimension on them holds them, or a fitted neighbour. reverse.feature.list { feature } gives the sketch.' } : {}),
  }
}

/** The pieces that moved between two states of a sketch, the farthest
 *  first — what an edit cost the fit, in millimetres. `{ count: 0 }` when
 *  none did: said, so that nothing moved reads as an answer. A piece new
 *  since `was` is measured from `fitted`, the sketch as the same call's fit
 *  left it, when it was fitted then. `radii` names each arc or circle whose
 *  radius changed, was and now. */
export function movedPieces(was: Sketch, now: Sketch, fitted?: Sketch): { count: number; pieces?: { id: number; mm: number }[]; radii?: { id: number; was: number; now: number }[] } {
  const out: { id: number; mm: number }[] = []
  // An arc's or circle's radius the edit changed, apart: a tangency held on
  // a rounded drawing value took an R1 to 0.989 on the last part, read as
  // 11 µm of travel.
  const radii: { id: number; was: number; now: number }[] = []
  for (const e of now.entities) {
    const w = was.entities.find((x) => x.id === e.id) ?? fitted?.entities.find((x) => x.id === e.id)
    if (!w || w.kind !== e.kind) continue
    const mm = retakeMoved(w, e)
    if (Number.isFinite(mm) && mm > 1e-4) out.push({ id: e.id, mm: round4(mm) })
    if ((w.kind === 'arc' || w.kind === 'circle') && (e.kind === 'arc' || e.kind === 'circle') && Math.abs(w.r - e.r) > RADIUS_CHANGED_MM) radii.push({ id: e.id, was: round4(w.r), now: round4(e.r) })
  }
  if (out.length + radii.length === 0) return { count: 0 }
  out.sort((a, b) => b.mm - a.mm)
  radii.sort((a, b) => Math.abs(b.now - b.was) - Math.abs(a.now - a.was))
  return { count: out.length, pieces: out.slice(0, 20), ...(radii.length > 0 ? { radii: radii.slice(0, 20) } : {}) }
}

/** A radius change under this, mm, is the solver's noise, not news. */
const RADIUS_CHANGED_MM = 5e-4

/** The pieces whose own curve an edit moved past `limit` mm — what the
 *  relations or rounds added pulled, a fit's tangencies 5.9 mm on the last
 *  fan with the sketch's answer reading on — with what to do; null with none.
 *  Trimmed back along itself, a piece has not moved (curveMoved). */
export function movedFar(was: Sketch, now: Sketch, fitted: Sketch | undefined, limit: number): { pieces: { id: number; offCurveMm: number }[]; say: string } | null {
  const pieces = now.entities.flatMap((e) => {
    const w = was.entities.find((x) => x.id === e.id) ?? fitted?.entities.find((x) => x.id === e.id)
    if (!w || w.kind !== e.kind) return []
    const mm = curveMoved(w, e)
    return Number.isFinite(mm) && mm > limit ? [{ id: e.id, offCurveMm: round4(mm) }] : []
  })
  if (pieces.length === 0) return null
  pieces.sort((a, b) => b.offCurveMm - a.offCurveMm)
  // units-ok: the answer's warning, for the agent — in millimetres always.
  return { pieces: pieces.slice(0, 20), say: `${pieces.length === 1 ? 'A piece' : `${pieces.length} pieces`} came more than ${limit} mm off ${pieces.length === 1 ? 'its' : 'their'} own line or circle (offCurveMm; moved, beside it, counts the ends' travel too): what this edit added pulled ${pieces.length === 1 ? 'it' : 'them'}. Look before building on it; history.undo takes it back.` }
}

/** An anchor held on a piece's line or circle past the piece's end, as the
 *  answer gives it: the relation, the anchor, the piece and how far past
 *  its end, mm. */
export interface OffPiece {
  constraint: number
  piece: number
  at: string
  on: number
  mm: number
}

/** The pointOns of a sketch whose anchor lies past the end of the line or
 *  arc it is held on by more than SNAP_MM — a T-junction come apart: the
 *  end slid off the piece onto the line it runs on, and the regions lose
 *  the junction. */
export function offPieceOf(sketch: Sketch): OffPiece[] {
  const out: OffPiece[] = []
  for (const c of sketch.constraints) {
    if (c.kind !== 'pointOn' || 'datum' in c.on) continue
    const mm = pastPiece(sketch, c)
    if (mm !== null && mm > SNAP_MM) out.push({ constraint: c.id, piece: c.p.entity, at: c.p.at, on: 'line' in c.on ? c.on.line : c.on.curve, mm: round4(mm) })
  }
  return out
}

/** offPiece for an answer, left out where no end lies past its piece. */
export function offPieceOut(sketch: Sketch | undefined): { offPiece?: OffPiece[] } {
  const off = sketch ? offPieceOf(sketch) : []
  return off.length > 0 ? { offPiece: off } : {}
}

/** The highest id a sketch handed in names itself — a piece's, a
 *  relation's, or the last a shape given an id takes — 0 for none: what the
 *  pieces put in before it (a face's outline) are kept clear of. */
export function namedIds(input: Json, frame: SectionFrame): number {
  let top = 0
  for (const x of [...((input.entities as Json[] | undefined) ?? []), ...((input.constraints as Json[] | undefined) ?? [])]) if (typeof x.id === 'number') top = Math.max(top, x.id)
  for (const sh of (input.shapes as Json[] | undefined) ?? []) {
    if (typeof sh.id !== 'number') continue
    const scratch = emptySketch()
    try {
      drawShape(scratch, polylineClosing(onSheet(sh, frame, 'shape')).sh, 'shape')
    } catch {
      // A shape that does not draw is refused where the sketch is made.
      continue
    }
    top = Math.max(top, sh.id + scratch.entities.length - 1)
  }
  return top
}

/**
 * The new pieces of an edit given an id a relation or a dimension of the
 * sketch has — pieces and relations share one run of ids, and a count of
 * the pieces alone lands on one — each given a free id, and what the same
 * add names by the old id (its constraints, its patterns, its rounds) moved
 * to the new: the old id names no piece of the sketch, so it can only mean
 * the new one. A new piece on an id a piece of the sketch has stays refused
 * (sketchOf), as do two new pieces on one id. `renumbered` maps old to new.
 */
export function renumberClashes<R extends { a: number; b: number }>(add: Json, held: Sketch, frame: SectionFrame, rounds: R[] | undefined): { add: Json; rounds: R[] | undefined; renumbered: Record<string, number> } {
  const listed = (add.entities as Json[] | undefined) ?? []
  const relations = new Set(held.constraints.map((c) => c.id))
  const pieces = new Set(held.entities.map((e) => e.id))
  const given = new Set(((add.constraints as Json[] | undefined) ?? []).flatMap((c) => (typeof c.id === 'number' ? [c.id] : [])))
  const clashing = [...new Set(listed.flatMap((e) => (typeof e.id === 'number' && relations.has(e.id) && !pieces.has(e.id) && !given.has(e.id) ? [e.id] : [])))].filter((id) => listed.filter((e) => e.id === id).length === 1)
  if (clashing.length === 0) return { add, rounds, renumbered: {} }
  let next = Math.max(held.nextId, namedIds(add, frame) + 1, ...held.entities.map((e) => e.id + 1), ...held.constraints.map((c) => c.id + 1))
  const map = new Map(clashing.map((id) => [id, next++]))
  const to = (id: number) => map.get(id) ?? id
  const out: Json = {
    ...add,
    entities: listed.map((e) => (typeof e.id === 'number' && map.has(e.id) ? { ...e, id: map.get(e.id) } : e)),
    ...(add.constraints ? { constraints: (add.constraints as Json[]).map((c) => renumbered(c as unknown as ConstraintInput, to) as unknown as Json) } : {}),
    ...(add.patterns ? { patterns: (add.patterns as Json[]).map((p) => (Array.isArray(p.pieces) ? { ...p, pieces: (p.pieces as number[]).map(to) } : p)) } : {}),
  }
  return { add: out, rounds: rounds?.map((r) => ({ ...r, a: to(r.a), b: to(r.b) })), renumbered: Object.fromEntries([...map].map(([old, now]) => [String(old), now])) }
}

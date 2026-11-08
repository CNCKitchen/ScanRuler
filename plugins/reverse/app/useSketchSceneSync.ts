// SPDX-License-Identifier: AGPL-3.0-only
// The sketch editor draws on the 2D Measure sheet — the same FlatScene, with
// its navigation, its grid, its edge overlay and its fat lines — laid with
// the slice chains of the sketch plane and the sketch's pieces over them.
// The store holds the draft; these effects repeat it to the sheet, one
// layer per concern, the way useFlatSceneSync does for the 2D workspace.
// The cursor stays out of the store: a drawing tool rubber-bands to it many
// times a second, and only the sheet needs to know where it is.

import { useEffect, useRef, type MutableRefObject } from 'react'
import type { FlatFit, Vec2 } from '../../../src/core/flat/types'
import { len2, normalize2, sub2 } from '../../../src/core/flat/vec2'
import { anchorPoint, anchorsOf, constraintEntities, entityOf, fixedEntityOf, fixedPieces, fixId, isDimension, lineDir, type Anchor, type Constraint, type Sketch, type SketchEntity } from '../core/sketch'
import { datumName, datumTraces, traceSegment, type DatumPlane } from '../core/datums'
import { piecesInBox } from '../core/boxSelect'
import { dimPlaceAt, dimShape } from '../core/dimLayout'
import { arcAbout, circleFrom, DEFAULT_DRAW_MODES, rectangleCorners, tangentArc, type DrawModes } from '../core/draw'
import { splineCurve } from '../core/sketchSpline'
import { patternPieces, polygonCorners, sketchBounds, type SketchPatternSpec } from '../core/sketch'
import { projectableAt, type Projectable } from '../core/project'
import { snapSketchPoint, type SnapContext, type SnapKind } from '../core/snap'
import { usePrefs } from '../../../src/state/prefsStore'
import { useRePrefs } from '../state/rePrefs'
import { arcThrough, chainArcStart, dragHandleAt, sketchHoverAt, splineClosesAt, useReverse, type SketchHover } from '../state/reStore'
import type { FlatScene, SketchDimensionItem } from '../../../src/viewer/FlatScene'
import { SKETCH_DOT, SKETCH_LINE, sketchPalette } from '../viewer/sketchPalette'
import { dimensionFieldText, dimensionText } from '../viewer/sketchDimText'
import type { SketchChains } from './useReverseWorkspace'
import { pieceNear, pulledDimension } from '../state/reSketchDraft'
import { trimPlan } from '../core/trim'

/** How the pieces are coloured — fitted to the slice, drawn free, brought
 *  in, for construction only, selected — on the instrument as it is lit. */
const colors = () => sketchPalette(usePrefs.getState().dark)

/** A piece as the sheet draws it. */
function entityFit(e: SketchEntity): FlatFit {
  switch (e.kind) {
    case 'line': {
      const d = lineDir(e) ?? [1, 0]
      return { kind: 'line', center: [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2], dir: d, length: len2(sub2(e.b, e.a)), sigma: 0, usedPoints: 0 }
    }
    case 'arc':
      return { kind: 'arc', center: e.c, radius: e.r, start: e.start, sweep: e.sweep, sigma: 0, usedPoints: 0 }
    case 'circle':
      return { kind: 'circle', center: e.c, radius: e.r, sigma: 0, usedPoints: 0 }
    case 'spline':
      return splineCurve(e)
    case 'point':
      return { kind: 'point', at: e.p, sigma: 0, usedPoints: 0 }
  }
}

/** The ends a relation or a dimension holds — what is lit as points while
 *  its glyph or its number is pointed at. */
function constraintAnchors(c: Constraint): Anchor[] {
  switch (c.kind) {
    case 'coincident':
    case 'symmetric':
      return [c.p, c.q]
    case 'distance':
      return 'entity' in c.q ? [c.p, c.q] : [c.p]
    case 'pointOn':
      return [c.p]
    default:
      return []
  }
}

/** The coordinate plane a relation or a dimension holds to, if one. */
function constraintDatum(c: Constraint): DatumPlane | null {
  if (c.kind === 'distance' && 'datum' in c.q) return c.q.datum
  if ((c.kind === 'pointOn' || c.kind === 'collinear') && 'datum' in c.on) return c.on.datum
  if (c.kind === 'symmetric' && typeof c.about === 'object' && 'datum' in c.about) return c.about.datum
  return null
}

/** A line between two sheet points as a fit, or null when they coincide. */
function lineFit(a: Vec2, b: Vec2): FlatFit | null {
  const d = normalize2(sub2(b, a))
  if (!d) return null
  return { kind: 'line', center: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], dir: d, length: len2(sub2(b, a)), sigma: 0, usedPoints: 0 }
}

/**
 * What a drawing tool is about to make, rubber-banded from the points it
 * has to the cursor, in the way it is drawn (see DrawModes): a line from its
 * first end, the whole rectangle from its first corner or its centre, a
 * turned rectangle's first side and then the whole of it, the circle about
 * its centre or through its points, an arc's chord or radius and then the
 * arc — the way Fusion and Onshape show the shape before the click that
 * fixes it. Empty with nothing to show yet.
 */
function toolPreview(tool: string, pending: readonly Vec2[], cursor: Vec2, modes: DrawModes = DEFAULT_DRAW_MODES, sides = 6): FlatFit[] {
  const p = pending
  const line = (a: Vec2, b: Vec2): FlatFit[] => {
    const l = lineFit(a, b)
    return l ? [l] : []
  }
  const loop = (corners: Vec2[] | null): FlatFit[] => (corners ? corners.flatMap((c, i) => line(c, corners[(i + 1) % corners.length])) : [])
  const circle = (c: { c: Vec2; r: number } | null): FlatFit[] => (c ? [{ kind: 'circle', center: c.c, radius: c.r, sigma: 0, usedPoints: 0 }] : [])
  const arcFit = (a: { c: Vec2; r: number; start: number; sweep: number } | null): FlatFit[] => (a ? [{ kind: 'arc', center: a.c, radius: a.r, start: a.start, sweep: a.sweep, sigma: 0, usedPoints: 0 }] : [])
  if (tool === 'line' && p.length === 1) return line(p[0], cursor)
  if (tool === 'rectangle') {
    if (modes.rectangle === 'threePoint') {
      if (p.length === 1) return line(p[0], cursor)
      const turned = p.length === 2 ? rectangleCorners('threePoint', [p[0], p[1], cursor]) : null
      if (p.length === 2) return turned ? loop(turned) : line(p[0], p[1])
      return []
    }
    if (p.length !== 1) return []
    const corners = rectangleCorners(modes.rectangle, [p[0], cursor])
    // About its centre, the diagonals it carries are drawn too.
    return [...loop(corners), ...(corners && modes.rectangle === 'center' ? [...line(corners[0], corners[2]), ...line(corners[1], corners[3])] : [])]
  }
  if (tool === 'polygon') {
    if (p.length !== 1) return []
    // The polygon and the circle it is drawn about.
    return [...loop(polygonCorners(p[0], cursor, sides, modes.polygon)), ...circle({ c: p[0], r: len2(sub2(cursor, p[0])) })]
  }
  if (tool === 'circle') {
    if (modes.circle === 'threePoint') {
      if (p.length === 1) return line(p[0], cursor)
      const through = p.length === 2 ? circleFrom('threePoint', [p[0], p[1], cursor]) : null
      if (p.length === 2) return through ? circle(through) : line(p[0], p[1])
      return []
    }
    return p.length === 1 ? [...circle(circleFrom(modes.circle, [p[0], cursor])), ...(modes.circle === 'twoPoint' ? line(p[0], cursor) : [])] : []
  }
  if (tool === 'arc') {
    if (modes.arc === 'center') {
      // The radius to the start, then the arc from it round to the cursor.
      if (p.length === 1) return line(p[0], cursor)
      if (p.length === 2) return [...line(p[0], p[1]), ...arcFit(arcAbout(p[0], p[1], cursor))]
      return []
    }
    if (p.length === 1) return line(p[0], cursor)
    if (p.length === 2) {
      const arc = arcThrough(p[0], p[1], cursor)
      return arc ? arcFit(arc) : line(p[0], p[1])
    }
  }
  if (tool === 'spline' && p.length > 0) {
    // The curve through the points so far and on to the cursor — closing
    // round to the first point when the cursor is on it.
    const closing = p.length >= 3 && len2(sub2(cursor, p[0])) < 1e-9
    const pts = closing ? [...p] : [...p, cursor].filter((q, i, all) => i === 0 || len2(sub2(q, all[i - 1])) > 1e-9)
    return pts.length >= 2 ? [splineCurve({ pts, closed: closing })] : []
  }
  return []
}

/** The copies a sketch pattern would make of the pieces given, as the
 *  sheet draws a shape in hand — at most a few hundred, which is past what
 *  reads on a sheet anyway. */
export function patternPreview(sketch: Sketch, ids: readonly number[], spec: SketchPatternSpec): FlatFit[] {
  const set = new Set(ids)
  const trial: Sketch = { entities: sketch.entities.filter((e) => set.has(e.id)).map((e) => ({ ...e })), constraints: [], nextId: sketch.nextId }
  const capped = spec.kind === 'rectangular' ? { ...spec, count: Math.min(spec.count, 50), count2: Math.min(spec.count2 ?? 1, 50) } : { ...spec, count: Math.min(spec.count, 360) }
  patternPieces(trial, ids, capped)
  return trial.entities.filter((e) => e.id >= sketch.nextId && e.kind !== 'point').map(entityFit)
}

/** The mark drawn where the cursor will land: a cross on an end it snaps
 *  to, an upright cross on the origin, a triangle on the middle of a line,
 *  a diamond on a slice point, a tick on a piece, a small square on the
 *  grid — so the hand knows what it is about to take before it clicks. */
function snapMark(kind: SnapKind, at: Vec2, s: number): FlatFit[] {
  const [x, y] = at
  const seg = (a: Vec2, b: Vec2) => lineFit(a, b)
  const shapes: (FlatFit | null)[] =
    kind === 'anchor'
      ? [seg([x - s, y - s], [x + s, y + s]), seg([x - s, y + s], [x + s, y - s])]
      : kind === 'origin'
        ? [seg([x - s * 1.4, y], [x + s * 1.4, y]), seg([x, y - s * 1.4], [x, y + s * 1.4])]
      : kind === 'midpoint'
        ? [seg([x - s, y - s * 0.7], [x + s, y - s * 0.7]), seg([x + s, y - s * 0.7], [x, y + s]), seg([x, y + s], [x - s, y - s * 0.7])]
      : kind === 'quadrant'
        ? [{ kind: 'circle', center: at, radius: s * 0.8, sigma: 0, usedPoints: 0 }, seg([x - s * 0.8, y], [x + s * 0.8, y]), seg([x, y - s * 0.8], [x, y + s * 0.8])]
      : kind === 'track'
        ? [seg([x - s, y - s], [x + s, y + s]), seg([x - s, y + s], [x + s, y - s]), { kind: 'circle', center: at, radius: s * 0.5, sigma: 0, usedPoints: 0 }]
      : kind === 'edge'
        ? [seg([x - s, y], [x, y + s]), seg([x, y + s], [x + s, y]), seg([x + s, y], [x, y - s]), seg([x, y - s], [x - s, y])]
        : kind === 'entity' || kind === 'datum'
          ? [seg([x - s, y], [x + s, y])]
          : [seg([x - s, y - s], [x + s, y - s]), seg([x + s, y - s], [x + s, y + s]), seg([x + s, y + s], [x - s, y + s]), seg([x - s, y + s], [x - s, y - s])]
  return shapes.filter((f): f is FlatFit => f !== null)
}

/** The tools whose clicks place points, and so track from points the
 *  cursor passed over (snap.ts trackingSnap). */
const TRACKING_TOOLS = new Set(['line', 'rectangle', 'polygon', 'circle', 'arc', 'spline', 'point'])

const GLYPHS: Partial<Record<Constraint['kind'], string>> = {
  coincident: '•',
  horizontal: 'H',
  vertical: 'V',
  parallel: '∥',
  perpendicular: '⊥',
  tangent: '◠',
  concentric: '◎',
  equal: '=',
  symmetric: '⋈',
  pointOn: '•',
  collinear: '≡',
}

/** A relation's name, shown beside its glyph under the cursor. */
const relationName = (kind: Constraint['kind']) => (kind === 'pointOn' ? 'Point on' : kind === 'collinear' ? 'Collinear' : kind[0].toUpperCase() + kind.slice(1))

/** Where a relation's glyph sits. */
function glyphSpot(c: Constraint, sketch: Sketch): Vec2 | null {
  const mid = (e: SketchEntity): Vec2 => {
    if (e.kind === 'line') return [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2]
    if (e.kind === 'arc') return anchorPoint({ ...e, start: e.start + e.sweep / 2 }, 'a')
    if (e.kind === 'circle') return [e.c[0], e.c[1] + e.r]
    if (e.kind === 'spline') return anchorPoint(e, 'center')
    return e.p
  }
  switch (c.kind) {
    case 'coincident':
    case 'pointOn': {
      const e = entityOf(sketch, c.p.entity)
      return e ? anchorPoint(e, c.p.at) : null
    }
    case 'collinear': {
      const e = entityOf(sketch, c.line)
      return e ? mid(e) : null
    }
    case 'symmetric': {
      const p = entityOf(sketch, c.p.entity)
      const q = entityOf(sketch, c.q.entity)
      if (!p || !q) return null
      const a = anchorPoint(p, c.p.at)
      const b = anchorPoint(q, c.q.at)
      return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    }
    case 'horizontal':
    case 'vertical': {
      const e = entityOf(sketch, c.entity)
      return e ? mid(e) : null
    }
    case 'tangent': {
      // At the point the two touch: the coincidence they share, if any.
      const shared = sketch.constraints.find(
        (x) => x.kind === 'coincident' && [x.p.entity, x.q.entity].includes(c.a) && [x.p.entity, x.q.entity].includes(c.b),
      )
      if (shared && shared.kind === 'coincident') {
        const e = entityOf(sketch, shared.p.entity)
        if (e) return anchorPoint(e, shared.p.at)
      }
      const e = entityOf(sketch, c.a)
      return e ? mid(e) : null
    }
    case 'parallel':
    case 'perpendicular':
    case 'concentric':
    case 'equal': {
      const e = entityOf(sketch, c.a)
      return e ? mid(e) : null
    }
    default:
      return null
  }
}

/** A Fix's glyph — an anchor, drawn as text — and where it sits: a third of
 *  the way along a line, clear of the H or V at its middle; at a round
 *  piece's centre; on a point. */
const FIX_GLYPH = '⚓︎'
function fixSpot(e: SketchEntity): Vec2 {
  if (e.kind === 'line') return [e.a[0] + (e.b[0] - e.a[0]) / 3, e.a[1] + (e.b[1] - e.a[1]) / 3]
  if (e.kind === 'arc' || e.kind === 'circle') return e.c
  if (e.kind === 'spline') return anchorPoint(e, 'center')
  return e.p
}

export function useSketchSceneSync({
  sceneRef,
  chainsOf,
  projectablesOf,
  onView,
}: {
  sceneRef: MutableRefObject<FlatScene | null>
  chainsOf: () => SketchChains | null
  /** What the Project tool can bring in, as pieces on the draft's plane. */
  projectablesOf: () => Projectable[]
  /** The sheet's view, for the 3D viewport underneath to take: what is
   *  under the sheet's centre and its scale. `animate` asks for the swing
   *  round to the plane — once, when the sheet is first laid. */
  onView: (centre: Vec2, unitsPerScreenPx: number, animate: boolean) => void
}) {
  const scene = () => sceneRef.current
  /** Where the cursor is on the sheet, how far a hand reaches there in
   *  sheet millimetres, and whether Ctrl is held for a raw pick — null off
   *  the sheet. */
  const hover = useRef<{ p: Vec2; radius: number; raw: boolean } | null>(null)
  /** Where the hand is with a tangent arc in it — the Line tool's press on
   *  the chain's last end, dragged — or null. */
  const arcDrag = useRef<{ p: Vec2; radius: number; raw: boolean } | null>(null)
  /** What a click would take under the cursor (see sketchHoverAt), and the
   *  relation or dimension whose glyph or number is pointed at — lit on the
   *  pieces, redrawn only when either changes. */
  const hovered = useRef<{ key: string; pick: SketchHover | null }>({ key: '', pick: null })
  const pointed = useRef<number | null>(null)
  /** The pieces a selection box being dragged would take, or null while
   *  none is — lit in place of what is under the cursor. */
  const boxed = useRef<{ key: string; ids: number[] } | null>(null)
  /** The dimension in hand and where its number last followed the cursor
   *  to — kept while the cursor is off the sheet, so it waits there. */
  const placing = useRef<{ id: number; at: Vec2 } | null>(null)
  /** The draft's dimFocus last acted on: a new count opens a number. */
  const focusSeen = useRef<number | undefined>(undefined)
  /** The points a drawing tool's cursor last snapped to — an end, a centre,
   *  a middle, a quadrant, the zero — newest first, by the anchor so they
   *  follow their piece: what the dashed tracking lines run from. Cleared
   *  when the tool changes. */
  const tracked = useRef<{ tool: string; points: (Anchor | 'origin')[] }>({ tool: '', points: [] })

  /** The tracked points where they lie now, for the tool in hand. */
  const trackPoints = (): Vec2[] => {
    const d = useReverse.getState().sketchDraft
    if (!d || !TRACKING_TOOLS.has(d.tool) || tracked.current.tool !== d.tool) return []
    const out: Vec2[] = []
    for (const t of tracked.current.points) {
      if (t === 'origin') out.push([0, 0])
      else {
        const e = entityOf(d.sketch, t.entity)
        if (e) out.push(anchorPoint(e, t.at))
      }
    }
    return out
  }

  /** A point the drawing tool's cursor snapped to, taken as one to track
   *  from: the newest first, the two newest kept, as CAD keeps a couple. */
  const remember = (tool: string, snap: { kind: SnapKind | null; anchor: Anchor | null }) => {
    if (!TRACKING_TOOLS.has(tool)) return
    const point: Anchor | 'origin' | null = snap.kind === 'origin' ? 'origin' : snap.anchor && (snap.kind === 'anchor' || snap.kind === 'midpoint' || snap.kind === 'quadrant') ? snap.anchor : null
    if (!point) return
    const same = (a: Anchor | 'origin', b: Anchor | 'origin') => (a === 'origin' || b === 'origin' ? a === b : a.entity === b.entity && a.at === b.at)
    const was = tracked.current.tool === tool ? tracked.current.points : []
    if (was[0] && same(was[0], point)) return
    tracked.current = { tool, points: [point, ...was.filter((p) => !same(p, point))].slice(0, 2) }
  }

  /** What a click or a drag may land on besides the sketch: the slice
   *  chains, the grid at its current spacing when grid snapping is switched
   *  on, the tracking lines of a drawing tool — or nothing, with Ctrl held. */
  const snapFor = (raw: boolean): SnapContext => {
    const frame = useReverse.getState().sketchDraft?.frame
    const track = trackPoints()
    return {
      chains: chainsOf()?.chains ?? null,
      grid: useRePrefs.getState().gridSnap ? (scene()?.gridStep() ?? null) : null,
      datums: frame ? datumTraces(frame) : null,
      off: raw,
      ...(track.length > 0 ? { track } : {}),
    }
  }

  /** The projectables of the draft as it stands, found once per sketch
   *  state: a hover asks many times a second, and they change only when
   *  the sketch's plane or the bodies do. */
  const projectCache = useRef<{ key: unknown; list: Projectable[] } | null>(null)
  /** Whether the sheet's zero lies on the sheet, as pushSheet last laid it out. */
  const originOnSheet = useRef(false)
  /** The bounds pushSheet last laid the sheet to, since the sheet was
   *  mounted — null before the first, which is framed at once. */
  const laidBounds = useRef<string | null>(null)
  const candidates = (): Projectable[] => {
    const d = useReverse.getState()
    const key = `${d.bodiesVersion}:${d.sketchDraft?.featureId ?? 'new'}:${d.sketchDraft ? JSON.stringify(d.sketchDraft.frame) : ''}`
    if (projectCache.current?.key !== key) projectCache.current = { key, list: projectablesOf() }
    return projectCache.current.list
  }

  const pushSheet = () => {
    const view = scene()
    const draft = useReverse.getState().sketchDraft
    if (!view || !draft) return
    const chains = chainsOf()
    // The sheet reaches round the slice and the sketch with a hand's width
    // to spare, so a click just outside the outline still lands on it.
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    const take = (x: number, y: number) => {
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
    if (chains) for (let i = 0; i < chains.edges.points.length; i += 2) take(chains.edges.points[i], chains.edges.points[i + 1])
    const b = sketchBounds(draft.sketch)
    if (b) {
      take(b.min[0], b.min[1])
      take(b.max[0], b.max[1])
    }
    // With no slice and nothing drawn — a new sketch on a stage with no
    // scan — the bodies as they lie on the plane, so the sheet opens over
    // the part rather than round the origin.
    if (!Number.isFinite(x0)) for (const p of candidates()) for (const q of p.polyline) take(q[0], q[1])
    if (!Number.isFinite(x0)) {
      x0 = -50
      y0 = -50
      x1 = 50
      y1 = 50
    }
    const pad = Math.max(5, 0.15 * Math.hypot(x1 - x0, y1 - y0))
    // Laid again — the slice came in, or moved with the plane — the view
    // flies to the new framing, and the 3D view under it with it; bounds
    // that did not change leave the view as the operator has it.
    const bounds = [x0 - pad, y0 - pad, x1 + pad, y1 + pad].map((v) => v.toFixed(3)).join(',')
    if (bounds !== laidBounds.current) view.setBlankSheet([x0 - pad, y0 - pad], [x1 + pad, y1 + pad], laidBounds.current === null ? 0 : 350)
    laidBounds.current = bounds
    // The sheet's zero — the part's origin projected onto the plane — is
    // marked when it lies on the sheet: on an unaligned scan the scanner's
    // origin may be a metre away, and a mark there would be a mark on
    // nothing.
    originOnSheet.current = x0 - pad <= 0 && 0 <= x1 + pad && y0 - pad <= 0 && 0 <= y1 + pad
    view.setEdgeChains(chains?.edges ?? null)
    view.setEdgeColor(colors().slice, colors().sliceOpacity)
    view.setAlignment(null)
    view.setMirror(false)
    view.setTurns(0)
    // A millimetre grid on the sheet's own frame, its spacing following the
    // zoom — what a hand drawing free geometry steadies itself on. The
    // frame is the part's own, so the grid is anchored on the origin.
    view.setGrid({ origin: [0, 0], xDir: [1, 0] })
  }

  /** The drawing tool's clicks so far and the ghost of what they are about
   *  to make, rubber-banded to the cursor, with a mark where the cursor
   *  would snap — and the cursor itself: a crosshair for a drawing tool, a
   *  hand over a piece that can be dragged. Redrawn on every move of the
   *  cursor, so it touches nothing but the draft layer. */
  const pushPreview = () => {
    const view = scene()
    const draft = useReverse.getState().sketchDraft
    if (!view) return
    if (!draft) {
      view.setDraftMarks([], null)
      view.setGuides([])
      view.setCursor('')
      view.setDragHover(false)
      return
    }
    const fits: FlatFit[] = []
    const guides: Parameters<FlatScene['setGuides']>[0][number][] = []
    const at = hover.current
    let overHandle = false
    const swung = arcDrag.current
    const from = swung ? chainArcStart(draft, draft.pending[0], Infinity) : null
    if (swung && from) {
      // The arc in the hand, tangent to the piece the chain ended with.
      const snap = snapSketchPoint(draft.sketch, swung.p, swung.radius, snapFor(swung.raw))
      const arc = tangentArc(from.p, from.t, snap.point)
      if (arc) fits.push({ kind: 'arc', center: arc.c, radius: arc.r, start: arc.start, sweep: arc.sweep, sigma: 0, usedPoints: 0 })
      if (snap.kind) fits.push(...snapMark(snap.kind, snap.point, swung.radius * 0.6))
    } else if (at && (draft.tool === 'dimension' || draft.tool === 'relation' || draft.tool === 'fillet' || draft.tool === 'chamfer')) {
      // Nothing is drawn by these: they take what is clicked, which is lit
      // on the pieces (pushPieces) — but a dimension in hand has its number
      // follow the cursor.
      if (draft.dimMade != null) {
        placing.current = { id: draft.dimMade, at: at.p }
        pushDimensions()
      }
    } else if (at && draft.tool === 'trim') {
      // The stretch a click would take away, lit in the trim colour.
      const hit = pieceNear(draft.sketch, at.p, at.radius)
      const plan = hit ? trimPlan(draft.sketch, hit.id, at.p) : null
      if (plan && typeof plan !== 'string') guides.push({ points: plan.stretch, color: colors().trim, width: SKETCH_LINE.hover })
    } else if (at && draft.tool === 'project') {
      // The edge or piece under the cursor, as the piece it would become.
      const found = projectableAt(candidates(), at.p, at.radius)
      if (found) fits.push(entityFit({ ...found.entity, id: 0 } as SketchEntity))
    } else if (at && draft.tool !== 'select') {
      const snap = snapSketchPoint(draft.sketch, at.p, at.radius, snapFor(at.raw))
      // A point snapped to is one to track from next; the tracking lines
      // the cursor is on are drawn dashed from their points.
      remember(draft.tool, snap)
      for (const g of snap.guides ?? []) guides.push({ points: [g.from, g.to], color: colors().track, dashed: true })
      // A spline's first point, the cursor back on it, closes the curve.
      const closing = draft.tool === 'spline' && splineClosesAt(draft.pending, at.p, at.radius)
      fits.push(...toolPreview(draft.tool, draft.pending, closing ? draft.pending[0] : snap.point, useRePrefs.getState().drawModes, useRePrefs.getState().polygonSides))
      if (snap.kind) fits.push(...snapMark(snap.kind, snap.point, at.radius * 0.6))
      // Over the chain's last end the press is the sketch's: held and
      // dragged it draws a tangent arc.
      overHandle = chainArcStart(draft, at.p, at.radius) !== null
    } else if (at && draft.pending.length === 0) {
      overHandle = dragHandleAt(draft.sketch, at.p, at.radius) !== null
    }
    // What a click would take, lit on the pieces — redrawn only when it
    // changes, as the cursor moves over a piece and off it.
    const pick = at && !swung && !boxed.current ? sketchHoverAt(draft, at.p, at.radius) : null
    const key = pick ? `${pick.pieces.join(',')}|${pick.point?.join(',') ?? ''}|${pick.datum ?? ''}` : ''
    if (key !== hovered.current.key) {
      hovered.current = { key, pick }
      pushPieces()
    }
    // The Pattern box open: the copies it would make, drawn where they land.
    if (draft.pattern && draft.selection.length > 0) fits.push(...patternPreview(draft.sketch, draft.selection, draft.pattern))
    view.setCursor(draft.tool === 'select' ? (pick ? 'pointer' : '') : draft.tool === 'dimension' || draft.tool === 'relation' || draft.tool === 'fillet' || draft.tool === 'chamfer' || draft.tool === 'trim' ? 'pointer' : 'crosshair')
    // Over a piece the navigator lets go of the press, so it is a drag of
    // the piece and not a pan of the sheet.
    view.setDragHover(overHandle)
    // A chain's carried-on start is an end already drawn, not a pick to pin.
    view.setDraftMarks(draft.chain ? [] : draft.pending, fits, undefined, colors().free)
    view.setGuides(guides)
  }

  /** The pieces, the coordinate planes' lines and the dots on the ends, in
   *  their colours — the selection, and what the cursor would take or a
   *  glyph or a number pointed at holds, lit. */
  const pushPieces = () => {
    const view = scene()
    const draft = useReverse.getState().sketchDraft
    if (!view || !draft) return
    const sketch = draft.sketch
    const palette = colors()
    const pick = hovered.current.pick
    const held = pointed.current === null ? undefined : sketch.constraints.find((c) => c.id === pointed.current)
    const fixPointed = pointed.current === null ? null : fixedEntityOf(pointed.current)
    const lit = new Set([...(pick?.pieces ?? []), ...(boxed.current?.ids ?? []), ...(held ? constraintEntities(held) : []), ...(fixPointed !== null ? [fixPointed] : [])])
    const litPoints: Vec2[] = []
    if (pick?.point) litPoints.push(pick.point)
    for (const a of held ? constraintAnchors(held) : []) {
      const e = entityOf(sketch, a.entity)
      if (e) litPoints.push(anchorPoint(e, a.at))
    }
    const litDatums = new Set<DatumPlane>([...(pick?.datum ? [pick.datum] : []), ...(held && constraintDatum(held) ? [constraintDatum(held)!] : [])])
    // The Dimension tool's first pick, and Coincident's, are lit like a
    // selection while they wait for the second.
    const picks = [draft.dimPick ?? null, ...(draft.relPicks ?? [])].filter((p): p is NonNullable<typeof p> => p !== null)
    const picked = picks[0] ?? null
    const selected = new Set(draft.selection)
    for (const p of picks) if (p.kind === 'piece') selected.add(p.id)
    // A free piece is loose until relations and dimensions pin it down,
    // then drawn in the constrained colour; with no solve yet, loose.
    const loose = new Set(draft.report ? draft.report.underConstrained : sketch.entities.map((e) => e.id))
    const colorOf = (e: SketchEntity) =>
      selected.has(e.id)
        ? palette.selected
        : e.construction
          ? palette.construction
          : e.projected
            ? palette.projected
            : 'points' in e && e.points
              ? palette.fitted
              : loose.has(e.id)
                ? palette.free
                : palette.constrained
    const items: { fit: FlatFit; color: string; name: string; value: string; label: boolean; width?: number }[] = sketch.entities.map((e) => ({
      fit: entityFit(e),
      color: lit.has(e.id) ? palette.hover : colorOf(e),
      name: '',
      value: '',
      label: false,
      width: lit.has(e.id) ? SKETCH_LINE.hover : selected.has(e.id) ? SKETCH_LINE.selected : e.construction ? SKETCH_LINE.construction : SKETCH_LINE.piece,
    }))
    // The part's coordinate planes, as the lines they cut the sheet in:
    // what a dimension to a plane is clicked on. Drawn about the sketch —
    // or about the sheet's zero while it is empty — and named.
    const traces = datumTraces(draft.frame)
    const around = sketchBounds(sketch)
    const middle: Vec2 = around ? [(around.min[0] + around.max[0]) / 2, (around.min[1] + around.max[1]) / 2] : [0, 0]
    const reach = Math.max(100, around ? 2 * Math.hypot(around.max[0] - around.min[0], around.max[1] - around.min[1]) : 0)
    for (const t of traces) {
      const fit = lineFit(...traceSegment(t, middle, reach))
      if (!fit) continue
      const on = picks.some((p) => p.kind === 'datum' && p.plane === t.plane)
      const over = litDatums.has(t.plane)
      items.push({ fit, color: over ? palette.hover : on ? palette.selected : palette.datum, name: datumName(t.plane), value: '', label: true, width: over ? SKETCH_LINE.hover : on ? SKETCH_LINE.selected : SKETCH_LINE.datum })
    }
    view.setFlatElements(items)
    // A dot on every end of a line or an arc: where one piece stops and the
    // next begins, which a run of fitted pieces in one colour does not say.
    const dots: { at: Vec2; color: string; size: number }[] = []
    // A spline's fit points too: what it is drawn through, and dragged by.
    for (const e of sketch.entities) {
      if (e.kind !== 'line' && e.kind !== 'arc' && e.kind !== 'spline') continue
      for (const at of anchorsOf(e)) dots.push({ at: anchorPoint(e, at), color: selected.has(e.id) ? palette.selected : palette.dot, size: SKETCH_DOT.end })
    }
    for (const p of picks) {
      if (p.kind !== 'point') continue
      const e = entityOf(sketch, p.anchor.entity)
      if (e) dots.push({ at: anchorPoint(e, p.anchor.at), color: palette.selected, size: SKETCH_DOT.picked })
    }
    void picked
    for (const at of litPoints) dots.push({ at, color: palette.hover, size: SKETCH_DOT.hover })
    // The origin, as every CAD sketcher marks it: a dot in the datum colour
    // at the sheet's zero, where the traces cross — a snap for the tools.
    if (originOnSheet.current) dots.push({ at: [0, 0], color: palette.datum, size: SKETCH_DOT.origin })
    view.setFlatDots(dots)
  }

  const pushSketch = () => {
    const view = scene()
    const draft = useReverse.getState().sketchDraft
    if (!view) return
    if (!draft) {
      view.setFlatElements([])
      view.setFlatDots([])
      view.setFlatFills([])
      view.setDraftMarks([], null)
      view.setNotes([])
      view.setFlatDimensions([])
      view.setCursor('')
      view.setBoxSelect(false)
      hovered.current = { key: '', pick: null }
      pointed.current = null
      placing.current = null
      return
    }
    const sketch = draft.sketch
    const palette = colors()
    // With the Select tool a drag over the bare sheet draws a selection
    // box; with any other the drag pans, as it does while drawing.
    view.setBoxSelect(draft.tool === 'select')
    pushPieces()
    // Every closed region as a translucent face, its holes cut out: a
    // profile that closes reads as a face, one that does not as lines.
    view.setFlatFills(
      draft.found.map((r) => ({ polygon: r.outer.polygon, holes: r.holes.map((h) => h.polygon), color: palette.region, opacity: 0.16 })),
    )
    pushPreview()

    // Relation glyphs as notes, dimensions as callouts. A glyph is lifted a
    // few pixels off its spot (the `glyph` class), the way CAD draws a
    // constraint beside its entity: sitting on the line's middle or on a
    // corner it would take the press meant to drag the piece.
    // Drawn only when asked for (the key by the tools), or for the one
    // relation selected in the panel: a fitted profile has a join and a
    // tangency at every corner, and their glyphs bury the drawing.
    const showGlyphs = useRePrefs.getState().sketchRelations
    const notes: { id: number; text: string; at: Vec2; editing: boolean; className?: string; tip?: string }[] = []
    for (const c of sketch.constraints) {
      if (isDimension(c)) continue
      if (!showGlyphs && draft.selectedConstraint !== c.id) continue
      const glyph = GLYPHS[c.kind]
      const at = glyphSpot(c, sketch)
      if (glyph && at) notes.push({ id: c.id, text: glyph, at, editing: draft.selectedConstraint === c.id, className: 'glyph', tip: relationName(c.kind) })
    }
    for (const e of fixedPieces(sketch)) {
      const id = fixId(e.id)
      if (!showGlyphs && draft.selectedConstraint !== id) continue
      notes.push({ id, text: FIX_GLYPH, at: fixSpot(e), editing: draft.selectedConstraint === id, className: 'glyph', tip: 'Fix' })
    }
    view.setNotes(notes)
    pushDimensions()
    // A dimension handed over for typing — just put down, or clicked again
    // with the Dimension tool — opens its number where it is.
    if (draft.dimFocus !== focusSeen.current) {
      focusSeen.current = draft.dimFocus
      if (draft.selectedConstraint !== null) view.openDimension(draft.selectedConstraint)
    }
  }

  /** The dimensions, as a drawing carries them. The one in hand is written
   *  where the cursor is, and while it is none of them takes a click — the
   *  click that puts it down goes through to the sheet. */
  const pushDimensions = () => {
    const view = scene()
    const draft = useReverse.getState().sketchDraft
    if (!view || !draft) return
    const sketch = draft.sketch
    if (placing.current && placing.current.id !== draft.dimMade) placing.current = null
    const held = placing.current
    const b = sketchBounds(sketch)
    const lift = b ? 0.03 * Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1]) : 1
    const traces = datumTraces(draft.frame)
    // Lengths are written, and their fields open, in the units shown; what
    // is typed is read back into millimetres by the label's handler.
    const units = usePrefs.getState().units
    const dims: SketchDimensionItem[] = []
    for (const c0 of sketch.constraints) {
      if (!isDimension(c0)) continue
      // The one in hand as the click would put it down there: a distance
      // pulled square above or beside its two points measures along u or v.
      const c = held?.id === c0.id ? pulledDimension(c0, sketch, held.at) : c0
      const place = held?.id === c.id ? dimPlaceAt(c, sketch, held.at, traces) : null
      const shape = dimShape(place ? { ...c, place } : c, sketch, traces, lift)
      if (!shape) continue
      const text = dimensionFieldText(c, units)
      dims.push({ shape, value: dimensionText(c, units), ...(draft.dimMade == null ? { edit: { id: c.id, value: c.value, ...(text !== undefined ? { text } : {}) } } : {}) })
    }
    view.setSketchDimensions(dims, { color: colors().dimension, className: 'sketch-dim' })
  }

  const chainsVersion = useReverse((s) => s.chainsVersion)
  const draftOpen = useReverse((s) => s.sketchDraft !== null)
  useEffect(() => {
    pushSheet()
    pushSketch()
    // Runs on the listed dependencies only, not on everything it reads.
  }, [chainsVersion, draftOpen])

  const draft = useReverse((s) => s.sketchDraft)
  const showRelations = useRePrefs((s) => s.sketchRelations)
  const dark = usePrefs((s) => s.dark)
  const units = usePrefs((s) => s.units)
  useEffect(pushSketch, [draft, showRelations, dark, units])
  useEffect(() => {
    scene()?.setEdgeColor(colors().slice, colors().sliceOpacity)
    // Runs on the listed dependencies only, not on everything it reads.
  }, [dark])

  return {
    onReady: (view: FlatScene | null) => {
      sceneRef.current = view
      if (view) {
        // A relation's glyph or a dimension's number pointed at lights what
        // it holds.
        const point = (id: number | null) => {
          if (pointed.current === id) return
          pointed.current = id
          pushPieces()
        }
        view.onNoteHover = point
        view.onDimensionHover = point
        // A selection box lights what it would take as it is dragged, and
        // takes it when let go.
        view.onBoxDrag = (box) => {
          const sketch = useReverse.getState().sketchDraft?.sketch
          const ids = box && sketch ? piecesInBox(sketch, box.corners, box.crossing) : null
          const key = ids ? ids.join(',') : null
          if (key === (boxed.current?.key ?? null)) return
          boxed.current = ids && key !== null ? { key, ids } : null
          pushPieces()
        }
        view.onBoxSelect = (box) => useReverse.getState().sketchBoxSelect(box.corners, box.crossing, box.additive)
        // The Spline tool's points in hand are pins on the sheet, which take
        // the click themselves: the last one clicked again ends the curve,
        // the first one closes it; a pin dragged moves its point.
        view.onPinClick = (index) => {
          const s = useReverse.getState()
          const d = s.sketchDraft
          if (d?.tool !== 'spline') return
          if (index === 0 && d.pending.length >= 3) s.finishSpline(true)
          else if (index === d.pending.length - 1) s.finishSpline()
        }
        view.onPickDrag = (index, p) => {
          const s = useReverse.getState()
          if (s.sketchDraft?.tool === 'spline') s.moveSplinePoint(index, p)
        }
        // A sheet laid anew over a sketch already open opens nothing.
        focusSeen.current = useReverse.getState().sketchDraft?.dimFocus
        laidBounds.current = null
        pushSheet()
        pushSketch()
        // The sheet is framed: the part swings round to lie under it.
        // Before the sheet's first tick, so no snap gets there first.
        const v = view.sheetView()
        onView(v.centre, v.unitsPerScreenPx, true)
      }
    },
    /** The sheet panned, zoomed or was re-framed: the part follows. */
    onViewChange: (centre: Vec2, unitsPerScreenPx: number) => onView(centre, unitsPerScreenPx, false),
    /** The cursor moved over the sheet (or left it): the ghost follows. */
    onHover: (p: Vec2 | null, radius: number, raw: boolean) => {
      const before = hover.current
      hover.current = p ? { p, radius, raw } : null
      if (before === null && hover.current === null) return
      pushPreview()
    },
    /** The hand with a tangent arc in it moved, or let go (null): the arc
     *  is drawn from the chain's last end to where it would land. */
    onArcDrag: (p: Vec2 | null, radius: number, raw: boolean) => {
      arcDrag.current = p ? { p, radius, raw } : null
      pushPreview()
    },
    snapFor,
    /** What the Project tool would take at a sheet point, or null. */
    projectableAt: (p: Vec2, radius: number) => projectableAt(candidates(), p, radius),
  }
}

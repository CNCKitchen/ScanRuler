// SPDX-License-Identifier: AGPL-3.0-only
// The sketch editor's actions: a sketch started on a plane or edited,
// drawn into, dimensioned, constrained, fitted to the scan's slice, undone
// and redone within itself, and finished — or finished straight into an
// extrude or a revolve.

import type { StoreApi } from 'zustand'
import type { Vec2 } from '../../../src/core/flat/types'
import { dot2, len2, perp2, scale2, sub2 } from '../../../src/core/flat/vec2'
import type { SectionFrame } from '../../../src/core/section/frame'
import { addScaled, cross, normalize, scale } from '../../../src/core/vec'
import { fmtLen } from '../../../src/core/units'
import { usePrefs } from '../../../src/state/prefsStore'
import { useStore } from '../../../src/state/store'
import { piecesInBox } from '../core/boxSelect'
import { letGo, type ShareReport, sharePieces } from '../core/shareFit'
import { closeChain, CORNER_GAP_MM, inferCorners, joinEnds, sharpenCorner } from '../core/corners'
import { datumTraces, traceNear } from '../core/datums'
import { dimPlaceAt, distanceEnds } from '../core/dimLayout'
import { detached, moveAnchor, rigidCluster, rotateSketch, translateEntity } from '../core/drag'
import { arcAbout, circleFrom, coincidentFor, dimensionFor, dimensionIsImmediate, dimPickAt, drawClicks, rectangleCorners, relPickAt, tangentArc } from '../core/draw'
import { planeOffset, type PlaneRef, planeTakesOffset, type SketchFeature, withPlaneOffset } from '../core/features'
import { cornerLinesAt } from '../core/filletCorner'
import { DEFAULT_FIT_OPTIONS } from '../core/fitOptions'
import { nominalOf } from '../core/nominal'
import { replaceSketch } from '../core/parameters'
import { resolvePlaneFrame } from '../core/resolve'
import { shadowPieceCount, shadowSketch } from '../core/shadowPieces'
import { trimAt } from '../core/trim'
import { addConstraint, addEntity, addPolygon, addRectangle, addRectangleCentre, addTurnedRectangle, type Anchor, type AnchorAt, anchorPoint, anchorsOf, arcThrough, axisRelationOf, cloneSketch, distanceAlong, type ConstraintInput, entityOf, fixedEntityOf, isDimension, lineDir, patternPieces, relationTakes, removeConstraint, removeEntities, type Sketch, sketchBounds, type SketchEntity, splineJoint, type SketchSpline } from '../core/sketch'
import { fitSplineToPoints, splineScatter } from '../core/sketchSpline'
import { levelImage, moveImage, scaleImage } from '../core/sketchImage'
import { snapHold, type SnapHold, snapSketchPoint } from '../core/snap'
import { measureDimension, type Pull } from '../core/solver'
import { everyRegion, nameFor, remember } from './reFeatureHelpers'
import { useRePrefs } from './rePrefs'
import { anchorNear, chainArcStart, chamferDraft, dimensionDone, dimensionPair, dragHandleAt, dropDimension, filletDraft, fitChain, fitChainShared, holdAt, holdDimension, holdSymmetric, isAnchor, MAX_HISTORY, nearestEnds, pieceNear, putDownDimension, seededSketch, settle, splineClosesAt, splineDraft, toolIdle } from './reSketchDraft'
import type { ReState } from './reStore'
import type { SketchDraft } from './reTypes'

type StoreSet = StoreApi<ReState>['setState']
type StoreGet = StoreApi<ReState>['getState']

/** A piece being dragged on the sheet: which, by what, and where the hand
 *  last was. The sketch as it stood is in the draft's history already. */
/** The drag in the hand. `rigid`, for a shape defined in all but its place
 *  (see rigidCluster), is every piece of it as it was when the drag began:
 *  the hand's move carries them all. */
let sketchDrag: { entity: number; at: AnchorAt | 'body'; start: Vec2; origin: SketchEntity; last: Vec2; snapped: SnapHold | null; pull: Pull[]; begun: boolean; rigid: SketchEntity[] | null } | null = null

/** Which chains were fitted when a history snapshot was taken by a fit or a
 *  refit — what undo puts back beside the sketch, so a refit undone leaves
 *  the chains fitted by the pieces that came back, not free to be fitted a
 *  second time on top of them. Keyed by the snapshot itself. */
const fittedBefore = new WeakMap<Sketch, SketchDraft['fitted']>()

function rememberFitted(snapshot: Sketch, fitted: SketchDraft['fitted']): Sketch {
  fittedBefore.set(snapshot, fitted)
  return snapshot
}

/** The angle a plane through an axis is turned to; 0 for any other. */
const planeAngle = (p: PlaneRef): number => (p.kind === 'radial' ? p.angleDeg : 0)

export const sketchSlice = (set: StoreSet, get: StoreGet): Pick<ReState, 'startSketchOn' | 'startSketch' | 'editSketch' | 'projectInto' | 'setSketch' | 'discardSketch' | 'setSketchTool' | 'armRelation' | 'setSketchName' | 'setSketchImage' | 'startImagePick' | 'scaleSketchImage' | 'setSketchOffset' | 'setSketchLevel' | 'setSketchAngle' | 'setSketchTolerance' | 'sketchClick' | 'sketchTangentArc' | 'finishSpline' | 'moveSplinePoint' | 'fitSplinesToSlice' | 'sketchBoxSelect' | 'sketchDragStart' | 'sketchDrag' | 'sketchDragEnd' | 'alignToSelected' | 'autoFit' | 'refitChains' | 'inferAllCorners' | 'closeAll' | 'joinSelected' | 'addRelation' | 'addDimension' | 'dimensionSelection' | 'setDimensionValue' | 'setDimensionForm' | 'setDistanceAxis' | 'finishDimension' | 'removeSelectedConstraint' | 'selectConstraint' | 'deleteSelected' | 'sharpenSelected' | 'filletSelected' | 'chamferSelected' | 'moveDimension' | 'toggleFixedSelected' | 'toggleConstructionSelected' | 'clearSelection' | 'openSketchPattern' | 'setSketchPattern' | 'applySketchPattern' | 'cancelSketchPattern' | 'putDownDimension' | 'undoSketch' | 'redoSketch' | 'solveNow' | 'commitSketch' | 'finishAndExtrude' | 'finishAndRevolve'> => ({

  startSketchOn: (plane) => {
    const store = useStore.getState()
    const frame = resolvePlaneFrame(plane, { sections: store.sections, elements: store.elements, modelCenter: store.modelCenter })
    if (!frame) return false
    get().startSketch(plane, frame)
    // A sketch on a shadow starts with its outline: the lines and arcs it
    // was read to, as they are, not its drawing fitted again. One undo
    // step, back to the empty sheet.
    const sec = plane.kind === 'section' ? store.sections.find((x) => x.id === plane.id) : undefined
    const sh = sec?.kind === 'shadow' ? sec.cut?.shadow : undefined
    if (sh && sh.loops.length > 0) {
      get().setSketch(shadowSketch(sh, frame))
      store.setStatus(`Sketch on ${sec!.name} — its outline is in, ${shadowPieceCount(sh)} pieces as the shadow was read. Edit it, or Finish and extrude it.`)
    }
    return true
  },

  startSketch: (plane, frame, seed) =>
    set((s) => ({
      extrudeDraft: null,
      revolveDraft: null,
      featureDraft: null,
      bodyPick: null,
      hint: null,
      selection: null,
      gripField: null,
      preview: { status: 'idle' },
      sketchDraft: settle({
        name: nameFor(s, 'sketch').name,
        plane,
        frame,
        sketch: seededSketch(seed),
        tool: 'select',
        selection: [],
        selectedConstraint: null,
        pending: [],
        report: null,
        tolerance: null,
        fitted: {},
        found: [],
        history: [],
        error: null,
      }),
    })),

  editSketch: (id) =>
    set((s) => {
      const f = s.features.find((x) => x.id === id)
      if (!f || f.kind !== 'sketch') return {}
      return {
        extrudeDraft: null,
        revolveDraft: null,
        hint: null,
        selection: null,
        gripField: null,
        preview: { status: 'idle' },
        // The part is built again as it stood before the sketch (see
        // featuresToBuild).
        buildVersion: s.buildVersion + 1,
        sketchDraft: settle({
          featureId: f.id,
          name: f.name,
          plane: f.plane,
          frame: f.frame,
          ...(f.exprs ? { exprs: { ...f.exprs } } : {}),
          ...(f.image ? { image: f.image } : {}),
          sketch: cloneSketch(f.sketch),
          tool: 'select',
          selection: [],
          selectedConstraint: null,
          pending: [],
          report: null,
          tolerance: null,
          fitted: {},
          found: [],
          history: [],
          error: null,
        }),
      }
    }),

  projectInto: (entities) =>
    set((s) => {
      const d = s.sketchDraft
      if (!d || entities.length === 0) return {}
      const before = cloneSketch(d.sketch)
      const ids = entities.map((e) => addEntity(d.sketch, e))
      return { sketchDraft: settle({ ...d, selection: ids.slice(-1), selectedConstraint: null }, before) }
    }),

  setSketch: (sketch, pull) =>
    set((s) => {
      const d = s.sketchDraft
      if (!d) return {}
      const idle = { ...dropDimension(d), ...toolIdle() }
      const before = cloneSketch(idle.sketch)
      return { sketchDraft: settle({ ...idle, sketch: cloneSketch(sketch), selection: [], selectedConstraint: null }, before, pull) }
    }),
  discardSketch: () => set((s) => ({ sketchDraft: null, ...(s.sketchDraft?.featureId !== undefined ? { buildVersion: s.buildVersion + 1 } : {}) })),
  setSketchTool: (tool) =>
    set((s) =>
      s.sketchDraft
        ? { sketchDraft: { ...dropDimension(s.sketchDraft), ...toolIdle(), tool, armedRelation: null, error: null, ...(tool === 'dimension' || tool === 'fillet' || tool === 'chamfer' ? { selection: [], selectedConstraint: null } : {}) } }
        : {},
    ),
  armRelation: (kind) =>
    set((s) =>
      s.sketchDraft
        ? { sketchDraft: { ...dropDimension(s.sketchDraft), ...toolIdle(), tool: 'relation', armedRelation: kind, selection: [], selectedConstraint: null, error: null } }
        : {},
    ),
  setSketchName: (name) => set((s) => (s.sketchDraft ? { sketchDraft: { ...s.sketchDraft, name } } : {})),
  setSketchImage: (image) =>
    set((s) =>
      s.sketchDraft
        ? {
            sketchDraft: { ...s.sketchDraft, image: image ?? undefined, imagePick: null, error: null },
            // A picture just laid in is seen: it lies on the part's plane.
            ...(image && !s.sketchDraft.image ? { sketchModelShown: true } : {}),
          }
        : {},
    ),
  startImagePick: (mode) =>
    set((s) => {
      const d = s.sketchDraft
      if (!d) return {}
      if (mode && !d.image) return { sketchDraft: { ...d, error: 'Lay a picture under the sketch first.' } }
      return { sketchDraft: { ...dropDimension(d), ...toolIdle(), tool: 'select', selection: [], pattern: null, imagePick: mode ? { mode, points: [] } : null, error: null } }
    }),
  scaleSketchImage: (length) =>
    set((s) => {
      const d = s.sketchDraft
      const pick = d?.imagePick
      if (!d?.image || pick?.mode !== 'scale' || pick.points.length < 2) return {}
      const scaled = scaleImage(d.image, pick.points[0], pick.points[1], length)
      if (!scaled) return { sketchDraft: { ...d, error: 'The two points are one — click two points apart.' } }
      return { sketchDraft: { ...d, image: scaled, imagePick: null, error: null } }
    }),
  setSketchOffset: (offset, expr = null) =>
    set((s) => {
      const d = s.sketchDraft
      if (!d || !planeTakesOffset(d.plane)) return {}
      const exprs = { ...(d.exprs ?? {}) }
      if (expr) exprs.offset = expr
      else delete exprs.offset
      // Solved again in the frame it lands in: a coordinate plane's line
      // on a tilted sheet is somewhere else there.
      const moved = withPlaneOffset({ ...d, exprs: Object.keys(exprs).length > 0 ? exprs : undefined }, offset)
      return { sketchDraft: settle(moved) }
    }),
  setSketchLevel: (level) =>
    set((s) => {
      const d = s.sketchDraft
      if (!d || !Number.isFinite(level) || (d.level ?? 0) === level) return {}
      // The chains of another level are other chains: none of them fitted.
      const { level: _was, ...rest } = d
      void _was
      return { sketchDraft: { ...rest, ...(level !== 0 ? { level } : {}), fitted: {}, error: null } }
    }),
  setSketchAngle: (angleDeg) => {
    const d = get().sketchDraft
    if (!d || d.plane.kind !== 'radial') return false
    const store = useStore.getState()
    const plane = { ...d.plane, angleDeg }
    const frame = resolvePlaneFrame(plane, { sections: store.sections, elements: store.elements, modelCenter: store.modelCenter })
    if (!frame) return false
    // Solved again in the frame it lands in, as an offset is: the
    // coordinate planes cross the sheet elsewhere at another angle.
    set({ sketchDraft: settle({ ...d, plane, frame }) })
    return true
  },
  setSketchTolerance: (tolerance) =>
    set((s) => (s.sketchDraft ? { sketchDraft: { ...s.sketchDraft, tolerance } } : {})),

  sketchClick: (spot, radius, additive, snapCtx = {}) => {
    // Points clicked on the picture under the sketch: two, then it is
    // moved or levelled — or, to scale it, the length between them asked
    // for. A click with two in hand starts the pair again.
    const picking = get().sketchDraft
    if (picking?.imagePick && picking.image) {
      const pick = picking.imagePick
      // Where a point of the picture goes snaps — to an end, the origin, an
      // axis — as a drawn point does; the points on the picture are where
      // they were clicked.
      const at = pick.mode === 'move' && pick.points.length === 1 ? snapSketchPoint(picking.sketch, spot, radius, snapCtx).point : spot
      const points = pick.points.length >= 2 ? [at] : [...pick.points, at]
      if (points.length < 2 || pick.mode === 'scale') {
        set({ sketchDraft: { ...picking, imagePick: { ...pick, points }, error: null } })
        return
      }
      const image = pick.mode === 'move' ? moveImage(picking.image, points[0], points[1]) : levelImage(picking.image, points[0], points[1])
      set({ sketchDraft: { ...picking, image: image ?? picking.image, imagePick: null, error: image ? null : 'The two points are one — click two points apart.' } })
      return
    }
    // A relation in hand: the pieces clicked are collected until it has
    // what it takes — one line for level or upright, two pieces otherwise —
    // and it stays in hand for the next.
    const armed = get().sketchDraft
    if (armed?.tool === 'relation' && armed.armedRelation === 'coincident') {
      // Coincident takes what CAD takes: an end, a centre, a piece or a
      // coordinate plane's line, then a second — two points meet, a point
      // lies on a piece or a plane's line, a line lies along a line or a
      // plane's line (core/re/draw's coincidentFor). It stays in hand.
      const pick = relPickAt(armed.sketch, spot, radius, datumTraces(armed.frame))
      const picks = armed.relPicks ?? []
      if (!pick) {
        set({ sketchDraft: { ...armed, relPicks: [], selection: [], error: null } })
        return
      }
      if (picks.length === 0) {
        set({ sketchDraft: { ...armed, relPicks: [pick], selection: [], selectedConstraint: null, error: null } })
        return
      }
      const made = coincidentFor(armed.sketch, picks[0], pick)
      if (typeof made === 'string') {
        set({ sketchDraft: { ...armed, relPicks: [], error: made } })
        return
      }
      const before = cloneSketch(armed.sketch)
      const id = addConstraint(armed.sketch, made)
      set({ sketchDraft: { ...settle({ ...armed, relPicks: [], selection: [] }, before), selectedConstraint: id } })
      return
    }
    if (armed?.tool === 'relation' && armed.armedRelation) {
      const kind = armed.armedRelation
      const hit = pieceNear(armed.sketch, spot, radius)
      if (!hit) {
        // Symmetric's mirror line may be one of the part's coordinate
        // planes, clicked on the line it cuts the sheet in — where no piece
        // of the sketch is (datums.ts).
        const trace = kind === 'symmetric' && armed.selection.length === 2 ? traceNear(datumTraces(armed.frame), spot, radius) : null
        const a = trace ? entityOf(armed.sketch, armed.selection[0]) : undefined
        const b = trace ? entityOf(armed.sketch, armed.selection[1]) : undefined
        if (trace && a && b) {
          set({ sketchDraft: { ...holdSymmetric({ ...armed, selectedConstraint: null }, a, b, trace), selection: [] } })
          return
        }
        set({ sketchDraft: { ...armed, selection: [], error: null } })
        return
      }
      if (armed.selection.includes(hit.id)) return
      const selection = [...armed.selection, hit.id]
      set({ sketchDraft: { ...armed, selection, selectedConstraint: null, error: null } })
      // Symmetric takes a third: the line the two mirror about.
      if (selection.length < (kind === 'horizontal' || kind === 'vertical' ? 1 : kind === 'symmetric' ? 3 : 2)) return
      get().addRelation(kind)
      const after = get().sketchDraft
      if (after) set({ sketchDraft: { ...after, selection: [] } })
      return
    }
    set((s) => {
      const d = s.sketchDraft
      if (!d) return {}
      if (d.tool === 'dimension') {
        // The first click picks a piece, an end or a coordinate plane. A
        // line is its length and a round piece its radius there and then,
        // and the dimension is in hand: its number follows the cursor, and
        // the next click puts it down where it reads best — unless that
        // click lands on another piece, an end or a plane, which turns it
        // into the distance or the angle between the two, in hand in its
        // turn. An end or a plane waits for its second click the same way.
        // Put down, the number opens for typing.
        const traces = datumTraces(d.frame)
        const pick = dimPickAt(d.sketch, spot, radius, traces)
        const first = d.dimPick ?? null
        const made = d.dimMade ?? null
        if (made !== null) {
          const pair = first ? dimensionPair(d, first, pick) : null
          // What pairs with nothing — the bare sheet, the same line, its
          // own end, a plane's line it does not run along — is where the
          // number goes.
          if (!pair) return { sketchDraft: putDownDimension(d, spot) }
          // The dimension the first click made gives way to what was meant,
          // in the step it took, so one undo undoes the pair.
          return { sketchDraft: holdDimension(dropDimension(d), pair, null) }
        }
        if (!first) {
          if (!pick) return { sketchDraft: { ...d, selectedConstraint: null, error: null } }
          if (!dimensionIsImmediate(d.sketch, pick)) return { sketchDraft: { ...d, dimPick: pick, selectedConstraint: null, error: null } }
          const alone = dimensionFor(d.sketch, pick, null, traces)
          if (!alone) return { sketchDraft: { ...d, dimPick: null, error: null } }
          // A line that carries its length already is not given a second:
          // that one opens for typing, and the line stays in hand to pair.
          const has = d.sketch.constraints.find((c) => c.kind === alone.kind && 'entity' in c && 'entity' in alone && c.entity === alone.entity)
          if (has) return { sketchDraft: { ...d, dimPick: pick, selectedConstraint: has.id, dimFocus: (d.dimFocus ?? 0) + 1, error: null } }
          return { sketchDraft: holdDimension(d, alone, pick) }
        }
        // A point or a plane alone is no dimension, and a line clicked
        // again is the one it has.
        if (!pick || (pick.kind === 'piece' && first.kind === 'piece' && pick.id === first.id)) return { sketchDraft: { ...d, dimPick: null, error: null } }
        const pair = dimensionPair(d, first, pick)
        if (!pair) return { sketchDraft: { ...d, dimPick: null, error: 'No dimension runs between those two.' } }
        return { sketchDraft: holdDimension(d, pair, null) }
      }
      if (d.tool === 'fillet' || d.tool === 'chamfer') {
        // A corner clicked is rounded or cut there and then; otherwise two
        // lines are collected, the way a relation in hand collects its pieces.
        const make = d.tool === 'fillet' ? filletDraft : chamferDraft
        const corner = anchorNear(d.sketch, spot, radius)
        const atCorner = corner ? cornerLinesAt(d.sketch, corner.anchor) : null
        if (atCorner) return { sketchDraft: make(d, atCorner[0], atCorner[1]) }
        const hit = pieceNear(d.sketch, spot, radius)
        if (!hit) return { sketchDraft: { ...d, selection: [], selectedConstraint: null, error: null } }
        if (hit.kind !== 'line') return { sketchDraft: { ...d, error: `A ${d.tool === 'fillet' ? 'round' : 'chamfer'} goes between two lines — click a corner, or one line and then the other.` } }
        if (d.selection.includes(hit.id)) return {}
        const first = d.selection.length === 1 ? d.selection[0] : null
        if (first === null) return { sketchDraft: { ...d, selection: [hit.id], selectedConstraint: null, error: null } }
        return { sketchDraft: make(d, first, hit.id) }
      }
      if (d.tool === 'select') {
        const hit = pieceNear(d.sketch, spot, radius)
        if (!hit) return { sketchDraft: { ...d, selection: [], selectedConstraint: null, error: null } }
        const selection = d.selection.includes(hit.id)
          ? d.selection.filter((id) => id !== hit.id)
          : additive || d.selection.length < 2
            ? [...d.selection, hit.id]
            : [hit.id]
        return { sketchDraft: { ...d, selection, selectedConstraint: null, error: null } }
      }
      // The Project tool's click is resolved against the part by the app,
      // which holds the bodies; it lands in projectInto.
      if (d.tool === 'project') return {}
      if (d.tool === 'trim') {
        // The stretch of the piece clicked between the nearest two places
        // other pieces cross it goes (core/trim.ts); a piece nothing
        // crosses goes whole. The tool stays in hand for the next.
        const hit = pieceNear(d.sketch, spot, radius)
        if (!hit) return { sketchDraft: { ...d, error: null } }
        const before = cloneSketch(d.sketch)
        const done = trimAt(d.sketch, hit.id, spot)
        if (typeof done === 'string') return { sketchDraft: { ...d, error: done } }
        return { sketchDraft: settle({ ...d, selection: [], selectedConstraint: null }, before) }
      }
      // A drawing tool: the click snaps to a nearby end (which the new piece
      // is then held to), a slice point, a piece or the grid.
      const snap = snapSketchPoint(d.sketch, spot, radius, snapCtx)
      const at: Vec2 = snap.point
      const pending = [...d.pending, at]
      const snaps = [...(d.snaps ?? []), snapHold(snap)]
      if (d.tool === 'point') {
        // One click, one point — held where it snapped, as a drawn end is:
        // on a middle, a quadrant, a piece, an axis.
        const before = cloneSketch(d.sketch)
        const id = addEntity(d.sketch, { kind: 'point', p: at })
        if (snaps[0]) holdAt(d.sketch, { entity: id, at: 'center' }, snaps[0])
        return { sketchDraft: settle({ ...d, ...toolIdle(), error: null }, before) }
      }
      if (d.tool === 'spline') {
        // The points are collected until the hand ends the curve: a click
        // back on the first point closes it; one on the last point again —
        // the second click of a double click — ends it open, as Enter does.
        if (splineClosesAt(d.pending, spot, radius)) return { sketchDraft: splineDraft(d, true) }
        const last = d.pending.at(-1)
        if (last && len2(sub2(last, at)) <= radius / 3) return { sketchDraft: splineDraft(d, false) }
        return { sketchDraft: { ...d, pending, snaps, error: null } }
      }
      const modes = useRePrefs.getState().drawModes
      const need = drawClicks(d.tool, modes)
      if (pending.length < need) {
        return { sketchDraft: { ...d, pending, error: null, snaps } }
      }
      const before = cloneSketch(d.sketch)
      const sketch = d.sketch
      const [p, q, r] = pending
      // A second click where the first landed makes nothing and puts the
      // points down: it is how a chain of lines is ended on the sheet.
      if (len2(sub2(p, q)) < 1e-6) return { sketchDraft: { ...d, ...toolIdle(), error: null } }
      /** The end the next line carries on from. */
      let carry: Anchor | null = null
      if (d.tool === 'line') {
        const id = addEntity(sketch, { kind: 'line', a: p, b: q })
        // A line that ends on another piece's end, or on the sheet's zero,
        // has arrived; one that ends on the open sheet is the start of the
        // next, as CAD chains them — Escape, or a click on the same spot,
        // ends the chain. On an axis or on a piece's body the chain runs
        // on: the end is held there, not arrived.
        if (!snaps[1] || 'datum' in snaps[1] || 'piece' in snaps[1]) carry = { entity: id, at: 'b' }
        if (snaps[0]) holdAt(sketch, { entity: id, at: 'a' }, snaps[0])
        if (snaps[1]) holdAt(sketch, { entity: id, at: 'b' }, snaps[1])
        // A line drawn nearly level or nearly upright was meant so: it gets
        // the relation, as a CAD sketcher infers it, shown as a chip that
        // can be taken off again.
        const axis = axisRelationOf(p, q)
        if (axis) addConstraint(sketch, { kind: axis, entity: id, inferred: true })
      } else if (d.tool === 'rectangle') {
        const mode = modes.rectangle
        const corners = rectangleCorners(mode, pending)
        if (!corners) return { sketchDraft: { ...d, ...toolIdle(), error: 'That rectangle has no area — the clicks lie on a line.' } }
        // The corners the clicks landed on are held where they snapped; the
        // two-corner and centre ways make their lines from the sorted
        // corners, so each click's corner is found again by where it lies.
        const ids = mode === 'threePoint' ? addTurnedRectangle(sketch, corners) : addRectangle(sketch, corners[0], corners[2])
        const cornerOf = (pt: Vec2) =>
          ids.find((i) => {
            const e = entityOf(sketch, i)
            return e?.kind === 'line' && len2(sub2(e.a, pt)) < 1e-9
          })
        const held: [Vec2, SnapHold | null][] = mode === 'center' ? [[q, snaps[1]]] : [[p, snaps[0]], [q, snaps[1]]]
        for (const [pt, hold] of held) {
          const id = hold ? cornerOf(pt) : undefined
          if (hold && id !== undefined) holdAt(sketch, { entity: id, at: 'a' }, hold)
        }
        if (mode === 'center') {
          // The centre is a point of its own where the diagonals cross,
          // held where the first click snapped: the rectangle stays about
          // it as it is dimensioned.
          const centre = addRectangleCentre(sketch, ids)
          if (snaps[0]) holdAt(sketch, { entity: centre, at: 'center' }, snaps[0])
        }
        // The third click of the three-point way says where the far side
        // lies; on another piece's end, the far side runs through it.
        if (mode === 'threePoint' && snaps[2] && isAnchor(snaps[2])) addConstraint(sketch, { kind: 'pointOn', p: snaps[2], on: { line: ids[2] } })
      } else if (d.tool === 'polygon') {
        const made = addPolygon(sketch, p, q, useRePrefs.getState().polygonSides, modes.polygon)
        if (!made) return { sketchDraft: { ...d, ...toolIdle(), error: 'That polygon has no size — click the centre, then a corner or the middle of a side.' } }
        // The centre is held where it snapped, as a circle's is; a corner
        // put on another piece's end goes through it.
        if (snaps[0]) holdAt(sketch, { entity: made.circle, at: 'center' }, snaps[0])
        if (snaps[1] && isAnchor(snaps[1]) && modes.polygon === 'inscribed') addConstraint(sketch, { kind: 'coincident', p: snaps[1], q: { entity: made.lines[0], at: 'a' } })
      } else if (d.tool === 'circle') {
        const mode = modes.circle
        const circle = circleFrom(mode, pending)
        if (!circle) return { sketchDraft: { ...d, ...toolIdle(), error: 'The three points lie on a line — no circle runs through them.' } }
        const id = addEntity(sketch, { kind: 'circle', ...circle })
        // A centre placed on an end, a centre, an axis or a piece is held
        // there, as a hole's centre is placed on the line it sits along; a
        // point of the rim placed on another piece's end runs through it.
        if (mode === 'center') {
          if (snaps[0]) holdAt(sketch, { entity: id, at: 'center' }, snaps[0])
        } else {
          for (const hold of snaps) if (hold && isAnchor(hold)) addConstraint(sketch, { kind: 'pointOn', p: hold, on: { curve: id } })
        }
      } else if (modes.arc === 'center') {
        // The centre, the start, and where it ends: the end click gives the
        // direction only, the start the radius.
        const arc = arcAbout(p, q, r)
        if (!arc) return { sketchDraft: { ...d, ...toolIdle(), error: 'The start lies on the centre — the arc has no radius.' } }
        const id = addEntity(sketch, { kind: 'arc', c: arc.c, r: arc.r, start: arc.start, sweep: arc.sweep })
        if (snaps[0]) holdAt(sketch, { entity: id, at: 'center' }, snaps[0])
        if (snaps[1]) holdAt(sketch, { entity: id, at: arc.startsAtP ? 'a' : 'b' }, snaps[1])
      } else {
        // Three points: start, end, and one the arc passes through.
        const arc = arcThrough(p, q, r)
        if (!arc) return { sketchDraft: { ...d, ...toolIdle(), error: 'The three points lie on a line — no arc runs through them.' } }
        const id = addEntity(sketch, { kind: 'arc', ...arc })
        if (snaps[0]) holdAt(sketch, { entity: id, at: arc.startsAtP ? 'a' : 'b' }, snaps[0])
        if (snaps[1]) holdAt(sketch, { entity: id, at: arc.startsAtP ? 'b' : 'a' }, snaps[1])
      }
      const next = settle({ ...d, sketch, ...toolIdle() }, before)
      // From where the solver left the end, not from where it was clicked:
      // a line made level has moved under the hand.
      const end = carry ? entityOf(next.sketch, carry.entity) : null
      return { sketchDraft: carry && end ? { ...next, pending: [anchorPoint(end, carry.at)], snaps: [carry], chain: carry } : next }
    })
  },

  sketchTangentArc: (spot, radius, snapCtx = {}) =>
    set((s) => {
      const d = s.sketchDraft
      if (!d || !d.chain) return {}
      const from = chainArcStart(d, d.pending[0], Infinity)
      if (!from) return {}
      const chain = d.chain
      const snap = snapSketchPoint(d.sketch, spot, radius, snapCtx)
      const arc = tangentArc(from.p, from.t, snap.point)
      if (!arc) return { sketchDraft: { ...d, error: 'Straight ahead no arc is tangent — drag to one side.' } }
      const before = cloneSketch(d.sketch)
      const { startsAtP, ...shape } = arc
      const id = addEntity(d.sketch, { kind: 'arc', ...shape })
      const near: AnchorAt = startsAtP ? 'a' : 'b'
      const far: AnchorAt = startsAtP ? 'b' : 'a'
      addConstraint(d.sketch, { kind: 'coincident', p: { entity: id, at: near }, q: chain })
      addConstraint(d.sketch, { kind: 'tangent', a: chain.entity, b: id })
      const hold = snapHold(snap)
      if (hold) holdAt(d.sketch, { entity: id, at: far }, hold)
      const next = settle({ ...d, ...toolIdle() }, before)
      // The chain runs on from the arc's far end, unless it landed on a
      // piece's end and has arrived.
      const end = snap.anchor ? null : entityOf(next.sketch, id)
      const carry: Anchor = { entity: id, at: far }
      return { sketchDraft: end ? { ...next, pending: [anchorPoint(end, far)], snaps: [carry], chain: carry } : next }
    }),

  finishSpline: (closed = false) => set((s) => (s.sketchDraft?.tool === 'spline' ? { sketchDraft: splineDraft(s.sketchDraft, closed) } : {})),

  moveSplinePoint: (index, p) =>
    set((s) => {
      const d = s.sketchDraft
      if (d?.tool !== 'spline' || !d.pending[index]) return {}
      // Moved by hand, it is held to nothing it snapped to when clicked.
      const snaps = (d.snaps ?? []).map((h, i) => (i === index ? null : h))
      return { sketchDraft: { ...d, pending: d.pending.map((q, i): Vec2 => (i === index ? [p[0], p[1]] : q)), snaps } }
    }),

  fitSplinesToSlice: (chains) =>
    set((s) => {
      const d = s.sketchDraft
      if (!d) return {}
      const splines = d.selection.map((id) => entityOf(d.sketch, id)).filter((e): e is SketchSpline => e?.kind === 'spline')
      if (splines.length === 0) return { sketchDraft: { ...d, error: 'Select a spline to fit to the slice.' } }
      const slice = chains.flat()
      if (slice.length === 0) return { sketchDraft: { ...d, error: 'There is no slice on this plane to fit to.' } }
      const before = cloneSketch(d.sketch)
      const missed: number[] = []
      for (const e of splines) {
        const made = fitSplineToPoints(e, slice)
        if (!made) missed.push(e.id)
        else d.sketch.entities = d.sketch.entities.map((x) => (x.id === e.id ? made : x))
      }
      if (missed.length === splines.length) return { sketchDraft: { ...d, sketch: before, error: 'No slice points lie along the spline — draw it over the slice, within a few millimetres of it.' } }
      const settled = settle({ ...d }, before)
      // How far the points still lie off the curve settled onto them is the
      // weight they carry: a clean cut holds the curve, a noisy one less.
      settled.sketch.entities = settled.sketch.entities.map((x) => (x.kind === 'spline' && splines.some((e) => e.id === x.id) && x.points ? { ...x, scatter: splineScatter(x) } : x))
      return { sketchDraft: { ...settle(settled), error: missed.length > 0 ? `No slice points lie along spline ${missed.join(', ')}.` : null } }
    }),

  sketchBoxSelect: (corners, crossing, additive) =>
    set((s) => {
      const d = s.sketchDraft
      if (!d || d.tool !== 'select') return {}
      const taken = piecesInBox(d.sketch, corners, crossing)
      const selection = additive ? [...d.selection, ...taken.filter((id) => !d.selection.includes(id))] : taken
      return { sketchDraft: { ...d, selection, selectedConstraint: null, error: null } }
    }),

  sketchDragStart: (spot, radius) => {
    const s = get()
    const d = s.sketchDraft
    if (!d || d.tool !== 'select' || d.pending.length > 0 || d.imagePick) return false
    const handle = dragHandleAt(d.sketch, spot, radius)
    if (!handle) return false
    const e = entityOf(d.sketch, handle.entity)
    if (!e || e.fixed) return false
    // Nothing changes yet: a press let go where it landed is a click, and
    // the click is what selects — a selection made here would be the one
    // that click then takes off again.
    const rigid = rigidCluster(d.sketch, handle)
    sketchDrag = { entity: handle.entity, at: handle.at, start: spot, origin: detached(e), last: spot, snapped: null, pull: [], begun: false, rigid: rigid ? (JSON.parse(JSON.stringify(rigid.map((id) => entityOf(d.sketch, id)!))) as SketchEntity[]) : null }
    return true
  },

  sketchDrag: (spot, radius, snapCtx) =>
    set((s) => {
      const drag = sketchDrag
      if (!s.sketchDraft || !drag) return {}
      // The sketch as it stands goes into the history once, with the first
      // move: the drag is one edit however many moves it takes, and the
      // piece in the hand is the selection.
      const d: SketchDraft = drag.begun
        ? s.sketchDraft
        : { ...s.sketchDraft, future: [], history: [...s.sketchDraft.history.slice(-(MAX_HISTORY - 1)), cloneSketch(s.sketchDraft.sketch)], selection: [drag.entity], selectedConstraint: null, error: null }
      drag.begun = true
      const e = entityOf(d.sketch, drag.entity)
      if (!e) return {}
      const sketch = d.sketch
      const pull: Pull[] = []
      if (drag.rigid) {
        // The whole shape goes with the hand, as it is: by the hand's move
        // for a piece carried, by where the end or centre snaps for a point
        // — other pieces, the slice, the axes and the zero, not the shape's
        // own, which moves with it.
        let delta: Vec2
        if (drag.at === 'body') {
          delta = sub2(spot, drag.start)
          drag.snapped = null
          drag.last = spot
        } else {
          const snap = snapSketchPoint(sketch, spot, radius, snapCtx, new Set(drag.rigid.map((x) => x.id)))
          delta = sub2(snap.point, anchorPoint(drag.origin, drag.at))
          drag.snapped = snapHold(snap)
          drag.last = snap.point
        }
        const carried = new Map(drag.rigid.map((x) => [x.id, translateEntity(x, delta)]))
        sketch.entities = sketch.entities.map((x) => carried.get(x.id) ?? x)
        const held = carried.get(drag.entity)!
        for (const at of drag.at === 'body' ? anchorsOf(held) : [drag.at]) pull.push({ anchor: { entity: held.id, at }, to: anchorPoint(held, at) })
        drag.pull = pull
        return { sketchDraft: settle({ ...d, sketch }, undefined, pull, true) }
      }
      let moved: SketchEntity
      if (drag.at === 'body') {
        // The whole piece rides with the hand, raw: a body has no one point
        // to snap by. A line moves square to itself — along its own length
        // there is nothing to move it to, and a side of a profile is set
        // by how far in it stands — unless Ctrl asks for it free.
        // From where the drag began, not from the last step: a step's solve
        // may stop short, and a piece carried on from where it got to would
        // fall behind the hand a little more at every step.
        let delta = sub2(spot, drag.start)
        const dir = e.kind === 'line' && !snapCtx.off ? lineDir(e) : null
        if (dir) {
          const n = perp2(dir)
          delta = scale2(n, dot2(delta, n))
        }
        moved = translateEntity(drag.origin, delta)
        drag.last = spot
        for (const at of anchorsOf(moved)) pull.push({ anchor: { entity: moved.id, at }, to: anchorPoint(moved, at) })
        drag.snapped = null
      } else {
        // An end or a centre lands on what is near — another end, a slice
        // point, the grid — and the hand's piece is left out of the search,
        // or it would snap to itself.
        const snap = snapSketchPoint(sketch, spot, radius, snapCtx, new Set([e.id]))
        moved = moveAnchor(detached(e), drag.at, snap.point)
        drag.last = snap.point
        drag.snapped = snapHold(snap)
        pull.push({ anchor: { entity: moved.id, at: drag.at }, to: snap.point })
      }
      drag.pull = pull
      sketch.entities = sketch.entities.map((x) => (x.id === moved.id ? moved : x))
      // The piece dragged out of its slice points is free now; the fitted
      // chain it belonged to is left as it is.
      const fitted = { ...d.fitted }
      for (const [k, f] of Object.entries(fitted)) {
        if (f.order.some((p) => p.id === moved.id)) fitted[Number(k)] = { ...f, order: f.order.filter((p) => p.id !== moved.id) }
      }
      return { sketchDraft: settle({ ...d, sketch, fitted }, undefined, pull, true) }
    }),

  sketchDragEnd: () =>
    set((s) => {
      const d = s.sketchDraft
      const drag = sketchDrag
      sketchDrag = null
      if (!d || !drag || !drag.begun) return {}
      // Dropped on another piece's end, its body, an axis or the zero:
      // held there, as a drawn end is — unless it is held so already.
      if (drag.at !== 'body' && drag.snapped) holdAt(d.sketch, { entity: drag.entity, at: drag.at }, drag.snapped)
      // Settled once more in full, the hand still on the piece where it let
      // go: the drag's steps were solved briefly, and this is what puts the
      // piece exactly where the hand left it, the constraints holding.
      return { sketchDraft: settle({ ...d }, undefined, drag.pull) }
    }),

  alignToSelected: () =>
    set((s) => {
      const d = s.sketchDraft
      if (!d) return {}
      const picked = d.selection.map((id) => entityOf(d.sketch, id)).filter((e): e is SketchEntity => Boolean(e))
      const line = picked.length === 1 && picked[0].kind === 'line' ? picked[0] : null
      if (!line) return { sketchDraft: { ...d, error: 'Select one line to lay the sheet along.' } }
      const dir = normalize([line.b[0] - line.a[0], line.b[1] - line.a[1], 0])
      if (!dir) return { sketchDraft: { ...d, error: 'The line has no length.' } }
      // The sheet turns by the line's angle, the drawing turns back by the
      // same, and every point stays where it is on the part.
      const theta = Math.atan2(dir[1], dir[0])
      const before = cloneSketch(d.sketch)
      rotateSketch(d.sketch, -theta)
      const basisU = addScaled(scale(d.frame.basisU, Math.cos(theta)), d.frame.basisV, Math.sin(theta))
      const basisV = cross(d.frame.normal, basisU)
      const frame: SectionFrame = { ...d.frame, basisU, basisV }
      return { sketchDraft: settle({ ...d, frame, ...toolIdle() }, before) }
    }),

  autoFit: (chains, which, options = DEFAULT_FIT_OPTIONS, share) =>
    set((s) => {
      const d = s.sketchDraft
      if (!d) return {}
      const before = rememberFitted(cloneSketch(d.sketch), d.fitted)
      const sketch = d.sketch
      const fitted = { ...d.fitted }
      const targets = which === 'all' ? chains.map((_, i) => i) : [which]
      // The pieces the chains land on: those the sketch held before this
      // fit, not each other's.
      const pieces = share !== undefined && share > 0 ? sharePieces(sketch) : []
      const report: ShareReport | undefined = pieces.length > 0 ? { chains: {}, shared: [], junctions: [], corners: 0 } : undefined
      let error: string | null = null
      for (const i of targets) {
        if (!chains[i] || fitted[i]) continue
        error = (report ? fitChainShared(sketch, fitted, i, chains[i], d.tolerance, options, pieces, share!, report) : fitChain(sketch, fitted, i, chains[i], d.tolerance, options)) ?? error
      }
      const { shareReport: _last, ...rest } = d
      void _last
      let next = settle({ ...rest, sketch, fitted, selection: [], ...(report ? { shareReport: report } : {}) }, before)
      // A landing the sketch does not solve with is let go, and the sketch
      // solved again without it. Solved twice to tell: a solve that met
      // everything by running an arc's end round past its other end (its
      // sweep the rest of the turn) is met no more from where it left it.
      if (report && report.junctions.length > 0)
        letGo(next.sketch, report.junctions, () => {
          next = settle(next)
          return next.report && !next.report.ok ? new Map(next.report.unmet.map((u) => [u.id, u.residual])) : null
        })
      return { sketchDraft: { ...next, error } }
    }),

  refitChains: (chains, options = DEFAULT_FIT_OPTIONS) =>
    set((s) => {
      const d = s.sketchDraft
      if (!d || Object.keys(d.fitted).length === 0) return {}
      const before = rememberFitted(cloneSketch(d.sketch), d.fitted)
      const sketch = d.sketch
      const fitted = { ...d.fitted }
      let error: string | null = null
      for (const key of Object.keys(d.fitted)) {
        const i = Number(key)
        if (!chains[i]) continue
        const was = fitted[i]
        removeEntities(sketch, [...was.order.map((p) => p.id), ...(was.runs ?? []).flat().map((p) => p.id), ...(was.bridges ?? [])])
        delete fitted[i]
        // A chain fitted onto the pieces there lands on them again.
        const pieces = was.share !== undefined ? sharePieces(sketch) : []
        error = (pieces.length > 0 ? fitChainShared(sketch, fitted, i, chains[i], d.tolerance, options, pieces, was.share!, { chains: {}, shared: [], junctions: [], corners: 0 }) : fitChain(sketch, fitted, i, chains[i], d.tolerance, options)) ?? error
      }
      return { sketchDraft: { ...settle({ ...d, sketch, fitted, selection: [], selectedConstraint: null, pending: [] }, before), error } }
    }),

  inferAllCorners: () =>
    set((s) => {
      const d = s.sketchDraft
      if (!d) return {}
      const before = cloneSketch(d.sketch)
      let joined = 0
      let open = 0
      for (const f of Object.values(d.fitted)) {
        const order = f.order.filter((p) => entityOf(d.sketch, p.id))
        const report = inferCorners(d.sketch, order, f.closed, CORNER_GAP_MM)
        joined += report.joined
        open += report.open
      }
      const next = settle({ ...d }, before)
      // Nothing joined with nothing open is a fit that joined its corners
      // itself: there is nothing to say.
      return { sketchDraft: { ...next, error: joined === 0 && open > 0 ? `No two ends lie within ${fmtLen(CORNER_GAP_MM, usePrefs.getState().units, 0)} of each other — use Close for wider gaps.` : null } }
    }),

  closeAll: () =>
    set((s) => {
      const d = s.sketchDraft
      if (!d) return {}
      const before = cloneSketch(d.sketch)
      let closed = 0
      const fitted = { ...d.fitted }
      for (const [key, f] of Object.entries(d.fitted)) {
        const order = f.order.filter((p) => entityOf(d.sketch, p.id))
        const had = new Set(d.sketch.entities.map((e) => e.id))
        closed += closeChain(d.sketch, order, CORNER_GAP_MM)
        // The bridges drawn belong to this chain's fit, and go with it on a refit.
        const bridges = d.sketch.entities.filter((e) => !had.has(e.id)).map((e) => e.id)
        if (bridges.length > 0) fitted[Number(key)] = { ...f, bridges: [...(f.bridges ?? []), ...bridges] }
      }
      const next = settle({ ...d, fitted }, before)
      return { sketchDraft: { ...next, error: closed === 0 ? 'Nothing left to close.' : null } }
    }),

  joinSelected: () =>
    set((s) => {
      const d = s.sketchDraft
      if (!d || d.selection.length !== 2) return {}
      const a = entityOf(d.sketch, d.selection[0])
      const b = entityOf(d.sketch, d.selection[1])
      if (!a || !b) return {}
      const ends = nearestEnds(a, b)
      if (!ends) return { sketchDraft: { ...d, error: 'A circle has no end to join.' } }
      const before = cloneSketch(d.sketch)
      joinEnds(d.sketch, ends[0], ends[1], Infinity)
      return { sketchDraft: settle({ ...d }, before) }
    }),

  addRelation: (kind) =>
    set((s) => {
      const d = s.sketchDraft
      if (!d) return {}
      const picked = d.selection.map((id) => entityOf(d.sketch, id)).filter((e): e is SketchEntity => Boolean(e))
      const before = cloneSketch(d.sketch)
      if (kind === 'coincident') {
        // On two selected pieces: two lines lie along each other; a
        // circle meets by its centre; anything else meets at its nearest
        // ends. With fewer, the key takes the relation in hand to click
        // its two picks on the sheet.
        if (picked.length !== 2) return { sketchDraft: { ...d, ...toolIdle(), tool: 'relation', armedRelation: 'coincident', selection: [], selectedConstraint: null, error: null } }
        if (picked[0].kind === 'line' && picked[1].kind === 'line') {
          const id = addConstraint(d.sketch, { kind: 'collinear', line: picked[0].id, on: { line: picked[1].id } })
          return { sketchDraft: { ...settle({ ...d }, before), selectedConstraint: id } }
        }
        const ends = nearestEnds(picked[0], picked[1])
        if (!ends) {
          const circle = picked.find((e) => e.kind === 'circle')
          const other = picked.find((e) => e !== circle)
          if (!circle || !other) return { sketchDraft: { ...d, error: 'Two circles are held by Concentric, not Coincident.' } }
          const made = coincidentFor(d.sketch, { kind: 'point', anchor: { entity: circle.id, at: 'center' } }, { kind: 'piece', id: other.id })
          if (typeof made === 'string') return { sketchDraft: { ...d, error: made } }
          const id = addConstraint(d.sketch, made)
          return { sketchDraft: { ...settle({ ...d }, before), selectedConstraint: id } }
        }
        joinEnds(d.sketch, ends[0], ends[1], Infinity)
        return { sketchDraft: settle({ ...d }, before) }
      }
      if (kind === 'symmetric') {
        // Two pieces and the line they mirror about, in the order picked.
        // With the two selected the key takes the relation in hand and the
        // next click is the mirror line.
        if (picked.length === 2) return { sketchDraft: { ...d, ...toolIdle(), tool: 'relation', armedRelation: 'symmetric', selectedConstraint: null, error: null } }
        if (picked.length !== 3) return { sketchDraft: { ...d, error: 'Symmetric takes the two pieces that mirror each other, then the line they mirror about.' } }
        return { sketchDraft: holdSymmetric(d, picked[0], picked[1], picked[2]) }
      }
      if (!relationTakes(kind, picked)) {
        return { sketchDraft: { ...d, error: `${kind[0].toUpperCase()}${kind.slice(1)} does not apply to what is selected.` } }
      }
      if (kind === 'tangent') {
        // A spline is held tangent where one of its ends meets the other.
        const spline = picked.find((e) => e.kind === 'spline')
        const other = picked.find((e) => e !== spline)
        if (spline && other && !splineJoint(d.sketch, spline.id, other.id)) return { sketchDraft: { ...d, error: 'Join an end of the spline to the other piece first — a spline is held tangent where it ends.' } }
      }
      switch (kind) {
        case 'horizontal':
        case 'vertical':
          for (const e of picked) addConstraint(d.sketch, { kind, entity: e.id })
          break
        case 'parallel':
        case 'perpendicular':
        case 'tangent':
        case 'concentric':
        case 'equal':
          addConstraint(d.sketch, { kind, a: picked[0].id, b: picked[1].id })
          break
        default:
          return {}
      }
      return { sketchDraft: settle({ ...d }, before) }
    }),

  addDimension: (kind, value) =>
    set((s) => {
      const d = s.sketchDraft
      if (!d) return {}
      const picked = d.selection.map((id) => entityOf(d.sketch, id)).filter((e): e is SketchEntity => Boolean(e))
      const before = cloneSketch(d.sketch)
      let measured: number | null = null
      let constraint: ConstraintInput | null = null
      if (kind === 'length' && picked.length === 1 && picked[0].kind === 'line') {
        measured = measureDimension(d.sketch, 'length', picked[0])
        constraint = { kind: 'length', entity: picked[0].id, value: value ?? measured ?? 0 }
      } else if ((kind === 'radius' || kind === 'diameter') && picked.length === 1 && (picked[0].kind === 'arc' || picked[0].kind === 'circle')) {
        measured = measureDimension(d.sketch, kind, picked[0])
        constraint = { kind, entity: picked[0].id, value: value ?? measured ?? 0 }
      } else if (kind === 'angle' && picked.length === 2 && picked.every((e) => e.kind === 'line')) {
        measured = measureDimension(d.sketch, 'angle', picked[0], picked[1])
        constraint = { kind: 'angle', a: picked[0].id, b: picked[1].id, value: value ?? measured ?? 0 }
      } else if (kind === 'distance' && picked.length === 2) {
        const [a, b] = picked
        const pointOf = (e: SketchEntity): Anchor | null =>
          e.kind === 'point' || e.kind === 'circle' || e.kind === 'arc' ? { entity: e.id, at: 'center' } : null
        if (a.kind === 'line' && b.kind === 'line') {
          // Between two lines: from the first line's start to the second.
          measured = measureDimension(d.sketch, 'distance', { entity: a.id, at: 'a' }, { line: b.id })
          constraint = { kind: 'distance', p: { entity: a.id, at: 'a' }, q: { line: b.id }, value: value ?? measured ?? 0 }
        } else if (a.kind === 'line' || b.kind === 'line') {
          const line = a.kind === 'line' ? a : b
          const other = pointOf(a.kind === 'line' ? b : a)
          if (other) {
            measured = measureDimension(d.sketch, 'distance', other, { line: line.id })
            constraint = { kind: 'distance', p: other, q: { line: line.id }, value: value ?? measured ?? 0 }
          }
        } else {
          const pa = pointOf(a)
          const pb = pointOf(b)
          if (pa && pb) {
            measured = measureDimension(d.sketch, 'distance', pa, pb)
            constraint = { kind: 'distance', p: pa, q: pb, value: value ?? measured ?? 0 }
          }
        }
      }
      if (!constraint) return { sketchDraft: { ...d, error: 'That dimension does not apply to what is selected.' } }
      const id = addConstraint(d.sketch, constraint)
      return { sketchDraft: { ...settle({ ...d }, before), selectedConstraint: id } }
    }),

  dimensionSelection: () =>
    set((s) => {
      const d = s.sketchDraft
      if (!d) return {}
      const [a, b] = d.selection
      const constraint =
        a === undefined || d.selection.length > 2
          ? null
          : dimensionFor(d.sketch, { kind: 'piece', id: a }, b === undefined ? null : { kind: 'piece', id: b }, datumTraces(d.frame))
      if (!constraint) return { sketchDraft: { ...d, error: 'No dimension applies to what is selected — one piece, or two.' } }
      // In hand, as one made by the Dimension tool's clicks: one piece is
      // still a pick to pair with.
      const held = holdDimension({ ...dropDimension(d), ...toolIdle(), tool: 'dimension', armedRelation: null }, constraint, b === undefined ? { kind: 'piece', id: a } : null)
      return { sketchDraft: held }
    }),

  setDimensionValue: (id, value, expr = null) =>
    set((s) => {
      const d = s.sketchDraft
      if (!d) return {}
      // A field left as it was — the blur of one that was only looked at —
      // changes nothing and is no step to undo.
      const held = d.sketch.constraints.find((c) => c.id === id)
      if (!held || !('value' in held) || (Math.abs(held.value - value) < 1e-12 && (held.expr ?? null) === expr)) return {}
      const before = cloneSketch(d.sketch)
      d.sketch.constraints = d.sketch.constraints.map((c) => {
        if (c.id !== id || !('value' in c)) return c
        const { expr: _expr, ...rest } = c
        void _expr
        return expr ? { ...rest, value, expr } : { ...rest, value }
      })
      return { sketchDraft: settle({ ...d, ...dimensionDone(d, id) }, before) }
    }),

  setDimensionForm: (id, form, typed, typedExpr = null) =>
    set((s) => {
      const d = s.sketchDraft
      if (!d) return {}
      const held = d.sketch.constraints.find((c) => c.id === id)
      if (!held || (held.kind !== 'radius' && held.kind !== 'diameter') || held.kind === form) return {}
      const before = cloneSketch(d.sketch)
      const kept = held.expr ? (form === 'diameter' ? `2 * (${held.expr})` : `(${held.expr}) / 2`) : null
      const value = typed ?? (form === 'diameter' ? 2 * held.value : held.value / 2)
      const expr = typed === undefined ? kept : typedExpr
      d.sketch.constraints = d.sketch.constraints.map((c) => {
        if (c !== held) return c
        const { expr: _expr, ...rest } = held
        void _expr
        return { ...rest, kind: form, value, ...(expr ? { expr } : {}) }
      })
      return { sketchDraft: settle({ ...d, ...(typed === undefined ? {} : dimensionDone(d, id)) }, before) }
    }),

  setDistanceAxis: (id, axis) =>
    set((s) => {
      const d = s.sketchDraft
      if (!d) return {}
      const held = d.sketch.constraints.find((c) => c.id === id)
      if (!held || held.kind !== 'distance' || (held.axis ?? null) === axis) return {}
      const ends = distanceEnds(held, d.sketch)
      if (!ends) return { sketchDraft: { ...d, error: 'Only a distance between two points is measured along an axis.' } }
      const before = cloneSketch(d.sketch)
      const { axis: _was, place: _place, ...rest } = held
      void _was
      void _place
      // At what the points measure that way now — nothing moves — unless an
      // expression drives it, which then says the new way's size. The
      // number goes back where the layout puts it.
      d.sketch.constraints = d.sketch.constraints.map((c) => (c === held ? { ...rest, ...(axis ? { axis } : {}), value: held.expr ? held.value : distanceAlong(ends[0], ends[1], axis ?? undefined) } : c))
      return { sketchDraft: { ...settle({ ...d }, before), selectedConstraint: id } }
    }),

  finishDimension: (id) =>
    set((s) => {
      const d = s.sketchDraft
      const done = d ? dimensionDone(d, id) : {}
      return d && 'dimPick' in done ? { sketchDraft: { ...d, ...done } } : {}
    }),

  removeSelectedConstraint: () =>
    set((s) => {
      const d = s.sketchDraft
      if (!d || d.selectedConstraint === null) return {}
      // The dimension in hand goes as Escape takes it back: never made.
      if (d.selectedConstraint === d.dimMade) return { sketchDraft: dropDimension(d) }
      const before = cloneSketch(d.sketch)
      // A Fix is taken off its piece: the piece is free to move again.
      const fixed = fixedEntityOf(d.selectedConstraint)
      if (fixed !== null) {
        d.sketch.entities = d.sketch.entities.map((e) => (e.id === fixed ? { ...e, fixed: false } : e))
        return { sketchDraft: settle({ ...d, selectedConstraint: null }, before) }
      }
      removeConstraint(d.sketch, d.selectedConstraint)
      return { sketchDraft: settle({ ...d, ...dimensionDone(d, d.selectedConstraint), selectedConstraint: null }, before) }
    }),

  selectConstraint: (id) =>
    set((s) => (s.sketchDraft ? { sketchDraft: { ...s.sketchDraft, selectedConstraint: id } } : {})),

  deleteSelected: () =>
    set((s) => {
      const d = s.sketchDraft
      if (!d || d.selection.length === 0) return {}
      const before = cloneSketch(d.sketch)
      removeEntities(d.sketch, d.selection)
      return { sketchDraft: settle({ ...d, selection: [] }, before) }
    }),

  sharpenSelected: () =>
    set((s) => {
      const d = s.sketchDraft
      if (!d) return {}
      const arcs = d.selection.filter((id) => ['arc', 'line'].includes(entityOf(d.sketch, id)?.kind ?? ''))
      if (arcs.length === 0) return { sketchDraft: { ...d, error: 'Select the fillet arc or the chamfer line to make sharp.' } }
      const before = cloneSketch(d.sketch)
      let done = 0
      for (const id of arcs) if (sharpenCorner(d.sketch, id)) done++
      if (done === 0) return { sketchDraft: { ...d, error: 'The piece is not a fillet or a chamfer between two lines.' } }
      return { sketchDraft: settle({ ...d, selection: [] }, before) }
    }),

  filletSelected: () =>
    set((s) => {
      const d = s.sketchDraft
      if (!d) return {}
      if (d.selection.length !== 2) return { sketchDraft: { ...d, error: 'Select the two lines of the corner to round.' } }
      return { sketchDraft: filletDraft(d, d.selection[0], d.selection[1]) }
    }),

  chamferSelected: () =>
    set((s) => {
      const d = s.sketchDraft
      if (!d) return {}
      if (d.selection.length !== 2) return { sketchDraft: { ...d, error: 'Select the two lines of the corner to chamfer.' } }
      return { sketchDraft: chamferDraft(d, d.selection[0], d.selection[1]) }
    }),

  moveDimension: (id, p, begin) =>
    set((s) => {
      const d = s.sketchDraft
      const held = d?.sketch.constraints.find((c) => c.id === id)
      if (!d || !held || !isDimension(held)) return {}
      const place = dimPlaceAt(held, d.sketch, p, datumTraces(d.frame))
      if (!place) return {}
      // Where a number is written changes nothing the solver reads.
      const history = begin ? [...d.history.slice(-(MAX_HISTORY - 1)), cloneSketch(d.sketch)] : d.history
      d.sketch.constraints = d.sketch.constraints.map((c) => (c.id === id ? { ...c, place } : c))
      return { sketchDraft: { ...d, history, ...(begin ? { future: [] } : {}) } }
    }),

  toggleFixedSelected: () =>
    set((s) => {
      const d = s.sketchDraft
      if (!d || d.selection.length === 0) return {}
      const before = cloneSketch(d.sketch)
      // A projected piece stays where the part put it.
      const mine = d.selection.filter((id) => !entityOf(d.sketch, id)?.projected)
      const allFixed = mine.every((id) => entityOf(d.sketch, id)?.fixed)
      d.sketch.entities = d.sketch.entities.map((e) => (mine.includes(e.id) ? { ...e, fixed: !allFixed } : e))
      return { sketchDraft: settle({ ...d }, before) }
    }),

  toggleConstructionSelected: () =>
    set((s) => {
      const d = s.sketchDraft
      if (!d || d.selection.length === 0) return {}
      const before = cloneSketch(d.sketch)
      const all = d.selection.every((id) => entityOf(d.sketch, id)?.construction)
      d.sketch.entities = d.sketch.entities.map((e) => (d.selection.includes(e.id) ? { ...e, construction: !all } : e))
      return { sketchDraft: settle({ ...d }, before) }
    }),

  clearSelection: () =>
    set((s) => (s.sketchDraft ? { sketchDraft: { ...dropDimension(s.sketchDraft), ...toolIdle(), selection: [], selectedConstraint: null, pattern: null, imagePick: null } } : {})),

  openSketchPattern: () =>
    set((s) => {
      const d = s.sketchDraft
      if (!d) return {}
      if (d.selection.length === 0) return { sketchDraft: { ...d, error: 'Select the pieces to repeat first.' } }
      const b = sketchBounds({ entities: d.sketch.entities.filter((e) => d.selection.includes(e.id)) })
      const width = b ? b.max[0] - b.min[0] : 0
      // Clear of the pieces by half their width, on a round number.
      const step = width > 1e-6 ? nominalOf(width * 1.5, 'length') ?? width * 1.5 : 10
      return { sketchDraft: { ...d, ...toolIdle(), tool: 'select', error: null, pattern: { kind: 'rectangular', step: [step, 0], count: 3 } } }
    }),
  setSketchPattern: (pattern) => set((s) => (s.sketchDraft ? { sketchDraft: { ...s.sketchDraft, pattern, error: null } } : {})),
  applySketchPattern: () =>
    set((s) => {
      const d = s.sketchDraft
      if (!d?.pattern) return {}
      if (d.selection.length === 0) return { sketchDraft: { ...d, error: 'Select the pieces to repeat.' } }
      const before = cloneSketch(d.sketch)
      const copies = patternPieces(d.sketch, d.selection, d.pattern)
      if (copies.length === 0) return { sketchDraft: { ...d, pattern: null, error: 'The pattern makes no copies — give it a count of two or more.' } }
      return { sketchDraft: { ...settle({ ...d, pattern: null }, before), selection: copies.flat() } }
    }),
  cancelSketchPattern: () => set((s) => (s.sketchDraft ? { sketchDraft: { ...s.sketchDraft, pattern: null } } : {})),

  putDownDimension: () =>
    set((s) => (s.sketchDraft?.dimMade != null ? { sketchDraft: putDownDimension(s.sketchDraft, null) } : {})),

  undoSketch: () =>
    set((s) => {
      const d = s.sketchDraft
      if (!d || d.history.length === 0) return {}
      const history = d.history.slice(0, -1)
      const sketch = d.history[d.history.length - 1]
      const current = cloneSketch(d.sketch)
      fittedBefore.set(current, d.fitted)
      const future = [...(d.future ?? []), current]
      // A fit or a refit remembered which chains its "before" had fitted;
      // anything else keeps the chains whose pieces are all still there.
      let fitted: SketchDraft['fitted'] = {}
      const remembered = fittedBefore.get(sketch)
      if (remembered) fitted = remembered
      else {
        for (const [k, f] of Object.entries(d.fitted)) {
          if (f.order.every((p) => sketch.entities.some((e) => e.id === p.id))) fitted[Number(k)] = f
        }
      }
      return { sketchDraft: settle({ ...d, ...toolIdle(), sketch, history, future, fitted, selection: [], selectedConstraint: null }) }
    }),

  redoSketch: () => set((s) => {
    const d = s.sketchDraft
    const sketch = d?.future?.at(-1)
    if (!d || !sketch) return {}
    const current = cloneSketch(d.sketch)
    fittedBefore.set(current, d.fitted)
    return { sketchDraft: settle({ ...d, ...toolIdle(), sketch,
      history: [...d.history.slice(-(MAX_HISTORY - 1)), current], future: d.future!.slice(0, -1),
      fitted: fittedBefore.get(sketch) ?? {}, selection: [], selectedConstraint: null }) }
  }),

  solveNow: () => set((s) => (s.sketchDraft ? { sketchDraft: settle({ ...s.sketchDraft }) } : {})),

  commitSketch: () => {
    const s = get()
    const d = s.sketchDraft
    if (!d) return null
    // Nothing drawn is nothing to keep: the box closes and no feature is
    // made — Finish on an empty sketch is how a sketch opened by mistake
    // goes away.
    // A sketch that held only a picture, the picture taken away, is
    // written back so: empty.
    const held = d.featureId !== undefined ? s.features.find((f) => f.id === d.featureId) : undefined
    if (d.sketch.entities.length === 0 && !d.image && !(held?.kind === 'sketch' && held.image)) {
      set({ sketchDraft: null, ...(d.featureId !== undefined ? { buildVersion: s.buildVersion + 1 } : {}) })
      return null
    }
    if (d.featureId !== undefined) {
      const id = d.featureId
      // Opened and closed with nothing done — every edit leaves a step in
      // the sketch's history — the feature is left exactly as it was, not
      // even solved again: the list the part is built from is the one it
      // was built from before the sketch was opened, which the worker still
      // holds and hands back without a rebuild. Nor is nothing an undo step.
      const stored = s.features.find((f) => f.id === id)
      const samePlace = stored?.kind === 'sketch' && planeOffset(stored.plane) === planeOffset(d.plane) && planeAngle(stored.plane) === planeAngle(d.plane) && stored.exprs?.offset === d.exprs?.offset && stored.image === d.image
      if (d.history.length === 0 && stored?.kind === 'sketch' && samePlace && (d.name.trim() || stored.name) === stored.name) {
        set({ sketchDraft: null, buildVersion: s.buildVersion + 1 })
        return id
      }
      const sketch = cloneSketch(d.sketch)
      // The features built on this sketch keep their faces: every pick is
      // matched to the region it names in the sketch as it is now (see
      // replaceSketch).
      set({
        ...remember(s),
        features: replaceSketch(s.features, id, sketch, { name: d.name.trim() || stored?.name, plane: d.plane, frame: d.frame, exprs: d.exprs, image: d.image }),
        sketchDraft: null,
        buildVersion: s.buildVersion + 1,
      })
      return id
    }
    const id = s.nextFeatureId
    const { nextOfKind } = nameFor(s, 'sketch')
    const feature: SketchFeature = {
      id,
      kind: 'sketch',
      name: d.name.trim() || `Sketch ${nextOfKind.sketch}`,
      plane: d.plane,
      frame: d.frame,
      sketch: cloneSketch(d.sketch),
      ...(d.exprs ? { exprs: { ...d.exprs } } : {}),
      ...(d.image ? { image: d.image } : {}),
      visible: true,
    }
    set({
      ...remember(s),
      features: [...s.features, feature],
      nextFeatureId: id + 1,
      nextOfKind,
      sketchDraft: null,
      buildVersion: s.buildVersion + 1,
    })
    return id
  },
  finishAndExtrude: () => {
    const id = get().commitSketch()
    if (id !== null) get().startExtrude(id, everyRegion(get().features.find((f): f is SketchFeature => f.kind === 'sketch' && f.id === id)?.sketch))
  },
  finishAndRevolve: () => {
    const id = get().commitSketch()
    if (id !== null) get().startRevolve(id, everyRegion(get().features.find((f): f is SketchFeature => f.kind === 'sketch' && f.id === id)?.sketch))
  },
})

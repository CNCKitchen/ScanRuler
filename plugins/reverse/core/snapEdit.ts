// SPDX-License-Identifier: AGPL-3.0-only
// Where a moved face's move goes. A face snapped onto the scan can be moved
// in two ways: by changing what made it — the distance of the extrude whose
// cap it is, the sketch line whose wall it is, the sketch circle whose bore
// or boss it is — or by working on the body as it stands (the Move face
// feature, kernel.offsetFaceTracked). The first is what a CAD operator would
// do by hand and is what is wanted wherever it can be had: the rounds, the
// drafts and the shells that come after the extrude are simply built again
// on the moved wall, where the second knows only the face's own outline and
// leaves a filleted face's rounds behind as a pad or a pocket.
//
// A face names the feature that made it (its fingerprint's `origin`, carried
// through every boolean by the builder), so the trace is: that feature, if
// it is an extrude or a revolve; its sketch; and in the sketch the piece
// whose lifted carrier the face lies on — for a revolve the line of its
// section square to the axis under a shoulder, the line along the axis at a
// bore's or a rim's radius. The move of a sketch piece goes through the
// solver, so the corners it shares follow and a dimension that holds the
// piece where it is says so instead of being overruled.
//
// Plain data in, plain data out: the feature list with the edit made, and a
// sentence for the box. Nothing here touches the kernel.

import type { Vec2 } from '../../../src/core/flat/types'
import type { Vec3 } from '../../../src/core/types'
import { cross, dot, len, sub } from '../../../src/core/vec'
import { datumTraces } from './datums'
import { detached, translateEntity } from './drag'
import { liftPoint, type ExtrudeFeature, type Feature, type ResolveContext, type RevolveFeature, type SketchFeature } from './features'
import { resolveAxis } from './resolve'
import { findRegions, matchRegions } from './regions'
import { addConstraint, addEntity, cloneSketch, removeConstraint, removeEntities, type Sketch, type SketchEntity } from './sketch'
import { solveSketch } from './solver'
import { unlinkSlot } from './parameters'
import type { FaceFingerprint } from './topo'
import { round3, round4, roundTo } from '../../../src/core/round'
import { lengthDecimals, toDisplay, unitWord, type DisplayUnits } from '../../../src/core/units'

export type SnapPlan =
  /** The edit of the history that moves the face: the features with it
   *  made, and what it is, for the box and the status line. */
  | { route: 'extent' | 'sketch'; features: Feature[]; text: string }
  /** No such edit: the face is moved on the body as it stands. `why` says
   *  what stood in the way. */
  | { route: 'direct'; why: string }

/** How near a face must lie to the cap or the carrier it is traced to,
 *  millimetres — past the kernel's own tolerance, short of any feature. */
const ON_MM = 2e-3
/** How far beyond the target the helper line of a moved wall is laid: the
 *  solver's point-to-line distance is |d| − value, smooth away from zero. */
const HELPER_MM = 10

/** A length of the box's sentence, in the units shown: three decimals in
 *  millimetres, as many more in inches as lengthDecimals gives, and no
 *  zeros carried behind. The unit's word follows it in the sentence. */
const lenText = (v: number, units: DisplayUnits) => (units === 'mm' ? `${round3(v)}` : `${roundTo(toDisplay(v, units), lengthDecimals(3, units))}`)

/** The features with one sketch replaced, the region picks of what is
 *  built on it matched onto the sketch as it now is — as a sketch edited
 *  by hand has them. */
function withSketch(features: readonly Feature[], sketchId: number, sketch: Sketch): Feature[] {
  const regions = findRegions(sketch)
  const rekey = (keys: string[]) => {
    const kept = matchRegions(keys, regions).map((r) => r.key)
    return kept.length > 0 ? kept : keys
  }
  return features.map((f) =>
    f.id === sketchId && f.kind === 'sketch' ? { ...f, sketch } : (f.kind === 'extrude' || f.kind === 'revolve') && f.sketchId === sketchId ? { ...f, regions: rekey(f.regions) } : f,
  )
}

/** An edit of a sketch as a plan — or none, where it changes how the
 *  sketch's profiles lie. A line run into a profile beside it makes the
 *  overlap a region of its own, which no extrude picked: the body would
 *  come out with a hole where the two meet, where a Move face on the body
 *  leaves the two bodies overlapping as the operator dragged them. */
function sketchPlan(features: readonly Feature[], sketch: SketchFeature, next: Sketch, text: string): SnapPlan {
  const was = findRegions(sketch.sketch)
  const now = findRegions(next)
  const built = features.filter((f): f is ExtrudeFeature | RevolveFeature => (f.kind === 'extrude' || f.kind === 'revolve') && f.sketchId === sketch.id)
  if (now.length !== was.length || built.some((f) => matchRegions(f.regions, now).length !== matchRegions(f.regions, was).length)) {
    return { route: 'direct', why: `the move would run a profile of ${sketch.name} into another, or open one` }
  }
  return { route: 'sketch', features: withSketch(features, sketch.id, next), text }
}

/** The sentence for constraints the solver could not meet after a move. */
const HELD = 'a dimension or a relation of the sketch holds it where it is'

function moveCap(features: readonly Feature[], maker: ExtrudeFeature, sketch: SketchFeature, face: FaceFingerprint, offset: number, units: DisplayUnits): SnapPlan {
  const n = sketch.frame.normal
  const along = dot(face.dir, n) > 0 ? 1 : -1
  const at = dot(sub(face.centroid, sketch.frame.origin), n)
  const e = maker.extent
  const ends = e.kind === 'distance' ? { from: e.from, to: e.to } : e.kind === 'symmetric' ? { from: -e.total / 2, to: e.total / 2 } : null
  if (!ends) return { route: 'direct', why: `${maker.name} reaches to a plane, not by a distance` }
  const side = Math.abs(at - ends.to) <= ON_MM ? 'to' : Math.abs(at - ends.from) <= ON_MM ? 'from' : null
  if (!side) return { route: 'direct', why: `the face is not an end of ${maker.name} any more` }
  const before = ends[side]
  const after = round4(before + along * offset)
  const next = { ...ends, [side]: after }
  if (Math.abs(next.to - next.from) < 1e-6) return { route: 'direct', why: `${maker.name} would have no length left` }
  // The end moved is a number now, not what an expression made it: left
  // linked, the next parameter pass put the end back and undid the move
  // (issue 34). A symmetric extent's total goes too — it is one no more.
  const edited: ExtrudeFeature = unlinkSlot(unlinkSlot({ ...maker, extent: { kind: 'distance', from: next.from, to: next.to } }, `extent.${side}`), 'extent.total')
  return {
    route: 'extent',
    features: features.map((f) => (f.id === maker.id ? edited : f)),
    text: `${maker.name}: ${side === 'to' ? 'To' : 'From'} ${lenText(before, units)} → ${lenText(after, units)} ${unitWord(units)}${e.kind === 'symmetric' ? ' (no longer symmetric)' : ''}`,
  }
}

function moveWall(features: readonly Feature[], maker: ExtrudeFeature | RevolveFeature, sketch: SketchFeature, face: FaceFingerprint, offset: number, units: DisplayUnits): SnapPlan {
  if (maker.kind === 'extrude' && maker.draftDeg) return { route: 'direct', why: `${maker.name} has a taper — its walls do not stand on the sketch's lines` }
  const frame = sketch.frame
  const off = (p: Vec3) => Math.abs(dot(sub(p, face.centroid), face.dir))
  // The line whose carrier the face lies on; of several in one carrier —
  // two steps of a profile in line — the one the face's middle is over.
  const to2 = (p: Vec3): Vec2 => [dot(sub(p, frame.origin), frame.basisU), dot(sub(p, frame.origin), frame.basisV)]
  const middle = to2(face.centroid)
  let line: Extract<SketchEntity, { kind: 'line' }> | null = null
  let nearest = Infinity
  for (const e of sketch.sketch.entities) {
    if (e.kind !== 'line' || e.construction) continue
    if (off(liftPoint(frame, e.a)) > ON_MM || off(liftPoint(frame, e.b)) > ON_MM) continue
    const d = Math.hypot((e.a[0] + e.b[0]) / 2 - middle[0], (e.a[1] + e.b[1]) / 2 - middle[1])
    if (d < nearest) {
      nearest = d
      line = e
    }
  }
  if (!line) return { route: 'direct', why: `no line of ${sketch.name} lies under this face` }

  // Square to the line, the way the face's normal reads on the sheet.
  const dir2: Vec2 = [dot(face.dir, frame.basisU), dot(face.dir, frame.basisV)]
  const l = Math.hypot(dir2[0], dir2[1])
  if (!(l > 1e-9)) return { route: 'direct', why: 'the face does not stand on the sketch plane' }
  const moved = moveLine(features, sketch, line, [dir2[0] / l, dir2[1] / l], offset, units)
  return moved.route === 'sketch' ? { ...moved, text: `${sketch.name}: the line under this face moves ${lenText(Math.abs(offset), units)} ${unitWord(units)} ${offset >= 0 ? 'out' : 'in'}` } : moved
}

/** A sketch line moved `offset` along `unit`, square to itself, through the
 *  solver — the corners it shares following. */
function moveLine(features: readonly Feature[], sketch: SketchFeature, line: Extract<SketchEntity, { kind: 'line' }>, unit: Vec2, offset: number, units: DisplayUnits): SnapPlan {
  if (line.fixed) return { route: 'direct', why: `the line of ${sketch.name} under this face is ${line.projected ? 'projected from the part' : 'fixed'}` }
  const delta: Vec2 = [unit[0] * offset, unit[1] * offset]

  const next = cloneSketch(sketch.sketch)
  const moved = translateEntity(detached(line), delta) as typeof line
  next.entities = next.entities.map((x) => (x.id === moved.id ? moved : x))
  // The wall is held on its new carrier while the solver carries the
  // corners after it: its two ends at a set distance from a fixed helper
  // line laid parallel beyond it, free to slide along — a neighbour that
  // meets it at a slant draws the corner along, not the wall off its place.
  const helper = addEntity(next, {
    kind: 'line',
    a: [moved.a[0] + unit[0] * HELPER_MM, moved.a[1] + unit[1] * HELPER_MM],
    b: [moved.b[0] + unit[0] * HELPER_MM, moved.b[1] + unit[1] * HELPER_MM],
    fixed: true,
    construction: true,
  })
  const holds = [
    addConstraint(next, { kind: 'distance', p: { entity: moved.id, at: 'a' }, q: { line: helper }, value: HELPER_MM }),
    addConstraint(next, { kind: 'distance', p: { entity: moved.id, at: 'b' }, q: { line: helper }, value: HELPER_MM }),
  ]
  const report = solveSketch(next, { datums: datumTraces(sketch.frame) })
  for (const id of holds) removeConstraint(next, id)
  removeEntities(next, [helper])
  if (!report.ok) return { route: 'direct', why: `the line of ${sketch.name} under this face cannot move — ${HELD}` }
  return sketchPlan(features, sketch, next, `${sketch.name}: a line moves ${lenText(Math.abs(offset), units)} ${unitWord(units)}`)
}

function resizeRound(features: readonly Feature[], maker: ExtrudeFeature, sketch: SketchFeature, face: FaceFingerprint, offset: number, units: DisplayUnits): SnapPlan {
  if (maker.draftDeg) return { route: 'direct', why: `${maker.name} has a taper — its round walls are cones` }
  if (face.radius === undefined || !face.center) return { route: 'direct', why: 'the round face has no axis' }
  const frame = sketch.frame
  let piece: Extract<SketchEntity, { kind: 'circle' | 'arc' }> | null = null
  for (const e of sketch.sketch.entities) {
    if ((e.kind !== 'circle' && e.kind !== 'arc') || e.construction) continue
    if (Math.abs(e.r - face.radius) > ON_MM) continue
    // The centre on the face's axis: its distance from the axis line.
    const c = sub(liftPoint(frame, e.c), face.center)
    if (len(cross(c, face.dir)) > ON_MM) continue
    piece = e
    break
  }
  if (!piece) return { route: 'direct', why: `no circle of ${sketch.name} lies under this face` }
  if (piece.fixed) return { route: 'direct', why: `the circle of ${sketch.name} under this face is ${piece.projected ? 'projected from the part' : 'fixed'}` }
  const radius = round4(piece.r + offset)
  if (!(radius > 1e-6)) return { route: 'direct', why: 'the radius would not be positive' }

  const next = cloneSketch(sketch.sketch)
  const id = piece.id
  next.entities = next.entities.map((x) => (x.id === id ? ({ ...detached(x), r: radius } as SketchEntity) : x))
  // A radius or a diameter dimension on the piece is what the operator
  // typed; the scan overrules it here, and the dimension reads the new
  // value. With none, one holds the radius for the length of the solve.
  const typed = next.constraints.find((c) => (c.kind === 'radius' || c.kind === 'diameter') && c.entity === id)
  // Its expression, if it had one, goes with the value it no longer gives.
  if (typed) {
    next.constraints = next.constraints.map((c) => {
      if (c !== typed || !('value' in c)) return c
      const { expr: _expr, ...rest } = c as typeof c & { expr?: string }
      void _expr
      return { ...rest, value: c.kind === 'diameter' ? 2 * radius : radius } as typeof c
    })
  }
  const hold = typed ? null : addConstraint(next, { kind: 'radius', entity: id, value: radius })
  const report = solveSketch(next, { datums: datumTraces(sketch.frame) })
  if (hold !== null) removeConstraint(next, hold)
  if (!report.ok) return { route: 'direct', why: `the circle of ${sketch.name} under this face cannot change — ${HELD}` }
  return sketchPlan(features, sketch, next, `${sketch.name}: the ${piece.kind} under this face, radius ${lenText(piece.r, units)} → ${lenText(radius, units)} ${unitWord(units)}`)
}

/** A revolve's bore, rim or hub — a cylinder about the revolve's own axis —
 *  resized by the line of the section that runs along the axis at its
 *  radius: that line moves away from the axis or towards it. Of two steps
 *  at one radius, the one beside the face along the axis. */
function resizeTurned(features: readonly Feature[], maker: RevolveFeature, sketch: SketchFeature, face: FaceFingerprint, axis: { origin: Vec3; dir: Vec3 }, offset: number, units: DisplayUnits): SnapPlan {
  if (face.radius === undefined) return { route: 'direct', why: 'the round face has no radius' }
  const frame = sketch.frame
  const to2 = (p: Vec3): Vec2 => [dot(sub(p, frame.origin), frame.basisU), dot(sub(p, frame.origin), frame.basisV)]
  const o = to2(axis.origin)
  const d: Vec2 = [dot(axis.dir, frame.basisU), dot(axis.dir, frame.basisV)]
  // A sheet point's signed distance from the axis, and its place along it.
  const out = (q: Vec2) => (q[0] - o[0]) * -d[1] + (q[1] - o[1]) * d[0]
  const along = (q: Vec2) => (q[0] - o[0]) * d[0] + (q[1] - o[1]) * d[1]
  const beside = along(to2(face.centroid))
  let line: Extract<SketchEntity, { kind: 'line' }> | null = null
  let nearest = Infinity
  for (const e of sketch.sketch.entities) {
    if (e.kind !== 'line' || e.construction) continue
    const a = out(e.a), b = out(e.b)
    if (a * b <= 0 || Math.abs(Math.abs(a) - face.radius) > ON_MM || Math.abs(Math.abs(b) - face.radius) > ON_MM) continue
    const gap = Math.abs((along(e.a) + along(e.b)) / 2 - beside)
    if (gap < nearest) {
      nearest = gap
      line = e
    }
  }
  if (!line) return { route: 'direct', why: `no line of ${sketch.name} runs along the axis at this face's radius` }
  const radius = round4(face.radius + offset)
  if (!(radius > 1e-6)) return { route: 'direct', why: 'the radius would not be positive' }
  const side = out(line.a) > 0 ? 1 : -1
  const moved = moveLine(features, sketch, line, [-d[1] * side, d[0] * side], offset, units)
  return moved.route === 'sketch' ? { ...moved, text: `${sketch.name}: the line of ${maker.name}'s section under this face, radius ${lenText(face.radius, units)} → ${lenText(radius, units)} ${unitWord(units)}` } : moved
}

/** A face a revolve made: a shoulder — flat, square to the axis — by the
 *  section's line under it, as an extrude's wall; a cylinder about the axis
 *  by the line along it. The flat ends of a part turn are the angle's, and
 *  a cone or a torus comes of a line that leans or an arc. */
function snapTurned(features: readonly Feature[], maker: RevolveFeature, sketch: SketchFeature, face: FaceFingerprint, offset: number, elements: ResolveContext['elements'], units: DisplayUnits): SnapPlan {
  if (maker.pitch) return { route: 'direct', why: `${maker.name} is a coil — its faces wind along the axis, and none is a shoulder or a cylinder` }
  const axis = resolveAxis(maker.axis, sketch, { sections: [], elements, modelCenter: [0, 0, 0] })
  if (!axis) return { route: 'direct', why: `the axis of ${maker.name} is gone` }
  const n = sketch.frame.normal
  if (Math.abs(dot(axis.dir, n)) > 1e-6 || Math.abs(dot(sub(axis.origin, sketch.frame.origin), n)) > ON_MM) return { route: 'direct', why: `the axis of ${maker.name} does not lie in its sketch's plane` }
  const square = Math.abs(dot(face.dir, axis.dir)) > 1 - 1e-6
  if (face.kind === 'plane') return square ? moveWall(features, maker, sketch, face, offset, units) : { route: 'direct', why: `the face is a flat end of ${maker.name}'s turn — that is its angle` }
  if (face.kind === 'cylinder' && square && face.center && len(cross(sub(face.center, axis.origin), axis.dir)) <= ON_MM) return resizeTurned(features, maker, sketch, face, axis, offset, units)
  return { route: 'direct', why: face.kind === 'cone' ? `the face is a cone of ${maker.name} — the line of its section leans to the axis` : `the face is neither a shoulder nor a cylinder about the axis of ${maker.name}` }
}

/**
 * How several faces move by one `offset`: the edits of the feature list
 * that move them all — each planned on the list as the one before left it,
 * so both ends of one extrude change its From and its To — or, when any of
 * them traces back to nothing, the reason they are all moved on the body
 * instead, as one Move face. Half the faces in the history and half on the
 * body would be two edits for one command, and the second would be made
 * against a body the first had already changed.
 */
export function planMoves(features: readonly Feature[], faces: readonly FaceFingerprint[], offset: number, elements: ResolveContext['elements'] = [], units: DisplayUnits = 'mm'): SnapPlan {
  if (faces.length === 0) return { route: 'direct', why: 'no face is picked' }
  let list: readonly Feature[] = features
  let route: 'extent' | 'sketch' = 'extent'
  const texts: string[] = []
  for (const face of faces) {
    const plan = planSnap(list, face, offset, elements, units)
    if (plan.route === 'direct') return faces.length === 1 ? plan : { route: 'direct', why: `one of them cannot be traced: ${plan.why}` }
    list = plan.features
    if (plan.route === 'sketch') route = 'sketch'
    if (!texts.includes(plan.text)) texts.push(plan.text)
  }
  return { route, features: [...list], text: texts.join('; ') }
}

/**
 * How a face moves by `offset` — along its outward normal for a plane, in
 * radius for a cylinder: the edit of the feature list that does it, or the
 * reason it has to be done on the body. `elements` are the measured
 * elements, for a revolve about one of them.
 */
export function planSnap(features: readonly Feature[], face: FaceFingerprint, offset: number, elements: ResolveContext['elements'] = [], units: DisplayUnits = 'mm'): SnapPlan {
  if (!(Math.abs(offset) > 1e-9)) return { route: 'direct', why: 'the face has nowhere to move' }
  const maker = features.find((f) => f.id === face.origin)
  if (!maker) return { route: 'direct', why: 'the feature that made this face is not in the list' }
  if (maker.kind !== 'extrude' && maker.kind !== 'revolve') return { route: 'direct', why: `${maker.name} made this face, and only an extrude's or a revolve's faces trace back to a sketch or a distance` }
  const sketch = features.find((f): f is SketchFeature => f.kind === 'sketch' && f.id === maker.sketchId)
  if (!sketch) return { route: 'direct', why: `the sketch of ${maker.name} is gone` }
  if (maker.kind === 'revolve') return snapTurned(features, maker, sketch, face, offset, elements, units)
  const along = Math.abs(dot(face.dir, sketch.frame.normal))
  if (face.kind === 'plane') {
    if (along > 1 - 1e-6) return moveCap(features, maker, sketch, face, offset, units)
    if (along < 1e-4) return moveWall(features, maker, sketch, face, offset, units)
    return { route: 'direct', why: 'the face leans to the sketch plane' }
  }
  if (face.kind === 'cylinder' && along > 1 - 1e-6) return resizeRound(features, maker, sketch, face, offset, units)
  return { route: 'direct', why: 'the face is neither an end nor a wall of its extrude' }
}

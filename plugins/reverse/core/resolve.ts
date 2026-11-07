// SPDX-License-Identifier: AGPL-3.0-only
// The feature list resolved for the build: planes and axes found from what
// they refer to, a hole's axis, and every feature turned into the BuildStep
// the builder plays, in order.

import { drawnFit } from '../../../src/core/elements/assumed'
import { type DisplayUnits, fmtLen } from '../../../src/core/units'
import { radialFrame, type SectionFrame, sketchFrameOn, WORLD_AXES, type WorldAxis, worldAxisDir, worldPlaneName } from '../../../src/core/section/frame'
import type { FitData, Vec3 } from '../../../src/core/types'
import { addScaled, cross, dot, normalize, scale } from '../../../src/core/vec'
import { type BuildStep, type PlaneGeometry, type ResolveContext, type SketchOnFace, SURFACE_MIN_REGION } from './buildSteps'
import { type AxisRef, constrainRefs, type EdgeRef, type RegionPick, type ExtrudeUntil, type FaceRef, type Feature, FULL_TURN_DEG, type HoleAxis, MIN_SWEEP_RAD, movableFace, type PatternFeature, type PlaneRef, type Primitive, revolveMaxDeg, type SketchFeature, type SurfaceFeature, toolsOf, type TrimPrimitive } from './features'
import type { Profile } from './kernel'
import { moveMatrix } from './move'
import { shadowPrimitive } from './shadowPieces'
import { liftPoint, loftProblem, loftProfile, pickedProfiles, routeSweepGeometry, sketchPieces, sweepGeometry } from './profiles'
import type { Region } from './regions'
import { threadProblem } from './thread'
import type { StoredPick } from './where'

/** The frame a plane reference stands for now, or null when the thing it
 *  names is gone. `seedU` keeps an in-plane X already chosen. The plane is
 *  the reference's; the sheet's zero and X on it are the sketch rule's
 *  (sketchFrameOn) — a section's or a plane element's own frame, laid out
 *  on its patch, is not a sketch's. A plane fitted or a face's carries the
 *  frame it was given. A plane with `up` takes its X as up × normal over
 *  any seed; a plane through an axis is laid out by the axis alone. */
export function resolvePlaneFrame(ref: PlaneRef, ctx: ResolveContext, seedU?: Vec3): SectionFrame | null {
  if (ref.kind === 'fitted' || ref.kind === 'bodyFace') return seedU ? { ...ref.frame, basisU: seedU, basisV: cross(ref.frame.normal, seedU) } : ref.frame
  const off = (frame: SectionFrame | null): SectionFrame | null => (frame && ref.kind !== 'world' && ref.offset ? { ...frame, origin: addScaled(frame.origin, frame.normal, ref.offset) } : frame)
  if (ref.kind === 'radial') {
    const line = resolveAxis(ref.axis, undefined, ctx)
    const dir = line && normalize(line.dir)
    if (!line || !dir) return null
    // The sheet's zero on the axis, level with the part's origin: the
    // origin's foot on the axis line.
    return off(radialFrame({ origin: addScaled(line.origin, dir, -dot(line.origin, dir)), dir }, ref.angleDeg))
  }
  const seed = (normal: Vec3) => upU(ref.up, normal) ?? seedU
  if (ref.kind === 'section') {
    const frame = ctx.sections.find((s) => s.id === ref.id)?.frame
    return frame ? off(sketchFrameOn(frame, seed(frame.normal))) : null
  }
  if (ref.kind === 'world') {
    const dir = worldAxisDir(ref.axis)
    return sketchFrameOn({ origin: scale(dir, Number.isFinite(ref.offset) ? ref.offset : 0), normal: dir }, seed(dir))
  }
  const fit = ctx.elements.find((e) => e.id === ref.id)?.fit
  if (!fit || fit.kind !== 'plane') return null
  return off(sketchFrameOn({ origin: fit.center, normal: fit.normal }, seed(fit.normal)))
}

/** How far off a plane's normal `up` has to lie to run up the plane: its
 *  share in the plane, about 6° — as a section picture's `up` has it. */
const UP_MIN_SHARE = 0.1

/** The u a plane's `up` asks for: up × normal, so v runs up the plane as
 *  near as it lets — or null with no `up`, or one along the normal that has
 *  no way up it. */
export function upU(up: WorldAxis | undefined, normal: Vec3): Vec3 | null {
  const n = up ? normalize(normal) : null
  if (!up || !n) return null
  const u = cross(worldAxisDir(up), n)
  return Math.hypot(u[0], u[1], u[2]) < UP_MIN_SHARE ? null : normalize(u)
}

/** The coordinate planes a sketch is offered. The planes themselves, at
 *  zero, once the part is aligned or there is no scan — the origin is then
 *  the part's own, and a sketch on the XY plane is what CAD means by it.
 *  And, with a scan, the same planes through the scan's centre: a slice
 *  across the middle of the part, which is what a profile is fitted on —
 *  the only offer while the part still sits where the scanner left it, at
 *  the origin they would miss it. */
export function coordinatePlaneOffers(opts: { centre: Vec3 | null; atZero: boolean }): { key: string; label: string; ref: Extract<PlaneRef, { kind: 'world' }> }[] {
  const out: { key: string; label: string; ref: Extract<PlaneRef, { kind: 'world' }> }[] = []
  if (opts.atZero) for (const axis of WORLD_AXES) out.push({ key: worldPlaneKey(axis, 0), label: worldPlaneName(axis), ref: { kind: 'world', axis, offset: 0 } })
  if (opts.centre) {
    for (const axis of WORLD_AXES) {
      const offset = opts.centre[axis === 'x' ? 0 : axis === 'y' ? 1 : 2]
      out.push({ key: worldPlaneKey(axis, offset), label: `${worldPlaneName(axis)} through the centre`, ref: { kind: 'world', axis, offset } })
    }
  }
  return out
}

/** The key a coordinate plane on offer is told apart by: the plane at zero
 *  and the one through the centre are two offers on one axis. */
export function worldPlaneKey(axis: WorldAxis, offset: number): string {
  return `world:${axis}:${Math.round(offset * 1000) / 1000}`
}

function resolvePlane(ref: PlaneRef, ctx: ResolveContext): PlaneGeometry | null {
  const frame = resolvePlaneFrame(ref, ctx)
  return frame && { origin: frame.origin, normal: frame.normal }
}

/** The axis a revolve turns about, or null. */
export function resolveAxis(
  ref: AxisRef,
  sketch: SketchFeature | undefined,
  ctx: ResolveContext,
): { origin: Vec3; dir: Vec3 } | null {
  if (ref.kind === 'world') {
    const dir: Vec3 = ref.axis === 'x' ? [1, 0, 0] : ref.axis === 'y' ? [0, 1, 0] : [0, 0, 1]
    return { origin: [0, 0, 0], dir }
  }
  if (ref.kind === 'sketchLine') {
    if (!sketch) return null
    const line = sketch.sketch.entities.find((e) => e.id === ref.entity)
    if (!line || line.kind !== 'line') return null
    const a = liftPoint(sketch.frame, line.a)
    const b = liftPoint(sketch.frame, line.b)
    const dir = normalize([b[0] - a[0], b[1] - a[1], b[2] - a[2]])
    return dir && { origin: a, dir }
  }
  const fit = ctx.elements.find((e) => e.id === ref.id)?.fit
  if (!fit) return null
  if (fit.kind === 'line') return { origin: fit.center, dir: fit.dir }
  if (fit.kind === 'cylinder' || fit.kind === 'cone') return { origin: fit.center, dir: fit.axis }
  if (fit.kind === 'circle') return { origin: fit.center, dir: fit.normal }
  return null
}

/** The name a plane reference reads as, its offset in the units shown. */
export function describePlaneRef(ref: PlaneRef, ctx: { sections: readonly { id: number; name: string }[]; elements: readonly { id: number; name: string }[] }, units: DisplayUnits = 'mm'): string {
  const off = ref.kind !== 'world' && ref.kind !== 'fitted' && ref.offset ? `, ${ref.offset > 0 ? '+' : '−'}${fmtLen(Math.abs(ref.offset), units, 2)} off it` : ''
  if (ref.kind === 'section') return (ctx.sections.find((s) => s.id === ref.id)?.name ?? 'deleted section') + off
  if (ref.kind === 'plane') return (ctx.elements.find((e) => e.id === ref.id)?.name ?? 'deleted plane') + off
  if (ref.kind === 'fitted') return ref.label ?? 'a fitted plane'
  if (ref.kind === 'bodyFace') return 'a face of the body' + off
  if (ref.kind === 'radial') {
    const a = ref.axis
    const axis = a.kind === 'world' ? `the ${a.axis.toUpperCase()} axis` : (ctx.elements.find((e) => e.id === a.id)?.name ?? 'a deleted axis')
    return `the plane through ${axis} at ${Math.round(ref.angleDeg * 1000) / 1000}°` + off
  }
  const name = ref.axis === 'x' ? 'YZ' : ref.axis === 'y' ? 'XZ' : 'XY'
  const at = units === 'mm' ? ref.offset.toFixed(2) : fmtLen(ref.offset, units, 2, { bare: true })
  return `${name} plane at ${ref.axis.toUpperCase()} = ${at}`
}

/** Whether a sketch is placed on the part by the build before the features
 *  on it: one on a body's face, which follows the face, and one with a
 *  projected piece that follows what it was projected from. */
function placedOnPart(f: SketchFeature): boolean {
  return f.plane.kind === 'bodyFace' || f.sketch.entities.some((e) => e.projected && e.source)
}

/** The solid a measured element stands for, or why there is none. */
function primitiveOf(fit: FitData | undefined, thickness: number): Exclude<Primitive, { kind: 'prism' }> | string {
  if (!fit) return 'The element this body is taken from is gone.'
  switch (fit.kind) {
    case 'plane':
      if (!(thickness > 0)) return 'A slab needs a thickness.'
      return { kind: 'slab', origin: fit.center, normal: fit.normal, basisU: fit.basisU, basisV: fit.basisV, extentU: fit.extentU, extentV: fit.extentV, thickness }
    case 'cylinder':
      return { kind: 'cylinder', origin: fit.center, axis: fit.axis, radius: fit.radius, length: fit.length }
    case 'cone':
      return { kind: 'cone', origin: fit.center, axis: fit.axis, radius1: fit.radius1, radius2: fit.radius2, length: fit.length }
    case 'sphere':
      return { kind: 'sphere', center: fit.center, radius: fit.radius }
    case 'torus':
      return { kind: 'torus', center: fit.center, axis: fit.axis, majorRadius: fit.majorRadius, minorRadius: fit.minorRadius }
    default:
      return `A ${fit.kind} has no volume to make a body of.`
  }
}

/** Where a hole's axis runs, or why it cannot: a cylinder or circle
 *  element's axis and radius, or a cylindrical face's. */
export function resolveHoleAxis(axis: HoleAxis, ctx: ResolveContext): { origin: Vec3; dir: Vec3; radius: number | null; oneWay?: boolean } | string {
  if (axis.kind === 'point') {
    if (axis.face.kind !== 'plane') return 'A hole is drilled into a flat face — the face picked is not one.'
    return { origin: axis.at, dir: scale(axis.face.dir, -1), radius: null, oneWay: true }
  }
  if (axis.kind === 'face') {
    const f = axis.face
    if (f.kind !== 'cylinder' || !f.center) return 'The face the hole follows is not a cylinder.'
    return { origin: f.center, dir: f.dir, radius: f.radius ?? null }
  }
  const fit = ctx.elements.find((e) => e.id === axis.id)?.fit
  if (!fit) return 'The element the hole follows is gone.'
  if (fit.kind === 'cylinder') return { origin: fit.center, dir: fit.axis, radius: fit.radius }
  if (fit.kind === 'circle') return { origin: fit.center, dir: fit.normal, radius: fit.radius }
  if (fit.kind === 'line') return { origin: fit.center, dir: fit.dir, radius: null }
  return `A ${fit.kind} has no axis to drill along.`
}

/** The queries a feature's picks were given by, for its step — absent
 *  with none. */
function queriesOf(f: { edgesWhere?: StoredPick<EdgeRef>[]; facesWhere?: StoredPick<FaceRef>[] }): { edgesWhere?: StoredPick<EdgeRef>[]; facesWhere?: StoredPick<FaceRef>[] } {
  return { ...(f.edgesWhere?.length ? { edgesWhere: f.edgesWhere } : {}), ...(f.facesWhere?.length ? { facesWhere: f.facesWhere } : {}) }
}

/** For an extrude's or a revolve's step: the picked regions an edit found
 *  again by where they lie, those still picked, for its row, and how the
 *  regions were asked for, while that stands — each absent with none. */
function byPlaceOf(f: { regions: string[]; regionsByPlace?: string[]; regionPick?: RegionPick }): { regionsByPlace?: string[]; regionPick?: RegionPick['given'] } {
  const still = (f.regionsByPlace ?? []).filter((k) => f.regions.includes(k))
  const pick = f.regionPick && f.regionPick.keys.length === f.regions.length && f.regionPick.keys.every((k) => f.regions.includes(k)) ? f.regionPick.given : undefined
  return { ...(still.length > 0 ? { regionsByPlace: still } : {}), ...(pick ? { regionPick: pick } : {}) }
}

/** Whether a pattern is a grid: linear, repeated along a second direction. */
function patternGrid(f: Pick<PatternFeature, 'mode' | 'axis2' | 'count2'>): boolean {
  return f.mode === 'linear' && f.axis2 !== undefined && (f.count2 ?? 1) >= 2
}

/**
 * Resolve the feature list into build steps. Regions are found on the
 * solved sketch as it stands; a feature whose sketch, profiles, plane or
 * axis are gone becomes a failed step with the reason, and the ones after
 * it still build. Sketches make no step: they are geometry for the
 * features that pick from them. Picks on a body travel as fingerprints,
 * which the builder re-finds on the body as it stands before the feature.
 */
export function resolveFeatures(
  features: readonly Feature[],
  ctx: ResolveContext,
  regionsOf: (sketch: SketchFeature) => Region[],
): BuildStep[] {
  const sketches = new Map<number, SketchFeature>()
  const steps: BuildStep[] = []
  const failed = (f: Feature, message: string) => steps.push({ kind: 'failed', id: f.id, name: f.name, message })
  // The sketch map fills in the list's order: a sketch a feature names is
  // not in it when it stands further down or is suppressed — said so, not
  // "gone", which reads as deleted.
  const absent = (f: Feature, id: number, gone: string): string => {
    const at = features.findIndex((x) => x.id === id)
    const s = features[at]
    if (!s || s.kind !== 'sketch') return gone
    const named = `Sketch ${id} (${s.name})`
    const what = f.kind === 'extrude' || f.kind === 'revolve' || f.kind === 'loft' || f.kind === 'sweep' || f.kind === 'sheet' ? f.kind : 'feature'
    if (s.suppressed) return `${named} is suppressed — build it again (reverse.feature.update { set: { suppressed: false } }), or take it out of this ${what}.`
    if (at > features.indexOf(f)) return `${named} stands after this ${what} — a feature takes only the sketches above it. Move it above: add the ${what} again below the sketch, or roll back to before the ${what} (reverse.feature.rollback { after }) and make the sketch there.`
    return gone
  }
  for (const f of features) {
    // Suppressed: no step, as if it were not in the list — a sketch with
    // it, so what is made from the sketch fails for want of it.
    if (f.suppressed) continue
    if (f.kind === 'sketch') {
      sketches.set(f.id, f)
      if (placedOnPart(f)) {
        const from = new Set(f.sketch.entities.flatMap((e) => (e.projected && e.source && 'sketch' in e.source ? [e.source.sketch] : [])))
        const sources = [...from].flatMap((id) => {
          const other = sketches.get(id)
          return other && id !== f.id ? [{ id, frame: other.frame }] : []
        })
        const onFace = f.plane.kind === 'bodyFace' ? { onFace: { body: f.plane.body, face: f.plane.face, frame: f.frame, ...(f.plane.offset ? { offset: f.plane.offset } : {}) } } : {}
        steps.push({ kind: 'sketch', id: f.id, name: f.name, frame: f.frame, ...onFace, sources })
      }
      continue
    }
    if (f.kind === 'shell') {
      if (!(f.thickness > 0)) failed(f, 'The wall needs a thickness.')
      else steps.push({ kind: 'shell', id: f.id, name: f.name, body: f.body, faces: f.faces, ...queriesOf(f), thickness: f.thickness })
      continue
    }
    if (f.kind === 'fillet') {
      const variable = f.variable ?? []
      if (f.edges.length === 0 && variable.length === 0) failed(f, 'Pick the edges to round.')
      else if (f.edges.length > 0 && !(f.radius > 0)) failed(f, 'The fillet needs a radius.')
      else if (variable.some((v) => !(v.radius[0] > 0 && v.radius[1] > 0))) failed(f, 'An edge rounded at a varying radius needs both its radii.')
      else steps.push({ kind: 'fillet', id: f.id, name: f.name, body: f.body, edges: f.edges, ...queriesOf(f), radius: f.radius, chain: f.chain, ...(f.skipFailing ? { skipFailing: true } : {}), ...(variable.length > 0 ? { variable } : {}) })
      continue
    }
    if (f.kind === 'chamfer') {
      if (f.edges.length === 0) failed(f, 'Pick the edges to chamfer.')
      else if (!(f.distance > 0)) failed(f, 'The chamfer needs a distance.')
      else if (f.mode === 'twoDistances' && !((f.distance2 ?? 0) > 0)) failed(f, 'The chamfer needs its second distance.')
      else if (f.mode === 'distanceAngle' && !((f.angleDeg ?? 0) > 0 && (f.angleDeg ?? 0) < 90)) failed(f, 'The chamfer’s angle is between 0° and 90°.')
      else {
        const sided = f.mode === 'twoDistances' ? { mode: f.mode, distance2: f.distance2! } : f.mode === 'distanceAngle' ? { mode: f.mode, angleDeg: f.angleDeg! } : null
        steps.push({ kind: 'chamfer', id: f.id, name: f.name, body: f.body, edges: f.edges, ...queriesOf(f), distance: f.distance, chain: f.chain, ...(f.skipFailing ? { skipFailing: true } : {}), ...(sided ? { ...sided, ...(f.flip ? { flip: true } : {}) } : {}) })
      }
      continue
    }
    if (f.kind === 'hole') {
      const axis = resolveHoleAxis(f.axis, ctx)
      if (typeof axis === 'string') failed(f, axis)
      else if (!(f.radius > 0)) failed(f, 'The hole needs a radius.')
      else steps.push({ kind: 'hole', id: f.id, name: f.name, body: f.body, origin: axis.origin, dir: axis.dir, radius: f.radius, depth: f.depth, ...(axis.oneWay ? { oneWay: true } : {}) })
      continue
    }
    if (f.kind === 'thread') {
      const why =
        f.face.kind !== 'cylinder'
          ? 'A thread is cut on a round face — the face picked is not one.'
          : (threadProblem(f) ?? (f.length !== null && !(f.length > 0) ? 'The thread needs a length.' : f.length !== null && !(f.start >= 0) ? 'The thread has to start on the face — zero or more in from its end.' : null))
      if (why) failed(f, why)
      else steps.push({ kind: 'thread', id: f.id, name: f.name, body: f.body, face: f.face, standard: f.standard, diameter: f.diameter, pitch: f.pitch, leftHanded: f.leftHanded, length: f.length, start: f.start, flip: f.flip, offset: f.offset, chamfer: f.chamfer ?? false })
      continue
    }
    if (f.kind === 'extract') {
      // The element as Measure draws and exports it: a cylinder or a plane
      // pulled out past the surface it was measured on is a body that long,
      // and one given an assumed Ø is a body that wide.
      // A shadow section stands as the block it draws.
      const element = ctx.elements.find((e) => e.id === f.element)
      const primitive = f.section !== undefined ? shadowPrimitive(ctx.sections.find((s) => s.id === f.section)) : primitiveOf(element?.fit && drawnFit(element.fit, element.assumed, element.extend), f.thickness)
      if (typeof primitive === 'string') failed(f, primitive)
      else steps.push({ kind: 'extract', id: f.id, name: f.name, primitive, op: f.op, target: f.target })
      continue
    }
    if (f.kind === 'cutPlane') {
      const plane = resolvePlane(f.plane, ctx)
      if (!plane) failed(f, `The plane this cut is made at is gone (${describePlaneRef(f.plane, { sections: [], elements: [] })}).`)
      else steps.push({ kind: 'cutPlane', id: f.id, name: f.name, body: f.body, plane, keep: f.keep })
      continue
    }
    if (f.kind === 'mirror') {
      if (f.plane.kind === 'face') {
        steps.push({ kind: 'mirror', id: f.id, name: f.name, body: f.body, plane: { face: f.plane.face }, join: f.join })
        continue
      }
      const plane = resolvePlane(f.plane, ctx)
      if (!plane) failed(f, `The plane this mirror is about is gone (${describePlaneRef(f.plane, { sections: [], elements: [] })}).`)
      else steps.push({ kind: 'mirror', id: f.id, name: f.name, body: f.body, plane, join: f.join })
      continue
    }
    if (f.kind === 'draft') {
      const rad = (deg: number) => (deg * Math.PI) / 180
      const bad = (deg: number) => !(Math.abs(deg) > 1e-9) || Math.abs(deg) >= 89
      // Faces at angles of their own, leaned after the first.
      const more = f.groups?.length ? { groups: f.groups.map((g) => ({ faces: g.faces, angleRad: rad(g.angleDeg) })) } : {}
      if (f.faces.length === 0 || f.groups?.some((g) => g.faces.length === 0)) failed(f, 'Pick the faces to draft.')
      else if (bad(f.angleDeg) || f.groups?.some((g) => bad(g.angleDeg))) failed(f, 'The draft needs an angle, under 89°.')
      else if (f.neutral.kind === 'face') steps.push({ kind: 'draft', id: f.id, name: f.name, body: f.body, neutral: { face: f.neutral.face }, faces: f.faces, ...queriesOf(f), angleRad: rad(f.angleDeg), ...more })
      else {
        const plane = resolvePlane(f.neutral, ctx)
        if (!plane) failed(f, `The neutral plane of this draft is gone (${describePlaneRef(f.neutral, { sections: [], elements: [] })}).`)
        else steps.push({ kind: 'draft', id: f.id, name: f.name, body: f.body, neutral: plane, faces: f.faces, ...queriesOf(f), angleRad: rad(f.angleDeg), ...more })
      }
      continue
    }
    if (f.kind === 'moveFace') {
      if (f.faces.length === 0) failed(f, 'No face is picked to move.')
      else if (f.faces.some((face) => !movableFace(face))) failed(f, 'Only a flat or a cylindrical face can be moved.')
      else if (!(Math.abs(f.offset) > 1e-9)) failed(f, 'The face has nowhere to move — the offset is zero.')
      else steps.push({ kind: 'moveFace', id: f.id, name: f.name, body: f.body, faces: f.faces, ...queriesOf(f), offset: f.offset })
      continue
    }
    if (f.kind === 'deleteFace') {
      if (f.faces.length === 0) failed(f, 'Pick the faces to delete.')
      else steps.push({ kind: 'deleteFace', id: f.id, name: f.name, body: f.body, faces: f.faces, ...queriesOf(f) })
      continue
    }
    if (f.kind === 'import') {
      steps.push({ kind: 'import', id: f.id, name: f.name, file: f.file.key })
      continue
    }
    if (f.kind === 'moveBody') {
      const numbers = [...f.pivot, ...f.translate, ...f.rotate]
      if (f.bodies.length === 0) failed(f, 'No body is picked to move.')
      else if (!numbers.every(Number.isFinite)) failed(f, 'The move needs a number for every distance and angle.')
      else steps.push({ kind: 'moveBody', id: f.id, name: f.name, bodies: [...f.bodies], matrix: moveMatrix(f), copy: f.copy })
      continue
    }
    if (f.kind === 'offsetBody') {
      if (!(Math.abs(f.distance) > 1e-9)) failed(f, 'The offset needs a distance — out, or in with a negative one.')
      else steps.push({ kind: 'offsetBody', id: f.id, name: f.name, body: f.body, distance: f.distance, keep: f.keep })
      continue
    }
    if (f.kind === 'boolean') {
      if (toolsOf(f).includes(f.body)) failed(f, 'A body cannot be combined with itself.')
      else steps.push({ kind: 'boolean', id: f.id, name: f.name, op: f.op, body: f.body, tool: f.tool, ...(f.keep ? { keep: true } : {}) })
      continue
    }
    if (f.kind === 'sheet') {
      const sketch = sketches.get(f.sketchId)
      if (!sketch) {
        failed(f, absent(f, f.sketchId, 'The sketch this sheet is drawn from is gone.'))
        continue
      }
      const pieces = sketchPieces(sketch)
      if (pieces.length === 0) failed(f, 'The sketch has no pieces to make a sheet of.')
      else if (Math.abs(f.to - f.from) < 1e-9) failed(f, 'The sheet has no height.')
      else steps.push({ kind: 'sheet', id: f.id, name: f.name, sketchId: f.sketchId, pieces, dir: sketch.frame.normal, from: f.from, to: f.to })
      continue
    }
    if (f.kind === 'trim') {
      const bodies = f.tools.filter((t): t is { kind: 'body'; id: number } => t.kind === 'body').map((t) => t.id)
      const primitives: TrimPrimitive[] = []
      let lost: string | null = null
      for (const t of f.tools) {
        if (t.kind !== 'element') continue
        const fit = ctx.elements.find((e) => e.id === t.id)?.fit
        if (!fit) {
          lost = 'An element this trim cuts with is gone.'
          break
        }
        if (fit.kind === 'plane') primitives.push({ kind: 'plane', origin: fit.center, normal: fit.normal, basisU: fit.basisU, basisV: fit.basisV })
        else {
          const p = primitiveOf(fit, 1)
          if (typeof p === 'string' || p.kind === 'slab') {
            lost = `A ${fit.kind} cannot cut space for a trim.`
            break
          }
          primitives.push(p)
        }
      }
      if (lost) failed(f, lost)
      else if (bodies.length + primitives.length === 0) failed(f, 'The trim has no surfaces to close.')
      else if (!(f.tolerance > 0) || !(f.overlap > 0 && f.overlap <= 1)) failed(f, 'The trim needs a tolerance above zero and an overlap between 0 and 1.')
      else steps.push({ kind: 'trim', id: f.id, name: f.name, bodies, primitives, tolerance: f.tolerance, overlap: f.overlap })
      continue
    }
    if (f.kind === 'surface') {
      if (f.region.length < SURFACE_MIN_REGION) failed(f, `The region holds ${f.region.length} points; a surface needs at least ${SURFACE_MIN_REGION}.`)
      // Its box moved with the parameters and its points were not read in
      // it again: fitted, the surface would be the old box's.
      else if (f.regionStale) failed(f, `The box its region is read in moved with the parameters, and the points in it were not read again${typeof f.regionStale === 'string' ? `: ${f.regionStale}` : ' yet'} — reverse.feature.update { set: { region: { box } } } reads them.`)
      else {
        // A plane or cylinder is held to what stands before it in the list;
        // the ones after it are held to it.
        const before = features.slice(0, features.indexOf(f))
        const refSurfaces = before.filter((o): o is SurfaceFeature => o.kind === 'surface' && (o.shape ?? 'freeform') !== 'freeform').map((o) => ({ id: o.id, name: o.name }))
        steps.push({ kind: 'surface', id: f.id, name: f.name, region: f.region, fit: f.fit, shape: f.shape ?? 'freeform', constrain: f.constrain ?? { mode: 'auto' }, refs: constrainRefs(ctx.elements), refSurfaces, ...(f.regionBox?.normal ? { facing: f.regionBox.normal } : {}) })
      }
      continue
    }
    if (f.kind === 'network') {
      if (f.curves.length === 0) failed(f, 'Place a patch: click its corners on the scan.')
      else steps.push({ kind: 'network', id: f.id, name: f.name, nodes: f.nodes, curves: f.curves, cells: f.cells, spans: f.spans, fit: f.fit })
      continue
    }
    if (f.kind === 'split') {
      if (f.tools.length === 0) failed(f, 'Pick a sheet or a body to split with.')
      else if (f.tools.includes(f.body)) failed(f, 'A body cannot split itself.')
      else if (f.keep === 'between' && f.tools.length < 2) failed(f, 'Keeping what lies between the sheets takes two sheets or more — the skins the wall lies between.')
      else steps.push({ kind: 'split', id: f.id, name: f.name, body: f.body, tools: f.tools, keep: f.keep, tolerance: f.tolerance, overlap: f.overlap, ...(f.within !== undefined ? { within: f.within } : {}) })
      continue
    }
    if (f.kind === 'loft') {
      if (f.sketches.length < 2) {
        failed(f, 'A loft needs two or more sketches.')
        continue
      }
      const profiles: Profile[] = []
      const through: SketchFeature[] = []
      let reason: string | null = null
      for (const id of f.sketches) {
        const sketch = sketches.get(id)
        if (!sketch) {
          reason = absent(f, id, 'A sketch this loft runs through is gone.')
          break
        }
        const profile = loftProfile(sketch, regionsOf(sketch))
        if (typeof profile === 'string') {
          reason = profile
          break
        }
        profiles.push(profile)
        through.push(sketch)
      }
      // Checked before the kernel tries it: its own failure there reads
      // "NCollection_DataMap::Find", and a run-off section lofts "ok".
      reason ??= loftProblem(through, profiles)
      if (reason) failed(f, reason)
      else steps.push({ kind: 'loft', id: f.id, name: f.name, profiles, sketches: f.sketches, sketchNames: through.map((s) => s.name), ruled: f.ruled, op: f.op, target: f.target })
      continue
    }
    if (f.kind === 'sweep') {
      const profileSketch = sketches.get(f.profile)
      if (f.route) {
        const swept = !profileSketch ? absent(f, f.profile, 'The sketch of the profile is gone.') : routeSweepGeometry(profileSketch, regionsOf(profileSketch), f.route)
        if (typeof swept === 'string') failed(f, swept)
        else steps.push({ kind: 'sweep', id: f.id, name: f.name, ...swept, sketches: [f.profile], route: f.route, op: f.op, target: f.target })
        continue
      }
      const pathSketch = f.path === undefined ? undefined : sketches.get(f.path)
      const swept = f.profile === f.path ? 'The profile and the path are one sketch — draw them in two.' : !profileSketch ? absent(f, f.profile, 'The sketch of the profile is gone.') : !pathSketch ? absent(f, f.path ?? f.profile, 'The sketch of the path is gone.') : sweepGeometry(profileSketch, regionsOf(profileSketch), pathSketch)
      if (typeof swept === 'string') failed(f, swept)
      else steps.push({ kind: 'sweep', id: f.id, name: f.name, ...swept, sketches: [f.profile, f.path!], op: f.op, target: f.target })
      continue
    }
    if (f.kind === 'thicken') {
      if (!(f.thickness > 0)) failed(f, 'The sheet needs a thickness.')
      else steps.push({ kind: 'thicken', id: f.id, name: f.name, sheet: f.sheet, thickness: f.thickness, side: f.side, op: f.op, target: f.target })
      continue
    }
    if (f.kind === 'pattern') {
      const axis = resolveAxis(f.axis, undefined, ctx)
      const grid = patternGrid(f)
      const axis2 = grid ? resolveAxis(f.axis2!, undefined, ctx) : null
      if (!axis || (grid && !axis2)) failed(f, 'The axis this pattern runs about is gone.')
      else if (!(f.count >= 2)) failed(f, 'A pattern needs a count of two or more.')
      else if (!(f.step > 0)) failed(f, f.mode === 'circular' ? 'The pattern needs an angle.' : 'The pattern needs a spacing.')
      else if (grid && !((f.step2 ?? 0) > 0)) failed(f, 'The second direction needs a spacing.')
      else if (grid && Math.abs(dot(axis.dir, axis2!.dir)) > 1 - 1e-9) failed(f, 'The two directions of the grid run the same way.')
      else steps.push({ kind: 'pattern', id: f.id, name: f.name, body: f.body, mode: f.mode, origin: axis.origin, dir: axis.dir, count: f.count, step: f.step, ...(grid ? { grid: { dir: axis2!.dir, count: f.count2!, step: f.step2! } } : {}) })
      continue
    }
    // An extrude pulled from a face of a body has no sketch: the builder
    // finds the face again and pulls it as it stands.
    const faceProfile = f.kind === 'extrude' ? f.face : undefined
    const sketch = faceProfile ? undefined : sketches.get(f.sketchId)
    if (!sketch && !faceProfile) {
      steps.push({ kind: 'failed', id: f.id, name: f.name, message: absent(f, f.sketchId, 'The sketch this feature builds on is gone.') })
      continue
    }
    // A sketch on a body's face is lifted in the frame it was last found
    // in; the builder finds the face again and moves what it lifted.
    const onFace: { onFace: SketchOnFace } | Record<string, never> = sketch?.plane.kind === 'bodyFace' ? { onFace: { body: sketch.plane.body, face: sketch.plane.face, frame: sketch.frame, ...(sketch.plane.offset ? { offset: sketch.plane.offset } : {}) } } : {}
    const profiles = sketch ? pickedProfiles(f, sketch, regionsOf) : []
    if (typeof profiles === 'string') {
      steps.push({ kind: 'failed', id: f.id, name: f.name, message: profiles })
      continue
    }
    if (f.kind === 'extrude') {
      if (Math.abs(f.draftDeg ?? 0) >= 89) {
        steps.push({ kind: 'failed', id: f.id, name: f.name, message: 'The taper has to stay under 89° — the sides would lie down flat.' })
        continue
      }
      const dir = faceProfile ? faceProfile.face.dir : sketch!.frame.normal
      const origin = faceProfile ? faceProfile.face.centroid : sketch!.frame.origin
      // Swept another way: never along the plane, which sweeps nothing.
      const along = f.direction ? normalize(f.direction) : null
      if (f.direction && (!along || Math.abs(dot(along, normalize(dir) ?? dir)) < Math.sin(MIN_SWEEP_RAD))) {
        steps.push({ kind: 'failed', id: f.id, name: f.name, message: `The direction runs ${along ? 'along the sketch plane' : 'nowhere'} — the extrusion would have no thickness; it has to leave the plane at ${(MIN_SWEEP_RAD * 180) / Math.PI}° at least.` })
        continue
      }
      const limit = (ref: PlaneRef): PlaneGeometry | string => resolvePlane(ref, ctx) ?? `The plane this extrusion reaches to is gone (${describePlaneRef(ref, { sections: [], elements: [] })}).`
      let from: number | PlaneGeometry
      let to: number | PlaneGeometry
      let until: ExtrudeUntil | undefined
      switch (f.extent.kind) {
        case 'toFace':
          from = to = f.extent.from
          until = { kind: 'face', body: f.extent.body, face: f.extent.face }
          break
        case 'toBody':
          from = to = f.extent.from
          until = { kind: 'body', body: f.extent.body, reverse: Boolean(f.extent.reverse) }
          break
        case 'toNext':
        case 'toLast':
          from = to = f.extent.from
          until = { kind: f.extent.kind === 'toNext' ? 'next' : 'last', reverse: Boolean(f.extent.reverse), against: f.target === undefined ? 'all' : [f.target], cutting: f.op === 'cut' }
          break
        case 'distance':
          from = f.extent.from
          to = f.extent.to
          break
        case 'symmetric':
          from = -f.extent.total / 2
          to = f.extent.total / 2
          break
        case 'toPlane': {
          const p = limit(f.extent.plane)
          if (typeof p === 'string') {
            steps.push({ kind: 'failed', id: f.id, name: f.name, message: p })
            continue
          }
          from = f.extent.from
          to = p
          break
        }
        case 'betweenPlanes': {
          const a = limit(f.extent.a)
          const b = limit(f.extent.b)
          if (typeof a === 'string' || typeof b === 'string') {
            steps.push({ kind: 'failed', id: f.id, name: f.name, message: typeof a === 'string' ? a : (b as string) })
            continue
          }
          from = a
          to = b
          break
        }
      }
      steps.push({ kind: 'extrude', id: f.id, name: f.name, sketchId: f.sketchId, profiles, regions: f.regions, ...byPlaceOf(f), dir, origin, from, to, ...(until ? { until } : {}), draftDeg: f.draftDeg ?? 0, ...(along ? { along } : {}), op: f.op, target: f.target, ...onFace, ...(faceProfile ? { faceProfile } : {}) })
      continue
    }
    const axis = resolveAxis(f.axis, sketch!, ctx)
    if (!axis) {
      steps.push({ kind: 'failed', id: f.id, name: f.name, message: 'The axis this revolve turns about is gone.' })
      continue
    }
    const pitch = Number.isFinite(f.pitch) ? (f.pitch as number) : 0
    if (!(f.angleDeg > 0)) {
      steps.push({ kind: 'failed', id: f.id, name: f.name, message: 'The revolve needs an angle.' })
      continue
    }
    if (pitch === 0 && f.angleDeg > FULL_TURN_DEG + 1e-9) {
      steps.push({ kind: 'failed', id: f.id, name: f.name, message: `A revolve turns ${FULL_TURN_DEG}° at most — give it a pitch to coil on past a full turn.` })
      continue
    }
    const angleDeg = Math.min(f.angleDeg, revolveMaxDeg(pitch))
    steps.push({ kind: 'revolve', id: f.id, name: f.name, sketchId: f.sketchId, profiles, regions: f.regions, ...byPlaceOf(f), origin: axis.origin, dir: axis.dir, angleRad: (angleDeg * Math.PI) / 180, pitch, leftHanded: pitch !== 0 && Boolean(f.leftHanded), op: f.op, target: f.target, ...onFace, ...(f.axis.kind === 'sketchLine' ? { axisInSketch: true, axisLine: f.axis.entity } : {}) })
  }
  return steps
}

// SPDX-License-Identifier: AGPL-3.0-only
// The features of the Reverse engineer workspace, as they are stored, and
// how they are resolved into what the kernel builds. A feature list is
// linear: a sketch on a plane, then extrusions and revolutions that each
// pick the sketch’s regions to use — the way a CAD extrude asks for its
// profiles — and make a new body or join or cut one made before.
// Features refer to the workspace's other things by id — a section, a plane
// element, a coordinate plane, a line element — and are resolved against
// them at build time into plain planes and axes, so the worker that runs the
// kernel needs nothing but geometry.

import type { SectionFrame, WorldAxis } from '../../../src/core/section/frame'
import { sketchFrameOn } from '../../../src/core/section/frame'
import type { Vec2 } from '../../../src/core/flat/types'
import type { Vec3 } from '../../../src/core/types'
import { addScaled, scale } from '../../../src/core/vec'
import { type Sketch } from './sketch'
import type { EdgeFingerprint, FaceFingerprint } from './topo'
import type { StoredPick } from './where'
import type { ConstrainMode, ConstrainRef } from './autoConstrain'
import type { Profile } from './kernelTypes'
import { DATUM_PLANES } from './datums'
import { type ThreadStandard } from './thread'
import type { SketchImage } from './sketchImage'
import type { SweepRoute } from './sweepRoute'
import { type ResolveContext } from './buildSteps'
export { farReach, frameMap, liftPoint, liftRegions, loftProfile, moveProfiles, pickedProfiles, profileMiddle, profilesMeetAxis, profileSpan, routeSweepGeometry, sideOf, sketchPieces, sweepPath } from './profiles'
export { type BuildStep, type PlaneGeometry, type ResolveContext, type SketchOnFace, SURFACE_MIN_REGION } from './buildSteps'

/** A face or an edge of a body as a feature stores its pick: a
 *  fingerprint re-found on the body as it stands before the feature (see
 *  topo.ts), never an index into a list the next rebuild remakes. */
export type FaceRef = FaceFingerprint
export type EdgeRef = EdgeFingerprint

/** How an extrude's or a revolve's regions were asked for, where by more
 *  than their keys: every region, the largest, or keys and points inside
 *  regions ({ at: [u, v] }) — taken again from the sketch as it stands
 *  whenever it is edited, so a profile redrawn piece by piece is still
 *  picked. `keys` are the regions it came to: while they are still the
 *  feature's regions it stands; regions picked again by hand let it go. */
export interface RegionPick {
  given: 'all' | 'largest' | (string | { at: Vec2 })[]
  keys: string[]
}

/** A feature edited in its box, which holds no queries: the queries its
 *  picks were given by (edgesWhere, facesWhere) carried over from what it
 *  was. Each stands while what it found is still picked (where.ts
 *  livePicks) — an edge taken out in the box lets its query go. */
export function withKeptQueries(old: Feature, next: Feature): Feature {
  if (old.kind !== next.kind) return next
  const was = old as { edgesWhere?: unknown; facesWhere?: unknown }
  const now = next as { edgesWhere?: unknown; facesWhere?: unknown }
  if ((!was.edgesWhere || now.edgesWhere) && (!was.facesWhere || now.facesWhere)) return next
  return { ...next, ...(was.edgesWhere && !now.edgesWhere ? { edgesWhere: was.edgesWhere } : {}), ...(was.facesWhere && !now.facesWhere ? { facesWhere: was.facesWhere } : {}) } as Feature
}

/** How far inside a face the scan is cut for a sketch on it. On the face
 *  itself the plane would pass through the face's own triangles and come
 *  back as a tangle; a hair inside, the cut crosses the walls that meet the
 *  face and gives the outline of the part at that face — which is the
 *  profile wanted. Well under the thinnest wall a scan resolves, and under
 *  the corner gap the fit tolerates. */
export const FACE_SLICE_INSET_MM = 0.25

/** Where a sketch lies: a section's plane, a plane element, or a coordinate
 *  plane at an offset along its axis. A section's plane, a plane element's
 *  and a body's face take an `offset` too: millimetres the plane is moved
 *  along its normal — out of a face, away from it. Absent is none. `up` is
 *  the coordinate axis a sketch's v runs up, as near as the plane lets it:
 *  its u is then `up` × the normal (see resolvePlaneFrame), so a sketch on
 *  a standing plane has Z up whichever way the plane's normal points. */
export type PlaneRef =
  | { kind: 'section'; id: number; offset?: number; up?: WorldAxis }
  | { kind: 'plane'; id: number; offset?: number; up?: WorldAxis }
  | { kind: 'world'; axis: WorldAxis; offset: number; up?: WorldAxis }
  /** A plane through an axis — a line, cylinder, cone or circle element's,
   *  or a coordinate axis through the origin — turned `angleDeg` about it:
   *  u out along the radius, v up the axis, at every angle (radialFrame in
   *  core/section/frame). The sheet's zero is on the axis, level with the
   *  part's origin. */
  | { kind: 'radial'; axis: Extract<AxisRef, { kind: 'element' | 'world' }>; angleDeg: number; offset?: number }
  /** A plane fitted through a face of the scan that was clicked to sketch
   *  on — belonging to no element, so the element list is not littered
   *  with one plane per sketch. The frame is the plane; it moves with the
   *  part under an alignment like a sketch's own frame does. */
  | { kind: 'fitted'; frame: SectionFrame; /** What the plane is, where it is not a clicked face: the scan's symmetry plane. */ label?: string }
  /** A flat face of a body, as a CAD sketch on a face: the face by its
   *  fingerprint, re-found on the body as it stands when a feature on the
   *  sketch is built, and the sketch moved with it — a face pushed out by
   *  an edit to an earlier feature takes its sketch along. `frame` is the
   *  plane as last found — moved out by the offset; a face lost stays with
   *  it. */
  | { kind: 'bodyFace'; body: number; face: FaceRef; frame: SectionFrame; offset?: number }

/** What a revolve turns about: a line or cylinder element's axis, a line of
 *  the sketch itself, or a coordinate axis through the origin. */
export type AxisRef =
  | { kind: 'element'; id: number }
  | { kind: 'sketchLine'; entity: number }
  | { kind: 'world'; axis: WorldAxis }

/** What a solid feature does with what it makes. Join makes one with
 *  every solid body it meets — a new body where it meets none, and one body
 *  of all of them where it bridges several; Cut takes it out of every
 *  solid body it meets; New body keeps it a body of its own, whatever it
 *  overlaps. A feature saved with a `target` joins or cuts that body alone,
 *  as every join and cut once did. */
export type BodyOp = 'new' | 'join' | 'cut'

/** How a body is named: by the feature that made it — and every further
 *  body that feature's step left, a solid in pieces (two profiles apart, a
 *  cut through a body's waist, a pattern of separate copies), by the
 *  feature's id and a fraction, n / ISLAND_IDS. One body is one solid. */
export const ISLAND_IDS = 1024

/** The id of the n-th further body a step leaves (n ≥ 1); the first is the
 *  step's own id. */
export function islandId(stepId: number, n: number): number {
  return stepId + n / ISLAND_IDS
}

/** The feature that made a body, from the body's id. */
export function bodyMaker(bodyId: number): number {
  return Math.floor(bodyId)
}

/** Which of the bodies its step left a body is: 0 for the first. */
export function islandOf(bodyId: number): number {
  return Math.round((bodyId - Math.floor(bodyId)) * ISLAND_IDS)
}

/** Whether a circular pattern's step is a full turn. */
export function fullTurn(stepDeg: number): boolean {
  return Math.abs(Math.abs(stepDeg) - 360) < 1e-9
}

/** The angle from one copy of a circular pattern to the next, degrees: a
 *  full turn shared out among `count`, an open span among `count − 1` —
 *  as the sketch's pattern spaces its copies. */
export function patternPitch(stepDeg: number, count: number): number {
  const n = Math.max(1, Math.round(count))
  return n > 1 ? stepDeg / (fullTurn(stepDeg) ? n : n - 1) : 0
}

/** How far an extrusion reaches, along the sketch plane's normal: offsets
 *  from the plane, a plane to stop at, planes on both sides, a symmetric
 *  span about the sketch, or an end found on the part. */
export type ExtrudeExtent =
  | { kind: 'distance'; from: number; to: number }
  | { kind: 'toPlane'; from: number; plane: PlaneRef }
  | { kind: 'betweenPlanes'; a: PlaneRef; b: PlaneRef }
  | { kind: 'symmetric'; total: number }
  /** Up to a face of a body, picked on the part, found again on the body
   *  as it stands when the extrude runs — a flat one as its whole plane, a
   *  curved one (a cylinder, a cone, a fitted surface) as the face it is:
   *  the profile has to lie under it all. */
  | { kind: 'toFace'; from: number; body: number; face: FaceRef }
  /** Up to the surface of a body — a solid's skin where the profile first
   *  meets it, or a sheet — the way the body lies from the sketch, against
   *  the normal with `reverse` where it lies both ways. */
  | { kind: 'toBody'; from: number; body: number; reverse?: boolean }
  /** Until the profile first meets the body it joins or cuts (or any body,
   *  for a new one) along the normal — against it with `reverse`. */
  | { kind: 'toNext'; from: number; reverse?: boolean }
  /** To the far end of that body: a boss as long as the part, a cut
   *  through all of it. */
  | { kind: 'toLast'; from: number; reverse?: boolean }

/** Whether an extent starts at a typed offset and ends at something found
 *  — the kinds with a From and no To. */
export function extentEndsOnPart(e: ExtrudeExtent): e is Extract<ExtrudeExtent, { kind: 'toPlane' | 'toFace' | 'toBody' | 'toNext' | 'toLast' }> {
  return e.kind === 'toPlane' || e.kind === 'toFace' || e.kind === 'toBody' || e.kind === 'toNext' || e.kind === 'toLast'
}

/** Where an extrude ends when its end is found on the bodies rather than
 *  given: a face of one, a body's surface, the next face of those it is
 *  measured against, or their far end. `against` names the bodies — the
 *  one joined or cut, or every body for a new one; `cutting` says whether
 *  the solid is wanted inside them (a cut) or outside (a boss). */
export type ExtrudeUntil =
  | { kind: 'face'; body: number; face: FaceRef }
  | { kind: 'body'; body: number; reverse: boolean }
  | { kind: 'next' | 'last'; reverse: boolean; against: number[] | 'all'; cutting: boolean }

/** What every feature carries beside its own fields. */
export interface FeatureFlags {
  /** Left out of the build — the part built as if the feature were not
   *  there, a later feature that picked what it made failing as it would
   *  without it — and kept in the list, its picks and numbers as they were,
   *  to be built again. Absent: built. Saved with the project; `visible`
   *  is the viewport's alone. */
  suppressed?: boolean
}

export interface SketchFeature extends FeatureFlags {
  id: number
  kind: 'sketch'
  name: string
  plane: PlaneRef
  /** The plane frozen when the sketch was made — as a section's is — so a
   *  re-fitted plane element does not move a sketch under its regions. */
  frame: SectionFrame
  sketch: Sketch
  /** The expression driving the plane's offset (`offset`) — see
   *  parameters.ts; the plane holds what it last came to. The dimensions'
   *  expressions are on the dimensions. */
  exprs?: Record<string, string>
  /** A picture laid under the sketch to trace — see sketchImage.ts; shown
   *  while the sketch is drawn, nothing to the build. */
  image?: SketchImage
  /** The profile this sketch was moved in from — a loft's inner station —
   *  and by how much: with an expression on `inset`, the profile is moved
   *  in again from `of` as it stands whenever the expression comes to
   *  another wall (parameters.ts). */
  inset?: SketchInset
  visible: boolean
}

/** Where a sketch's inset profile came from: the sketch, the wall, and
 *  the pieces kept where they lie. */
export interface SketchInset {
  of: number
  by: number
  keep: number[]
}

/** A plane moved to an offset along its normal — a face's last-found
 *  frame with it. One that takes no offset comes back as it was. */
export function planeAtOffset(ref: PlaneRef, offset: number): PlaneRef {
  if (!planeTakesOffset(ref) || !Number.isFinite(offset)) return ref
  if (ref.kind !== 'bodyFace') return { ...ref, offset } as PlaneRef
  const delta = offset - planeOffset(ref)
  return { ...ref, offset, frame: { ...ref.frame, origin: addScaled(ref.frame.origin, ref.frame.normal, delta) } }
}

/** How far a plane is moved along its normal: a coordinate plane's
 *  coordinate, the offset of any other — none for a plane fitted where the
 *  scan was clicked, which takes no offset. */
export function planeOffset(ref: PlaneRef): number {
  return ref.kind === 'fitted' ? 0 : (ref.offset ?? 0)
}

/** Whether a plane takes an offset. */
export const planeTakesOffset = (ref: PlaneRef): boolean => ref.kind !== 'fitted'

/** A sketch — or its draft — moved to an offset of its plane: the plane's
 *  offset set and the sketch's frame carried along its normal by the
 *  change, a face's last-found frame with it. Its pieces keep their sheet
 *  coordinates. */
export function withPlaneOffset<T extends { plane: PlaneRef; frame: SectionFrame }>(x: T, offset: number): T {
  if (!planeTakesOffset(x.plane) || !Number.isFinite(offset)) return x
  const delta = offset - planeOffset(x.plane)
  if (Math.abs(delta) < 1e-12) return x
  const shift = (f: SectionFrame): SectionFrame => ({ ...f, origin: addScaled(f.origin, f.normal, delta) })
  const plane = x.plane.kind === 'bodyFace' ? { ...x.plane, offset, frame: shift(x.plane.frame) } : ({ ...x.plane, offset } as PlaneRef)
  return { ...x, plane, frame: shift(x.frame) }
}

/** A flat face of a body as an extrude's profile: the face itself, by its
 *  fingerprint, taken as it stands when the extrude runs — so an earlier
 *  feature that changes the face changes what is pulled from it, as a CAD
 *  face pulled straight does. Nothing is copied into a sketch. */
export interface FaceProfile {
  body: number
  face: FaceRef
}

export interface ExtrudeFeature extends FeatureFlags {
  id: number
  kind: 'extrude'
  name: string
  /** The sketch the profiles come from — 0, and `regions` empty, for an
   *  extrude pulled from a face of a body (`face`). */
  sketchId: number
  /** The sketch’s regions to extrude, by their keys — see regions.ts. An
   *  inner loop left unpicked is a hole. */
  regions: string[]
  /** How the regions were asked for, where by more than their keys. */
  regionPick?: RegionPick
  /** Regions an edit of the sketch found again by where they lie, every
   *  piece round them remade — said on the feature's row while they are
   *  still picked. */
  regionsByPlace?: string[]
  /** A face of a body pulled as it stands, in place of a sketch's regions. */
  face?: FaceProfile
  extent: ExtrudeExtent
  /** Degrees the sides lean in as the extrusion goes away from the sketch
   *  plane — a moulded boss's draft; absent or 0 for straight sides. The
   *  profile is the section at the sketch plane, or at the end of the
   *  extent nearest it; an extent reaching both ways leans both ways from
   *  the plane. The box shows it as a taper the way Fusion does, the other
   *  way round: a positive taper leans the sides out. */
  draftDeg?: number
  /** The way the profile is swept, a unit vector in the part's frame — an
   *  oblique prism, its ends parallel to the sketch plane; the extent's
   *  offsets count along it, and a taper leans the sides about it. Absent:
   *  the sketch plane's normal (a pulled face's). Tapered, the kernel holds
   *  the profile where the plane square to the direction through its middle
   *  crosses the sides, so the outline in the sketch plane strays from the
   *  sketch by up to half its length along the lean × tan(lean) ×
   *  tan(taper) — 0.09 mm for a 10 mm square leaning 11° at 5°. */
  direction?: Vec3
  op: BodyOp
  /** The one body a join or a cut works on, in a feature saved before a
   *  join met every body it touched: the id of the feature that made it.
   *  Absent, a join or a cut works on every body it meets. */
  target?: number
  /** The expressions driving the numbers above, by the field as the box
   *  shows it — see parameters.ts; the numbers hold what they last came
   *  to. Absent when every number was typed as one. */
  exprs?: Record<string, string>
  visible: boolean
}

export interface RevolveFeature extends FeatureFlags {
  id: number
  kind: 'revolve'
  name: string
  sketchId: number
  regions: string[]
  /** As an extrude's. */
  regionPick?: RegionPick
  regionsByPlace?: string[]
  axis: AxisRef
  /** At most a full turn for a plain revolve; any number of turns for one
   *  with a pitch. */
  angleDeg: number
  /** Millimetres the profile climbs along the axis every full turn — a coil
   *  or a thread; absent or 0 for a plain revolve. A negative pitch climbs
   *  against the axis's direction. */
  pitch?: number
  /** With a pitch: the screw turns clockwise seen down the way it climbs —
   *  a left-hand thread. Absent is right-handed. */
  leftHanded?: boolean
  op: BodyOp
  target?: number
  /** The expressions driving the numbers above, by the field as the box
   *  shows it — see parameters.ts; the numbers hold what they last came
   *  to. Absent when every number was typed as one. */
  exprs?: Record<string, string>
  visible: boolean
}

/** The angle a revolve with no pitch turns at most: a whole turn. */
export const FULL_TURN_DEG = 360

/** The least an extrude's direction leaves its sketch plane by: a sweep
 *  nearer the plane than this is a sliver, and along it none at all. */
export const MIN_SWEEP_RAD = (1 * Math.PI) / 180

/** The angle a coil turns at most: a thousand turns. */
export const MAX_COIL_DEG = 360 * 1000

/** The most a revolve may turn, with its pitch or without one. */
export function revolveMaxDeg(pitch: number | undefined): number {
  return pitch ? MAX_COIL_DEG : FULL_TURN_DEG
}

/** Hollow a body to a wall: the faces named are taken away to open it;
 *  none named leaves it closed, hollow inside. */
export interface ShellFeature extends FeatureFlags {
  id: number
  kind: 'shell'
  name: string
  /** The body worked on: the id of the feature that made it. */
  body: number
  faces: FaceRef[]
  /** The queries (where) the faces were picked by — see FilletFeature's
   *  edgesWhere. */
  facesWhere?: StoredPick<FaceRef>[]
  thickness: number
  /** The expressions driving the numbers above, by the field as the box
   *  shows it — see parameters.ts; the numbers hold what they last came
   *  to. Absent when every number was typed as one. */
  exprs?: Record<string, string>
  visible: boolean
}

export interface FilletFeature extends FeatureFlags {
  id: number
  kind: 'fillet'
  name: string
  body: number
  edges: EdgeRef[]
  /** The queries (where) the edges were picked by, each with what it
   *  found then — run again at build on the body as it stands before the
   *  feature, so the edges a sketch edit remade are picked as the query
   *  names them now. `edges` holds what each found, the fallback where it
   *  finds nothing now. Absent for edges picked by index, fingerprint or
   *  click, and in a project saved before. */
  edgesWhere?: StoredPick<EdgeRef>[]
  radius: number
  /** Whether the edges tangent-continuous with the picked ones are rounded
   *  too — the whole way round a rounded rectangle from one side. */
  chain: boolean
  /** Round what the kernel can: a chain it cannot round is left out, and
   *  the result's note says where, instead of the whole round failing. */
  skipFailing?: boolean
  /** Edges rounded at a radius running evenly from the first to the second
   *  along each — the first at the edge's first end as body.describe lists
   *  it — beside `edges` at `radius`; each its own, after those, no chain. */
  variable?: VariableEdge[]
  /** The expressions driving the numbers above, by the field as the box
   *  shows it — see parameters.ts; the numbers hold what they last came
   *  to. Absent when every number was typed as one. */
  exprs?: Record<string, string>
  visible: boolean
}

/** An edge a fillet rounds at a varying radius: from `radius[0]` at its
 *  first end to `radius[1]` at its other. */
export interface VariableEdge {
  edge: EdgeRef
  radius: [number, number]
}

/** How a chamfer cuts each face back from its edge: by one distance on
 *  both, by two — `distance` on the edge's reference face, `distance2` on
 *  the other — or by `distance` on the reference face and the angle the
 *  chamfer makes with it. */
export type ChamferMode = 'equal' | 'twoDistances' | 'distanceAngle'

export interface ChamferFeature extends FeatureFlags {
  id: number
  kind: 'chamfer'
  name: string
  body: number
  edges: EdgeRef[]
  /** As a fillet's. */
  edgesWhere?: StoredPick<EdgeRef>[]
  distance: number
  chain: boolean
  /** Bevel what the kernel can: a chain it cannot bevel is left out, and
   *  the result's note says where, instead of the whole chamfer failing. */
  skipFailing?: boolean
  /** Absent: one distance on both faces. */
  mode?: ChamferMode
  /** Two distances: the setback on the face across from the reference. */
  distance2?: number
  /** Distance and angle: degrees between the chamfer and the reference
   *  face, under 90. */
  angleDeg?: number
  /** The reference face of each edge is the face shared by the most of the
   *  edges chamfered — a rim's top — or, edge by edge where none is, the
   *  kernel's first; flipped, the other face. */
  flip?: boolean
  /** The expressions driving the numbers above, by the field as the box
   *  shows it — see parameters.ts; the numbers hold what they last came
   *  to. Absent when every number was typed as one. */
  exprs?: Record<string, string>
  visible: boolean
}

/** What a hole is drilled along: a cylinder or circle element's axis, a
 *  cylindrical face of the body itself — both ways from its point — or a
 *  flat face of the body, drilled into the body square to it from a point
 *  on it (`at`: the face's centre, as a click takes it — a boss's top). */
export type HoleAxis = { kind: 'element'; id: number } | { kind: 'face'; face: FaceRef } | { kind: 'point'; face: FaceRef; at: Vec3 }

export interface HoleFeature extends FeatureFlags {
  id: number
  kind: 'hole'
  name: string
  body: number
  axis: HoleAxis
  radius: number
  /** Millimetres along the axis from its point, both ways — into the body
   *  alone from a flat face; null drills through everything. */
  depth: number | null
  /** The heat-set insert it is sized for, by its label (inserts.ts) — what
   *  the box offers again; the hole is cut to its radius and depth. */
  insert?: string
  /** The expressions driving the numbers above, by the field as the box
   *  shows it — see parameters.ts; the numbers hold what they last came
   *  to. Absent when every number was typed as one. */
  exprs?: Record<string, string>
  visible: boolean
}

/** A screw thread cut on a full round face of a body: a bolt's on a boss, a
 *  nut's in a bore, as the side the face looks to says — the size taken
 *  from a standard's table or typed as a diameter and a pitch, the whole
 *  face long or a length in from one end. The profile is the basic one of
 *  the standard's form — the 60° vee, or the 45° form for printing; see
 *  thread.ts. */
export interface ThreadFeature extends FeatureFlags {
  id: number
  kind: 'thread'
  name: string
  body: number
  face: FaceRef
  /** The table the size was chosen from — what the box offers again — and
   *  the form the thread is cut in. The thread is cut to the diameter and
   *  the pitch, whatever the table says. */
  standard: ThreadStandard
  /** The major diameter, millimetres. */
  diameter: number
  pitch: number
  leftHanded: boolean
  /** Millimetres along the face; null runs the whole face. */
  length: number | null
  /** Millimetres in from the face's end that a thread with a length starts
   *  at: the far end along the face's axis. */
  start: number
  /** Measured from the other end of the face. */
  flip: boolean
  /** A clearance for printing: millimetres every face of the thread is
   *  moved into the material. */
  offset: number
  /** A 45° chamfer where the thread runs out of the body — a bolt's tip, a
   *  bore's mouth — from just past the root. Absent is none. */
  chamfer?: boolean
  /** The expressions driving the numbers above, by the field as the box
   *  shows it — see parameters.ts; the numbers hold what they last came
   *  to. Absent when every number was typed as one. */
  exprs?: Record<string, string>
  visible: boolean
}

/** A measured element as a body at its extents — the fitted ones, with
 *  whatever Measure's Extend added to them: a plane as a slab, a cylinder
 *  or a cone as a solid of its length, a sphere as a ball — or a shadow
 *  section as the block it stands as, its outline through the part's
 *  thickness. One of `element` and `section`. */
export interface ExtractFeature extends FeatureFlags {
  id: number
  kind: 'extract'
  name: string
  element?: number
  /** A shadow section, by id: the body follows its outline and thickness
   *  as 3D Measure takes them again. */
  section?: number
  /** A slab's thickness, centred on the plane. */
  thickness: number
  op: BodyOp
  target?: number
  /** The expressions driving the numbers above, by the field as the box
   *  shows it — see parameters.ts; the numbers hold what they last came
   *  to. Absent when every number was typed as one. */
  exprs?: Record<string, string>
  visible: boolean
}

export interface CutPlaneFeature extends FeatureFlags {
  id: number
  kind: 'cutPlane'
  name: string
  body: number
  plane: PlaneRef
  /** Which side stays: the side the plane's normal points to (1) or the
   *  other (−1). */
  keep: 1 | -1
  /** The expression driving the plane's offset (`plane.offset`) — see
   *  parameters.ts; the plane holds what it last came to. */
  exprs?: Record<string, string>
  visible: boolean
}

export type MirrorPlane = PlaneRef | { kind: 'face'; face: FaceRef }

export interface MirrorFeature extends FeatureFlags {
  id: number
  kind: 'mirror'
  name: string
  body: number
  plane: MirrorPlane
  /** Joined with the source into one body, or a body of its own. */
  join: boolean
  /** The expression driving the plane's offset (`plane.offset`), where the
   *  plane is not a face — see parameters.ts. */
  exprs?: Record<string, string>
  visible: boolean
}

/** Faces of a body leaned about a neutral plane — a moulding's draft, put
 *  on after the fact: the neutral plane is where the faces keep their place
 *  (a flat face of the body, or any plane), and a positive angle leans them
 *  in as they go away from it into the body. */
export interface DraftFeature extends FeatureFlags {
  id: number
  kind: 'draft'
  name: string
  body: number
  neutral: MirrorPlane
  faces: FaceRef[]
  /** The queries (where) `faces` were picked by — see FilletFeature's
   *  edgesWhere; a group's faces keep their fingerprints alone. */
  facesWhere?: StoredPick<FaceRef>[]
  angleDeg: number
  /** More faces, each group at an angle of its own, leaned after `faces`
   *  in the order given — one feature for walls drafted differently.
   *  Absent for one angle. */
  groups?: DraftGroup[]
  /** The expressions driving the numbers above, by the field as the box
   *  shows it — see parameters.ts; the numbers hold what they last came
   *  to. Absent when every number was typed as one. */
  exprs?: Record<string, string>
  visible: boolean
}

/** Faces a draft leans at an angle of their own. */
export interface DraftGroup {
  faces: FaceRef[]
  angleDeg: number
}

/** Faces of a body moved by one offset: a flat face along its outward
 *  normal by `offset` millimetres, a full cylinder's radius changed by it —
 *  CAD's offset of faces. Several picked together are a whole made larger
 *  or smaller: a cylinder's wall and its ends, every face of a block. What
 *  a face snapped onto the scan becomes, too — the offset read off an
 *  element fitted where the scan was clicked, and a number from then on, so
 *  a rebuild does not fit the scan again. Saved before several faces could
 *  be picked, a file holds the one `face` (see projectSection.ts). */
export interface MoveFaceFeature extends FeatureFlags {
  id: number
  kind: 'moveFace'
  name: string
  body: number
  faces: FaceRef[]
  /** As a shell's. */
  facesWhere?: StoredPick<FaceRef>[]
  offset: number
  /** The expressions driving the numbers above, by the field as the box
   *  shows it — see parameters.ts; the numbers hold what they last came
   *  to. Absent when every number was typed as one. */
  exprs?: Record<string, string>
  visible: boolean
}

/** Faces of a body taken off and the faces round them run on to close the
 *  gap — CAD's delete face: a fillet, a chamfer, a hole, a boss taken out
 *  of a part, the neighbours healed over where it was. */
export interface DeleteFaceFeature extends FeatureFlags {
  id: number
  kind: 'deleteFace'
  name: string
  body: number
  faces: FaceRef[]
  /** As a shell's — for faces picked alone, not each with what a click on
   *  it takes (whole). */
  facesWhere?: StoredPick<FaceRef>[]
  visible: boolean
}

/** A body grown all round by a distance — its convex edges rounded over,
 *  as an offset rounds them — or shrunk by a negative one: the keep-out
 *  round a bought-in part, the pocket it sits in with its clearance. Kept,
 *  the body stays as it was and the offset is a body of its own; not, the
 *  body becomes the offset. */
export interface OffsetBodyFeature extends FeatureFlags {
  id: number
  kind: 'offsetBody'
  name: string
  body: number
  /** Millimetres out — in, negative. */
  distance: number
  keep: boolean
  /** The expressions driving the numbers above, by the field as the box
   *  shows it — see parameters.ts; the numbers hold what they last came
   *  to. Absent when every number was typed as one. */
  exprs?: Record<string, string>
  visible: boolean
}

/** A STEP file as an Import holds it: the file's name and size as it came
 *  in, and the key its text is kept under — a digest of the text, so the
 *  same file imported twice is kept once. The text itself is the store's
 *  (stepFiles), the project's archive and the kernel worker's, never the
 *  feature's: a feature is copied into every step of the undo history and
 *  every build request. */
export interface StepFileRef {
  key: string
  name: string
  size: number
}

/** The key a STEP file's text is kept under: its length and a 53-bit
 *  digest of it (cyrb53), so one file imported twice is one file, and two
 *  files alike in their first megabyte are not. */
export function stepFileKey(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  const digest = 4294967296 * (2097151 & h2) + (h1 >>> 0)
  return `${text.length.toString(36)}-${digest.toString(36)}`
}

/** A STEP file brought in as bodies of their own — a bought-in part, a
 *  mating part, the CAD model to check the scan against: a body per solid
 *  in the file, named after its part where the file names it. A file of
 *  faces with no solid comes in as a surface body. */
export interface ImportFeature extends FeatureFlags {
  id: number
  kind: 'import'
  name: string
  file: StepFileRef
  visible: boolean
}

/** Bodies moved and turned — or copies of them, the bodies left as they
 *  were: turned about `pivot` about X, then Y, then Z by `rotate` degrees,
 *  then carried by `translate` millimetres (move.ts). */
export interface MoveBodyFeature extends FeatureFlags {
  id: number
  kind: 'moveBody'
  name: string
  bodies: number[]
  pivot: Vec3
  translate: Vec3
  rotate: Vec3
  /** The bodies stay where they are and copies of them are moved. */
  copy: boolean
  /** The expressions driving the numbers above, by the field as the box
   *  shows it — see parameters.ts; the numbers hold what they last came
   *  to. Absent when every number was typed as one. */
  exprs?: Record<string, string>
  visible: boolean
}

export type BooleanOp = 'join' | 'cut' | 'intersect'

/** Two bodies made separately into one: the tool goes into the body —
 *  or, kept, stays a body of its own beside it, as it was. */
export interface BooleanFeature extends FeatureFlags {
  id: number
  kind: 'boolean'
  name: string
  op: BooleanOp
  body: number
  /** One body, or several: joined all, or cut or intersected by each in
   *  turn. A project from before several keeps one. */
  tool: number | number[]
  keep?: boolean
  visible: boolean
}

/** A Combine's tools as a list, one or several. */
export function toolsOf(f: { tool: number | readonly number[] }): number[] {
  return typeof f.tool === 'number' ? [f.tool] : [...f.tool]
}

/** A sketch's pieces — an open chain, or a closed one — extruded as a
 *  surface, not a solid: a cutter to split a body with, a body of its own
 *  in the list, marked as a surface, never exported alone. */
export interface SheetFeature extends FeatureFlags {
  id: number
  kind: 'sheet'
  name: string
  sketchId: number
  /** Millimetres along the sketch plane's normal, either way. */
  from: number
  to: number
  /** The expressions driving the numbers above, by the field as the box
   *  shows it — see parameters.ts; the numbers hold what they last came
   *  to. Absent when every number was typed as one. */
  exprs?: Record<string, string>
  visible: boolean
}

/** Which fragments of a split body are kept: the ones lying on the scan
 *  (the cell test — a fragment whose faces are mostly on the scan is
 *  part), simply the largest or the smallest, or those lying between the
 *  sheets — a fragment with a face on every one of the tools: the wall
 *  between a part's outer and inner skin, each fitted to the scan. */
export type SplitKeep = 'scan' | 'largest' | 'smallest' | 'between'

/** Which way a sheet is thickened: along its normal (out), against it
 *  (in), or half the thickness each way (both). */
export type ThickenSide = 'in' | 'out' | 'both'

/** A sheet — a fitted surface, a sheet drawn from a sketch — made a solid
 *  of a thickness: a freeform thin shell's wall from its one skin, where a
 *  shell or an offset of a lofted body will not go. The sheet stays a body
 *  of its own; the solid is a new body, or joined to or cut from what it
 *  meets as a loft's is. */
export interface ThickenFeature extends FeatureFlags {
  id: number
  kind: 'thicken'
  name: string
  /** The sheet body thickened, by the id of the feature that made it. */
  sheet: number
  /** Millimetres, through the wall. */
  thickness: number
  side: ThickenSide
  op: BodyOp
  target?: number
  /** The expressions driving the numbers above, by the field as the box
   *  shows it — see parameters.ts; the numbers hold what they last came
   *  to. Absent when every number was typed as one. */
  exprs?: Record<string, string>
  visible: boolean
}

export interface SplitFeature extends FeatureFlags {
  id: number
  kind: 'split'
  name: string
  body: number
  /** The sheet bodies (and solid bodies) cutting it, by feature id. */
  tools: number[]
  keep: SplitKeep
  /** How far a sampled point of a fragment's face may lie from the scan
   *  and still count as on it, millimetres. */
  tolerance: number
  /** The share of a fragment's samples that must lie on the scan. */
  overlap: number
  /** Cut within the fitted sheets' regions: each sheet trimmed to its
   *  region's outline grown by this many millimetres before it cuts, the
   *  body outside the outlines left as it was — so only the part of a
   *  sheet that was fitted cuts, not its margin or its carrying on. Absent:
   *  the whole sheet, carried on to the body's sides where it stops short. */
  within?: number
  /** The expressions driving the numbers above, by the field as the box
   *  shows it — see parameters.ts; the numbers hold what they last came
   *  to. Absent when every number was typed as one. */
  exprs?: Record<string, string>
  visible: boolean
}

/** A solid through the profiles of two or more sketches, each on its own
 *  plane — a rib between two sections, a boss that tapers. */
export interface LoftFeature extends FeatureFlags {
  id: number
  kind: 'loft'
  name: string
  /** In order; each sketch's one region, or its largest. */
  sketches: number[]
  /** Straight between the profiles, or a smooth surface through them. */
  ruled: boolean
  op: BodyOp
  target?: number
  visible: boolean
}

/** A profile swept along a path — a bent bar, a handle, the rim of a shell
 *  that follows a curve: one sketch's largest region carried along another
 *  sketch's one chain of lines and arcs, or along a route of straights and
 *  bends in 3D, the section held square to the path and turning as little
 *  as it can. The profile's plane stands square to the path where it starts. */
export interface SweepFeature extends FeatureFlags {
  id: number
  kind: 'sweep'
  name: string
  /** The sketch whose largest region is swept. */
  profile: number
  /** The sketch whose one chain the profile follows, from its end nearest
   *  the profile. Absent where the sweep has a route. */
  path?: number
  /** The centreline in the part's frame, in place of a path: it moves with
   *  the part as a sketch's frame does, and reads no sketch. */
  route?: SweepRoute
  op: BodyOp
  target?: number
  visible: boolean
  exprs?: Record<string, string>
}

export interface PatternFeature extends FeatureFlags {
  id: number
  kind: 'pattern'
  name: string
  body: number
  mode: 'circular' | 'linear'
  /** Circular: the axis turned about. Linear: the direction stepped
   *  along. */
  axis: AxisRef
  count: number
  /** Circular: the angle from the first copy to the last, degrees — 360
   *  is a full turn, `count` copies round with none on the first (see
   *  patternPitch). Linear: the spacing, millimetres. Projects saved
   *  before part version 2 held a circular pitch × count here, and are
   *  turned into the span on load. */
  step: number
  /** Linear only: a second direction the row is repeated along — a grid,
   *  `count2` rows `step2` millimetres apart. Absent, or a count of one, is
   *  a single row. */
  axis2?: AxisRef
  count2?: number
  step2?: number
  /** The expressions driving the numbers above, by the field as the box
   *  shows it — see parameters.ts; the numbers hold what they last came
   *  to. Absent when every number was typed as one. */
  exprs?: Record<string, string>
  visible: boolean
}

/** The parameters a freeform surface is fitted with — see
 *  core/re/surfaceFit. */
export interface SurfaceFitParams {
  /** The control net, U × V, or null for the fit to choose from the
   *  region's extent and scatter. */
  net: { u: number; v: number } | null
  degree: number
  /** How far past the region's bounds the surface reaches, as a share of
   *  its extent — a surface is trimmed against its neighbours later and
   *  has to reach them. */
  expandPct: number
  /** The weight of the thin-plate term relative to the data's, so the
   *  surface stays fair where the region is thin or noisy. */
  smoothness: number
  /** Fit again without the points that stand far off the first fit — a rib
   *  or a stray edge caught in the region. Absent is false. */
  robust?: boolean
  /** The height direction the surface is fitted along, any length — the
   *  way the region faces. Absent: the region's own principal normal. */
  normal?: Vec3
}

/** The box a surface's region was read in off the scan, with what else
 *  the query asked — kept so the box's numbers can follow parameters. */
export interface RegionBox {
  box: { min: Vec3; max: Vec3 }
  normal?: { dir: Vec3; withinDeg?: number }
  exclude?: { min: Vec3; max: Vec3 }[]
  limit?: number
}

/** A freeform surface fitted through a region of the scan — a body of its
 *  own, marked as a surface, for the automatic trim to close into a solid
 *  with the others. The region is a set of the scan's vertices, held by
 *  the feature alone: it takes nothing from a Measure element's ownership
 *  and may overlap a neighbour's at a seam. */
export interface SurfaceFeature extends FeatureFlags {
  id: number
  kind: 'surface'
  name: string
  region: Uint32Array
  fit: SurfaceFitParams
  /** What is fitted through the region. Absent is `freeform`, what every
   *  surface saved before there was a choice is. */
  shape?: SurfaceShape
  /** A plane's or a cylinder's Auto Constrain; absent is `auto`. */
  constrain?: ConstrainMode
  /** The box the region was read in, where it was asked for by one — its
   *  numbers driven by `exprs` (`region.box.min.x` …), see parameters.ts.
   *  `regionStale`: the box moved with the parameters since the region was
   *  read, and the points in it are read again before the next build — or,
   *  a string, why they could not be. */
  regionBox?: RegionBox
  regionStale?: true | string
  exprs?: Record<string, string>
  visible: boolean
}

/** A point of a patch network: a curve's end, or a corner — on the scan, in
 *  the scan's frame, and taken onto it again at every build; or on a body's
 *  edge or corner (`on`), where it is found again on the body as built. */
export interface NetworkNode {
  id: number
  at: Vec3
  on?: { body: number; edge: EdgeRef; t: number } | { body: number; vertex: EdgeRef; end: 0 | 1 }
  /** Whether the node is a corner of the cells it bounds, over the rule
   *  (the boundary turning more than 30° there). Absent: the rule. */
  corner?: boolean
}

/** A curve of a patch network, from one node to another through its grips
 *  (`via`), along the scan between them. */
export interface NetworkCurve {
  id: number
  from: number
  to: number
  via: Vec3[]
  /** A fold or a parting line: the patches either side meet at an angle.
   *  Absent: they meet tangent. */
  crease?: boolean
  /** The curve runs along a body's edge: its points are the edge's. */
  along?: { body: number; edge: EdgeRef }
  /** The patch beside a body's face meets it there: on its edge (contact)
   *  or tangent to the face too. */
  side?: { body: number; face: FaceRef; mode: 'contact' | 'tangent' }
}

/** A cell of a network filled with a patch: which region was filled, by a
 *  point inside it — it stays filled when its curves move — and, for a
 *  cell of three, five or six sides split into four-sided ones, where its
 *  centre was dragged to. A patch placed by its corners keeps them
 *  (`corners`, node ids in order round it): they are its corners however
 *  little the boundary turns there, and the box puts its seed back in its
 *  middle when they move. */
export interface NetworkCell {
  seed: Vec3
  centre?: Vec3
  corners?: number[]
}

/** How a network's patches are fitted to the scan. */
export interface NetworkFitParams {
  /** The fairing term's weight, as Fit Surface's smoothness. */
  smoothness: number
  /** Fit again without the points past three sigmas of the first pass. */
  robust?: boolean
  /** How far Auto lets a patch stray from the scan beyond its noise before
   *  its strips get more spans, mm (networkCurve's DEFAULT_TOLERANCE if
   *  none). */
  tolerance?: number
}

/** A Patch network: curves drawn on the scan, and the regions they close
 *  filled with B-spline patches fitted to the scan together — sharing
 *  their edges and meeting tangent across every curve not marked a crease
 *  (core/network.ts). One body: a sheet, or a solid where the network
 *  closes. */
export interface NetworkFeature extends FeatureFlags {
  id: number
  kind: 'network'
  name: string
  nodes: NetworkNode[]
  curves: NetworkCurve[]
  cells: NetworkCell[]
  /** The span count of a strip of patches (networkFit.ts), keyed by the id
   *  of a curve in it; a strip with none is Auto. */
  spans: Record<string, number>
  fit: NetworkFitParams
  visible: boolean
}

/** A fitted surface's kind: the freeform B-spline, or a plane or a cylinder
 *  — exact faces, held square and parallel to what the part already has
 *  (core/re/autoConstrain), and cutting a trim as the whole plane or
 *  cylinder rather than as the patch that is drawn. */
export type SurfaceShape = 'freeform' | 'plane' | 'cylinder'

/** What a plane or cylinder fitted in the workspace can be held to, as far
 *  as the feature list's own context knows it: the part's coordinate planes
 *  and the measured planes, cylinders and cones. The surfaces fitted before
 *  it are the builder's to add — their fits are made there. */
export function constrainRefs(elements: ResolveContext['elements']): ConstrainRef[] {
  const refs: ConstrainRef[] = DATUM_PLANES.map((p) => ({ key: `datum:${p.plane}`, kind: 'plane', name: p.name, origin: [0, 0, 0], normal: p.normal }))
  for (const e of elements) {
    const fit = e.fit
    if (!fit) continue
    const name = e.name ?? `Element ${e.id}`
    if (fit.kind === 'plane') refs.push({ key: `element:${e.id}`, kind: 'plane', name, origin: fit.center, normal: fit.normal })
    else if (fit.kind === 'cylinder' || fit.kind === 'cone') refs.push({ key: `element:${e.id}`, kind: 'axis', name, origin: fit.center, dir: fit.axis })
  }
  return refs
}

/** What an automatic trim cuts space with: a surface body (a fitted
 *  surface, a sheet — or a solid, whose faces count) or a measured plane,
 *  cylinder, cone or sphere, reaching past the part. */
export type TrimTool = { kind: 'body'; id: number } | { kind: 'element'; id: number }

/** A set of surfaces closed into a solid: a box round the scan is split by
 *  every tool, and of the faces that makes, the ones lying on the scan are
 *  kept and sewn. A set that does not close leaves a surface body of the
 *  kept faces, its open edges reported. */
export interface TrimFeature extends FeatureFlags {
  id: number
  kind: 'trim'
  name: string
  tools: TrimTool[]
  /** How far a sampled point of a face may lie from the scan and still
   *  count as on it, millimetres. */
  tolerance: number
  /** The share of a face's samples that must lie on the scan. */
  overlap: number
  /** The expressions driving the numbers above, by the field as the box
   *  shows it — see parameters.ts; the numbers hold what they last came
   *  to. Absent when every number was typed as one. */
  exprs?: Record<string, string>
  visible: boolean
}

/** A measured element as a trim tool, resolved: a plane by its frame,
 *  the others as the primitives Extract makes, which the builder oversizes
 *  to reach past the part. */
export type TrimPrimitive = { kind: 'plane'; origin: Vec3; normal: Vec3; basisU: Vec3; basisV: Vec3 } | Exclude<Primitive, { kind: 'slab' | 'prism' }>

export type BodyFeature = ShellFeature | FilletFeature | ChamferFeature | HoleFeature | ThreadFeature | CutPlaneFeature | MirrorFeature | BooleanFeature | SplitFeature | PatternFeature | DraftFeature | MoveFaceFeature | DeleteFaceFeature | OffsetBodyFeature
export type Feature = SketchFeature | ExtrudeFeature | RevolveFeature | ExtractFeature | SheetFeature | LoftFeature | SweepFeature | ThickenFeature | SurfaceFeature | NetworkFeature | TrimFeature | ImportFeature | MoveBodyFeature | BodyFeature

/** The solid an extracted element or shadow becomes, resolved to plain
 *  geometry. */
export type Primitive =
  | { kind: 'slab'; origin: Vec3; normal: Vec3; basisU: Vec3; basisV: Vec3; extentU: number; extentV: number; thickness: number }
  | { kind: 'cylinder'; origin: Vec3; axis: Vec3; radius: number; length: number }
  | { kind: 'cone'; origin: Vec3; axis: Vec3; radius1: number; radius2: number; length: number }
  | { kind: 'sphere'; center: Vec3; radius: number }
  | { kind: 'torus'; center: Vec3; axis: Vec3; majorRadius: number; minorRadius: number }
  /** Profiles in the part stood along `dir` from `from` to `to` mm off
   *  their plane — a shadow section's block. */
  | { kind: 'prism'; profiles: Profile[]; dir: Vec3; from: number; to: number }

/** The frame a sketch on a body's planar face lies in: the face's plane
 *  with its normal outward, the sheet's zero and X by the sketch rule
 *  (sketchFrameOn) — or null for a face that is not a plane. */
export function frameOnFace(face: FaceFingerprint): SectionFrame | null {
  if (face.kind !== 'plane') return null
  return sketchFrameOn({ origin: face.centroid, normal: face.dir })
}

/** Whether Move face takes a face: a flat one, or a round one with a
 *  radius to change. That a round face goes the whole way round is the
 *  kernel's to tell — the fingerprint does not say; a face read off a
 *  build does (partialRound). */
export function movableFace(face: FaceFingerprint): boolean {
  return face.kind === 'plane' || face.kind === 'cylinder'
}

/** Whether a face of a build is a round one known to stop short of a full
 *  turn — a fillet's quarter of a cylinder, a boss cut in half. A thread
 *  is not cut on it and its radius is not changed: both need the whole
 *  way round. A pick taken back from a feature does not know, and passes. */
export function partialRound(face: { fullTurn?: boolean }): boolean {
  return face.fullTurn === false
}

/** The sketch plane a body's face makes, by its fingerprint: the reference
 *  a sketch on it is stored with, or null for a face that is not flat. */
export function bodyFacePlane(body: number, face: FaceFingerprint): Extract<PlaneRef, { kind: 'bodyFace' }> | null {
  const frame = frameOnFace(face)
  return frame && { kind: 'bodyFace', body, face, frame }
}

/** The ids of the features this one builds on: its sketch, the body it
 *  joins, cuts, works on or combines with — a sketch, the body whose face
 *  it lies on and what its pieces are projected from. */
export function referencesOf(f: Feature): number[] {
  switch (f.kind) {
    case 'sketch': {
      const refs: number[] = f.plane.kind === 'bodyFace' ? [f.plane.body] : []
      for (const e of f.sketch.entities) {
        const from = e.projected && e.source ? ('body' in e.source ? e.source.body : e.source.sketch) : undefined
        if (from !== undefined && from !== f.id && !refs.includes(from)) refs.push(from)
      }
      return refs
    }
    case 'extrude': {
      const refs = f.face ? [f.face.body] : [f.sketchId]
      if (f.target !== undefined && !refs.includes(f.target)) refs.push(f.target)
      return (f.extent.kind === 'toFace' || f.extent.kind === 'toBody') && !refs.includes(f.extent.body) ? [...refs, f.extent.body] : refs
    }
    case 'revolve':
      return f.target === undefined ? [f.sketchId] : [f.sketchId, f.target]
    case 'extract':
      return f.target === undefined ? [] : [f.target]
    case 'boolean':
      return [f.body, ...toolsOf(f)]
    case 'sheet':
      return [f.sketchId]
    case 'surface': {
      // Held by hand to a surface fitted before it; what Auto finds is not a
      // reference — with that surface gone the fit is simply free of it.
      const held = f.constrain?.mode === 'force' ? /^surface:(\d+)$/.exec(f.constrain.ref) : null
      return held ? [Number(held[1])] : []
    }
    case 'network': {
      // The bodies its curves run along and its patches meet.
      const refs: number[] = []
      const add = (id: number) => {
        if (!refs.includes(id)) refs.push(id)
      }
      for (const n of f.nodes) if (n.on) add(n.on.body)
      for (const c of f.curves) {
        if (c.along) add(c.along.body)
        if (c.side) add(c.side.body)
      }
      return refs
    }
    case 'trim':
      return f.tools.filter((t) => t.kind === 'body').map((t) => t.id)
    case 'split':
      return [f.body, ...f.tools]
    case 'loft':
      return f.target === undefined ? [...f.sketches] : [...f.sketches, f.target]
    case 'sweep':
      return [f.profile, ...(f.path === undefined ? [] : [f.path]), ...(f.target === undefined ? [] : [f.target])]
    case 'thicken':
      return f.target === undefined ? [f.sheet] : [f.sheet, f.target]
    case 'import':
      return []
    case 'moveBody':
      return [...f.bodies]
    default:
      return [f.body]
  }
}

/** Features that depend on the given one — what deleting it would orphan:
 *  a feature on a body it made counts, a further body of its step too. */
export function dependentsOf(id: number, features: readonly Feature[]): Feature[] {
  return features.filter((f) => referencesOf(f).some((r) => bodyMaker(r) === id))
}

/** The features one builds on, by id, for its place in the list: what it
 *  references, the features that made the faces and edges it picks (their
 *  fingerprints' origin, a query's madeBy), and the bodies whose faces its
 *  planes lie on. */
export function builtOn(f: Feature): number[] {
  const ids = new Set(referencesOf(f).map(bodyMaker))
  const walk = (v: unknown, key?: string) => {
    if (v === null || typeof v !== 'object') {
      if (key === 'madeBy' && typeof v === 'number') ids.add(bodyMaker(v))
      return
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, key)
      return
    }
    const o = v as Record<string, unknown>
    // A face's or an edge's fingerprint: what first made it.
    if (typeof o.origin === 'number' && ('centroid' in o || 'mid' in o)) ids.add(bodyMaker(o.origin))
    if (o.kind === 'bodyFace' && typeof o.body === 'number') ids.add(bodyMaker(o.body))
    for (const [k, x] of Object.entries(o)) if (k !== 'sketch' || f.kind !== 'sketch') walk(x, k)
  }
  walk(f)
  ids.delete(f.id)
  return [...ids]
}

/**
 * The list with the features `ids` moved, in the order they stand, to just
 * after the feature `after` (null: to the top) — or why not: a feature
 * moved that would then come before one it builds on (builtOn), or one it
 * is moved past that builds on it. Ids, names and picks stay as they are.
 */
export function movedList(features: readonly Feature[], ids: readonly number[], after: number | null): Feature[] | string {
  const moving = features.filter((f) => ids.includes(f.id))
  if (after !== null && ids.includes(after)) return `after names a feature that is moved — name one that stays.`
  const rest = features.filter((f) => !ids.includes(f.id))
  const at = after === null ? 0 : rest.findIndex((f) => f.id === after) + 1
  const order = [...rest.slice(0, at), ...moving, ...rest.slice(at)]
  const place = new Map(order.map((f, i) => [f.id, i]))
  for (const f of order) {
    for (const used of builtOn(f)) {
      const u = order[place.get(used) ?? -1]
      if (!u || place.get(used)! < place.get(f.id)! || !(ids.includes(f.id) || ids.includes(used))) continue
      return ids.includes(f.id)
        ? `${f.name} builds on ${u.name}, which would then come after it — move ${u.name} with it, or put ${f.name} lower.`
        : `${f.name} builds on ${u.name}, which the move puts after it — move ${f.name} with it, or put ${u.name} higher.`
    }
  }
  return order
}

export { scale as scaleVec }

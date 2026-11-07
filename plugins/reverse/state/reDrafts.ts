// SPDX-License-Identifier: AGPL-3.0-only
// Pure reads of the workspace's state and the rules its drafts follow: which
// features are built and which wait, whether an extrude, a revolve or a
// feature box is ready, what a snap edits, the key number a feature shows,
// what a grip's field reads. No state here; the store calls these.

import type { WorldAxis } from '../../../src/core/section/frame'
import type { Vec3 } from '../../../src/core/types'
import type { DisplayUnits } from '../../../src/core/units'
import { addScaled, cross, normalize } from '../../../src/core/vec'
import { PALETTE } from '../../../src/state/palette'
import type { FaceInfo, FeatureResult } from '../core/build'
import { bodyMaker, type DraftFeature, extentEndsOnPart, type Feature, islandOf, pickedProfiles, profileSpan, type ResolveContext, revolveMaxDeg, type SketchFeature, SURFACE_MIN_REGION, type TrimTool } from '../core/features'
import { resolveAxis } from '../core/resolve'
import { movesNothing, pivotOf } from '../core/move'
import { nominalStep } from '../core/nominal'
import { type ExtrudeEnd, type FeatureGripSide, isMoveGripSide, moveGripSlot } from '../core/preview'
import { findRegions } from '../core/regions'
import { planMoves, type SnapPlan } from '../core/snapEdit'
import { threadProblem } from '../core/thread'
import { cloneData, networkReady } from './reNetworkDraft'
import type { ReState } from './reStore'
import type { BodyInfo, DraftFace, ExtrudeDraft, FeatureDraft, RevolveDraft } from './reTypes'

/** Whether the workspace has an editor open — the row keys stand down. */
export function reEditorOpen(s: Pick<ReState, 'sketchDraft' | 'extrudeDraft' | 'revolveDraft' | 'featureDraft'>): boolean {
  return s.sketchDraft !== null || s.extrudeDraft !== null || s.revolveDraft !== null || s.featureDraft !== null
}

/** The feature reopened for editing, whichever box holds it — or null
 *  while nothing is open, or a new feature is being set up. */
export function editingFeatureId(s: Pick<ReState, 'sketchDraft' | 'extrudeDraft' | 'revolveDraft' | 'featureDraft'>): number | null {
  return s.sketchDraft?.featureId ?? s.extrudeDraft?.featureId ?? s.revolveDraft?.featureId ?? s.featureDraft?.featureId ?? null
}

/** The features the build runs: every one above the rollback bar — or,
 *  while one of them is reopened for editing, those before it alone. The
 *  part then stands as it stood when the feature was made, and the
 *  feature's ghost is drawn on that — a CAD tree rolled back to the
 *  feature being edited — rather than on the finished part, where the
 *  faces it picked may no longer be, and whose later features would
 *  hide what the edit changes. */
export function featuresToBuild(s: Pick<ReState, 'features' | 'sketchDraft' | 'extrudeDraft' | 'revolveDraft' | 'featureDraft'>): Feature[] {
  const id = editingFeatureId(s)
  if (id === null) return s.features
  const at = s.features.findIndex((f) => f.id === id)
  return at < 0 ? s.features : s.features.slice(0, at)
}

/** Whether a feature being set up has everything it needs to be created. */
export function featureDraftReady(d: FeatureDraft): boolean {
  switch (d.kind) {
    case 'shell':
      return d.body !== null && d.thickness > 0
    case 'fillet':
      return d.body !== null && ((d.edges.length > 0 && d.radius > 0) || (d.edges.length === 0 && (d.variable?.length ?? 0) > 0)) && (d.variable ?? []).every((v) => v.radius[0] > 0 && v.radius[1] > 0)
    case 'chamfer':
      return d.body !== null && d.edges.length > 0 && d.distance > 0 && (d.mode !== 'twoDistances' || d.distance2 > 0) && (d.mode !== 'distanceAngle' || (d.angleDeg > 0 && d.angleDeg < 90))
    case 'hole':
      return d.body !== null && d.axis !== null && d.radius > 0 && (d.depth === null || d.depth > 0)
    case 'thread':
      return d.body !== null && d.face !== null && threadProblem(d) === null && (d.fullLength || (d.length > 0 && d.start >= 0))
    case 'extract':
      return d.element !== null || d.section !== null
    case 'cutPlane':
      return d.body !== null && d.plane !== null
    case 'mirror':
      return d.body !== null && d.plane !== null
    case 'boolean':
      return d.body !== null && d.tool !== null && d.body !== d.tool && !(d.moreTools ?? []).includes(d.body)
    case 'sheet':
      return d.sketchId !== null && Math.abs(d.to - d.from) > 1e-9
    case 'split':
      return d.body !== null && d.tools.length > (d.keep === 'between' ? 1 : 0) && !d.tools.includes(d.body) && d.tolerance > 0 && d.overlap > 0 && d.overlap <= 1
    case 'thicken':
      return d.sheet !== null && d.thickness > 0
    case 'loft':
      return d.sketches.length >= 2
    case 'sweep':
      return d.profile !== null && (d.route ? d.route.points.length >= 2 : d.path !== null && d.profile !== d.path)
    case 'pattern':
      return d.body !== null && d.axis !== null && d.count >= 2 && d.step > 0 && (d.mode === 'circular' || d.axis2 === null || d.count2 < 2 || d.step2 > 0)
    case 'surface':
      return d.region.length >= SURFACE_MIN_REGION
    case 'network':
      return networkReady(d)
    case 'trim':
      return d.tools.length > 0 && d.tolerance > 0 && d.overlap > 0 && d.overlap <= 1
    case 'draft':
      return d.body !== null && d.neutral !== null && d.faces.length > 0 && [d.angleDeg, ...(d.groups ?? []).map((g) => g.angleDeg)].every((a) => Math.abs(a) > 1e-9 && Math.abs(a) < 89) && (d.groups ?? []).every((g) => g.faces.length > 0)
    case 'moveFace':
      return d.body !== null && d.faces.length > 0 && Math.abs(d.offset) > 1e-6
    case 'deleteFace':
      return d.body !== null && d.faces.length > 0
    case 'offsetBody':
      return d.body !== null && Math.abs(d.distance) > 1e-6
    case 'import':
      return d.file !== null
    // A copy is made where it stands as well — a body to work on beside
    // the original — but a move that moves nothing is no move.
    case 'moveBody':
      return d.bodies.length > 0 && [...d.pivot, ...d.translate, ...d.rotate].every(Number.isFinite) && (d.copy || !movesNothing(d))
  }
}

/** How the faces being moved could be moved by an edit of the extrudes or
 *  the sketches that made them — or, route direct, why they cannot — or
 *  null while the box has no face or no distance yet. A Move face feature
 *  reopened for editing is a move on the body and stays one. */
export function snapPlanOf(d: FeatureDraft, features: readonly Feature[], elements: ResolveContext['elements'] = [], units: DisplayUnits = 'mm'): SnapPlan | null {
  if (d.kind !== 'moveFace' || d.faces.length === 0 || !(Math.abs(d.offset) > 1e-6)) return null
  if (d.featureId !== undefined) return { route: 'direct', why: 'this Move face was made on the body' }
  return planMoves(features, d.faces.map((f) => f.fingerprint), d.offset, elements, units)
}

/** The edit of the history a Move face box makes in place of a feature:
 *  the plan, where there is one and the box's tick asks for it. Null
 *  otherwise — the move is then a Move face feature on the body, a row in
 *  the list like any other. */
export function historyEditOf(d: FeatureDraft, features: readonly Feature[], elements: ResolveContext['elements'] = [], units: DisplayUnits = 'mm'): Extract<SnapPlan, { route: 'extent' | 'sketch' }> | null {
  if (d.kind !== 'moveFace' || !d.history) return null
  const plan = snapPlanOf(d, features, elements, units)
  return plan && plan.route !== 'direct' ? plan : null
}

/** The one face a Move face box reads the scan for — the scan says where a
 *  single face should lie, not several — or null. */
export function snapFaceOf(d: FeatureDraft): DraftFace | null {
  return d.kind === 'moveFace' && d.faces.length === 1 ? d.faces[0] : null
}

/** The Draft feature a snapped face is followed by — the scan's flat face
 *  leaning to the body's by more than the fit's noise explains, and the
 *  operator having ticked the offer — less its id and name; null with no
 *  such offer, or none taken, or the offset typed since. The face is named
 *  where the move leaves it, and the neutral plane stands square to the
 *  face through the line across its middle where the scan's plane crosses
 *  it, so the face turns about that line onto the scan. */
export function snapDraftOf(d: FeatureDraft): Omit<DraftFeature, 'id' | 'name'> | null {
  const face = snapFaceOf(d)
  if (d.kind !== 'moveFace' || !d.lean || !face || d.body === null || d.featureId !== undefined) return null
  const lean = d.reading?.draft
  const fp = face.fingerprint
  if (!lean || fp.kind !== 'plane' || !(Math.abs(d.offset) > 1e-6)) return null
  const basisU = normalize(fp.dir) ?? [0, 0, 1]
  return {
    kind: 'draft',
    body: d.body,
    neutral: { kind: 'fitted', frame: { origin: lean.origin, normal: lean.pull, basisU, basisV: cross(lean.pull, basisU) }, label: 'the line across the face’s middle where the scan crosses it' },
    faces: [{ ...fp, centroid: addScaled(fp.centroid, fp.dir, d.offset) }],
    angleDeg: lean.angleDeg,
    visible: true,
  }
}

/** The trim's tolerance from the scan's own scatter, read where it matters:
 *  three times the median σ of the surfaces being trimmed, between 0.05
 *  and 0.5 mm — or 0.3 mm with no fitted surface among the tools. */
export function trimToleranceFor(tools: readonly TrimTool[], results: Record<number, FeatureResult>): number {
  const sigmas = tools.map((t) => (t.kind === 'body' ? results[t.id]?.surface?.rms : undefined)).filter((s): s is number => s !== undefined && Number.isFinite(s) && s > 0).sort((a, b) => a - b)
  if (sigmas.length === 0) return DEFAULT_SPLIT_TOLERANCE_MM
  return Math.round(Math.min(0.5, Math.max(0.05, 3 * sigmas[sigmas.length >> 1])) * 1000) / 1000
}

/** The middle of the bodies a Move takes, by their boxes as built — the
 *  origin while none is picked. */
export function movePivot(bodies: readonly BodyInfo[], ids: readonly number[]): Vec3 {
  return pivotOf(ids.flatMap((id) => {
    const box = bodies.find((b) => b.id === id)?.box
    return box ? [box] : []
  }))
}

/** A Move's bodies changed: the pivot follows them to their middle, and
 *  stays where it was with none picked. */
export function withMoveBodies(d: Extract<FeatureDraft, { kind: 'moveBody' }>, bodies: number[], all: readonly BodyInfo[]): FeatureDraft {
  return { ...d, bodies, pivot: bodies.length > 0 ? movePivot(all, bodies) : d.pivot }
}

/** The slot a gizmo grip's number is: a distance along an axis, an angle
 *  about it. */
export function moveSlotPath(side: FeatureGripSide): string {
  const { field, axis } = moveGripSlot(side as Parameters<typeof moveGripSlot>[0])
  return `${field}.${'xyz'[axis]}`
}

/** A Combine box's tools as the feature keeps them: one body as a number,
 *  several as a list, each once. */
function draftTools(d: Extract<FeatureDraft, { kind: 'boolean' }>): number | number[] {
  const tools = [...new Set([d.tool!, ...(d.moreTools ?? [])])]
  return tools.length === 1 ? tools[0] : tools
}

/** The feature a draft stands for, ready to be built, or null while it is
 *  not — the preview and the commit read the same thing. */
export function featureOfDraft(d: FeatureDraft, id: number, name: string): Feature | null {
  // A network with curves and no region filled yet is built all the same —
  // for the preview, whose reading of the regions the curves close is what
  // a click fills and Fill all fills; Create still waits for a cell.
  if (d.kind === 'network') return d.curves.length > 0 ? { id, kind: 'network', name, ...cloneData(d), visible: true } : null
  if (!featureDraftReady(d)) return null
  switch (d.kind) {
    case 'shell':
      return { id, kind: 'shell', name, body: d.body!, faces: d.faces.map((f) => f.fingerprint), thickness: d.thickness, visible: true }
    case 'fillet':
      return { id, kind: 'fillet', name, body: d.body!, edges: d.edges.map((e) => e.fingerprint), radius: d.radius, chain: d.chain, ...(d.skipFailing ? { skipFailing: true } : {}), ...(d.variable?.length ? { variable: d.variable.map((v) => ({ edge: v.edge.fingerprint, radius: v.radius })) } : {}), visible: true }
    case 'chamfer':
      return {
        id,
        kind: 'chamfer',
        name,
        body: d.body!,
        edges: d.edges.map((e) => e.fingerprint),
        distance: d.distance,
        chain: d.chain,
        ...(d.skipFailing ? { skipFailing: true } : {}),
        ...(d.mode === 'twoDistances' ? { mode: d.mode, distance2: d.distance2 } : d.mode === 'distanceAngle' ? { mode: d.mode, angleDeg: d.angleDeg } : {}),
        ...(d.mode !== 'equal' && d.flip ? { flip: true } : {}),
        visible: true,
      }
    case 'hole':
      return { id, kind: 'hole', name, body: d.body!, axis: d.axis!, radius: d.radius, depth: d.depth, ...(d.insert ? { insert: d.insert } : {}), visible: true }
    case 'thread':
      return { id, kind: 'thread', name, body: d.body!, face: d.face!.fingerprint, standard: d.standard, diameter: d.diameter, pitch: d.pitch, leftHanded: d.leftHanded, length: d.fullLength ? null : d.length, start: d.fullLength ? 0 : d.start, flip: d.flip, offset: d.offset, chamfer: d.chamfer, visible: true }
    case 'extract':
      return { id, kind: 'extract', name, ...(d.section !== null ? { section: d.section } : { element: d.element! }), thickness: d.thickness, op: d.op, visible: true }
    case 'cutPlane':
      return { id, kind: 'cutPlane', name, body: d.body!, plane: d.plane!, keep: d.keep, visible: true }
    case 'mirror':
      return { id, kind: 'mirror', name, body: d.body!, plane: d.plane!, join: d.join, visible: true }
    case 'boolean':
      return { id, kind: 'boolean', name, op: d.op, body: d.body!, tool: draftTools(d), ...(d.keep ? { keep: true } : {}), visible: true }
    case 'sheet':
      return { id, kind: 'sheet', name, sketchId: d.sketchId!, from: d.from, to: d.to, visible: true }
    case 'split':
      return { id, kind: 'split', name, body: d.body!, tools: [...d.tools], keep: d.keep, tolerance: d.tolerance, overlap: d.overlap, ...(d.within !== undefined ? { within: d.within } : {}), visible: true }
    case 'loft':
      return { id, kind: 'loft', name, sketches: [...d.sketches], ruled: d.ruled, op: d.op, visible: true }
    case 'sweep':
      return { id, kind: 'sweep', name, profile: d.profile!, ...(d.route ? { route: d.route } : { path: d.path! }), op: d.op, visible: true }
    case 'thicken':
      return { id, kind: 'thicken', name, sheet: d.sheet!, thickness: d.thickness, side: d.side, op: d.op, visible: true }
    case 'pattern':
      return { id, kind: 'pattern', name, body: d.body!, mode: d.mode, axis: d.axis!, count: d.count, step: d.step, ...(d.mode === 'linear' && d.axis2 && d.count2 >= 2 ? { axis2: d.axis2, count2: d.count2, step2: d.step2 } : {}), visible: true }
    case 'surface':
      return { id, kind: 'surface', name, region: d.region, fit: { ...d.fit, net: d.fit.net ? { ...d.fit.net } : null }, shape: d.shape, constrain: { ...d.constrain }, ...(d.regionBox ? { regionBox: d.regionBox } : {}), ...(d.regionStale ? { regionStale: d.regionStale } : {}), visible: true }
    case 'trim':
      return { id, kind: 'trim', name, tools: d.tools.map((t) => ({ ...t })), tolerance: d.tolerance, overlap: d.overlap, visible: true }
    case 'draft':
      return { id, kind: 'draft', name, body: d.body!, neutral: d.neutral!, faces: d.faces.map((f) => f.fingerprint), angleDeg: d.angleDeg, ...(d.groups?.length ? { groups: d.groups.map((g) => ({ faces: g.faces.map((f) => f.fingerprint), angleDeg: g.angleDeg })) } : {}), visible: true }
    case 'moveFace':
      return { id, kind: 'moveFace', name, body: d.body!, faces: d.faces.map((f) => f.fingerprint), offset: d.offset, visible: true }
    case 'deleteFace':
      return { id, kind: 'deleteFace', name, body: d.body!, faces: d.faces.map((f) => f.fingerprint), visible: true }
    case 'offsetBody':
      return { id, kind: 'offsetBody', name, body: d.body!, distance: d.distance, keep: d.keep, visible: true }
    case 'import':
      return { id, kind: 'import', name, file: { ...d.file! }, visible: true }
    case 'moveBody':
      return { id, kind: 'moveBody', name, bodies: [...d.bodies], pivot: [...d.pivot], translate: [...d.translate], rotate: [...d.rotate], copy: d.copy, visible: true }
  }
}

/** The tolerance a split's cell test reads the scan at, millimetres —
 *  three times a good scan's scatter. */
export const DEFAULT_SPLIT_TOLERANCE_MM = 0.3

/** The share of a fragment's samples that must lie on the scan. */
export const DEFAULT_SPLIT_OVERLAP = 0.5

/** The default wall for a shell: 2 mm — a print's, a casting's — unless
 *  the caller brings the Thickness map's reading. */
export const DEFAULT_WALL_MM = 2

/** A moulding's usual draft, degrees. */
export const DEFAULT_DRAFT_DEG = 2

/** The fillet radius when the scan shows no round at the edge. */
export const DEFAULT_FILLET_MM = 1

/** How long a round face runs along its axis, read off its fingerprint as
 *  a full cylinder's — what a thread that does not run the whole face
 *  starts at. */
export function roundFaceLength(face: FaceInfo['fingerprint']): number {
  const r = face.radius ?? 0
  return r > 0 ? Math.round((face.area / (2 * Math.PI * r)) * 1000) / 1000 : 10
}

/** A fillet's box turned to a constant or a variable radius: the edges
 *  picked the one way carried over to the other while the other has none —
 *  each edge going from the one radius at both ends, or the edges taking
 *  the first one's start radius — else only what new clicks go into. */
export function filletModeSwitch(d: Extract<FeatureDraft, { kind: 'fillet' }>, mode: 'constant' | 'variable'): Partial<Extract<FeatureDraft, { kind: 'fillet' }>> {
  if (mode === d.mode) return {}
  const varying = d.variable ?? []
  if (mode === 'variable' && varying.length === 0 && d.edges.length > 0) return { mode, edges: [], variable: d.edges.map((edge) => ({ edge, radius: [d.radius, d.radius] })) }
  if (mode === 'constant' && d.edges.length === 0 && varying.length > 0) return { mode, edges: varying.map((v) => v.edge), variable: undefined, radius: varying[0].radius[0], radiusTyped: true }
  return { mode }
}

/** Whether an extrude being set up has everything it needs to be created
 *  — the box's Create key and a middle click ask the same question. */
export function extrudeDraftReady(d: ExtrudeDraft): boolean {
  const e = d.extent
  return (
    (d.face !== undefined || (d.sketchId !== null && d.regions.length > 0)) &&
    (e.kind !== 'toPlane' || Boolean(e.plane)) &&
    (e.kind !== 'toFace' || Boolean(e.face)) &&
    (e.kind !== 'toBody' || e.body >= 0) &&
    (e.kind !== 'betweenPlanes' || (Boolean(e.a) && Boolean(e.b)))
  )
}

/** The end of the open extrude a click on the part sets: To for a point
 *  in front of the sketch plane, From for one behind it — the body runs
 *  from the lowest point clicked to the highest, in whichever order they
 *  are clicked. An extent that ends on the part has only its start to
 *  give. */
export function extrudePickEnd(d: Pick<ExtrudeDraft, 'extent'>, height: number): ExtrudeEnd {
  if (extentEndsOnPart(d.extent)) return 'from'
  return height < 0 ? 'from' : 'to'
}

export function revolveDraftReady(d: RevolveDraft): boolean {
  return d.sketchId !== null && d.regions.length > 0 && d.axis !== null && d.angleDeg > 0 && d.angleDeg <= revolveMaxDeg(d.pitch)
}

/** The angle a revolve's box takes: positive, at most a full turn without
 *  a pitch and a thousand with one, to a tenth of a degree. */
export function revolveAngle(deg: number, pitch: number): number {
  return Math.min(revolveMaxDeg(pitch), Math.max(0.1, Math.round(Math.abs(deg) * 10) / 10))
}

/** A coil's pitch to start with: half again as far as the picked profiles
 *  reach along the axis, rounded up — the turns clear of each other with
 *  room between — or 5 mm while there is no axis or profile to read. */
export function startingPitch(d: Pick<RevolveDraft, 'sketchId' | 'regions' | 'axis'>, features: readonly Feature[], ctx: ResolveContext): number {
  const fallback = 5
  const sketch = features.find((f): f is SketchFeature => f.kind === 'sketch' && f.id === d.sketchId)
  if (!sketch || !d.axis || d.regions.length === 0) return fallback
  const axis = resolveAxis(d.axis, sketch, ctx)
  const dir = axis && normalize(axis.dir)
  const profiles = pickedProfiles({ regions: d.regions }, sketch, (f) => findRegions(f.sketch))
  if (!axis || !dir || typeof profiles === 'string') return fallback
  const span = profileSpan(profiles, axis.origin, dir)
  const reach = span.max - span.min
  if (!(reach > 1e-6)) return fallback
  const step = nominalStep(reach * 1.5, 'length')
  return Math.ceil((reach * 1.5) / step - 1e-9) * step
}

/** The unit a row's or a grip's number is held in: millimetres for a
 *  length — the id, which the screen turns into the units shown — or
 *  degrees. */
export type KeyUnit = 'mm' | '°'

// units-ok: the id of the unit a length is held in, not a word on screen.
const LENGTH_UNIT: KeyUnit = 'mm'

/** The one number a feature's row reads and takes, or null for a feature
 *  that has none — a sketch, an extrude reaching to a plane. */
export function keyParameterOf(f: Feature): { value: number; unit: KeyUnit } | null {
  switch (f.kind) {
    case 'extrude':
      if (f.extent.kind === 'distance') return { value: Math.abs(f.extent.to - f.extent.from), unit: LENGTH_UNIT }
      if (f.extent.kind === 'symmetric') return { value: f.extent.total, unit: LENGTH_UNIT }
      return null
    case 'revolve':
      return { value: f.angleDeg, unit: '°' }
    case 'shell':
    case 'thicken':
      return { value: f.thickness, unit: LENGTH_UNIT }
    // A fillet whose edges all vary has no one radius to read.
    case 'fillet':
      return f.edges.length > 0 ? { value: f.radius, unit: LENGTH_UNIT } : null
    case 'chamfer':
      return { value: f.distance, unit: LENGTH_UNIT }
    case 'hole':
      return { value: 2 * f.radius, unit: LENGTH_UNIT }
    // A shadow's block is as thick as the part: no number of its own.
    case 'extract':
      return f.section === undefined && f.thickness > 0 ? { value: f.thickness, unit: LENGTH_UNIT } : null
    case 'draft':
      return { value: f.angleDeg, unit: '°' }
    case 'moveFace':
      return { value: f.offset, unit: LENGTH_UNIT }
    case 'offsetBody':
      return { value: f.distance, unit: LENGTH_UNIT }
    default:
      return null
  }
}

/** The feature with its key number set — a distance extrude keeps its
 *  start and moves its end, a symmetric one its whole; the same feature
 *  when it has no such number or the number is no use. */
export function withKeyParameter(f: Feature, value: number): Feature {
  const positive = Math.abs(value)
  switch (f.kind) {
    case 'extrude': {
      const e = f.extent
      if (e.kind === 'distance') return { ...f, extent: { ...e, to: e.from + Math.sign(e.to - e.from || 1) * positive } }
      if (e.kind === 'symmetric') return { ...f, extent: { ...e, total: positive } }
      return f
    }
    case 'revolve':
      return { ...f, angleDeg: Math.min(revolveMaxDeg(f.pitch), Math.max(1, positive)) }
    case 'shell':
    case 'thicken':
      return positive > 0 ? { ...f, thickness: positive } : f
    case 'fillet':
      return positive > 0 && f.edges.length > 0 ? { ...f, radius: positive } : f
    case 'chamfer':
      return positive > 0 ? { ...f, distance: positive } : f
    case 'hole':
      return positive > 0 ? { ...f, radius: positive / 2 } : f
    case 'extract':
      return positive > 0 && f.section === undefined ? { ...f, thickness: positive } : f
    // Signed, these two: a draft leans the other way, a face moves back.
    case 'draft':
      return positive > 0 && positive < 89 ? { ...f, angleDeg: value } : f
    case 'moveFace':
      return positive > 1e-6 ? { ...f, offset: value } : f
    case 'offsetBody':
      return positive > 1e-6 ? { ...f, distance: value } : f
    default:
      return f
  }
}

/** The colour a body wears, by the feature that made it — and a further
 *  body a step left, a piece apart, a colour further along. */
export function bodyColor(id: number): string {
  return PALETTE[(bodyMaker(id) + 5 + 3 * islandOf(id)) % PALETTE.length]
}

/** Whether a coordinate plane is drawn: as its eye was set, else shown on a
 *  blank stage — the planes are what a model with no scan starts from — and
 *  hidden over a scan, which says where the part is by itself. */
export function coordinatePlaneShown(planesShown: Partial<Record<WorldAxis, boolean>>, axis: WorldAxis, hasScan: boolean): boolean {
  return planesShown[axis] ?? !hasScan
}

/** The number the grip field shows, and its unit — or null while no grip
 *  has a field, or the grip's extent has no number of its own (an extrude
 *  reaching to a plane). */
export function gripFieldValue(s: Pick<ReState, 'extrudeDraft' | 'revolveDraft' | 'featureDraft' | 'gripField'>): { value: number; unit: KeyUnit; expr?: string } | null {
  const side = s.gripField
  if (!side) return null
  const base = gripFieldBase(s, side)
  if (!base) return null
  // The expression behind the number, when the box has one for the slot
  // the grip drags: the field shows it, as the box does.
  const path = gripSlotPath(side, s)
  const draft = s.extrudeDraft ?? s.revolveDraft ?? s.featureDraft
  const expr = path && draft?.exprs ? draft.exprs[path] : undefined
  return expr !== undefined ? { ...base, expr } : base
}

/** The slot a grip's number is, for the open editor — the one an
 *  expression typed on the grip is kept under (core/parameters.ts). */
export function gripSlotPath(side: FeatureGripSide, s: Pick<ReState, 'extrudeDraft' | 'revolveDraft' | 'featureDraft'>): string | null {
  switch (side) {
    case 'taper':
      return 'taper'
    case 'extrudeFrom':
    case 'extrudeTo':
      return s.extrudeDraft?.extent.kind === 'symmetric' ? 'extent.total' : side === 'extrudeFrom' ? 'extent.from' : 'extent.to'
    case 'turn':
      return 'angleDeg'
    case 'radius':
      return s.featureDraft?.kind === 'chamfer' ? 'distance' : 'radius'
    case 'thickness':
      return 'thickness'
    case 'move':
      return 'offset'
    default:
      return isMoveGripSide(side) ? moveSlotPath(side) : null
  }
}

function gripFieldBase(s: Pick<ReState, 'extrudeDraft' | 'revolveDraft' | 'featureDraft'>, side: FeatureGripSide): { value: number; unit: KeyUnit } | null {
  if (s.extrudeDraft && side === 'taper') return { value: -s.extrudeDraft.draftDeg, unit: '°' }
  if (s.extrudeDraft && side !== 'turn') {
    const e = s.extrudeDraft.extent
    if (e.kind === 'distance') return { value: side === 'extrudeFrom' ? e.from : e.to, unit: LENGTH_UNIT }
    if (e.kind === 'symmetric') return { value: e.total, unit: LENGTH_UNIT }
    if (extentEndsOnPart(e) && side === 'extrudeFrom') return { value: e.from, unit: LENGTH_UNIT }
    return null
  }
  if (s.revolveDraft && side === 'turn') return { value: s.revolveDraft.angleDeg, unit: '°' }
  const d = s.featureDraft
  if (d && side === 'radius' && d.kind === 'fillet') return { value: d.radius, unit: LENGTH_UNIT }
  if (d && side === 'radius' && d.kind === 'chamfer') return { value: d.distance, unit: LENGTH_UNIT }
  if (d && side === 'thickness' && d.kind === 'shell') return { value: d.thickness, unit: LENGTH_UNIT }
  if (d && side === 'move' && d.kind === 'moveFace') return { value: d.offset, unit: LENGTH_UNIT }
  if (d && d.kind === 'moveBody' && isMoveGripSide(side)) {
    const { field, axis } = moveGripSlot(side)
    return { value: d[field][axis], unit: field === 'translate' ? LENGTH_UNIT : '°' }
  }
  return null
}

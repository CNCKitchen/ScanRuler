// SPDX-License-Identifier: AGPL-3.0-only
// The workspace's state as types: the kernel's status, the bodies and how
// they are shown, a selection, the drafts the sketch, extrude, revolve and
// feature boxes hold, the preview and the live map's report. reStore holds
// the state itself and re-exports these.

import type { Vec2 } from '../../../src/core/flat/types'
import type { SectionFrame, WorldAxis } from '../../../src/core/section/frame'
import type { SymmetryPlane } from '../../../src/core/symmetry'
import type { Vec3 } from '../../../src/core/types'
import type { ConstrainMode } from '../core/autoConstrain'
import type { BodyFolder } from '../core/bodyFolders'
import type { Diagnosis, EdgeInfo, FaceInfo, SurfaceReport, TrimReport } from '../core/build'
import type { NetworkReport } from '../core/networkBody'
import type { DimPick } from '../core/draw'
import type { AxisRef, BodyOp, BooleanOp, ChamferMode, ExtrudeExtent, FaceProfile, Feature, HoleAxis, MirrorPlane, NetworkFeature, PlaneRef, RegionBox, SplitKeep, StepFileRef, SurfaceFitParams, SurfaceShape, ThickenSide, TrimTool } from '../core/features'
import type { ExprMap, Parameter } from '../core/parameters'
import type { Region } from '../core/regions'
import type { PlacedSegment } from '../core/segment'
import type { ShareReport } from '../core/shareFit'
import type { PickedItem } from '../core/selectionInfo'
import type { Anchor, ConstraintKind, Sketch, SketchPatternSpec } from '../core/sketch'
import type { SketchImage } from '../core/sketchImage'
import type { SnapHold } from '../core/snap'
import type { SnapReading } from '../core/snapFace'
import type { SolveReport } from '../core/solver'
import type { SweepRoute } from '../core/sweepRoute'
import type { ThreadStandard } from '../core/thread'

export type KernelStatus = 'idle' | 'loading' | 'ready' | 'unavailable'

/** The tools of the sketch editor: pick pieces, draw, project — a click
 *  on a body's edge or another sketch's piece brings it into this sketch —
 *  or put a dimension or a relation on the pieces clicked next, with
 *  nothing selected beforehand. */
export type SketchTool = 'select' | 'line' | 'rectangle' | 'polygon' | 'circle' | 'arc' | 'spline' | 'point' | 'project' | 'trim' | 'dimension' | 'relation' | 'fillet' | 'chamfer'

/** What the viewport knows about the feature being set up: whether its
 *  ghost is building, and what the kernel made of it. */
/** What a picker in the panel is pointing at, for the viewport to show:
 *  the plane or the axis under the cursor in its list. */
export type ViewHint =
  | { kind: 'plane'; ref: PlaneRef; name: string }
  | { kind: 'axis'; ref: AxisRef; sketchId: number | null; name: string }

/** What a click on the part picked while no editor is open — the thing the
 *  chips in the viewport offer verbs for: a sketch's region (Extrude,
 *  Revolve), one of its lines or an element with an axis (Revolve about
 *  this), a body face (Sketch here, once bodies can be picked). `at` is
 *  where the click was, in client pixels, for the chip bar to stand by. */
export type ReSelection =
  | { kind: 'region'; sketchId: number; key: string; at: { x: number; y: number } }
  | { kind: 'sketchLine'; sketchId: number; entity: number; at: { x: number; y: number } }
  | { kind: 'element'; id: number; name: string; at: { x: number; y: number } }
  /** A coordinate plane drawn at the origin, by the axis it stands on. */
  | { kind: 'coordinatePlane'; axis: WorldAxis; at: { x: number; y: number } }
  /** `edges` are the edges bounding the face — its outline, for a sketch
   *  or an extrude that starts from it. */
  | { kind: 'bodyFace'; bodyId: number; face: FaceInfo; edges: EdgeInfo[]; at: { x: number; y: number } }
  | { kind: 'bodyEdge'; bodyId: number; edge: EdgeInfo; at: { x: number; y: number } }
  /** A corner of a body — an end of its edges — picked to be read. */
  | { kind: 'bodyVertex'; bodyId: number; point: Vec3; at: { x: number; y: number } }
  /** Several faces, edges and corners together — Ctrl+click adds one, a
   *  Shift+drag a window of them — for what lies between them to be read
   *  and for a feature to take them all. */
  | { kind: 'bodyItems'; items: PickedItem[]; at: { x: number; y: number } }

/** The faces, edges and corners of the bodies a selection holds — none for
 *  a region, a sketch line or an element. */
export function selectionItems(sel: ReSelection | null): PickedItem[] {
  if (!sel) return []
  if (sel.kind === 'bodyFace') return [{ type: 'face', bodyId: sel.bodyId, face: sel.face, edges: sel.edges }]
  if (sel.kind === 'bodyEdge') return [{ type: 'edge', bodyId: sel.bodyId, edge: sel.edge }]
  if (sel.kind === 'bodyVertex') return [{ type: 'vertex', bodyId: sel.bodyId, point: sel.point }]
  if (sel.kind === 'bodyItems') return sel.items
  return []
}

/** Picked items as a selection: one as the kind the chips have always
 *  known, several as a set, none as nothing. */
export function selectionOf(items: PickedItem[], at: { x: number; y: number }): ReSelection | null {
  if (items.length === 0) return null
  if (items.length > 1) return { kind: 'bodyItems', items, at }
  const i = items[0]
  if (i.type === 'face') return { kind: 'bodyFace', bodyId: i.bodyId, face: i.face, edges: i.edges, at }
  if (i.type === 'edge') return { kind: 'bodyEdge', bodyId: i.bodyId, edge: i.edge, at }
  return { kind: 'bodyVertex', bodyId: i.bodyId, point: i.point, at }
}

/** What an editor is asking the viewport for on the bodies: faces or
 *  edges, of the bodies named (null: all of them). Null with no editor
 *  asking — the faces are then click targets for a selection. */
export interface BodyPick {
  mode: 'faces' | 'edges'
  bodies: number[] | null
}

/** The feature list as it stood before a change — what Ctrl+Z goes back
 *  to. The names' counters travel with it, so a redone feature is the
 *  same feature, with the same id and name, that was undone. */
export interface FeatureSnapshot {
  features: Feature[]
  /** The features below the rollback bar, as they stood — see `rolledBack`. */
  rolledBack: Feature[]
  nextFeatureId: number
  nextOfKind: Record<string, number>
  /** The parameters as they stood: a feature's numbers and the parameters
   *  they read go back together. */
  parameters: Parameter[]
  nextParameterId: number
  /** The bodies' names and colours as they stood. */
  bodyStyles: BodyStyles
  /** The body list's components as they stood. */
  bodyFolders: BodyFolder[]
}

/** What a body is called and wears where it is given its own — by the
 *  body's id; a body with none is Solid n, in the palette's colour. */
export interface BodyStyle {
  name?: string
  /** #rrggbb. */
  color?: string
}

export type BodyStyles = Record<number, BodyStyle>

/** The bodies the pointer is on: over their rows in the body list — a
 *  component's row is all of its bodies — or over one of them in the
 *  viewport; each lights in the other. */
export interface BodyHover {
  ids: number[]
  from: 'list' | 'view'
}

/** The feature list being played back: where the rollback bar stood when
 *  it began — where it goes back to — the step it shows, as the number of
 *  features built (0 for none), and whether it moves on by itself. */
export interface Playback {
  origin: number
  at: number
  playing: boolean
}

/** The colours a body is offered — a board's greens and blues, the metals
 *  of what is bought in — by the names the commands take them by too. */
export const BODY_SWATCHES: readonly { name: string; color: string }[] = [
  { name: 'black', color: '#1e1f22' },
  { name: 'white', color: '#f1f1ee' },
  { name: 'grey', color: '#8b9096' },
  { name: 'aluminium', color: '#c5c9cd' },
  { name: 'steel', color: '#707880' },
  { name: 'brass', color: '#c9a646' },
  { name: 'copper', color: '#b87333' },
  { name: 'pcb green', color: '#1f5e33' },
  { name: 'pcb blue', color: '#1d3f7a' },
  { name: 'red', color: '#c62f2f' },
  { name: 'orange', color: '#e57a2e' },
  { name: 'yellow', color: '#efc33a' },
  { name: 'green', color: '#3f9b4a' },
  { name: 'blue', color: '#2f73c4' },
  { name: 'purple', color: '#7c52b3' },
]

/** A colour as given — #rgb, #rrggbb, or a swatch's name, any case — as
 *  #rrggbb, or null for none of those. */
export function bodyColorOf(given: string): string | null {
  const t = given.trim().toLowerCase()
  const swatch = BODY_SWATCHES.find((s) => s.name === t || s.name.replace(' ', '') === t.replace(/[\s_-]/g, ''))
  if (swatch) return swatch.color
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(t)
  if (!m) return null
  return m[1].length === 3 ? `#${m[1].replace(/./g, (c) => c + c)}` : t
}

/** The live map's reading: against the ghost or the bodies, how many of
 *  the scan's vertices it covers and how many of those lie within the
 *  range. */
export interface MapReport {
  source: 'ghost' | 'bodies'
  points: number
  within: number
  /** Scan vertices deeper inside the bodies than the reach — material the
   *  model has and the part has not (see liveMap.ts). Zero for a ghost. */
  farInside: number
  range: number
  /** Counts up with every answer, never back. */
  tick: number
}

export type PreviewInfo =
  | { status: 'idle' }
  | { status: 'building' }
  | { status: 'ok'; volume: number; closed: boolean; surface?: SurfaceReport; trim?: TrimReport; network?: NetworkReport; sheetFaces?: number; failure?: Diagnosis }
  /** `where`: the edges or face outlines a round, a chamfer or a shell
   *  failed on, drawn red on the part — see Builder.diagnose. */
  | { status: 'failed'; message: string; where?: Float32Array[] }

export interface BodyInfo {
  /** The id of the feature that made the body. */
  id: number
  name: string
  /** The colour it wears: its own, or the palette's (bodyColor) where a
   *  body was set down without one. */
  color?: string
  visible: boolean
  volume: number
  faces: number
  closed: boolean
  triangles: number
  /** A sheet or a fitted surface: faces without an inside — drawn and
   *  listed, left out of the export and of a comparison. */
  surface?: boolean
  /** The box round the body as built — what a Move turns it about. */
  box?: { min: Vec3; max: Vec3 }
  /** The name the body came with from a STEP file, where the file gave it
   *  one: its row's name until it is given one of its own (bodyStyles). */
  label?: string
}

/** The sketch being drawn: a working copy of a sketch feature, or a new
 *  one, with the editor's own state around it. */
export interface SketchDraft {
  featureId?: number
  name: string
  plane: PlaneRef
  frame: SectionFrame
  sketch: Sketch
  tool: SketchTool
  /** The pieces selected, for a relation or a dimension. */
  selection: number[]
  selectedConstraint: number | null
  /** The clicks a drawing tool has collected so far, sheet millimetres. */
  pending: Vec2[]
  /** What each of those clicks snapped to — the end of another piece, or
   *  a coordinate plane's line, the new one is then held to — or null. */
  snaps?: (SnapHold | null)[]
  /** The end the Line tool carries on from: a line drawn leaves its far
   *  end as the start of the next, and a press held on it and dragged
   *  draws an arc tangent to the piece it ends. */
  chain?: Anchor | null
  /** The Dimension tool's first click, waiting for its second. */
  dimPick?: DimPick | null
  /** The Coincident relation's first click — an end, a centre, a piece
   *  or a coordinate plane's line — waiting for its second. */
  relPicks?: DimPick[]
  /** The dimension in hand: made at the value measured, its number
   *  following the cursor until a click puts it down, as CAD places a
   *  dimension. While the pick that made it is still in hand (`dimPick` — a
   *  line's length, a radius, one click each), a click on another piece, an
   *  end or a plane makes it the distance or the angle between the two
   *  instead; any other click puts it down there. */
  dimMade?: number | null
  /** The sketch as it stood before the dimension in hand was made — the
   *  step of the history that made it, while nothing else has been done
   *  since: a dimension taken back goes back to it. */
  dimFrom?: Sketch | null
  /** Counted up when the Dimension tool hands a dimension over for typing —
   *  one just put down, one that was there already and is clicked again — so
   *  its number on the sheet opens for typing, under the hand. */
  dimFocus?: number
  /** The relation the Relation tool puts on the pieces clicked. */
  armedRelation?: ConstraintKind | null
  /** The setback of the last chamfer cut in this sketch — what the next
   *  one starts with. */
  lastChamfer?: number
  report: SolveReport | null
  /** The segmentation tolerance the operator set, or null for the chain's
   *  own. */
  tolerance: number | null
  /** Which slice chains have been auto-fitted, and the order of the pieces
   *  each produced — what corner inference and Close walk. A chain fitted
   *  onto the pieces already there (core/shareFit.ts) has no order of its
   *  own: `runs` holds each open run's pieces, `share` the reach it was
   *  shared at. */
  fitted: Record<number, { order: PlacedSegment[]; closed: boolean; bridges?: number[]; runs?: PlacedSegment[][]; share?: number }>
  /** What the last fit onto the pieces already there shared and landed —
   *  for the command that asked it to; absent after a fit that shared
   *  nothing. */
  shareReport?: ShareReport
  /** mm along the plane's normal the slice chains are cut at, off the
   *  sketch's plane — another level of a stacked part fitted into the same
   *  sketch. The panel's; not kept with the feature. */
  level?: number
  /** The closed regions of the sketch as it stands — recomputed after
   *  every change; what an extrude will have to pick from. */
  found: Region[]
  /** Past sketches, for undo. */
  history: Sketch[]
  /** Sketches ahead of the current draft after undo. A new edit clears them. */
  future?: Sketch[]
  /** Why the last action did nothing, for the box. */
  error: string | null
  /** The Pattern box open on the selection: how the pieces selected are
   *  repeated, drawn on the sheet as they would land until it is applied. */
  pattern?: SketchPatternSpec | null
  /** The expression behind the plane's offset, carried into the feature —
   *  see SketchFeature. */
  exprs?: ExprMap
  /** The picture under the sketch, carried into the feature. */
  image?: SketchImage
  /** Two points being clicked on the picture: to bring it to scale (the
   *  length between them typed next), to move it (the point, then where it
   *  goes), or to level it (two points that should lie level). */
  imagePick?: { mode: ImagePickMode; points: Vec2[] } | null
}

export type ImagePickMode = 'scale' | 'move' | 'level'

export interface ExtrudeDraft {
  featureId?: number
  name?: string
  /** The expressions behind the box's numbers, by slot — see
   *  core/parameters.ts; carried into the feature. */
  exprs?: ExprMap
  sketchId: number | null
  /** The sketch's regions picked in the viewport, by key. */
  regions: string[]
  extent: ExtrudeExtent
  /** Degrees the sides lean in; 0 for straight. The box and the grip show
   *  it as a taper, the other way round — see ExtrudeFeature. */
  draftDeg: number
  /** The way the profile is swept, when not along the plane's normal — see
   *  ExtrudeFeature.direction. */
  direction?: Vec3
  /** Join meets every body it touches, Cut every body it goes into — see
   *  BodyOp; there is no body to choose. */
  op: BodyOp
  /** A flat face of a body as the profile, pulled as it stands, in place
   *  of a sketch's regions — see FaceProfile. */
  face?: FaceProfile
  /** Set when the extrude was started from a flat face of a body: whether
   *  the result still follows the direction, joining outward and cutting
   *  inward, as a pulled face does. `sketchId` names the sketch of the
   *  face's outline an older pull made for it, taken back if the extrude
   *  is cancelled; a pull made now takes the face itself and makes none. */
  fromFace?: { sketchId?: number; opAuto: boolean }
}

export interface RevolveDraft {
  featureId?: number
  name?: string
  exprs?: ExprMap
  sketchId: number | null
  regions: string[]
  axis: AxisRef | null
  angleDeg: number
  /** Millimetres climbed along the axis every turn; 0 for a plain revolve
   *  — see RevolveFeature. */
  pitch: number
  leftHanded: boolean
  op: BodyOp
}

/** A pick on a body while a feature is set up: the face or edge with its
 *  hash for lighting it on the part — −1 once the feature is reopened,
 *  when the hash of the last build no longer names it — and the
 *  fingerprint the feature stores. */
export type DraftFace = FaceInfo

export type DraftEdge = EdgeInfo

/** What a fillet's radius was taken from: the scan, read across the first
 *  picked edge; a default when the scan showed no round there; the
 *  operator's own number. */
export type FilletEstimate =
  | { status: 'idle' }
  | { status: 'working' }
  | { status: 'found'; radius: number; points: number }
  | { status: 'none' }

/** Where a new mirror's plane came from: the scan is searched for its own
 *  symmetry plane when the box opens with no plane in it, and the plane
 *  found — or a symmetry plane already measured — is the default. */
export type SymmetryFinding =
  | { status: 'idle' }
  | { status: 'working' }
  | { status: 'found'; plane: SymmetryPlane }
  | { status: 'element'; name: string }
  | { status: 'none'; rms: number | null }

/** The features that work on a body, or make one of an element, while
 *  they are set up — one editor box at a time, like the extrude's. */
export type FeatureDraft = { exprs?: ExprMap } & (
  | { kind: 'shell'; featureId?: number; name?: string; body: number | null; faces: DraftFace[]; thickness: number; thicknessFrom: 'map' | 'default' | 'typed' }
  /** `variable`: edges at a radius running from the first to the second
   *  along each (FilletFeature.variable), from its start — the end the
   *  part marks. `mode` says which of the two an edge clicked goes into:
   *  `edges` at the one radius, or `variable` at a start and an end radius. */
  | { kind: 'fillet'; featureId?: number; name?: string; body: number | null; edges: DraftEdge[]; radius: number; chain: boolean; skipFailing?: boolean; radiusTyped: boolean; estimate: FilletEstimate; variable?: { edge: DraftEdge; radius: [number, number] }[]; mode: 'constant' | 'variable' }
  /** `distance2` and `angleDeg` stand while their mode is not chosen, for
   *  the box to come back to — ChamferFeature keeps the one in use. */
  | { kind: 'chamfer'; featureId?: number; name?: string; body: number | null; edges: DraftEdge[]; distance: number; chain: boolean; skipFailing?: boolean; mode: ChamferMode; distance2: number; angleDeg: number; flip: boolean }
  /** `insert`: the heat-set insert the hole is sized for, or null. */
  | { kind: 'hole'; featureId?: number; name?: string; body: number | null; axis: HoleAxis | null; radius: number; depth: number | null; insert?: string | null }
  /** A thread on a round face: the face clicked — a boss or a bore, which
   *  the app reads off the body's mesh (`internal`, null until it has) — and
   *  the size from a standard's table, taken for the face as it is clicked
   *  until a size is chosen or typed (`sized`). `length` and `start` stand
   *  while `fullLength` is off. */
  | { kind: 'thread'; featureId?: number; name?: string; body: number | null; face: DraftFace | null; internal: boolean | null; standard: ThreadStandard; diameter: number; pitch: number; leftHanded: boolean; fullLength: boolean; length: number; start: number; flip: boolean; offset: number; chamfer: boolean; sized: boolean }
  /** `element` or `section`: a measured element, or a shadow section. */
  | { kind: 'extract'; featureId?: number; name?: string; element: number | null; section: number | null; thickness: number; op: BodyOp }
  | { kind: 'cutPlane'; featureId?: number; name?: string; body: number | null; plane: PlaneRef | null; keep: 1 | -1 }
  | { kind: 'mirror'; featureId?: number; name?: string; body: number | null; plane: MirrorPlane | null; join: boolean; symmetry: SymmetryFinding }
  /** `keep`: the tools stay bodies of their own (BooleanFeature).
   *  `moreTools`: the tools past the first, joined with it, or cut or
   *  intersected by in turn. */
  | { kind: 'boolean'; featureId?: number; name?: string; op: BooleanOp; body: number | null; tool: number | null; moreTools?: number[]; keep: boolean }
  | { kind: 'sheet'; featureId?: number; name?: string; sketchId: number | null; from: number; to: number }
  | { kind: 'split'; featureId?: number; name?: string; body: number | null; tools: number[]; keep: SplitKeep; tolerance: number; overlap: number; within?: number }
  | { kind: 'loft'; featureId?: number; name?: string; sketches: number[]; ruled: boolean; op: BodyOp }
  | { kind: 'sweep'; featureId?: number; name?: string; profile: number | null; path: number | null; route?: SweepRoute; exprs?: Record<string, string>; op: BodyOp }
  /** A sheet made a solid (ThickenFeature): the sheet, the thickness and
   *  the side it grows to, and what the solid does with the bodies. */
  | { kind: 'thicken'; featureId?: number; name?: string; sheet: number | null; thickness: number; side: ThickenSide; op: BodyOp }
  /** `axis2`, `count2`, `step2`: a linear pattern's second direction —
   *  a grid — none while `axis2` is null. */
  | { kind: 'pattern'; featureId?: number; name?: string; body: number | null; mode: 'circular' | 'linear'; axis: AxisRef | null; count: number; step: number; axis2: AxisRef | null; count2: number; step2: number }
  /** A draft: the first flat face clicked (or a plane chosen) is the neutral
   *  plane, the faces clicked after it are the ones leaned. `groups`: more
   *  faces at angles of their own, as the commands set them — the panel
   *  shows them and keeps them, the clicks pick `faces`. */
  | { kind: 'draft'; featureId?: number; name?: string; body: number | null; neutral: MirrorPlane | null; faces: DraftFace[]; angleDeg: number; groups?: { faces: DraftFace[]; angleDeg: number }[] }
  /** Faces moved by one offset — typed, dragged, or read off the scan:
   *  clicks on the body pick the faces; with `snap` on and one face picked
   *  the clicks are the scan's instead, where a plane or a cylinder is
   *  fitted and the offset read off it (`reading`). `lean` is the
   *  operator's yes to the draft the reading offers where the scan's flat
   *  face leans to the body's: a Draft feature made after the move
   *  (`snapDraftOf`). */
  /** `history`: the move edits what made the faces — the extrude's
   *  distance, the sketch's line — instead of adding a Move face, where it
   *  can (historyEditOf). */
  | { kind: 'moveFace'; featureId?: number; name?: string; body: number | null; faces: DraftFace[]; snap: boolean; offset: number; reading: SnapReading | null; fitting: boolean; error: string | null; lean: boolean; history: boolean }
  /** Faces taken off a body and healed over; `tangent`: a click on a round
   *  takes the rounds that run on from it too (faceGroup.ts). */
  | { kind: 'deleteFace'; featureId?: number; name?: string; body: number | null; faces: DraftFace[]; tangent: boolean }
  /** A body grown or shrunk all round; `keep` leaves the body as it was
   *  and makes the offset a body of its own. */
  | { kind: 'offsetBody'; featureId?: number; name?: string; body: number | null; distance: number; keep: boolean }
  /** A STEP file brought in: the file chosen, its text in stepFiles. */
  | { kind: 'import'; featureId?: number; name?: string; file: StepFileRef | null }
  /** Bodies moved and turned, or copies of them (MoveBodyFeature): clicks
   *  on the part pick the bodies, the pivot following them to their
   *  middle; the gizmo or the box's six numbers place them. */
  | { kind: 'moveBody'; featureId?: number; name?: string; bodies: number[]; pivot: Vec3; translate: Vec3; rotate: Vec3; copy: boolean }
  /** A surface fitted through a region of the scan: the region gathered
   *  by clicks that flood by normal angle, or with the marking tools while
   *  `paint` is on; the fit's parameters as the feature holds them. */
  | { kind: 'surface'; featureId?: number; name?: string; region: Uint32Array; floodDeg: number; paint: boolean; fit: SurfaceFitParams; shape: SurfaceShape; constrain: ConstrainMode; regionBox?: RegionBox; regionStale?: true | string }
  /** The automatic trim: the surfaces and elements to close into a solid,
   *  the tolerance read off the surfaces' own fits until typed. */
  | { kind: 'trim'; featureId?: number; name?: string; tools: TrimTool[]; tolerance: number; toleranceTyped: boolean; overlap: number }
  /** A patch network being drawn: the network as the feature holds it, the
   *  curve being drawn, the editor's own undo, and the patch picked in the
   *  readout. */
  | ({ kind: 'network'; featureId?: number; name?: string } & NetworkDraft)
)

/** A patch network as the feature holds it. */
export type NetworkData = Pick<NetworkFeature, 'nodes' | 'curves' | 'cells' | 'spans' | 'fit'>

/** Where a curve starts or ends: a node of the network, or a point of the
 *  scan that becomes one when the curve is made. */
export type NetworkStart = { node: number } | { at: Vec3 }

/** A patch's corner as it is placed: a node of the network, a point of the
 *  scan, a point on a curve (split there with a node when the patch is
 *  made) or a curve's grip (made a node there). */
export type PlacedCorner = { node: number } | { at: Vec3 } | { curve: number; at: Vec3 } | { curve: number; grip: number; at: Vec3 }

export interface NetworkDraft extends NetworkData {
  /** The next id a node or a curve takes. */
  nextId: number
  /** The patch being placed: its corners clicked so far, in order. */
  placing: { corners: PlacedCorner[] } | null
  /** The editor's own history: the network as it was before each edit,
   *  and the edits undone. */
  history: NetworkData[]
  future: NetworkData[]
  /** The patch picked in the readout or the view, by its index in the
   *  report; null for none. */
  picked: number | null
  /** What a click on the scan does: draw a curve, or fill the region it
   *  lands in (or pick the patch filling it). */
  tool: 'draw' | 'fill'
  /** The scan's creases suggested (PN12) and not yet taken or dismissed;
   *  null when none were asked for. Not part of the network, nor of its
   *  undo. */
  suggested: SuggestedCrease[] | null
}

/** A crease the scan suggests: a crease curve's two ends and its grips —
 *  two suggestions that meet share an end's point — with the fitted curve
 *  sampled to draw it, its length (mm) and how far the scan folds along it
 *  (degrees). */
export interface SuggestedCrease {
  from: Vec3
  to: Vec3
  via: Vec3[]
  points: Float32Array
  length: number
  angle: number
}

export type FeatureDraftKind = FeatureDraft['kind']

/** The angle a click's flood may turn over one edge, degrees — one face of
 *  a tessellated part, a patch of a scan up to its first crease. */
export const DEFAULT_FLOOD_DEG = 1

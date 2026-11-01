// SPDX-License-Identifier: AGPL-3.0-only
// The Reverse engineer workspace's state: the kernel's standing, the feature
// list and what the last build made of it, the bodies with their visibility,
// and the editors — a sketch being drawn on its plane, an extrude or a
// revolve being set up with the profiles it picked and the ghost it shows.
// The body meshes themselves stay out of the store like every other big
// buffer (see app/useReverse); this holds what the panel and the list
// read. The sketch editor's working copy lives here too, because every
// click on the sheet changes it and the panel and the stage both draw from
// it.

import { create } from 'zustand'
import type { Vec2 } from '../../../src/core/flat/types'
import type { Vec3 } from '../../../src/core/types'
import type { EdgeInfo, FaceInfo, FeatureResult } from '../core/build'
import type { TangentEdges } from '../core/edgeLines'
import { type FitOptions } from '../core/fitOptions'
import { type SnapContext } from '../core/snap'
import { dependentsOf, movedList, stepFileKey, type AxisRef, type Feature, type ResolveContext, type PlaneRef, type StepFileRef } from '../core/features'
import { moveInto, nextFolderId, nextFolderName, NO_PICK, withoutFolder, type BodyFolder, type FolderMove, type ListPick } from '../core/bodyFolders'
import { itemKey, type PickedItem } from '../core/selectionInfo'
import { type FeatureGripSide } from '../core/preview'
import { type SketchImage } from '../core/sketchImage'
import type { Pull } from '../core/solver'
import {
  arcThrough,
  type ConstraintKind,
  type EntityInput,
  type Sketch,
  type SketchPatternSpec,
} from '../core/sketch'
import { evaluateParameters, featureReads, nameProblem, renameInParameters, unlinkSlot, usersOf, type ExprMap, type Parameter, type ParameterKind, type ParameterTable } from '../core/parameters'
import { frameKey, type SectionFrame, type WorldAxis } from '../../../src/core/section/frame'
import { type BodyHover, type BodyInfo, type BodyPick, type BodyStyle, type BodyStyles, type ExtrudeDraft, type FeatureDraft, type FeatureDraftKind, type FeatureSnapshot, type ImagePickMode, type KernelStatus, type MapReport, type Playback, type PreviewInfo, type ReSelection, type RevolveDraft, selectionItems, selectionOf, type SketchDraft, type SketchTool, type ViewHint } from './reTypes'
import { reEditorOpen, withKeyParameter } from './reDrafts'
import { CLOSE_OTHERS, followParameters, keyParameterPaths, nameBodies, remember, restored, snapshotOf, unlinkSlots } from './reFeatureHelpers'
import { featureSlice } from './reFeatureSlice'
import { gripSlice } from './reGripSlice'
import { solidSlice } from './reSolidSlice'
import { sketchSlice } from './reSketchSlice'
export { nameBodies, sketchesUsedBy } from './reFeatureHelpers'
export { chainArcStart, dragHandleAt, type SketchHover, sketchHoverAt, splineClosesAt } from './reSketchDraft'
export { bodyColor, coordinatePlaneShown, DEFAULT_FILLET_MM, DEFAULT_WALL_MM, editingFeatureId, extrudeDraftReady, featureDraftReady, featureOfDraft, featuresToBuild, filletModeSwitch, gripFieldValue, gripSlotPath, historyEditOf, keyParameterOf, reEditorOpen, revolveAngle, revolveDraftReady, roundFaceLength, snapDraftOf, snapFaceOf, snapPlanOf, trimToleranceFor, withKeyParameter } from './reDrafts'
export { BODY_SWATCHES, bodyColorOf, type BodyHover, type BodyInfo, type BodyPick, type BodyStyle, type BodyStyles, type DraftEdge, type DraftFace, type ExtrudeDraft, type FeatureDraft, type FeatureDraftKind, type FilletEstimate, type ImagePickMode, type KernelStatus, type MapReport, type Playback, type PreviewInfo, type ReSelection, type RevolveDraft, selectionItems, type SketchDraft, type SketchTool, type SymmetryFinding, type ViewHint } from './reTypes'

export interface ReState {
  kernelStatus: KernelStatus
  kernelMessage: string | null
  kernelVersion: string | null
  setKernel: (status: KernelStatus, message?: string | null, version?: string | null) => void

  features: Feature[]
  nextFeatureId: number
  nextOfKind: Record<string, number>
  /** What the last build said about each feature. */
  results: Record<number, FeatureResult>
  bodies: BodyInfo[]
  /** The bodies put out of view, by id — what the eyes in the body list,
   *  a feature's `visible` and a thicken hiding its sheet write, and every
   *  build reads. Lasting: a build that lacks a body (one that failed, a
   *  panel edit's build up to its feature, a rollback above it) keeps its
   *  id, so it comes back hidden; an id goes only with the feature whose
   *  step made it. Saved with the project; not a step of the history. */
  hiddenBodies: number[]
  /** The names and colours given to bodies, by id — saved, undone with the
   *  features. */
  bodyStyles: BodyStyles
  /** The text of every STEP file imported this session, by its key
   *  (StepFileRef) — only ever added to, so an Import taken back and
   *  brought again by the undo history finds its file; saved for the
   *  Imports the project holds (projectSection.ts). */
  stepFiles: Record<string, string>
  /** A STEP file's text kept — once, however often it is imported — and
   *  the reference an Import holds it by. */
  addStepFile: (name: string, text: string) => StepFileRef
  /** Name a body or colour it — null takes the name or the colour back to
   *  the one it had. One step of the undo history; nothing is rebuilt. */
  setBodyStyle: (id: number, patch: { name?: string | null; color?: string | null }) => void
  /** The components the body list sorts the bodies into (core/bodyFolders)
   *  — saved, undone with the features. */
  bodyFolders: BodyFolder[]
  /** A new component, Component n, in `parent` (null: at the head of the
   *  list) — holding `what` where given, taken out of wherever it was. One
   *  undo step. Returns its id. */
  addBodyFolder: (parent: number | null, what?: FolderMove) => number
  /** A component renamed; a blank name leaves it as it was. One undo step. */
  renameBodyFolder: (id: number, name: string) => void
  /** A component taken away, what it held moved up to where it stood —
   *  no body goes with it. One undo step. */
  removeBodyFolder: (id: number) => void
  /** Bodies and components put into a component, or at the head of the
   *  list with null. One undo step; false — nothing changed — for a
   *  component put into itself or into one inside it. */
  moveToBodyFolder: (what: FolderMove, folder: number | null) => boolean
  /** The components shown closed in the list. Not saved. */
  closedFolders: number[]
  setFolderOpen: (id: number, open: boolean) => void
  /** The rows picked in the body list — Ctrl+click adds one, Shift+click
   *  the rows up to it — dragged, moved and hidden together, lit in the
   *  viewport. Let go as an editor opens, by a plain click on the part, a
   *  click on nothing and Escape. Not saved. */
  listSelection: ListPick
  setListSelection: (pick: ListPick) => void
  /** See BodyHover; null with the pointer on none. Not saved. */
  bodyHover: BodyHover | null
  setBodyHover: (hover: BodyHover | null) => void
  building: boolean
  /** Bumped whenever the features change in a way that needs a rebuild. */
  buildVersion: number
  /** Bumped when a build has landed, so the scene redraws the bodies. */
  bodiesVersion: number
  /** The message of the last build that failed outright. */
  buildError: string | null
  beginBuild: () => void
  finishBuild: (results: FeatureResult[], bodies: Omit<BodyInfo, 'color'>[]) => void
  failBuild: (message: string) => void
  toggleBodyVisible: (id: number) => void
  setAllBodiesVisible: (visible: boolean) => void
  /** These bodies' eyes set — a component's, or the others' than the ones
   *  picked. */
  setBodiesVisible: (ids: readonly number[], visible: boolean) => void
  removeFeature: (id: number) => void
  /** Features moved, in the order they stand, to just after `after` (null:
   *  the top of the list) — one undo step, their ids, names and picks kept;
   *  the rollback bar stays between the features it stood between, a
   *  feature moved to just after the last above it going above it too.
   *  Null when moved, or why not (features.ts movedList). */
  moveFeatures: (ids: readonly number[], after: number | null) => string | null
  /** Every feature taken out of the list, those below the rollback bar too
   *  — one undo step; the parameters stay. */
  clearFeatures: () => void
  /** The features below the rollback bar: taken out of `features` — so the
   *  build, the picks, the defaults and every commit work on the part as it
   *  stood at the bar, and a new feature lands there — and put back behind
   *  whatever was added when the bar is moved down again. */
  rolledBack: Feature[]
  /** Put the rollback bar under the first `count` features of the whole
   *  list, or at its end with null. Not an undo step: nothing of the model
   *  changes. Left alone while an editor is open — what it is working on
   *  would go from under it. */
  rollTo: (count: number | null) => void
  /** The feature list played back step by step — see app/playback.ts —
   *  or null while nothing plays. */
  playback: Playback | null
  /** Put the playback at a step: the rollback bar under the first `at`
   *  features, as rollTo puts it, but neither an undo step nor a change to
   *  the file, which keeps the bar where it stood when the playback began.
   *  Left alone while an editor is open. */
  playbackTo: (at: number, playing: boolean) => void
  /** The playback over: the bar back where it stood when it began, or —
   *  with `restore` false — left at the step it stands at. */
  endPlayback: (restore: boolean) => void
  toggleFeatureVisible: (id: number) => void
  /** Features left out of the build, or built again (FeatureFlags) —
   *  below the rollback bar too; one undo step, a rebuild when anything
   *  changed. Returns the ids that changed. */
  setSuppressed: (ids: readonly number[], on: boolean) => number[]
  /** The one number a feature's row reads — an extrude's distance, a
   *  revolve's angle, a shell's wall, a fillet's radius, a chamfer's
   *  distance, a hole's diameter, a slab's thickness — set from the row
   *  without opening the box; the features rebuild. */
  setKeyParameter: (id: number, value: number) => void
  /** The model's parameters — named expressions the features' numbers and
   *  the sketches' dimensions read (core/parameters.ts) — and the table
   *  they evaluate to, kept current with them. */
  parameters: Parameter[]
  nextParameterId: number
  parameterTable: ParameterTable
  /** A new parameter, named p1, p2…, at 0; returns its id. */
  addParameter: (kind?: ParameterKind) => number
  /** A parameter's name, kind, expression or comment changed: refused,
   *  with why, when the name will not do or the table would not evaluate
   *  whole — nothing then changes; otherwise every expression that reads
   *  it is evaluated again, the features and the open editors follow, and
   *  the part rebuilds. A rename is written through every expression. */
  setParameter: (id: number, patch: Partial<Pick<Parameter, 'name' | 'kind' | 'expression' | 'comment'>>) => string | null
  /** Refused, naming its readers, while anything reads it. */
  removeParameter: (id: number) => string | null
  /** The expression behind one number of the open editor's box, by slot
   *  (core/parameters.ts slotsOf), or none — a plain number typed over an
   *  expression lets it go. The number itself the box sets as ever. */
  setDraftExpr: (path: string, expr: string | null) => void
  /** The feature list before each change and after each undo: Ctrl+Z and
   *  Ctrl+Shift+Z over the features, the way a sketch has its own history
   *  inside. A discarded new sketch is Finish then Undo. */
  past: FeatureSnapshot[]
  future: FeatureSnapshot[]
  undoFeatures: () => void
  redoFeatures: () => void
  canUndo: () => boolean
  canRedo: () => boolean
  /** Everything gone — a new scan. */
  reset: () => void
  /** The scan put away — the click on the view bar's Scan key. */
  scanHidden: boolean
  setScanHidden: (hidden: boolean) => void
  /** The bodies put away as a whole — the view bar's switch — to look at
   *  the scan under them and the map on it. Only the drawing: each body's
   *  own eye says whether it is in the model and in the map, and these
   *  stay as they are. Not saved, as the scan's switch is not. */
  bodiesHidden: boolean
  setBodiesHidden: (hidden: boolean) => void
  /** The scan a see-through veil over the bodies — the Transparent switch
   *  in the menu of the view bar's Scan key. Null, as the workspace opens:
   *  see-through while a body is shown, the designed part being what is
   *  looked at, and solid while none is, there being nothing under it. */
  scanSeeThrough: boolean | null
  setScanSeeThrough: (on: boolean) => void
  /** The bodies see-through — the Transparent switch in the menu of the
   *  Bodies key; solid as the workspace opens. */
  bodiesSeeThrough: boolean
  setBodiesSeeThrough: (on: boolean) => void
  /** How the bodies' tangent edges are drawn — where a round runs into a
   *  flat: as the sharp ones, as the workspace opens and as Onshape and
   *  SolidWorks draw them; dimmed; or left out. In the Bodies key's menu.
   *  Not saved: every session starts with them drawn. A round face's seam
   *  and the cut a join left across one surface are drawn in no case
   *  (core/edgeLines.ts). */
  tangentEdges: TangentEdges
  setTangentEdges: (mode: TangentEdges) => void
  /** Where two bodies run into each other, drawn hatched red — the
   *  Overlaps switch in the Bodies key's menu; on as the workspace opens.
   *  Off for a part whose bodies overlap on purpose — a modifier volume for
   *  a slicer — and saved with it: off, nothing is worked out. */
  overlapsShown: boolean
  setOverlapsShown: (on: boolean) => void
  /** The measured elements and sections shown on the part here too. */
  elementsShown: boolean
  setElementsShown: (shown: boolean) => void
  /** The coordinate planes at the origin as their rows' eyes set them, by
   *  the axis each stands on; a plane not set follows the stage — see
   *  coordinatePlaneShown. Not saved, as the bodies' eyes are not. */
  planesShown: Partial<Record<WorldAxis, boolean>>
  setPlaneShown: (axis: WorldAxis, shown: boolean) => void
  /** The scan coloured by its deviation from the committed bodies — the
   *  view bar's Deviation key. The ghost's own map, while an editor is
   *  open, is a preference (rePrefs.liveMap). */
  bodyMap: boolean
  setBodyMap: (on: boolean) => void
  /** Measure's elements as the feature list needs them — a revolve's axis
   *  may be one — kept here by the workspace so that what the store decides
   *  by itself (where a snapped face's move goes) reads the same elements
   *  the box showed. */
  elementRefs: ResolveContext['elements']
  setElementRefs: (elements: ResolveContext['elements']) => void
  /** The scan coloured by its mean curvature — Curvature in the menu of
   *  the view bar's Scan key: flats green, convex rounds towards red,
   *  hollows towards blue, sharp edges dark. Where a surface region should
   *  end is read off it. One map at a time: it and the Deviation key put
   *  each other out. */
  curvatureMap: boolean
  setCurvatureMap: (on: boolean) => void
  /** The reading behind the key, per vertex of the scan in 1/mm, with the
   *  scale it is drawn at; null until the mesh worker has answered, and
   *  again when the scan changes. `shown` is whether it is on the part right
   *  now — a feature's ghost with its live map takes the surface over. */
  curvature: { values: Float32Array; range: number } | null
  setCurvature: (curvature: { values: Float32Array; range: number } | null) => void
  curvatureShown: boolean
  setCurvatureShown: (shown: boolean) => void
  /** What the map on the part is reading right now, for the box and the
   *  legend: null with no map up. `tick` moves with every answer, so a
   *  check can tell a fresh reading from the last one. */
  mapReport: MapReport | null
  setMapReport: (report: MapReport | null) => void
  /** What a picker is pointing at, for the viewport. */
  hint: ViewHint | null
  /** What an editor asks the viewport for on the bodies. */
  bodyPick: BodyPick | null
  setBodyPick: (pick: BodyPick | null) => void
  setHint: (hint: ViewHint | null) => void
  /** The 3D model kept beside the sheet while a sketch is drawn, turned to
   *  face the sketch plane — the reference the drawing is read against. */
  sketchModelShown: boolean
  setSketchModelShown: (shown: boolean) => void
  /** That model cut open at the sketch plane, where the plane runs through
   *  it, so the slice being drawn on is the face in view. */
  sketchSliced: boolean
  setSketchSliced: (sliced: boolean) => void

  // ---- the sketch editor ---------------------------------------------------------
  sketchDraft: SketchDraft | null
  /** How many slice chains lie on the draft's plane, and a version to redraw
   *  by — the chains themselves are in app/useReverse. */
  chainCount: number
  chainsVersion: number
  chainsStatus: 'idle' | 'cutting' | 'ready' | 'failed'
  setChains: (count: number, status: 'idle' | 'cutting' | 'ready' | 'failed') => void
  /** `seed` are pieces the sketch opens with — a body face's outline,
   *  projected (core/re/project). */
  startSketch: (plane: PlaneRef, frame: SectionFrame, seed?: readonly EntityInput[]) => void
  /** A sketch started on a plane by reference — a section, a measured
   *  plane, a coordinate plane — wherever it stands now: the panel's Sketch
   *  on list and a plane's chip both. False when the plane is gone. */
  startSketchOn: (plane: PlaneRef) => boolean
  /** Pieces projected into the sketch being drawn — the Project tool's
   *  click on a body's edge or another sketch's piece. */
  projectInto: (entities: readonly EntityInput[]) => void
  /** The sketch being drawn replaced whole — pieces, relations and
   *  dimensions as one hands them in, ids and all — and solved: one step of
   *  the sketch's own history, as every edit on the sheet is. What a sketch
   *  written out rather than drawn comes in by. */
  /** `pull`: pieces the caller put where they stand, solved as a drag lets
   *  go, the rest of the sketch giving way to them. */
  setSketch: (sketch: Sketch, pull?: readonly Pull[]) => void
  editSketch: (id: number) => void
  /** The draft thrown away without a feature — for the workspace's own
   *  housekeeping (a new scan), not a key: the sketch's one exit is
   *  Finish, and an unwanted sketch is undone from the feature list. */
  discardSketch: () => void
  setSketchTool: (tool: SketchTool) => void
  /** A relation asked for with nothing selected: it is put on the pieces
   *  clicked next, and stays in hand for more until Escape. */
  armRelation: (kind: ConstraintKind) => void
  setSketchName: (name: string) => void
  /** Move the sketch along its plane's normal: a coordinate plane to
   *  another coordinate, a sketch off a face or a measured plane by an
   *  offset — the expression it was typed as kept, or let go with null. */
  setSketchOffset: (offset: number, expr?: string | null) => void
  /** Cut the slice chains at another level, mm along the normal off the
   *  sketch's plane (0 at the plane): the chains are those of that level,
   *  and none of them is fitted yet. */
  setSketchLevel: (level: number) => void
  /** Turn a sketch on a plane through an axis to another angle about it,
   *  as setSketchOffset moves a flat one: its pieces keep their [u, v].
   *  False for a sketch on any other plane, or an axis that is gone. */
  setSketchAngle: (angleDeg: number) => boolean
  /** Lay a picture under the sketch, change it, or take it away (null). */
  setSketchImage: (image: SketchImage | null) => void
  /** Start clicking two points on the picture — see SketchDraft.imagePick
   *  — or stop (null). */
  startImagePick: (mode: ImagePickMode | null) => void
  /** The two points clicked to scale the picture are `length` mm apart. */
  scaleSketchImage: (length: number) => void
  setSketchTolerance: (mm: number | null) => void
  /** A click on the sheet: to the drawing tool or the selection. `radius`
   *  is the hand's reach in sheet millimetres; `snap` is what else there is
   *  to land on. */
  sketchClick: (spot: Vec2, radius: number, additive: boolean, snap?: SnapContext) => void
  /** A press on the sheet with the Select tool: taken as a drag when an
   *  end, a centre or a piece lies under it. Returns whether it was. */
  sketchDragStart: (spot: Vec2, radius: number) => boolean
  /** The hand moved with a piece in it: the point follows, snapping to
   *  what is near, and the solver carries the rest. */
  sketchDrag: (spot: Vec2, radius: number, snap: SnapContext) => void
  /** The hand let go: a point dropped on another's end is joined to it. */
  sketchDragEnd: () => void
  /** A selection box let go with the Select tool — `corners` in sheet
   *  millimetres, in order round it: a window takes the pieces wholly
   *  inside it, a crossing box every piece it touches (core/boxSelect).
   *  They become the selection, or join it when `additive`. */
  sketchBoxSelect: (corners: readonly Vec2[], crossing: boolean, additive: boolean) => void
  /** The Line tool's press on the chain's last end, dragged and let go:
   *  an arc from that end to the spot, tangent to the piece before it. */
  sketchTangentArc: (spot: Vec2, radius: number, snap?: SnapContext) => void
  /** The Spline tool's points made the curve: open — Enter, Escape, a
   *  middle click, a click on the last point again — or closed, a click on
   *  the first. */
  finishSpline: (closed?: boolean) => void
  /** One of the Spline tool's points in hand dragged to a new spot. */
  moveSplinePoint: (index: number, p: Vec2) => void
  /** The selected splines fitted to the slice: the slice points along each
   *  become its soft data, and the solver pulls the curve onto them. */
  fitSplinesToSlice: (chains: readonly (readonly Vec2[])[]) => void
  /** Turn the sheet so the one selected line lies along its X — the frame
   *  turns underneath, the drawing stays where it is on the part. */
  alignToSelected: () => void
  /** Fit lines and arcs to one chain — or every chain — of the slice, the
   *  way the options say: how fine, the corners joined or not, lines laid
   *  along the sheet's axes or not. With `share` (mm), on a sketch that
   *  holds pieces already, each chain lands on them (core/shareFit.ts): what
   *  of it lies along a piece is that piece's, and only the rest is fitted,
   *  in open runs whose ends land on the pieces they reach. */
  autoFit: (chains: readonly Vec2[][], which: number | 'all', options?: FitOptions, share?: number) => void
  /** Fit again every chain already fitted, with other options: the pieces
   *  the last fit made — and the bridges Close drew between them — go, and
   *  with them whatever was put on them by hand. One step to undo. */
  refitChains: (chains: readonly Vec2[][], options?: FitOptions) => void
  /** Corners inferred over every fitted chain, then the sketch solved. */
  inferAllCorners: () => void
  /** Close every fitted chain's open gaps. */
  closeAll: () => void
  /** Bring two selected pieces' nearest ends together. */
  joinSelected: () => void
  addRelation: (kind: ConstraintKind) => void
  addDimension: (kind: 'length' | 'radius' | 'diameter' | 'angle' | 'distance', value?: number) => void
  /** The dimension the selection asks for — see core/re/draw's
   *  dimensionFor: one piece its length, radius or diameter, two their
   *  distance or angle — in hand with the Dimension tool, its number following the
   *  cursor until a click puts it down. */
  dimensionSelection: () => void
  /** The dimension in hand put down where the layout puts it, and opened
   *  for typing — Enter's answer while one follows the cursor. */
  putDownDimension: () => void
  /** A dimension's number typed — and the expression it was typed as,
   *  kept beside the number, or none for a plain number. */
  setDimensionValue: (id: number, value: number, expr?: string | null) => void
  /** A round piece's dimension given the other way — by its diameter
   *  rather than its radius, or back. With no value the size holds: the
   *  number doubled or halved, an expression carried over with it; with
   *  one — Ø12 typed over an R — it takes that, in one step. */
  setDimensionForm: (id: number, form: 'radius' | 'diameter', value?: number, expr?: string | null) => void
  /** The number of the dimension the Dimension tool has in hand confirmed —
   *  typed, or taken as it stands with Enter: the dimension is done, and
   *  the next click starts the next one rather than pairing with it. */
  finishDimension: (id: number) => void
  removeSelectedConstraint: () => void
  selectConstraint: (id: number | null) => void
  deleteSelected: () => void
  sharpenSelected: () => void
  /** Round the corner between the two selected lines; the radius comes out
   *  as a dimension, selected, to be typed over. */
  filletSelected: () => void
  chamferSelected: () => void
  /** A dimension's label dragged on the sheet to `p`. `begin` is the first
   *  step of a drag — the one that is a step to undo. */
  moveDimension: (id: number, p: Vec2, begin: boolean) => void
  toggleFixedSelected: () => void
  toggleConstructionSelected: () => void
  clearSelection: () => void
  /** Open the Pattern box on the pieces selected: three in a row, a step
   *  apart that clears them, to start from. */
  openSketchPattern: () => void
  setSketchPattern: (spec: SketchPatternSpec) => void
  /** Copy the selected pieces as the box says — each copy with the
   *  relations and dimensions the pieces have among themselves — and close
   *  it, the copies selected. */
  applySketchPattern: () => void
  cancelSketchPattern: () => void
  undoSketch: () => void
  redoSketch: () => void
  solveNow: () => void
  /** Turn the draft into a feature, or write it back over the one being
   *  edited. Returns the feature id, or null when there was nothing to
   *  keep — an empty sketch closes and makes nothing. */
  commitSketch: () => number | null
  /** The keys under the sketch's status once a region closes: finish the
   *  sketch and open the feature on it at once, every region of it picked —
   *  from a closed profile to a body without a visit to the panel. */
  finishAndExtrude: () => void
  finishAndRevolve: () => void

  // ---- extrude and revolve -------------------------------------------------------
  extrudeDraft: ExtrudeDraft | null
  /** Open the extrude on a sketch — the last one made when none is named —
   *  with these regions picked, or its one region when it has exactly
   *  one, or none. */
  startExtrude: (sketchId?: number | null, regions?: string[] | null) => void
  editExtrude: (id: number) => void
  /** A flat face of a body pulled: the extrude opens with the face itself
   *  as its profile — found again on the body whenever the extrude runs,
   *  so the pull follows the face through later edits — joining the body
   *  outward and cutting it inward. Returns why not, or null. */
  extrudeFace: (bodyId: number, face: FaceInfo) => string | null
  setExtrude: (patch: Partial<ExtrudeDraft>) => void
  /** The Result chosen in the box. Into Cut or out of it the extrude turns
   *  the other way as well (flipExtrude): a join reaches out of the part, a
   *  cut into it. A command's op does not turn it — it names its extent. */
  setExtrudeOp: (op: ExtrudeDraft['op']) => void
  /** A point clicked on the part — the scan, a body, a corner — while an
   *  extrude is set up: the end on the point's side of the sketch plane
   *  (extrudePickEnd) is put through it, as a number read off the point
   *  once, not a reference kept to it. Answers with what it did, or why it
   *  did nothing, for the status line. */
  extrudeToPoint: (point: Vec3) => string
  /** The other way along the normal: a distance extent's numbers change
   *  sign, so what stood in front of the plane stands behind it. */
  flipExtrude: () => void
  cancelExtrude: () => void
  commitExtrude: () => number | null

  revolveDraft: RevolveDraft | null
  /** As startExtrude; `axis` opens the revolve with its axis already set —
   *  the chip on an element or a sketch line. */
  startRevolve: (sketchId?: number | null, regions?: string[] | null, axis?: AxisRef | null) => void
  editRevolve: (id: number) => void
  setRevolve: (patch: Partial<RevolveDraft>) => void
  /** The revolve made a coil, climbing as it turns — with a pitch half
   *  again the profile's reach along the axis, and three turns where it
   *  turned once — or a plain revolve again, a full turn at most. */
  setRevolveCoil: (on: boolean) => void
  cancelRevolve: () => void
  commitRevolve: () => number | null

  // ---- the features on a body, and a body from an element -----------------------
  featureDraft: FeatureDraft | null
  /** Open a feature's box with its defaults — the last body, a wall from
   *  the Thickness map when one was measured — and what the caller has
   *  already, such as the face or edge the chips were on. */
  startFeature: (kind: FeatureDraftKind, init?: Partial<FeatureDraft>) => void
  editFeature: (id: number) => void
  setFeatureDraft: (patch: Partial<FeatureDraft>) => void
  cancelFeature: () => void
  commitFeature: () => number | null
  /** A click on a body's face or edge while a feature is asking: picked or
   *  let go. A face on another body moves the feature to that body. A
   *  Delete face takes `group` with the face — what the click on it takes
   *  (faceGroup.ts) — and lets all of it go when the face was picked. */
  toggleDraftFace: (bodyId: number, face: FaceInfo, group?: FaceInfo[]) => void
  /** Vertices of the scan into a surface's region — a flood from a click
   *  — or out of it. */
  addToRegion: (vertices: Uint32Array, remove?: boolean) => void
  /** The region as the marking tools left it. */
  setRegion: (region: Uint32Array) => void
  toggleDraftEdge: (bodyId: number, edge: EdgeInfo) => void
  /** Every picked face or edge let go — a shell's faces, a draft's, a
   *  fillet's or a chamfer's edges — to pick again from nothing. */
  clearDraftPicks: () => void
  /** The bodies the open Move takes, its pivot following them to their
   *  middle. */
  setMoveBodies: (bodies: number[]) => void
  /** The open Patch network edited: `change` takes the draft as it stands
   *  to the next (state/reNetworkDraft.ts). Nothing while no network is
   *  open. */
  editNetwork: (change: (d: Extract<FeatureDraft, { kind: 'network' }>) => Extract<FeatureDraft, { kind: 'network' }>) => void

  /** A click on a sketch's region in the viewport, for whichever of the
   *  two editors is open: picked or let go — and a region of another
   *  sketch starts the pick over on that sketch. */
  toggleDraftRegion: (sketchId: number, key: string) => void
  /** Every region of the draft's sketch — or, with all picked, none. */
  pickAllDraftRegions: () => void
  /** The ghost's standing, from app/useReverse. */
  preview: PreviewInfo
  setPreview: (preview: PreviewInfo) => void
  /** A feature grip dragged: millimetres along an extrude's arrow, degrees
   *  round a revolve's ring, since the drag began. */
  gripDrag: (side: FeatureGripSide, delta: number, phase: 'start' | 'move' | 'end') => void
  /** The grip whose number is shown in a field on it in the viewport — the
   *  one last dragged; the field stays after the hand lets go so the number
   *  can be typed over. Null with none. */
  gripField: FeatureGripSide | null
  setGripField: (side: FeatureGripSide | null) => void
  /** A number typed into that field: the extent or the angle the grip
   *  drags. */
  setGripValue: (side: FeatureGripSide, value: number) => void
  /** What a click on the part picked while no editor is open. */
  selection: ReSelection | null
  setSelection: (selection: ReSelection | null) => void
  /** A face, an edge or a corner of a body clicked with no editor open:
   *  the selection, or — `additive`, Ctrl held — one more in it, or one
   *  fewer when it was in it already. */
  pickBodyItem: (item: PickedItem, at: { x: number; y: number }, additive: boolean) => void
  /** A window dragged over the bodies with no editor open: everything in
   *  it joins the selection. */
  addBodyItems: (items: PickedItem[], at: { x: number; y: number }) => void
  /** A window dragged while a fillet, a chamfer or a shell asks for its
   *  edges or faces: all of them are added, none taken off. */
  addDraftEdges: (bodyId: number, edges: EdgeInfo[]) => void
  addDraftFaces: (bodyId: number, faces: FaceInfo[]) => void
}

export const useReverse = create<ReState>()((set, get) => ({
  kernelStatus: 'idle',
  kernelMessage: null,
  kernelVersion: null,
  setKernel: (kernelStatus, kernelMessage = null, kernelVersion = null) =>
    set({ kernelStatus, kernelMessage, kernelVersion }),

  features: [],
  nextFeatureId: 1,
  nextOfKind: {},
  results: {},
  bodies: [],
  hiddenBodies: [],
  bodyStyles: {},
  stepFiles: {},
  addStepFile: (name, text) => {
    const file: StepFileRef = { key: stepFileKey(text), name, size: text.length }
    if (!Object.hasOwn(get().stepFiles, file.key)) set((s) => ({ stepFiles: { ...s.stepFiles, [file.key]: text } }))
    return file
  },
  setBodyStyle: (id, patch) =>
    set((s) => {
      const was = s.bodyStyles[id] ?? {}
      const next: BodyStyle = { ...was }
      if (patch.name !== undefined) {
        if (patch.name && patch.name.trim()) next.name = patch.name.trim()
        else delete next.name
      }
      if (patch.color !== undefined) {
        if (patch.color) next.color = patch.color
        else delete next.color
      }
      if (next.name === was.name && next.color === was.color) return {}
      const bodyStyles = { ...s.bodyStyles }
      if (next.name === undefined && next.color === undefined) delete bodyStyles[id]
      else bodyStyles[id] = next
      return { ...remember(s), bodyStyles, bodies: nameBodies(s.bodies, s.features, bodyStyles) }
    }),
  bodyFolders: [],
  addBodyFolder: (parent, what) => {
    const s = get()
    const id = nextFolderId(s.bodyFolders)
    const made = [...s.bodyFolders, { id, name: nextFolderName(s.bodyFolders), parent: parent !== null && s.bodyFolders.some((f) => f.id === parent) ? parent : null, bodies: [] }]
    set({ ...remember(s), bodyFolders: (what && moveInto(made, what, id)) || made })
    return id
  },
  renameBodyFolder: (id, name) =>
    set((s) => {
      const f = s.bodyFolders.find((g) => g.id === id)
      const text = name.trim()
      if (!f || !text || text === f.name) return {}
      return { ...remember(s), bodyFolders: s.bodyFolders.map((g) => (g.id === id ? { ...g, name: text } : g)) }
    }),
  removeBodyFolder: (id) =>
    set((s) => {
      if (!s.bodyFolders.some((f) => f.id === id)) return {}
      return { ...remember(s), bodyFolders: withoutFolder(s.bodyFolders, id), closedFolders: s.closedFolders.filter((c) => c !== id) }
    }),
  moveToBodyFolder: (what, folder) => {
    const s = get()
    const next = moveInto(s.bodyFolders, what, folder)
    if (!next) return false
    if (next !== s.bodyFolders) set({ ...remember(s), bodyFolders: next })
    return true
  },
  closedFolders: [],
  setFolderOpen: (id, open) =>
    set((s) => (open === !s.closedFolders.includes(id) ? {} : { closedFolders: open ? s.closedFolders.filter((c) => c !== id) : [...s.closedFolders, id] })),
  listSelection: NO_PICK,
  setListSelection: (pick) => set({ listSelection: pick.bodies.length + pick.folders.length === 0 ? NO_PICK : pick }),
  bodyHover: null,
  setBodyHover: (hover) =>
    set((s) => {
      const was = s.bodyHover
      const same = was === hover || (was !== null && hover !== null && was.from === hover.from && was.ids.length === hover.ids.length && was.ids.every((id, i) => id === hover.ids[i]))
      return same ? {} : { bodyHover: hover }
    }),
  building: false,
  buildVersion: 0,
  bodiesVersion: 0,
  buildError: null,

  beginBuild: () => set({ building: true, buildError: null }),
  finishBuild: (results, bodies) =>
    set((s) => {
      // Out of view as the lasting set has it, not as the last build left
      // the eyes: that build may have lacked the body.
      const hiddenBodies = hiddenOf(s.hiddenBodies, [...s.features, ...s.rolledBack])
      const hidden = new Set(hiddenBodies)
      // A sketch on a body's face is kept where the build found the face,
      // and a sketch whose projected pieces were taken again as the build
      // solved it on them: the frame and the pieces the features on it are
      // lifted from next time, the overlay and the editor drawn so. No undo
      // step and no rebuild — the build just ran there, and running it
      // again would find the same.
      const moved = new Map<number, SectionFrame>()
      const retaken = new Map<number, Sketch>()
      for (const r of results) {
        if (r.sketchFrame) moved.set(r.sketchFrame.sketchId, r.sketchFrame.frame)
        if (r.sketch) retaken.set(r.id, r.sketch)
      }
      const follow = (f: Feature): Feature => {
        if (f.kind !== 'sketch') return f
        const sketch = retaken.get(f.id)
        const frame = f.plane.kind === 'bodyFace' ? moved.get(f.id) : undefined
        const placed = frame && frameKey(frame) !== frameKey(f.frame) && f.plane.kind === 'bodyFace' ? { frame, plane: { ...f.plane, frame } } : {}
        return sketch || 'frame' in placed ? { ...f, ...placed, ...(sketch ? { sketch } : {}) } : f
      }
      return {
        building: false,
        results: Object.fromEntries(results.map((r) => [r.id, r])),
        bodies: nameBodies(bodies, s.features, s.bodyStyles).map((b) => ({ ...b, visible: !hidden.has(b.id) })),
        ...(hiddenBodies !== s.hiddenBodies ? { hiddenBodies } : {}),
        bodiesVersion: s.bodiesVersion + 1,
        ...(moved.size + retaken.size > 0 ? { features: s.features.map(follow) } : {}),
      }
    }),
  failBuild: (message) => set((s) => ({ building: false, buildError: message, bodies: [], bodiesVersion: s.bodiesVersion + 1 })),

  toggleBodyVisible: (id) =>
    set((s) => {
      const b = s.bodies.find((x) => x.id === id)
      return eyesSet(s, [id], b ? !b.visible : s.hiddenBodies.includes(id))
    }),
  // Every body shown: those the build lacks now too, or a rolled-back
  // one would come back hidden after a Show all.
  setAllBodiesVisible: (visible) => set((s) => eyesSet(s, visible ? [...s.hiddenBodies, ...s.bodies.map((b) => b.id)] : s.bodies.map((b) => b.id), visible)),
  setBodiesVisible: (ids, visible) => set((s) => eyesSet(s, ids, visible)),

  clearFeatures: () =>
    set((s) => {
      if (s.features.length + s.rolledBack.length === 0) return {}
      // Every feature, those below the bar too; the parameters and the
      // counters the names run on stay.
      return { ...remember(s), features: [], rolledBack: [], buildVersion: s.buildVersion + 1, extrudeDraft: null, revolveDraft: null, featureDraft: null, sketchDraft: null, selection: null }
    }),
  removeFeature: (id) =>
    set((s) => {
      // A feature others build on stays — like an element with dependents.
      if (dependentsOf(id, [...s.features, ...s.rolledBack]).length > 0) return {}
      return {
        ...remember(s),
        features: s.features.filter((f) => f.id !== id),
        rolledBack: s.rolledBack.filter((f) => f.id !== id),
        buildVersion: s.buildVersion + 1,
        extrudeDraft: s.extrudeDraft?.featureId === id ? null : s.extrudeDraft,
        revolveDraft: s.revolveDraft?.featureId === id ? null : s.revolveDraft,
        featureDraft: s.featureDraft?.featureId === id ? null : s.featureDraft,
        sketchDraft: s.sketchDraft?.featureId === id ? null : s.sketchDraft,
        selection: null,
      }
    }),
  moveFeatures: (ids, after) => {
    const s = get()
    if (reEditorOpen(s)) return 'A box is open in the panel — finish or cancel it first.'
    const order = movedList([...s.features, ...s.rolledBack], ids, after)
    if (typeof order === 'string') return order
    // The bar after the last feature above it that stays — and after the
    // features moved to just below that one.
    const above = s.features.filter((f) => !ids.includes(f.id))
    const last = above.length > 0 ? above[above.length - 1].id : null
    const k = (last === null ? 0 : order.findIndex((f) => f.id === last) + 1) + (last === after ? order.filter((f) => ids.includes(f.id)).length : 0)
    set({ ...remember(s), features: order.slice(0, k), rolledBack: order.slice(k), buildVersion: s.buildVersion + 1, selection: null })
    return null
  },
  rolledBack: [],
  rollTo: (count) =>
    set((s) => {
      if (reEditorOpen(s)) return {}
      const all = [...s.features, ...s.rolledBack]
      const at = count === null ? all.length : Math.min(all.length, Math.max(0, Math.round(count)))
      if (at === s.features.length) return {}
      return { ...CLOSE_OTHERS, features: all.slice(0, at), rolledBack: all.slice(at), buildVersion: s.buildVersion + 1 }
    }),
  playback: null,
  playbackTo: (count, playing) =>
    set((s) => {
      if (reEditorOpen(s)) return {}
      const all = [...s.features, ...s.rolledBack]
      const at = Math.min(all.length, Math.max(0, Math.round(count)))
      const playback = { origin: s.playback?.origin ?? s.features.length, at, playing }
      if (at === s.features.length) return { playback }
      return { ...CLOSE_OTHERS, features: all.slice(0, at), rolledBack: all.slice(at), playback, buildVersion: s.buildVersion + 1 }
    }),
  endPlayback: (restore) =>
    set((s) => {
      if (!s.playback) return {}
      const all = [...s.features, ...s.rolledBack]
      const at = Math.min(all.length, s.playback.origin)
      if (!restore || reEditorOpen(s) || at === s.features.length) return { playback: null }
      return { playback: null, features: all.slice(0, at), rolledBack: all.slice(at), buildVersion: s.buildVersion + 1 }
    }),
  toggleFeatureVisible: (id) =>
    set((s) => ({ ...remember(s), features: s.features.map((f) => (f.id === id ? { ...f, visible: !f.visible } : f)) })),
  setSuppressed: (ids, on) => {
    const s = get()
    const changed = [...s.features, ...s.rolledBack].filter((f) => ids.includes(f.id) && Boolean(f.suppressed) !== on).map((f) => f.id)
    if (changed.length === 0) return []
    const flip = (f: Feature): Feature => {
      if (!changed.includes(f.id)) return f
      const { suppressed: _was, ...rest } = f
      void _was
      return (on ? { ...rest, suppressed: true } : rest) as Feature
    }
    set({ ...remember(s), features: s.features.map(flip), rolledBack: s.rolledBack.map(flip), buildVersion: s.buildVersion + 1 })
    return changed
  },
  setKeyParameter: (id, value) =>
    set((s) => {
      if (!Number.isFinite(value)) return {}
      const f = s.features.find((x) => x.id === id)
      const next = f && withKeyParameter(f, value)
      if (!next || next === f) return {}
      // A number typed over the row stands on its own: the expression
      // behind it, if any, is let go.
      return { ...remember(s), features: s.features.map((x) => (x.id === id ? unlinkSlots(next, keyParameterPaths(next)) : x)), buildVersion: s.buildVersion + 1 }
    }),

  parameters: [],
  nextParameterId: 1,
  parameterTable: evaluateParameters([]),
  addParameter: (kind = 'length') => {
    const s = get()
    const id = s.nextParameterId
    const taken = new Set(s.parameters.map((p) => p.name))
    let n = 1
    while (taken.has(`p${n}`)) n++
    const parameters = [...s.parameters, { id, name: `p${n}`, kind, expression: '0' }]
    set({ ...remember(s), parameters, nextParameterId: id + 1, parameterTable: evaluateParameters(parameters) })
    return id
  },
  setParameter: (id, patch) => {
    const s = get()
    const p = s.parameters.find((x) => x.id === id)
    if (!p) return 'There is no such parameter.'
    let parameters = s.parameters
    const renamed = patch.name !== undefined && patch.name !== p.name ? { from: p.name, to: patch.name } : null
    if (renamed) {
      const problem = nameProblem(renamed.to, s.parameters, id)
      if (problem) return problem
      parameters = renameInParameters(parameters, id, renamed.to)
    }
    const rest: Partial<Parameter> = {}
    if (patch.kind !== undefined) rest.kind = patch.kind
    if (patch.expression !== undefined) rest.expression = patch.expression
    if (patch.comment !== undefined) rest.comment = patch.comment
    parameters = parameters.map((x) => (x.id === id ? { ...x, ...rest } : x))
    if (parameters.every((x, i) => x === s.parameters[i])) return null
    const table = evaluateParameters(parameters)
    const mine = table.readings.find((r) => r.id === id)
    if (mine?.error) return mine.error
    // Nor may an edit leave another parameter without a value — a kind
    // changed under one that reads it.
    const was = new Map(s.parameterTable.readings.map((r) => [r.id, r.error]))
    const broke = table.readings.find((r) => r.error && !was.get(r.id))
    if (broke) return `would leave “${broke.name}” with no value: ${broke.error}`
    set({ ...remember(s), ...followParameters(s, parameters, table, renamed) })
    return null
  },
  removeParameter: (id) => {
    const s = get()
    const p = s.parameters.find((x) => x.id === id)
    if (!p) return null
    const users = usersOf(p.name, s.parameters, [...s.features, ...s.rolledBack]).map((u) => u.name)
    for (const d of [s.extrudeDraft, s.revolveDraft, s.featureDraft]) if (d && featureReads(d, p.name)) users.push('the feature being set up')
    if (s.sketchDraft && featureReads(s.sketchDraft, p.name)) users.push('the sketch being drawn')
    if (users.length > 0) return `${p.name} is read by ${users.join(', ')} — take it out of those first.`
    const parameters = s.parameters.filter((x) => x.id !== id)
    set({ ...remember(s), parameters, parameterTable: evaluateParameters(parameters) })
    return null
  },
  setDraftExpr: (path, expr) =>
    set((s) => {
      const put = <T extends { exprs?: ExprMap }>(d: T): T => (expr ? { ...d, exprs: { ...(d.exprs ?? {}), [path]: expr } } : unlinkSlot(d, path))
      if (s.extrudeDraft) return { extrudeDraft: put(s.extrudeDraft) }
      if (s.revolveDraft) return { revolveDraft: put(s.revolveDraft) }
      if (s.featureDraft) return { featureDraft: put(s.featureDraft) }
      return {}
    }),

  past: [],
  future: [],
  undoFeatures: () =>
    set((s) => {
      const prev = s.past[s.past.length - 1]
      if (!prev) return {}
      return {
        past: s.past.slice(0, -1),
        future: [...s.future, snapshotOf(s)],
        ...restored(prev),
        // A feature the undo takes away lets its id go to the next one made:
        // its bodies' eyes go with it.
        hiddenBodies: hiddenOf(s.hiddenBodies, [...prev.features, ...prev.rolledBack]),
        // An editor open on the list that just changed under it closes; a
        // sketch being drawn stays unless the feature it edits is gone.
        extrudeDraft: null,
        revolveDraft: null,
        featureDraft: null,
        bodyPick: null,
        preview: { status: 'idle' },
        gripField: null,
        selection: null,
        sketchDraft: s.sketchDraft?.featureId !== undefined && !prev.features.some((f) => f.id === s.sketchDraft!.featureId) ? null : s.sketchDraft,
        buildVersion: s.buildVersion + 1,
      }
    }),
  redoFeatures: () =>
    set((s) => {
      const next = s.future[s.future.length - 1]
      if (!next) return {}
      return {
        future: s.future.slice(0, -1),
        past: [...s.past, snapshotOf(s)],
        ...restored(next),
        hiddenBodies: hiddenOf(s.hiddenBodies, [...next.features, ...next.rolledBack]),
        extrudeDraft: null,
        revolveDraft: null,
        featureDraft: null,
        bodyPick: null,
        preview: { status: 'idle' },
        gripField: null,
        selection: null,
        buildVersion: s.buildVersion + 1,
      }
    }),
  canUndo: () => get().past.length > 0,
  canRedo: () => get().future.length > 0,

  scanHidden: false,
  setScanHidden: (scanHidden) => set({ scanHidden }),
  bodiesHidden: false,
  setBodiesHidden: (bodiesHidden) => set({ bodiesHidden }),
  scanSeeThrough: null,
  setScanSeeThrough: (scanSeeThrough) => set({ scanSeeThrough }),
  bodiesSeeThrough: false,
  setBodiesSeeThrough: (bodiesSeeThrough) => set({ bodiesSeeThrough }),
  tangentEdges: 'visible',
  setTangentEdges: (tangentEdges) => set({ tangentEdges }),
  overlapsShown: true,
  setOverlapsShown: (overlapsShown) => set({ overlapsShown }),
  elementsShown: true,
  setElementsShown: (elementsShown) => set({ elementsShown }),
  planesShown: {},
  setPlaneShown: (axis, shown) => set((s) => ({ planesShown: { ...s.planesShown, [axis]: shown } })),
  elementRefs: [],
  setElementRefs: (elementRefs) => set({ elementRefs }),
  bodyMap: false,
  setBodyMap: (bodyMap) => set(bodyMap ? { bodyMap, curvatureMap: false } : { bodyMap }),
  curvatureMap: false,
  setCurvatureMap: (curvatureMap) => set(curvatureMap ? { curvatureMap, bodyMap: false } : { curvatureMap }),
  curvature: null,
  setCurvature: (curvature) => set({ curvature }),
  curvatureShown: false,
  setCurvatureShown: (curvatureShown) => set({ curvatureShown }),
  mapReport: null,
  setMapReport: (mapReport) => set({ mapReport }),
  hint: null,
  setHint: (hint) => set({ hint }),
  bodyPick: null,
  setBodyPick: (bodyPick) => set({ bodyPick }),
  sketchModelShown: true,
  setSketchModelShown: (sketchModelShown) => set({ sketchModelShown }),
  sketchSliced: true,
  setSketchSliced: (sketchSliced) => set({ sketchSliced }),

  reset: () =>
    set((s) => ({
      features: [],
      rolledBack: [],
      playback: null,
      parameters: [],
      nextParameterId: 1,
      parameterTable: evaluateParameters([]),
      results: {},
      bodies: [],
      hiddenBodies: [],
      bodyStyles: {},
      bodyFolders: [],
      closedFolders: [],
      listSelection: NO_PICK,
      bodyHover: null,
      stepFiles: {},
      buildVersion: s.buildVersion + 1,
      sketchDraft: null,
      extrudeDraft: null,
      revolveDraft: null,
      featureDraft: null,
      bodyPick: null,
      buildError: null,
      past: [],
      future: [],
      selection: null,
      gripField: null,
      preview: { status: 'idle' },
      mapReport: null,
      planesShown: {},
      bodiesHidden: false,
      overlapsShown: true,
    })),

  // ---- the sketch editor ---------------------------------------------------------
  sketchDraft: null,
  chainCount: 0,
  chainsVersion: 0,
  chainsStatus: 'idle',
  setChains: (chainCount, chainsStatus) => set((s) => ({ chainCount, chainsStatus, chainsVersion: s.chainsVersion + 1 })),
  ...sketchSlice(set, get),
  ...solidSlice(set, get),
  ...gripSlice(set, get),
  selection: null,
  setSelection: (selection) => set({ selection }),
  pickBodyItem: (item, at, additive) =>
    set((s) => {
      // A plain click on the part is a new selection: the rows picked in
      // the list are let go with what was picked there before.
      if (!additive) return { selection: selectionOf([item], at), listSelection: NO_PICK }
      const held = selectionItems(s.selection)
      const k = itemKey(item)
      const next = held.some((i) => itemKey(i) === k) ? held.filter((i) => itemKey(i) !== k) : [...held, item]
      return { selection: selectionOf(next, at) }
    }),
  addBodyItems: (items, at) =>
    set((s) => {
      const held = selectionItems(s.selection)
      const seen = new Set(held.map(itemKey))
      const next = [...held]
      for (const i of items) {
        if (seen.has(itemKey(i))) continue
        seen.add(itemKey(i))
        next.push(i)
      }
      return { selection: selectionOf(next, at) }
    }),
  ...featureSlice(set, get),
}))

export { arcThrough }

/** `hidden` without the ids no feature of `features` can have made — a
 *  body's id is its step's, or the step's and a fraction (islandId) — the
 *  same array where none went. */
function hiddenOf(hidden: number[], features: readonly { id: number }[]): number[] {
  if (hidden.length === 0) return hidden
  const steps = new Set(features.map((f) => f.id))
  const kept = hidden.filter((id) => steps.has(Math.floor(id)))
  return kept.length === hidden.length ? hidden : kept
}

/** The eyes of these bodies set, in the lasting set and on the bodies
 *  built — an id the build lacks is written all the same — or no change
 *  where none is. */
function eyesSet(s: Pick<ReState, 'bodies' | 'hiddenBodies'>, ids: readonly number[], visible: boolean): Partial<ReState> {
  const these = new Set(ids)
  const was = new Set(s.hiddenBodies)
  const hiddenBodies = visible ? s.hiddenBodies.filter((id) => !these.has(id)) : [...s.hiddenBodies, ...[...these].filter((id) => !was.has(id))]
  const bodiesChange = s.bodies.some((b) => these.has(b.id) && b.visible !== visible)
  const hiddenChange = hiddenBodies.length !== s.hiddenBodies.length
  return {
    ...(hiddenChange ? { hiddenBodies } : {}),
    ...(bodiesChange ? { bodies: s.bodies.map((b) => (these.has(b.id) && b.visible !== visible ? { ...b, visible } : b)) } : {}),
  }
}

/** Open a feature's editor, whatever its kind: a sketch's, an extrude's or
 *  a revolve's own, the feature box for the rest — the feature list's
 *  pencil, and a face's Edit chip for the feature that made the face. */
export function openFeatureEditor(id: number): void {
  const s = useReverse.getState()
  const f = s.features.find((x) => x.id === id)
  if (!f) return
  if (f.kind === 'sketch') s.editSketch(id)
  else if (f.kind === 'extrude') s.editExtrude(id)
  else if (f.kind === 'revolve') s.editRevolve(id)
  else s.editFeature(id)
}

/** The pieces and constraints as counts, for the row. */
export function describeSketch(sketch: Sketch): string {
  const n = sketch.entities.length
  const c = sketch.constraints.length
  return `${n} piece${n === 1 ? '' : 's'}${c > 0 ? ` · ${c} relation${c === 1 ? '' : 's'}` : ''}`
}

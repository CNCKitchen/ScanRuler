// SPDX-License-Identifier: AGPL-3.0-only
// The main store: the scan loaded and what 3D Measure makes on it —
// elements and their drafts, dimensions, sections, the datum alignment —
// with the status line, busy flag and error every workspace shares. What
// belongs to one scan starts afresh with the next; element and dimension
// ids run on. One editor is open at a time, so a click in the viewport has
// one taker. The pure rules are in elementModel, alignModel and
// sectionModel; a few settings remembered per browser are here too — the
// navigation, the colour scheme, the export forms, the sharp edges.

import { create } from 'zustand'
import { elementKindInfo } from '../core/elements/kinds'
import {
  creationMethod,
  takesSurface,
} from '../core/elements/construct'
import type { Dimension, DimensionFamily, Limit, SphereAnchor } from '../core/dimensions'
import {
  assignDimensionRefs,
  dimensionTypeInfo,
  resolveDimensionType,
  selectionFits,
  stemKey,
} from '../core/dimensions'
import { roleOf } from '../core/elements/refs'
import {
  extensionOf,
  fitsInside,
  isExtendable,
  isExtended,
  squareExtension,
  withFitInside,
  withSide,
  zeroExtension,
  type ExtendSide,
} from '../core/elements/extend'
import { hasDiameter } from '../core/elements/assumed'
import {
  isOrientable,
  isOrientRef,
  refThroughMotion,
  type OrientRelation,
} from '../core/elements/orient'
import { basePlaneOf } from '../core/basePlanes'
import {
  ALIGN_PICK_COUNT,
  transformFit,
  type AlignSlot,
  type AxisDir,
} from '../core/alignment'
import { rigidApply, rigidCompose, rigidRotate, type Rigid } from '../core/deviation/rigid'
import {
  axisOfFrame,
  canCutAlong,
  cutAxisOf,
  isRadialRef,
  isWorldAxis,
  sectionRefAxis,
  sectionRefElement,
  transformAxis,
  transformFrame,
  worldCutAxis,
  type CutAxis,
  type SectionPlaneRef,
} from '../core/section/frame'
import { transformCut, type SectionCut } from '../core/section/slice'
import { SCHEMES, schemeById } from '../viewer/navSchemes'
import type { Projection } from '../viewer/orthoViewport'
import { DEFAULT_THEME, themeById } from '../viewer/viewThemes'
import type { StepStyle } from '../core/exportStep'
import { creaseAngleOf, type CreaseMode } from '../core/geometry/crease'
import type { CloudFormat } from '../core/exportPointCloud'
import type {
  ElementKind,
  ElementSource,
  FitOutput,
  FitSettings,
  PointFit,
  SigmaPreset,
  Vec3,
} from '../core/types'
import { blockedRefs, defaultMethod, dependentsOf, type DimensionDraft, type Draft, draftFromElement, type Element, elementColor, evalConstructDraft, freshCounters, freshDraft, keptOf, nextPointPick, reevaluateConstructions, type SelectMode, transformSource, withoutRegion } from './elementModel'
import { type AlignDraft, type AlignmentProposal, alignSlotPicks, withSlotPicks, withSlotRef } from './alignModel'
import { centreShadowDraft, dimensionRefsOf, type Section, sectionMeasureRefs, type SectionDraft, sectionDraftReady, sectionKeyOf, type SectionKind, specFields, settleSectionDraft } from './sectionModel'
export { type Section, type SectionDraft, sectionDraftColorOf, sectionDraftReady } from './sectionModel'
export { alignCenterOf, type AlignDraft, alignmentPreview, type AlignmentProposal, type AlignPreview, alignSlotPicks } from './alignModel'
export { blockedRefs, type DimensionDraft, type Draft, draftColorOf, draftHolds, type Element, orientedDraft, picksItsPoints, type SelectMode } from './elementModel'

export type { AlignSlot }

interface AppState {
  /** What the operator named the project — what it is saved and exported
   *  under, whatever the scan was called — or null for one not named, which
   *  goes by the scan's or the image's name. It is the project's, not the
   *  scan's: a scan opened into a named project keeps the name. */
  projectName: string | null
  setProjectName: (name: string | null) => void
  fileName: string | null
  vertexCount: number
  triangleCount: number
  /** Half the scan's bounding-box diagonal — the scale constructed elements
   *  without an inherent size are drawn at. */
  modelSize: number
  /** Centre of the scan's bounding box, carried through every applied
   *  alignment — what a first alignment centres on the origin. */
  modelCenter: Vec3
  busy: boolean
  /** A search the tool is running on the scan for the user — Auto-align
   *  reading the part's directions, Use symmetry looking for its mirror
   *  plane — as the word the viewport shows over the part meanwhile, or
   *  null. The strip's status line says what is being searched for. */
  working: string | null
  statusText: string
  /** How far the job the status line describes has got, 0 to 1, when it
   *  says — a progress message from the worker — or null. */
  progress: number | null
  errorText: string | null
  elements: Element[]
  draft: Draft | null
  /** The last draft closed unfinished with a marked surface still on it. A
   *  marking is minutes of work and the draft is the only thing that holds
   *  it, so a draft dropped with one — a second Escape, a slip onto Cancel,
   *  another editor taking the panel — is kept here until the next draft
   *  starts, and restoreDraft puts it back, marking and all. Nothing else is
   *  kept: a click or a choice of references is a moment to redo. Always
   *  carries a non-empty `selection`. */
  discarded: Draft | null
  dimensions: Dimension[]
  dimDraft: DimensionDraft | null
  alignDraft: AlignDraft | null
  /** The scan cut with planes, for the 2D workspace — see Section. */
  sections: Section[]
  sectionDraft: SectionDraft | null
  /** Sections are named "Section 1", "Section 2", … on a counter of their own. */
  nextSectionNumber: number
  /** Cumulative datum alignment already baked into the scan — inverted to
   *  put the part back where the scanner delivered it. */
  appliedAlignment: Rigid | null
  nextId: number
  nextNumber: number
  /** Per-kind counters, so elements are named "Sphere 1", "Plane 1", … */
  nextOfKind: Record<ElementKind, number>
  nextDimensionId: number
  /** The next number of each dimension kind, keyed by its name stem — see
   *  stemKey. A kind not yet used has no entry and starts at 1. */
  nextOfDimGroup: Record<string, number>
  /** The fit settings the next new element starts with — the ones last chosen
   *  in any draft. Not what any element is measured with: each fitted element
   *  carries its own in its source, and changing the setting on one leaves
   *  the others as they were. A tool setting like selectMode, kept because
   *  whoever needed a tighter cut-off on one face is likely to want it on the
   *  next. */
  settings: FitSettings
  /** Where a fit gets its surface from — see SelectMode. Marking one by hand
   *  uses the shared tools in markStore, the same ones the deviation
   *  workspace's local fine fit is marked with. */
  selectMode: SelectMode
  /** The name tags and readouts on the part in 3D Measure — in the menu of
   *  the view bar's Elements key. */
  showLabels: boolean
  /** The scan put away — the view bar's Scan key, where no workspace holds
   *  the key itself. Not saved, and a new scan comes in shown. */
  scanHidden: boolean
  /** The elements, the dimensions and the sections put away as a whole in
   *  3D Measure — the view bar's Elements key. Each one's own eye in the
   *  list stays as it is. Not saved. */
  elementsHidden: boolean
  /** Colour the far side of every triangle of the scan differently, so holes
   *  and inverted normals stop reading as solid part. */
  showBackfaces: boolean
  /** Draw the scan see-through, so the reference inside it, the fitted
   *  elements and the pinned readings show. A way of looking for the session,
   *  not a property of the part: neither this nor the mesh is saved. */
  translucent: boolean
  /** Draw the triangle edges on the scan. */
  wireframe: boolean
  /** The scan came with colours of its own — a textured OBJ — which bare
   *  surface wears in place of the stage's scan colour. */
  scanColors: boolean
  /** Show those colours, or the plain surface. Kept across scans. */
  showScanColors: boolean
  /** Id of the mouse navigation scheme (see viewer/navSchemes). Remembered per
   *  browser, because which buttons orbit is a habit from whichever CAD the
   *  user came from, not a property of the part on screen. */
  navScheme: string
  /** How the 3D view is drawn: in parallel, as measuring wants it, or in
   *  perspective. Remembered per browser, like the navigation. */
  projection: Projection
  /** Id of the viewport colour scheme (see viewer/viewThemes). Remembered per
   *  browser for the same reason as the navigation: which stage a part is
   *  easiest to read on is the operator's preference, not the part's. */
  viewTheme: string
  /** Which form the STEP export is written in. Remembered per browser, like
   *  the navigation scheme: whether measured elements should reach CAD as
   *  bodies or as construction geometry is a property of how the user works,
   *  not of the part on screen. */
  stepStyle: StepStyle
  /** Which file the point-cloud export writes — remembered per browser for
   *  the same reason: which cloud format the next tool reads is how the user
   *  works, not what the part is. */
  cloudFormat: CloudFormat
  /** Whether the scan's sharp edges are drawn sharp — split for shading, see
   *  core/geometry/crease.ts — always (unless told otherwise), never, or only
   *  when the mesh looks tessellated from CAD. Remembered per browser: it is
   *  a way of looking, and the reference part is always drawn sharp
   *  regardless. */
  creaseMode: CreaseMode
  /** From what angle between two faces, in degrees, an edge of the scan is
   *  drawn sharp when its sharp edges are — remembered with the mode. */
  creaseAngle: number
  /** Imprint & privacy dialog, opened from the status strip. */
  imprintOpen: boolean

  setStatus: (text: string) => void
  setError: (text: string | null) => void
  setWorking: (label: string | null) => void
  beginLoad: (name: string) => void
  finishLoad: (
    vertexCount: number,
    triangleCount: number,
    modelSize: number,
    modelCenter: Vec3,
  ) => void
  loadFailed: (message: string) => void
  resolveFit: (id: number, r: FitOutput) => void
  failFit: (id: number, message: string) => void
  removeElement: (id: number) => void
  toggleElementVisible: (id: number) => void
  /** Show or hide every element at once. */
  setAllElementsVisible: (visible: boolean) => void
  startDraft: (kind: ElementKind) => void
  /** Re-open an existing element for editing. The caller puts its seeds or its
   *  marked surface back on the scan — see draftFromElement. */
  editElement: (id: number) => void
  setDraftName: (name: string) => void
  setDraftMethod: (method: string) => void
  /** The picked surface points of the open draft — vertex triples for the
   *  fit pipeline, plus the exact hit points for the pick-mode methods that
   *  need coordinates (a circle through picked points). */
  setDraftPicks: (picks: [number, number, number][], points?: Vec3[]) => void
  /** Where the open draft's picks landed on the scan, without touching the
   *  picks or the fit standing on them — a re-opened element getting the spots
   *  it was measured from back onto the part. */
  setDraftPickPoints: (points: Vec3[]) => void
  /** The hand-marked surface a draft's fit is running on, or null when the
   *  marking has been cleared. */
  setDraftSelection: (selection: Uint32Array | null) => void
  setDraftRef: (slot: number, id: number | null) => void
  /** "+ Pick point on scan…" on a construction's point slot: the next click
   *  on the scan fills it. Whatever was in the slot is let go. */
  beginDraftPick: (slot: number) => void
  cancelDraftPick: () => void
  /** The click the slot was waiting for: a picked Point element is created
   *  from it and referenced by the slot. Returns the new element's id. */
  pickDraftPoint: (point: Vec3) => number | null
  setDraftParam: (index: number, value: number) => void
  /** Every number of a construction at once — what a search on the scan
   *  hands back — with a note on how it was got. */
  setDraftParams: (params: number[], note?: string) => void
  /** The draft is waiting on the scan: a centroid being measured, a symmetry
   *  plane being searched for. */
  setDraftWorking: (note?: string) => void
  setDraftSeed: (id: number | null) => void
  /** Extend the open draft's cylinder or plane by one side, in millimetres
   *  past the measured surface. Driven by both the panel's fields and the
   *  handles dragged in the viewport. */
  setDraftExtend: (side: ExtendSide, value: number) => void
  /** Grow the shorter axis of the open plane draft out to the longer one. */
  squareDraftExtend: () => void
  /** Confine the open cylinder draft's fit to its drawn span, or let it take
   *  the whole surface again. The re-fit that follows is the caller's — the
   *  store only records the choice. */
  setDraftFitInside: (on: boolean) => void
  /** Back to exactly the measured surface. The fit-inside choice stands: with
   *  nothing pulled in it takes nothing away. */
  resetDraftExtend: () => void
  /** The assumed diameter of the open draft, in millimetres; undefined
   *  clears it, so the element goes out as measured. Anything that is
   *  not a positive number is ignored — the field snaps back to what stands. */
  setDraftAssumed: (value: number | undefined) => void
  /** Align the open draft's direction to a reference plane, or take the
   *  alignment off again with null. The relation is kept across a change of
   *  plane. */
  setDraftOrientRef: (ref: number | null) => void
  setDraftOrientRelation: (relation: OrientRelation) => void
  resolveDraft: (r: FitOutput) => void
  failDraft: (message: string) => void
  cancelDraft: () => void
  /** The box emptied and the kind kept in hand — same method, same
   *  settings: what Create leaves behind for the next element, and Escape's
   *  first step on a new draft with picks in it. Nothing for an edit. */
  restartDraft: () => void
  /** Put the discarded draft back, with its marking, ready to be measured on
   *  it again — the caller paints the selection back onto the part and asks
   *  for the fit or the search. Does nothing over an open draft. */
  restoreDraft: () => void
  /** Let the discarded draft and its marking go for good. */
  forgetDiscarded: () => void
  commitDraft: () => number | null
  /** Open the box a section is made in: choose the element to cut along and
   *  the offset, watch the cut on the part, create. Closes any other editor. */
  startSection: () => void
  /** Re-open a section on its frozen plane. Changing the offset slides it
   *  along that plane's normal; choosing another element moves it there. */
  editSection: (id: number) => void
  cancelSection: () => void
  /** Take the plane across an element, or across a coordinate axis — the
   *  XY, YZ or XZ plane, moved to pass through the part's centre — or
   *  through an axis at an angle about it. */
  setSectionDraftRef: (ref: SectionPlaneRef | null) => void
  setSectionDraftOffset: (mm: number) => void
  /** The plane turned by hand: the gizmo's rings hand back the line it now
   *  slides along. The reference stays, as the record of what the plane was
   *  taken from and the direction its tilt is read against. */
  setSectionDraftAxis: (axis: CutAxis) => void
  setSectionDraftName: (name: string) => void
  /** Cut or shadow: the same plane, the scan through it or projected onto
   *  it. */
  setSectionDraftKind: (kind: SectionKind) => void
  /** A shadow's play and tolerance (mm) and whether it is extruded; a value
   *  that is not a number is ignored. */
  setSectionDraftShadow: (patch: { play?: number; tolerance?: number; smoothDeg?: number; extrude?: boolean }) => void
  /** The worker's cut for the frame keyed `cutKey`. A cut for a frame the
   *  draft has since moved on from is kept as the preview until the next one
   *  lands, but does not make the draft ready. */
  resolveSectionDraft: (cutKey: string, cut: SectionCut) => void
  failSectionDraft: (message: string) => void
  /** Turn the draft into a section, or write it back over the one being
   *  edited. Returns the section's id, or null if not ready. */
  commitSection: () => number | null
  removeSection: (id: number) => void
  toggleSectionVisible: (id: number) => void
  setAllSectionsVisible: (visible: boolean) => void
  /** A cut taken for a section whose frame is `cutKey` — on project load,
   *  where the frames are saved and the polylines cut again. */
  resolveSection: (id: number, cutKey: string, cut: SectionCut) => void
  failSection: (id: number, message: string) => void
  startAlignment: () => void
  /** Open the alignment editor on a proposal: every slot filled with its
   *  picks — the face the part stands on facing down, X along the second
   *  direction — and `note` saying what the proposal was read from. Nothing
   *  moves until it is applied, and every choice can still be changed. */
  proposeAlignment: (proposal: AlignmentProposal, note: string) => void
  cancelAlignment: () => void
  setAlignmentRef: (slot: AlignSlot, id: number | null) => void
  setAlignmentAxis: (slot: 'primary' | 'secondary', axis: AxisDir) => void
  /** Start filling a slot by clicking points on the scan. */
  beginAlignmentPick: (slot: AlignSlot) => void
  /** A click on the scan while a slot is collecting points, with the surface
   *  normal under it. The slot closes itself once it has enough. */
  addAlignmentPick: (point: Vec3, normal: Vec3) => void
  undoAlignmentPick: () => void
  cancelAlignmentPick: () => void
  /** A click on an element in the viewport while the alignment is being set
   *  up: datums fill primary then secondary, points the origin. Clicking a
   *  chosen element takes it out again. */
  selectAlignmentElement: (id: number) => void
  /** Carry every element (and the coordinate datums among the constructions)
   *  through an applied alignment. The mesh itself is the caller's business. */
  applyAlignment: (m: Rigid) => void
  clearAppliedAlignment: () => void
  startDimension: (type: string) => void
  /** Re-open an existing dimension — same slots, same preview, written back to
   *  the row it came from. */
  editDimension: (id: number) => void
  setDimensionName: (name: string) => void
  setDimensionType: (type: string) => void
  setDimensionRef: (slot: number, id: number | null) => void
  /** A click on an element in the viewport while a dimension is being built:
   *  fills the next slot, switching the dimension type if the element's role
   *  does not fit the current one. Clicking a selected element deselects it. */
  selectDimensionElement: (id: number) => void
  setDimensionAnchor: (anchor: SphereAnchor) => void
  /** The limit the value is held to; undefined takes it off. */
  setDimensionLimit: (limit: Limit | undefined) => void
  /** The basic angle of an angularity. */
  setDimensionBasic: (basic: number | undefined) => void
  beginDimensionPick: (slot: number) => void
  cancelDimension: () => void
  commitDimension: () => void
  removeDimension: (id: number) => void
  toggleDimensionVisible: (id: number) => void
  /** Show or hide every dimension at once — of one family, or of both. */
  setAllDimensionsVisible: (visible: boolean, family?: DimensionFamily) => void
  /** The outlier cut-off of the open draft — and, remembered, of the next new
   *  element. The re-fit that follows is the caller's, like a change of the
   *  fit window: the store only records the choice. */
  setDraftSigma: (k: SigmaPreset) => void
  /** The diameter the open draft's sphere is held at, or none. The draft's
   *  own: the next sphere the box stays on after Create keeps it — a
   *  ballbar's second ball — but it is never the default a new box starts
   *  on. Like the cut-off, the re-fit is the caller's. */
  setDraftKnownDiameter: (mm: number | undefined) => void
  setSelectMode: (mode: SelectMode) => void
  setShowLabels: (v: boolean) => void
  setScanHidden: (v: boolean) => void
  setElementsHidden: (v: boolean) => void
  setShowBackfaces: (v: boolean) => void
  setTranslucent: (v: boolean) => void
  setWireframe: (v: boolean) => void
  setShowScanColors: (v: boolean) => void
  setNavScheme: (id: string) => void
  setProjection: (projection: Projection) => void
  setViewTheme: (id: string) => void
  setStepStyle: (style: StepStyle) => void
  setCloudFormat: (format: CloudFormat) => void
  setCreaseMode: (mode: CreaseMode) => void
  setCreaseAngle: (deg: number) => void
  openImprint: (v: boolean) => void
}

const NAV_SCHEME_KEY = 'scanruler.navscheme'
const VIEW_THEME_KEY = 'scanruler.viewtheme'
const PROJECTION_KEY = 'scanruler.projection'
const STEP_STYLE_KEY = 'scanruler.stepstyle'
const CLOUD_FORMAT_KEY = 'scanruler.cloudformat'
const CREASE_KEY = 'scanruler.crease'
const CREASE_ANGLE_KEY = 'scanruler.creaseangle'

/** Falls back to the built-in default when storage is unavailable (private
 *  mode, blocked cookies) or holds an id that no longer exists. */
const storedNavScheme = (): string => {
  try {
    return schemeById(localStorage.getItem(NAV_SCHEME_KEY)).id
  } catch {
    return SCHEMES[0].id
  }
}

const storedProjection = (): Projection => {
  try {
    return localStorage.getItem(PROJECTION_KEY) === 'perspective' ? 'perspective' : 'orthographic'
  } catch {
    return 'orthographic'
  }
}

const storedViewTheme = (): string => {
  try {
    return themeById(localStorage.getItem(VIEW_THEME_KEY)).id
  } catch {
    return DEFAULT_THEME.id
  }
}

const storedStepStyle = (): StepStyle => {
  try {
    return localStorage.getItem(STEP_STYLE_KEY) === 'surfaces' ? 'surfaces' : 'solids'
  } catch {
    return 'solids'
  }
}

const storedCloudFormat = (): CloudFormat => {
  try {
    return localStorage.getItem(CLOUD_FORMAT_KEY) === 'xyz' ? 'xyz' : 'ply'
  } catch {
    return 'ply'
  }
}

const storedCreaseMode = (): CreaseMode => {
  try {
    const v = localStorage.getItem(CREASE_KEY)
    return v === 'auto' || v === 'off' ? v : 'on'
  } catch {
    return 'on'
  }
}

const storedCreaseAngle = (): number => {
  try {
    return creaseAngleOf(localStorage.getItem(CREASE_ANGLE_KEY))
  } catch {
    return creaseAngleOf(null)
  }
}

/** What belongs to one scan and starts afresh with the next: its elements,
 *  dimensions, alignment and sections, the counters that name them, and the
 *  mesh's size. Element and dimension ids run on across scans. */
function freshScanState() {
  return {
    elements: [],
    draft: null,
    // A marking indexes the vertices of the scan it was made on.
    discarded: null,
    dimensions: [],
    dimDraft: null,
    alignDraft: null,
    // Sections are cuts through this scan and go with it.
    sections: [],
    sectionDraft: null,
    nextSectionNumber: 1,
    appliedAlignment: null,
    nextNumber: 1,
    nextOfKind: freshCounters(),
    nextOfDimGroup: { distance: 1, angle: 1 },
    vertexCount: 0,
    triangleCount: 0,
    scanHidden: false,
    elementsHidden: false,
  } satisfies Partial<AppState>
}

/** The constructions and alignments worked out again over `elements`, the
 *  sections standing in as the planes they were cut on. */
function rebuilt(elements: Element[], s: Pick<AppState, 'modelSize' | 'sections'>): Element[] {
  return reevaluateConstructions(elements, s.modelSize, sectionMeasureRefs(s.sections))
}

/** What deleting `doomed` — elements, and a section if one is among them —
 *  leaves of the rest: constructions built on any of it are in `doomed`
 *  already (dependentsOf); dimensions on it go, slots and alignments on it
 *  empty, and a section cut along a doomed element keeps its plane. */
function withoutRefs(s: AppState, doomed: ReadonlySet<number>): Partial<AppState> {
  const keepRef = (r: number | null) => (r !== null && doomed.has(r) ? null : r)
  const dropOrient = (e: Element): Element =>
    e.orient && doomed.has(e.orient.ref)
      ? { ...e, orient: undefined, fit: e.measured ?? e.fit, measured: undefined }
      : e
  const dropDraftRefs = (d: Draft): Draft => {
    const out = d.orient && doomed.has(d.orient.ref) ? { ...d, orient: undefined } : d
    return out.seed != null && doomed.has(out.seed) ? { ...out, seed: null } : out
  }
  const sections = s.sections.filter((sec) => !doomed.has(sec.id))
  const elements = rebuilt(s.elements.filter((e) => !doomed.has(e.id)).map(dropOrient), { ...s, sections })
  const dimensions = s.dimensions.filter((d) => !d.refs.some((r) => doomed.has(r)))
  const dd = s.dimDraft
  return {
    elements,
    dimensions,
    // A section keeps its frozen plane whatever happens to the element
    // it was cut along; only the name in the record goes.
    sections: sections.map((sec) =>
      doomed.has(sectionRefElement(sec.ref) ?? -1) ? { ...sec, ref: null } : sec,
    ),
    sectionDraft:
      s.sectionDraft?.editId !== undefined && doomed.has(s.sectionDraft.editId)
        ? null
        : s.sectionDraft && doomed.has(sectionRefElement(s.sectionDraft.ref) ?? -1)
          ? { ...s.sectionDraft, ref: null }
          : s.sectionDraft,
    alignDraft: s.alignDraft
      ? {
          ...s.alignDraft,
          primary: keepRef(s.alignDraft.primary),
          secondary: keepRef(s.alignDraft.secondary),
          origin: keepRef(s.alignDraft.origin),
        }
      : null,
    // A dimension open for editing that went with the rest closes.
    dimDraft:
      !dd || (dd.editId !== undefined && !dimensions.some((d) => d.id === dd.editId))
        ? null
        : { ...dd, refs: dd.refs.map((r) => (r !== null && doomed.has(r) ? null : r)) },
    // Deleting the element that is open for editing closes the editor —
    // there is nothing left to write back to.
    draft:
      s.draft?.editId !== undefined && doomed.has(s.draft.editId)
        ? null
        : s.draft && s.draft.refs.some((r) => r !== null && doomed.has(r))
          ? evalConstructDraft(
              dropDraftRefs({
                ...s.draft,
                refs: s.draft.refs.map((r) => (r !== null && doomed.has(r) ? null : r)),
              }),
              dimensionRefsOf(elements, sections),
              s.modelSize,
            )
          : s.draft
            ? dropDraftRefs(s.draft)
            : null,
  }
}

export const useStore = create<AppState>()((set, get) => ({
  projectName: null,
  setProjectName: (name) => set({ projectName: name?.trim() || null }),
  fileName: null,
  ...freshScanState(),
  modelSize: 1,
  modelCenter: [0, 0, 0],
  busy: false,
  working: null,
  statusText: '',
  progress: null,
  errorText: null,
  nextId: 1,
  nextDimensionId: 1,
  settings: { method: 'gaussian', sigma: 3 },
  selectMode: 'auto',
  showLabels: true,
  showBackfaces: true,
  translucent: false,
  wireframe: false,
  scanColors: false,
  showScanColors: true,
  navScheme: storedNavScheme(),
  projection: storedProjection(),
  viewTheme: storedViewTheme(),
  stepStyle: storedStepStyle(),
  cloudFormat: storedCloudFormat(),
  creaseMode: storedCreaseMode(),
  creaseAngle: storedCreaseAngle(),
  imprintOpen: false,

  setStatus: (statusText) => set({ statusText, progress: null }),
  setError: (errorText) => set({ errorText }),
  setWorking: (working) => set({ working }),

  beginLoad: (name) =>
    set({
      busy: true,
      fileName: name,
      statusText: 'Reading file…',
      errorText: null,
      ...freshScanState(),
    }),

  // The brush is sized to the part it will be used on — see markStore, which
  // holds it for both workspaces.
  finishLoad: (vertexCount, triangleCount, modelSize, modelCenter) =>
    set({ busy: false, vertexCount, triangleCount, modelSize, modelCenter }),

  loadFailed: (message) =>
    set({ busy: false, fileName: null, statusText: '', errorText: message }),

  resolveFit: (id, r) =>
    set((s) => ({
      elements: rebuilt(
        s.elements.map((e) =>
          e.id === id
            ? {
                ...e,
                status: 'done' as const,
                fit: withoutRegion(r),
                // An aligned element re-fits onto its measurement; the
                // re-evaluation pass puts the alignment back on top.
                measured: e.orient ? withoutRegion(r) : undefined,
              }
            : e,
        ),
        s,
      ),
    })),

  // A failed re-fit keeps the element's previous result; a failed first fit
  // removes the placeholder entry.
  failFit: (id, message) =>
    set((s) => ({
      errorText: message,
      elements: s.elements.flatMap((e) => {
        if (e.id !== id) return [e]
        return e.fit ? [{ ...e, status: 'done' as const }] : []
      }),
    })),

  // Deleting an element takes every construction built on it along, and every
  // dimension that references anything removed.
  removeElement: (id) => set((s) => withoutRefs(s, dependentsOf(id, s.elements))),

  toggleElementVisible: (id) =>
    set((s) => ({
      elements: s.elements.map((e) => (e.id === id ? { ...e, visible: !e.visible } : e)),
    })),
  setAllElementsVisible: (visible) =>
    set((s) => ({ elements: s.elements.map((e) => (e.visible === visible ? e : { ...e, visible })) })),

  startDraft: (kind) =>
    set((s) => ({
      draft: freshDraft(kind, defaultMethod(kind), s.settings),
      discarded: null,
      dimDraft: null,
      alignDraft: null,
      sectionDraft: null,
      errorText: null,
    })),

  // How the surface of a re-opened fit was chosen comes back with it: an
  // element marked by hand opens with the marking tools out, one grown from a
  // click opens ready to be clicked again.
  editElement: (id) =>
    set((s) => {
      const el = s.elements.find((e) => e.id === id)
      if (!el) return {}
      const draft = draftFromElement(el, dimensionRefsOf(s.elements, s.sections), s.modelSize, s.settings)
      return {
        draft,
        discarded: null,
        selectMode:
          el.source.type === 'picked'
            ? s.selectMode
            : el.source.selection
              ? 'paint'
              : el.source.type === 'fitted' || takesSurface(creationMethod(el.kind, el.source.method))
                ? 'auto'
                : s.selectMode,
        alignDraft: null,
        sectionDraft: null,
        errorText: null,
      }
    }),

  setDraftName: (name) => set((s) => (s.draft ? { draft: { ...s.draft, name } } : {})),

  setDraftMethod: (method) =>
    set((s) => {
      if (!s.draft) return {}
      const { editId, name, settings } = s.draft
      return {
        draft: evalConstructDraft(
          freshDraft(s.draft.kind, method, settings, { editId, name }),
          s.elements,
          s.modelSize,
        ),
      }
    }),

  setDraftPicks: (picks, points) =>
    set((s) => {
      if (!s.draft) return {}
      // Below a method's minimum there is nothing to fit yet — the draft shows
      // its progress rather than a spinner that cannot resolve.
      const min = creationMethod(s.draft.kind, s.draft.method).minPicks ?? 1
      return {
        draft: {
          ...s.draft,
          picks,
          pickPoints: points ?? [],
          fit: undefined,
          message: undefined,
          status: picks.length >= min ? ('fitting' as const) : ('empty' as const),
        },
      }
    }),

  setDraftPickPoints: (points) =>
    set((s) => (s.draft ? { draft: { ...s.draft, pickPoints: points } } : {})),

  setDraftSelection: (selection) =>
    set((s) => {
      if (!s.draft) return {}
      const m = creationMethod(s.draft.kind, s.draft.method)
      // A construction that searches the scan starts over on a new marking:
      // the numbers it found were for a surface that is no longer the one
      // asked about. The centroid measures itself again, the symmetry plane
      // waits to be asked.
      if (m.mode === 'construct') {
        return {
          draft: {
            ...s.draft,
            selection: selection ?? undefined,
            params: m.params.map(() => NaN),
            fit: undefined,
            message: undefined,
            note: selection
              ? `The search is confined to the ${selection.length.toLocaleString('en-US')} marked points.`
              : undefined,
            status: 'empty' as const,
          },
        }
      }
      return {
        draft: {
          ...s.draft,
          selection: selection ?? undefined,
          fit: undefined,
          message: undefined,
          status: selection ? ('fitting' as const) : ('empty' as const),
        },
      }
    }),

  setDraftRef: (slot, id) =>
    set((s) => {
      if (!s.draft) return {}
      // An element cannot be built on itself, nor on anything that is already
      // built on it.
      if (id !== null && blockedRefs(s.draft.editId, s.elements).has(id)) return {}
      const refs = s.draft.refs.map((r, i) => (i === slot ? id : r))
      const draft = evalConstructDraft({ ...s.draft, refs }, dimensionRefsOf(s.elements, s.sections), s.modelSize)
      // A slot filled from the list or by a click on an element hands the
      // pick on to the next empty one, as a click on the scan does.
      const waiting = s.draft.pickSlot
      const pickSlot = waiting != null && refs[waiting] === null ? waiting : nextPointPick(draft)
      return { draft: { ...draft, pickSlot } }
    }),

  beginDraftPick: (slot) =>
    set((s) => {
      if (!s.draft) return {}
      const m = creationMethod(s.draft.kind, s.draft.method)
      if (m.mode !== 'construct' || m.slots[slot]?.role !== 'point') return {}
      const refs = s.draft.refs.map((r, i) => (i === slot ? null : r))
      return {
        draft: { ...evalConstructDraft({ ...s.draft, refs }, dimensionRefsOf(s.elements, s.sections), s.modelSize), pickSlot: slot },
        errorText: null,
      }
    }),

  cancelDraftPick: () =>
    set((s) => (s.draft && s.draft.pickSlot != null ? { draft: { ...s.draft, pickSlot: null } } : {})),

  pickDraftPoint: (point) => {
    const d = get().draft
    if (!d || d.pickSlot == null) return null
    const slot = d.pickSlot
    const fit: PointFit = { kind: 'point', center: point, sigma: 0, usedPoints: 0, regionSize: 0 }
    const id = get().nextId
    const num = get().nextNumber
    const ofKind = get().nextOfKind.point
    set((s) => {
      if (!s.draft) return {}
      const elements = [
        ...s.elements,
        {
          id,
          kind: 'point' as const,
          name: `${elementKindInfo('point').label} ${ofKind}`,
          color: elementColor(num),
          source: { type: 'picked' } as ElementSource,
          status: 'done' as const,
          visible: true,
          fit,
        },
      ]
      const refs = s.draft.refs.map((r, i) => (i === slot ? id : r))
      const draft = evalConstructDraft({ ...s.draft, refs, pickSlot: null }, dimensionRefsOf(elements, s.sections), s.modelSize)
      return {
        nextId: id + 1,
        nextNumber: num + 1,
        nextOfKind: { ...s.nextOfKind, point: ofKind + 1 },
        elements,
        draft: { ...draft, pickSlot: nextPointPick(draft) },
      }
    })
    return id
  },

  setDraftParam: (index, value) =>
    set((s) => {
      if (!s.draft) return {}
      const params = s.draft.params.map((p, i) => (i === index ? value : p))
      return { draft: evalConstructDraft({ ...s.draft, params }, dimensionRefsOf(s.elements, s.sections), s.modelSize) }
    }),

  setDraftParams: (params, note) =>
    set((s) => {
      if (!s.draft) return {}
      return {
        draft: { ...evalConstructDraft({ ...s.draft, params }, dimensionRefsOf(s.elements, s.sections), s.modelSize), note },
      }
    }),

  setDraftWorking: (note) =>
    set((s) =>
      s.draft ? { draft: { ...s.draft, status: 'fitting' as const, message: undefined, note } } : {},
    ),

  setDraftSeed: (id) => set((s) => (s.draft ? { draft: { ...s.draft, seed: id } } : {})),

  setDraftExtend: (side, value) =>
    set((s) => {
      const d = s.draft
      if (!d || !isExtendable(d.fit)) return {}
      const ext = extensionOf(d.fit, d.extend)
      return { draft: { ...d, extend: withSide(d.fit, ext, side, value) } }
    }),

  squareDraftExtend: () =>
    set((s) => {
      const d = s.draft
      if (!d || d.fit?.kind !== 'plane') return {}
      return { draft: { ...d, extend: squareExtension(d.fit, d.extend) } }
    }),

  setDraftFitInside: (on) =>
    set((s) => {
      const d = s.draft
      if (!d || d.fit?.kind !== 'cylinder') return {}
      return { draft: { ...d, extend: withFitInside(extensionOf(d.fit, d.extend), on) } }
    }),

  resetDraftExtend: () =>
    set((s) => {
      const d = s.draft
      if (!d || !isExtendable(d.fit)) return {}
      const zero = zeroExtension(d.fit)
      return { draft: { ...d, extend: withFitInside(zero, fitsInside(d.extend)) } }
    }),

  setDraftAssumed: (value) =>
    set((s) => {
      const d = s.draft
      if (!d || !hasDiameter(d.fit)) return {}
      if (value === undefined) return { draft: { ...d, assumed: undefined } }
      if (!Number.isFinite(value) || value <= 0) return {}
      return { draft: { ...d, assumed: value } }
    }),

  setDraftOrientRef: (ref) =>
    set((s) => {
      const d = s.draft
      if (!d) return {}
      if (ref === null) return { draft: { ...d, orient: undefined } }
      // Only a plane can be aligned to — a coordinate plane, a plane element
      // or a section, and not one that builds on the element being edited:
      // that would close a loop.
      if (!isOrientRef(ref, dimensionRefsOf(s.elements, s.sections)) || blockedRefs(d.editId, s.elements).has(ref)) return {}
      return { draft: { ...d, orient: { ref, relation: d.orient?.relation ?? 'normal' } } }
    }),

  setDraftOrientRelation: (relation) =>
    set((s) => {
      const d = s.draft
      if (!d?.orient) return {}
      return { draft: { ...d, orient: { ...d.orient, relation } } }
    }),

  resolveDraft: (r) =>
    set((s) =>
      s.draft
        ? { draft: { ...s.draft, status: 'ready' as const, fit: withoutRegion(r), message: undefined } }
        : {},
    ),

  // A failed preview keeps the picks so the user can undo the bad one instead
  // of starting over.
  failDraft: (message) =>
    set((s) => (s.draft ? { draft: { ...s.draft, status: 'failed' as const, message } } : {})),

  cancelDraft: () =>
    set((s) => ({
      draft: null,
      discarded: keptOf(s.draft),
      // A pick that was feeding a dimension slot is abandoned with it.
      dimDraft: s.dimDraft ? { ...s.dimDraft, pickSlot: null } : null,
    })),

  restartDraft: () =>
    set((s) =>
      s.draft && s.draft.editId === undefined
        ? { draft: freshDraft(s.draft.kind, s.draft.method, s.draft.settings), errorText: null }
        : {},
    ),

  restoreDraft: () =>
    set((s) => {
      const d = s.discarded
      if (!d || s.draft) return {}
      const alive = (id: number | null | undefined) =>
        id != null && (s.elements.some((e) => e.id === id) || s.sections.some((sec) => sec.id === id))
      // What it was built on may have gone since it was put aside: an edit of
      // an element deleted meanwhile comes back as a new element, a seed
      // plane or reference deleted meanwhile is simply not there any more.
      // The marking is what is being brought back; the numbers are measured
      // on it again by whoever restores it.
      const edit = alive(d.editId) ? { editId: d.editId, name: d.name } : { editId: undefined, name: undefined }
      return {
        draft: {
          ...d,
          ...edit,
          seed: alive(d.seed) || (d.seed != null && d.seed < 0) ? d.seed : null,
          refs: d.refs.map((r) => (alive(r) ? r : null)),
          orient:
            d.orient && (alive(d.orient.ref) || basePlaneOf(d.orient.ref) !== undefined)
              ? d.orient
              : undefined,
          status: 'empty',
          fit: undefined,
          message: undefined,
          note: undefined,
        },
        selectMode: 'paint',
        discarded: null,
        alignDraft: null,
        sectionDraft: null,
        errorText: null,
      }
    }),

  forgetDiscarded: () => set({ discarded: null }),

  commitDraft: () => {
    const d = get().draft
    if (!d || d.status !== 'ready' || !d.fit) return null
    const m = creationMethod(d.kind, d.method)
    // An extension only travels with geometry that can carry it: a draft that
    // ended up producing something else drops whatever was set for the shape
    // it used to be, and one that was never extended carries nothing at all.
    const extend =
      isExtendable(d.fit) && d.extend?.kind === d.fit.kind && isExtended(d.extend)
        ? d.extend
        : undefined
    // The assumed diameter the element goes out with: exactly what was typed,
    // nothing when nothing was. Kinds without a diameter carry nothing.
    const assumed = hasDiameter(d.fit) && d.assumed !== undefined && d.assumed > 0 ? d.assumed : undefined
    // The alignment only travels with geometry that has a direction, and only
    // while its reference plane exists. What gets stored is the measurement
    // plus the recipe; the aligned geometry is computed from the two on the
    // way in, and again whenever the reference moves.
    const orient =
      isOrientable(d.fit) && d.orient && isOrientRef(d.orient.ref, dimensionRefsOf(get().elements, get().sections))
        ? d.orient
        : undefined
    const measured = orient ? d.fit : undefined
    // A fitted element takes the settings its preview was measured with along,
    // so it re-fits the same way on load and re-opens on the same choice.
    const source: ElementSource =
      m.mode === 'fit'
        ? d.selection
          ? { type: 'fitted', seeds: [], selection: d.selection, settings: d.settings }
          : { type: 'fitted', seeds: d.picks.flat(), settings: d.settings }
        : m.mode === 'pick'
          ? { type: 'picked' }
          : {
              type: 'constructed',
              method: d.method,
              refs: d.refs as number[],
              params: d.params,
              // The surface a scan search was confined to goes with the
              // element, so it re-opens marked and searches the same again.
              ...(d.selection && takesSurface(m) ? { selection: d.selection } : {}),
            }
    // An edited element is written back where it stands: same id, same colour,
    // same place in the list, so every dimension and construction on it simply
    // re-reads the new geometry.
    if (d.editId !== undefined) {
      const editId = d.editId
      set((s) => ({
        draft: null,
        elements: rebuilt(
          s.elements.map((e) =>
            e.id === editId
              ? {
                  ...e,
                  name: d.name?.trim() || e.name,
                  source,
                  status: 'done' as const,
                  fit: d.fit,
                  measured,
                  orient,
                  extend,
                  assumed,
                  message: undefined,
                }
              : e,
          ),
          s,
        ),
      }))
      return editId
    }
    const id = get().nextId
    const num = get().nextNumber
    const ofKind = get().nextOfKind[d.kind]
    // The kind stays in hand for the next one, as a sketch tool does, until
    // Cancel or Escape puts it down — one plane is seldom the last. The
    // point picked for a dimension slot is the exception: a one-off, and
    // the box goes back to the dimension.
    const forSlot = get().dimDraft?.pickSlot != null && d.kind === 'point'
    set((s) => ({
      nextId: id + 1,
      nextNumber: num + 1,
      nextOfKind: { ...s.nextOfKind, [d.kind]: ofKind + 1 },
      draft: forSlot ? null : freshDraft(d.kind, d.method, d.settings),
      elements: rebuilt(
        [
          ...s.elements,
          {
            id,
            kind: d.kind,
            name: `${elementKindInfo(d.kind).label} ${ofKind}`,
            color: elementColor(num),
            source,
            status: 'done' as const,
            visible: true,
            fit: d.fit,
            measured,
            orient,
            extend,
            assumed,
          },
        ],
        s,
      ),
      // A point picked for a dimension slot drops straight into it.
      dimDraft:
        s.dimDraft && s.dimDraft.pickSlot !== null && d.kind === 'point'
          ? {
              ...s.dimDraft,
              refs: s.dimDraft.refs.map((r, i) => (i === s.dimDraft!.pickSlot ? id : r)),
              pickSlot: null,
            }
          : s.dimDraft,
    }))
    return id
  },

  startAlignment: () =>
    set((s) => ({
      alignDraft: {
        primary: null,
        primaryPicks: [],
        primaryPickNormals: [],
        // The face the part stands on is the one beginners are told to pick,
        // so "bottom" — outward normal down — is the default reading of it.
        primaryAxis: 'z-',
        secondary: null,
        secondaryPicks: [],
        secondaryAxis: 'x+',
        origin: null,
        originPicks: [],
        pickSlot: null,
      },
      draft: null,
      discarded: keptOf(s.draft),
      dimDraft: null,
      sectionDraft: null,
      errorText: null,
    })),

  proposeAlignment: (proposal, note) =>
    set((s) => ({
      alignDraft: {
        primary: null,
        primaryPicks: proposal.primary,
        primaryPickNormals: proposal.primaryNormals,
        primaryAxis: 'z-',
        secondary: null,
        secondaryPicks: proposal.secondary,
        secondaryAxis: 'x+',
        origin: null,
        originPicks: [proposal.origin],
        pickSlot: null,
        proposal: note,
      },
      draft: null,
      discarded: keptOf(s.draft),
      dimDraft: null,
      sectionDraft: null,
      errorText: null,
    })),

  cancelAlignment: () => set({ alignDraft: null }),

  startSection: () =>
    set((s) => ({
      sectionDraft: { ref: null, offset: 0, axis: null, frame: null, status: 'empty' },
      draft: null,
      discarded: keptOf(s.draft),
      dimDraft: null,
      alignDraft: null,
      errorText: null,
    })),

  // The draft opens on the frozen plane, sliding along its own normal: the
  // element it was cut along may have been re-fitted or deleted since, and
  // opening the editor must not move a section nobody has touched.
  editSection: (id) =>
    set((s) => {
      const sec = s.sections.find((x) => x.id === id)
      if (!sec) return {}
      // A coordinate axis is always there; an element only while it is.
      const refEl = sectionRefElement(sec.ref)
      const refAlive = sec.ref !== null && (refEl === null || s.elements.some((e) => e.id === refEl && e.fit))
      return {
        sectionDraft: settleSectionDraft({
          ref: refAlive ? sec.ref : null,
          offset: sec.offset,
          axis: axisOfFrame(sec.frame, sec.offset),
          refDir: sec.refDir,
          seedU: sec.frame.basisU,
          frame: sec.frame,
          status: 'ready',
          cut: sec.cut,
          cutKey: sec.cutKey,
          editId: sec.id,
          name: sec.name,
          ...specFields(sec),
        }),
        draft: null,
        discarded: keptOf(s.draft),
        dimDraft: null,
        alignDraft: null,
        errorText: null,
      }
    }),

  cancelSection: () => set({ sectionDraft: null }),

  setSectionDraftRef: (ref) =>
    set((s) => {
      const d = s.sectionDraft
      if (!d) return {}
      if (ref === null)
        return { sectionDraft: settleSectionDraft({ ...d, ref: null, axis: null, refDir: undefined }) }
      if (isWorldAxis(ref)) {
        // The coordinate plane is offered where the part is — through its
        // centre — and that is where choosing it puts the plane, gizmo and
        // all: its offset is the centre's coordinate on the axis. Chosen
        // again, it keeps the offset it has: that is how a turned plane is
        // squared up again.
        const c = s.modelCenter
        const axis = worldCutAxis(ref, c)
        const offset =
          d.ref === ref ? d.offset : c[0] * axis.dir[0] + c[1] * axis.dir[1] + c[2] * axis.dir[2]
        return { sectionDraft: settleSectionDraft({ ...d, ref, axis, refDir: axis.dir, offset }) }
      }
      if (isRadialRef(ref)) {
        // A plane through an axis is laid out by the axis alone — its X
        // along the radius, never the one an edited section had, which
        // turned half round would mirror the sheet. Turned about the same
        // axis it keeps its offset; taken about another it goes through it.
        const axis = sectionRefAxis(ref, s.elements, s.modelCenter)
        if (!axis) return {}
        const offset = isRadialRef(d.ref) && d.ref.axis === ref.axis ? d.offset : 0
        return { sectionDraft: settleSectionDraft({ ...d, ref, axis, refDir: axis.dir, offset, seedU: undefined }) }
      }
      const el = s.elements.find((e) => e.id === ref)
      if (!el?.fit || !canCutAlong(el.kind)) return {}
      const axis = cutAxisOf(el.fit)
      if (!axis) return {}
      return { sectionDraft: settleSectionDraft({ ...d, ref, axis, refDir: axis.dir }) }
    }),

  setSectionDraftAxis: (axis) =>
    set((s) => {
      const d = s.sectionDraft
      if (!d || !d.axis) return {}
      return { sectionDraft: settleSectionDraft({ ...d, axis }) }
    }),

  setSectionDraftOffset: (mm) =>
    set((s) => {
      const d = s.sectionDraft
      if (!d || !Number.isFinite(mm)) return {}
      return { sectionDraft: settleSectionDraft({ ...d, offset: mm }) }
    }),

  setSectionDraftName: (name) =>
    set((s) => (s.sectionDraft ? { sectionDraft: { ...s.sectionDraft, name } } : {})),

  setSectionDraftKind: (kind) =>
    set((s) => {
      const d = s.sectionDraft
      if (!d || (d.kind ?? 'cut') === kind) return {}
      // The other kind's cut is no preview of this one.
      return { sectionDraft: settleSectionDraft({ ...d, kind, cut: undefined, cutKey: undefined }) }
    }),

  setSectionDraftShadow: (patch) =>
    set((s) => {
      const d = s.sectionDraft
      if (!d) return {}
      const next = { ...d }
      if (patch.play !== undefined && Number.isFinite(patch.play)) next.play = patch.play
      if (patch.tolerance !== undefined && Number.isFinite(patch.tolerance) && patch.tolerance > 0) next.tolerance = patch.tolerance
      if (patch.smoothDeg !== undefined && Number.isFinite(patch.smoothDeg) && patch.smoothDeg >= 0) next.smoothDeg = Math.min(patch.smoothDeg, 180)
      if (patch.extrude !== undefined) next.extrude = patch.extrude
      return { sectionDraft: settleSectionDraft(next) }
    }),

  resolveSectionDraft: (cutKey, cut) =>
    set((s) => {
      const d = s.sectionDraft
      if (!d) return {}
      // A shadow goes to the middle of the part as it lands.
      return { sectionDraft: centreShadowDraft(settleSectionDraft({ ...d, cut, cutKey })) }
    }),

  failSectionDraft: (message) =>
    set((s) =>
      s.sectionDraft ? { sectionDraft: { ...s.sectionDraft, status: 'failed', message } } : {},
    ),

  commitSection: () => {
    const d = get().sectionDraft
    if (!d || !sectionDraftReady(d) || !d.frame || !d.cut) return null
    const frame = d.frame
    const cut = d.cut
    const cutKey = sectionKeyOf(frame, d)
    if (d.editId !== undefined) {
      const editId = d.editId
      // What is built on the section follows it to its new plane.
      set((s) => {
        const sections = s.sections.map((sec) => {
          if (sec.id !== editId) return sec
          // The kind and its settings are the draft's, a cut's absent.
          const { kind: _kind, play: _play, tolerance: _tolerance, smoothDeg: _smooth, extrude: _extrude, ...rest } = sec
          return {
            ...rest,
            ...specFields(d),
            name: d.name?.trim() || sec.name,
            frame,
            ref: d.ref,
            refDir: d.refDir,
            offset: d.offset,
            cut,
            cutKey,
            message: undefined,
          }
        })
        return { sectionDraft: null, sections, elements: rebuilt(s.elements, { ...s, sections }) }
      })
      return editId
    }
    const id = get().nextId
    const num = get().nextNumber
    const n = get().nextSectionNumber
    set((s) => ({
      nextId: id + 1,
      nextNumber: num + 1,
      nextSectionNumber: n + 1,
      sectionDraft: null,
      sections: [
        ...s.sections,
        {
          id,
          name: `Section ${n}`,
          color: elementColor(num),
          visible: true,
          frame,
          ref: d.ref,
          refDir: d.refDir,
          offset: d.offset,
          ...specFields(d),
          cut,
          cutKey,
        },
      ],
    }))
    return id
  },

  // A dimension taken from the section goes with it, and a construction
  // built on it, as they do with a deleted element.
  removeSection: (id) => set((s) => withoutRefs(s, dependentsOf(id, s.elements))),

  toggleSectionVisible: (id) =>
    set((s) => ({
      sections: s.sections.map((sec) => (sec.id === id ? { ...sec, visible: !sec.visible } : sec)),
    })),
  setAllSectionsVisible: (visible) =>
    set((s) => ({
      sections: s.sections.map((sec) => (sec.visible === visible ? sec : { ...sec, visible })),
    })),

  // The cut says where on its plane the section lies, which is where a
  // construction on it is drawn and measured from — so they follow.
  resolveSection: (id, cutKey, cut) =>
    set((s) => {
      const sections = s.sections.map((sec) =>
        sec.id === id && sectionKeyOf(sec.frame, sec) === cutKey
          ? { ...sec, cut, cutKey, message: undefined }
          : sec,
      )
      return { sections, elements: rebuilt(s.elements, { ...s, sections }) }
    }),

  failSection: (id, message) =>
    set((s) => ({
      sections: s.sections.map((sec) => (sec.id === id ? { ...sec, message } : sec)),
    })),

  setAlignmentRef: (slot, id) =>
    set((s) => (s.alignDraft ? { alignDraft: withSlotRef(s.alignDraft, slot, id) } : {})),

  beginAlignmentPick: (slot) =>
    set((s) =>
      s.alignDraft
        ? { alignDraft: { ...withSlotPicks(s.alignDraft, slot, []), pickSlot: slot } }
        : {},
    ),

  addAlignmentPick: (point, normal) =>
    set((s) => {
      const ad = s.alignDraft
      if (!ad || ad.pickSlot === null) return {}
      const slot = ad.pickSlot
      const picks = [...alignSlotPicks(ad, slot), point]
      const normals = slot === 'primary' ? [...ad.primaryPickNormals, normal] : []
      const full = picks.length >= ALIGN_PICK_COUNT[slot]
      return {
        alignDraft: { ...withSlotPicks(ad, slot, picks, normals), pickSlot: full ? null : slot },
      }
    }),

  undoAlignmentPick: () =>
    set((s) => {
      const ad = s.alignDraft
      if (!ad || ad.pickSlot === null) return {}
      const picks = alignSlotPicks(ad, ad.pickSlot)
      if (picks.length === 0) return {}
      return {
        alignDraft: {
          ...withSlotPicks(
            ad,
            ad.pickSlot,
            picks.slice(0, -1),
            ad.pickSlot === 'primary' ? ad.primaryPickNormals.slice(0, -1) : [],
          ),
          pickSlot: ad.pickSlot,
        },
      }
    }),

  cancelAlignmentPick: () =>
    set((s) => {
      const ad = s.alignDraft
      if (!ad || ad.pickSlot === null) return {}
      return { alignDraft: { ...withSlotPicks(ad, ad.pickSlot, []), pickSlot: null } }
    }),

  setAlignmentAxis: (slot, axis) =>
    set((s) => {
      if (!s.alignDraft) return {}
      if (slot === 'secondary') return { alignDraft: { ...s.alignDraft, secondaryAxis: axis } }
      // The secondary axis dodges out of the way rather than colliding.
      const secondaryAxis =
        axis[0] === s.alignDraft.secondaryAxis[0]
          ? axis[0] === 'z'
            ? ('x+' as AxisDir)
            : ('z+' as AxisDir)
          : s.alignDraft.secondaryAxis
      return { alignDraft: { ...s.alignDraft, primaryAxis: axis, secondaryAxis } }
    }),

  selectAlignmentElement: (id) =>
    set((s) => {
      const ad = s.alignDraft
      if (!ad) return {}
      const el = s.elements.find((e) => e.id === id)
      if (!el?.fit) return {}
      // Clicking a chosen element takes it out of its slot.
      if (ad.primary === id) return { alignDraft: withSlotRef(ad, 'primary', null) }
      if (ad.secondary === id) return { alignDraft: withSlotRef(ad, 'secondary', null) }
      if (ad.origin === id) return { alignDraft: withSlotRef(ad, 'origin', null) }
      const role = roleOf(el.kind)
      if (role === 'point') return { alignDraft: withSlotRef(ad, 'origin', id) }
      // Directions fill the levelling slot first, then the rotation; with both
      // taken the pick replaces the rotation, so the levelling stays put.
      if (ad.primary === null && ad.primaryPicks.length === 0)
        return { alignDraft: withSlotRef(ad, 'primary', id) }
      return { alignDraft: withSlotRef(ad, 'secondary', id) }
    }),

  applyAlignment: (m) =>
    set((s) => {
      const moved = new Float64Array(3)
      rigidApply(m, s.modelCenter[0], s.modelCenter[1], s.modelCenter[2], moved)
      // A section is a cut through the scan: its plane and its polylines move
      // with the part, and nothing has to be cut again.
      const turn = (v: Vec3 | undefined): Vec3 | undefined => {
        if (!v) return v
        const out = new Float64Array(3)
        rigidRotate(m, v[0], v[1], v[2], out)
        return [out[0], out[1], out[2]]
      }
      const moveSection = (sec: Section): Section => {
        const frame = transformFrame(sec.frame, m)
        return {
          ...sec,
          frame,
          refDir: turn(sec.refDir),
          cut: sec.cut ? transformCut(sec.cut, m) : undefined,
          cutKey: sec.cut ? sectionKeyOf(frame, sec) : undefined,
        }
      }
      const moveDraft = (d: SectionDraft): SectionDraft => {
        const frame = d.frame ? transformFrame(d.frame, m) : null
        return settleSectionDraft({
          ...d,
          axis: d.axis ? transformAxis(d.axis, m) : null,
          refDir: turn(d.refDir),
          seedU: turn(d.seedU),
          frame,
          cut: d.cut ? transformCut(d.cut, m) : undefined,
          cutKey: d.cut && frame ? sectionKeyOf(frame, d) : undefined,
        })
      }
      const sections = s.sections.map(moveSection)
      return {
        alignDraft: null,
        appliedAlignment: s.appliedAlignment ? rigidCompose(m, s.appliedAlignment) : m,
        modelCenter: [moved[0], moved[1], moved[2]] as Vec3,
        elements: rebuilt(
          s.elements.map((el) => {
            const out: Element = {
              ...el,
              source: transformSource(el.source, m),
              fit: el.fit ? transformFit(el.fit, m) : el.fit,
              measured: el.measured ? transformFit(el.measured, m) : el.measured,
            }
            if (!out.orient) return out
            // A coordinate plane does not move with the part: the alignment
            // goes to the one its old plane was turned onto, or comes off.
            const ref = refThroughMotion(out.orient.ref, (v) => turn(v)!)
            return ref === null
              ? { ...out, orient: undefined, fit: out.measured ?? out.fit, measured: undefined }
              : { ...out, orient: { ...out.orient, ref } }
          }),
          { ...s, sections },
        ),
        sections,
        sectionDraft: s.sectionDraft ? moveDraft(s.sectionDraft) : null,
      }
    }),

  clearAppliedAlignment: () => set({ appliedAlignment: null }),

  // One thing in hand at a time: a dimension closes the element draft, as
  // an alignment or a section does, so a click in the viewport has one
  // taker — the slot. A marked surface is kept (see `discarded`).
  startDimension: (type) =>
    set((s) => ({
      dimDraft: {
        type,
        refs: dimensionTypeInfo(type).slots.map(() => null),
        anchor: 'center',
        pickSlot: null,
      },
      draft: null,
      discarded: keptOf(s.draft),
      alignDraft: null,
      sectionDraft: null,
    })),

  editDimension: (id) =>
    set((s) => {
      const d = s.dimensions.find((x) => x.id === id)
      if (!d) return {}
      return {
        dimDraft: {
          type: d.type,
          refs: [...d.refs],
          anchor: d.anchor ?? 'center',
          pickSlot: null,
          editId: d.id,
          name: d.name,
          limit: d.limit,
          basic: d.basic,
        },
        draft: null,
        discarded: keptOf(s.draft),
        alignDraft: null,
        sectionDraft: null,
      }
    }),

  setDimensionName: (name) => set((s) => (s.dimDraft ? { dimDraft: { ...s.dimDraft, name } } : {})),

  setDimensionType: (type) =>
    set((s) => {
      if (!s.dimDraft) return {}
      const slots = dimensionTypeInfo(type).slots
      const signature = (t: string) =>
        dimensionTypeInfo(t)
          .slots.map((sl) => `${sl.roles.join('|')}:${(sl.kinds ?? []).join('|')}`)
          .join(',')
      const sameRoles = signature(type) === signature(s.dimDraft.type)
      const sameUnit = dimensionTypeInfo(type).unit === dimensionTypeInfo(s.dimDraft.type).unit
      return {
        dimDraft: {
          ...s.dimDraft,
          type,
          // Keep the picked references when the new type takes the same roles
          // (switching Axis–Axis distance → Axis–Axis angle, say).
          refs: sameRoles ? s.dimDraft.refs : slots.map(() => null),
          // A limit in millimetres means nothing to an angle, and the other
          // way round.
          limit: sameUnit ? s.dimDraft.limit : undefined,
          pickSlot: null,
        },
      }
    }),

  setDimensionRef: (slot, id) =>
    set((s) =>
      s.dimDraft
        ? { dimDraft: { ...s.dimDraft, refs: s.dimDraft.refs.map((r, i) => (i === slot ? id : r)) } }
        : {},
    ),

  selectDimensionElement: (id) =>
    set((s) => {
      const dd = s.dimDraft
      if (!dd) return {}
      const family = dimensionTypeInfo(dd.type).family
      // A section stands in as the plane it was cut on — for a dimension
      // only: a tolerance reads a surface, and a cut has none.
      const pool = family === 'dimension' ? dimensionRefsOf(s.elements, s.sections) : s.elements
      const el = pool.find((e) => e.id === id)
      if (!el?.fit) return {}
      // Clicking an element that is already a reference takes it out again.
      if (dd.refs.includes(id)) {
        return { dimDraft: { ...dd, refs: dd.refs.map((r) => (r === id ? null : r)) } }
      }
      // What is already selected, in slot order — plus the new element. The
      // pick joins the selection while some type of the family can seat them
      // all (a second plane after a flatness makes a parallelism); otherwise
      // it replaces the last pick, so the first reference stays the anchor
      // of the measurement.
      const held = dd.refs.flatMap((r) => {
        const ref = r !== null ? pool.find((e) => e.id === r) : undefined
        return ref ? [{ id: ref.id, kind: ref.kind }] : []
      })
      const pick = { id, kind: el.kind }
      const grown = [...held, pick]
      const selected = selectionFits(
        family,
        grown.map((sel) => sel.kind),
      )
        ? grown
        : [...held.slice(0, -1), pick]
      const type = resolveDimensionType(dd.type, selected.map((sel) => sel.kind))
      return {
        dimDraft: { ...dd, type, refs: assignDimensionRefs(type, selected), pickSlot: null },
      }
    }),

  setDimensionAnchor: (anchor) =>
    set((s) => (s.dimDraft ? { dimDraft: { ...s.dimDraft, anchor } } : {})),

  setDimensionLimit: (limit) =>
    set((s) => (s.dimDraft ? { dimDraft: { ...s.dimDraft, limit } } : {})),

  setDimensionBasic: (basic) =>
    set((s) => (s.dimDraft ? { dimDraft: { ...s.dimDraft, basic } } : {})),

  beginDimensionPick: (slot) =>
    set((s) =>
      s.dimDraft
        ? {
            dimDraft: { ...s.dimDraft, pickSlot: slot },
            draft: freshDraft('point', 'pick', s.settings),
            discarded: keptOf(s.draft),
            errorText: null,
          }
        : {},
    ),

  cancelDimension: () => set({ dimDraft: null }),

  commitDimension: () =>
    set((s) => {
      const dd = s.dimDraft
      if (!dd || dd.refs.some((r) => r === null)) return {}
      const info = dimensionTypeInfo(dd.type)
      const key = stemKey(info)
      const n = s.nextOfDimGroup[key] ?? 1
      if (dd.editId !== undefined) {
        const old = s.dimensions.find((d) => d.id === dd.editId)
        const typed = dd.name?.trim()
        // A distance turned into an angle is no longer "Distance 2": unless it
        // was renamed by hand it takes the next name of the kind it has
        // become.
        const renamed = Boolean(typed) && typed !== old?.name
        const regroup =
          !renamed && old !== undefined && stemKey(dimensionTypeInfo(old.type)) !== key
        const name = regroup ? `${info.stem} ${n}` : typed || (old?.name ?? '')
        return {
          dimensions: s.dimensions.map((d) =>
            d.id === dd.editId
              ? {
                  ...d,
                  type: dd.type,
                  refs: dd.refs as number[],
                  anchor: dd.anchor,
                  name,
                  limit: dd.limit,
                  basic: dd.basic,
                }
              : d,
          ),
          nextOfDimGroup: regroup ? { ...s.nextOfDimGroup, [key]: n + 1 } : s.nextOfDimGroup,
          dimDraft: null,
        }
      }
      return {
        dimensions: [
          ...s.dimensions,
          {
            id: s.nextDimensionId,
            type: dd.type,
            name: `${info.stem} ${n}`,
            refs: dd.refs as number[],
            anchor: dd.anchor,
            visible: true,
            limit: dd.limit,
            basic: dd.basic,
          },
        ],
        nextDimensionId: s.nextDimensionId + 1,
        nextOfDimGroup: { ...s.nextOfDimGroup, [key]: n + 1 },
        // The box stays open for the next one of the same type, its slots
        // empty — the way the sketch's Dimension tool stays in hand — until
        // Cancel or Escape closes it.
        dimDraft: { type: dd.type, refs: info.slots.map(() => null), anchor: 'center', pickSlot: null },
      }
    }),

  removeDimension: (id) =>
    set((s) => ({
      dimensions: s.dimensions.filter((d) => d.id !== id),
      dimDraft: s.dimDraft?.editId === id ? null : s.dimDraft,
    })),

  toggleDimensionVisible: (id) =>
    set((s) => ({
      dimensions: s.dimensions.map((d) =>
        d.id === id ? { ...d, visible: d.visible === false } : d,
      ),
    })),
  setAllDimensionsVisible: (visible, family) =>
    set((s) => ({
      dimensions: s.dimensions.map((d) =>
        family === undefined || dimensionTypeInfo(d.type).family === family ? { ...d, visible } : d,
      ),
    })),

  setDraftSigma: (sigma) =>
    set((s) => {
      const settings = { ...(s.draft?.settings ?? s.settings), sigma }
      const { knownDiameter: _known, ...remembered } = settings
      return { settings: remembered, draft: s.draft ? { ...s.draft, settings } : null }
    }),
  setDraftKnownDiameter: (mm) =>
    set((s) => {
      if (!s.draft) return {}
      const { knownDiameter: _known, ...rest } = s.draft.settings
      const settings = mm !== undefined && Number.isFinite(mm) && mm > 0 ? { ...rest, knownDiameter: mm } : rest
      return { draft: { ...s.draft, settings } }
    }),
  setSelectMode: (selectMode) => set({ selectMode }),
  setShowLabels: (showLabels) => set({ showLabels }),
  setScanHidden: (scanHidden) => set({ scanHidden }),
  setElementsHidden: (elementsHidden) => set({ elementsHidden }),
  setShowBackfaces: (showBackfaces) => set({ showBackfaces }),
  setTranslucent: (translucent) => set({ translucent }),
  setWireframe: (wireframe) => set({ wireframe }),
  setShowScanColors: (showScanColors) => set({ showScanColors }),
  setNavScheme: (navScheme) => {
    try {
      localStorage.setItem(NAV_SCHEME_KEY, navScheme)
    } catch {
      // Not being able to remember the choice is no reason to refuse it.
    }
    set({ navScheme })
  },
  setProjection: (projection) => {
    try {
      localStorage.setItem(PROJECTION_KEY, projection)
    } catch {
      // Not being able to remember the choice is no reason to refuse it.
    }
    set({ projection })
  },
  setViewTheme: (viewTheme) => {
    try {
      localStorage.setItem(VIEW_THEME_KEY, viewTheme)
    } catch {
      // Same as above: the stage still changes for this session.
    }
    set({ viewTheme })
  },
  setStepStyle: (stepStyle) => {
    try {
      localStorage.setItem(STEP_STYLE_KEY, stepStyle)
    } catch {
      // Same as above: the export still goes out in the form that was asked for.
    }
    set({ stepStyle })
  },
  setCloudFormat: (cloudFormat) => {
    try {
      localStorage.setItem(CLOUD_FORMAT_KEY, cloudFormat)
    } catch {
      // Same as above: the export still goes out in the form that was asked for.
    }
    set({ cloudFormat })
  },
  setCreaseMode: (creaseMode) => {
    try {
      localStorage.setItem(CREASE_KEY, creaseMode)
    } catch {
      // Same as above: the scan is still redrawn as asked for this session.
    }
    set({ creaseMode })
  },
  setCreaseAngle: (deg) => {
    const creaseAngle = creaseAngleOf(deg)
    try {
      localStorage.setItem(CREASE_ANGLE_KEY, String(creaseAngle))
    } catch {
      // Same as above: the scan is still redrawn as asked for this session.
    }
    set({ creaseAngle })
  },
  openImprint: (imprintOpen) => set({ imprintOpen }),
}))

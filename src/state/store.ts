// SPDX-License-Identifier: AGPL-3.0-only
import { create } from 'zustand'
import { elementKindInfo } from '../core/elements/kinds'
import {
  ConstructionError,
  creationMethod,
  evaluateConstruction,
} from '../core/elements/construct'
import type { Dimension, SphereAnchor } from '../core/dimensions'
import {
  assignDimensionRefs,
  dimensionTypeInfo,
  resolveDimensionType,
} from '../core/dimensions'
import { roleOf } from '../core/elements/refs'
import {
  extensionOf,
  isExtendable,
  isExtended,
  squareExtension,
  withSide,
  zeroExtension,
  type ExtendSide,
  type Extension,
} from '../core/elements/extend'
import { hasDiameter } from '../core/elements/assumed'
import {
  isOrientable,
  OrientError,
  orientFit,
  type Orient,
  type OrientRelation,
} from '../core/elements/orient'
import {
  ALIGN_PICK_COUNT,
  AlignmentError,
  computeDatumAlignment,
  describeRigid,
  fitFromAlignPicks,
  transformFit,
  translationToOrigin,
  type AlignSlot,
  type AxisDir,
} from '../core/alignment'
import { rigidApply, rigidCompose, type Rigid } from '../core/deviation/rigid'
import { PALETTE } from './palette'
import { SCHEMES, schemeById } from '../viewer/navSchemes'
import { DEFAULT_THEME, themeById } from '../viewer/viewThemes'
import type { StepStyle } from '../core/exportStep'
import type {
  ElementKind,
  ElementSource,
  FitData,
  FitOutput,
  FitSettings,
  SigmaPreset,
  Vec3,
} from '../core/types'

/** Colour of the nth element (1-based). Used for the element itself and, while
 *  it is still a draft, for the surfaces picked for it. */
export function elementColor(num: number): string {
  return PALETTE[(num - 1) % PALETTE.length]
}

export interface Element {
  id: number
  kind: ElementKind
  name: string
  color: string
  /** How to rebuild it: seeds for fitted elements, references and parameters
   *  for constructed ones. */
  source: ElementSource
  status: 'fitting' | 'done'
  /** Shown in the viewport. A hidden element keeps measuring — only its
   *  overlay and surface tint go away. */
  visible: boolean
  fit?: FitData
  /** How far past the measured surface a cylinder or a plane is drawn and
   *  exported. Kept beside the fit rather than in it, so what is reported
   *  stays what was measured — see core/elements/extend. */
  extend?: Extension
  /** The diameter the feature is assumed to have been designed at, for the
   *  kinds that have one (sphere, cylinder, circle). Kept beside the fit like
   *  an extension and written out only by the assumed-dimension STEP export —
   *  see core/elements/assumed. */
  assumed?: number
  /** The reference plane this element takes its direction from, if any —
   *  see core/elements/orient. `fit` is then the aligned geometry, and
   *  `measured` keeps the fit as it came off the scan (or out of the
   *  construction), for re-applying the alignment and for the record. */
  orient?: Orient
  measured?: FitData
  /** Why a constructed element currently has no geometry (a re-evaluated
   *  construction can go degenerate, e.g. planes turning parallel). */
  message?: string
}

/** An element in the making. Fit/pick methods collect picked surface points;
 *  construct methods collect element references and typed-in numbers. Nothing
 *  is measured until it is confirmed. */
export interface Draft {
  kind: ElementKind
  /** Creation method id — see CREATION_METHODS. */
  method: string
  picks: [number, number, number][]
  /** The exact raycast hit of each pick, for the pick-mode methods that fit
   *  geometry through several of them (a circle). The vertex triples above
   *  stay the durable record; these are draft-lifetime working data. */
  pickPoints: Vec3[]
  /** The surface marked by hand, when the fit came from the brush rather than
   *  from a click. Carried into the element so a change of outlier cut-off
   *  re-fits on exactly the same points. */
  selection?: Uint32Array
  refs: (number | null)[]
  params: number[]
  status: 'empty' | 'fitting' | 'ready' | 'failed'
  fit?: FitData
  /** The extension being set up with the geometry: a re-opened element brings
   *  its own along, and a re-fit inside the draft leaves it standing, so
   *  changing the outlier cut-off never quietly resizes what is on screen. */
  extend?: Extension
  /** The assumed diameter as typed. Undefined means none was given — the
   *  element then goes out as measured. */
  assumed?: number
  /** The reference plane the draft aligns its direction to, once one is
   *  chosen. The draft's `fit` stays the measurement; the aligned geometry is
   *  derived from the two — see orientedDraft. */
  orient?: Orient
  message?: string
  /** Set when the draft re-opens an element that already exists: the id it
   *  writes back to on confirm, instead of adding a new element. Everything
   *  measured against it — dimensions, constructions — keeps pointing at the
   *  same element and simply re-reads the new geometry. */
  editId?: number
  /** The element's name while it is open for editing, so it can be changed
   *  along with the geometry. */
  name?: string
}

/** How the surface a fit is measured on gets chosen: click a point and let the
 *  tool find the feature, or mark the surface by hand. A tool setting rather
 *  than a property of one element, because it is a way of working — whoever
 *  paints one cylinder will paint the next one too. */
export type SelectMode = 'auto' | 'paint'

/** The 3-2-1 alignment being set up: per slot either an existing element or
 *  points picked straight on the scan (3 span the levelling plane, 2 the
 *  rotation line, 1 the origin), plus the global axis each direction becomes.
 *  Nothing moves until it is applied. */
export interface AlignDraft {
  primary: number | null
  primaryPicks: Vec3[]
  /** Surface normal at each primary pick, so the levelling plane knows which
   *  side of it is outside the part — see fitFromAlignPicks. */
  primaryPickNormals: Vec3[]
  primaryAxis: AxisDir
  secondary: number | null
  secondaryPicks: Vec3[]
  secondaryAxis: AxisDir
  origin: number | null
  originPicks: Vec3[]
  /** The slot currently collecting clicks on the scan, or null. */
  pickSlot: AlignSlot | null
}

export type { AlignSlot }

export function alignSlotPicks(ad: AlignDraft, slot: AlignSlot): Vec3[] {
  return slot === 'primary' ? ad.primaryPicks : slot === 'secondary' ? ad.secondaryPicks : ad.originPicks
}

/** The point a datum alignment centres on the origin, or null for none: only
 *  the *first* alignment centres, because a part fresh from the scanner sits
 *  at an arbitrary offset nobody wants to keep — while a part that has already
 *  been aligned or moved is exactly where its user put it. */
export function alignCenterOf(s: {
  appliedAlignment: Rigid | null
  modelCenter: Vec3
}): Vec3 | null {
  return s.appliedAlignment === null ? s.modelCenter : null
}

/** What an alignment draft would do to the part right now: the transform and
 *  how far it moves, or why it cannot be computed yet. Read by the panel for
 *  its preview numbers and by the viewport for the live preview, so the two
 *  can never disagree. Null with no error means the levelling slot is still
 *  empty — there is nothing to say yet. */
export interface AlignPreview {
  rigid: Rigid
  rotationDeg: number
  translation: number
}

export function alignmentPreview(
  ad: AlignDraft,
  elements: Element[],
  modelSize: number,
  centerOf: Vec3 | null = null,
): { preview: AlignPreview | null; error: string | null } {
  const slotFit = (slot: AlignSlot, ref: number | null): FitData | null => {
    if (ref !== null) return elements.find((e) => e.id === ref)?.fit ?? null
    return fitFromAlignPicks(
      slot,
      alignSlotPicks(ad, slot),
      modelSize,
      slot === 'primary' ? ad.primaryPickNormals : undefined,
    )
  }
  try {
    const primary = slotFit('primary', ad.primary)
    if (!primary) {
      // A zero point on its own is a valid alignment: the part keeps its
      // orientation and that point becomes 0, 0, 0.
      const origin = slotFit('origin', ad.origin)
      if (!origin) return { preview: null, error: null }
      const rigid = translationToOrigin(origin.center)
      return { preview: { rigid, ...describeRigid(rigid) }, error: null }
    }
    const secondary = slotFit('secondary', ad.secondary)
    const origin = slotFit('origin', ad.origin)
    const rigid = computeDatumAlignment(
      { fit: primary, axis: ad.primaryAxis },
      secondary ? { fit: secondary, axis: ad.secondaryAxis } : null,
      origin,
      centerOf,
    )
    return { preview: { rigid, ...describeRigid(rigid) }, error: null }
  } catch (e) {
    return {
      preview: null,
      error: e instanceof AlignmentError ? e.message : 'Alignment failed.',
    }
  }
}

/** The slot with the given element reference and its picks discarded — the
 *  two ways of filling a slot are exclusive. */
function withSlotRef(ad: AlignDraft, slot: AlignSlot, id: number | null): AlignDraft {
  const base = { ...ad, pickSlot: ad.pickSlot === slot ? null : ad.pickSlot }
  if (slot === 'primary')
    return { ...base, primary: id, primaryPicks: [], primaryPickNormals: [] }
  if (slot === 'secondary') return { ...base, secondary: id, secondaryPicks: [] }
  return { ...base, origin: id, originPicks: [] }
}

function withSlotPicks(
  ad: AlignDraft,
  slot: AlignSlot,
  picks: Vec3[],
  normals: Vec3[] = [],
): AlignDraft {
  if (slot === 'primary')
    return { ...ad, primary: null, primaryPicks: picks, primaryPickNormals: normals }
  if (slot === 'secondary') return { ...ad, secondary: null, secondaryPicks: picks }
  return { ...ad, origin: null, originPicks: picks }
}

/** A dimension in the making. pickSlot marks a point slot waiting for a
 *  point element to be created by picking on the scan. */
export interface DimensionDraft {
  type: string
  refs: (number | null)[]
  anchor: SphereAnchor
  pickSlot: number | null
  /** Set when an existing dimension was re-opened: the id it writes back to. */
  editId?: number
  /** Its name while it is open, so it can be changed with the rest of it. */
  name?: string
}

/** The region is a large typed array only the scene needs, so it is stripped
 *  before a fit goes into the store. */
function withoutRegion(r: FitOutput): FitData {
  const { region: _region, ...fit } = r
  return fit
}

function freshDraft(kind: ElementKind, method: string, edit?: Pick<Draft, 'editId' | 'name'>): Draft {
  const m = creationMethod(kind, method)
  return {
    kind,
    method,
    picks: [],
    pickPoints: [],
    refs: m.slots.map(() => null),
    params: m.params.map(() => NaN),
    status: 'empty',
    ...edit,
  }
}

/** The pick-mode method of a kind — the one a picked element re-opens on. */
function pickMethodOf(kind: ElementKind): string {
  return kind === 'circle' ? 'circle-points' : 'pick'
}

/** The creation method an existing element was made with — the one its draft
 *  re-opens on. */
function methodOf(el: Element): string {
  if (el.source.type === 'constructed') return el.source.method
  return el.source.type === 'picked' ? pickMethodOf(el.kind) : 'fit'
}

/** Re-open an element as a draft: everything it was built from, ready to be
 *  changed. A fitted element comes back with the seeds or the hand-marked
 *  surface it was measured on, so the caller can put both back on the scan;
 *  a construction comes back with its references and numbers, re-evaluated so
 *  the preview stands before anything is touched. */
function draftFromElement(el: Element, elements: Element[], modelSize: number): Draft {
  const base: Draft = {
    kind: el.kind,
    method: methodOf(el),
    picks: [],
    pickPoints: [],
    refs: [],
    params: [],
    status: el.fit ? 'ready' : 'empty',
    // The draft works on the measurement; the alignment is put back on top
    // of it the same way it was the first time.
    fit: el.measured ?? el.fit,
    extend: el.extend,
    assumed: el.assumed,
    orient: el.orient,
    editId: el.id,
    name: el.name,
  }
  if (el.source.type === 'constructed') {
    return evalConstructDraft(
      { ...base, refs: [...el.source.refs], params: [...el.source.params] },
      elements,
      modelSize,
    )
  }
  if (el.source.type === 'picked') return base
  const { seeds, selection } = el.source
  const picks: [number, number, number][] = []
  for (let i = 0; i + 2 < seeds.length; i += 3) picks.push([seeds[i], seeds[i + 1], seeds[i + 2]])
  return { ...base, picks, selection }
}

/** Elements an edited element must not be built on: itself, and everything
 *  that already builds on it — either would close a loop. Empty for a draft
 *  that is making a new element, which nothing can depend on yet. */
export function blockedRefs(editId: number | undefined, elements: Element[]): Set<number> {
  return editId === undefined ? new Set() : dependentsOf(editId, elements, true)
}

/** The colour the open draft is drawn in: an edited element keeps its own, a
 *  new one takes the next in the palette. */
export function draftColorOf(s: {
  draft: Draft | null
  elements: Element[]
  nextNumber: number
}): string {
  const id = s.draft?.editId
  const el = id === undefined ? undefined : s.elements.find((e) => e.id === id)
  return el?.color ?? elementColor(s.nextNumber)
}

/** Default creation method per kind: the one that touches the scan. */
function defaultMethod(kind: ElementKind): string {
  if (kind === 'point') return 'pick'
  if (kind === 'line') return 'line-two-points'
  if (kind === 'circle') return 'circle-points'
  return 'fit'
}

/** What the open draft would create: its measured fit turned onto the
 *  reference plane it is aligned to, or the fit as it stands. Derived rather
 *  than stored, so the measurement under it is never overwritten — and so the
 *  viewport ghost, the panel and the commit cannot disagree. */
export function orientedDraft(
  d: Pick<Draft, 'fit' | 'orient'> | null,
  elements: Element[],
): { fit: FitData | undefined; deviationDeg: number; warning: string | null } {
  if (!d?.fit) return { fit: undefined, deviationDeg: 0, warning: null }
  if (!d.orient || !isOrientable(d.fit)) return { fit: d.fit, deviationDeg: 0, warning: null }
  const ref = elements.find((e) => e.id === d.orient!.ref)?.fit
  if (ref?.kind !== 'plane') {
    return { fit: d.fit, deviationDeg: 0, warning: 'The reference plane is unavailable.' }
  }
  try {
    return orientFit(d.fit, ref, d.orient.relation)
  } catch (e) {
    return {
      fit: d.fit,
      deviationDeg: 0,
      warning: e instanceof OrientError ? e.message : 'Alignment failed.',
    }
  }
}

/** An element's geometry with its alignment (re)applied to its measured fit,
 *  given the current geometry of every element. An alignment that can no
 *  longer be computed leaves the element on its measurement. */
function orientElement(el: Element, byId: ReadonlyMap<number, FitData>): Element {
  if (!el.orient) return el
  const measured = el.measured ?? el.fit
  if (!measured) return el
  const ref = byId.get(el.orient.ref)
  let fit = measured
  if (ref?.kind === 'plane' && isOrientable(measured)) {
    try {
      fit = orientFit(measured, ref, el.orient.relation).fit
    } catch {
      fit = measured
    }
  }
  return el.fit && sameFit(el.fit, fit) && el.measured === measured
    ? el
    : { ...el, fit, measured }
}

/** Recompute a construct-mode draft's preview from the current elements.
 *  Pure math, so the preview is always in step with its inputs. */
function evalConstructDraft(d: Draft, elements: Element[], modelSize: number): Draft {
  const m = creationMethod(d.kind, d.method)
  if (m.mode !== 'construct') return d
  if (d.refs.some((r) => r === null) || d.params.some((p) => !Number.isFinite(p))) {
    return { ...d, status: 'empty', fit: undefined, message: undefined }
  }
  const fits: FitData[] = []
  for (const id of d.refs) {
    const el = elements.find((e) => e.id === id)
    if (!el?.fit) return { ...d, status: 'failed', fit: undefined, message: 'A reference is unavailable.' }
    fits.push(el.fit)
  }
  try {
    const fit = evaluateConstruction(d.method, fits, d.params, modelSize)
    return { ...d, status: 'ready', fit, message: undefined }
  } catch (e) {
    return {
      ...d,
      status: 'failed',
      fit: undefined,
      message: e instanceof ConstructionError ? e.message : 'Construction failed.',
    }
  }
}

/** Re-evaluate every constructed element from its sources, in creation order
 *  (constructions can only reference older elements, so one pass settles the
 *  whole chain). Called after anything that changes a geometry. */
function reevaluateConstructions(elements: Element[], modelSize: number): Element[] {
  // Alignments may point at planes anywhere in the list, so the current
  // geometry of everything is on hand before the pass; constructions and
  // alignments that are recomputed overwrite their entry as they go.
  const byId = new Map<number, FitData>()
  for (const el of elements) if (el.fit) byId.set(el.id, el.fit)
  const settle = (el: Element): Element => {
    const out = orientElement(el, byId)
    if (out.fit) byId.set(out.id, out.fit)
    return out
  }
  return elements.map((el) => {
    if (el.source.type !== 'constructed') return settle(el)
    const { method, refs, params } = el.source
    const fits: FitData[] = []
    for (const id of refs) {
      const f = byId.get(id)
      if (f) fits.push(f)
    }
    if (fits.length !== refs.length) {
      byId.delete(el.id)
      return { ...el, fit: undefined, measured: undefined, message: 'A source element is unavailable.' }
    }
    try {
      const fit = evaluateConstruction(method, fits, params, modelSize)
      // A construction's measured geometry is what it evaluates to; the
      // alignment goes on top of that.
      const measured = el.orient ? fit : undefined
      const next =
        el.fit && !el.orient && sameFit(el.fit, fit) ? el : { ...el, fit, measured, message: undefined }
      return settle(next)
    } catch (e) {
      byId.delete(el.id)
      return {
        ...el,
        fit: undefined,
        measured: undefined,
        message: e instanceof ConstructionError ? e.message : 'Construction failed.',
      }
    }
  })
}

/** Cheap identity check so untouched constructions keep their object and the
 *  UI does not re-render every element on every fit. */
function sameFit(a: FitData, b: FitData): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Carry an element's rebuild recipe through a rigid motion. Only typed-in
 *  coordinates hold positions of their own — everything else is either mesh
 *  vertex indices (which do not change when the vertices move) or references
 *  to other elements. */
function transformSource(source: ElementSource, m: Rigid): ElementSource {
  if (source.type !== 'constructed') return source
  if (source.method === 'point-coords') {
    const p = transformFit(
      { kind: 'point', center: source.params.slice(0, 3) as Vec3, sigma: 0, usedPoints: 0, regionSize: 0 },
      m,
    )
    return { ...source, params: [...p.center] }
  }
  if (source.method === 'plane-coords') {
    const [nx, ny, nz, px, py, pz] = source.params
    const moved = transformFit(
      { kind: 'line', center: [px, py, pz], dir: [nx, ny, nz], length: 0, sigma: 0, usedPoints: 0, regionSize: 0 },
      m,
    )
    if (moved.kind !== 'line') return source
    return { ...source, params: [...moved.dir, ...moved.center] }
  }
  if (source.method === 'circle-coords') {
    const [d, nx, ny, nz, cx, cy, cz] = source.params
    const moved = transformFit(
      { kind: 'line', center: [cx, cy, cz], dir: [nx, ny, nz], length: 0, sigma: 0, usedPoints: 0, regionSize: 0 },
      m,
    )
    if (moved.kind !== 'line') return source
    return { ...source, params: [d, ...moved.dir, ...moved.center] }
  }
  return source
}

/** All elements that (transitively) build on the given one. Being aligned to
 *  an element counts as building on it when `withOrient` is set — for loop
 *  checks, where it must; not for deletion, where an aligned element simply
 *  falls back to its measurement. */
function dependentsOf(id: number, elements: Element[], withOrient = false): Set<number> {
  const doomed = new Set<number>([id])
  let grew = true
  while (grew) {
    grew = false
    for (const el of elements) {
      if (doomed.has(el.id)) continue
      const built = el.source.type === 'constructed' && el.source.refs.some((r) => doomed.has(r))
      const aligned = withOrient && el.orient !== undefined && doomed.has(el.orient.ref)
      if (built || aligned) {
        doomed.add(el.id)
        grew = true
      }
    }
  }
  return doomed
}

interface AppState {
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
  statusText: string
  errorText: string | null
  elements: Element[]
  draft: Draft | null
  dimensions: Dimension[]
  dimDraft: DimensionDraft | null
  alignDraft: AlignDraft | null
  /** Cumulative datum alignment already baked into the scan — inverted to
   *  put the part back where the scanner delivered it. */
  appliedAlignment: Rigid | null
  nextId: number
  nextNumber: number
  /** Per-kind counters, so elements are named "Sphere 1", "Plane 1", … */
  nextOfKind: Record<ElementKind, number>
  nextDimensionId: number
  nextOfDimGroup: Record<'distance' | 'angle', number>
  settings: FitSettings
  /** Where a fit gets its surface from — see SelectMode. Marking one by hand
   *  uses the shared tools in markStore, the same ones the deviation
   *  workspace's local fine fit is marked with. */
  selectMode: SelectMode
  showOverlays: boolean
  /** Colour the far side of every triangle differently, so holes and inverted
   *  normals stop reading as solid part. */
  showBackfaces: boolean
  /** Id of the mouse navigation scheme (see viewer/navSchemes). Remembered per
   *  browser, because which buttons orbit is a habit from whichever CAD the
   *  user came from, not a property of the part on screen. */
  navScheme: string
  /** Id of the viewport colour scheme (see viewer/viewThemes). Remembered per
   *  browser for the same reason as the navigation: which stage a part is
   *  easiest to read on is the operator's preference, not the part's. */
  viewTheme: string
  /** Which form the STEP export is written in. Remembered per browser, like
   *  the navigation scheme: whether measured elements should reach CAD as
   *  bodies or as construction geometry is a property of how the user works,
   *  not of the part on screen. */
  stepStyle: StepStyle
  /** Imprint & privacy dialog, opened from the status strip. */
  imprintOpen: boolean

  setStatus: (text: string) => void
  setError: (text: string | null) => void
  beginLoad: (name: string) => void
  finishLoad: (
    vertexCount: number,
    triangleCount: number,
    modelSize: number,
    modelCenter: Vec3,
  ) => void
  loadFailed: (message: string) => void
  markFitting: (id: number, seeds: number[], selection?: Uint32Array) => void
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
  /** The hand-marked surface a draft's fit is running on, or null when the
   *  marking has been cleared. */
  setDraftSelection: (selection: Uint32Array | null) => void
  setDraftRef: (slot: number, id: number | null) => void
  setDraftParam: (index: number, value: number) => void
  /** Extend the open draft's cylinder or plane by one side, in millimetres
   *  past the measured surface. Driven by both the panel's fields and the
   *  handles dragged in the viewport. */
  setDraftExtend: (side: ExtendSide, value: number) => void
  /** Grow the shorter axis of the open plane draft out to the longer one. */
  squareDraftExtend: () => void
  /** Back to exactly the measured surface. */
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
  commitDraft: () => number | null
  startAlignment: () => void
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
  beginDimensionPick: (slot: number) => void
  cancelDimension: () => void
  commitDimension: () => void
  removeDimension: (id: number) => void
  toggleDimensionVisible: (id: number) => void
  /** Show or hide every dimension at once. */
  setAllDimensionsVisible: (visible: boolean) => void
  setSigma: (k: SigmaPreset) => void
  setSelectMode: (mode: SelectMode) => void
  setShowOverlays: (v: boolean) => void
  setShowBackfaces: (v: boolean) => void
  setNavScheme: (id: string) => void
  setViewTheme: (id: string) => void
  setStepStyle: (style: StepStyle) => void
  openImprint: (v: boolean) => void
}

const NAV_SCHEME_KEY = 'scanruler.navscheme'
const VIEW_THEME_KEY = 'scanruler.viewtheme'
const STEP_STYLE_KEY = 'scanruler.stepstyle'

/** Falls back to the built-in default when storage is unavailable (private
 *  mode, blocked cookies) or holds an id that no longer exists. */
const storedNavScheme = (): string => {
  try {
    return schemeById(localStorage.getItem(NAV_SCHEME_KEY)).id
  } catch {
    return SCHEMES[0].id
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


const freshCounters = (): Record<ElementKind, number> => ({
  point: 1,
  line: 1,
  plane: 1,
  sphere: 1,
  cylinder: 1,
  cone: 1,
  circle: 1,
})

export const useStore = create<AppState>()((set, get) => ({
  fileName: null,
  vertexCount: 0,
  triangleCount: 0,
  modelSize: 1,
  modelCenter: [0, 0, 0],
  busy: false,
  statusText: '',
  errorText: null,
  elements: [],
  draft: null,
  dimensions: [],
  dimDraft: null,
  alignDraft: null,
  appliedAlignment: null,
  nextId: 1,
  nextNumber: 1,
  nextOfKind: freshCounters(),
  nextDimensionId: 1,
  nextOfDimGroup: { distance: 1, angle: 1 },
  settings: { method: 'gaussian', sigma: 3 },
  selectMode: 'auto',
  showOverlays: true,
  showBackfaces: true,
  navScheme: storedNavScheme(),
  viewTheme: storedViewTheme(),
  stepStyle: storedStepStyle(),
  imprintOpen: false,

  setStatus: (statusText) => set({ statusText }),
  setError: (errorText) => set({ errorText }),

  beginLoad: (name) =>
    set({
      busy: true,
      fileName: name,
      statusText: 'Reading file…',
      errorText: null,
      elements: [],
      draft: null,
      dimensions: [],
      dimDraft: null,
      alignDraft: null,
      appliedAlignment: null,
      nextNumber: 1,
      nextOfKind: freshCounters(),
      nextOfDimGroup: { distance: 1, angle: 1 },
      vertexCount: 0,
      triangleCount: 0,
    }),

  // The brush is sized to the part it will be used on — see markStore, which
  // holds it for both workspaces.
  finishLoad: (vertexCount, triangleCount, modelSize, modelCenter) =>
    set({ busy: false, vertexCount, triangleCount, modelSize, modelCenter }),

  loadFailed: (message) =>
    set({ busy: false, fileName: null, statusText: '', errorText: message }),

  markFitting: (id, seeds, selection) =>
    set((s) => ({
      elements: s.elements.map((e) =>
        e.id === id
          ? {
              ...e,
              source: { type: 'fitted' as const, seeds, selection },
              status: 'fitting' as const,
            }
          : e,
      ),
    })),

  resolveFit: (id, r) =>
    set((s) => ({
      elements: reevaluateConstructions(
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
        s.modelSize,
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
  removeElement: (id) =>
    set((s) => {
      const doomed = dependentsOf(id, s.elements)
      const keepRef = (r: number | null) => (r !== null && doomed.has(r) ? null : r)
      const dropOrient = (e: Element): Element =>
        e.orient && doomed.has(e.orient.ref)
          ? { ...e, orient: undefined, fit: e.measured ?? e.fit, measured: undefined }
          : e
      const dropDraftOrient = (d: Draft): Draft =>
        d.orient && doomed.has(d.orient.ref) ? { ...d, orient: undefined } : d
      return {
        elements: reevaluateConstructions(
          s.elements.filter((e) => !doomed.has(e.id)).map(dropOrient),
          s.modelSize,
        ),
        dimensions: s.dimensions.filter((d) => !d.refs.some((r) => doomed.has(r))),
        alignDraft: s.alignDraft
          ? {
              ...s.alignDraft,
              primary: keepRef(s.alignDraft.primary),
              secondary: keepRef(s.alignDraft.secondary),
              origin: keepRef(s.alignDraft.origin),
            }
          : null,
        dimDraft: s.dimDraft
          ? {
              ...s.dimDraft,
              refs: s.dimDraft.refs.map((r) => (r !== null && doomed.has(r) ? null : r)),
            }
          : null,
        // Deleting the element that is open for editing closes the editor —
        // there is nothing left to write back to.
        draft:
          s.draft?.editId !== undefined && doomed.has(s.draft.editId)
            ? null
            : s.draft && s.draft.refs.some((r) => r !== null && doomed.has(r))
            ? evalConstructDraft(
                dropDraftOrient({
                  ...s.draft,
                  refs: s.draft.refs.map((r) => (r !== null && doomed.has(r) ? null : r)),
                }),
                s.elements.filter((e) => !doomed.has(e.id)),
                s.modelSize,
              )
            : s.draft
              ? dropDraftOrient(s.draft)
              : null,
      }
    }),

  toggleElementVisible: (id) =>
    set((s) => ({
      elements: s.elements.map((e) => (e.id === id ? { ...e, visible: !e.visible } : e)),
    })),
  setAllElementsVisible: (visible) =>
    set((s) => ({ elements: s.elements.map((e) => (e.visible === visible ? e : { ...e, visible })) })),

  startDraft: (kind) =>
    set({ draft: freshDraft(kind, defaultMethod(kind)), alignDraft: null, errorText: null }),

  // How the surface of a re-opened fit was chosen comes back with it: an
  // element marked by hand opens with the marking tools out, one grown from a
  // click opens ready to be clicked again.
  editElement: (id) =>
    set((s) => {
      const el = s.elements.find((e) => e.id === id)
      if (!el) return {}
      const draft = draftFromElement(el, s.elements, s.modelSize)
      return {
        draft,
        selectMode: el.source.type === 'fitted' ? (el.source.selection ? 'paint' : 'auto') : s.selectMode,
        alignDraft: null,
        errorText: null,
      }
    }),

  setDraftName: (name) => set((s) => (s.draft ? { draft: { ...s.draft, name } } : {})),

  setDraftMethod: (method) =>
    set((s) => {
      if (!s.draft) return {}
      const { editId, name } = s.draft
      return {
        draft: evalConstructDraft(
          freshDraft(s.draft.kind, method, { editId, name }),
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

  setDraftSelection: (selection) =>
    set((s) =>
      s.draft
        ? {
            draft: {
              ...s.draft,
              selection: selection ?? undefined,
              fit: undefined,
              message: undefined,
              status: selection ? ('fitting' as const) : ('empty' as const),
            },
          }
        : {},
    ),

  setDraftRef: (slot, id) =>
    set((s) => {
      if (!s.draft) return {}
      // An element cannot be built on itself, nor on anything that is already
      // built on it.
      if (id !== null && blockedRefs(s.draft.editId, s.elements).has(id)) return {}
      const refs = s.draft.refs.map((r, i) => (i === slot ? id : r))
      return { draft: evalConstructDraft({ ...s.draft, refs }, s.elements, s.modelSize) }
    }),

  setDraftParam: (index, value) =>
    set((s) => {
      if (!s.draft) return {}
      const params = s.draft.params.map((p, i) => (i === index ? value : p))
      return { draft: evalConstructDraft({ ...s.draft, params }, s.elements, s.modelSize) }
    }),

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

  resetDraftExtend: () =>
    set((s) => {
      const d = s.draft
      if (!d || !isExtendable(d.fit)) return {}
      return { draft: { ...d, extend: zeroExtension(d.fit) } }
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
      // Only a plane can be aligned to, and not one that builds on the
      // element being edited — that would close a loop.
      const el = s.elements.find((e) => e.id === ref)
      if (el?.kind !== 'plane' || blockedRefs(d.editId, s.elements).has(ref)) return {}
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
      // A pick that was feeding a dimension slot is abandoned with it.
      dimDraft: s.dimDraft ? { ...s.dimDraft, pickSlot: null } : null,
    })),

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
      isOrientable(d.fit) &&
      d.orient &&
      get().elements.some((e) => e.id === d.orient!.ref && e.kind === 'plane')
        ? d.orient
        : undefined
    const measured = orient ? d.fit : undefined
    const source: ElementSource =
      m.mode === 'fit'
        ? d.selection
          ? { type: 'fitted', seeds: [], selection: d.selection }
          : { type: 'fitted', seeds: d.picks.flat() }
        : m.mode === 'pick'
          ? { type: 'picked' }
          : { type: 'constructed', method: d.method, refs: d.refs as number[], params: d.params }
    // An edited element is written back where it stands: same id, same colour,
    // same place in the list, so every dimension and construction on it simply
    // re-reads the new geometry.
    if (d.editId !== undefined) {
      const editId = d.editId
      set((s) => ({
        draft: null,
        elements: reevaluateConstructions(
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
          s.modelSize,
        ),
      }))
      return editId
    }
    const id = get().nextId
    const num = get().nextNumber
    const ofKind = get().nextOfKind[d.kind]
    set((s) => ({
      nextId: id + 1,
      nextNumber: num + 1,
      nextOfKind: { ...s.nextOfKind, [d.kind]: ofKind + 1 },
      draft: null,
      elements: reevaluateConstructions(
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
        s.modelSize,
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
    set({
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
      dimDraft: null,
      errorText: null,
    }),

  cancelAlignment: () => set({ alignDraft: null }),

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
      return {
        alignDraft: null,
        appliedAlignment: s.appliedAlignment ? rigidCompose(m, s.appliedAlignment) : m,
        modelCenter: [moved[0], moved[1], moved[2]] as Vec3,
        elements: reevaluateConstructions(
          s.elements.map((el) => ({
            ...el,
            source: transformSource(el.source, m),
            fit: el.fit ? transformFit(el.fit, m) : el.fit,
            measured: el.measured ? transformFit(el.measured, m) : el.measured,
          })),
          s.modelSize,
        ),
      }
    }),

  clearAppliedAlignment: () => set({ appliedAlignment: null }),

  startDimension: (type) =>
    set({
      dimDraft: {
        type,
        refs: dimensionTypeInfo(type).slots.map(() => null),
        anchor: 'center',
        pickSlot: null,
      },
      alignDraft: null,
    }),

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
        },
        alignDraft: null,
      }
    }),

  setDimensionName: (name) => set((s) => (s.dimDraft ? { dimDraft: { ...s.dimDraft, name } } : {})),

  setDimensionType: (type) =>
    set((s) => {
      if (!s.dimDraft) return {}
      const slots = dimensionTypeInfo(type).slots
      const sameRoles =
        dimensionTypeInfo(s.dimDraft.type).slots.length === slots.length &&
        slots.every((sl, i) => sl.role === dimensionTypeInfo(s.dimDraft!.type).slots[i].role)
      return {
        dimDraft: {
          ...s.dimDraft,
          type,
          // Keep the picked references when the new type takes the same roles
          // (switching Axis–Axis distance → Axis–Axis angle, say).
          refs: sameRoles ? s.dimDraft.refs : slots.map(() => null),
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
      const el = s.elements.find((e) => e.id === id)
      if (!el?.fit) return {}
      // Clicking an element that is already a reference takes it out again.
      if (dd.refs.includes(id)) {
        return { dimDraft: { ...dd, refs: dd.refs.map((r) => (r === id ? null : r)) } }
      }
      const slots = dimensionTypeInfo(dd.type).slots
      // What is already selected, in slot order — plus the new element. With
      // both slots taken the pick replaces the second one, so the first
      // reference stays the anchor of the measurement.
      let selected = dd.refs.flatMap((r, i) => (r !== null ? [{ id: r, role: slots[i].role }] : []))
      if (selected.length >= slots.length) selected = selected.slice(0, slots.length - 1)
      selected.push({ id, role: roleOf(el.kind) })
      const type = resolveDimensionType(dd.type, selected.map((sel) => sel.role))
      return {
        dimDraft: { ...dd, type, refs: assignDimensionRefs(type, selected), pickSlot: null },
      }
    }),

  setDimensionAnchor: (anchor) =>
    set((s) => (s.dimDraft ? { dimDraft: { ...s.dimDraft, anchor } } : {})),

  beginDimensionPick: (slot) =>
    set((s) =>
      s.dimDraft
        ? {
            dimDraft: { ...s.dimDraft, pickSlot: slot },
            draft: freshDraft('point', 'pick'),
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
      const n = s.nextOfDimGroup[info.group]
      if (dd.editId !== undefined) {
        const old = s.dimensions.find((d) => d.id === dd.editId)
        const typed = dd.name?.trim()
        // A distance turned into an angle is no longer "Distance 2": unless it
        // was renamed by hand it takes the next name of the group it has
        // become.
        const renamed = Boolean(typed) && typed !== old?.name
        const regroup = !renamed && old !== undefined && dimensionTypeInfo(old.type).group !== info.group
        const name = regroup
          ? `${info.group === 'distance' ? 'Distance' : 'Angle'} ${n}`
          : typed || (old?.name ?? '')
        return {
          dimensions: s.dimensions.map((d) =>
            d.id === dd.editId
              ? { ...d, type: dd.type, refs: dd.refs as number[], anchor: dd.anchor, name }
              : d,
          ),
          nextOfDimGroup: regroup ? { ...s.nextOfDimGroup, [info.group]: n + 1 } : s.nextOfDimGroup,
          dimDraft: null,
        }
      }
      return {
        dimensions: [
          ...s.dimensions,
          {
            id: s.nextDimensionId,
            type: dd.type,
            name: `${info.group === 'distance' ? 'Distance' : 'Angle'} ${n}`,
            refs: dd.refs as number[],
            anchor: dd.anchor,
            visible: true,
          },
        ],
        nextDimensionId: s.nextDimensionId + 1,
        nextOfDimGroup: { ...s.nextOfDimGroup, [info.group]: n + 1 },
        dimDraft: null,
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
  setAllDimensionsVisible: (visible) =>
    set((s) => ({ dimensions: s.dimensions.map((d) => ({ ...d, visible })) })),

  setSigma: (sigma) => set((s) => ({ settings: { ...s.settings, sigma } })),
  setSelectMode: (selectMode) => set({ selectMode }),
  setShowOverlays: (showOverlays) => set({ showOverlays }),
  setShowBackfaces: (showBackfaces) => set({ showBackfaces }),
  setNavScheme: (navScheme) => {
    try {
      localStorage.setItem(NAV_SCHEME_KEY, navScheme)
    } catch {
      // Not being able to remember the choice is no reason to refuse it.
    }
    set({ navScheme })
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
  openImprint: (imprintOpen) => set({ imprintOpen }),
}))

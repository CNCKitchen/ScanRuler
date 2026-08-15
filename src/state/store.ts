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
import { ALIGN_PICK_COUNT, transformFit, type AlignSlot, type AxisDir } from '../core/alignment'
import { rigidCompose, type Rigid } from '../core/deviation/rigid'
import { SCHEMES, schemeById } from '../viewer/navSchemes'
import type {
  ElementKind,
  ElementSource,
  FitData,
  FitOutput,
  FitSettings,
  SigmaPreset,
  Vec3,
} from '../core/types'

/** Saturated enough to hold against the warm-grey chassis and the aluminium
 *  tone of an unmeasured scan — pastels wash out on a light stage. Starts on
 *  the CNC Kitchen blue so the first element is always "the" brand colour. */
const PALETTE = ['#1877c0', '#e8590c', '#2e7d46', '#b5179e', '#c99a0a', '#0f9b9b', '#b3361c', '#6d4bbd']

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
  refs: (number | null)[]
  params: number[]
  status: 'empty' | 'fitting' | 'ready' | 'failed'
  fit?: FitData
  message?: string
}

/** The 3-2-1 alignment being set up: per slot either an existing element or
 *  points picked straight on the scan (3 span the levelling plane, 2 the
 *  rotation line, 1 the origin), plus the global axis each direction becomes.
 *  Nothing moves until it is applied. */
export interface AlignDraft {
  primary: number | null
  primaryPicks: Vec3[]
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

/** The slot with the given element reference and its picks discarded — the
 *  two ways of filling a slot are exclusive. */
function withSlotRef(ad: AlignDraft, slot: AlignSlot, id: number | null): AlignDraft {
  const base = { ...ad, pickSlot: ad.pickSlot === slot ? null : ad.pickSlot }
  if (slot === 'primary') return { ...base, primary: id, primaryPicks: [] }
  if (slot === 'secondary') return { ...base, secondary: id, secondaryPicks: [] }
  return { ...base, origin: id, originPicks: [] }
}

function withSlotPicks(ad: AlignDraft, slot: AlignSlot, picks: Vec3[]): AlignDraft {
  if (slot === 'primary') return { ...ad, primary: null, primaryPicks: picks }
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
}

/** The region is a large typed array only the scene needs, so it is stripped
 *  before a fit goes into the store. */
function withoutRegion(r: FitOutput): FitData {
  const { region: _region, ...fit } = r
  return fit
}

function freshDraft(kind: ElementKind, method: string): Draft {
  const m = creationMethod(kind, method)
  return {
    kind,
    method,
    picks: [],
    refs: m.slots.map(() => null),
    params: m.params.map(() => NaN),
    status: 'empty',
  }
}

/** Default creation method per kind: the one that touches the scan. */
function defaultMethod(kind: ElementKind): string {
  if (kind === 'point') return 'pick'
  if (kind === 'line') return 'line-two-points'
  return 'fit'
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
  const byId = new Map<number, FitData>()
  return elements.map((el) => {
    if (el.source.type !== 'constructed') {
      if (el.fit) byId.set(el.id, el.fit)
      return el
    }
    const { method, refs, params } = el.source
    const fits: FitData[] = []
    for (const id of refs) {
      const f = byId.get(id)
      if (f) fits.push(f)
    }
    if (fits.length !== refs.length) {
      return { ...el, fit: undefined, message: 'A source element is unavailable.' }
    }
    try {
      const fit = evaluateConstruction(method, fits, params, modelSize)
      byId.set(el.id, fit)
      return el.fit && sameFit(el.fit, fit) ? el : { ...el, fit, message: undefined }
    } catch (e) {
      return {
        ...el,
        fit: undefined,
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
  return source
}

/** All elements that (transitively) build on the given one. */
function dependentsOf(id: number, elements: Element[]): Set<number> {
  const doomed = new Set<number>([id])
  let grew = true
  while (grew) {
    grew = false
    for (const el of elements) {
      if (doomed.has(el.id) || el.source.type !== 'constructed') continue
      if (el.source.refs.some((r) => doomed.has(r))) {
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
  showOverlays: boolean
  /** Id of the mouse navigation scheme (see viewer/navSchemes). Remembered per
   *  browser, because which buttons orbit is a habit from whichever CAD the
   *  user came from, not a property of the part on screen. */
  navScheme: string
  /** Imprint & privacy dialog, opened from the status strip. */
  imprintOpen: boolean

  setStatus: (text: string) => void
  setError: (text: string | null) => void
  beginLoad: (name: string) => void
  finishLoad: (vertexCount: number, triangleCount: number, modelSize: number) => void
  loadFailed: (message: string) => void
  markFitting: (id: number, seeds: number[]) => void
  resolveFit: (id: number, r: FitOutput) => void
  failFit: (id: number, message: string) => void
  removeElement: (id: number) => void
  toggleElementVisible: (id: number) => void
  clearElements: () => void
  startDraft: (kind: ElementKind) => void
  setDraftMethod: (method: string) => void
  setDraftPicks: (picks: [number, number, number][]) => void
  setDraftRef: (slot: number, id: number | null) => void
  setDraftParam: (index: number, value: number) => void
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
  /** A click on the scan while a slot is collecting points. The slot closes
   *  itself once it has enough. */
  addAlignmentPick: (point: Vec3) => void
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
  setSigma: (k: SigmaPreset) => void
  setShowOverlays: (v: boolean) => void
  setNavScheme: (id: string) => void
  openImprint: (v: boolean) => void
}

const NAV_SCHEME_KEY = 'scanruler.navscheme'

/** Falls back to the built-in default when storage is unavailable (private
 *  mode, blocked cookies) or holds an id that no longer exists. */
const storedNavScheme = (): string => {
  try {
    return schemeById(localStorage.getItem(NAV_SCHEME_KEY)).id
  } catch {
    return SCHEMES[0].id
  }
}

const freshCounters = (): Record<ElementKind, number> => ({
  point: 1,
  line: 1,
  plane: 1,
  sphere: 1,
  cylinder: 1,
})

export const useStore = create<AppState>()((set, get) => ({
  fileName: null,
  vertexCount: 0,
  triangleCount: 0,
  modelSize: 1,
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
  showOverlays: true,
  navScheme: storedNavScheme(),
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

  finishLoad: (vertexCount, triangleCount, modelSize) =>
    set({ busy: false, vertexCount, triangleCount, modelSize }),

  loadFailed: (message) =>
    set({ busy: false, fileName: null, statusText: '', errorText: message }),

  markFitting: (id, seeds) =>
    set((s) => ({
      elements: s.elements.map((e) =>
        e.id === id
          ? { ...e, source: { type: 'fitted' as const, seeds }, status: 'fitting' as const }
          : e,
      ),
    })),

  resolveFit: (id, r) =>
    set((s) => ({
      elements: reevaluateConstructions(
        s.elements.map((e) =>
          e.id === id ? { ...e, status: 'done' as const, fit: withoutRegion(r) } : e,
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
      return {
        elements: s.elements.filter((e) => !doomed.has(e.id)),
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
        draft:
          s.draft && s.draft.refs.some((r) => r !== null && doomed.has(r))
            ? evalConstructDraft(
                { ...s.draft, refs: s.draft.refs.map((r) => (r !== null && doomed.has(r) ? null : r)) },
                s.elements.filter((e) => !doomed.has(e.id)),
                s.modelSize,
              )
            : s.draft,
      }
    }),

  toggleElementVisible: (id) =>
    set((s) => ({
      elements: s.elements.map((e) => (e.id === id ? { ...e, visible: !e.visible } : e)),
    })),

  clearElements: () =>
    set({
      elements: [],
      draft: null,
      dimensions: [],
      dimDraft: null,
      alignDraft: null,
      nextNumber: 1,
      nextOfKind: freshCounters(),
      nextOfDimGroup: { distance: 1, angle: 1 },
    }),

  startDraft: (kind) =>
    set({ draft: freshDraft(kind, defaultMethod(kind)), alignDraft: null, errorText: null }),

  setDraftMethod: (method) =>
    set((s) => {
      if (!s.draft) return {}
      return { draft: evalConstructDraft(freshDraft(s.draft.kind, method), s.elements, s.modelSize) }
    }),

  setDraftPicks: (picks) =>
    set((s) =>
      s.draft
        ? {
            draft: {
              ...s.draft,
              picks,
              fit: undefined,
              message: undefined,
              status: picks.length ? ('fitting' as const) : ('empty' as const),
            },
          }
        : {},
    ),

  setDraftRef: (slot, id) =>
    set((s) => {
      if (!s.draft) return {}
      const refs = s.draft.refs.map((r, i) => (i === slot ? id : r))
      return { draft: evalConstructDraft({ ...s.draft, refs }, s.elements, s.modelSize) }
    }),

  setDraftParam: (index, value) =>
    set((s) => {
      if (!s.draft) return {}
      const params = s.draft.params.map((p, i) => (i === index ? value : p))
      return { draft: evalConstructDraft({ ...s.draft, params }, s.elements, s.modelSize) }
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
    const source: ElementSource =
      m.mode === 'fit'
        ? { type: 'fitted', seeds: d.picks.flat() }
        : m.mode === 'pick'
          ? { type: 'picked' }
          : { type: 'constructed', method: d.method, refs: d.refs as number[], params: d.params }
    const id = get().nextId
    const num = get().nextNumber
    const ofKind = get().nextOfKind[d.kind]
    set((s) => ({
      nextId: id + 1,
      nextNumber: num + 1,
      nextOfKind: { ...s.nextOfKind, [d.kind]: ofKind + 1 },
      draft: null,
      elements: [
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
        },
      ],
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
        primaryAxis: 'z+',
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

  addAlignmentPick: (point) =>
    set((s) => {
      const ad = s.alignDraft
      if (!ad || ad.pickSlot === null) return {}
      const slot = ad.pickSlot
      const picks = [...alignSlotPicks(ad, slot), point]
      const full = picks.length >= ALIGN_PICK_COUNT[slot]
      return { alignDraft: { ...withSlotPicks(ad, slot, picks), pickSlot: full ? null : slot } }
    }),

  undoAlignmentPick: () =>
    set((s) => {
      const ad = s.alignDraft
      if (!ad || ad.pickSlot === null) return {}
      const picks = alignSlotPicks(ad, ad.pickSlot)
      if (picks.length === 0) return {}
      return {
        alignDraft: {
          ...withSlotPicks(ad, ad.pickSlot, picks.slice(0, -1)),
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
    set((s) => ({
      alignDraft: null,
      appliedAlignment: s.appliedAlignment ? rigidCompose(m, s.appliedAlignment) : m,
      elements: reevaluateConstructions(
        s.elements.map((el) => ({
          ...el,
          source: transformSource(el.source, m),
          fit: el.fit ? transformFit(el.fit, m) : el.fit,
        })),
        s.modelSize,
      ),
    })),

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

  setDimensionType: (type) =>
    set((s) => {
      if (!s.dimDraft) return {}
      const slots = dimensionTypeInfo(type).slots
      const sameRoles =
        dimensionTypeInfo(s.dimDraft.type).slots.length === slots.length &&
        slots.every((sl, i) => sl.role === dimensionTypeInfo(s.dimDraft!.type).slots[i].role)
      return {
        dimDraft: {
          type,
          // Keep the picked references when the new type takes the same roles
          // (switching Axis–Axis distance → Axis–Axis angle, say).
          refs: sameRoles ? s.dimDraft.refs : slots.map(() => null),
          anchor: s.dimDraft.anchor,
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
    set((s) => ({ dimensions: s.dimensions.filter((d) => d.id !== id) })),

  toggleDimensionVisible: (id) =>
    set((s) => ({
      dimensions: s.dimensions.map((d) =>
        d.id === id ? { ...d, visible: d.visible === false } : d,
      ),
    })),

  setSigma: (sigma) => set((s) => ({ settings: { ...s.settings, sigma } })),
  setShowOverlays: (showOverlays) => set({ showOverlays }),
  setNavScheme: (navScheme) => {
    try {
      localStorage.setItem(NAV_SCHEME_KEY, navScheme)
    } catch {
      // Not being able to remember the choice is no reason to refuse it.
    }
    set({ navScheme })
  },
  openImprint: (imprintOpen) => set({ imprintOpen }),
}))

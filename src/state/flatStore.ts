// SPDX-License-Identifier: AGPL-3.0-only
// The 2D Measure workspace's state: the loaded scan image, the scale in force
// and where it came from, and the named scanner profiles that scale can be
// kept under. The decoded bitmap itself lives in a ref owned by App — the
// same rule that keeps meshes and fields out of the other stores — and
// `imageVersion` is how everyone else learns a new one has landed.
//
// Profiles are the one thing this app persists: a calibration that had to be
// redone every reload would not be a profile. A tiny versioned JSON blob in
// localStorage, read once at startup, written through on every change.

import { create } from 'zustand'
import { distanceCalibration, diameterCalibration } from '../core/flat/calibration'
import { flatMethod } from '../core/flat/construct'
import {
  evaluateFlatElements,
  evaluateFlatSource,
  flatDependentsOf,
  flatPicksReady,
  FLAT_KIND_LABELS,
  type FlatElement,
  type FlatSource,
} from '../core/flat/elements'
import type { FlatDatum } from '../core/flat/datum'
import {
  FLAT_DIMENSION_TYPES,
  flatDimensionTypeInfo,
  type FlatDimension,
  type FlatDimensionGroup,
} from '../core/flat/dimensions'
import { FitError } from '../core/fit/errors'
import type { PixelsPerMm } from '../core/flat/image'
import type { FlatElementKind, FlatFit, Vec2 } from '../core/flat/types'
import { PALETTE } from './palette'

/** What the numbers on screen rest on. `metadata` is the file's own claim —
 *  honest to measure with, nominal until verified; `measured` is a
 *  calibration taken against a reference; `none` is bare pixels. */
export type CalSource = 'none' | 'metadata' | 'measured'

export type CalMode = 'distance' | 'diameter'

export interface CalibrationProfile {
  name: string
  pxPerMm: PixelsPerMm
}

/** A flat element being built: picks and references accumulate, and the fit
 *  (or the reason there is none) follows every change. Picks are image
 *  pixels, like the elements' own sources. An edit is the same draft with
 *  `editId` set — it writes back over that element instead of adding one. */
export interface FlatDraft {
  kind: FlatElementKind
  method: string
  picks: Vec2[]
  refs: (number | null)[]
  fit: FlatFit | null
  error: string | null
  editId?: number
  /** The name as typed while editing; blank keeps the old one. */
  name?: string
}

/** A tally taken by clicking features one after another — the teeth of a
 *  gear, the holes in a flange. The picks (image pixels) are the count; they
 *  stay numbered on the sheet so the tally can be checked against the part. */
export interface FlatCount {
  id: number
  name: string
  color: string
  picks: Vec2[]
  visible: boolean
}

/** A dimension being assembled — or re-opened, with `editId` set. */
export interface FlatDimDraft {
  type: string
  refs: (number | null)[]
  editId?: number
  name?: string
}

/** Elements an edited draft must not reference: itself and everything
 *  constructed on it, which would close a loop. */
export function flatBlockedRefs(editId: number | undefined, elements: readonly FlatElement[]): Set<number> {
  return editId === undefined ? new Set() : flatDependentsOf(editId, elements)
}

/** The colour the open draft draws in: the edited element's own, or the one
 *  the next element will get. */
export function flatDraftColorOf(s: {
  draft: FlatDraft | null
  elements: readonly FlatElement[]
  nextId: number
}): string {
  const el = s.draft?.editId === undefined ? undefined : s.elements.find((e) => e.id === s.draft!.editId)
  return el?.color ?? PALETTE[(s.nextId - 1) % PALETTE.length]
}

/** The colour a tally wears — offset into the palette so the first count
 *  does not match the first element. */
export function flatCountColor(id: number): string {
  return PALETTE[(id + 3) % PALETTE.length]
}

function freshDraft(kind: FlatElementKind, method: string, edit?: Pick<FlatDraft, 'editId' | 'name'>): FlatDraft {
  return {
    kind,
    method,
    picks: [],
    refs: new Array<number | null>(flatMethod(method).slots?.length ?? 0).fill(null),
    fit: null,
    error: null,
    ...edit,
  }
}

const PROFILE_KEY = 'scanruler.flat.profiles.v1'

function loadProfiles(): CalibrationProfile[] {
  try {
    const raw = localStorage.getItem(PROFILE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (p): p is CalibrationProfile =>
        typeof p === 'object' &&
        p !== null &&
        typeof (p as CalibrationProfile).name === 'string' &&
        typeof (p as CalibrationProfile).pxPerMm?.x === 'number' &&
        typeof (p as CalibrationProfile).pxPerMm?.y === 'number',
    )
  } catch {
    return []
  }
}

function storeProfiles(profiles: CalibrationProfile[]): void {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profiles))
  } catch {
    // Storage full or blocked — the profiles still work for this session.
  }
}

/** The draft's fit, following every change: null-and-no-error while picks or
 *  slots are still missing, null-with-reason when the geometry refuses. */
function evaluateDraft(
  draft: Pick<FlatDraft, 'kind' | 'method' | 'picks' | 'refs'>,
  elements: readonly FlatElement[],
  pxPerMm: PixelsPerMm | null,
): { fit: FlatFit | null; error: string | null } {
  const m = flatMethod(draft.method)
  try {
    if (m.mode !== 'construct') {
      if (!flatPicksReady(draft.method, draft.picks)) return { fit: null, error: null }
      return {
        fit: evaluateFlatSource(
          { type: 'picks', method: draft.method, picks: draft.picks },
          pxPerMm,
          () => null,
        ),
        error: null,
      }
    }
    const slots = m.slots?.length ?? 0
    if (draft.refs.length < slots || draft.refs.some((r) => r === null)) {
      return { fit: null, error: null }
    }
    return {
      fit: evaluateFlatSource(
        { type: 'construct', method: draft.method, refs: draft.refs as number[] },
        pxPerMm,
        (id) => elements.find((e) => e.id === id)?.fit ?? null,
      ),
      error: null,
    }
  } catch (e) {
    if (e instanceof FitError) return { fit: null, error: e.message }
    throw e
  }
}

/** Per-kind name counters: "Circle 3" is the third circle ever made this
 *  session, and deletions never make a name come back to mean something new. */
type NameCounts = Partial<Record<FlatElementKind, number>>

interface FlatState {
  imageName: string | null
  /** Pixel dimensions of the loaded image. */
  imageWidth: number
  imageHeight: number
  imageBusy: boolean
  /** Bumped when a fresh bitmap has landed in App's ref. */
  imageVersion: number
  /** Pixels per mm as declared by the file's metadata, or null when the file
   *  carried none. Kept apart from the scale in force, so the panel can say
   *  what the file claims even after a measurement overrides it. */
  metaPxPerMm: PixelsPerMm | null

  /** Edge detection over the loaded image: computed once per image in a
   *  worker, re-run when the sensitivity moves. The chains themselves live in
   *  a ref beside the bitmap; this is the status, the count for the panel,
   *  and a version to redraw off. */
  edgeStatus: 'idle' | 'running' | 'ready'
  edgeCount: number
  edgeVersion: number
  /** 0…1 — how faint an edge may be and still count. */
  edgeSensitivity: number
  showEdges: boolean
  /** Hand picks — placed or dragged — land on the nearest detected edge
   *  rather than where the cursor was. Off, the cursor is the measurement;
   *  Alt inverts either way for one pick. */
  snapToEdge: boolean

  /** The scale measurements use, or null for bare pixels (drawn at 1 px/mm). */
  pxPerMm: PixelsPerMm | null
  calSource: CalSource
  /** Calibrate X and Y separately — scanner transports err per axis. */
  splitAxes: boolean
  /** The calibration tool is out, collecting picks (in image pixels). */
  calibrating: { mode: CalMode; picks: Vec2[] } | null

  profiles: CalibrationProfile[]

  /** Measured results and the one being built. Sources are image pixels;
   *  fits are document units, re-derived whenever the scale moves. */
  elements: FlatElement[]
  draft: FlatDraft | null
  nextId: number
  nameCounts: NameCounts

  startDraft: (kind: FlatElementKind, method: string) => void
  /** Re-open an element: the same box it was created in, its picks or its
   *  references back on the sheet, writing back over it on save. */
  editElement: (id: number) => void
  cancelDraft: () => void
  addDraftPick: (px: Vec2) => void
  /** A pick dragged to a new place on the sheet. */
  moveDraftPick: (index: number, px: Vec2) => void
  /** A dragged region's worth of edge points, all at once. */
  addDraftPoints: (px: Vec2[]) => void
  undoDraftPick: () => void
  setDraftRef: (slot: number, id: number | null) => void
  setDraftMethod: (method: string) => void
  setDraftName: (name: string) => void
  /** Turn the draft into an element — or write it back over the one being
   *  edited. Returns the element's id, or null if not ready. */
  commitDraft: () => number | null
  deleteElement: (id: number) => void
  toggleElementVisible: (id: number) => void
  /** Show or hide every element and count at once. */
  setAllElementsVisible: (visible: boolean) => void

  beginImageLoad: (name: string) => void
  finishImageLoad: (name: string, width: number, height: number, meta: PixelsPerMm | null) => void
  imageFailed: () => void

  beginEdges: () => void
  /** A fresh set of chains has landed in App's ref. */
  resolveEdges: (count: number) => void
  failEdges: () => void
  setEdgeSensitivity: (v: number) => void
  setShowEdges: (v: boolean) => void
  setSnapToEdge: (v: boolean) => void

  /** User-created measurements between elements, and the one being built. */
  dimensions: FlatDimension[]
  dimDraft: FlatDimDraft | null
  nextDimId: number
  /** Per-group name counters — "Distance 3", "Angle 1". */
  dimCounts: Partial<Record<FlatDimensionGroup, number>>

  startDimDraft: () => void
  editDimension: (id: number) => void
  cancelDimDraft: () => void
  setDimType: (type: string) => void
  setDimRef: (slot: number, id: number | null) => void
  setDimName: (name: string) => void
  commitDim: () => void
  deleteDimension: (id: number) => void
  toggleDimensionVisible: (id: number) => void
  /** Show or hide every dimension at once. */
  setAllDimensionsVisible: (visible: boolean) => void

  /** The part's own frame: origin and +X, as two picks (image pixels). Null
   *  reads coordinates in the image frame, origin bottom-left. */
  datum: FlatDatum | null
  /** The datum tool is out, holding its first pick until the second lands. */
  datumPicking: { picks: Vec2[] } | null
  showGrid: boolean

  startDatum: () => void
  cancelDatum: () => void
  /** Origin first, then +X — the second pick commits the datum. */
  addDatumPick: (px: Vec2) => void
  clearDatum: () => void
  setShowGrid: (v: boolean) => void

  /** Tallies taken so far, and the one being clicked out. */
  counts: FlatCount[]
  /** The tally being clicked out; `editId` when a finished one was re-opened
   *  to count on. */
  counting: { picks: Vec2[]; editId?: number } | null
  nextCountId: number

  startCount: () => void
  /** Re-open a tally with its picks back on the sheet, the next click adding
   *  to it; finishing writes back over it. */
  editCount: (id: number) => void
  cancelCount: () => void
  addCountPick: (px: Vec2) => void
  undoCountPick: () => void
  /** Keep the tally — it needs at least one pick to be worth keeping. */
  finishCount: () => void
  deleteCount: (id: number) => void
  toggleCountVisible: (id: number) => void

  startCalibration: (mode: CalMode) => void
  cancelCalibration: () => void
  addCalPick: (px: Vec2) => void
  undoCalPick: () => void
  /** Apply the collected picks against the reference's true size. Returns an
   *  error to show, or null on success. */
  applyCalibration: (trueMm: number) => string | null
  setSplitAxes: (v: boolean) => void

  saveProfile: (name: string) => void
  applyProfile: (name: string) => void
  deleteProfile: (name: string) => void
}

export const useFlat = create<FlatState>()((set, get) => ({
  imageName: null,
  imageWidth: 0,
  imageHeight: 0,
  imageBusy: false,
  imageVersion: 0,
  metaPxPerMm: null,

  edgeStatus: 'idle',
  edgeCount: 0,
  edgeVersion: 0,
  edgeSensitivity: 0.5,
  // On by default so the first detection is visible feedback for the slider;
  // a chip on the stage puts them away while measuring.
  showEdges: true,
  snapToEdge: true,

  pxPerMm: null,
  calSource: 'none',
  splitAxes: false,
  calibrating: null,

  dimensions: [],
  dimDraft: null,
  nextDimId: 1,
  dimCounts: {},

  startDimDraft: () =>
    set({
      dimDraft: {
        type: FLAT_DIMENSION_TYPES[0].id,
        refs: FLAT_DIMENSION_TYPES[0].slots.map(() => null),
      },
    }),

  editDimension: (id) =>
    set((s) => {
      const d = s.dimensions.find((x) => x.id === id)
      if (!d) return {}
      return { dimDraft: { type: d.type, refs: [...d.refs], editId: d.id, name: d.name } }
    }),

  cancelDimDraft: () => set({ dimDraft: null }),

  // Slots re-shape with the type; whatever was chosen stays only if a slot of
  // the new type could still hold it — simplest is to start the slots over.
  setDimType: (type) =>
    set((s) => ({
      dimDraft: { ...s.dimDraft, type, refs: flatDimensionTypeInfo(type).slots.map(() => null) },
    })),

  setDimName: (name) => set((s) => (s.dimDraft ? { dimDraft: { ...s.dimDraft, name } } : {})),

  setDimRef: (slot, id) =>
    set((s) => {
      if (!s.dimDraft) return {}
      const refs = [...s.dimDraft.refs]
      refs[slot] = id
      return { dimDraft: { ...s.dimDraft, refs } }
    }),

  commitDim: () =>
    set((s) => {
      const dd = s.dimDraft
      if (!dd || dd.refs.some((r) => r === null)) return {}
      const group = flatDimensionTypeInfo(dd.type).group
      const n = (s.dimCounts[group] ?? 0) + 1
      const groupName = `${group === 'distance' ? 'Distance' : 'Angle'} ${n}`
      if (dd.editId !== undefined) {
        const old = s.dimensions.find((d) => d.id === dd.editId)
        if (!old) return { dimDraft: null }
        const typed = dd.name?.trim()
        // A distance turned into an angle is no longer "Distance 2": unless it
        // was renamed by hand it takes the next name of the group it joined.
        const renamed = Boolean(typed) && typed !== old.name
        const regroup = !renamed && flatDimensionTypeInfo(old.type).group !== group
        return {
          dimensions: s.dimensions.map((d) =>
            d.id === dd.editId
              ? { ...d, type: dd.type, refs: dd.refs as number[], name: regroup ? groupName : typed || old.name }
              : d,
          ),
          dimCounts: regroup ? { ...s.dimCounts, [group]: n } : s.dimCounts,
          dimDraft: null,
        }
      }
      const dim: FlatDimension = {
        id: s.nextDimId,
        type: dd.type,
        name: groupName,
        refs: dd.refs as number[],
        visible: true,
      }
      return {
        dimensions: [...s.dimensions, dim],
        dimDraft: null,
        nextDimId: s.nextDimId + 1,
        dimCounts: { ...s.dimCounts, [group]: n },
      }
    }),

  deleteDimension: (id) =>
    set((s) => ({
      dimensions: s.dimensions.filter((d) => d.id !== id),
      dimDraft: s.dimDraft?.editId === id ? null : s.dimDraft,
    })),

  toggleDimensionVisible: (id) =>
    set((s) => ({
      dimensions: s.dimensions.map((d) => (d.id === id ? { ...d, visible: !d.visible } : d)),
    })),
  setAllDimensionsVisible: (visible) =>
    set((s) => ({ dimensions: s.dimensions.map((d) => ({ ...d, visible })) })),

  counts: [],
  counting: null,
  nextCountId: 1,

  // One stage tool at a time: the count puts the others away, and they it.
  startCount: () => set({ counting: { picks: [] }, calibrating: null, datumPicking: null }),
  editCount: (id) =>
    set((s) => {
      const c = s.counts.find((x) => x.id === id)
      if (!c) return {}
      return { counting: { picks: [...c.picks], editId: id }, calibrating: null, datumPicking: null }
    }),
  cancelCount: () => set({ counting: null }),

  addCountPick: (px) =>
    set((s) =>
      s.counting ? { counting: { ...s.counting, picks: [...s.counting.picks, px] } } : {},
    ),

  undoCountPick: () =>
    set((s) =>
      s.counting ? { counting: { ...s.counting, picks: s.counting.picks.slice(0, -1) } } : {},
    ),

  finishCount: () =>
    set((s) => {
      if (!s.counting) return {}
      if (s.counting.picks.length === 0) return { counting: null }
      if (s.counting.editId !== undefined) {
        const picks = s.counting.picks
        return {
          counts: s.counts.map((c) => (c.id === s.counting!.editId ? { ...c, picks } : c)),
          counting: null,
        }
      }
      const id = s.nextCountId
      const count: FlatCount = {
        id,
        name: `Count ${id}`,
        color: flatCountColor(id),
        picks: s.counting.picks,
        visible: true,
      }
      return { counts: [...s.counts, count], counting: null, nextCountId: id + 1 }
    }),

  deleteCount: (id) =>
    set((s) => ({
      counts: s.counts.filter((c) => c.id !== id),
      counting: s.counting?.editId === id ? null : s.counting,
    })),

  toggleCountVisible: (id) =>
    set((s) => ({
      counts: s.counts.map((c) => (c.id === id ? { ...c, visible: !c.visible } : c)),
    })),

  datum: null,
  datumPicking: null,
  // On while the datum is being placed and after — the grid is the visible
  // proof of where the frame lies; a checkbox puts it away.
  showGrid: true,

  profiles: loadProfiles(),

  elements: [],
  draft: null,
  nextId: 1,
  nameCounts: {},

  startDraft: (kind, method) => set({ draft: freshDraft(kind, method) }),

  // The element comes back exactly as it was made: its picks on the sheet for
  // a picked or region-fitted one, its slots filled for a construction.
  editElement: (id) =>
    set((s) => {
      const el = s.elements.find((e) => e.id === id)
      if (!el) return {}
      const base = freshDraft(el.kind, el.source.method, { editId: el.id, name: el.name })
      const draft =
        el.source.type === 'picks'
          ? { ...base, picks: [...el.source.picks] }
          : { ...base, refs: [...el.source.refs] }
      return { draft: { ...draft, ...evaluateDraft(draft, s.elements, s.pxPerMm) } }
    }),

  cancelDraft: () => set({ draft: null }),

  addDraftPick: (px) =>
    set((s) => {
      if (!s.draft || flatMethod(s.draft.method).mode !== 'pick') return {}
      // A single-point method moves its point; everything else accumulates.
      const picks =
        flatMethod(s.draft.method).minPicks === 1 && s.draft.kind === 'point'
          ? [px]
          : [...s.draft.picks, px]
      const draft = { ...s.draft, picks }
      return { draft: { ...draft, ...evaluateDraft(draft, s.elements, s.pxPerMm) } }
    }),

  moveDraftPick: (index, px) =>
    set((s) => {
      if (!s.draft || index < 0 || index >= s.draft.picks.length) return {}
      const picks = s.draft.picks.map((p, i) => (i === index ? px : p))
      const draft = { ...s.draft, picks }
      return { draft: { ...draft, ...evaluateDraft(draft, s.elements, s.pxPerMm) } }
    }),

  addDraftPoints: (px) =>
    set((s) => {
      if (!s.draft || flatMethod(s.draft.method).mode !== 'edge' || px.length === 0) return {}
      const draft = { ...s.draft, picks: [...s.draft.picks, ...px] }
      return { draft: { ...draft, ...evaluateDraft(draft, s.elements, s.pxPerMm) } }
    }),

  // For an edge draft this clears the lot: the unit of input was the dragged
  // region, and un-clicking one of its thousand points would mean nothing.
  undoDraftPick: () =>
    set((s) => {
      if (!s.draft) return {}
      const picks =
        flatMethod(s.draft.method).mode === 'edge' ? [] : s.draft.picks.slice(0, -1)
      const draft = { ...s.draft, picks }
      return { draft: { ...draft, ...evaluateDraft(draft, s.elements, s.pxPerMm) } }
    }),

  setDraftRef: (slot, id) =>
    set((s) => {
      if (!s.draft) return {}
      if (id !== null && flatBlockedRefs(s.draft.editId, s.elements).has(id)) return {}
      const refs = [...s.draft.refs]
      refs[slot] = id
      const draft = { ...s.draft, refs }
      return { draft: { ...draft, ...evaluateDraft(draft, s.elements, s.pxPerMm) } }
    }),

  setDraftMethod: (method) =>
    set((s) => {
      if (!s.draft) return {}
      const { editId, name } = s.draft
      return { draft: freshDraft(s.draft.kind, method, { editId, name }) }
    }),

  setDraftName: (name) => set((s) => (s.draft ? { draft: { ...s.draft, name } } : {})),

  commitDraft: () => {
    const s = get()
    if (!s.draft?.fit) return null
    const m = flatMethod(s.draft.method)
    const source: FlatSource =
      m.mode !== 'construct'
        ? { type: 'picks', method: s.draft.method, picks: s.draft.picks }
        : { type: 'construct', method: s.draft.method, refs: s.draft.refs as number[] }
    // An edited element is written back where it stands: same id, same
    // colour, same place in the list — and everything constructed on it
    // re-reads the new geometry.
    if (s.draft.editId !== undefined) {
      const editId = s.draft.editId
      const name = s.draft.name?.trim()
      set({
        draft: null,
        elements: evaluateFlatElements(
          s.elements.map((e) => (e.id === editId ? { ...e, name: name || e.name, source } : e)),
          s.pxPerMm,
        ),
      })
      return editId
    }
    const id = s.nextId
    const count = (s.nameCounts[s.draft.kind] ?? 0) + 1
    const element: FlatElement = {
      id,
      kind: s.draft.kind,
      name: `${FLAT_KIND_LABELS[s.draft.kind]} ${count}`,
      color: PALETTE[(id - 1) % PALETTE.length],
      source,
      fit: s.draft.fit,
      error: null,
      visible: true,
    }
    set({
      elements: [...s.elements, element],
      draft: null,
      nextId: id + 1,
      nameCounts: { ...s.nameCounts, [s.draft.kind]: count },
    })
    return id
  },

  // Constructions referencing the deleted element keep their row and say why
  // they cannot be evaluated any more, exactly like the 3D side. Open editors
  // drop the reference; an editor open on the element itself closes.
  deleteElement: (id) =>
    set((s) => {
      const dropRef = (r: number | null) => (r === id ? null : r)
      const elements = evaluateFlatElements(
        s.elements.filter((e) => e.id !== id),
        s.pxPerMm,
      )
      let draft = s.draft
      if (draft?.editId === id) draft = null
      else if (draft && draft.refs.includes(id)) {
        const next = { ...draft, refs: draft.refs.map(dropRef) }
        draft = { ...next, ...evaluateDraft(next, elements, s.pxPerMm) }
      }
      return {
        elements,
        draft,
        dimDraft: s.dimDraft ? { ...s.dimDraft, refs: s.dimDraft.refs.map(dropRef) } : null,
      }
    }),

  toggleElementVisible: (id) =>
    set((s) => ({
      elements: s.elements.map((e) => (e.id === id ? { ...e, visible: !e.visible } : e)),
    })),
  setAllElementsVisible: (visible) =>
    set((s) => ({
      elements: s.elements.map((e) => ({ ...e, visible })),
      counts: s.counts.map((c) => ({ ...c, visible })),
    })),

  beginImageLoad: (imageName) => set({ imageBusy: true, imageName }),

  // A new image adopts its own metadata scale — unless a measured calibration
  // is in force, which describes the scanner rather than the file and is
  // exactly the thing that should survive an image swap.
  finishImageLoad: (imageName, imageWidth, imageHeight, metaPxPerMm) =>
    set((s) => ({
      imageBusy: false,
      imageName,
      imageWidth,
      imageHeight,
      metaPxPerMm,
      imageVersion: s.imageVersion + 1,
      calibrating: null,
      edgeStatus: 'idle' as const,
      edgeCount: 0,
      // Elements are measurements of one image; the calibration is of the
      // scanner and stays.
      elements: [],
      draft: null,
      nameCounts: {},
      dimensions: [],
      dimDraft: null,
      dimCounts: {},
      datum: null,
      datumPicking: null,
      counts: [],
      counting: null,
      ...(s.calSource === 'measured'
        ? {}
        : {
            pxPerMm: metaPxPerMm,
            calSource: metaPxPerMm ? ('metadata' as CalSource) : ('none' as CalSource),
          }),
    })),

  imageFailed: () =>
    set({ imageBusy: false, imageName: null, imageWidth: 0, imageHeight: 0, metaPxPerMm: null }),

  beginEdges: () => set({ edgeStatus: 'running' }),
  resolveEdges: (edgeCount) =>
    set((s) => ({ edgeStatus: 'ready', edgeCount, edgeVersion: s.edgeVersion + 1 })),
  failEdges: () => set((s) => ({ edgeStatus: 'idle', edgeCount: 0, edgeVersion: s.edgeVersion + 1 })),
  setEdgeSensitivity: (edgeSensitivity) => set({ edgeSensitivity }),
  setShowEdges: (showEdges) => set({ showEdges }),
  setSnapToEdge: (snapToEdge) => set({ snapToEdge }),

  startDatum: () => set({ datumPicking: { picks: [] }, calibrating: null, counting: null }),
  cancelDatum: () => set({ datumPicking: null }),

  addDatumPick: (px) =>
    set((s) => {
      if (!s.datumPicking) return {}
      const picks = [...s.datumPicking.picks, px]
      if (picks.length < 2) return { datumPicking: { picks } }
      return { datum: { originPx: picks[0], xRefPx: picks[1] }, datumPicking: null }
    }),

  clearDatum: () => set({ datum: null, datumPicking: null }),
  setShowGrid: (showGrid) => set({ showGrid }),

  startCalibration: (mode) => set({ calibrating: { mode, picks: [] }, datumPicking: null, counting: null }),
  cancelCalibration: () => set({ calibrating: null }),

  addCalPick: (px) =>
    set((s) => {
      if (!s.calibrating) return {}
      // The distance tool takes exactly two: a third pick moves the second.
      const limit = s.calibrating.mode === 'distance' ? 2 : Infinity
      const picks =
        s.calibrating.picks.length < limit
          ? [...s.calibrating.picks, px]
          : [...s.calibrating.picks.slice(0, limit - 1), px]
      return { calibrating: { ...s.calibrating, picks } }
    }),

  undoCalPick: () =>
    set((s) =>
      s.calibrating
        ? { calibrating: { ...s.calibrating, picks: s.calibrating.picks.slice(0, -1) } }
        : {},
    ),

  applyCalibration: (trueMm) => {
    const s = get()
    if (!s.calibrating) return 'The calibration tool is not collecting.'
    try {
      const pxPerMm =
        s.calibrating.mode === 'distance'
          ? distanceCalibration(s.calibrating.picks[0], s.calibrating.picks[1], trueMm, {
              current: s.calSource === 'measured' ? s.pxPerMm : null,
              splitAxes: s.splitAxes,
            })
          : diameterCalibration(s.calibrating.picks, trueMm)
      // Every fit re-derives from its recorded pixels under the new scale —
      // the measurements move with the calibration, never lag it.
      set({
        pxPerMm,
        calSource: 'measured',
        calibrating: null,
        elements: evaluateFlatElements(s.elements, pxPerMm),
      })
      return null
    } catch (e) {
      if (e instanceof FitError) return e.message
      throw e
    }
  },

  setSplitAxes: (splitAxes) => set({ splitAxes }),

  saveProfile: (name) =>
    set((s) => {
      const trimmed = name.trim()
      if (!trimmed || !s.pxPerMm) return {}
      const profiles = [
        ...s.profiles.filter((p) => p.name !== trimmed),
        { name: trimmed, pxPerMm: { ...s.pxPerMm } },
      ]
      storeProfiles(profiles)
      return { profiles }
    }),

  // A profile is a measured calibration by construction — applying one puts
  // the workspace in the calibrated state it was saved from.
  applyProfile: (name) =>
    set((s) => {
      const p = s.profiles.find((x) => x.name === name)
      if (!p) return {}
      return {
        pxPerMm: { ...p.pxPerMm },
        calSource: 'measured',
        elements: evaluateFlatElements(s.elements, p.pxPerMm),
      }
    }),

  deleteProfile: (name) =>
    set((s) => {
      const profiles = s.profiles.filter((p) => p.name !== name)
      storeProfiles(profiles)
      return { profiles }
    }),
}))

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
  flatPicksReady,
  FLAT_KIND_LABELS,
  type FlatElement,
  type FlatSource,
} from '../core/flat/elements'
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
 *  pixels, like the elements' own sources. */
export interface FlatDraft {
  kind: FlatElementKind
  method: string
  picks: Vec2[]
  refs: (number | null)[]
  fit: FlatFit | null
  error: string | null
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
  selectedId: number | null

  startDraft: (kind: FlatElementKind, method: string) => void
  cancelDraft: () => void
  addDraftPick: (px: Vec2) => void
  /** A dragged region's worth of edge points, all at once. */
  addDraftPoints: (px: Vec2[]) => void
  undoDraftPick: () => void
  setDraftRef: (slot: number, id: number | null) => void
  setDraftMethod: (method: string) => void
  /** Turn the draft into an element. Returns its id, or null if not ready. */
  commitDraft: () => number | null
  deleteElement: (id: number) => void
  setElementVisible: (id: number, v: boolean) => void
  selectElement: (id: number | null) => void

  beginImageLoad: (name: string) => void
  finishImageLoad: (name: string, width: number, height: number, meta: PixelsPerMm | null) => void
  imageFailed: () => void

  beginEdges: () => void
  /** A fresh set of chains has landed in App's ref. */
  resolveEdges: (count: number) => void
  failEdges: () => void
  setEdgeSensitivity: (v: number) => void
  setShowEdges: (v: boolean) => void

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

  pxPerMm: null,
  calSource: 'none',
  splitAxes: false,
  calibrating: null,

  profiles: loadProfiles(),

  elements: [],
  draft: null,
  nextId: 1,
  nameCounts: {},
  selectedId: null,

  startDraft: (kind, method) =>
    set({
      draft: {
        kind,
        method,
        picks: [],
        refs: new Array<number | null>(flatMethod(method).slots?.length ?? 0).fill(null),
        fit: null,
        error: null,
      },
      selectedId: null,
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
      const refs = [...s.draft.refs]
      refs[slot] = id
      const draft = { ...s.draft, refs }
      return { draft: { ...draft, ...evaluateDraft(draft, s.elements, s.pxPerMm) } }
    }),

  setDraftMethod: (method) =>
    set((s) => {
      if (!s.draft) return {}
      return {
        draft: {
          kind: s.draft.kind,
          method,
          picks: [],
          refs: new Array<number | null>(flatMethod(method).slots?.length ?? 0).fill(null),
          fit: null,
          error: null,
        },
      }
    }),

  commitDraft: () => {
    const s = get()
    if (!s.draft?.fit) return null
    const m = flatMethod(s.draft.method)
    const source: FlatSource =
      m.mode !== 'construct'
        ? { type: 'picks', method: s.draft.method, picks: s.draft.picks }
        : { type: 'construct', method: s.draft.method, refs: s.draft.refs as number[] }
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
      selectedId: id,
    })
    return id
  },

  // Constructions referencing the deleted element keep their row and say why
  // they cannot be evaluated any more, exactly like the 3D side.
  deleteElement: (id) =>
    set((s) => ({
      elements: evaluateFlatElements(
        s.elements.filter((e) => e.id !== id),
        s.pxPerMm,
      ),
      selectedId: s.selectedId === id ? null : s.selectedId,
    })),

  setElementVisible: (id, visible) =>
    set((s) => ({
      elements: s.elements.map((e) => (e.id === id ? { ...e, visible } : e)),
    })),

  selectElement: (selectedId) => set({ selectedId }),

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
      selectedId: null,
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

  startCalibration: (mode) => set({ calibrating: { mode, picks: [] } }),
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

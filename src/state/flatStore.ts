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
import { FitError } from '../core/fit/errors'
import type { PixelsPerMm } from '../core/flat/image'
import type { Vec2 } from '../core/flat/types'

/** What the numbers on screen rest on. `metadata` is the file's own claim —
 *  honest to measure with, nominal until verified; `measured` is a
 *  calibration taken against a reference; `none` is bare pixels. */
export type CalSource = 'none' | 'metadata' | 'measured'

export type CalMode = 'distance' | 'diameter'

export interface CalibrationProfile {
  name: string
  pxPerMm: PixelsPerMm
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
      set({ pxPerMm, calSource: 'measured', calibrating: null })
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
      return p ? { pxPerMm: { ...p.pxPerMm }, calSource: 'measured' } : {}
    }),

  deleteProfile: (name) =>
    set((s) => {
      const profiles = s.profiles.filter((p) => p.name !== name)
      storeProfiles(profiles)
      return { profiles }
    }),
}))

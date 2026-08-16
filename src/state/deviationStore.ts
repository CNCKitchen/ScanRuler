// SPDX-License-Identifier: AGPL-3.0-only
import { create } from 'zustand'
import type { AlignResult, PointPair } from '../core/deviation/align'
import type { DeviationStats } from '../core/deviation/deviation'
import type { FieldHistogram } from '../core/field/stats'
import type { StepInfo } from '../core/parsers/step'
import type { Vec3 } from '../core/types'
import { PALETTE } from './palette'
import { probeSlice, type Probe, type ProbeSlice } from './probes'

export type { Probe }

/** The three things this tool does. They share the scan, the scene and the
 *  camera; only what is drawn on top of the part differs. */
export type Workspace = 'elements' | 'deviation' | 'thickness'

export type AlignStatus = 'idle' | 'running' | 'done' | 'failed'
export type MapStatus = 'idle' | 'running' | 'ready'

/** Colour of a point pair in the split view — the same pair gets the same
 *  colour on both sides, which is the only thing tying them together visually. */
export function pairColor(index: number): string {
  return PALETTE[index % PALETTE.length]
}

export const BAND_CHOICES = [5, 7, 9, 11, 15, 21] as const

/** The marking for a local fit, in a colour no deviation band can be mistaken
 *  for: the map underneath runs blue → green → red, and the marking has to
 *  read as "chosen" on top of any of it. */
export const MARK_COLOR = '#b5179e'

interface DeviationState extends ProbeSlice {
  workspace: Workspace

  nominalName: string | null
  nominalTriangles: number
  nominalVertices: number
  nominalBusy: boolean
  /** How a STEP reference was tessellated, or null when it arrived as a mesh.
   *  The chord tolerance is a systematic term in every reading taken against a
   *  curved face of it, so it belongs on screen next to the triangle count. */
  nominalStep: StepInfo | null

  alignStatus: AlignStatus
  align: AlignResult | null
  alignMessage: string | null
  /** The last fit that used the whole scan, kept so a local fine fit that went
   *  somewhere unhelpful can be taken back off without starting over. */
  globalAlign: AlignResult | null

  /** The marking tools for a local fine fit are out. Which gesture is live,
   *  what is marked and how wide the brush is belong to the tools themselves —
   *  they are the same tools the elements workspace marks with, and they live
   *  in markStore. */
  marking: boolean
  /** How far a marked point may reach for reference surface during the fine
   *  fit, in mm. Deliberately tight: it is what stops the marked surface from
   *  snapping onto a different feature. */
  localMaxDistance: number

  mapStatus: MapStatus
  stats: DeviationStats | null
  histogram: FieldHistogram | null
  /** Bumped whenever a fresh deviation field lands, so the view repaints. */
  mapVersion: number

  /** Half-width of the colour scale, in mm. Zero is always the centre. */
  range: number
  rangeAuto: boolean
  /** Deviation past this has no counterpart and is not drawn as a measurement. */
  maxDistance: number
  maxDistanceAuto: boolean
  /** Discrete colour bands, or null for a continuous ramp. */
  bands: number | null
  /** The band the "within tolerance" figure counts, in mm. */
  tolerance: number
  showHistogram: boolean
  showNominal: boolean
  showScan: boolean

  /** The split-screen point picker is open. */
  picking: boolean
  pairs: PointPair[]
  /** A scan point clicked but not yet matched on the nominal. */
  pendingScan: Vec3 | null

  setWorkspace: (w: Workspace) => void
  beginNominalLoad: (name: string) => void
  finishNominalLoad: (
    name: string,
    vertices: number,
    triangles: number,
    step?: StepInfo | null,
  ) => void
  nominalFailed: () => void
  beginAlign: () => void
  resolveAlign: (r: AlignResult) => void
  failAlign: (message: string) => void
  failLocal: (message: string) => void
  failMap: (message: string) => void
  clearAlign: () => void
  startMarking: () => void
  stopMarking: () => void
  setLocalMaxDistance: (d: number) => void
  revertToGlobal: () => void
  beginMap: () => void
  resolveMap: (range: number, maxDistance: number) => void
  setReadout: (stats: DeviationStats, histogram: FieldHistogram) => void
  setRange: (range: number) => void
  setMaxDistance: (d: number) => void
  setBands: (bands: number | null) => void
  setTolerance: (t: number) => void
  setShowHistogram: (v: boolean) => void
  setShowNominal: (v: boolean) => void
  setShowScan: (v: boolean) => void
  startPicking: () => void
  stopPicking: () => void
  addPickPoint: (side: 'scan' | 'nominal', point: Vec3) => void
  undoPair: () => void
  clearPairs: () => void
}

const CLEARED = {
  alignStatus: 'idle' as AlignStatus,
  align: null,
  alignMessage: null,
  globalAlign: null,
  mapStatus: 'idle' as MapStatus,
  stats: null,
  histogram: null,
  probes: [] as Probe[],
  picking: false,
  pairs: [] as PointPair[],
  pendingScan: null,
  marking: false,
  maxDistanceAuto: true,
}

export const useDeviation = create<DeviationState>()((set, get) => ({
  workspace: 'elements',

  nominalName: null,
  nominalTriangles: 0,
  nominalVertices: 0,
  nominalBusy: false,
  nominalStep: null,

  // The pinned readings and their actions, shared with the thickness store.
  ...probeSlice(set),
  ...CLEARED,
  mapVersion: 0,

  // A millimetre: further than any residual a global fit leaves behind, closer
  // than the next feature on almost any part.
  localMaxDistance: 1,

  range: 0.5,
  rangeAuto: true,
  maxDistance: 3,
  bands: null,
  tolerance: 0.1,
  showHistogram: false,
  // On by default: the reference appears the moment it is loaded so it can be
  // checked for being the right part, and stays visible through the alignment
  // so the fit can be watched. It is switched off once the map exists, since
  // by then the reading is on the scan and the ghost only gets in the way.
  showNominal: true,
  showScan: true,

  setWorkspace: (workspace) => set({ workspace }),

  beginNominalLoad: (name) =>
    set({ nominalBusy: true, nominalName: name, nominalStep: null, ...CLEARED }),

  finishNominalLoad: (nominalName, nominalVertices, nominalTriangles, step = null) =>
    set({
      nominalBusy: false,
      nominalName,
      nominalVertices,
      nominalTriangles,
      nominalStep: step,
      showNominal: true,
    }),

  nominalFailed: () =>
    set({
      nominalBusy: false,
      nominalName: null,
      nominalVertices: 0,
      nominalTriangles: 0,
      nominalStep: null,
    }),

  // Showing the reference again for the duration: the whole point of streaming
  // the intermediate poses is that the fit can be watched happening.
  beginAlign: () => set({ alignStatus: 'running', alignMessage: null, showNominal: true }),

  // A new alignment invalidates the map that was measured under the old one.
  resolveAlign: (align) =>
    set((s) => ({
      alignStatus: 'done',
      align,
      alignMessage: null,
      // A local fit refines whatever whole-scan fit is in hand; it never
      // becomes the thing to fall back to.
      globalAlign: align.source === 'local' ? s.globalAlign : align,
      mapStatus: 'idle',
      stats: null,
      histogram: null,
      probes: [],
    })),

  failAlign: (alignMessage) => set({ alignStatus: 'failed', alignMessage }),

  // A local fit that refuses leaves the alignment it was refining exactly
  // where it was — only the message is new.
  failLocal: (alignMessage) => set({ alignStatus: 'done', alignMessage }),

  // A measurement that refuses leaves no map behind — and must not tear down
  // the alignment it was measured under.
  failMap: (alignMessage) => set({ mapStatus: 'idle', alignMessage }),

  clearAlign: () => set({ ...CLEARED }),

  // Opening the tools arms nothing: the camera keeps its buttons until a
  // gesture is picked, and picking one is one click. The tools themselves are
  // put back to that state by whoever opens the session (App), because the
  // elements workspace opens the same ones.
  startMarking: () => set({ marking: true }),
  stopMarking: () => set({ marking: false }),
  setLocalMaxDistance: (d) => set({ localMaxDistance: Math.max(1e-4, d) }),

  // Back to the whole-scan fit, with the map it implies to be measured again.
  revertToGlobal: () =>
    set((s) =>
      s.globalAlign
        ? {
            align: s.globalAlign,
            alignStatus: 'done',
            alignMessage: null,
            mapStatus: 'idle',
            stats: null,
            histogram: null,
            probes: [],
          }
        : {},
    ),

  beginMap: () => set({ mapStatus: 'running' }),

  // The suggested scale only takes effect while the user has not overridden it;
  // re-measuring a part they have already dialled in should not reset the view.
  resolveMap: (range, maxDistance) =>
    set((s) => ({
      mapStatus: 'ready',
      mapVersion: s.mapVersion + 1,
      range: s.rangeAuto ? range : s.range,
      maxDistance: s.maxDistanceAuto ? maxDistance : s.maxDistance,
      // The map is on the scan now, so the ghost stops earning its place.
      showNominal: false,
      probes: [],
    })),

  setReadout: (stats, histogram) => set({ stats, histogram }),

  setRange: (range) => set({ range: Math.max(1e-4, range), rangeAuto: false }),
  setMaxDistance: (maxDistance) =>
    set({ maxDistance: Math.max(1e-4, maxDistance), maxDistanceAuto: false }),
  setBands: (bands) => set({ bands }),
  setTolerance: (tolerance) => set({ tolerance: Math.max(1e-4, tolerance) }),
  setShowHistogram: (showHistogram) => set({ showHistogram }),
  setShowNominal: (showNominal) => set({ showNominal }),
  setShowScan: (showScan) => set({ showScan }),

  startPicking: () => set({ picking: true, pendingScan: null }),
  stopPicking: () => set({ picking: false, pendingScan: null }),

  // Picks alternate: a point on the scan, then its counterpart on the nominal.
  addPickPoint: (side, point) => {
    const pending = get().pendingScan
    if (side === 'scan') {
      set({ pendingScan: point })
      return
    }
    if (!pending) return
    set((s) => ({ pairs: [...s.pairs, { scan: pending, nominal: point }], pendingScan: null }))
  },

  undoPair: () =>
    set((s) =>
      s.pendingScan ? { pendingScan: null } : { pairs: s.pairs.slice(0, -1) },
    ),

  clearPairs: () => set({ pairs: [], pendingScan: null }),
}))

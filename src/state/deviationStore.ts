// SPDX-License-Identifier: AGPL-3.0-only
import { create } from 'zustand'
import type { AlignResult, PointPair } from '../core/deviation/align'
import type { DeviationStats } from '../core/deviation/deviation'
import type { FieldHistogram } from '../core/field/stats'
import type { Vec3 } from '../core/types'

/** The three things this tool does. They share the scan, the scene and the
 *  camera; only what is drawn on top of the part differs. */
export type Workspace = 'elements' | 'deviation' | 'thickness'

export type AlignStatus = 'idle' | 'running' | 'done' | 'failed'
export type MapStatus = 'idle' | 'running' | 'ready'

/** Colours for the point pairs in the split view — the same pair gets the same
 *  colour on both sides, which is the only thing tying them together visually. */
const PAIR_COLORS = ['#1877c0', '#e8590c', '#2e7d46', '#b5179e', '#c99a0a', '#0f9b9b', '#b3361c', '#6d4bbd']

export function pairColor(index: number): string {
  return PAIR_COLORS[index % PAIR_COLORS.length]
}

export const BAND_CHOICES = [5, 7, 9, 11, 15, 21] as const

/** A deviation reading pinned to a spot on the part. */
export interface Probe {
  id: number
  point: Vec3
  value: number
}

interface DeviationState {
  workspace: Workspace

  nominalName: string | null
  nominalTriangles: number
  nominalVertices: number
  nominalBusy: boolean

  alignStatus: AlignStatus
  align: AlignResult | null
  alignMessage: string | null

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
  /** Discrete colour bands, or null for a continuous ramp. */
  bands: number | null
  /** The band the "within tolerance" figure counts, in mm. */
  tolerance: number
  showHistogram: boolean
  showNominal: boolean
  showScan: boolean

  /** Readings pinned to the part by clicking it. */
  probes: Probe[]
  nextProbeId: number

  /** The split-screen point picker is open. */
  picking: boolean
  pairs: PointPair[]
  /** A scan point clicked but not yet matched on the nominal. */
  pendingScan: Vec3 | null

  setWorkspace: (w: Workspace) => void
  beginNominalLoad: (name: string) => void
  finishNominalLoad: (name: string, vertices: number, triangles: number) => void
  nominalFailed: () => void
  beginAlign: () => void
  resolveAlign: (r: AlignResult) => void
  failAlign: (message: string) => void
  clearAlign: () => void
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
  addProbe: (point: Vec3, value: number) => void
  removeProbe: (id: number) => void
  clearProbes: () => void
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
  mapStatus: 'idle' as MapStatus,
  stats: null,
  histogram: null,
  probes: [] as Probe[],
  picking: false,
  pairs: [] as PointPair[],
  pendingScan: null,
}

export const useDeviation = create<DeviationState>()((set, get) => ({
  workspace: 'elements',

  nominalName: null,
  nominalTriangles: 0,
  nominalVertices: 0,
  nominalBusy: false,

  ...CLEARED,
  mapVersion: 0,
  nextProbeId: 1,

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
    set({ nominalBusy: true, nominalName: name, ...CLEARED }),

  finishNominalLoad: (nominalName, nominalVertices, nominalTriangles) =>
    set({ nominalBusy: false, nominalName, nominalVertices, nominalTriangles, showNominal: true }),

  nominalFailed: () =>
    set({ nominalBusy: false, nominalName: null, nominalVertices: 0, nominalTriangles: 0 }),

  // Showing the reference again for the duration: the whole point of streaming
  // the intermediate poses is that the fit can be watched happening.
  beginAlign: () => set({ alignStatus: 'running', alignMessage: null, showNominal: true }),

  // A new alignment invalidates the map that was measured under the old one.
  resolveAlign: (align) =>
    set({
      alignStatus: 'done',
      align,
      alignMessage: null,
      mapStatus: 'idle',
      stats: null,
      histogram: null,
      probes: [],
    }),

  failAlign: (alignMessage) => set({ alignStatus: 'failed', alignMessage }),

  clearAlign: () => set({ ...CLEARED }),

  beginMap: () => set({ mapStatus: 'running' }),

  // The suggested scale only takes effect while the user has not overridden it;
  // re-measuring a part they have already dialled in should not reset the view.
  resolveMap: (range, maxDistance) =>
    set((s) => ({
      mapStatus: 'ready',
      mapVersion: s.mapVersion + 1,
      range: s.rangeAuto ? range : s.range,
      maxDistance: s.mapVersion === 0 ? maxDistance : s.maxDistance,
      // The map is on the scan now, so the ghost stops earning its place.
      showNominal: false,
      probes: [],
    })),

  setReadout: (stats, histogram) => set({ stats, histogram }),

  setRange: (range) => set({ range: Math.max(1e-4, range), rangeAuto: false }),
  setMaxDistance: (maxDistance) => set({ maxDistance: Math.max(1e-4, maxDistance) }),
  setBands: (bands) => set({ bands }),
  setTolerance: (tolerance) => set({ tolerance: Math.max(1e-4, tolerance) }),
  setShowHistogram: (showHistogram) => set({ showHistogram }),
  setShowNominal: (showNominal) => set({ showNominal }),
  setShowScan: (showScan) => set({ showScan }),

  addProbe: (point, value) =>
    set((s) => ({
      probes: [...s.probes, { id: s.nextProbeId, point, value }],
      nextProbeId: s.nextProbeId + 1,
    })),

  removeProbe: (id) => set((s) => ({ probes: s.probes.filter((p) => p.id !== id) })),

  clearProbes: () => set({ probes: [] }),

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

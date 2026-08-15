// SPDX-License-Identifier: AGPL-3.0-only
// Everything the wall thickness workspace knows. It shares the loaded scan
// with the other two — and the Probe, the band choices and the map status with
// the deviation workspace, because a pinned reading and a colour scale mean
// the same thing whichever map they are read off.
//
// The settings split in two: what shapes the search, which only takes effect
// when the part is measured again, and what shapes the reading, which takes
// effect the moment it changes.

import { create } from 'zustand'
import type { FieldHistogram } from '../core/field/stats'
import {
  DEFAULT_CONE_ANGLE_DEG,
  DEFAULT_NORMAL_DEVIATION_DEG,
  defaultMaxThickness,
  type ThicknessMethod,
  type ThicknessStats,
} from '../core/thickness/thickness'
import type { Vec3 } from '../core/types'
import type { MapStatus, Probe } from './deviationStore'

/** How hard the ray method works at each vertex. A single ray down the normal
 *  is exact wherever the two faces of a wall are parallel and fast enough to
 *  be the default; a cone finds the short way across a chamfer or a tapered
 *  rib, and costs its ray count. */
export const CONE_CHOICES = [
  { rays: 0, label: 'Single ray — fast' },
  { rays: 6, label: '6-ray cone — tighter' },
  { rays: 12, label: '12-ray cone — tightest' },
] as const

interface ThicknessState {
  status: MapStatus
  message: string | null
  stats: ThicknessStats | null
  histogram: FieldHistogram | null
  /** Bumped whenever a fresh thickness field lands, so the view repaints. */
  mapVersion: number

  // ---- what shapes the search -------------------------------------------
  method: ThicknessMethod
  /** Nothing thicker than this is measured, and no ray looks further. */
  maxThickness: number
  maxThicknessAuto: boolean
  coneRays: number
  coneAngleDeg: number
  /** How far a surface may be from facing the ray and still count as the
   *  other side of a wall; null accepts whatever is hit first. */
  normalDeviationDeg: number | null

  // ---- what shapes the reading ------------------------------------------
  /** Ends of the colour scale, in mm, when the thickness is mapped for
   *  itself. Unlike deviation there is no natural centre, so both are set. */
  low: number
  high: number
  scaleAuto: boolean
  /** Discrete colour bands, or null for a continuous ramp. */
  bands: number | null
  /** The wall thickness the "under" figure counts below, in mm. */
  limit: number
  showHistogram: boolean

  probes: Probe[]
  nextProbeId: number

  begin: () => void
  resolve: (low: number, high: number) => void
  fail: (message: string) => void
  setReadout: (stats: ThicknessStats, histogram: FieldHistogram) => void
  setMethod: (m: ThicknessMethod) => void
  setMaxThickness: (v: number) => void
  /** Size the search to a part just loaded, unless the user has said what it
   *  should be. */
  suggestMaxThickness: (bboxDiagonal: number) => void
  setConeRays: (rays: number) => void
  setConeAngle: (deg: number) => void
  setNormalDeviation: (deg: number | null) => void
  setLow: (v: number) => void
  setHigh: (v: number) => void
  setBands: (bands: number | null) => void
  setLimit: (v: number) => void
  setShowHistogram: (v: boolean) => void
  addProbe: (point: Vec3, value: number) => void
  removeProbe: (id: number) => void
  clearProbes: () => void
  /** A different scan has nothing to do with the map measured on the last one. */
  clear: () => void
}

const CLEARED = {
  status: 'idle' as MapStatus,
  message: null,
  stats: null,
  histogram: null,
  probes: [] as Probe[],
}

export const useThickness = create<ThicknessState>()((set) => ({
  ...CLEARED,
  mapVersion: 0,
  nextProbeId: 1,

  method: 'ray' as ThicknessMethod,
  maxThickness: 10,
  maxThicknessAuto: true,
  coneRays: 0,
  coneAngleDeg: DEFAULT_CONE_ANGLE_DEG,
  normalDeviationDeg: DEFAULT_NORMAL_DEVIATION_DEG,

  low: 0,
  high: 3,
  scaleAuto: true,
  bands: null,
  limit: 1,
  showHistogram: false,

  begin: () => set({ status: 'running', message: null }),

  // The suggested scale only takes effect while the user has not overridden
  // it; re-measuring a part they have already dialled in should not reset the
  // view. The thin-wall limit is theirs from the start — it is a
  // specification, not a property of this particular scan.
  resolve: (low, high) =>
    set((s) => ({
      status: 'ready',
      message: null,
      mapVersion: s.mapVersion + 1,
      low: s.scaleAuto ? low : s.low,
      high: s.scaleAuto ? high : s.high,
      probes: [],
    })),

  fail: (message) => set({ status: 'idle', message }),

  setReadout: (stats, histogram) => set({ stats, histogram }),

  setMethod: (method) => set({ method }),

  setMaxThickness: (maxThickness) =>
    set({ maxThickness: Math.max(1e-3, maxThickness), maxThicknessAuto: false }),

  suggestMaxThickness: (bboxDiagonal) =>
    set((s) => (s.maxThicknessAuto ? { maxThickness: defaultMaxThickness(bboxDiagonal) } : {})),

  setConeRays: (coneRays) => set({ coneRays }),
  setConeAngle: (coneAngleDeg) => set({ coneAngleDeg: Math.min(89, Math.max(0, coneAngleDeg)) }),
  setNormalDeviation: (normalDeviationDeg) =>
    set({
      normalDeviationDeg:
        normalDeviationDeg === null ? null : Math.min(90, Math.max(0, normalDeviationDeg)),
    }),

  // The two ends may not cross: a scale that runs backwards paints nothing
  // meaningful, so each end pushes the other ahead of it instead.
  setLow: (low) =>
    set((s) => ({
      low: Math.max(0, low),
      high: Math.max(s.high, Math.max(0, low) + 1e-3),
      scaleAuto: false,
    })),

  setHigh: (high) =>
    set((s) => ({
      high: Math.max(1e-3, high),
      low: Math.min(s.low, Math.max(1e-3, high) - 1e-3),
      scaleAuto: false,
    })),

  setBands: (bands) => set({ bands }),
  setLimit: (limit) => set({ limit: Math.max(1e-4, limit) }),
  setShowHistogram: (showHistogram) => set({ showHistogram }),

  addProbe: (point, value) =>
    set((s) => ({
      probes: [...s.probes, { id: s.nextProbeId, point, value }],
      nextProbeId: s.nextProbeId + 1,
    })),

  removeProbe: (id) => set((s) => ({ probes: s.probes.filter((p) => p.id !== id) })),

  clearProbes: () => set({ probes: [] }),

  clear: () => set({ ...CLEARED }),
}))

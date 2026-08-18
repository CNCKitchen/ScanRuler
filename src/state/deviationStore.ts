// SPDX-License-Identifier: AGPL-3.0-only
import { create } from 'zustand'
import type { AlignResult, PointPair } from '../core/deviation/align'
import { MAX_AUTO_RANGE, type DeviationStats } from '../core/deviation/deviation'
import { DEFAULT_FACING_DEG, type MaterialSide } from '../core/deviation/elementField'
import type { FieldHistogram } from '../core/field/stats'
import type { StepInfo } from '../core/parsers/step'
import type { Vec3 } from '../core/types'
import { PALETTE } from './palette'
import { probeSlice, type Probe, type ProbeSlice } from './probes'

export type { Probe }

/** The three things this tool does. They share the scan, the scene and the
 *  camera; only what is drawn on top of the part differs. */
export type Workspace = 'elements' | 'deviation' | 'thickness'

/** What the scan's deviation is measured against. Both produce the same map —
 *  signed millimetres per scan vertex, read through the same colour scale — and
 *  differ entirely in what it takes to get there: a reference part has to be
 *  loaded and best-fitted first, while an element was measured on this scan and
 *  is already in its frame, so choosing one is the whole setup. */
export type DeviationSource = 'reference' | 'element'

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
  source: DeviationSource

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

  /** Which fitted element the scan is measured against, in element mode. */
  targetId: number | null
  /** Which side of that element the material lies on — detected from the scan
   *  when the element is chosen, and flippable when the detection is wrong. */
  targetSide: MaterialSide
  /** How far a scan normal may be from facing the way the element faces, in
   *  degrees; null accepts anything within the element. */
  targetFacingDeg: number | null
  /** The element map keeps its own status and version, because the two maps are
   *  held side by side: switching what the scan is measured against must not
   *  throw away the map that is not on screen. */
  elementStatus: MapStatus
  elementVersion: number
  /** Which part of the scan the element map covers: everything the element
   *  bounds, or only a surface marked by hand with the selection tools. The
   *  marked vertices themselves live in a ref beside the field (they are one
   *  large typed array); this is the choice, the count for the panel, and a
   *  version to recompute off. The scope survives a change of target — the
   *  same region measured against several elements is the point of it. */
  targetScope: 'all' | 'marked'
  scopeCount: number
  scopeVersion: number
  /** The element being measured against is drawn over the map. */
  showElement: boolean

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
  /** Whether the measured map is painted onto the scan at all. Off leaves the
   *  bare surface to be looked at — the shape of the part rather than the
   *  reading on it — and takes nothing away: the map stays measured, and the
   *  figures, the hover reading and the pins go on reporting it. */
  showMap: boolean
  /** Scan and reference side by side, in two viewports held in one pose. */
  split: boolean

  /** The split-screen point picker is open. */
  picking: boolean
  pairs: PointPair[]
  /** A scan point clicked but not yet matched on the nominal. */
  pendingScan: Vec3 | null

  setWorkspace: (w: Workspace) => void
  setSource: (s: DeviationSource) => void
  /** Measure against this element, with the material side just detected for it.
   *  Null when the choice is cleared, or when the element it named is gone. */
  setTarget: (id: number | null, side?: MaterialSide) => void
  flipTargetSide: () => void
  setTargetFacing: (deg: number | null) => void
  /** A fresh element field has landed. Cheap enough to be computed on the main
   *  thread, so unlike the reference map there is no running state to pass
   *  through — it is ready by the time anything can ask. */
  resolveElementMap: (range: number) => void
  clearElementMap: () => void
  setShowElement: (v: boolean) => void
  setTargetScope: (scope: 'all' | 'marked') => void
  /** The marked region changed — whoever owns the vertex array has updated it;
   *  this records how many vertices it holds and triggers the recompute. */
  markScope: (count: number) => void
  /** Back to measuring everywhere, marked region discarded. */
  clearScope: () => void
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
  setShowMap: (v: boolean) => void
  setSplit: (v: boolean) => void
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

/** The element map and the choice behind it. Cleared on its own: a new
 *  reference part has nothing to do with a map measured against an element, and
 *  the other way round. Only a new scan takes both.
 *
 *  The figures under the scale and the pinned readings are shared with the
 *  reference map — whichever is on screen owns them — so they are cleared here
 *  only when the element map is the one being read. */
const NO_TARGET = {
  targetId: null,
  targetSide: 1 as MaterialSide,
  elementStatus: 'idle' as MapStatus,
}

/** The readout belongs to the map on screen; nulling it while the other map is
 *  being read would blank a legend that is still perfectly good. */
function clearedReadout(shown: boolean) {
  return shown ? { stats: null, histogram: null, probes: [] as Probe[] } : {}
}

export const useDeviation = create<DeviationState>()((set, get) => ({
  workspace: 'elements',
  source: 'reference',

  nominalName: null,
  nominalTriangles: 0,
  nominalVertices: 0,
  nominalBusy: false,
  nominalStep: null,

  // The pinned readings and their actions, shared with the thickness store.
  ...probeSlice(set),
  ...CLEARED,
  ...NO_TARGET,
  mapVersion: 0,
  elementVersion: 0,
  targetScope: 'all',
  scopeCount: 0,
  scopeVersion: 0,
  targetFacingDeg: DEFAULT_FACING_DEG,
  // On, and it earns its place: the map is measured against a surface that is
  // nowhere on the part, so without the element drawn there is no way to see
  // where the zero of the scale actually is.
  showElement: true,

  // A millimetre: further than any residual a global fit leaves behind, closer
  // than the next feature on almost any part.
  localMaxDistance: 1,

  // The widest the scale ever opens by itself — see MAX_AUTO_RANGE. Starting
  // there rather than tighter means the first map a session measures is never
  // read off a scale narrower than the one the tool would have chosen.
  range: MAX_AUTO_RANGE,
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
  showMap: true,
  split: false,

  setWorkspace: (workspace) => set({ workspace }),

  // Both maps stay measured, so switching back and forth costs nothing. The
  // pinned readings do not: a reading off one map and a reading off the other
  // are both millimetres on the same part and look identical on it, so keeping
  // them would be a way to misread one for the other.
  setSource: (source) => set({ source, probes: [], stats: null, histogram: null }),

  // A different element is a different measurement — the map on the old one goes
  // with the choice, and the field itself is recomputed by whoever owns it.
  //
  // Choosing the element already in use has to be nothing at all, not a reset:
  // the map is recomputed off a change to the choice, so putting the status back
  // to idle when the choice has not moved would take the map away and leave
  // nothing to bring it back.
  setTarget: (targetId, side = 1) =>
    set((s) =>
      s.targetId === targetId && s.targetSide === side
        ? {}
        : {
            ...NO_TARGET,
            targetId,
            targetSide: side,
            ...clearedReadout(s.source === 'element'),
          },
    ),

  flipTargetSide: () => set((s) => ({ targetSide: s.targetSide === 1 ? -1 : 1 })),

  setTargetFacing: (targetFacingDeg) =>
    set({
      targetFacingDeg:
        targetFacingDeg === null ? null : Math.min(90, Math.max(1, targetFacingDeg)),
    }),

  // Same bargain as the reference map: the suggested scale only takes effect
  // while the user has not overridden it.
  //
  // The scale and the pins belong to whichever map is being read, and this one
  // is also recomputed behind the reference map whenever the element it measures
  // against changes under it — so neither is touched unless it is this map's.
  resolveElementMap: (range) =>
    set((s) => ({
      elementStatus: 'ready',
      elementVersion: s.elementVersion + 1,
      ...(s.source === 'element' ? { range: s.rangeAuto ? range : s.range, probes: [] } : {}),
    })),

  clearElementMap: () =>
    set((s) => ({ ...NO_TARGET, ...clearedReadout(s.source === 'element') })),

  setShowElement: (showElement) => set({ showElement }),

  setTargetScope: (targetScope) => set({ targetScope }),

  markScope: (scopeCount) =>
    set((s) => ({ scopeCount, scopeVersion: s.scopeVersion + 1 })),

  clearScope: () =>
    set((s) => ({ targetScope: 'all', scopeCount: 0, scopeVersion: s.scopeVersion + 1 })),

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
  setShowMap: (showMap) => set({ showMap }),

  // The left half is the scan, so opening the split view with the scan switched
  // off would open onto an empty half — the switch goes back on with it.
  setSplit: (split) => set(split ? { split, showScan: true } : { split }),

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

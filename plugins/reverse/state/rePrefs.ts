// SPDX-License-Identifier: AGPL-3.0-only
// The Reverse engineer workspace's settings: how the operator likes to draw
// and see, in this browser — the same rule the app's own settings follow
// (src/state/prefsStore.ts). Each is remembered under the key it has always
// had, so nothing an operator set is lost, and falls back to the default
// when storage is unavailable or holds something this version cannot read.

import { create } from 'zustand'
import { sanitizeFitOptions, type FitOptions } from '../core/fitOptions'
import { LIVE_MAP_MIN_RANGE_MM, LIVE_MAP_RANGE_MM } from '../core/liveMap'
import { DEFAULT_DRAW_MODES, type DrawModes } from '../core/draw'
import { POLYGON_MAX_SIDES } from '../core/sketch'
import { meshResolution, type MeshResolution } from '../core/meshResolution'

const GRID_SNAP_KEY = 'scanruler.gridsnap'
const SKETCH_RELATIONS_KEY = 'scanruler.sketchrelations'
const FIT_OPTIONS_KEY = 'scanruler.fitoptions'
const LIVE_MAP_KEY = 'scanruler.livemap'
const LIVE_MAP_RANGE_KEY = 'scanruler.livemaprange'
const DRAW_MODES_KEY = 'scanruler.drawmodes'
const POLYGON_SIDES_KEY = 'scanruler.polygonsides'
const PLAYBACK_STEP_KEY = 'scanruler.playbackstep'
const PLAYBACK_CAPTION_KEY = 'scanruler.playbackcaption'
const PLAYBACK_SKIP_SKETCHES_KEY = 'scanruler.playbackskipsketches'
const MESH_RESOLUTION_KEY = 'scanruler.meshresolution'

/** How long the playback holds each step, in milliseconds, once its build
 *  has landed — the choices the panel offers. */
export const PLAYBACK_STEPS_MS = [500, 1000, 1500, 2000, 3000, 5000] as const
const clampPlaybackStep = (ms: number): number => (Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 60_000) : 1500)

/** A polygon's sides, a whole number from three up — six, a hexagon, when
 *  nothing sensible was given. */
function clampSides(n: number): number {
  return Number.isFinite(n) && n >= 3 ? Math.min(POLYGON_MAX_SIDES, Math.round(n)) : 6
}

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    // Storage blocked: every preference reads as its default.
    return null
  }
}

const write = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Not being able to remember the choice is no reason to refuse it — the
    // setting still holds for this session.
  }
}

/** A stored or typed range, or the default when it is not a usable one. */
const clampLiveMapRange = (mm: number): number =>
  Number.isFinite(mm) && mm >= LIVE_MAP_MIN_RANGE_MM ? Math.min(mm, 100) : LIVE_MAP_RANGE_MM

function storedFitOptions(): FitOptions {
  try {
    return sanitizeFitOptions(JSON.parse(read(FIT_OPTIONS_KEY) ?? 'null'))
  } catch {
    return sanitizeFitOptions(null)
  }
}

/** The stored ways of drawing, each one this version knows or its default. */
function storedDrawModes(): DrawModes {
  const known: { [K in keyof DrawModes]: readonly DrawModes[K][] } = {
    rectangle: ['corners', 'center', 'threePoint'],
    circle: ['center', 'twoPoint', 'threePoint'],
    arc: ['threePoint', 'center'],
    polygon: ['inscribed', 'circumscribed'],
  }
  let stored: Partial<Record<keyof DrawModes, unknown>> = {}
  try {
    stored = JSON.parse(read(DRAW_MODES_KEY) ?? '{}') ?? {}
  } catch {
    stored = {}
  }
  const pick = <K extends keyof DrawModes>(k: K): DrawModes[K] =>
    (known[k] as readonly unknown[]).includes(stored[k]) ? (stored[k] as DrawModes[K]) : DEFAULT_DRAW_MODES[k]
  return { rectangle: pick('rectangle'), circle: pick('circle'), arc: pick('arc'), polygon: pick('polygon') }
}

interface RePrefsState {
  /** Whether a point drawn on the sketch sheet snaps to the grid as well as
   *  to ends, the slice and pieces. Off by default: the grid is there to read
   *  against, and a scan's own points are what a profile is drawn to; a hand
   *  that wants round numbers switches it on with the key by the sketch
   *  tools. */
  gridSnap: boolean
  /** Whether the relations of a sketch are drawn beside their pieces as
   *  glyphs. Off by default: a fitted profile carries a join and a tangency
   *  at every corner, and the glyphs bury the drawing; the list in the panel
   *  has them all, and a relation selected there shows its glyph. */
  sketchRelations: boolean
  /** How Fit all chains cuts a slice — the Fit options window's fields, see
   *  core/fitOptions.ts. */
  fitOptions: FitOptions
  /** Whether the ghost of a feature being set up colours the scan near it by
   *  its deviation, and the range the ramp reads at, ± millimetres. On by
   *  default: the map is how the operator sees a feature settle onto the
   *  scan. */
  liveMap: boolean
  liveMapRange: number
  /** How the rectangle, the circle and the arc are drawn — two corners or
   *  centre and corner, and so on; each tool keeps the way last chosen. */
  drawModes: DrawModes
  /** How many sides the Polygon tool draws. */
  polygonSides: number
  /** How long the feature list's playback holds each step once it is
   *  built, whether the viewport carries a caption naming the step, and
   *  whether the sketches' steps are passed over — only a step that changes
   *  the geometry shown. */
  playbackStepMs: number
  playbackCaption: boolean
  playbackSkipSketches: boolean
  /** How finely Export mesh meshes the bodies — see core/meshResolution. */
  meshResolution: MeshResolution['id']
  setGridSnap: (on: boolean) => void
  setSketchRelations: (on: boolean) => void
  setFitOptions: (options: FitOptions) => void
  setLiveMap: (on: boolean) => void
  setLiveMapRange: (mm: number) => void
  setDrawMode: <K extends keyof DrawModes>(tool: K, mode: DrawModes[K]) => void
  setPolygonSides: (sides: number) => void
  setPlaybackStepMs: (ms: number) => void
  setPlaybackCaption: (on: boolean) => void
  setPlaybackSkipSketches: (on: boolean) => void
  setMeshResolution: (id: MeshResolution['id']) => void
}

export const useRePrefs = create<RePrefsState>()((set) => ({
  gridSnap: read(GRID_SNAP_KEY) === '1',
  sketchRelations: read(SKETCH_RELATIONS_KEY) === '1',
  fitOptions: storedFitOptions(),
  liveMap: read(LIVE_MAP_KEY) !== '0',
  liveMapRange: clampLiveMapRange(Number(read(LIVE_MAP_RANGE_KEY))),
  drawModes: storedDrawModes(),
  polygonSides: clampSides(Number(read(POLYGON_SIDES_KEY) ?? 6)),
  playbackStepMs: clampPlaybackStep(Number(read(PLAYBACK_STEP_KEY) ?? 1500)),
  playbackCaption: read(PLAYBACK_CAPTION_KEY) !== '0',
  playbackSkipSketches: read(PLAYBACK_SKIP_SKETCHES_KEY) === '1',
  meshResolution: meshResolution(read(MESH_RESOLUTION_KEY) ?? undefined).id,

  setGridSnap: (gridSnap) => {
    write(GRID_SNAP_KEY, gridSnap ? '1' : '0')
    set({ gridSnap })
  },
  setSketchRelations: (sketchRelations) => {
    write(SKETCH_RELATIONS_KEY, sketchRelations ? '1' : '0')
    set({ sketchRelations })
  },
  setFitOptions: (options) => {
    const fitOptions = sanitizeFitOptions(options)
    write(FIT_OPTIONS_KEY, JSON.stringify(fitOptions))
    set({ fitOptions })
  },
  setLiveMap: (liveMap) => {
    write(LIVE_MAP_KEY, liveMap ? '1' : '0')
    set({ liveMap })
  },
  setLiveMapRange: (mm) => {
    const liveMapRange = clampLiveMapRange(mm)
    write(LIVE_MAP_RANGE_KEY, String(liveMapRange))
    set({ liveMapRange })
  },
  setDrawMode: (tool, mode) =>
    set((s) => {
      const drawModes = { ...s.drawModes, [tool]: mode }
      write(DRAW_MODES_KEY, JSON.stringify(drawModes))
      return { drawModes }
    }),
  setPolygonSides: (sides) => {
    const polygonSides = clampSides(sides)
    write(POLYGON_SIDES_KEY, String(polygonSides))
    set({ polygonSides })
  },
  setPlaybackStepMs: (ms) => {
    const playbackStepMs = clampPlaybackStep(ms)
    write(PLAYBACK_STEP_KEY, String(playbackStepMs))
    set({ playbackStepMs })
  },
  setPlaybackCaption: (playbackCaption) => {
    write(PLAYBACK_CAPTION_KEY, playbackCaption ? '1' : '0')
    set({ playbackCaption })
  },
  setPlaybackSkipSketches: (playbackSkipSketches) => {
    write(PLAYBACK_SKIP_SKETCHES_KEY, playbackSkipSketches ? '1' : '0')
    set({ playbackSkipSketches })
  },
  setMeshResolution: (id) => {
    const res = meshResolution(id).id
    write(MESH_RESOLUTION_KEY, res)
    set({ meshResolution: res })
  },
}))

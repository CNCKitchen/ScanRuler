// SPDX-License-Identifier: AGPL-3.0-only
// One set of rules for every map the tool paints on the scan: the deviation
// from a nominal part, and the wall thickness of the part itself. Only the
// domain and its direction differ, so both are described by a FieldScale and
// painted by the same loop — through whichever colour map the operator has
// chosen in the settings, the same one for every map and every legend.

import { CIVIDIS, INFERNO, MAGMA, MAKO, PLASMA, ROCKET, TURBO, VIRIDIS } from './colormapData'

export type Rgb = readonly [number, number, number]

/** The unmeasured scan surface: a machined-aluminium grey. Doubles as the
 *  "nothing to measure here" colour on any map, which is the point — an
 *  unmeasured patch should read as bare material, not as a measurement. The
 *  same on every colour map, and on none of them. */
export const UNMEASURED_RGB: Rgb = [126, 131, 138]

export type ColormapId =
  | 'jet'
  | 'viridis'
  | 'magma'
  | 'plasma'
  | 'inferno'
  | 'cividis'
  | 'mako'
  | 'rocket'
  | 'turbo'

/** A ramp, and the two colours that stand beyond its ends. */
export interface Colormap {
  id: ColormapId
  label: string
  /** What it looks like and what it is for, in a line. */
  hint: string
  /** Evenly spaced colours from the low end of the ramp to the high, three
   *  bytes each, read between by straight lines. */
  stops: Uint8Array
  /** Caps for a reading that is real but off the end of the scale: past the
   *  low end of the ramp, and past the high. Each map's own, and colours it
   *  never uses itself, so a value that is off-scale is never confused with
   *  one that is merely large — the dark red past jet's red would be lost
   *  against turbo's dark red end, and its dark blue against viridis' dark
   *  purple start. Blue below and red above where the ramp leaves those
   *  free, the way jet reads; a ramp that runs through red has green above. */
  under: Rgb
  over: Rgb
}

/** Jet, pinned so that the middle of the scale is green.
 *
 *  Plain MATLAB jet puts a washed-out (128, 255, 128) at its midpoint, which
 *  is a poor place to hang the most important reading on a deviation scale.
 *  These stops keep jet's blue → cyan → green → yellow → red progression and
 *  its symmetry, but land a saturated green exactly in the middle, the way
 *  inspection software does — orange falls out of the yellow→red leg on its
 *  own, and its mirror, a light blue, out of the cyan→blue leg. */
const JET = Uint8Array.from([0, 0, 255, 0, 255, 255, 0, 200, 0, 255, 255, 0, 255, 0, 0])

const BLUE: Rgb = [0, 0, 255]
const RED: Rgb = [220, 0, 0]
const GREEN: Rgb = [0, 190, 0]

/** Every map the settings offer, in the order they offer them: jet, which
 *  the tool has always painted, then the eight of the viridis family in the
 *  order the R package introduces them. */
export const COLORMAPS: readonly Colormap[] = [
  {
    id: 'jet',
    label: 'Jet',
    hint: 'Blue through cyan, green and yellow to red, a saturated green in the middle — the inspection-software classic. Uneven in lightness, so cyan and yellow show as bands the part does not have',
    stops: JET,
    under: [0, 0, 110],
    over: [130, 0, 0],
  },
  {
    id: 'viridis',
    label: 'Viridis',
    hint: 'Dark blue through teal and green to yellow. Perceptually uniform — an even step in the reading is an even step in colour — and as legible to colour-blind eyes and in greyscale',
    stops: VIRIDIS,
    under: BLUE,
    over: RED,
  },
  {
    id: 'magma',
    label: 'Magma',
    hint: 'Black through purple and pink to pale cream. Perceptually uniform and colour-blind safe',
    stops: MAGMA,
    under: BLUE,
    over: GREEN,
  },
  {
    id: 'plasma',
    label: 'Plasma',
    hint: 'Indigo through magenta and orange to yellow — no black end. Perceptually uniform and colour-blind safe',
    stops: PLASMA,
    under: [0, 0, 0],
    over: GREEN,
  },
  {
    id: 'inferno',
    label: 'Inferno',
    hint: 'Black through purple, red and orange to pale yellow. Perceptually uniform and colour-blind safe',
    stops: INFERNO,
    under: BLUE,
    over: GREEN,
  },
  {
    id: 'cividis',
    label: 'Cividis',
    hint: 'Navy through grey to yellow, made to look the same to red–green colour blindness as to anyone else. Perceptually uniform',
    stops: CIVIDIS,
    under: BLUE,
    over: RED,
  },
  {
    id: 'mako',
    label: 'Mako',
    hint: 'Black through deep blue and teal to mint. Perceptually uniform and colour-blind safe',
    stops: MAKO,
    under: BLUE,
    over: RED,
  },
  {
    id: 'rocket',
    label: 'Rocket',
    hint: 'Black through purple and red to cream. Perceptually uniform and colour-blind safe',
    stops: ROCKET,
    under: BLUE,
    over: GREEN,
  },
  {
    id: 'turbo',
    label: 'Turbo',
    hint: 'A rainbow like jet, dark blue through green to dark red, but smooth — without the bands jet shows. Not for red–green colour blindness',
    stops: TURBO,
    under: BLUE,
    over: [255, 90, 170],
  },
]

export const DEFAULT_COLORMAP: ColormapId = 'jet'

/** The map with this id, or jet for one this version does not know. */
export function colormapById(id: string | null | undefined): Colormap {
  return COLORMAPS.find((m) => m.id === id) ?? COLORMAPS[0]
}

/** Colour of a position `t` along a map's ramp, `t` clamped to 0…1. */
export function rampColor(map: Colormap, t: number, out: [number, number, number]): void {
  const s = map.stops
  const last = s.length / 3 - 1
  const u = (t <= 0 ? 0 : t >= 1 ? 1 : t) * last
  const i = Math.min(last - 1, Math.floor(u))
  const f = u - i
  const a = i * 3
  out[0] = Math.round(s[a] + (s[a + 3] - s[a]) * f)
  out[1] = Math.round(s[a + 1] + (s[a + 4] - s[a + 1]) * f)
  out[2] = Math.round(s[a + 2] + (s[a + 5] - s[a + 2]) * f)
}

/** Snap a ramp position to the middle of one of `bands` equal steps, so a
 *  continuous map becomes a contour map. */
export function quantize(t: number, bands: number): number {
  if (!(bands >= 2)) return t
  const u = t <= 0 ? 0 : t >= 1 ? 1 : t
  return (Math.min(bands - 1, Math.floor(u * bands)) + 0.5) / bands
}

/** How a field is read as colour: what the ends of the ramp mean, which way
 *  round it runs, and what counts as a measurement at all. */
export interface FieldScale {
  /** Value at the bottom of the legend. */
  low: number
  /** Value at the top. */
  high: number
  /** Number of discrete colour bands, or null for a continuous ramp. */
  bands: number | null
  /** Outside this window there is no measurement — bare material. */
  validMin: number
  validMax: number
  /** Run the ramp from its high end down instead of from its low end up.
   *  Thickness wants it: thin is the alarming end, and alarming is the hot
   *  end of a map — red on jet. */
  reversed?: boolean
}

/** The colours drawn for a measured value below the scale's `low` and above
 *  its `high`: the caps of whichever end of the ramp each of them runs off. */
export function scaleCaps(scale: FieldScale, map: Colormap): { low: Rgb; high: Rgb } {
  return scale.reversed ? { low: map.over, high: map.under } : { low: map.under, high: map.over }
}

/**
 * Per-vertex RGB for a scalar field, written into `out` (3 bytes each).
 *
 * Three distinct outcomes share the map and must stay distinguishable: within
 * the scale gets the ramp; past it but still measured gets the map's cap for
 * that end, so you can see that a real reading went off-scale rather than
 * assuming the surface is simply the end colour; outside the valid window gets
 * the unmeasured grey, because there was nothing there to measure.
 */
export function paintField(values: Float32Array, scale: FieldScale, map: Colormap, out: Uint8Array): void {
  const { low, high, bands, validMin, validMax, reversed } = scale
  const caps = scaleCaps(scale, map)
  const rgb: [number, number, number] = [0, 0, 0]
  const span = high - low
  const inv = span > 0 ? 1 / span : 0
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    let r: number, g: number, b: number
    if (!(v >= validMin && v <= validMax)) {
      r = UNMEASURED_RGB[0]; g = UNMEASURED_RGB[1]; b = UNMEASURED_RGB[2]
    } else if (v > high) {
      r = caps.high[0]; g = caps.high[1]; b = caps.high[2]
    } else if (v < low) {
      r = caps.low[0]; g = caps.low[1]; b = caps.low[2]
    } else {
      let t = (v - low) * inv
      if (reversed) t = 1 - t
      if (bands) t = quantize(t, bands)
      rampColor(map, t, rgb)
      r = rgb[0]; g = rgb[1]; b = rgb[2]
    }
    out[i * 3] = r
    out[i * 3 + 1] = g
    out[i * 3 + 2] = b
  }
}

export function cssRgb(rgb: Rgb): string {
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`
}

/** CSS gradient for a map's ramp, its low end at the far side from `toward`
 *  and its high end at `toward` — the legend's runs up from `low` to `high`,
 *  matching whatever the viewport is showing including the banding and the
 *  direction. */
export function legendGradient(
  map: Colormap,
  bands: number | null,
  reversed = false,
  toward: 'top' | 'right' = 'top',
): string {
  const rgb: [number, number, number] = [0, 0, 0]
  const parts: string[] = []
  const at = (t: number): number => (reversed ? 1 - t : t)
  if (bands && bands >= 2) {
    for (let i = 0; i < bands; i++) {
      rampColor(map, quantize(at((i + 0.5) / bands), bands), rgb)
      const from = ((i / bands) * 100).toFixed(3)
      const to = (((i + 1) / bands) * 100).toFixed(3)
      parts.push(`${cssRgb(rgb)} ${from}% ${to}%`)
    }
  } else {
    for (let i = 0; i <= 64; i++) {
      rampColor(map, at(i / 64), rgb)
      parts.push(`${cssRgb(rgb)} ${((i / 64) * 100).toFixed(2)}%`)
    }
  }
  return `linear-gradient(to ${toward}, ${parts.join(', ')})`
}

// SPDX-License-Identifier: AGPL-3.0-only
// One ramp, one set of rules, for every map the tool paints on the scan: the
// deviation from a nominal part, and the wall thickness of the part itself.
// Only the domain and its direction differ, so both are described by a
// FieldScale and painted by the same loop.

/** The unmeasured scan surface: a machined-aluminium grey. Doubles as the
 *  "nothing to measure here" colour on any map, which is the point — an
 *  unmeasured patch should read as bare material, not as a measurement. */
export const UNMEASURED_RGB: readonly [number, number, number] = [126, 131, 138]

/** Saturated caps for a reading that is real but off the end of the scale,
 *  one for each end of the ramp. Dark enough to be unmistakable against the
 *  ramp's own red and blue, so a value that is merely large is never confused
 *  with one that is off-scale. */
export const RED_CAP_RGB: readonly [number, number, number] = [130, 0, 0]
export const BLUE_CAP_RGB: readonly [number, number, number] = [0, 0, 110]

/** Jet, pinned so that the middle of the scale is green.
 *
 *  Plain MATLAB jet puts a washed-out (128, 255, 128) at its midpoint, which
 *  is a poor place to hang the most important reading on a deviation scale.
 *  These stops keep jet's blue → cyan → green → yellow → red progression and
 *  its symmetry, but land a saturated green exactly in the middle, the way
 *  inspection software does — orange falls out of the yellow→red leg on its
 *  own, and its mirror, a light blue, out of the cyan→blue leg. */
const STOPS: readonly (readonly [number, number, number, number])[] = [
  [0.0, 0, 0, 255],
  [0.25, 0, 255, 255],
  [0.5, 0, 200, 0],
  [0.75, 255, 255, 0],
  [1.0, 255, 0, 0],
]

/** Colour of a position `t` along the ramp, `t` clamped to 0…1. */
export function jet(t: number, out: [number, number, number]): void {
  const u = t <= 0 ? 0 : t >= 1 ? 1 : t
  let i = 0
  while (i < STOPS.length - 2 && u > STOPS[i + 1][0]) i++
  const a = STOPS[i]
  const b = STOPS[i + 1]
  const f = (u - a[0]) / (b[0] - a[0])
  out[0] = Math.round(a[1] + (b[1] - a[1]) * f)
  out[1] = Math.round(a[2] + (b[2] - a[2]) * f)
  out[2] = Math.round(a[3] + (b[3] - a[3]) * f)
}

/** Snap a ramp position to the middle of one of `bands` equal steps, so a
 *  continuous map becomes a contour map. */
export function quantize(t: number, bands: number): number {
  if (!(bands >= 2)) return t
  const u = t <= 0 ? 0 : t >= 1 ? 1 : t
  return (Math.min(bands - 1, Math.floor(u * bands)) + 0.5) / bands
}

/** How a field is read as colour: what the ends of the ramp mean, which way
 *  round it runs, what counts as a measurement at all, and what to draw for a
 *  reading that is real but off either end. */
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
  /** Run the ramp red-to-blue instead of blue-to-red. Thickness wants it:
   *  thin is the alarming end, and alarming is red. */
  reversed?: boolean
  /** Colour for a measured value below `low`, and for one above `high`. */
  capLow: readonly [number, number, number]
  capHigh: readonly [number, number, number]
}

/**
 * Per-vertex RGB for a scalar field, written into `out` (3 bytes each).
 *
 * Three distinct outcomes share the map and must stay distinguishable: within
 * the scale gets the ramp; past it but still measured gets a dark cap, so you
 * can see that a real reading went off-scale rather than assuming the surface
 * is simply the end colour; outside the valid window gets the unmeasured grey,
 * because there was nothing there to measure.
 */
export function paintField(values: Float32Array, scale: FieldScale, out: Uint8Array): void {
  const { low, high, bands, validMin, validMax, reversed, capLow, capHigh } = scale
  const rgb: [number, number, number] = [0, 0, 0]
  const span = high - low
  const inv = span > 0 ? 1 / span : 0
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    let r: number, g: number, b: number
    if (!(v >= validMin && v <= validMax)) {
      r = UNMEASURED_RGB[0]; g = UNMEASURED_RGB[1]; b = UNMEASURED_RGB[2]
    } else if (v > high) {
      r = capHigh[0]; g = capHigh[1]; b = capHigh[2]
    } else if (v < low) {
      r = capLow[0]; g = capLow[1]; b = capLow[2]
    } else {
      let t = (v - low) * inv
      if (reversed) t = 1 - t
      if (bands) t = quantize(t, bands)
      jet(t, rgb)
      r = rgb[0]; g = rgb[1]; b = rgb[2]
    }
    out[i * 3] = r
    out[i * 3 + 1] = g
    out[i * 3 + 2] = b
  }
}

function css(rgb: readonly [number, number, number]): string {
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`
}

/** CSS gradient for the legend, bottom (`low`) to top (`high`), matching
 *  whatever the viewport is showing including the banding and the direction. */
export function legendGradient(bands: number | null, reversed = false): string {
  const rgb: [number, number, number] = [0, 0, 0]
  const parts: string[] = []
  const at = (t: number): number => (reversed ? 1 - t : t)
  if (bands && bands >= 2) {
    for (let i = 0; i < bands; i++) {
      jet(quantize(at((i + 0.5) / bands), bands), rgb)
      const from = ((i / bands) * 100).toFixed(3)
      const to = (((i + 1) / bands) * 100).toFixed(3)
      parts.push(`${css([rgb[0], rgb[1], rgb[2]])} ${from}% ${to}%`)
    }
  } else {
    for (let i = 0; i <= 64; i++) {
      jet(at(i / 64), rgb)
      parts.push(`${css([rgb[0], rgb[1], rgb[2]])} ${((i / 64) * 100).toFixed(2)}%`)
    }
  }
  return `linear-gradient(to top, ${parts.join(', ')})`
}

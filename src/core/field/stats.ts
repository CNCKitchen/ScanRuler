// SPDX-License-Identifier: AGPL-3.0-only
// What any per-vertex scalar field on the scan needs, whichever workspace
// measured it: how to summarise it, how to bin it for the legend's histogram,
// and how to pick a scale that shows the part rather than its worst pixel.
//
// Deviation and wall thickness both come through here, so the two maps are
// read on the same terms and the legend beside them is the same instrument.

/** Vertices whose value falls outside the valid window carry no measurement.
 *  NaN fails every comparison below, so an unmeasured vertex is excluded
 *  without a special case. */
export interface FieldStats {
  /** Vertices carrying a real measurement. */
  measured: number
  total: number
  min: number
  max: number
  mean: number
  /** RMS about zero. For a signed field that is the scatter about nominal,
   *  which is the thing being measured against; for a positive one it is
   *  rarely interesting and simply not shown. */
  rms: number
  /** Standard deviation about the mean — the spread once a uniform offset (a
   *  slightly small print, a scanner scale error) is set aside. */
  sigma: number
}

export function fieldStats(
  values: Float32Array,
  validMin: number,
  validMax: number,
): FieldStats {
  let measured = 0
  let min = Infinity
  let max = -Infinity
  let sum = 0
  let sumSq = 0
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (!(v >= validMin && v <= validMax)) continue
    measured++
    if (v < min) min = v
    if (v > max) max = v
    sum += v
    sumSq += v * v
  }
  const mean = measured ? sum / measured : 0
  return {
    measured,
    total: values.length,
    min: measured ? min : 0,
    max: measured ? max : 0,
    mean,
    rms: measured ? Math.sqrt(sumSq / measured) : 0,
    sigma: measured ? Math.sqrt(Math.max(0, sumSq / measured - mean * mean)) : 0,
  }
}

export interface FieldHistogram {
  /** Counts across the colour scale, low to high. Values past either end fold
   *  into the end bins, matching how the ramp caps them. */
  bins: Uint32Array
  low: number
  high: number
  peak: number
}

export function fieldHistogram(
  values: Float32Array,
  low: number,
  high: number,
  validMin: number,
  validMax: number,
  binCount = 60,
): FieldHistogram {
  const bins = new Uint32Array(binCount)
  if (!(high > low)) return { bins, low, high, peak: 0 }
  const scale = binCount / (high - low)
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (!(v >= validMin && v <= validMax)) continue
    const b = Math.floor((v - low) * scale)
    bins[b < 0 ? 0 : b >= binCount ? binCount - 1 : b]++
  }
  let peak = 0
  for (let i = 0; i < binCount; i++) if (bins[i] > peak) peak = bins[i]
  return { bins, low, high, peak }
}

/**
 * Percentiles of a field, from a strided sample.
 *
 * The extremes of a scan are usually a handful of points on a fixture edge or
 * a stray bit of turntable, and scaling a colour ramp to them flattens the
 * whole part to one colour. A percentile keeps the map readable and leaves the
 * genuine outliers visible as capped colour, which is a more honest signal
 * than a scale nothing reaches.
 *
 * The answer only needs to be stable, not exact; on a million-vertex scan
 * every eighth point gives the same figure for a fraction of the sort.
 */
export function fieldPercentiles(
  values: Float32Array,
  validMin: number,
  validMax: number,
  fractions: readonly number[],
  magnitude = false,
): number[] {
  const sample: number[] = []
  const stride = Math.max(1, Math.floor(values.length / 200_000))
  for (let i = 0; i < values.length; i += stride) {
    const v = values[i]
    if (!(v >= validMin && v <= validMax)) continue
    sample.push(magnitude ? Math.abs(v) : v)
  }
  if (sample.length === 0) return fractions.map(() => NaN)
  sample.sort((a, b) => a - b)
  return fractions.map(
    (f) => sample[Math.min(sample.length - 1, Math.max(0, Math.floor(sample.length * f)))],
  )
}

const NICE_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]

/** Round up to a value a person would have chosen for the end of a scale. */
export function niceCeil(x: number): number {
  if (!(x > 0)) return 0.1
  const exp = Math.floor(Math.log10(x))
  const m = x / Math.pow(10, exp)
  for (const step of NICE_STEPS) if (m <= step + 1e-9) return scaleByDecade(step, exp)
  return scaleByDecade(10, exp)
}

/**
 * `step * 10^exp` without the binary-float crumbs: 6 * 0.1 is
 * 0.6000000000000001 in IEEE arithmetic, and that is what would land in the
 * input box. Dividing by a positive power of ten is exact for these steps, and
 * the final rounding to the decade's digits removes whatever is left.
 */
function scaleByDecade(step: number, exp: number): number {
  const v = exp >= 0 ? step * Math.pow(10, exp) : step / Math.pow(10, -exp)
  // The steps carry at most one decimal, so exp - 1 digits are all a value needs.
  const digits = Math.max(0, 1 - exp)
  return Number(v.toFixed(Math.min(digits, 100)))
}

/** The same, downwards — for the low end of a scale that does not start at
 *  zero. Anything at or below zero floors to zero, which is where a positive
 *  field's scale belongs when its thinnest reading is vanishing. */
export function niceFloor(x: number): number {
  if (!(x > 0)) return 0
  const exp = Math.floor(Math.log10(x))
  const m = x / Math.pow(10, exp)
  for (let i = NICE_STEPS.length - 1; i >= 0; i--) {
    if (m >= NICE_STEPS[i] - 1e-9) return scaleByDecade(NICE_STEPS[i], exp)
  }
  return scaleByDecade(1, exp)
}

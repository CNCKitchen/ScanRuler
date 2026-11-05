// SPDX-License-Identifier: AGPL-3.0-only
// The figures under the legend — the histogram and the deviation or thickness
// tally — each take a pass over every vertex of the map. A tab, a map or a
// range tap re-runs the effect that reads them though most of those taps change
// only one of the inputs (or none the figures read), so the last result is kept
// per values array and handed back as the very same object while the numbers
// that produced it are unchanged. The caller can then tell "nothing moved" by
// identity alone and leave the store, and everything subscribed to it, be.
import { deviationStats, type DeviationStats } from '../deviation/deviation'
import { thicknessStats, type ThicknessStats } from '../thickness/thickness'
import { fieldHistogram, type FieldHistogram } from './stats'

interface Entry<T> {
  args: readonly number[]
  result: T
}

/** One slot per values array: a map is read at one scale at a time, so the last
 *  result is the one worth keeping. The WeakMap lets a replaced map's slot go
 *  with the array. */
type Slots<T> = WeakMap<Float32Array, Entry<T>>

function memo<T>(
  slots: Slots<T>,
  values: Float32Array,
  args: readonly number[],
  compute: () => T,
): T {
  const held = slots.get(values)
  // The version is among the args: a new version is a new map even when the
  // array object is the same one, so it recomputes rather than trust the old tally.
  if (held && held.args.every((a, i) => Object.is(a, args[i]))) return held.result
  const result = compute()
  slots.set(values, { args, result })
  return result
}

const histograms: Slots<FieldHistogram> = new WeakMap()
const deviations: Slots<DeviationStats> = new WeakMap()
const thicknesses: Slots<ThicknessStats> = new WeakMap()

export function cachedHistogram(
  values: Float32Array,
  version: number,
  low: number,
  high: number,
  validMin: number,
  validMax: number,
): FieldHistogram {
  return memo(histograms, values, [version, low, high, validMin, validMax], () =>
    fieldHistogram(values, low, high, validMin, validMax),
  )
}

export function cachedDeviationStats(
  values: Float32Array,
  version: number,
  maxDistance: number,
  tolerance: number,
): DeviationStats {
  return memo(deviations, values, [version, maxDistance, tolerance], () =>
    deviationStats(values, maxDistance, tolerance),
  )
}

export function cachedThicknessStats(
  values: Float32Array,
  version: number,
  limit: number,
): ThicknessStats {
  return memo(thicknesses, values, [version, limit], () => thicknessStats(values, limit))
}

// SPDX-License-Identifier: AGPL-3.0-only
import { BLUE_CAP_RGB, RED_CAP_RGB, type FieldScale } from '../field/colormap'
import { fieldPercentiles, fieldStats, niceCeil, type FieldStats } from '../field/stats'
import { rigidApply, type Rigid } from './rigid'
import { emptyHit, type NominalSurface } from './surface'

/** A deviation map's numbers: the shared ones, plus the tolerance band an
 *  inspection report is actually judged on. `measured` here means "had a
 *  nominal counterpart inside the search distance". */
export interface DeviationStats extends FieldStats {
  /** Points within ±`tolerance`. */
  withinTolerance: number
  tolerance: number
}

/** How a deviation field is read as colour: symmetric about zero, blue below
 *  and red above, with everything past the search distance left bare. */
export function deviationScale(
  range: number,
  maxDistance: number,
  bands: number | null,
): FieldScale {
  return {
    low: -range,
    high: range,
    bands,
    validMin: -maxDistance,
    validMax: maxDistance,
    capLow: BLUE_CAP_RGB,
    capHigh: RED_CAP_RGB,
  }
}

/**
 * Signed distance from every scan vertex to the nominal surface.
 *
 * The scan is queried against the nominal and never the other way round: the
 * scan is an open, partly non-manifold capture with no reliable inside, while
 * the nominal is watertight, so only this direction has a well-defined sign.
 * It also means a scan that covers half the part produces a complete map of
 * the half it covers, rather than a sparse one of the whole.
 *
 * The search is unbounded, so the display's max search distance stays a pure
 * display control: it can be moved either way afterwards without recomputing.
 */
export function computeDeviation(
  surface: NominalSurface,
  scanPositions: Float32Array,
  transform: Rigid,
  onProgress?: (fraction: number) => void,
): Float32Array {
  const n = scanPositions.length / 3
  const values = new Float32Array(n)
  const hit = emptyHit()
  const p = new Float64Array(3)
  const chunk = Math.max(1, Math.floor(n / 50))

  for (let v = 0; v < n; v++) {
    rigidApply(transform, scanPositions[v * 3], scanPositions[v * 3 + 1], scanPositions[v * 3 + 2], p)
    values[v] = surface.closest(p[0], p[1], p[2], hit) ? hit.signed : NaN
    if (onProgress && v % chunk === 0) onProgress(v / n)
  }
  onProgress?.(1)
  return values
}

export function deviationStats(
  values: Float32Array,
  maxDistance: number,
  tolerance: number,
): DeviationStats {
  let within = 0
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (Math.abs(v) <= maxDistance && Math.abs(v) <= tolerance) within++
  }
  return {
    ...fieldStats(values, -maxDistance, maxDistance),
    withinTolerance: within,
    tolerance,
  }
}

/**
 * A colour range that shows the part rather than its worst pixel: the rounded
 * 95th percentile of the absolute deviation, so that a handful of points on a
 * fixture edge cannot flatten the whole part to green.
 */
export function suggestRange(values: Float32Array, maxDistance: number): number {
  const [p95] = fieldPercentiles(values, -maxDistance, maxDistance, [0.95], true)
  return Number.isFinite(p95) && p95 > 0 ? niceCeil(p95) : 0.1
}

/** Default search distance: 2 % of the part's bounding-box diagonal, rounded.
 *  Generous enough that a rough first alignment still colours the whole part,
 *  tight enough to leave genuinely unscanned regions grey. */
export function defaultMaxDistance(bboxDiagonal: number): number {
  return niceCeil(bboxDiagonal * 0.02)
}

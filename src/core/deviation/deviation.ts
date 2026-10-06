// SPDX-License-Identifier: AGPL-3.0-only
import type { FieldScale } from '../field/colormap'
import { fieldPercentiles, fieldStats, niceCeil, type FieldStats } from '../field/stats'
import { writeDirection } from './deflection'
import { rigidApply, rigidRotate, type Rigid } from './rigid'
import { emptyHit, type NominalSurface } from './surface'

/** A deviation map's numbers: the shared ones, plus the tolerance band an
 *  inspection report is actually judged on. `measured` here means "had a
 *  nominal counterpart inside the search distance". */
export interface DeviationStats extends FieldStats {
  /** Points within ±`tolerance`. */
  withinTolerance: number
  tolerance: number
}

/** How a deviation field is read as colour: symmetric about zero, the low
 *  end of the ramp below and the high end above — blue and red on jet — with
 *  everything past the search distance left bare. */
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
  }
}

/**
 * How far a scan point whose nearest reference surface faces away from it
 * looks for one that faces its way, as a fraction of the reference's
 * bounding-box diagonal. The search is otherwise unbounded, but a point with
 * nothing facing it anywhere near — on scan spray, or on a feature the
 * reference does not have — would open most of the tree looking, and anything
 * this far off is past every search distance worth reading a map at.
 */
export const FACING_REACH = 0.1

/**
 * The reference map's facing limit until the user sets another: surface facing
 * away from the scan, and nothing short of that. A tighter limit also re-reads
 * points their nearest surface is merely steep to — the inside of a sharp edge
 * the scan has rounded over, measured against the neighbouring face instead —
 * and moves the closest-point reading an inspection is read against at every
 * edge of the part. On the bracket test pair 60° re-reads twenty times as many
 * points as this, and opens the map's extremes by two millimetres.
 */
export const DEFAULT_MAP_FACING_DEG = 90

export interface DeviationOptions {
  onProgress?: (fraction: number) => void
  /** Filled with the direction each reading was taken along, three per
   *  vertex, in the scan's own coordinates — see deflection.ts. It comes
   *  almost free here, from the closest point already in hand, and nowhere
   *  else is that point known. */
  directions?: Int8Array
  /** The scan's own vertex normals, three per vertex, in its own frame. Read
   *  for the facing limit and nothing else. */
  normals?: Float32Array
  /** How far, in radians, the reference surface a point is measured against
   *  may be from facing the way the scan faces there. Null, or no `normals`,
   *  takes the nearest surface whatever it faces. */
  maxNormalDeviation?: number | null
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
 *
 * The nearest surface is not always the one a point came off. Across a thin
 * wall, a point sunk more than half the wall's thickness is nearer the far
 * side than its own, and reads short — or, once it is through, with the sign
 * the wrong way round. With a facing limit, a point whose nearest surface
 * faces away from it is measured against the nearest one that faces its way
 * instead (the same facing-aware search the alignment pairs marked points
 * with), and left unmeasured when there is none within FACING_REACH. The
 * plain query still goes first: nearly every point passes, and only the ones
 * that fail pay for the second, slower search.
 */
export function computeDeviation(
  surface: NominalSurface,
  scanPositions: Float32Array,
  transform: Rigid,
  { onProgress, directions, normals, maxNormalDeviation = null }: DeviationOptions = {},
): Float32Array {
  const n = scanPositions.length / 3
  const values = new Float32Array(n)
  const hit = emptyHit()
  const p = new Float64Array(3)
  const sn = new Float64Array(3)
  const r = transform.r
  const chunk = Math.max(1, Math.floor(n / 50))
  const minFacing = normals && maxNormalDeviation !== null ? Math.cos(maxNormalDeviation) : null
  const reach = surface.bboxDiagonal * FACING_REACH
  const outward = minFacing === null ? 1 : normalsSign(surface, scanPositions, normals!, transform)

  for (let v = 0; v < n; v++) {
    rigidApply(transform, scanPositions[v * 3], scanPositions[v * 3 + 1], scanPositions[v * 3 + 2], p)
    let found = surface.closest(p[0], p[1], p[2], hit)
    if (found && minFacing !== null) {
      // The scan's own normal, carried into the reference's frame.
      rigidRotate(
        transform,
        outward * normals![v * 3],
        outward * normals![v * 3 + 1],
        outward * normals![v * 3 + 2],
        sn,
      )
      if (sn[0] * hit.nx + sn[1] * hit.ny + sn[2] * hit.nz < minFacing) {
        found =
          surface.closestFacing(p[0], p[1], p[2], sn[0], sn[1], sn[2], minFacing, hit, reach) &&
          // The search filters on each face's own normal, while the reading's
          // sign comes off the pseudonormal of the feature the point lands on
          // — and a seam's is the average of the faces meeting there, so on
          // the rim of a sheet or a knife edge it can still face away. Such a
          // reading is no better than the one it was meant to replace.
          sn[0] * hit.nx + sn[1] * hit.ny + sn[2] * hit.nz >= minFacing
      }
    }
    if (!found) {
      values[v] = NaN
    } else {
      values[v] = hit.signed
      if (directions) {
        // From the closest point to the scan point, over the signed reading so
        // that it points off the outside of the reference either way. A point
        // lying on the surface has no such line; the side it would leave by is
        // the one the sign is read off.
        let dx = hit.nx, dy = hit.ny, dz = hit.nz
        if (Math.abs(hit.signed) > 1e-9) {
          dx = (p[0] - hit.px) / hit.signed
          dy = (p[1] - hit.py) / hit.signed
          dz = (p[2] - hit.pz) / hit.signed
        }
        // Back into the scan's frame: the transpose of the fit's rotation.
        writeDirection(
          directions,
          v,
          r[0] * dx + r[3] * dy + r[6] * dz,
          r[1] * dx + r[4] * dy + r[7] * dz,
          r[2] * dx + r[5] * dy + r[8] * dz,
        )
      }
    }
    if (onProgress && v % chunk === 0) onProgress(v / n)
  }
  onProgress?.(1)
  return values
}

/**
 * Which way the scan's normals point: 1 out of the material, -1 into it. A
 * scan too open for its winding to be settled on loading can come in either
 * way round, and read inside-out the facing test would step over the very
 * surface each point came off. Nearly every point lies nearest the surface it
 * came off, so the sign of their summed agreement with it is the scan's — and
 * a couple of thousand of them settle it.
 */
function normalsSign(
  surface: NominalSurface,
  positions: Float32Array,
  normals: Float32Array,
  transform: Rigid,
): 1 | -1 {
  const n = positions.length / 3
  const step = Math.max(1, Math.floor(n / 2000))
  const hit = emptyHit()
  const p = new Float64Array(3)
  const sn = new Float64Array(3)
  let agreement = 0
  for (let v = 0; v < n; v += step) {
    rigidApply(transform, positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2], p)
    if (!surface.closest(p[0], p[1], p[2], hit)) continue
    rigidRotate(transform, normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2], sn)
    agreement += sn[0] * hit.nx + sn[1] * hit.ny + sn[2] * hit.nz
  }
  return agreement < 0 ? -1 : 1
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
 * How wide the colour scale opens on its own, in mm. Past this the scale is the
 * user's to widen: a millimetre either side is already a lot of deviation, and
 * whatever pushed the suggestion past it is far more likely to be a feature that
 * has no business being in the reading — a boss standing proud of the datum
 * plane a map is measured against, scan spray, a fixture — than the part being
 * genuinely two millimetres out. Suggesting the wide scale those produce would
 * flatten the real deviation, all a few hundredths of a millimetre of it, into
 * one shade of green.
 *
 * Anything past the ends is drawn in a dark cap rather than at the limit colour,
 * so a part that really is further out says so plainly instead of hiding.
 */
export const MAX_AUTO_RANGE = 1

/**
 * A colour range that shows the part rather than its worst pixel: the rounded
 * 95th percentile of the absolute deviation, so that a handful of points on a
 * fixture edge cannot flatten the whole part to green. Capped, so that a great
 * many such points cannot either.
 */
export function suggestRange(values: Float32Array, maxDistance: number): number {
  const [p95] = fieldPercentiles(values, -maxDistance, maxDistance, [0.95], true)
  return Number.isFinite(p95) && p95 > 0 ? Math.min(MAX_AUTO_RANGE, niceCeil(p95)) : 0.1
}

/** Default search distance: 2 % of the part's bounding-box diagonal, rounded.
 *  Generous enough that a rough first alignment still colours the whole part,
 *  tight enough to leave genuinely unscanned regions grey. */
export function defaultMaxDistance(bboxDiagonal: number): number {
  return niceCeil(bboxDiagonal * 0.02)
}

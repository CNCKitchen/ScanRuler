// SPDX-License-Identifier: AGPL-3.0-only
// The deviation map: the signed distance from every scan vertex to the
// reference surface, positive outside it, and the statistics and colour range
// it is read with. The scan is queried against the reference, never the other
// way round, since only the closed reference has an inside to sign by; and
// the query is unbounded, so the search distance stays a display control that
// moves either way without measuring again. A facing limit reads a point
// whose nearest surface faces away from it — the far side of a thin wall —
// against the nearest one that faces its way.

import type { FieldScale } from '../field/colormap'
import { fieldPercentiles, fieldStats, niceCeil, type FieldStats } from '../field/stats'
import { writeDirection } from './deflection'
import { rigidApply, rigidRotate, type Rigid } from './rigid'
import { type ClosestHit, emptyHit, type NominalSurface } from './surface'

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
const FACING_REACH = 0.1

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
  /** The nearest reference face for each vertex, found ahead of time — by
   *  the GPU search in gpuNearest.ts — or -1 where it is to be searched for
   *  here. Only the face is taken from it: the reading itself is resolved on
   *  that face in doubles, so it is the one the tree search gives. */
  nearestFaces?: Int32Array | null
  /** Measure only vertices from..to; the answer, and `directions`, then hold
   *  just those, the first at index 0 — how the map is cut into slices for
   *  several workers (parallel.ts). */
  range?: { from: number; to: number }
  /** Which way the scan's normals point, when the caller has settled it for the
   *  whole scan already (a slice cannot, being only part of it). */
  outward?: 1 | -1
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
  { onProgress, directions, normals, maxNormalDeviation = null, nearestFaces = null, range, outward: settledOutward }: DeviationOptions = {},
): Float32Array {
  const from = range?.from ?? 0
  const to = range?.to ?? scanPositions.length / 3
  const n = to - from
  const values = new Float32Array(n)
  const hit = emptyHit()
  const p = new Float64Array(3)
  const sn = new Float64Array(3)
  const r = transform.r
  const chunk = Math.max(1, Math.floor(n / 50))
  const minFacing = normals && maxNormalDeviation !== null ? Math.cos(maxNormalDeviation) : null
  const reach = surface.bboxDiagonal * FACING_REACH
  const outward = settledOutward ?? (minFacing === null ? 1 : scanNormalsSign(surface, scanPositions, normals!, transform))

  for (let v = from; v < to; v++) {
    rigidApply(transform, scanPositions[v * 3], scanPositions[v * 3 + 1], scanPositions[v * 3 + 2], p)
    let found: boolean
    const face = nearestFaces ? nearestFaces[v] : -1
    if (face >= 0) surface.closestOnFace(p[0], p[1], p[2], face, hit)
    if (minFacing === null) found = face >= 0 || surface.closest(p[0], p[1], p[2], hit)
    else {
      // The scan's own normal, carried into the reference's frame.
      rigidRotate(
        transform,
        outward * normals![v * 3],
        outward * normals![v * 3 + 1],
        outward * normals![v * 3 + 2],
        sn,
      )
      if (face >= 0 && sn[0] * hit.nx + sn[1] * hit.ny + sn[2] * hit.nz >= minFacing) found = true
      else {
        const read = closestFacingWay(surface, p[0], p[1], p[2], sn[0], sn[1], sn[2], minFacing, hit, Infinity, reach)
        found = read === 'nearest' || read === 'refaced'
      }
    }
    if (!found) {
      values[v - from] = NaN
    } else {
      values[v - from] = hit.signed
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
          v - from,
          r[0] * dx + r[3] * dy + r[6] * dz,
          r[1] * dx + r[4] * dy + r[7] * dz,
          r[2] * dx + r[5] * dy + r[8] * dz,
        )
      }
    }
    if (onProgress && (v - from) % chunk === 0) onProgress((v - from) / n)
  }
  onProgress?.(1)
  return values
}

/** What a closest-point query under a facing limit came to — see
 *  closestFacingWay. */
export type FacingRead = 'none' | 'nearest' | 'refaced' | 'unfacing'

/** The plain hit held while a facing surface is looked for. */
const heldHit = emptyHit()

/**
 * The closest point to (x, y, z) under a facing limit: the nearest surface
 * within `maxDistance` when its outward normal turns from (sx, sy, sz) by
 * no more than `minFacing` allows (a cosine) — 'nearest' — or else the
 * nearest surface within `facingReach` that does — 'refaced'. 'unfacing':
 * no surface within reach faces the point's way, and `hit` holds the plain
 * nearest all the same, for a caller that reads it anyway; 'none': there
 * is no surface within `maxDistance` at all. A null `minFacing` takes the
 * nearest whatever it faces.
 */
export function closestFacingWay(
  surface: NominalSurface,
  x: number, y: number, z: number,
  sx: number, sy: number, sz: number,
  minFacing: number | null,
  hit: ClosestHit,
  maxDistance = Infinity,
  facingReach = maxDistance,
): FacingRead {
  if (!surface.closest(x, y, z, hit, maxDistance)) return 'none'
  if (minFacing === null || sx * hit.nx + sy * hit.ny + sz * hit.nz >= minFacing) return 'nearest'
  Object.assign(heldHit, hit)
  if (
    surface.closestFacing(x, y, z, sx, sy, sz, minFacing, hit, facingReach) &&
    // The search filters on each face's own normal, while the reading's
    // sign comes off the pseudonormal of the feature the point lands on
    // — and a seam's is the average of the faces meeting there, so on
    // the rim of a sheet or a knife edge it can still face away. Such a
    // reading is no better than the one it was meant to replace.
    sx * hit.nx + sy * hit.ny + sz * hit.nz >= minFacing
  )
    return 'refaced'
  Object.assign(hit, heldHit)
  return 'unfacing'
}

/**
 * Which way the scan's normals point: 1 out of the material, -1 into it. A
 * scan too open for its winding to be settled on loading can come in either
 * way round, and read inside-out the facing test would step over the very
 * surface each point came off. Nearly every point lies nearest the surface it
 * came off, so the sign of their summed agreement with it is the scan's — and
 * a couple of thousand of them settle it.
 *
 * `vertices` keeps the vote to some of the scan — the part near what is
 * measured. With `near`, mm, a point's vote counts less the further it lies
 * from the surface (by 1 / (1 + (d / near)²)): against a model that has one
 * skin of a thin wall and not the other, as many points lie a wall away,
 * facing back at it, as lie on it, and only the ones on it say how the scan
 * is wound.
 *
 * Without `near` the scan sets its own: the distance a fifth of the voters
 * lie within, which is the scan on the surface's own spread as long as more
 * than a fifth of it lies there. An unweighted vote let a fixture or the
 * far side of a wall, if enough of it was scanned, turn every reading the
 * wrong way round (issue 34).
 */
export function scanNormalsSign(
  surface: NominalSurface,
  positions: Float32Array | Float64Array,
  normals: Float32Array | Float64Array,
  transform: Rigid,
  { vertices, near }: { vertices?: ArrayLike<number>; near?: number } = {},
): 1 | -1 {
  const n = vertices ? vertices.length : positions.length / 3
  const step = Math.max(1, Math.floor(n / 2000))
  const hit = emptyHit()
  const p = new Float64Array(3)
  const sn = new Float64Array(3)
  const distances: number[] = []
  const agreements: number[] = []
  for (let i = 0; i < n; i += step) {
    const v = vertices ? vertices[i] : i
    rigidApply(transform, positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2], p)
    if (!surface.closest(p[0], p[1], p[2], hit)) continue
    rigidRotate(transform, normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2], sn)
    distances.push(hit.distance)
    agreements.push(sn[0] * hit.nx + sn[1] * hit.ny + sn[2] * hit.nz)
  }
  if (distances.length === 0) return 1
  let scale = near
  if (scale === undefined) {
    const sorted = Float64Array.from(distances).sort()
    scale = Math.max(sorted[Math.floor(sorted.length / 5)], surface.bboxDiagonal * 1e-5)
  }
  let agreement = 0
  for (let i = 0; i < distances.length; i++) agreement += agreements[i] / (1 + (distances[i] / scale) ** 2)
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

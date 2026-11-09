// SPDX-License-Identifier: AGPL-3.0-only
// How well a pose lays one scan on another: the RMS of the closest-point
// (Euclidean) distances of the source points that find a facing partner in the
// target, and the share of the source that does. It is not ICP's reported rms,
// which is the signed plane residual after a median cut. Run over every source point, so it is the
// honest figure behind an alignment that ICP only fitted on a thinned sample.

import { emptyHit, type ClosestSurface } from './surface'
import { type Rigid, rigidApply, rigidRotate } from './rigid'

/** The least overlap, as a share of the source, at which a pose is taken to be
 *  a real placement. Below it two scans touch too little for the alignment to
 *  be trusted. Kept at its starting 0.30: the Revo passes show no gap to fix it
 *  in. The lowest true (oracle) overlap is 0.605, but ICP from an identity start
 *  settles in wrong poses that match up to 0.66 (0905_03, rms 0.122 against the
 *  oracle's 0.088), so no value separates the two by overlap alone. Never
 *  loosened. */
export const LOW_OVERLAP = 0.3

/** Pairs whose normals disagree beyond acos(this) are not the same surface —
 *  the rule ICP's facing search applies. */
const MIN_NORMAL_DOT = 0.5

/** Row-major 4x4 (translation at [3, 7, 11]) to a Rigid, read as given: the
 *  matrix maps the pass into the frame of the Revo merge's reference pass. */
export function oraclePose(m: number[]): Rigid {
  if (m.length !== 16) throw new Error('A pose needs 16 numbers.')
  return {
    r: Float64Array.from([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]),
    t: Float64Array.from([m[3], m[7], m[11]]),
  }
}

/** maxPair here (3 spacings in the Revo tests) is the scoring reach, tighter
 *  than the 30 mm pairing reach ICP runs with. */
export function scorePose(
  target: ClosestSurface,
  source: { positions: Float32Array; normals: Float32Array },
  pose: Rigid,
  maxPair: number,
): { rms: number; matched: number } {
  const n = source.positions.length / 3
  const hit = emptyHit()
  const p = new Float64Array(3)
  const sn = new Float64Array(3)
  let count = 0
  let sumSq = 0
  for (let i = 0; i < n; i++) {
    rigidApply(pose, source.positions[3 * i], source.positions[3 * i + 1], source.positions[3 * i + 2], p)
    rigidRotate(pose, source.normals[3 * i], source.normals[3 * i + 1], source.normals[3 * i + 2], sn)
    if (!target.closest(p[0], p[1], p[2], hit, maxPair)) continue
    if (sn[0] * hit.nx + sn[1] * hit.ny + sn[2] * hit.nz < MIN_NORMAL_DOT) {
      if (!target.closestFacing(p[0], p[1], p[2], sn[0], sn[1], sn[2], MIN_NORMAL_DOT, hit, maxPair)) continue
      // As ICP does: the search can hand back a seam whose pseudonormal still disagrees.
      if (sn[0] * hit.nx + sn[1] * hit.ny + sn[2] * hit.nz < MIN_NORMAL_DOT) continue
    }
    if (hit.distance > maxPair) continue
    count++
    sumSq += hit.distance * hit.distance
  }
  return { rms: count > 0 ? Math.sqrt(sumSq / count) : Infinity, matched: n > 0 ? count / n : 0 }
}

/** A pose whose RMS residual is within this many target spacings is a close
 *  fit. Overlap alone cannot tell a wrong pose from a right one (ICP from an
 *  identity start settles in wrong poses that match 0.45 to 0.66), so the
 *  residual is read as well. On the Revo passes the correct poses end at 0.87
 *  to 0.89 spacings and the wrong identity-start pose that fits best (0905_05,
 *  157 deg off) at 0.996; 0.935 is the midpoint. The gap is narrow. */
export const CONFIDENT_RMS_SPACINGS = 0.935

/** Whether a scored pose can be trusted: it overlaps enough and fits closely. */
export function poseConfidence(
  score: { rms: number; matched: number },
  targetSpacing: number,
): { lowOverlap: boolean; confident: boolean } {
  const lowOverlap = score.matched < LOW_OVERLAP
  return { lowOverlap, confident: !lowOverlap && score.rms <= CONFIDENT_RMS_SPACINGS * targetSpacing }
}

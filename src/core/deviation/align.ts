// SPDX-License-Identifier: AGPL-3.0-only
import type { Vec3 } from '../types'
import { absoluteOrientation } from './absoluteOrientation'
import { icp, sampleScan, type ScanSamples } from './icp'
import { preAlignCandidates, principalFrame } from './prealign'
import { identityRigid, rigidDisagreement, type Rigid } from './rigid'
import type { NominalSurface } from './surface'

export type AlignSource = 'auto' | 'points'

export interface AlignResult {
  /** Carries scan coordinates into the nominal's frame. The scan itself is
   *  never moved — the nominal is drawn under the inverse — so that elements
   *  measured in the other workspace stay where they were put. */
  transform: Rigid
  source: AlignSource
  /** RMS of the point-to-plane residuals over the accepted pairs, in mm. */
  rms: number
  /** Mean absolute point-to-surface distance over accepted pairs, in mm. */
  meanDistance: number
  iterations: number
  matched: number
  sampled: number
  /** Set when a second, materially different starting pose scored nearly as
   *  well — the part may be symmetric enough that the automatic match has
   *  locked onto the wrong one of two equally good answers. */
  ambiguous: boolean
  /** RMS of the picked pairs themselves, before ICP. Manual alignments only. */
  pairRms?: number
}

export interface AlignOptions {
  /** Points used while scoring the candidate starting poses. */
  coarseSamples?: number
  /** Points used for the final fit. */
  fineSamples?: number
  onProgress?: (text: string) => void
  /** Called with poses along the way, so the view can show the part settling
   *  onto the reference instead of a spinner. The shortlist attempts and the
   *  final refinement report; the first screening pass does not, because
   *  cutting between two dozen unrelated attitudes is a flicker, not a fit. */
  onTransform?: (transform: Rigid, iteration: number, meanDistance: number) => void
}

/** First pass over every candidate: just enough to tell a start that is
 *  falling towards the part from one that is wandering off. */
const SCREEN_ITERATIONS = 6
/** Second pass, over the shortlist only. */
const COARSE_ITERATIONS = 20
const SHORTLIST = 5
const FINE_ITERATIONS = 70
/** Below this the two best starts are effectively tied. */
const AMBIGUITY_MARGIN = 1.25

function fine(
  surface: NominalSurface,
  samples: ScanSamples,
  start: Rigid,
  source: AlignSource,
  ambiguous: boolean,
  options: AlignOptions,
): AlignResult {
  const { onProgress, onTransform } = options
  const r = icp(surface, samples, start, {
    maxIterations: FINE_ITERATIONS,
    rejectMedianFactor: 3,
    // Only once the pose is roughly right is it safe to insist that matched
    // surfaces face the same way; from a wild start it would starve the fit.
    minNormalDot: 0.3,
    onIteration:
      onProgress || onTransform
        ? (i, d, m) => {
            onProgress?.(`Aligning — pass ${i}, mean deviation ${d.toFixed(4)} mm…`)
            onTransform?.(m, i, d)
          }
        : undefined,
  })
  return {
    transform: r.transform,
    source,
    rms: r.rms,
    meanDistance: r.meanDistance,
    iterations: r.iterations,
    matched: r.matched,
    sampled: r.sampled,
    ambiguous,
  }
}

/**
 * Best fit with no help from the user.
 *
 * Principal axes give four candidate attitudes and the identity gives a fifth,
 * which covers the common case of two files already exported in a shared frame
 * — where a principal-axis guess would actively make things worse, because a
 * partial scan's inertia is not the whole part's. Each candidate gets a short
 * ICP and is scored on what it actually achieves rather than on how plausible
 * it looked; the winner then gets the long run on ten times the points.
 */
export function autoAlign(
  surface: NominalSurface,
  scanPositions: Float32Array,
  scanNormals: Float32Array | null,
  options: AlignOptions = {},
): AlignResult {
  const coarseCount = options.coarseSamples ?? 4000
  const fineCount = options.fineSamples ?? 25_000
  const progress = options.onProgress

  progress?.('Aligning — measuring principal axes…')
  const coarse = sampleScan(scanPositions, scanNormals, coarseCount)
  const scanFrame = principalFrame(coarse.xyz)
  const nominalFrame = principalFrame(surface.positions)

  // The identity leads the field because two files exported from the same
  // inspection session already share a frame, and a principal-axis guess would
  // actively throw that away.
  const candidates: Rigid[] = [identityRigid(), ...preAlignCandidates(scanFrame, nominalFrame)]

  // Screen all of them briefly, then spend real iterations only on the few
  // that are heading somewhere — 24 candidates run to convergence would cost
  // several times what the final fit does, for no better answer.
  const screened = candidates.map((start, i) => {
    progress?.(`Aligning — screening start ${i + 1} of ${candidates.length}…`)
    return icp(surface, coarse, start, {
      maxIterations: SCREEN_ITERATIONS,
      rejectMedianFactor: 2.5,
      minNormalDot: 0,
    })
  })
  screened.sort((a, b) => a.score - b.score)

  const shortlist = screened.slice(0, SHORTLIST)
  const scored = shortlist.map((seed, i) => {
    progress?.(`Aligning — trying start ${i + 1} of ${shortlist.length}…`)
    return icp(surface, coarse, seed.transform, {
      maxIterations: COARSE_ITERATIONS,
      rejectMedianFactor: 2.5,
      minNormalDot: 0,
      // Streamed as well: these are the attempts that take the time, and
      // watching a candidate swing in and settle is what tells the user the
      // tool is working rather than stuck.
      onIteration: options.onTransform
        ? (it, d, m) => options.onTransform!(m, it, d)
        : undefined,
    })
  })
  scored.sort((a, b) => a.score - b.score)

  const winner = scored[0]
  const runnerUp = scored[1]
  // Two starts only count as ambiguous if they scored alike *and* ended up
  // somewhere genuinely different — the four axis flips of a part with a plane
  // of symmetry converge to the same place, which is agreement, not ambiguity.
  let radius = 0
  for (let i = 0; i < coarse.count; i++) {
    radius = Math.max(
      radius,
      Math.hypot(
        coarse.xyz[i * 3] - scanFrame.centroid[0],
        coarse.xyz[i * 3 + 1] - scanFrame.centroid[1],
        coarse.xyz[i * 3 + 2] - scanFrame.centroid[2],
      ),
    )
  }
  const ambiguous =
    runnerUp !== undefined &&
    runnerUp.score < winner.score * AMBIGUITY_MARGIN &&
    rigidDisagreement(winner.transform, runnerUp.transform, scanFrame.centroid, radius) >
      surface.bboxDiagonal * 0.01

  progress?.('Aligning — refining…')
  const samples = sampleScan(scanPositions, scanNormals, fineCount)
  return fine(surface, samples, winner.transform, 'auto', ambiguous, options)
}

export interface PointPair {
  scan: Vec3
  nominal: Vec3
}

/**
 * Best fit started from hand-picked pairs.
 *
 * The clicks only have to be roughly right: absolute orientation turns them
 * into a coarse pose in closed form, and ICP does the rest. Three pairs is the
 * minimum and three pairs strung out along one edge is not enough — the
 * rotation about that line is unconstrained — so a degenerate pick is rejected
 * with an explanation rather than silently producing a plausible wrong answer.
 */
export function alignFromPairs(
  surface: NominalSurface,
  scanPositions: Float32Array,
  scanNormals: Float32Array | null,
  pairs: PointPair[],
  options: AlignOptions = {},
): AlignResult {
  if (pairs.length < 3) {
    throw new Error('Pick at least three point pairs — two cannot fix a rotation.')
  }
  const solved = absoluteOrientation(
    pairs.map((p) => p.scan),
    pairs.map((p) => p.nominal),
  )
  if (!solved) throw new Error('Could not solve the picked points.')
  if (solved.conditioning < 0.02) {
    throw new Error(
      'The picked points are nearly in a line — add one away from that line, so the rotation about it is fixed.',
    )
  }

  options.onProgress?.('Aligning — refining from picked points…')
  const samples = sampleScan(scanPositions, scanNormals, options.fineSamples ?? 25_000)
  const result = fine(surface, samples, solved.transform, 'points', false, options)
  result.pairRms = solved.rms
  return result
}

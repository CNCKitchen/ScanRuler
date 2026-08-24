// SPDX-License-Identifier: AGPL-3.0-only
import { symmetricEigen3 } from '../fit/linalg'
import type { Vec3 } from '../types'
import { absoluteOrientation } from './absoluteOrientation'
import { icpSteps, sampleScan, type ScanSamples } from './icp'
import { preAlignCandidates, principalFrame } from './prealign'
import { identityRigid, rigidDisagreement, type Rigid } from './rigid'
import { runSteps, type Steps } from './steps'
import type { NominalSurface } from './surface'

export type AlignSource = 'auto' | 'points' | 'local'

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
  /** How many marked scan vertices a local fit was given. */
  selected?: number
  /** The gate a local fit was run under, in mm. Part of how the number was
   *  arrived at, so it belongs in the report with it. */
  searchDistance?: number
  /** Set when the marked surface faces essentially one way — a single flat
   *  patch fixes the distance across itself and nothing else, so the fit is
   *  free to slide along it. Local fits only. */
  underconstrained?: boolean
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

function* fine(
  surface: NominalSurface,
  samples: ScanSamples,
  start: Rigid,
  source: AlignSource,
  ambiguous: boolean,
  options: AlignOptions,
): Steps<AlignResult> {
  const { onProgress, onTransform } = options
  const r = yield* icpSteps(surface, samples, start, {
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
  return runSteps(autoAlignSteps(surface, scanPositions, scanNormals, options))
}

/** The automatic fit, a pass at a time — see steps.ts. */
export function* autoAlignSteps(
  surface: NominalSurface,
  scanPositions: Float32Array,
  scanNormals: Float32Array | null,
  options: AlignOptions = {},
): Steps<AlignResult> {
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
  const screened = []
  for (let i = 0; i < candidates.length; i++) {
    progress?.(`Aligning — screening start ${i + 1} of ${candidates.length}…`)
    screened.push(
      yield* icpSteps(surface, coarse, candidates[i], {
        maxIterations: SCREEN_ITERATIONS,
        rejectMedianFactor: 2.5,
        minNormalDot: 0,
      }),
    )
  }
  screened.sort((a, b) => a.score - b.score)

  const shortlist = screened.slice(0, SHORTLIST)
  const scored = []
  for (let i = 0; i < shortlist.length; i++) {
    progress?.(`Aligning — trying start ${i + 1} of ${shortlist.length}…`)
    scored.push(
      yield* icpSteps(surface, coarse, shortlist[i].transform, {
        maxIterations: COARSE_ITERATIONS,
        rejectMedianFactor: 2.5,
        minNormalDot: 0,
        // Streamed as well: these are the attempts that take the time, and
        // watching a candidate swing in and settle is what tells the user the
        // tool is working rather than stuck.
        onIteration: options.onTransform
          ? (it, d, m) => options.onTransform!(m, it, d)
          : undefined,
      }),
    )
  }
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
  return yield* fine(surface, samples, winner.transform, 'auto', ambiguous, options)
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
 *
 * `vertices` narrows what the refinement is measured on, the same way a local
 * fine fit does: a scan carrying a fixture, a riser or a run of spray is one
 * the picked pose is right about and ICP is then free to drag off it. Empty or
 * absent means the whole scan, which is what nearly every part wants.
 */
export function alignFromPairs(
  surface: NominalSurface,
  scanPositions: Float32Array,
  scanNormals: Float32Array | null,
  pairs: PointPair[],
  options: AlignOptions = {},
  vertices?: Uint32Array | null,
): AlignResult {
  return runSteps(
    alignFromPairsSteps(surface, scanPositions, scanNormals, pairs, options, vertices),
  )
}

/** The picked-point fit, a pass at a time — see steps.ts. */
export function* alignFromPairsSteps(
  surface: NominalSurface,
  scanPositions: Float32Array,
  scanNormals: Float32Array | null,
  pairs: PointPair[],
  options: AlignOptions = {},
  vertices?: Uint32Array | null,
): Steps<AlignResult> {
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

  const selected = vertices && vertices.length > 0 ? vertices : null
  if (selected && selected.length < MIN_LOCAL_POINTS) {
    throw new Error(
      `Select more surface — a fit needs at least ${MIN_LOCAL_POINTS} selected points, and this selection has ${selected.length}. Clear the selection to fit on the whole scan.`,
    )
  }

  options.onProgress?.(
    selected
      ? 'Aligning — refining from picked points, on the selected surface…'
      : 'Aligning — refining from picked points…',
  )
  const source = selected ? gatherVertices(scanPositions, scanNormals, selected) : null
  const samples = sampleScan(
    source ? source.positions : scanPositions,
    source ? source.normals : scanNormals,
    options.fineSamples ?? 25_000,
  )
  const result = yield* fine(surface, samples, solved.transform, 'points', false, options)
  result.pairRms = solved.rms
  if (selected) result.selected = selected.length
  return result
}

/** The marked vertices as arrays of their own, which is what the sampler and
 *  everything downstream of it speak. */
function gatherVertices(
  positions: Float32Array,
  normals: Float32Array | null,
  vertices: Uint32Array,
): { positions: Float32Array; normals: Float32Array | null } {
  const picked = new Float32Array(vertices.length * 3)
  const pickedNormals = normals ? new Float32Array(vertices.length * 3) : null
  for (let i = 0; i < vertices.length; i++) {
    const v = vertices[i]
    picked[i * 3] = positions[v * 3]
    picked[i * 3 + 1] = positions[v * 3 + 1]
    picked[i * 3 + 2] = positions[v * 3 + 2]
    if (pickedNormals && normals) {
      pickedNormals[i * 3] = normals[v * 3]
      pickedNormals[i * 3 + 1] = normals[v * 3 + 1]
      pickedNormals[i * 3 + 2] = normals[v * 3 + 2]
    }
  }
  return { positions: picked, normals: pickedNormals }
}

/** Below this there is not enough marked surface to place a part with: six
 *  degrees of freedom against a handful of noisy points is not a measurement. */
export const MIN_LOCAL_POINTS = 50

/** Second largest eigenvalue of the marked normals' covariance, below which
 *  the selection faces one way and the fit is free to slide along it. Unit
 *  normals all pointing one way give (1, 0, 0) and two faces at a right angle
 *  give (½, ½, 0); this sits between them at about a 20° spread, which is the
 *  point where a gently curved patch stops meaningfully resisting a slide. */
const FLAT_SELECTION = 0.05

export interface LocalAlignOptions extends AlignOptions {
  /** How far a marked point may reach for reference surface, in mm. The whole
   *  point of the local fit: it stops the marked patch from snapping onto a
   *  neighbouring feature that happens to fit it better. */
  maxDistance: number
}

/**
 * Fine tuning against part of the scan, from an alignment that already
 * roughly holds.
 *
 * The global best fit weighs every point of the scan the same, which is right
 * up until the scan contains surface that is not the part: sprayed developer,
 * print supports, the riser it was scanned on, a fixture. Those pull the whole
 * fit off, and no amount of iterating fixes it, because they are being fitted
 * on purpose. Here the user has said which surface is real, so only that is
 * measured — and because the answer is a correction rather than a search, the
 * pose starts where the global fit left it and pairs beyond `maxDistance` are
 * refused outright.
 *
 * Everything downstream is unchanged: the result is still a full scan → nominal
 * transform, and the deviation map that follows is still measured over the
 * whole scan. Excluding surface from the *fit* is not excluding it from the
 * *reading*.
 */
export function alignLocal(
  surface: NominalSurface,
  scanPositions: Float32Array,
  scanNormals: Float32Array | null,
  vertices: Uint32Array,
  start: Rigid,
  options: LocalAlignOptions,
): AlignResult {
  return runSteps(
    alignLocalSteps(surface, scanPositions, scanNormals, vertices, start, options),
  )
}

/** The fine fit, a pass at a time — see steps.ts. */
export function* alignLocalSteps(
  surface: NominalSurface,
  scanPositions: Float32Array,
  scanNormals: Float32Array | null,
  vertices: Uint32Array,
  start: Rigid,
  options: LocalAlignOptions,
): Steps<AlignResult> {
  if (vertices.length < MIN_LOCAL_POINTS) {
    throw new Error(
      `Mark more surface — a local fit needs at least ${MIN_LOCAL_POINTS} marked points, and this selection has ${vertices.length}.`,
    )
  }
  if (!(options.maxDistance > 0)) {
    throw new Error('The maximum search distance must be greater than zero.')
  }

  options.onProgress?.('Fine fit — reading the marked surface…')
  const picked = gatherVertices(scanPositions, scanNormals, vertices)
  const samples = sampleScan(picked.positions, picked.normals, options.fineSamples ?? 25_000)

  options.onProgress?.('Fine fit — refining on the marked surface…')
  const r = yield* icpSteps(surface, samples, start, {
    maxIterations: FINE_ITERATIONS,
    rejectMedianFactor: 3,
    // The pose is already right to within a fraction of a millimetre, so the
    // facing test can be strict — it is what keeps a marked wall from pairing
    // with the other side of a thin one.
    minNormalDot: 0.5,
    // And it is applied inside the search, not after it: the nearest reference
    // surface to a point marked on a thin wall, in a bore or in a narrow gap
    // is the one facing back at it, and rejecting that pair afterwards would
    // throw the point away rather than pair it with the wall it came off.
    // Surface the user marked as being the part has to be able to vote.
    facingSearch: true,
    maxPairDistance: options.maxDistance,
    // A sample that found nothing inside the gate costs exactly the gate, so
    // the score stays comparable between poses that match different subsets.
    scoreCap: options.maxDistance,
    onIteration:
      options.onProgress || options.onTransform
        ? (i, d, m) => {
            options.onProgress?.(`Fine fit — pass ${i}, mean deviation ${d.toFixed(4)} mm…`)
            options.onTransform?.(m, i, d)
          }
        : undefined,
  })

  if (r.matched === 0) {
    throw new Error(
      `No marked point found reference surface within ${options.maxDistance} mm. Raise the maximum search distance, or run the global best fit first.`,
    )
  }

  return {
    transform: r.transform,
    source: 'local',
    rms: r.rms,
    meanDistance: r.meanDistance,
    iterations: r.iterations,
    matched: r.matched,
    sampled: r.sampled,
    ambiguous: false,
    selected: vertices.length,
    searchDistance: options.maxDistance,
    underconstrained: normalSpread(samples.normals, samples.count) < FLAT_SELECTION,
  }
}

/** How many directions the marked surface faces, as the middle eigenvalue of
 *  the mean outer product of its normals. One flat patch scatters along a
 *  single direction and returns ~0; anything with a second face returns a
 *  substantial fraction. */
function normalSpread(normals: Float64Array | null, count: number): number {
  if (!normals || count === 0) return 1
  const m = new Float64Array(9)
  for (let i = 0; i < count; i++) {
    const x = normals[i * 3], y = normals[i * 3 + 1], z = normals[i * 3 + 2]
    m[0] += x * x; m[1] += x * y; m[2] += x * z
    m[4] += y * y; m[5] += y * z
    m[8] += z * z
  }
  m[3] = m[1]; m[6] = m[2]; m[7] = m[5]
  for (let i = 0; i < 9; i++) m[i] /= count
  // Ascending, so the middle one is the second largest.
  return symmetricEigen3(m).values[1]
}

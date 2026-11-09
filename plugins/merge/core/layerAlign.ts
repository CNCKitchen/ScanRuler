// SPDX-License-Identifier: AGPL-3.0-only
// Laying a layer (an extra scan pass) onto the merge's target: from picked
// point pairs, or refined by ICP from any start (datums, a user's nudge, the
// identity). The pose carries layer coordinates into the target's frame.
//
// ICP runs twice, on 25 k samples and then on 200 k from where the first
// ended, 40 passes each, pairs at most `maxPairDistance` apart and facing
// within 60 degrees: the settings measured on the Revo passes, where starts 5
// degrees and 5 mm off land within 0.06 degrees / 0.41 mm of Revo's own merge.
// The pair bound is 30 mm by default: wide enough for a start a few
// millimetres and degrees off on a hand-sized part, and a bound at all,
// because a layer only partly overlaps the target and an unbounded pairing
// drags the rest of it onto whatever surface is nearest.
//
// What it reports is not ICP's figure but scorePose over every layer point,
// pairs within 3 target spacings: an honest closest-point RMS and the share
// of the layer that found the target. ICP from a start nobody chose can settle
// in a wrong pose that still overlaps (the Revo passes do, 133 to 180 degrees
// off), so such a result is never called confident.
//
// Pure numerics: no DOM, no Three.js.

import { alignFromPairsSteps } from '../../../src/core/deviation/align'
import type { DatumSpec } from '../../../src/core/alignment'
import { CloudSurface } from '../../../src/core/deviation/cloudSurface'
import { icpSteps, sampleScan } from '../../../src/core/deviation/icp'
import { poseConfidence, scorePose } from '../../../src/core/deviation/poseScore'
import type { Rigid } from '../../../src/core/deviation/rigid'
import type { Steps } from '../../../src/core/deviation/steps'
import type { ClosestSurface } from '../../../src/core/deviation/surface'
import type { FitData, Vec3 } from '../../../src/core/types'
import { datumPose, type DatumSet } from './datums'

export interface LayerCloud {
  /** The layer in its own frame, mm. */
  positions: Float32Array
  normals: Float32Array
  /** A 25 k-point sample of it, for the first ICP stage. */
  sample: Float32Array
  sampleNormals: Float32Array
}

export interface LayerAlignResult {
  pose: Rigid
  /** Closest-point RMS over the layer points that found the target, mm. */
  rms: number
  /** Share of the layer's points that found the target. */
  matched: number
  lowOverlap: boolean
  /** Overlaps enough, fits within CONFIDENT_RMS_SPACINGS, and started from a
   *  pose the user gave. */
  confident: boolean
}

export interface RefineOptions {
  /** False when the start is no one's guess (the identity on opening a
   *  layer): the result is then never confident. Default true. */
  fromUserGuess?: boolean
  /** The target's point spacing, mm; read off a CloudSurface when absent. */
  targetSpacing?: number
  /** ICP pair bound, mm. Default 30. */
  maxPairDistance?: number
}

const COARSE_SAMPLES = 25_000
const FINE_SAMPLES = 200_000
const ITERATIONS = 40
const MIN_NORMAL_DOT = 0.5
const MAX_PAIR = 30
/** Scoring reach, in target spacings. */
const SCORE_SPACINGS = 3

/** A layer ready to align, its positions multiplied by `scale` first (25.4
 *  for a file in inches) so it lives in the target's millimetres. */
export function layerCloud(positions: Float32Array, normals: Float32Array, scale = 1): LayerCloud {
  const p = scale === 1 ? positions : positions.map((v) => v * scale)
  const s = sampleScan(p, normals, COARSE_SAMPLES)
  return { positions: p, normals, sample: Float32Array.from(s.xyz), sampleNormals: Float32Array.from(s.normals ?? []) }
}

/** Picked pairs (a point on the layer, the same point on the target) solved in
 *  closed form, then refined. Throws the picked-point errors of
 *  alignFromPairsSteps for fewer than three pairs or pairs in a line. */
export function* alignPairs(
  target: ClosestSurface,
  layer: LayerCloud,
  pairs: { layer: Vec3; target: Vec3 }[],
  opts: Omit<RefineOptions, 'fromUserGuess'> = {},
): Steps<LayerAlignResult> {
  const picked = yield* alignFromPairsSteps(
    target,
    layer.positions,
    layer.normals,
    pairs.map((p) => ({ scan: p.layer, nominal: p.target })),
    { fineSamples: COARSE_SAMPLES },
  )
  return yield* refineLayer(target, layer, picked.transform, { ...opts, fromUserGuess: true })
}

export function* refineLayer(
  target: ClosestSurface,
  layer: LayerCloud,
  start: Rigid,
  opts: RefineOptions = {},
): Steps<LayerAlignResult> {
  const spacing = opts.targetSpacing ?? (target instanceof CloudSurface ? target.spacing : NaN)
  if (!(spacing > 0)) throw new Error('refineLayer needs the target spacing for a target that is not a point cloud.')
  const icpOptions = { maxIterations: ITERATIONS, maxPairDistance: opts.maxPairDistance ?? MAX_PAIR, minNormalDot: MIN_NORMAL_DOT }

  const coarse = {
    xyz: Float64Array.from(layer.sample),
    normals: Float64Array.from(layer.sampleNormals),
    count: layer.sample.length / 3,
  }
  let pose = (yield* icpSteps(target, coarse, start, icpOptions)).transform
  pose = (yield* icpSteps(target, sampleScan(layer.positions, layer.normals, FINE_SAMPLES), pose, icpOptions)).transform
  yield

  const score = scorePose(target, layer, pose, SCORE_SPACINGS * spacing)
  const { lowOverlap, confident } = poseConfidence(score, spacing)
  return { pose, rms: score.rms, matched: score.matched, lowOverlap, confident: confident && opts.fromUserGuess !== false }
}

/** The same datum with its direction the other way, or null for a datum whose
 *  direction sign means something (a plane's outward normal) or that has none. */
function flippedAxis(spec: DatumSpec): DatumSpec | null {
  const f: FitData = spec.fit
  const neg = (v: Vec3): Vec3 => [-v[0], -v[1], -v[2]]
  if (f.kind === 'line') return { ...spec, fit: { ...f, dir: neg(f.dir) } }
  if (f.kind === 'cylinder' || f.kind === 'cone') return { ...spec, fit: { ...f, axis: neg(f.axis) } }
  return null
}

/**
 * A layer laid on the target by matching datums, then refined. An axis fitted
 * to a bore or a line has no sign of its own, so the two sides can disagree on
 * it and the datum pose come out half a turn wrong. Each axis-type datum of the
 * layer is therefore tried both ways (at most four starts), each start is
 * refined, and the best result is kept: confident first, then the lowest rms.
 * The datum pose is only a start: coordinates no datum owns are pinned at the
 * primary's centre (datums.ts), and the refinement closes what that leaves.
 */
export function* alignDatums(
  target: ClosestSurface,
  layer: LayerCloud,
  layerDatums: DatumSet,
  targetDatums: DatumSet,
  opts: Omit<RefineOptions, 'fromUserGuess'> = {},
): Steps<LayerAlignResult | { refused: string }> {
  const primaries = [layerDatums.primary, flippedAxis(layerDatums.primary)].filter((d): d is DatumSpec => d !== null)
  const secondaries = layerDatums.secondary
    ? [layerDatums.secondary, flippedAxis(layerDatums.secondary)].filter((d): d is DatumSpec => d !== null)
    : [null]
  let best: LayerAlignResult | null = null
  let refused: { refused: string } | null = null
  for (const primary of primaries) {
    for (const secondary of secondaries) {
      const start = datumPose({ ...layerDatums, primary, secondary }, targetDatums)
      if ('refused' in start) {
        refused = start
        continue
      }
      const r = yield* refineLayer(target, layer, start, { ...opts, fromUserGuess: true })
      if (!best || (r.confident && !best.confident) || (r.confident === best.confident && r.rms < best.rms)) best = r
    }
  }
  return best ?? refused!
}

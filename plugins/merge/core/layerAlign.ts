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
// The wide bound is also what made a refine slow: a layer point with nothing
// near (four in ten on the Ruben head) searches out towards it every pass,
// several times dearer than a near hit. Those points still count, in ICP's
// median cut and its score, and on a pass that can slide (Revo's 0905_01) its
// path depends on them, so they are not dropped but searched again only once
// they have moved a spacing (icp's FarPairs). And the 200 k stage stops when
// a pass moves the layer under a two-hundredth of a spacing rather than a
// ten-millionth of the part. Together they take a refine of the Ruben head
// from 8 to 10 s to 3 to 4, landing where it did to 0.001 degrees
// (refineBench.test.ts).
//
// What it reports is not ICP's figure but scorePose over every layer point,
// pairs within 3 target spacings: an honest closest-point RMS and the share
// of the layer that found the target. ICP from a start nobody chose can settle
// in a wrong pose that still overlaps (the Revo passes do, 133 to 180 degrees
// off), so such a result is never called confident.
//
// Two more things keep a fit that only looks good from being called
// confident. The constraint (poseConstraint): an overlap that is mostly one
// flat face lets ICP slide along it and stop anywhere. And the picks or
// datums the start came from: a refine that carries them further than
// driftBound off went somewhere they did not say, and is flagged drifted.
//
// Pure numerics: no DOM, no Three.js.

import type { DatumSpec } from '../../../src/core/alignment'
import { absoluteOrientation } from '../../../src/core/deviation/absoluteOrientation'
import { CloudSurface } from '../../../src/core/deviation/cloudSurface'
import { icpSteps, sampleScan, type ScanSamples } from '../../../src/core/deviation/icp'
import { poseConfidence, scorePose } from '../../../src/core/deviation/poseScore'
import { rigidApply, rigidRotate, type Rigid } from '../../../src/core/deviation/rigid'
import type { Steps } from '../../../src/core/deviation/steps'
import { emptyHit, type ClosestSurface } from '../../../src/core/deviation/surface'
import { symmetricEigenN } from '../../../src/core/fit/linalg'
import { transformFit } from '../../../src/core/alignment'
import type { FitData, Vec3 } from '../../../src/core/types'
import { datumPose, type DatumSet } from './datums'
import { MIN_CONSTRAINT } from './protocol'

export { MIN_CONSTRAINT }

export interface LayerCloud {
  /** The layer in its own frame, mm. */
  positions: Float32Array
  normals: Float32Array
  /** A 25 k-point sample of it, for the first ICP stage. */
  sample: Float32Array
  sampleNormals: Float32Array
  /** The 200 k-point sample for the second stage, drawn once so the starts
   *  alignDatums tries share it. */
  fine: ScanSamples
}

export interface LayerAlignResult {
  pose: Rigid
  /** Closest-point RMS over the layer points that found the target, mm. */
  rms: number
  /** Share of the layer's points that found the target. */
  matched: number
  lowOverlap: boolean
  /** How well the overlap pins the pose in its weakest direction: the
   *  smallest over the largest eigenvalue of the point-to-plane normal matrix
   *  at the pose (poseConstraint). Near 0, the layer can slide or turn along
   *  the surfaces it found (a flat face, a single bore) and ICP's stopping
   *  place says nothing. */
  constraint: number
  /** For a start from picks or datums: how far the result moved off them at
   *  the farthest, mm. */
  drift?: number
  /** The refinement drifted off the picks or datums by more than
   *  driftBound, and the result is the better of where they put the layer
   *  and where it drifted to — never confident. */
  drifted?: boolean
  /** Auto align only: another pose fits about as well, or the best is not
   *  confident — the result needs checking. */
  ambiguous?: boolean
  /** Overlaps enough, fits within CONFIDENT_RMS_SPACINGS, is constrained
   *  (MIN_CONSTRAINT), stayed on its picks, and started from a pose the user
   *  gave. */
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
/** Layer samples with no target point within this many target spacings (and
 *  NEAR_MIN mm) are paired as icp's FarPairs says, searched again once they
 *  have moved SLACK_SPACINGS. */
const NEAR_SPACINGS = 16
const NEAR_MIN = 1
const SLACK_SPACINGS = 1
/** The 200 k stage stops once a pass moves the layer less than this many
 *  target spacings. The 25 k stage keeps ICP's own, far tighter, stop: a
 *  layer sliding slowly along a face (layerAlign.test's shifted picks) must
 *  be let slide, and on 25 k samples that is cheap. */
const FINE_TOLERANCE = 0.005
/** Scoring reach, in target spacings. */
const SCORE_SPACINGS = 3
/** Layer points scored between two yields: the full-resolution score of a
 *  real pass is about a second of work, too long to hold a stop request. */
const SCORE_CHUNK = 100_000

/** A layer ready to align, its positions multiplied by `scale` first (25.4
 *  for a file in inches) so it lives in the target's millimetres. */
export function layerCloud(positions: Float32Array, normals: Float32Array, scale = 1): LayerCloud {
  const p = scale === 1 ? positions : positions.map((v) => v * scale)
  const s = sampleScan(p, normals, COARSE_SAMPLES)
  return {
    positions: p,
    normals,
    sample: Float32Array.from(s.xyz),
    sampleNormals: Float32Array.from(s.normals ?? []),
    fine: sampleScan(p, normals, FINE_SAMPLES),
  }
}

/** Picked pairs (a point on the layer, the same point on the target) solved in
 *  closed form, then refined. `layer` points are in the layer's frame as
 *  layerCloud left it: scaled, so millimetres. The closed-form pose goes
 *  straight to refineLayer, not through alignFromPairs, whose own ICP pairs
 *  without a distance bound and would drag a partly overlapping layer. Throws
 *  alignFromPairs' texts for fewer than three pairs, no solution, or pairs in
 *  a line. */
export function* alignPairs(
  target: ClosestSurface,
  layer: LayerCloud,
  pairs: { layer: Vec3; target: Vec3 }[],
  opts: Omit<RefineOptions, 'fromUserGuess'> = {},
): Steps<LayerAlignResult> {
  if (pairs.length < 3) throw new Error('Pick at least three point pairs — two cannot fix a rotation.')
  const solved = absoluteOrientation(pairs.map((p) => p.layer), pairs.map((p) => p.target))
  if (!solved) throw new Error('Could not solve the picked points.')
  if (solved.conditioning < 0.02) {
    throw new Error('The picked points are nearly in a line — add one away from that line, so the rotation about it is fixed.')
  }
  const spacing = spacingOf(target, opts)
  const refined = yield* refineLayer(target, layer, solved.transform, { ...opts, fromUserGuess: true })
  const residual = (pose: Rigid) => pairResidual(pairs, pose)
  return yield* heldToStart(target, layer, solved.transform, refined, residual, spacing)
}

/** The farthest a pose puts a picked layer point from its target point, mm. */
export function pairResidual(pairs: { layer: Vec3; target: Vec3 }[], pose: Rigid): number {
  const q = new Float64Array(3)
  let worst = 0
  for (const p of pairs) {
    rigidApply(pose, p.layer[0], p.layer[1], p.layer[2], q)
    worst = Math.max(worst, Math.hypot(q[0] - p.target[0], q[1] - p.target[1], q[2] - p.target[2]))
  }
  return worst
}

/** How far a refinement may carry the layer off its picks or datums: three
 *  target spacings, and never under 1 mm, since a click lands a few tenths
 *  off the point meant (layerAlign.test's rough picks are 0.4 mm out) and the
 *  closed form spreads that over the pairs. A refinement that slides further
 *  went to a different place than the one picked — on the Ruben head, 8.3 mm
 *  along the gasket face, with every boss off its pick by that much. */
/** The start fits about as well as a drifted refine when its matched share
 *  is within this of the refine's... */
const STAYS_MATCHED = 0.05
/** ...and its rms within this factor. */
const STAYS_RMS = 1.2

export function driftBound(spacing: number): number {
  return Math.max(3 * spacing, 1)
}

/**
 * A refinement held to the start the user's picks or datums gave. Within
 * driftBound of them it stands as it is. Beyond, it is never confident, and
 * the start is judged too: the start is returned when it fits about as well
 * (STAYS_MATCHED, STAYS_RMS) — the refine slid where the picks did not say —
 * and the refined pose when it fits clearly better, as on the Ruben head,
 * where the picks' own pose found 4 % of the layer on the target and the
 * pose 8.3 mm off them 59 %, which auto align found independently. Either
 * way it comes back flagged as drifted, for the person to look at.
 */
function* heldToStart(
  target: ClosestSurface,
  layer: LayerCloud,
  start: Rigid,
  refined: LayerAlignResult,
  residual: (pose: Rigid) => number,
  spacing: number,
): Steps<LayerAlignResult> {
  const bound = driftBound(spacing)
  const drift = residual(refined.pose)
  if (drift <= bound) return { ...refined, drift }
  const held = { ...(yield* judge(target, layer, start, spacing)), drift: residual(start) }
  const drifted = { ...refined, drift }
  const asGood = held.matched >= drifted.matched - STAYS_MATCHED && held.rms <= STAYS_RMS * drifted.rms
  return { ...(asGood ? held : drifted), confident: false, drifted: true }
}

export function* refineLayer(
  target: ClosestSurface,
  layer: LayerCloud,
  start: Rigid,
  opts: RefineOptions = {},
): Steps<LayerAlignResult> {
  const spacing = spacingOf(target, opts)
  const reuseFar = { near: Math.max(NEAR_SPACINGS * spacing, NEAR_MIN), slack: SLACK_SPACINGS * spacing }
  const icpOptions = { reuseFar, maxIterations: ITERATIONS, maxPairDistance: opts.maxPairDistance ?? MAX_PAIR, minNormalDot: MIN_NORMAL_DOT }

  const coarse = {
    xyz: Float64Array.from(layer.sample),
    normals: Float64Array.from(layer.sampleNormals),
    count: layer.sample.length / 3,
  }
  let pose = (yield* icpSteps(target, coarse, start, icpOptions)).transform
  pose = (yield* icpSteps(target, layer.fine, pose, { ...icpOptions, tolerance: FINE_TOLERANCE * spacing })).transform
  const r = yield* judge(target, layer, pose, spacing)
  return { ...r, confident: r.confident && opts.fromUserGuess !== false }
}

function spacingOf(target: ClosestSurface, opts: { targetSpacing?: number }): number {
  const spacing = opts.targetSpacing ?? (target instanceof CloudSurface ? target.spacing : NaN)
  if (!(spacing > 0)) throw new Error('refineLayer needs the target spacing for a target that is not a point cloud.')
  return spacing
}

/** A pose scored over every layer point, its constraint read on the 25 k
 *  sample, and judged by both. */
function* judge(target: ClosestSurface, layer: LayerCloud, pose: Rigid, spacing: number): Steps<LayerAlignResult> {
  const score = yield* scoreInChunks(target, layer, pose, SCORE_SPACINGS * spacing)
  yield
  const constraint = poseConstraint(target, { positions: layer.sample, normals: layer.sampleNormals }, pose, SCORE_SPACINGS * spacing)
  const { lowOverlap, confident } = poseConfidence(score, spacing)
  return { pose, rms: score.rms, matched: score.matched, lowOverlap, constraint, confident: confident && constraint >= MIN_CONSTRAINT }
}


/**
 * How firmly the surfaces a pose pairs pin it, in its weakest direction.
 * Point-to-plane ICP at the pose solves J·x = r for a twist x = (turn, move);
 * each matched point adds the row [(p − c) × n / L, n], c the matched points'
 * centroid and L their RMS distance from it, so a turn and a move are weighed
 * on one scale. The answer is λmin / λmax of JᵀJ, between 0 and 1: 0 when
 * some twist moves no point off its surface — a plane lets the layer slide in
 * it and turn about its normal; a lone bore, slide along and turn about its
 * axis — and ICP's resting place along that twist is wherever it stopped.
 * A slim part (a shaft, a thin rib) reads low too, its turn about its length
 * held only by small features: that errs on the safe side.
 */
export function poseConstraint(
  target: ClosestSurface,
  source: { positions: Float32Array; normals: Float32Array },
  pose: Rigid,
  maxPair: number,
): number {
  const n = source.positions.length / 3
  const hit = emptyHit()
  const p = new Float64Array(3)
  const sn = new Float64Array(3)
  const pts: number[] = []
  for (let i = 0; i < n; i++) {
    rigidApply(pose, source.positions[3 * i], source.positions[3 * i + 1], source.positions[3 * i + 2], p)
    rigidRotate(pose, source.normals[3 * i], source.normals[3 * i + 1], source.normals[3 * i + 2], sn)
    if (!target.closest(p[0], p[1], p[2], hit, maxPair)) continue
    if (sn[0] * hit.nx + sn[1] * hit.ny + sn[2] * hit.nz < MIN_NORMAL_DOT) continue
    pts.push(p[0], p[1], p[2], hit.nx, hit.ny, hit.nz)
  }
  const m = pts.length / 6
  if (m < 6) return 0
  const c = [0, 0, 0]
  for (let k = 0; k < pts.length; k += 6) for (let a = 0; a < 3; a++) c[a] += pts[k + a] / m
  let r2 = 0
  for (let k = 0; k < pts.length; k += 6) r2 += ((pts[k] - c[0]) ** 2 + (pts[k + 1] - c[1]) ** 2 + (pts[k + 2] - c[2]) ** 2) / m
  const L = Math.sqrt(r2) || 1
  const a = new Float64Array(36)
  const row = new Float64Array(6)
  for (let k = 0; k < pts.length; k += 6) {
    const x = (pts[k] - c[0]) / L, y = (pts[k + 1] - c[1]) / L, z = (pts[k + 2] - c[2]) / L
    const nx = pts[k + 3], ny = pts[k + 4], nz = pts[k + 5]
    row[0] = y * nz - z * ny; row[1] = z * nx - x * nz; row[2] = x * ny - y * nx
    row[3] = nx; row[4] = ny; row[5] = nz
    for (let i = 0; i < 6; i++) for (let j = i; j < 6; j++) a[6 * i + j] += row[i] * row[j]
  }
  for (let i = 0; i < 6; i++) for (let j = 0; j < i; j++) a[6 * i + j] = a[6 * j + i]
  const values = symmetricEigenN(6, a).values
  const hi = Math.max(...values), lo = Math.min(...values)
  return hi > 0 ? Math.max(0, lo) / hi : 0
}

/** scorePose over the layer a chunk at a time, yielding between chunks. */
function* scoreInChunks(
  target: ClosestSurface,
  layer: LayerCloud,
  pose: Rigid,
  maxPair: number,
): Steps<{ rms: number; matched: number }> {
  const n = layer.positions.length / 3
  let count = 0
  let sumSq = 0
  for (let i = 0; i < n; i += SCORE_CHUNK) {
    yield
    const end = Math.min(n, i + SCORE_CHUNK)
    const s = scorePose(target, { positions: layer.positions.subarray(3 * i, 3 * end), normals: layer.normals.subarray(3 * i, 3 * end) }, pose, maxPair)
    const c = Math.round(s.matched * (end - i))
    count += c
    if (c > 0) sumSq += s.rms * s.rms * c
  }
  return { rms: count > 0 ? Math.sqrt(sumSq / count) : Infinity, matched: n > 0 ? count / n : 0 }
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
      const refined = yield* refineLayer(target, layer, start, { ...opts, fromUserGuess: true })
      const sides = { ...layerDatums, primary, secondary }
      const r = yield* heldToStart(target, layer, start, refined, (pose) => datumResidual(sides, targetDatums, pose), spacingOf(target, opts))
      if (!best || (r.confident && !best.confident) || (r.confident === best.confident && r.rms < best.rms)) best = r
    }
  }
  return best ?? refused!
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]

/** A cone's apex: back along its axis from the centre by radius / tan(half angle). */
function apexOf(c: Extract<FitData, { kind: 'cone' }>): Vec3 {
  const back = c.radius / Math.tan((c.halfAngle * Math.PI) / 180)
  const l = Math.hypot(c.axis[0], c.axis[1], c.axis[2]) || 1
  return [c.center[0] - (back * c.axis[0]) / l, c.center[1] - (back * c.axis[1]) / l, c.center[2] - (back * c.axis[2]) / l]
}

/** Where a datum's position is read: what it fixes, not where along it the
 *  fit happened to centre. */
function datumGap(a: FitData, b: FitData): number {
  const ca = (a as { center?: Vec3 }).center, cb = (b as { center?: Vec3 }).center
  if (!ca || !cb) return 0
  const d: Vec3 = [ca[0] - cb[0], ca[1] - cb[1], ca[2] - cb[2]]
  const along = (u: Vec3) => {
    const l = Math.hypot(u[0], u[1], u[2]) || 1
    const k = (d[0] * u[0] + d[1] * u[1] + d[2] * u[2]) / l
    return Math.hypot(d[0] - k * u[0] / l, d[1] - k * u[1] / l, d[2] - k * u[2] / l)
  }
  if (b.kind === 'plane') {
    const n = b.normal, l = Math.hypot(n[0], n[1], n[2]) || 1
    return Math.abs(d[0] * n[0] + d[1] * n[1] + d[2] * n[2]) / l
  }
  if (b.kind === 'cylinder') return along(b.axis)
  // A cone is fixed along its axis too: by where its apex is.
  if (b.kind === 'cone' && a.kind === 'cone') return Math.hypot(...sub(apexOf(a), apexOf(b)))
  if (b.kind === 'cone') return along(b.axis)
  if (b.kind === 'line') return along(b.dir)
  return Math.hypot(d[0], d[1], d[2])
}

/** The farthest a pose puts a layer datum from the target's, mm: a plane
 *  by its offset, an axis by its distance from the other, a point or a
 *  ball by its centre. */
export function datumResidual(layer: DatumSet, target: DatumSet, pose: Rigid): number {
  const pairs: [FitData, FitData][] = [[layer.primary.fit, target.primary.fit]]
  if (layer.secondary && target.secondary) pairs.push([layer.secondary.fit, target.secondary.fit])
  if (layer.origin && target.origin) pairs.push([layer.origin, target.origin])
  return Math.max(...pairs.map(([a, b]) => datumGap(transformFit(a, pose), b)))
}

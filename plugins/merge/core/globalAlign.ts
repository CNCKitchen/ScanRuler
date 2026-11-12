// SPDX-License-Identifier: AGPL-3.0-only
// Auto align: a layer laid on its target from no start at all.
//
// Both clouds are thinned on one voxel grid to about ten thousand points each,
// every kept point described by a Fast Point Feature Histogram (Rusu, Blodow
// and Beetz, ICRA 2009) of how the normals around it turn, and points paired
// where each is the other's nearest descriptor. RANSAC over three such pairs
// at a time — the three edges agreeing in length on both sides first, so most
// draws cost a few comparisons — solves each draw in closed form (Horn) and
// counts the pairs it carries within 1.5 voxels. The best few distinct poses
// are each settled by ICP on a thinned sample, and the two best of those by
// the full refineLayer and scored over every layer point.
//
// The anti-goal is a confident wrong pose: a part with a repeating feature
// (the Revo gear) or a near-symmetric one has more than one pose that fits,
// and only the score can tell them apart. So the result is confident only
// when the best pose is confident by poseConfidence, is constrained in every
// direction (layerAlign's constraint), and beats the runner-up clearly — see
// ambiguityOf. Anything else comes back with ambiguous set, for the panel to
// say "check the result".
//
// Pure numerics: no DOM, no Three.js. Deterministic: one seeded generator.

import { absoluteOrientation } from '../../../src/core/deviation/absoluteOrientation'
import { icpSteps, sampleScan, type ScanSamples } from '../../../src/core/deviation/icp'
import { scorePose } from '../../../src/core/deviation/poseScore'
import { rigidApply, rigidCompose, rigidFromAxisAngle, rigidInvert, rigidRotationAngle, type Rigid } from '../../../src/core/deviation/rigid'
import type { Steps } from '../../../src/core/deviation/steps'
import type { ClosestSurface } from '../../../src/core/deviation/surface'
import { mulberry32 } from '../../../src/core/fit/ransac'
import { symmetricEigen3 } from '../../../src/core/fit/linalg'
import { CloudSurface } from '../../../src/core/deviation/cloudSurface'
import { PointKdTree } from '../../../src/core/geometry/pointKdTree'
import type { Vec3 } from '../../../src/core/types'
import { refineLayer, type LayerAlignResult, type LayerCloud } from './layerAlign'

/** What a layer is auto-aligned onto: its surface for ICP and scoring, and
 *  its points for the descriptors. */
export interface AlignTarget {
  surface: ClosestSurface
  positions: Float32Array
  normals: Float32Array
  /** Point spacing, mm: what the result is judged in. */
  spacing: number
}

export interface AutoAlignResult extends LayerAlignResult {
  /** More than one pose fits about as well, or the best is not confident:
   *  the result needs checking. */
  ambiguous: boolean
  /** Distinct poses RANSAC proposed. */
  hypotheses: number
}

export interface AutoAlignOptions {
  seed?: number
  /** RANSAC draws at most. Default 200 000. */
  iterations?: number
  /** RANSAC wall time at most, ms. Default 3000. */
  ransacMs?: number
  /** Distinct hypotheses settled by the light ICP. Default 6. */
  hypotheses?: number
  /** Progress text, as each stage starts. */
  progress?: (text: string) => void
  /** Each pose as a stage settles it, with its score on the 25 k sample —
   *  for measuring, not for the result. */
  inspect?: (stage: 'coarse' | 'settled' | 'refined', pose: Rigid, score: { rms: number; matched: number; tight: number }) => void
}

/** The descriptor's length: three angle features, 11 bins each. */
export const FPFH_BINS = 33
const SUB = 11
/** Voxels per bounding-box diagonal to start from, and the thinned count the
 *  grid is tuned towards (the larger cloud lands between 5 k and 15 k). */
const START_DIVISIONS = 150
const AIM = 10_000
const MIN_COUNT = 5_000
const MAX_COUNT = 15_000
/** Thinning is done on a sample this large: at a few hundred points a
 *  voxel, it reaches every voxel the full cloud does, at a tenth the cost. */
const THIN_FROM = 400_000
/** Feature radius, in voxels: about 80 neighbours on a surface. */
const FEATURE_VOXELS = 5
/** Fewer neighbours than this and a point has no shape to describe. */
const MIN_NEIGHBOURS = 8
/** Fewer mutual pairs than this, and the one-way ones are used. */
const MIN_MUTUAL = 50
/** A RANSAC pair is an inlier within this many voxels. */
const INLIER_VOXELS = 1.5
/** Three pairs whose edges disagree by more than this share are no draw. */
const EDGE_AGREEMENT = 0.9
/** Distinct hypotheses: turned more than this, or moved more than 2 voxels. */
const DISTINCT_RAD = (10 * Math.PI) / 180
const DISTINCT_VOXELS = 2
/** Settled poses closer than this are one. */
const SAME_RAD = (2 * Math.PI) / 180
/** Coarse ICP on the thinned clouds: samples and passes; how many RANSAC
 *  proposals get symmetry partners, and how many coarse poses go on. */
const COARSE_SAMPLES = 1_500
const COARSE_PASSES = 20
const PARTNERED = 2
const LIGHT_COUNT = 24
/** Turns tried about a part's most distinct axis. */
const SPIN_STEP = (15 * Math.PI) / 180
/** A settled runner-up with less than this share of the best's tight share
 *  is not refined: it trails by more than CLEAR_MARGIN however it settles. */
const HOPELESS = 0.5
/** Settled poses refined in search of a runner-up apart from the best. */
const RUNNER_UP_TRIES = 2
/** Light ICP: samples and passes. */
const LIGHT_SAMPLES = 6_000
const LIGHT_PASSES = 30
/** Scoring reach, in target spacings — refineLayer's. */
const SCORE_SPACINGS = 3
/** RANSAC draws between two yields. */
const DRAWS_PER_YIELD = 2_000

// ---- Thinning --------------------------------------------------------------

export interface Thinned {
  positions: Float32Array
  normals: Float32Array
  count: number
}

/** One point per occupied voxel: the mean of its points, and the mean of
 *  their normals renormalised. Points with no usable normal are left out. */
export function voxelThin(positions: ArrayLike<number>, normals: ArrayLike<number>, voxel: number): Thinned {
  const n = Math.floor(positions.length / 3)
  let x0 = Infinity, y0 = Infinity, z0 = Infinity
  for (let i = 0; i < n; i++) {
    const x = positions[3 * i], y = positions[3 * i + 1], z = positions[3 * i + 2]
    if (!Number.isFinite(x + y + z)) continue
    if (x < x0) x0 = x
    if (y < y0) y0 = y
    if (z < z0) z0 = z
  }
  const cell = new Map<number, number>()
  const acc: number[] = []
  const K = 1 << 20
  for (let i = 0; i < n; i++) {
    const x = positions[3 * i], y = positions[3 * i + 1], z = positions[3 * i + 2]
    const nx = normals[3 * i], ny = normals[3 * i + 1], nz = normals[3 * i + 2]
    if (!Number.isFinite(x + y + z + nx + ny + nz) || nx * nx + ny * ny + nz * nz < 0.25) continue
    const key = (Math.floor((x - x0) / voxel) * K + Math.floor((y - y0) / voxel)) * K + Math.floor((z - z0) / voxel)
    let slot = cell.get(key)
    if (slot === undefined) {
      slot = acc.length / 7
      cell.set(key, slot)
      acc.push(0, 0, 0, 0, 0, 0, 0)
    }
    const b = 7 * slot
    acc[b] += x; acc[b + 1] += y; acc[b + 2] += z
    acc[b + 3] += nx; acc[b + 4] += ny; acc[b + 5] += nz
    acc[b + 6]++
  }
  const slots = acc.length / 7
  const p = new Float32Array(3 * slots)
  const q = new Float32Array(3 * slots)
  let w = 0
  for (let s = 0; s < slots; s++) {
    const b = 7 * s
    const len = Math.hypot(acc[b + 3], acc[b + 4], acc[b + 5])
    // Normals that cancel (two sides of a thin wall in one voxel) say nothing.
    if (!(len > 0.3 * acc[b + 6])) continue
    p[3 * w] = acc[b] / acc[b + 6]; p[3 * w + 1] = acc[b + 1] / acc[b + 6]; p[3 * w + 2] = acc[b + 2] / acc[b + 6]
    q[3 * w] = acc[b + 3] / len; q[3 * w + 1] = acc[b + 4] / len; q[3 * w + 2] = acc[b + 5] / len
    w++
  }
  return { positions: p.slice(0, 3 * w), normals: q.slice(0, 3 * w), count: w }
}

function bboxDiagonal(p: ArrayLike<number>): number {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
  for (let i = 0; i + 2 < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2]
    if (!Number.isFinite(x + y + z)) continue
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
    if (z < z0) z0 = z
    if (z > z1) z1 = z
  }
  return x1 >= x0 ? Math.hypot(x1 - x0, y1 - y0, z1 - z0) : 0
}

/** Both clouds on one grid, its voxel tuned so the larger lands near AIM
 *  points (between MIN_COUNT and MAX_COUNT where it has that many). */
export function thinBoth(a: ScanSamples, b: ScanSamples): { a: Thinned; b: Thinned; voxel: number } {
  const diag = Math.max(bboxDiagonal(a.xyz), bboxDiagonal(b.xyz))
  let voxel = diag / START_DIVISIONS
  let ta = voxelThin(a.xyz, a.normals!, voxel)
  let tb = voxelThin(b.xyz, b.normals!, voxel)
  for (let k = 0; k < 8; k++) {
    const most = Math.max(ta.count, tb.count)
    if (most <= MAX_COUNT && (most >= MIN_COUNT || most >= 0.8 * Math.max(a.count, b.count))) break
    // A surface's count goes as 1 / voxel².
    voxel *= Math.min(3, Math.max(1 / 3, Math.sqrt(most / AIM)))
    ta = voxelThin(a.xyz, a.normals!, voxel)
    tb = voxelThin(b.xyz, b.normals!, voxel)
  }
  return { a: ta, b: tb, voxel }
}

// ---- FPFH ------------------------------------------------------------------

const bin = (v: number, lo: number, hi: number) => Math.min(SUB - 1, Math.max(0, Math.floor(((v - lo) / (hi - lo)) * SUB)))

/** The three angle features of a pair of oriented points, binned into `h`
 *  at `base` — the Darboux frame of whichever point's normal lies closer to
 *  the line between them, so the features do not depend on the order. */
function pairFeatures(
  px: number, py: number, pz: number, nx: number, ny: number, nz: number,
  qx: number, qy: number, qz: number, mx: number, my: number, mz: number,
  h: Float32Array, base: number,
): boolean {
  let dx = qx - px, dy = qy - py, dz = qz - pz
  const d = Math.hypot(dx, dy, dz)
  if (!(d > 0)) return false
  dx /= d; dy /= d; dz /= d
  // Source s, target t: s is the point whose normal makes the smaller angle with the line.
  let ux = nx, uy = ny, uz = nz, tx = mx, ty = my, tz = mz
  if (Math.abs(nx * dx + ny * dy + nz * dz) < Math.abs(mx * dx + my * dy + mz * dz)) {
    ux = mx; uy = my; uz = mz; tx = nx; ty = ny; tz = nz
    dx = -dx; dy = -dy; dz = -dz
  }
  // v = u × d, w = u × v
  let vx = uy * dz - uz * dy, vy = uz * dx - ux * dz, vz = ux * dy - uy * dx
  const vl = Math.hypot(vx, vy, vz)
  if (!(vl > 1e-9)) return false
  vx /= vl; vy /= vl; vz /= vl
  const wx = uy * vz - uz * vy, wy = uz * vx - ux * vz, wz = ux * vy - uy * vx
  const alpha = vx * tx + vy * ty + vz * tz
  const phi = ux * dx + uy * dy + uz * dz
  const theta = Math.atan2(wx * tx + wy * ty + wz * tz, ux * tx + uy * ty + uz * tz)
  h[base + bin(alpha, -1, 1)]++
  h[base + SUB + bin(phi, -1, 1)]++
  h[base + 2 * SUB + bin(theta, -Math.PI, Math.PI)]++
  return true
}

/** Each of the three sub-histograms scaled to sum 100. */
function normaliseHist(h: Float32Array, base: number): void {
  for (let s = 0; s < 3; s++) {
    let sum = 0
    for (let k = 0; k < SUB; k++) sum += h[base + s * SUB + k]
    if (sum > 0) for (let k = 0; k < SUB; k++) h[base + s * SUB + k] *= 100 / sum
  }
}

export interface Descriptors {
  /** FPFH_BINS floats a point. */
  features: Float32Array
  /** False for a point with too few neighbours to describe. */
  valid: Uint8Array
}

/**
 * Fast Point Feature Histograms. The simplified histogram (SPFH) of a point
 * bins the pair features between it and each neighbour within `radius`; its
 * FPFH is its own SPFH plus the mean of its neighbours' SPFHs, each weighted
 * by the inverse of its distance. Invariant to rigid motion, since every
 * feature is an angle in a frame built from the points themselves.
 */
export function* fpfhSteps(c: Thinned, radius: number): Steps<Descriptors> {
  const n = c.count
  const p = c.positions, nm = c.normals
  const tree = new PointKdTree(p)
  const spfh = new Float32Array(n * FPFH_BINS)
  const offsets = new Int32Array(n + 1)
  const neigh: number[] = []
  const dist: number[] = []
  const around: number[] = []
  for (let i = 0; i < n; i++) {
    if ((i & 1023) === 0) yield
    tree.withinRadius(p[3 * i], p[3 * i + 1], p[3 * i + 2], radius, around)
    for (const j of around) {
      if (j === i) continue
      if (!pairFeatures(p[3 * i], p[3 * i + 1], p[3 * i + 2], nm[3 * i], nm[3 * i + 1], nm[3 * i + 2],
        p[3 * j], p[3 * j + 1], p[3 * j + 2], nm[3 * j], nm[3 * j + 1], nm[3 * j + 2], spfh, i * FPFH_BINS)) continue
      neigh.push(j)
      dist.push(Math.hypot(p[3 * j] - p[3 * i], p[3 * j + 1] - p[3 * i + 1], p[3 * j + 2] - p[3 * i + 2]))
    }
    offsets[i + 1] = neigh.length
    normaliseHist(spfh, i * FPFH_BINS)
  }
  const features = new Float32Array(n * FPFH_BINS)
  const valid = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    if ((i & 1023) === 0) yield
    const lo = offsets[i], hi = offsets[i + 1]
    if (hi - lo < MIN_NEIGHBOURS) continue
    valid[i] = 1
    const f = i * FPFH_BINS
    let wsum = 0
    for (let k = lo; k < hi; k++) wsum += 1 / dist[k]
    for (let k = lo; k < hi; k++) {
      const w = 1 / dist[k] / wsum
      const g = neigh[k] * FPFH_BINS
      for (let b = 0; b < FPFH_BINS; b++) features[f + b] += w * spfh[g + b]
    }
    for (let b = 0; b < FPFH_BINS; b++) features[f + b] += spfh[f + b]
    normaliseHist(features, f)
  }
  return { features, valid }
}

// ---- Correspondences -------------------------------------------------------

/** For each valid row of `a`, the valid row of `b` nearest in descriptor
 *  space (-1 for none). Brute force with an early exit on the partial sum:
 *  at ten thousand a side a tree in 33 dimensions prunes little. */
function* nearestRows(a: Descriptors, na: number, b: Descriptors, nb: number, rows: Uint8Array | null): Steps<Int32Array> {
  const out = new Int32Array(na).fill(-1)
  const fa = a.features, fb = b.features
  for (let i = 0; i < na; i++) {
    if ((i & 255) === 0) yield
    if (!a.valid[i] || (rows && rows[i] === 0)) continue
    const ia = i * FPFH_BINS
    let best = Infinity, arg = -1
    for (let j = 0; j < nb; j++) {
      if (!b.valid[j]) continue
      const jb = j * FPFH_BINS
      let s = 0
      for (let k = 0; k < FPFH_BINS; k++) {
        const d = fa[ia + k] - fb[jb + k]
        s += d * d
        if (s >= best) break
      }
      if (s < best) { best = s; arg = j }
    }
    out[i] = arg
  }
  return out
}

/** Pairs (layer point, target point) that are each other's nearest descriptor. */
export function* mutualMatches(layer: Descriptors, nl: number, target: Descriptors, nt: number): Steps<Int32Array> {
  const forward = yield* nearestRows(layer, nl, target, nt, null)
  const wanted = new Uint8Array(nt)
  for (let i = 0; i < nl; i++) if (forward[i] >= 0) wanted[forward[i]] = 1
  const backward = yield* nearestRows(target, nt, layer, nl, wanted)
  const pairs: number[] = []
  for (let i = 0; i < nl; i++) {
    const j = forward[i]
    if (j >= 0 && backward[j] === i) pairs.push(i, j)
  }
  // A shape whose points all look alike (a ball, a plain cylinder) has few
  // mutual pairs; the one-way ones still let RANSAC propose its many poses,
  // which the ambiguity check then reports.
  if (pairs.length / 2 < MIN_MUTUAL) {
    pairs.length = 0
    for (let i = 0; i < nl; i++) if (forward[i] >= 0) pairs.push(i, forward[i])
  }
  return Int32Array.from(pairs)
}

// ---- RANSAC ----------------------------------------------------------------

interface Hypothesis {
  pose: Rigid
  /** Pairs carried within INLIER_VOXELS. */
  inliers: number
}

const dist3 = (p: Float32Array, i: number, j: number) => Math.hypot(p[3 * i] - p[3 * j], p[3 * i + 1] - p[3 * j + 1], p[3 * i + 2] - p[3 * j + 2])
const vecOf = (p: Float32Array, i: number): Vec3 => [p[3 * i], p[3 * i + 1], p[3 * i + 2]]

function countInliers(pose: Rigid, lp: Float32Array, tp: Float32Array, pairs: Int32Array, reach2: number, keep?: number[]): number {
  const r = pose.r, t = pose.t
  let c = 0
  for (let k = 0; k < pairs.length; k += 2) {
    const i = 3 * pairs[k], j = 3 * pairs[k + 1]
    const x = lp[i], y = lp[i + 1], z = lp[i + 2]
    const dx = r[0] * x + r[1] * y + r[2] * z + t[0] - tp[j]
    const dy = r[3] * x + r[4] * y + r[5] * z + t[1] - tp[j + 1]
    const dz = r[6] * x + r[7] * y + r[8] * z + t[2] - tp[j + 2]
    if (dx * dx + dy * dy + dz * dz <= reach2) {
      c++
      keep?.push(k)
    }
  }
  return c
}

/** Poses from three matched pairs at a time, each re-solved over the pairs
 *  it carries; every draw with at least six inliers is kept. */
export function* ransacSteps(
  layer: Thinned,
  target: Thinned,
  pairs: Int32Array,
  voxel: number,
  opts: { seed: number; iterations: number; ms: number },
): Steps<Hypothesis[]> {
  const m = pairs.length / 2
  const out: Hypothesis[] = []
  if (m < 3) return out
  const rand = mulberry32(opts.seed)
  const lp = layer.positions, tp = target.positions
  const reach2 = (INLIER_VOXELS * voxel) ** 2
  const minEdge = 3 * voxel
  const t0 = Date.now()
  for (let it = 0; it < opts.iterations; it++) {
    if (it % DRAWS_PER_YIELD === 0) {
      if (it > 0 && Date.now() - t0 > opts.ms) break
      yield
    }
    const a = Math.floor(rand() * m), b = Math.floor(rand() * m), c = Math.floor(rand() * m)
    if (a === b || b === c || a === c) continue
    const la = pairs[2 * a], lb = pairs[2 * b], lc = pairs[2 * c]
    const ta = pairs[2 * a + 1], tb = pairs[2 * b + 1], tc = pairs[2 * c + 1]
    let ok = true
    for (const [u, v, s, w] of [[la, lb, ta, tb], [lb, lc, tb, tc], [la, lc, ta, tc]]) {
      const dl = dist3(lp, u, v), dt = dist3(tp, s, w)
      if (dl < minEdge || dt < minEdge || Math.min(dl, dt) < EDGE_AGREEMENT * Math.max(dl, dt)) { ok = false; break }
    }
    if (!ok) continue
    const solved = absoluteOrientation([vecOf(lp, la), vecOf(lp, lb), vecOf(lp, lc)], [vecOf(tp, ta), vecOf(tp, tb), vecOf(tp, tc)])
    if (!solved || solved.conditioning < 0.05) continue
    const inliers = countInliers(solved.transform, lp, tp, pairs, reach2)
    if (inliers < 6) continue
    // One local re-solve over the pairs the draw carries.
    const keep: number[] = []
    countInliers(solved.transform, lp, tp, pairs, reach2, keep)
    const again = absoluteOrientation(keep.map((k) => vecOf(lp, pairs[k])), keep.map((k) => vecOf(tp, pairs[k + 1])))
    let pose = solved.transform, best = inliers
    if (again) {
      const n2 = countInliers(again.transform, lp, tp, pairs, reach2)
      if (n2 >= inliers) { pose = again.transform; best = n2 }
    }
    out.push({ pose, inliers: best })
  }
  return out
}

/** Two poses place the layer differently: turned more than `rad` apart, or
 *  its centre moved more than `mm`. */
function distinct(a: Rigid, b: Rigid, centre: Vec3, rad: number, mm: number): boolean {
  if (rigidRotationAngle(rigidCompose(rigidInvert(a), b)) > rad) return true
  const p = new Float64Array(3), q = new Float64Array(3)
  rigidApply(a, centre[0], centre[1], centre[2], p)
  rigidApply(b, centre[0], centre[1], centre[2], q)
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) > mm
}

/** The best `count` hypotheses, by inliers, no two alike. */
function topDistinct<T extends { pose: Rigid }>(sorted: T[], count: number, centre: Vec3, rad: number, mm: number): T[] {
  const kept: T[] = []
  for (const h of sorted) {
    if (kept.length >= count) break
    if (kept.every((k) => distinct(k.pose, h.pose, centre, rad, mm))) kept.push(h)
  }
  return kept
}

function centreOf(p: Float32Array): Vec3 {
  const c: Vec3 = [0, 0, 0]
  const n = p.length / 3
  for (let i = 0; i < p.length; i += 3) { c[0] += p[i]; c[1] += p[i + 1]; c[2] += p[i + 2] }
  return n > 0 ? [c[0] / n, c[1] / n, c[2] / n] : c
}

// ---- Symmetry partners -----------------------------------------------------

/** Rotation by `angle` about `axis` through `centre`, as a pose. */
function turnAbout(axis: Vec3, angle: number, centre: Vec3): Rigid {
  const m = rigidFromAxisAngle(axis, angle)
  const rc = new Float64Array(3)
  rigidApply(m, centre[0], centre[1], centre[2], rc)
  m.t[0] = centre[0] - rc[0]; m.t[1] = centre[1] - rc[1]; m.t[2] = centre[2] - rc[2]
  return m
}

/**
 * Poses a near-symmetric part could as well be in, given one it was found
 * in: half turns about each principal axis of the layer, and turns in
 * SPIN_STEP steps about its most distinct one (a plate's normal, a shaft's
 * axis), with and without a half turn about another. Descriptors cannot tell
 * these apart where the part repeats — on the Revo gear every RANSAC pose
 * for 0905_01 was the one with the gear's faces swapped, 180 degrees from
 * Revo's, which fits three times worse once tried — so they are tried, and
 * the score decides.
 */
function partners(h: Rigid, layer: Thinned): Rigid[] {
  const p = layer.positions, n = layer.count
  const c = centreOf(p)
  const cov = new Float64Array(9)
  for (let i = 0; i < n; i++) {
    const d = [p[3 * i] - c[0], p[3 * i + 1] - c[1], p[3 * i + 2] - c[2]]
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) cov[3 * a + b] += d[a] * d[b]
  }
  const { values, vectors } = symmetricEigen3(cov)
  // The axis whose spread stands furthest from the other two (ascending values).
  const spin = values[1] - values[0] >= values[2] - values[1] ? 0 : 2
  const other = spin === 0 ? 2 : 0
  const out: Rigid[] = []
  for (const v of vectors) out.push(rigidCompose(h, turnAbout(v, Math.PI, c)))
  const flip = turnAbout(vectors[other], Math.PI, c)
  for (let k = 1; k * SPIN_STEP < 2 * Math.PI - 1e-9; k++) {
    const turn = turnAbout(vectors[spin], k * SPIN_STEP, c)
    out.push(rigidCompose(h, turn), rigidCompose(h, rigidCompose(turn, flip)))
  }
  return out
}

/**
 * A partner keeps its turn but takes the move the matched pairs vote for
 * under it. Turned back from a face-swapped pose about an axis through the
 * layer's centroid, the Revo gear lands 8 to 11 mm off along its axis — the
 * centroid of a one-sided view is not the part's — further than ICP reaches,
 * while the few pairs that are right under the turn agree on one move.
 * Votes are counted on a grid of 1.5 voxels, each pair's move with its 26
 * neighbouring cells; a turn no move gathers six votes for keeps its own.
 */
function placedByVote(q: Rigid, layer: Thinned, target: Thinned, pairs: Int32Array, voxel: number): Rigid {
  const cell = INLIER_VOXELS * voxel
  const votes = new Map<string, number>()
  const moves: number[] = []
  const p = new Float64Array(3)
  for (let k = 0; k < pairs.length; k += 2) {
    const i = pairs[k], j = pairs[k + 1]
    rigidApply({ r: q.r, t: new Float64Array(3) }, layer.positions[3 * i], layer.positions[3 * i + 1], layer.positions[3 * i + 2], p)
    const tx = target.positions[3 * j] - p[0], ty = target.positions[3 * j + 1] - p[1], tz = target.positions[3 * j + 2] - p[2]
    moves.push(tx, ty, tz)
    const key = `${Math.floor(tx / cell)},${Math.floor(ty / cell)},${Math.floor(tz / cell)}`
    votes.set(key, (votes.get(key) ?? 0) + 1)
  }
  let best = -1, most = 0
  for (let m = 0; m < moves.length; m += 3) {
    const cx = Math.floor(moves[m] / cell), cy = Math.floor(moves[m + 1] / cell), cz = Math.floor(moves[m + 2] / cell)
    let n = 0
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) n += votes.get(`${cx + a},${cy + b},${cz + c}`) ?? 0
    if (n > most) { most = n; best = m }
  }
  if (most < 6) return q
  // The move: the mean of those within a cell of the winner.
  const t = [0, 0, 0]
  let n = 0
  for (let m = 0; m < moves.length; m += 3) {
    if (Math.hypot(moves[m] - moves[best], moves[m + 1] - moves[best + 1], moves[m + 2] - moves[best + 2]) > cell) continue
    t[0] += moves[m]; t[1] += moves[m + 1]; t[2] += moves[m + 2]; n++
  }
  return { r: q.r.slice(), t: Float64Array.from([t[0] / n, t[1] / n, t[2] / n]) }
}

// ---- Ranking ----------------------------------------------------------------

/** How much better the best must be than the runner-up for the best to be
 *  trusted: its tight share (layer points within one target spacing of the
 *  target) at least this much above, as a share of it. See ambiguityOf. */
export const CLEAR_MARGIN = 0.15

/** Whether the best refined pose is clearly the one: confident itself
 *  (poseConfidence and the constraint), and the runner-up's tight share
 *  trailing its own by CLEAR_MARGIN. */
export function ambiguityOf(
  best: LayerAlignResult & { tight: number },
  runnerUp: (LayerAlignResult & { tight: number }) | null,
): boolean {
  if (!best.confident) return true
  if (!runnerUp) return false
  return !(best.tight >= (1 + CLEAR_MARGIN) * runnerUp.tight)
}

// ---- The whole -------------------------------------------------------------

/** Lay `layer` on `target` from no start. See the head of the file. */
export function* autoAlign(target: AlignTarget, layer: LayerCloud, opts: AutoAlignOptions = {}): Steps<AutoAlignResult> {
  const say = opts.progress ?? (() => {})
  const inspect = opts.inspect
  const spacing = target.spacing
  if (!(spacing > 0)) throw new Error('autoAlign needs the target spacing.')
  const clock = timer()

  say('Describing the shapes…')
  yield
  const targetSample = sampleScan(target.positions, target.normals, THIN_FROM, 0x7a29)
  const layerSample = sampleScan(layer.positions, layer.normals, THIN_FROM, 0x1a7e)
  const { a: lt, b: tt, voxel } = thinBoth(layerSample, targetSample)
  const lf = yield* fpfhSteps(lt, FEATURE_VOXELS * voxel)
  const tf = yield* fpfhSteps(tt, FEATURE_VOXELS * voxel)
  clock('describe')

  say('Matching the shapes…')
  const pairs = yield* mutualMatches(lf, lt.count, tf, tt.count)
  clock('match')
  const drawn = yield* ransacSteps(lt, tt, pairs, voxel, {
    seed: opts.seed ?? 0x5ca1e,
    iterations: opts.iterations ?? 200_000,
    ms: opts.ransacMs ?? 3000,
  })
  drawn.sort((a, b) => b.inliers - a.inliers)
  const centre = centreOf(lt.positions)
  const proposed = topDistinct(drawn, opts.hypotheses ?? 6, centre, DISTINCT_RAD, DISTINCT_VOXELS * voxel)
  if (proposed.length === 0) throw new Error('Auto align found nothing the layer and its target share — place it by hand, by pairs or by datums.')
  clock('ransac')

  // Every proposal, and the symmetry partners of the best, settled coarsely
  // on the thinned clouds and scored there by the share within half a voxel.
  say('Trying the likely poses…')
  const starts: Rigid[] = proposed.map((h) => h.pose)
  for (const h of proposed.slice(0, PARTNERED)) {
    for (const q of partners(h.pose, lt)) starts.push(placedByVote(q, lt, tt, pairs, voxel))
  }
  const thinTarget = new CloudSurface(tt.positions, tt.normals, voxel)
  const coarse: ScanSamples = sampleScan(lt.positions, lt.normals, COARSE_SAMPLES, 0x22)
  const thinLayer = { positions: lt.positions, normals: lt.normals }
  const rough: { pose: Rigid; quality: number }[] = []
  for (const s of starts) {
    const r = yield* icpSteps(thinTarget, coarse, s, { maxIterations: COARSE_PASSES, maxPairDistance: 6 * voxel, minNormalDot: 0.5 })
    rough.push({ pose: r.transform, quality: scorePose(thinTarget, thinLayer, r.transform, 0.5 * voxel).matched })
  }
  rough.sort((a, b) => b.quality - a.quality)
  if (inspect) for (const r of rough) inspect('coarse', r.pose, { rms: NaN, matched: NaN, tight: r.quality })
  const shortlist = topDistinct(rough, LIGHT_COUNT, centre, DISTINCT_RAD, 4 * voxel)
  clock(`coarse ${starts.length}`)

  // The shortlist settled on the full clouds from a 6 k sample, ranked by
  // the share of the 25 k sample within one target spacing.
  const light: ScanSamples = sampleScan(layer.sample, layer.sampleNormals, LIGHT_SAMPLES, 0x11)
  const sample = { positions: layer.sample, normals: layer.sampleNormals }
  const tightOf = (pose: Rigid) => scorePose(target.surface, sample, pose, spacing).matched
  const settled: { pose: Rigid; quality: number }[] = []
  for (const h of shortlist) {
    const r = yield* icpSteps(target.surface, light, h.pose, { maxIterations: LIGHT_PASSES, maxPairDistance: 4 * voxel, minNormalDot: 0.5 })
    yield
    const tight = tightOf(r.transform)
    if (inspect) inspect('settled', r.transform, { ...scorePose(target.surface, sample, r.transform, SCORE_SPACINGS * spacing), tight })
    settled.push({ pose: r.transform, quality: tight })
  }
  settled.sort((a, b) => b.quality - a.quality)
  clock('light')

  // The best refined in full; the runner-up is the next settled pose that
  // stays apart from it, refined too: two that settle on one pose are one.
  say('Refining the best poses…')
  const refine = function* (pose: Rigid) {
    const r = yield* refineLayer(target.surface, layer, pose, { targetSpacing: spacing })
    yield
    const tight = tightOf(r.pose)
    if (inspect) inspect('refined', r.pose, { rms: r.rms, matched: r.matched, tight })
    return { ...r, tight }
  }
  const first = yield* refine(settled[0].pose)
  let runnerUp: (typeof first) | null = null
  let tries = 0
  for (const s of settled.slice(1)) {
    if (!distinct(first.pose, s.pose, centre, SAME_RAD, voxel)) continue
    if (tries++ >= RUNNER_UP_TRIES) break
    // Far behind already, it is a runner-up as it stands: refining a pose
    // that found a twentieth of what the best did is the slowest refine
    // there is (48 s on the Ruben head) and cannot close a gap that wide.
    if (s.quality < HOPELESS * first.tight) {
      runnerUp = { pose: s.pose, rms: NaN, matched: NaN, lowOverlap: true, constraint: 0, confident: false, tight: s.quality }
      break
    }
    const r = yield* refine(s.pose)
    if (distinct(first.pose, r.pose, centre, SAME_RAD, voxel)) {
      runnerUp = r
      break
    }
  }
  // The runner-up may refine to the better fit; then they swap.
  const [top, next] = runnerUp && runnerUp.tight > first.tight ? [runnerUp, first] : [first, runnerUp]
  clock('refine')
  const ambiguous = ambiguityOf(top, next)
  const { tight, ...best } = top
  void tight
  return { ...best, confident: best.confident && !ambiguous, ambiguous, hypotheses: starts.length }
}

/** Stage times on stderr under AUTO_DEBUG — for profiling, never shown. */
function timer(): (stage: string) => void {
  const debug = typeof process !== 'undefined' && !!process.env?.AUTO_DEBUG
  let t = Date.now()
  return (stage) => {
    if (!debug) return
    const now = Date.now()
    process.stderr.write(`auto ${stage}: ${now - t} ms\n`)
    t = now
  }
}

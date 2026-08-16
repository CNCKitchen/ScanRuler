// SPDX-License-Identifier: AGPL-3.0-only
import { solveLinear } from '../fit/linalg'
import { mulberry32 } from '../fit/ransac'
import {
  cloneRigid,
  reorthonormalize,
  rigidApply,
  rigidCompose,
  rigidFromTwist,
  rigidRotate,
  type Rigid,
} from './rigid'
import { emptyHit, type NominalSurface } from './surface'

/** A thinned copy of the scan, in the scan's own frame, that ICP iterates on.
 *  Every iteration is one closest-point query per sample, so this is the knob
 *  that decides whether an alignment takes a moment or a minute — and past a
 *  few thousand well-spread points the transform stops improving. */
export interface ScanSamples {
  xyz: Float64Array
  normals: Float64Array | null
  count: number
}

export interface IcpOptions {
  maxIterations?: number
  /** Drop a pair whose point-to-surface distance exceeds this multiple of the
   *  current iteration's median. Adaptive, so it is loose while the part is
   *  still far away and tightens by itself as the fit closes in. */
  rejectMedianFactor?: number
  /** Drop a pair whose scan normal disagrees with the nominal's by more than
   *  `acos(minNormalDot)` — stops a surface from latching onto the far wall. */
  minNormalDot?: number
  /** Hard ceiling on how far a sample may reach for reference surface, in mm.
   *  Unlike the median cut-off this one does not adapt: it is the user's
   *  statement that nothing further away is the same feature, which is what
   *  keeps a fine fit from walking the part onto the neighbouring boss. */
  maxPairDistance?: number
  /** Distance at which a sample stops counting for more in the pose score, in
   *  mm. Defaults to 5 % of the nominal's bounding-box diagonal. */
  scoreCap?: number
  /** Stop once a step moves the part less than this many millimetres. */
  tolerance?: number
  onIteration?: (iteration: number, meanDistance: number, transform: Rigid) => void
}

export interface IcpResult {
  transform: Rigid
  iterations: number
  /** RMS of the accepted point-to-plane residuals, in mm. */
  rms: number
  /** Mean absolute point-to-surface distance over accepted pairs, in mm. */
  meanDistance: number
  /** The quantity actually minimised when choosing between poses: the mean
   *  over every sample of its distance to the surface, capped. Lower is a
   *  better placement of the *whole* scan, not of a convenient subset. */
  score: number
  matched: number
  sampled: number
  converged: boolean
}

/** Evenly thinned sample of a scan's vertices. A deterministic stride with a
 *  random phase beats a random draw here: the mesh vertices already tile the
 *  surface uniformly, so a stride inherits that spread, and repeat runs on the
 *  same scan give the same answer. */
export function sampleScan(
  positions: Float32Array,
  normals: Float32Array | null,
  wanted: number,
  seed = 0x5eed,
): ScanSamples {
  const total = positions.length / 3
  const count = Math.min(wanted, total)
  if (count <= 0) return { xyz: new Float64Array(0), normals: null, count: 0 }

  const stride = total / count
  const rand = mulberry32(seed)
  const phase = rand()
  const xyz = new Float64Array(count * 3)
  const nrm = normals ? new Float64Array(count * 3) : null
  for (let i = 0; i < count; i++) {
    const v = Math.min(total - 1, Math.floor((i + phase) * stride))
    xyz[i * 3] = positions[v * 3]
    xyz[i * 3 + 1] = positions[v * 3 + 1]
    xyz[i * 3 + 2] = positions[v * 3 + 2]
    if (nrm && normals) {
      nrm[i * 3] = normals[v * 3]
      nrm[i * 3 + 1] = normals[v * 3 + 1]
      nrm[i * 3 + 2] = normals[v * 3 + 2]
    }
  }
  return { xyz, normals: nrm, count }
}

/**
 * Point-to-plane ICP fitting `samples` (scan frame) onto `surface` (nominal
 * frame), starting from `initial`.
 *
 * Point-to-plane rather than point-to-point because a scan slides freely along
 * the surface it is being matched to: penalising only the distance *across*
 * the surface lets the part shear into place in a handful of iterations where
 * point-to-point would crawl, and it is what makes a flat, feature-poor face
 * contribute nothing spurious to the rotation.
 *
 * The incremental rotation is taken about the centroid of the correspondences,
 * not the origin. With a part sitting 100 mm out, an origin-centred increment
 * couples rotation and translation so tightly that the 6×6 system is nearly
 * singular; centring it decouples them and the solve stays well conditioned.
 */
export function icp(
  surface: NominalSurface,
  samples: ScanSamples,
  initial: Rigid,
  options: IcpOptions = {},
): IcpResult {
  const maxIterations = options.maxIterations ?? 60
  const rejectMedianFactor = options.rejectMedianFactor ?? 3
  const minNormalDot = options.minNormalDot ?? 0
  const maxPairDistance = options.maxPairDistance ?? Infinity
  const tolerance = options.tolerance ?? surface.bboxDiagonal * 1e-7
  const scoreCap = options.scoreCap ?? surface.bboxDiagonal * 0.05

  let transform = cloneRigid(initial)
  let best = cloneRigid(initial)
  let bestScore = Infinity
  let bestRms = Infinity
  let bestMean = Infinity
  let bestMatched = 0
  let iterations = 0
  let converged = false

  const n = samples.count
  const q = new Float64Array(n * 3) // sample in the nominal frame
  const cp = new Float64Array(n * 3) // its closest point
  const cn = new Float64Array(n * 3) // pseudonormal there
  const dist = new Float64Array(n)
  /** Has a usable correspondence and survived the outlier cut, so it drives
   *  the step. */
  const ok = new Uint8Array(n)
  const sorted = new Float64Array(n)
  const hit = emptyHit()
  const p = new Float64Array(3)
  const sn = new Float64Array(3)

  // Normal equations for [ω, τ]: 6×6 and its right-hand side.
  const ata = new Float64Array(36)
  const atb = new Float64Array(6)
  const row = new Float64Array(6)

  for (let iter = 0; iter < maxIterations; iter++) {
    iterations = iter + 1

    let found = 0
    // Truncated mean distance over *every* sample, not just the ones that
    // survive the cut. Scoring the survivors alone is worse than useless: the
    // cut is a multiple of the median, so a pose that slides until only a
    // well-fitting patch still corresponds gets a *better* average from fewer
    // pairs, and the fit walks off the part chasing it. Capping the far ones
    // keeps outliers from dominating while still charging for every sample the
    // pose failed to place.
    let scoreSum = 0
    for (let i = 0; i < n; i++) {
      ok[i] = 0
      rigidApply(transform, samples.xyz[i * 3], samples.xyz[i * 3 + 1], samples.xyz[i * 3 + 2], p)
      q[i * 3] = p[0]; q[i * 3 + 1] = p[1]; q[i * 3 + 2] = p[2]
      if (!surface.closest(p[0], p[1], p[2], hit)) {
        scoreSum += scoreCap
        continue
      }
      // Out of reach counts against the pose exactly as a miss does — a fit
      // that solves by sliding until only a handful of points still answer
      // must not be rewarded for the ones it abandoned.
      if (hit.distance > maxPairDistance) {
        scoreSum += scoreCap
        continue
      }
      if (samples.normals) {
        rigidRotate(
          transform,
          samples.normals[i * 3], samples.normals[i * 3 + 1], samples.normals[i * 3 + 2],
          sn,
        )
        if (sn[0] * hit.nx + sn[1] * hit.ny + sn[2] * hit.nz < minNormalDot) {
          scoreSum += scoreCap
          continue
        }
      }
      cp[i * 3] = hit.px; cp[i * 3 + 1] = hit.py; cp[i * 3 + 2] = hit.pz
      cn[i * 3] = hit.nx; cn[i * 3 + 1] = hit.ny; cn[i * 3 + 2] = hit.nz
      dist[i] = hit.distance
      scoreSum += hit.distance < scoreCap ? hit.distance : scoreCap
      sorted[found++] = hit.distance
      ok[i] = 1
    }
    const score = scoreSum / n
    if (found < 3) break

    // Median-based cut-off, with a floor so a fit that has genuinely converged
    // to near-zero residual does not start rejecting its own good pairs.
    const head = sorted.subarray(0, found)
    head.sort()
    const median = head[found >> 1]
    const cutoff = Math.max(median * rejectMedianFactor, surface.bboxDiagonal * 1e-5)

    let cx = 0, cy = 0, cz = 0
    let matched = 0
    let sumAbs = 0
    for (let i = 0; i < n; i++) {
      if (!ok[i]) continue
      if (dist[i] > cutoff) {
        ok[i] = 0
        continue
      }
      cx += q[i * 3]; cy += q[i * 3 + 1]; cz += q[i * 3 + 2]
      sumAbs += dist[i]
      matched++
    }
    if (matched < 6) break
    cx /= matched; cy /= matched; cz /= matched

    ata.fill(0)
    atb.fill(0)
    let sumSq = 0
    for (let i = 0; i < n; i++) {
      if (!ok[i]) continue
      const qx = q[i * 3] - cx, qy = q[i * 3 + 1] - cy, qz = q[i * 3 + 2] - cz
      const nx = cn[i * 3], ny = cn[i * 3 + 1], nz = cn[i * 3 + 2]
      // Signed distance across the surface — the quantity being driven to zero.
      const r =
        (q[i * 3] - cp[i * 3]) * nx +
        (q[i * 3 + 1] - cp[i * 3 + 1]) * ny +
        (q[i * 3 + 2] - cp[i * 3 + 2]) * nz
      sumSq += r * r
      // ∂r/∂ω = q × n, ∂r/∂τ = n
      row[0] = qy * nz - qz * ny
      row[1] = qz * nx - qx * nz
      row[2] = qx * ny - qy * nx
      row[3] = nx
      row[4] = ny
      row[5] = nz
      for (let a = 0; a < 6; a++) {
        atb[a] -= row[a] * r
        for (let b = a; b < 6; b++) ata[a * 6 + b] += row[a] * row[b]
      }
    }
    for (let a = 0; a < 6; a++) for (let b = 0; b < a; b++) ata[a * 6 + b] = ata[b * 6 + a]

    const meanDistance = sumAbs / matched
    const rms = Math.sqrt(sumSq / matched)
    options.onIteration?.(iterations, meanDistance, transform)

    // Score the pose we just measured, not the one we are about to make: this
    // is the only place a transform is evaluated, so keeping the best-scoring
    // one means a final bad step can never be what gets returned.
    if (score < bestScore) {
      bestScore = score
      bestRms = rms
      bestMean = meanDistance
      bestMatched = matched
      best = cloneRigid(transform)
    }

    // A touch of Levenberg damping on the diagonal. Point-to-plane goes
    // singular on a part with an unconstrained direction — a plate free to
    // slide in its own plane — and without this the solve would answer with an
    // arbitrarily large slide along it.
    let trace = 0
    for (let a = 0; a < 6; a++) trace += ata[a * 6 + a]
    const lambda = (trace / 6) * 1e-9 + 1e-12
    for (let a = 0; a < 6; a++) ata[a * 6 + a] += lambda

    const step = solveLinear(6, ata, atb)
    if (!step) break

    let omega: [number, number, number] = [step[0], step[1], step[2]]
    let tau: [number, number, number] = [step[3], step[4], step[5]]

    // Clamp a wild step rather than take it. Early iterations from a bad pose
    // can solve for half a turn, which lands somewhere unrelated.
    const angle = Math.hypot(omega[0], omega[1], omega[2])
    const shift = Math.hypot(tau[0], tau[1], tau[2])
    const maxAngle = 0.35
    const maxShift = surface.bboxDiagonal * 0.5
    const scale = Math.min(
      1,
      angle > maxAngle ? maxAngle / angle : 1,
      shift > maxShift ? maxShift / shift : 1,
    )
    if (scale < 1) {
      omega = [omega[0] * scale, omega[1] * scale, omega[2] * scale]
      tau = [tau[0] * scale, tau[1] * scale, tau[2] * scale]
    }

    // The increment is about the correspondence centroid, so lift it back to
    // the origin before composing: Δ = T(c) · Δ_local · T(−c).
    const local = rigidFromTwist(omega, tau)
    const rc = new Float64Array(3)
    rigidRotate(local, cx, cy, cz, rc)
    const delta: Rigid = {
      r: local.r,
      t: Float64Array.from([
        cx + local.t[0] - rc[0],
        cy + local.t[1] - rc[1],
        cz + local.t[2] - rc[2],
      ]),
    }
    transform = reorthonormalize(rigidCompose(delta, transform))

    // How far the step actually moved the part: the rotation swung about the
    // centroid over the part's radius, plus the translation.
    const moved =
      Math.hypot(omega[0], omega[1], omega[2]) * surface.bboxDiagonal * 0.5 +
      Math.hypot(tau[0], tau[1], tau[2])
    if (moved < tolerance) {
      converged = true
      break
    }
  }

  return {
    transform: best,
    iterations,
    rms: Number.isFinite(bestRms) ? bestRms : 0,
    meanDistance: Number.isFinite(bestMean) ? bestMean : 0,
    score: Number.isFinite(bestScore) ? bestScore : Infinity,
    matched: bestMatched,
    sampled: n,
    converged,
  }
}

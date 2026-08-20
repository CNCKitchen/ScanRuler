// SPDX-License-Identifier: AGPL-3.0-only
// The flat fits: line, circle and arc through 2D points, whether those points
// were clicked by hand or collected off detected edges. Small counts to a few
// thousand edge samples, so everything runs on the main thread. The circle
// math is the shared kernel in fit/circle2d.ts; what this file adds is the
// residual bookkeeping (sigma, form error) and the measured extent.

import { fitCircle2d } from '../fit/circle2d'
import { FitError } from '../fit/errors'
import { mulberry32 } from '../fit/ransac'
import type { FlatArcFit, FlatCircleFit, FlatLineFit, FlatPointFit, Vec2 } from './types'

/** A picked point is the point — no residuals to speak of. */
export function flatPoint(at: Vec2): FlatPointFit {
  return { kind: 'point', at: [at[0], at[1]], sigma: 0, usedPoints: 0 }
}

/**
 * Total-least-squares line through two or more points: the direction the
 * points scatter most along, by the closed-form eigenvector of the 2×2
 * covariance. sigma is the RMS perpendicular residual, formError its
 * peak-to-peak span — the straightness of the points. The segment covers the
 * points' extent along the line.
 *
 * Throws FitError with a user-facing message on degenerate input.
 */
export function fitLinePoints(points: readonly Vec2[]): FlatLineFit {
  const n = points.length
  if (n < 2) throw new FitError('A line needs at least two points.')

  let mx = 0, my = 0
  for (const p of points) {
    mx += p[0]
    my += p[1]
  }
  mx /= n
  my /= n
  let sxx = 0, sxy = 0, syy = 0
  let spread = 0
  for (const p of points) {
    const x = p[0] - mx
    const y = p[1] - my
    sxx += x * x
    sxy += x * y
    syy += y * y
    spread = Math.max(spread, x * x + y * y)
  }
  if (!(spread > 0)) throw new FitError('The points coincide — they do not define a line.')

  // Largest-eigenvalue direction of the covariance, in closed form: the TLS
  // line makes angle θ with +X where tan 2θ = 2·sxy / (sxx − syy).
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy)
  let dx = Math.cos(theta)
  let dy = Math.sin(theta)
  // Which way along the line is arbitrary; pick the same side every time so
  // re-picking the same edge gives the same element.
  if (dx < 0 || (dx === 0 && dy < 0)) {
    dx = -dx
    dy = -dy
  }

  let tMin = Infinity
  let tMax = -Infinity
  let sumSq = 0
  let eMin = Infinity
  let eMax = -Infinity
  for (const p of points) {
    const x = p[0] - mx
    const y = p[1] - my
    const t = x * dx + y * dy
    const e = -x * dy + y * dx
    if (t < tMin) tMin = t
    if (t > tMax) tMax = t
    if (e < eMin) eMin = e
    if (e > eMax) eMax = e
    sumSq += e * e
  }
  const tMid = (tMin + tMax) / 2

  return {
    kind: 'line',
    center: [mx + tMid * dx, my + tMid * dy],
    dir: [dx, dy],
    length: tMax - tMin,
    sigma: Math.sqrt(sumSq / n),
    usedPoints: n,
    formError: eMax - eMin,
  }
}

/** The shared circle kernel plus its residuals: sigma is the RMS radial
 *  residual, formError the peak-to-peak — the circularity of the points. */
function circleWithResiduals(points: readonly Vec2[], what: string) {
  const n = points.length
  if (n < 3) throw new FitError(`A ${what} needs at least three points.`)
  const pu = new Float64Array(n)
  const pv = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    pu[i] = points[i][0]
    pv[i] = points[i][1]
  }
  const fit = fitCircle2d(pu, pv)
  if (!fit) throw new FitError(`Couldn't fit a ${what} through these points.`)
  let sumSq = 0
  let eMin = Infinity
  let eMax = -Infinity
  for (let i = 0; i < n; i++) {
    const e = Math.hypot(pu[i] - fit.cu, pv[i] - fit.cv) - fit.r
    if (e < eMin) eMin = e
    if (e > eMax) eMax = e
    sumSq += e * e
  }
  return { fit, sigma: Math.sqrt(sumSq / n), formError: eMax - eMin }
}

export function fitCirclePoints(points: readonly Vec2[]): FlatCircleFit {
  const { fit, sigma, formError } = circleWithResiduals(points, 'circle')
  return {
    kind: 'circle',
    center: [fit.cu, fit.cv],
    radius: fit.r,
    sigma,
    usedPoints: points.length,
    formError,
  }
}

/**
 * An arc is the circle fit plus the angular extent the points actually cover:
 * the points' angles around the center, with the largest gap between
 * neighbours left out. Points spread over the whole circle leave no real gap
 * and the sweep approaches a full turn — still a valid arc, just one the UI
 * may as well have called a circle.
 */
/**
 * The robust variants, for points collected off a dragged region of edge
 * chains rather than placed by hand: a region over one edge of a bar
 * unavoidably catches strays from neighbouring edges, and a least-squares fit
 * would split the difference. LMedS consensus — minimise the median absolute
 * residual over random minimal samples, keep what lies within a robust band
 * of the best model, fit least-squares on that.
 */
const RANSAC_ROUNDS = 96
/** Inliers lie within this many robust sigmas (1.4826·MAD) of the model. */
const INLIER_BAND = 3

function consensus(
  points: readonly Vec2[],
  residualsOf: (rand: () => number) => number[] | null,
): boolean[] {
  const rand = mulberry32(7)
  let bestMedian = Infinity
  let bestResiduals: number[] | null = null
  for (let round = 0; round < RANSAC_ROUNDS; round++) {
    const residuals = residualsOf(rand)
    if (!residuals) continue
    const sorted = residuals.map(Math.abs).sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    if (median < bestMedian) {
      bestMedian = median
      bestResiduals = residuals
    }
  }
  if (!bestResiduals) return points.map(() => true)
  // A perfectly clean set has a near-zero MAD; the floor keeps subpixel
  // scatter from being culled as if it were outliers.
  const band = Math.max(INLIER_BAND * 1.4826 * bestMedian, 0.35)
  return bestResiduals.map((r) => Math.abs(r) <= band)
}

/** Line through region-collected points: consensus first, TLS on what agrees. */
export function fitLineRegion(points: readonly Vec2[]): FlatLineFit {
  if (points.length < 8) throw new FitError('The region caught too few edge points for a line.')
  const keep = consensus(points, (rand) => {
    const a = points[(rand() * points.length) | 0]
    const b = points[(rand() * points.length) | 0]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const len = Math.hypot(dx, dy)
    if (len < 1e-9) return null
    return points.map((p) => ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len)
  })
  const inliers = points.filter((_, i) => keep[i])
  if (inliers.length < 8) throw new FitError('The region caught too few edge points for a line.')
  return fitLinePoints(inliers)
}

function circleResiduals(points: readonly Vec2[], rand: () => number): number[] | null {
  const pick = () => points[(rand() * points.length) | 0]
  const sample = [pick(), pick(), pick()]
  const fit = fitCircle2d(
    Float64Array.from(sample.map((p) => p[0])),
    Float64Array.from(sample.map((p) => p[1])),
  )
  if (!fit) return null
  return points.map((p) => Math.hypot(p[0] - fit.cu, p[1] - fit.cv) - fit.r)
}

/** Circle through region-collected points, consensus first. */
export function fitCircleRegion(points: readonly Vec2[]): FlatCircleFit {
  if (points.length < 12) throw new FitError('The region caught too few edge points for a circle.')
  const keep = consensus(points, (rand) => circleResiduals(points, rand))
  const inliers = points.filter((_, i) => keep[i])
  if (inliers.length < 12) throw new FitError('The region caught too few edge points for a circle.')
  return fitCirclePoints(inliers)
}

/** Arc through region-collected points, consensus first. */
export function fitArcRegion(points: readonly Vec2[]): FlatArcFit {
  if (points.length < 12) throw new FitError('The region caught too few edge points for an arc.')
  const keep = consensus(points, (rand) => circleResiduals(points, rand))
  const inliers = points.filter((_, i) => keep[i])
  if (inliers.length < 12) throw new FitError('The region caught too few edge points for an arc.')
  return fitArcPoints(inliers)
}

export function fitArcPoints(points: readonly Vec2[]): FlatArcFit {
  const { fit, sigma, formError } = circleWithResiduals(points, 'arc')
  const angles = points
    .map((p) => Math.atan2(p[1] - fit.cv, p[0] - fit.cu))
    .sort((a, b) => a - b)
  let gapAt = angles.length - 1
  let gap = angles[0] + 2 * Math.PI - angles[angles.length - 1]
  for (let i = 1; i < angles.length; i++) {
    if (angles[i] - angles[i - 1] > gap) {
      gap = angles[i] - angles[i - 1]
      gapAt = i - 1
    }
  }
  const start = angles[(gapAt + 1) % angles.length]
  return {
    kind: 'arc',
    center: [fit.cu, fit.cv],
    radius: fit.r,
    start,
    sweep: 2 * Math.PI - gap,
    sigma,
    usedPoints: points.length,
    formError,
  }
}

// SPDX-License-Identifier: AGPL-3.0-only
// The flat fits: line, circle and arc through 2D points, whether those points
// were clicked by hand or collected off detected edges. Small counts to a few
// thousand edge samples, so everything runs on the main thread. The circle
// math is the shared kernel in fit/circle2d.ts; what this file adds is the
// residual bookkeeping (sigma, form error) and the measured extent.

import { fitCircle2d } from '../fit/circle2d'
import { FitError } from '../fit/errors'
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

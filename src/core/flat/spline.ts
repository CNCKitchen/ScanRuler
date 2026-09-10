// SPDX-License-Identifier: AGPL-3.0-only
// The fit-point spline: the curve a CAD sketch draws through the points you
// click, with a tangent handle at every point to bend it by. Cubic Hermite
// segments between consecutive points, parameterised by chord length, and the
// tangents solved so the curve is C2 wherever no handle has been set — the
// same interpolating spline a sketcher's "fit point spline" is — with natural
// ends on an open curve (no curvature at the tips) and a periodic wrap on a
// closed one. A handle that has been dragged fixes the derivative at its
// point; the rest of the tangents are re-solved around it, so the curve stays
// as smooth as it can be everywhere the hand has not been.
//
// The handle the stage draws is the derivative scaled to a third of the mean
// chord to the neighbours: an automatic handle then looks like a Bézier
// control handle would, and a dragged one is what the curve leaves the point
// along, at the pull the drag gave it. Everything here is in document units;
// the store keeps handles in image pixels beside the picks, like every
// source, and converts on the way in.

import { FitError } from '../fit/errors'
import { solveLinear } from '../fit/linalg'
import type { FlatSplineFit, Vec2 } from './types'

/** How far a handle reaches, as a fraction of the mean chord to the
 *  neighbours. */
export const HANDLE_REACH = 1 / 3

/** Which end of a tangent handle is meant: `a` is the end the curve leaves
 *  the point along, `b` the one it arrives from. */
export type HandleEnd = 'a' | 'b'

/** One handle as drawn: the point it belongs to, the end the curve leaves
 *  along (`a`) and the one it arrives from (`b`), and whether it was set by
 *  hand. */
export interface SplineHandle {
  at: Vec2
  a: Vec2
  b: Vec2
  fixed: boolean
}

/** The curve as cubic Béziers — the form SVG, STEP and CAD kernels all take
 *  exactly: 3s + 1 poles for s segments, segment k running through poles 3k
 *  to 3k + 3, and the chord-length parameter each segment starts at, plus the
 *  end — s + 1 knots. */
export interface SplineBezierForm {
  poles: Vec2[]
  knots: number[]
}

export function splineSegmentCount(pointCount: number, closed: boolean): number {
  return closed ? pointCount : pointCount - 1
}

/** Chord length of segment k. */
function chords(points: readonly Vec2[], closed: boolean): number[] {
  const n = points.length
  const out: number[] = []
  for (let k = 0; k < splineSegmentCount(n, closed); k++) {
    const a = points[k]
    const b = points[(k + 1) % n]
    out.push(Math.hypot(b[0] - a[0], b[1] - a[1]))
  }
  return out
}

/** The handle reach at point i: a third of the mean of its chords — the one
 *  chord at the tip of an open curve. */
function reaches(points: readonly Vec2[], closed: boolean, h: readonly number[]): number[] {
  const n = points.length
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const before = closed ? h[(i - 1 + n) % n] : i > 0 ? h[i - 1] : null
    const after = closed ? h[i % n] : i < n - 1 ? h[i] : null
    const mean =
      before !== null && after !== null ? (before + after) / 2 : (before ?? after ?? 1)
    out.push(mean * HANDLE_REACH)
  }
  return out
}

/**
 * Solve the spline through `points` with the handles that were set. A handle
 * is the offset (document units) from its point to the end the curve leaves
 * along, or null to let the tangent there be solved. Throws FitError, with a
 * user-facing message, when the points cannot carry a curve.
 */
export function fitSplinePoints(
  points: readonly Vec2[],
  handles: readonly (Vec2 | null)[],
  closed: boolean,
): FlatSplineFit {
  const n = points.length
  if (n < 2) throw new FitError('A spline needs at least two points.')
  if (closed && n < 3) throw new FitError('A closed spline needs at least three points.')
  const h = chords(points, closed)
  if (h.some((c) => !(c > 1e-9))) {
    throw new FitError('Two consecutive points coincide — move one of them apart.')
  }
  const reach = reaches(points, closed, h)

  // One row per point, for the derivative there. A free interior point asks
  // for equal second derivatives on both sides; a free tip of an open curve
  // for none; a fixed point simply states its derivative.
  const a = new Float64Array(n * n)
  const bx = new Float64Array(n)
  const by = new Float64Array(n)
  const segments = splineSegmentCount(n, closed)
  for (let i = 0; i < n; i++) {
    const handle = handles[i] ?? null
    if (handle) {
      a[i * n + i] = 1
      bx[i] = handle[0] / reach[i]
      by[i] = handle[1] / reach[i]
      continue
    }
    const prev = closed ? (i - 1 + n) % n : i - 1
    const next = closed ? (i + 1) % n : i + 1
    const hPrev = closed ? h[(i - 1 + n) % n] : i > 0 ? h[i - 1] : 0
    const hNext = closed ? h[i % segments] : i < n - 1 ? h[i] : 0
    if (!closed && i === 0) {
      a[i * n + i] = 2
      a[i * n + next] = 1
      bx[i] = (3 * (points[next][0] - points[i][0])) / hNext
      by[i] = (3 * (points[next][1] - points[i][1])) / hNext
      continue
    }
    if (!closed && i === n - 1) {
      a[i * n + prev] = 1
      a[i * n + i] = 2
      bx[i] = (3 * (points[i][0] - points[prev][0])) / hPrev
      by[i] = (3 * (points[i][1] - points[prev][1])) / hPrev
      continue
    }
    a[i * n + prev] += 1 / hPrev
    a[i * n + i] += 2 * (1 / hPrev + 1 / hNext)
    a[i * n + next] += 1 / hNext
    bx[i] =
      3 * ((points[i][0] - points[prev][0]) / (hPrev * hPrev) + (points[next][0] - points[i][0]) / (hNext * hNext))
    by[i] =
      3 * ((points[i][1] - points[prev][1]) / (hPrev * hPrev) + (points[next][1] - points[i][1]) / (hNext * hNext))
  }
  // The system is diagonally dominant and small — a few dozen points at the
  // most — so a dense solve, twice, is well within a pointer move.
  const mx = solveLinear(n, a.slice(), bx)
  const my = solveLinear(n, a.slice(), by)
  if (!mx || !my) throw new FitError("Couldn't lay a curve through these points.")

  const fit: FlatSplineFit = {
    kind: 'spline',
    points: points.map((p) => [p[0], p[1]]),
    tangents: Array.from({ length: n }, (_, i) => [mx[i], my[i]]),
    fixed: Array.from({ length: n }, (_, i) => (handles[i] ?? null) !== null),
    closed,
    length: 0,
    sigma: 0,
    usedPoints: n,
  }
  fit.length = arcLength(fit)
  return fit
}

/** The point on segment k at u in [0, 1]. */
export function evalSpline(fit: FlatSplineFit, k: number, u: number): Vec2 {
  const n = fit.points.length
  const p0 = fit.points[k]
  const p1 = fit.points[(k + 1) % n]
  const h = Math.hypot(p1[0] - p0[0], p1[1] - p0[1])
  const m0 = fit.tangents[k]
  const m1 = fit.tangents[(k + 1) % n]
  const u2 = u * u
  const u3 = u2 * u
  const c0 = 2 * u3 - 3 * u2 + 1
  const c1 = (u3 - 2 * u2 + u) * h
  const c2 = -2 * u3 + 3 * u2
  const c3 = (u3 - u2) * h
  return [
    c0 * p0[0] + c1 * m0[0] + c2 * p1[0] + c3 * m1[0],
    c0 * p0[1] + c1 * m0[1] + c2 * p1[1] + c3 * m1[1],
  ]
}

/** The derivative on segment k with respect to u. */
function evalSplineDerivative(fit: FlatSplineFit, k: number, u: number): Vec2 {
  const n = fit.points.length
  const p0 = fit.points[k]
  const p1 = fit.points[(k + 1) % n]
  const h = Math.hypot(p1[0] - p0[0], p1[1] - p0[1])
  const m0 = fit.tangents[k]
  const m1 = fit.tangents[(k + 1) % n]
  const u2 = u * u
  const c0 = 6 * u2 - 6 * u
  const c1 = (3 * u2 - 4 * u + 1) * h
  const c2 = -6 * u2 + 6 * u
  const c3 = (3 * u2 - 2 * u) * h
  return [
    c0 * p0[0] + c1 * m0[0] + c2 * p1[0] + c3 * m1[0],
    c0 * p0[1] + c1 * m0[1] + c2 * p1[1] + c3 * m1[1],
  ]
}

// Five-point Gauss–Legendre on [-1, 1]; four panels of it per segment
// integrate the speed of a cubic to well past any scanner's resolution.
const GAUSS_X = [0, 0.5384693101056831, -0.5384693101056831, 0.906179845938664, -0.906179845938664]
const GAUSS_W = [0.5688888888888889, 0.4786286704993665, 0.4786286704993665, 0.2369268850561891, 0.2369268850561891]
const PANELS = 4

function arcLength(fit: FlatSplineFit): number {
  let total = 0
  for (let k = 0; k < splineSegmentCount(fit.points.length, fit.closed); k++) {
    for (let panel = 0; panel < PANELS; panel++) {
      const u0 = panel / PANELS
      const half = 1 / (2 * PANELS)
      let sum = 0
      for (let g = 0; g < GAUSS_X.length; g++) {
        const d = evalSplineDerivative(fit, k, u0 + half * (1 + GAUSS_X[g]))
        sum += GAUSS_W[g] * Math.hypot(d[0], d[1])
      }
      total += sum * half
    }
  }
  return total
}

/** The curve sampled for drawing and hit-testing: `perSegment` steps on each
 *  segment, the first point once, a closed curve back at its start. */
export function splinePolyline(fit: FlatSplineFit, perSegment = 24): Vec2[] {
  const out: Vec2[] = [[fit.points[0][0], fit.points[0][1]]]
  for (let k = 0; k < splineSegmentCount(fit.points.length, fit.closed); k++) {
    for (let i = 1; i <= perSegment; i++) out.push(evalSpline(fit, k, i / perSegment))
  }
  return out
}

/** A spot on the curve to hang its label from: halfway along the samples. */
export function splineMidpoint(fit: FlatSplineFit): Vec2 {
  const pts = splinePolyline(fit, 8)
  return pts[Math.floor(pts.length / 2)]
}

/** The handles as the stage draws them, one per point. */
export function splineHandles(fit: FlatSplineFit): SplineHandle[] {
  const h = chords(fit.points, fit.closed)
  const reach = reaches(fit.points, fit.closed, h)
  return fit.points.map((p, i) => {
    const m = fit.tangents[i]
    const dx = m[0] * reach[i]
    const dy = m[1] * reach[i]
    return { at: [p[0], p[1]], a: [p[0] + dx, p[1] + dy], b: [p[0] - dx, p[1] - dy], fixed: fit.fixed[i] }
  })
}

/** The curve as cubic Béziers on chord-length knots. */
export function splineBezierForm(fit: FlatSplineFit): SplineBezierForm {
  const n = fit.points.length
  const poles: Vec2[] = [[fit.points[0][0], fit.points[0][1]]]
  const knots = [0]
  for (let k = 0; k < splineSegmentCount(n, fit.closed); k++) {
    const p0 = fit.points[k]
    const p1 = fit.points[(k + 1) % n]
    const h = Math.hypot(p1[0] - p0[0], p1[1] - p0[1])
    const m0 = fit.tangents[k]
    const m1 = fit.tangents[(k + 1) % n]
    poles.push(
      [p0[0] + (h * m0[0]) / 3, p0[1] + (h * m0[1]) / 3],
      [p1[0] - (h * m1[0]) / 3, p1[1] - (h * m1[1]) / 3],
      [p1[0], p1[1]],
    )
    knots.push(knots[knots.length - 1] + h)
  }
  return { poles, knots }
}

/** Which segment of the curve passes nearest `p`, and how far away it runs —
 *  what a click on the curve inserts a point into: before the segment's end
 *  point, at index `segment + 1`. */
export function nearestSplineSegment(fit: FlatSplineFit, p: Vec2, perSegment = 24): { segment: number; dist: number } {
  const pts = splinePolyline(fit, perSegment)
  let best = Infinity
  let segment = 0
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const len2 = dx * dx + dy * dy
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0
    const d = Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
    if (d < best) {
      best = d
      segment = Math.floor(i / perSegment)
    }
  }
  return { segment, dist: best }
}

// SPDX-License-Identifier: AGPL-3.0-only
// The sketch's spline: a smooth curve through the fit points it was drawn
// by — the interpolating spline the 2D workspace draws (flat/spline.ts):
// cubic Hermite between the points on chord-length parameters, C2 through
// every point, with natural ends, or an end held to a direction where a
// tangent relation holds it. A closed one wraps round, smooth at its first
// point too.
//
// Along the curve a place is one parameter t: segment k runs from t = k to
// t = k + 1, so an open curve of n points runs 0 to n − 1 and a closed one
// 0 to n, and on round again past n. The kernel is handed the curve itself,
// not samples of it: a stretch as cubic Béziers on their chord-length
// spans, joined into one B-spline with simple knots — exact, the curve
// being C2 at every inner point, and so one smooth edge to offset, shell
// and round against rather than a chain of patches.

import { evalSpline, evalSplineDerivative, fitSplinePoints, HANDLE_REACH } from '../../../src/core/flat/spline'
import type { FlatSplineFit, Vec2 } from '../../../src/core/flat/types'
import type { SketchSpline } from './sketch'

/** What a spline is drawn by: the sketch piece's own fields. `startDir` and
 *  `endDir` are the directions the curve leaves its first point and
 *  arrives at its last, radians — set while a tangent relation holds that
 *  end, natural otherwise. */
export interface SplineShape {
  pts: readonly Vec2[]
  closed?: boolean
  startDir?: number
  endDir?: number
}

/** A cubic Bézier: its four poles. */
export type Bezier = [Vec2, Vec2, Vec2, Vec2]

/** A cubic B-spline: its poles, its distinct knots and their multiplicities
 *  — clamped, four at either end — the form OCCT and STEP take. */
export interface BSpline<P extends number[] = Vec2> {
  poles: P[]
  knots: number[]
  mults: number[]
}

/** How many segments the curve has: one fewer than its points, open; as
 *  many, closed. */
export const splineSegmentsOf = (e: Pick<SplineShape, 'pts' | 'closed'>): number => (isClosed(e) ? e.pts.length : Math.max(0, e.pts.length - 1))

/** Whether the curve closes: asked so, with three points at least. */
export const isClosed = (e: Pick<SplineShape, 'pts' | 'closed'>): boolean => Boolean(e.closed) && e.pts.length >= 3

const segmentsOfFit = (fit: FlatSplineFit): number => (fit.closed ? fit.points.length : Math.max(0, fit.points.length - 1))

/** The curve through the piece's points: tangents solved, an end held to its
 *  direction where one is set. Two points on one spot — a solve passing
 *  through it, a hand that clicked twice — still give a curve, its tangents
 *  read off the neighbours, rather than none. */
export function splineCurve(e: SplineShape): FlatSplineFit {
  const pts = e.pts
  const n = pts.length
  const closed = isClosed(e)
  const chord = (i: number) => Math.hypot(pts[(i + 1) % n][0] - pts[i][0], pts[(i + 1) % n][1] - pts[i][1])
  const handles: (Vec2 | null)[] = pts.map(() => null)
  if (!closed && n >= 2) {
    // A handle reaches a third of the chord beside it, and is then the
    // curve's derivative of unit length — the speed of a chord-length curve.
    if (e.startDir !== undefined) {
      const r = HANDLE_REACH * chord(0)
      handles[0] = [Math.cos(e.startDir) * r, Math.sin(e.startDir) * r]
    }
    if (e.endDir !== undefined) {
      const r = HANDLE_REACH * chord(n - 2)
      handles[n - 1] = [Math.cos(e.endDir) * r, Math.sin(e.endDir) * r]
    }
  }
  if (n >= 2) {
    try {
      return fitSplinePoints(pts, handles, closed)
    } catch {
      // Below: a curve that still evaluates.
    }
  }
  const tangents: Vec2[] = pts.map((_, i) => {
    const before = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)]
    const after = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)]
    const d: Vec2 = [after[0] - before[0], after[1] - before[1]]
    const l = Math.hypot(d[0], d[1])
    return l > 1e-12 ? [d[0] / l, d[1] / l] : [1, 0]
  })
  let length = 0
  for (let i = 0; i < splineSegmentsOf(e); i++) length += chord(i)
  return { kind: 'spline', points: pts.map((p) => [p[0], p[1]]), tangents, fixed: pts.map(() => false), closed, length, sigma: 0, usedPoints: n }
}

/** The segment and its own parameter at t — a closed curve's t taken round,
 *  an open one's held to its ends. */
function locate(fit: FlatSplineFit, t: number): [number, number] {
  const s = segmentsOfFit(fit)
  if (s === 0) return [0, 0]
  const w = fit.closed ? ((t % s) + s) % s : Math.min(Math.max(t, 0), s)
  const k = Math.min(Math.floor(w), s - 1)
  return [k, w - k]
}

/** The point at t. */
export function splineAt(fit: FlatSplineFit, t: number): Vec2 {
  if (segmentsOfFit(fit) === 0) return [fit.points[0][0], fit.points[0][1]]
  const [k, u] = locate(fit, t)
  return evalSpline(fit, k, u)
}

/** The derivative at t, per unit of t — the way the curve runs on there. */
export function splineDerivAt(fit: FlatSplineFit, t: number): Vec2 {
  if (segmentsOfFit(fit) === 0) return [1, 0]
  const [k, u] = locate(fit, t)
  return evalSplineDerivative(fit, k, u)
}

/** The unit direction the curve runs at t, or [1, 0] where it stands still. */
export function splineDirAt(fit: FlatSplineFit, t: number): Vec2 {
  const d = splineDerivAt(fit, t)
  const l = Math.hypot(d[0], d[1])
  return l > 1e-12 ? [d[0] / l, d[1] / l] : [1, 0]
}

/** The parameter at the curve's end: 0 at its start, the segment count at
 *  its end. */
export const splineEnd = (fit: FlatSplineFit): number => segmentsOfFit(fit)

/** The curve sampled, `perSegment` steps a segment, with the parameter of
 *  every sample — a closed one back at its start. */
export function splineSamples(fit: FlatSplineFit, perSegment = 16): { t: number; p: Vec2 }[] {
  const s = segmentsOfFit(fit)
  if (s === 0) return [{ t: 0, p: [fit.points[0][0], fit.points[0][1]] }]
  const out: { t: number; p: Vec2 }[] = []
  for (let k = 0; k < s; k++) for (let i = k === 0 ? 0 : 1; i <= perSegment; i++) out.push({ t: k + i / perSegment, p: evalSpline(fit, k, i / perSegment) })
  return out
}

/** The point of the curve nearest `p`: its parameter, where it is and how
 *  far. The samples find the stretch, a golden-section search closes on it
 *  — to a hundred-millionth of a segment. */
export function nearestOnSpline(fit: FlatSplineFit, p: Vec2, perSegment = 16): { t: number; point: Vec2; dist: number } {
  const s = segmentsOfFit(fit)
  const d2 = (t: number) => {
    const q = splineAt(fit, t)
    return (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2
  }
  if (s === 0) return { t: 0, point: splineAt(fit, 0), dist: Math.sqrt(d2(0)) }
  let best = 0
  let bestD = Infinity
  for (const { t } of splineSamples(fit, perSegment)) {
    const d = d2(t)
    if (d < bestD) {
      bestD = d
      best = t
    }
  }
  const step = 1 / perSegment
  let lo = best - step
  let hi = best + step
  if (!fit.closed) {
    lo = Math.max(lo, 0)
    hi = Math.min(hi, s)
  }
  const g = (Math.sqrt(5) - 1) / 2
  let x1 = hi - g * (hi - lo)
  let x2 = lo + g * (hi - lo)
  let f1 = d2(x1)
  let f2 = d2(x2)
  for (let i = 0; i < 40; i++) {
    if (f1 < f2) {
      hi = x2
      x2 = x1
      f2 = f1
      x1 = hi - g * (hi - lo)
      f1 = d2(x1)
    } else {
      lo = x1
      x1 = x2
      f1 = f2
      x2 = lo + g * (hi - lo)
      f2 = d2(x2)
    }
  }
  let t = (lo + hi) / 2
  // The samples' own ends are candidates too: an open curve's nearest point
  // may be its tip, which the bracket reaches only from one side.
  if (d2(best) < d2(t)) t = best
  if (fit.closed) t = ((t % s) + s) % s
  const point = splineAt(fit, t)
  return { t, point, dist: Math.hypot(point[0] - p[0], point[1] - p[1]) }
}

// ---- the curve as the kernel takes it ------------------------------------------

const lerp = (a: Vec2, b: Vec2, u: number): Vec2 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]

/** Segment k as a Bézier, and the chord its parameter spans. */
function segmentBezier(fit: FlatSplineFit, k: number): { bezier: Bezier; h: number } {
  const n = fit.points.length
  const p0 = fit.points[k]
  const p1 = fit.points[(k + 1) % n]
  const h = Math.hypot(p1[0] - p0[0], p1[1] - p0[1])
  const m0 = fit.tangents[k]
  const m1 = fit.tangents[(k + 1) % n]
  return {
    bezier: [
      [p0[0], p0[1]],
      [p0[0] + (h * m0[0]) / 3, p0[1] + (h * m0[1]) / 3],
      [p1[0] - (h * m1[0]) / 3, p1[1] - (h * m1[1]) / 3],
      [p1[0], p1[1]],
    ],
    h,
  }
}

/** The part of a Bézier from u0 to u1, by de Casteljau. */
function subBezier(b: Bezier, u0: number, u1: number): Bezier {
  const split = (c: Bezier, u: number): [Bezier, Bezier] => {
    const a = lerp(c[0], c[1], u)
    const m = lerp(c[1], c[2], u)
    const d = lerp(c[2], c[3], u)
    const e = lerp(a, m, u)
    const f = lerp(m, d, u)
    const g = lerp(e, f, u)
    return [
      [c[0], a, e, g],
      [g, f, d, c[3]],
    ]
  }
  let c = b
  if (u1 < 1) c = split(c, u1)[0]
  if (u0 > 0) c = split(c, u0 / u1)[1]
  return c
}

/**
 * The stretch of the curve from t0 to t1 as Béziers in that direction, each
 * with the span of chord-length parameter it covers. A closed curve's
 * stretch may run on past its first point (t past the segment count). Spans
 * of no length — two points on one spot — are left out.
 */
export function splineStretchBeziers(fit: FlatSplineFit, t0: number, t1: number): { pieces: Bezier[]; spans: number[] } {
  const s = segmentsOfFit(fit)
  const pieces: Bezier[] = []
  const spans: number[] = []
  if (s === 0) return { pieces, spans }
  let lo = Math.min(t0, t1)
  let hi = Math.max(t0, t1)
  if (!fit.closed) {
    lo = Math.max(lo, 0)
    hi = Math.min(hi, s)
  }
  const first = Math.floor(lo + 1e-12)
  const last = Math.ceil(hi - 1e-12) - 1
  for (let j = first; j <= last; j++) {
    const u0 = Math.max(lo - j, 0)
    const u1 = Math.min(hi - j, 1)
    if (u1 - u0 < 1e-12) continue
    const k = fit.closed ? ((j % s) + s) % s : Math.min(Math.max(j, 0), s - 1)
    const { bezier, h } = segmentBezier(fit, k)
    const span = (u1 - u0) * h
    if (!(span > 1e-12)) continue
    pieces.push(subBezier(bezier, u0, u1))
    spans.push(span)
  }
  if (t0 > t1) {
    pieces.reverse()
    spans.reverse()
    for (let i = 0; i < pieces.length; i++) pieces[i] = [pieces[i][3], pieces[i][2], pieces[i][1], pieces[i][0]]
  }
  return { pieces, spans }
}

/**
 * Béziers end to end, on the spans given, as one cubic B-spline. Where the
 * chain is C2 — every stretch of a spline is — the poles are the de Boor
 * points behind it and the knots simple: each Bézier's two inner poles lie
 * on a leg of the de Boor polygon, a third and two thirds of the way on
 * equal spans and as the spans either side weigh them otherwise, so each
 * Bézier gives back its leg's two points. A chain that is not C2 — checked
 * by laying the Béziers again from the points found — is handed over as it
 * is, its inner knots of multiplicity three: exact still, only not smooth
 * in its knots.
 */
export function bezierChainToBSpline(pieces: readonly (readonly number[])[][], spans: readonly number[]): BSpline<number[]> {
  const m = pieces.length
  const knots = [0]
  for (const s of spans) knots.push(knots[knots.length - 1] + s)
  const dim = pieces[0]?.[0].length ?? 2
  const mix = (a: readonly number[], wa: number, b: readonly number[], wb: number): number[] => Array.from({ length: dim }, (_, i) => a[i] * wa + b[i] * wb)
  const span = (k: number) => (k < 0 || k >= m ? 0 : spans[k])
  // Leg k + 1 → k + 2 of the de Boor polygon carries Bézier k's inner poles:
  //   b1 = ((Δk + Δk+1) d1 + Δk−1 d2) / Σ,  b2 = (Δk+1 d1 + (Δk−1 + Δk) d2) / Σ.
  const weights = (k: number) => {
    const sum = span(k - 1) + span(k) + span(k + 1)
    return { a: (span(k) + span(k + 1)) / sum, b: span(k - 1) / sum, c: span(k + 1) / sum, d: (span(k - 1) + span(k)) / sum }
  }
  const de: number[][] = [Array.from(pieces[0][0])]
  for (let k = 0; k < m; k++) {
    const { a, b, c, d } = weights(k)
    const det = a * d - b * c
    const b1 = pieces[k][1]
    const b2 = pieces[k][2]
    de[k + 1] = mix(b1, d / det, b2, -b / det)
    if (k === m - 1) de[k + 2] = mix(b2, a / det, b1, -c / det)
  }
  de.push(Array.from(pieces[m - 1][3]))
  // Laid again from the points found, the Béziers have to come back.
  let size = 1
  for (const p of pieces) for (const q of p) for (const v of q) size = Math.max(size, Math.abs(v))
  const tol = 1e-9 * size
  let smooth = true
  for (let k = 0; k < m && smooth; k++) {
    const { a, b, c, d } = weights(k)
    const b1 = mix(de[k + 1], a, de[k + 2], b)
    const b2 = mix(de[k + 1], c, de[k + 2], d)
    const b0 = k === 0 ? de[0] : mix(pieces[k - 1][2], span(k) / (span(k - 1) + span(k)), pieces[k][1], span(k - 1) / (span(k - 1) + span(k)))
    for (let i = 0; i < dim; i++) {
      if (Math.abs(b1[i] - pieces[k][1][i]) > tol || Math.abs(b2[i] - pieces[k][2][i]) > tol || Math.abs(b0[i] - pieces[k][0][i]) > tol) smooth = false
    }
  }
  if (smooth) return { poles: de, knots, mults: knots.map((_, i) => (i === 0 || i === m ? 4 : 1)) }
  const poles: number[][] = [Array.from(pieces[0][0])]
  for (const p of pieces) poles.push(Array.from(p[1]), Array.from(p[2]), Array.from(p[3]))
  return { poles, knots, mults: knots.map((_, i) => (i === 0 || i === m ? 4 : 3)) }
}

/** The stretch of the curve from t0 to t1 as one B-spline, null where it
 *  has no length. */
export function splineStretch(fit: FlatSplineFit, t0: number, t1: number): BSpline | null {
  const { pieces, spans } = splineStretchBeziers(fit, t0, t1)
  if (pieces.length === 0) return null
  return bezierChainToBSpline(pieces, spans) as unknown as BSpline
}

/** A clamped cubic B-spline's point at parameter t, by de Boor — the knots
 *  as `knots` and `mults` give them. */
export function bsplineAt(b: BSpline<number[]>, t: number): number[] {
  const U = b.mults.flatMap((m, k) => Array<number>(m).fill(b.knots[k]))
  const p = 3
  const n = b.poles.length
  let k = p
  while (k < n - 1 && t >= U[k + 1]) k++
  const d = b.poles.slice(k - p, k + 1).map((q) => [...q])
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const i = k - p + j
      const den = U[i + p - r + 1] - U[i]
      const a = den > 0 ? (t - U[i]) / den : 0
      d[j] = d[j].map((v, c) => d[j - 1][c] * (1 - a) + v * a)
    }
  }
  return d[p]
}

/** A B-spline sampled at `count` + 1 points from its start to its end. */
export function bsplineSamples(b: BSpline<number[]>, count: number): number[][] {
  const t0 = b.knots[0]
  const t1 = b.knots[b.knots.length - 1]
  return Array.from({ length: count + 1 }, (_, i) => bsplineAt(b, t0 + ((t1 - t0) * i) / count))
}

/** A spline given the slice points along it as its soft data — what the
 *  solver then pulls it onto, its fit points free to move as far as its
 *  relations let them — or null when none lie along it. They are taken
 *  within a twentieth of its length, a millimetre to five: a curve drawn
 *  by hand over the slice lies that close, and a neighbouring wall further
 *  off. */
export function fitSplineToPoints(e: SketchSpline, slice: readonly Vec2[]): SketchSpline | null {
  const fit = splineCurve(e)
  const reach = Math.min(5, Math.max(1, 0.05 * fit.length))
  const points = pointsAlong(fit, slice, reach)
  if (points.length < Math.max(4, e.pts.length)) return null
  return { ...e, points, scatter: Math.max(splineScatter({ ...e, points }), 0.01) }
}

/** The RMS of a spline's slice points off the curve, millimetres. */
export function splineScatter(e: Pick<SketchSpline, 'pts' | 'closed' | 'startDir' | 'endDir' | 'points'>): number {
  const points = e.points ?? []
  if (points.length === 0) return 0
  const fit = splineCurve(e)
  let sum = 0
  for (const p of points) sum += nearestOnSpline(fit, p, 8).dist ** 2
  return Math.sqrt(sum / points.length)
}

/** Where a spline of `count` fit points starts along a chain of slice
 *  points: evenly spaced by length along it, end to end on an open chain,
 *  round it on a closed one — the solver then settles the curve onto the
 *  points between. Null for a chain too short to space them on. */
export function fitPointsAlong(chain: readonly Vec2[], count: number, closed: boolean): Vec2[] | null {
  const pts = closed && chain.length > 1 && Math.hypot(chain[0][0] - chain[chain.length - 1][0], chain[0][1] - chain[chain.length - 1][1]) < 1e-9 ? chain.slice(0, -1) : chain.slice()
  if (closed) pts.push(pts[0])
  const run = [0]
  for (let i = 1; i < pts.length; i++) run.push(run[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
  const total = run[run.length - 1]
  if (!(total > 1e-9)) return null
  const n = Math.max(closed ? 3 : 2, Math.round(count))
  const steps = closed ? n : n - 1
  const out: Vec2[] = []
  let j = 0
  for (let k = 0; k < n; k++) {
    const at = (total * k) / steps
    while (j < run.length - 2 && run[j + 1] < at) j++
    const span = run[j + 1] - run[j]
    const u = span > 0 ? (at - run[j]) / span : 0
    out.push([pts[j][0] + (pts[j + 1][0] - pts[j][0]) * u, pts[j][1] + (pts[j + 1][1] - pts[j][1]) * u])
  }
  return out
}

/** The slice points that lie along the curve: within `reach` of it, and
 *  beside it rather than past an open curve's tips — what a spline fitted
 *  to the slice is pulled to. */
export function pointsAlong(fit: FlatSplineFit, points: readonly Vec2[], reach: number): Vec2[] {
  const s = segmentsOfFit(fit)
  const xs = fit.points.map((p) => p[0])
  const ys = fit.points.map((p) => p[1])
  const pad = reach + 0.5 * fit.length
  const box = [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad]
  const out: Vec2[] = []
  for (const p of points) {
    if (p[0] < box[0] || p[0] > box[2] || p[1] < box[1] || p[1] > box[3]) continue
    const near = nearestOnSpline(fit, p, 8)
    if (near.dist > reach) continue
    if (!fit.closed && (near.t < 1e-3 || near.t > s - 1e-3)) continue
    out.push([p[0], p[1]])
  }
  return out
}

/** Past this, mm, a spline's swing beyond its points is said. */
const OVERSHOOT_MM = 0.01

/** Where a spline swings past its own points: a stretch between two fit
 *  points, where the points either side run one way along u (or v) and
 *  never back, that the curve leaves the two points' span of by more than
 *  OVERSHOOT_MM — a corner table's curve bulging 0.05 mm past the edge the
 *  last point lies on, a run of points on u = 0 dipping under it. The
 *  worst stretch of each axis, worst first; none on a curve that keeps
 *  within. A stretch over a turn of the points (a crest between two) is
 *  not one: its curve goes past them as it should. */
export function splineOvershoots(e: SketchSpline): { stretch: number; axis: 'u' | 'v'; mm: number; at: Vec2 }[] {
  const fit = splineCurve(e)
  const n = e.pts.length
  const closed = isClosed(e)
  const segments = splineSegmentsOf(e)
  const worst = new Map<'u' | 'v', { stretch: number; axis: 'u' | 'v'; mm: number; at: Vec2 }>()
  for (let k = 0; k < segments; k++) {
    const around = [k - 1, k, k + 1, k + 2].filter((i) => closed || (i >= 0 && i < n)).map((i) => e.pts[((i % n) + n) % n])
    for (const [axis, a] of [['u', 0], ['v', 1]] as const) {
      const values = around.map((p) => p[a])
      const steps = values.slice(1).map((x, i) => x - values[i])
      if (!steps.every((d) => d >= 0) && !steps.every((d) => d <= 0)) continue
      const p0 = e.pts[k][a]
      const p1 = e.pts[(k + 1) % n][a]
      const lo = Math.min(p0, p1)
      const hi = Math.max(p0, p1)
      for (let i = 1; i < 32; i++) {
        const p = evalSpline(fit, k, i / 32)
        const mm = Math.max(lo - p[a], p[a] - hi)
        if (mm > OVERSHOOT_MM && mm > (worst.get(axis)?.mm ?? 0)) worst.set(axis, { stretch: k, axis, mm: Math.round(mm * 1e4) / 1e4, at: [Math.round(p[0] * 1e4) / 1e4, Math.round(p[1] * 1e4) / 1e4] })
      }
    }
  }
  return [...worst.values()].sort((x, y) => y.mm - x.mm)
}

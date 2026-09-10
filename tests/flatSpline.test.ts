// SPDX-License-Identifier: AGPL-3.0-only
// The fit-point spline: through every point, C2 wherever no handle has been
// set, natural at open ends, periodic when closed — and the handles, the
// Bézier form and the hit test the stage and the exports read off it.
import { describe, expect, it } from 'vitest'
import { FitError } from '../src/core/fit/errors'
import {
  evalSpline,
  fitSplinePoints,
  HANDLE_REACH,
  nearestSplineSegment,
  splineBezierForm,
  splineHandles,
  splineMidpoint,
  splinePolyline,
  splineSegmentCount,
} from '../src/core/flat/spline'
import type { FlatSplineFit, Vec2 } from '../src/core/flat/types'

const square: Vec2[] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
]
const wave: Vec2[] = [
  [0, 0],
  [10, 8],
  [20, -3],
  [35, 5],
]
const none = (n: number) => new Array<Vec2 | null>(n).fill(null)

/** Second derivative on segment k with respect to the chord-length
 *  parameter, by central difference — what C2 continuity compares. */
function secondDerivative(fit: FlatSplineFit, k: number, u: number): Vec2 {
  const n = fit.points.length
  const a = fit.points[k]
  const b = fit.points[(k + 1) % n]
  const h = Math.hypot(b[0] - a[0], b[1] - a[1])
  const e = 1e-4
  const p0 = evalSpline(fit, k, u - e)
  const p1 = evalSpline(fit, k, u)
  const p2 = evalSpline(fit, k, u + e)
  return [(p0[0] - 2 * p1[0] + p2[0]) / (e * e * h * h), (p0[1] - 2 * p1[1] + p2[1]) / (e * e * h * h)]
}

describe('fitSplinePoints', () => {
  it('runs through every point, in order, and counts its segments', () => {
    const fit = fitSplinePoints(wave, none(4), false)
    expect(fit.kind).toBe('spline')
    expect(fit.points).toEqual(wave)
    expect(fit.fixed).toEqual([false, false, false, false])
    expect(fit.usedPoints).toBe(4)
    expect(splineSegmentCount(4, false)).toBe(3)
    for (let k = 0; k < 3; k++) {
      expect(evalSpline(fit, k, 0)).toEqual(wave[k])
      const end = evalSpline(fit, k, 1)
      expect(end[0]).toBeCloseTo(wave[k + 1][0], 9)
      expect(end[1]).toBeCloseTo(wave[k + 1][1], 9)
    }
  })

  it('is a straight segment through two points, at their distance', () => {
    const fit = fitSplinePoints(
      [
        [1, 1],
        [4, 5],
      ],
      none(2),
      false,
    )
    expect(fit.length).toBeCloseTo(5, 9)
    const mid = evalSpline(fit, 0, 0.5)
    expect(mid[0]).toBeCloseTo(2.5, 9)
    expect(mid[1]).toBeCloseTo(3, 9)
  })

  it('is C2 at every free interior point and has no curvature at open ends', () => {
    const fit = fitSplinePoints(wave, none(4), false)
    for (const k of [1, 2]) {
      const before = secondDerivative(fit, k - 1, 1 - 1e-4)
      const after = secondDerivative(fit, k, 1e-4)
      expect(before[0]).toBeCloseTo(after[0], 3)
      expect(before[1]).toBeCloseTo(after[1], 3)
    }
    const start = secondDerivative(fit, 0, 1e-4)
    const end = secondDerivative(fit, 2, 1 - 1e-4)
    expect(Math.hypot(start[0], start[1])).toBeLessThan(1e-2)
    expect(Math.hypot(end[0], end[1])).toBeLessThan(1e-2)
  })

  it('closes on itself with C2 continuity across the seam', () => {
    const fit = fitSplinePoints(square, none(4), true)
    expect(fit.closed).toBe(true)
    expect(splineSegmentCount(4, true)).toBe(4)
    const back = evalSpline(fit, 3, 1)
    expect(back[0]).toBeCloseTo(0, 9)
    expect(back[1]).toBeCloseTo(0, 9)
    // The seam is a free point like any other.
    const before = secondDerivative(fit, 3, 1 - 1e-4)
    const after = secondDerivative(fit, 0, 1e-4)
    expect(before[0]).toBeCloseTo(after[0], 3)
    expect(before[1]).toBeCloseTo(after[1], 3)
    // A square's rounded ring is symmetric: the same tangent speed at every
    // corner, and the polyline returns to its start.
    const speeds = fit.tangents.map((t) => Math.hypot(t[0], t[1]))
    for (const s of speeds) expect(s).toBeCloseTo(speeds[0], 9)
    const pts = splinePolyline(fit)
    expect(pts[0]).toEqual([0, 0])
    expect(pts[pts.length - 1][0]).toBeCloseTo(0, 9)
    expect(pts[pts.length - 1][1]).toBeCloseTo(0, 9)
  })

  it('approximates a circle through points on it to a fraction of a percent', () => {
    // Twelve points round a Ø 20 circle, closed: the length is close to the
    // circumference and every sample within a hair of the radius.
    const pts: Vec2[] = Array.from({ length: 12 }, (_, i) => [
      10 * Math.cos((i * Math.PI) / 6),
      10 * Math.sin((i * Math.PI) / 6),
    ])
    const fit = fitSplinePoints(pts, none(12), true)
    expect(Math.abs(fit.length - 20 * Math.PI) / (20 * Math.PI)).toBeLessThan(0.002)
    for (const p of splinePolyline(fit)) expect(Math.hypot(p[0], p[1])).toBeCloseTo(10, 1)
    // Open, through four points 40° apart on a 120° arc — what the e2e run
    // clicks along the disc — the natural ends straighten the tips a little
    // and the length falls a hair short of the arc's, within a percent.
    const arc: Vec2[] = [100, 140, 180, 220].map((deg) => [
      10 * Math.cos((deg * Math.PI) / 180),
      10 * Math.sin((deg * Math.PI) / 180),
    ])
    const open = fitSplinePoints(arc, none(4), false)
    const arcLength = (10 * 120 * Math.PI) / 180
    expect(open.length).toBeLessThan(arcLength)
    expect(Math.abs(open.length - arcLength) / arcLength).toBeLessThan(0.01)
  })

  it('honours a handle set by hand and re-solves the rest around it', () => {
    // The middle of three points on a line, with its tangent turned straight
    // up: the curve leaves the point along the handle, at the handle's pull.
    const pts: Vec2[] = [
      [0, 0],
      [10, 0],
      [20, 0],
    ]
    const straight = fitSplinePoints(pts, none(3), false)
    expect(straight.length).toBeCloseTo(20, 9)
    const bent = fitSplinePoints(pts, [null, [0, 4], null], false)
    expect(bent.fixed).toEqual([false, true, false])
    // The mean chord at the middle point is 10, the reach a third of it: a
    // handle of 4 along +Y is a derivative of 4 / (10 / 3) = 1.2 along +Y.
    expect(bent.tangents[1][0]).toBeCloseTo(0, 9)
    expect(bent.tangents[1][1]).toBeCloseTo(4 / (10 * HANDLE_REACH), 9)
    expect(bent.length).toBeGreaterThan(straight.length)
    // The handles read back exactly what was set, symmetric about the point.
    const handles = splineHandles(bent)
    expect(handles[1].at).toEqual([10, 0])
    expect(handles[1].a[0]).toBeCloseTo(10, 9)
    expect(handles[1].a[1]).toBeCloseTo(4, 9)
    expect(handles[1].b[0]).toBeCloseTo(10, 9)
    expect(handles[1].b[1]).toBeCloseTo(-4, 9)
    expect(handles[1].fixed).toBe(true)
    expect(handles[0].fixed).toBe(false)
    // An automatic handle on the unbent line reaches a third of the way to
    // the neighbour, along it; once the middle is bent the ends re-solve
    // and their handles follow.
    const plain = splineHandles(straight)
    expect(plain[0].a[0]).toBeCloseTo(10 * HANDLE_REACH, 9)
    expect(plain[0].a[1]).toBeCloseTo(0, 9)
    expect(plain[2].b[0]).toBeCloseTo(20 - 10 * HANDLE_REACH, 9)
    expect(handles[0].a[1]).toBeLessThan(0)
    // The free points are still C2 with the fixed one in place.
    const before = secondDerivative(bent, 0, 1 - 1e-4)
    const after = secondDerivative(bent, 1, 1e-4)
    expect(Math.hypot(before[0] - after[0], before[1] - after[1])).toBeGreaterThan(0)
  })

  it('refuses what cannot carry a curve, with a reason', () => {
    expect(() => fitSplinePoints([[0, 0]], none(1), false)).toThrow(FitError)
    expect(() => fitSplinePoints([[0, 0]], none(1), false)).toThrow(/at least two/)
    expect(() =>
      fitSplinePoints(
        [
          [0, 0],
          [5, 5],
        ],
        none(2),
        true,
      ),
    ).toThrow(/closed spline needs at least three/)
    expect(() =>
      fitSplinePoints(
        [
          [0, 0],
          [0, 0],
          [5, 5],
        ],
        none(3),
        false,
      ),
    ).toThrow(/coincide/)
    // Closed, the seam is a segment too: the last point may not sit on the first.
    expect(() =>
      fitSplinePoints(
        [
          [0, 0],
          [5, 5],
          [0, 0],
        ],
        none(3),
        true,
      ),
    ).toThrow(/coincide/)
  })
})

describe('the Bézier form', () => {
  it('has three poles per segment on chord-length knots and draws the same curve', () => {
    const fit = fitSplinePoints(wave, none(4), false)
    const { poles, knots } = splineBezierForm(fit)
    expect(poles).toHaveLength(10)
    expect(knots).toHaveLength(4)
    expect(knots[0]).toBe(0)
    expect(knots[1]).toBeCloseTo(Math.hypot(10, 8), 9)
    expect(poles[0]).toEqual(wave[0])
    expect(poles[9]).toEqual(wave[3])
    for (let k = 0; k < 3; k++) {
      const [b0, b1, b2, b3] = poles.slice(3 * k, 3 * k + 4)
      for (const u of [0.25, 0.5, 0.8]) {
        const v = 1 - u
        const x = v ** 3 * b0[0] + 3 * v * v * u * b1[0] + 3 * v * u * u * b2[0] + u ** 3 * b3[0]
        const y = v ** 3 * b0[1] + 3 * v * v * u * b1[1] + 3 * v * u * u * b2[1] + u ** 3 * b3[1]
        const p = evalSpline(fit, k, u)
        expect(x).toBeCloseTo(p[0], 9)
        expect(y).toBeCloseTo(p[1], 9)
      }
    }
  })

  it('a closed curve ends where it began', () => {
    const { poles, knots } = splineBezierForm(fitSplinePoints(square, none(4), true))
    expect(poles).toHaveLength(13)
    expect(knots).toHaveLength(5)
    expect(poles[12]).toEqual([0, 0])
  })
})

describe('the hit test', () => {
  it('finds the segment a spot lies nearest, and how far off it is', () => {
    const fit = fitSplinePoints(wave, none(4), false)
    // Right on the second segment's midpoint.
    const on = evalSpline(fit, 1, 0.5)
    const hit = nearestSplineSegment(fit, on)
    expect(hit.segment).toBe(1)
    expect(hit.dist).toBeLessThan(0.05)
    // Well away from the curve: still a nearest segment, but far.
    const off = nearestSplineSegment(fit, [15, 40])
    expect(off.dist).toBeGreaterThan(30)
    // A spot beside the last segment inserts before the last point.
    const late = evalSpline(fit, 2, 0.7)
    expect(nearestSplineSegment(fit, [late[0], late[1] + 0.2]).segment).toBe(2)
  })

  it('hangs the label halfway along', () => {
    const fit = fitSplinePoints(
      [
        [0, 0],
        [10, 0],
      ],
      none(2),
      false,
    )
    const mid = splineMidpoint(fit)
    expect(mid[0]).toBeCloseTo(5, 9)
    expect(mid[1]).toBeCloseTo(0, 9)
  })
})

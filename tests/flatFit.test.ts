// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import {
  fitArcPoints,
  fitCirclePoints,
  fitLinePoints,
  flatPoint,
} from '../src/core/flat/fit'
import type { Vec2 } from '../src/core/flat/types'
import { mulberry32 } from '../src/core/fit/ransac'

/** Points on a circle, optionally radially perturbed. */
function circlePoints(
  center: Vec2,
  radius: number,
  angles: number[],
  jitter = 0,
  seed = 7,
): Vec2[] {
  const rand = mulberry32(seed)
  return angles.map((a) => {
    const r = radius + (jitter ? (rand() - 0.5) * 2 * jitter : 0)
    return [center[0] + r * Math.cos(a), center[1] + r * Math.sin(a)] as Vec2
  })
}

describe('flatPoint', () => {
  it('copies the coordinates rather than aliasing them', () => {
    const at: Vec2 = [3, 4]
    const fit = flatPoint(at)
    at[0] = 99
    expect(fit.at).toEqual([3, 4])
    expect(fit.sigma).toBe(0)
  })
})

describe('fitLinePoints', () => {
  it('is exact through two points', () => {
    const fit = fitLinePoints([
      [1, 1],
      [5, 4],
    ])
    expect(fit.center).toEqual([3, 2.5])
    expect(fit.length).toBeCloseTo(5, 12)
    expect(fit.dir[0]).toBeCloseTo(0.8, 12)
    expect(fit.dir[1]).toBeCloseTo(0.6, 12)
    expect(fit.sigma).toBeLessThan(1e-12)
    expect(fit.formError).toBeLessThan(1e-12)
  })

  it('recovers a noisy horizontal edge', () => {
    const rand = mulberry32(3)
    const pts: Vec2[] = Array.from({ length: 200 }, (_, i) => [
      i * 0.1,
      20 + (rand() - 0.5) * 0.02,
    ])
    const fit = fitLinePoints(pts)
    expect(Math.abs(fit.dir[1])).toBeLessThan(1e-3)
    expect(fit.center[1]).toBeCloseTo(20, 2)
    expect(fit.length).toBeCloseTo(19.9, 1)
    expect(fit.sigma).toBeLessThan(0.01)
    // Peak-to-peak of a ±0.01 jitter — the straightness of the picks.
    expect(fit.formError!).toBeGreaterThan(0.005)
    expect(fit.formError!).toBeLessThan(0.021)
  })

  it('fits a steep line without axis bias', () => {
    // A vertical edge is the case a y-on-x regression cannot do at all.
    const pts: Vec2[] = Array.from({ length: 50 }, (_, i) => [7, i * 0.5])
    const fit = fitLinePoints(pts)
    expect(Math.abs(fit.dir[0])).toBeLessThan(1e-9)
    expect(fit.center[0]).toBeCloseTo(7, 12)
  })

  it('orients the direction the same way whatever the pick order', () => {
    const pts: Vec2[] = [
      [0, 0],
      [1, 2],
      [2, 4.01],
    ]
    const a = fitLinePoints(pts)
    const b = fitLinePoints([...pts].reverse())
    expect(a.dir[0]).toBeCloseTo(b.dir[0], 12)
    expect(a.dir[1]).toBeCloseTo(b.dir[1], 12)
    expect(a.dir[0]).toBeGreaterThan(0)
  })

  it('refuses one point, and coincident points', () => {
    expect(() => fitLinePoints([[1, 1]])).toThrow(/two points/)
    expect(() =>
      fitLinePoints([
        [1, 1],
        [1, 1],
      ]),
    ).toThrow(/coincide/)
  })
})

describe('fitCirclePoints', () => {
  it('recovers the exact circle through three points', () => {
    const fit = fitCirclePoints(circlePoints([10, -4], 6.5, [0.3, 1.9, 4.1]))
    expect(fit.radius).toBeCloseTo(6.5, 9)
    expect(fit.center[0]).toBeCloseTo(10, 9)
    expect(fit.center[1]).toBeCloseTo(-4, 9)
    expect(fit.sigma).toBeLessThan(1e-9)
    expect(fit.usedPoints).toBe(3)
  })

  it('fits many noisy points', () => {
    const angles = Array.from({ length: 24 }, (_, i) => (i / 24) * 2 * Math.PI)
    const fit = fitCirclePoints(circlePoints([3, 8], 12, angles, 0.02))
    expect(fit.radius).toBeCloseTo(12, 1)
    expect(fit.center[0]).toBeCloseTo(3, 1)
    expect(fit.center[1]).toBeCloseTo(8, 1)
    expect(fit.sigma).toBeLessThan(0.05)
    expect(fit.formError!).toBeGreaterThan(0.01)
    expect(fit.formError!).toBeLessThan(0.09)
  })

  it('refuses collinear points', () => {
    expect(() =>
      fitCirclePoints([
        [0, 0],
        [1, 0],
        [2, 0],
      ]),
    ).toThrow()
  })
})

describe('fitArcPoints', () => {
  it('covers what the points cover', () => {
    // A quarter arc from 0 to π/2.
    const angles = Array.from({ length: 10 }, (_, i) => (i / 9) * (Math.PI / 2))
    const fit = fitArcPoints(circlePoints([5, 5], 20, angles, 0.001))
    expect(fit.radius).toBeCloseTo(20, 1)
    expect(fit.start).toBeCloseTo(0, 1)
    expect(fit.sweep).toBeCloseTo(Math.PI / 2, 1)
  })

  it('handles an arc across the ±π seam', () => {
    // Points around 180°: from 160° to 200°, whose atan2 values wrap.
    const angles = Array.from({ length: 9 }, (_, i) => Math.PI * (160 + i * 5) / 180)
    const fit = fitArcPoints(circlePoints([0, 0], 10, angles))
    expect(fit.sweep).toBeCloseTo((40 * Math.PI) / 180, 5)
    // Start at the 160° end, not at the seam.
    const startDeg = ((fit.start * 180) / Math.PI + 360) % 360
    expect(startDeg).toBeCloseTo(160, 3)
  })

  it('approaches a full turn when the points go all the way round', () => {
    const angles = Array.from({ length: 36 }, (_, i) => (i / 36) * 2 * Math.PI)
    const fit = fitArcPoints(circlePoints([1, 2], 4, angles))
    // 36 evenly spaced points leave 10° gaps — the sweep is exactly 350°.
    expect(fit.sweep).toBeGreaterThanOrEqual((350 * Math.PI) / 180 - 1e-9)
    expect(fit.sweep).toBeLessThanOrEqual(2 * Math.PI)
  })
})

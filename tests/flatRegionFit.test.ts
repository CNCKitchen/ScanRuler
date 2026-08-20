// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { fitCircleRegion, fitLineRegion } from '../src/core/flat/fit'
import type { Vec2 } from '../src/core/flat/types'
import { mulberry32 } from '../src/core/fit/ransac'

describe('fitLineRegion', () => {
  it('votes out a second edge caught by the region', () => {
    const rand = mulberry32(11)
    const pts: Vec2[] = []
    // The edge being measured: y = 50, with subpixel scatter…
    for (let i = 0; i < 200; i++) pts.push([i * 0.5, 50 + (rand() - 0.5) * 0.1])
    // …and the far side of the bar, 8 units away, caught by a sloppy drag.
    for (let i = 0; i < 60; i++) pts.push([i * 1.5, 58 + (rand() - 0.5) * 0.1])
    const fit = fitLineRegion(pts)
    // A least-squares fit over everything would land near 51.8; consensus
    // stays on the measured edge.
    expect(Math.abs(fit.center[1] - 50)).toBeLessThan(0.1)
    expect(Math.abs(fit.dir[1])).toBeLessThan(0.01)
    expect(fit.usedPoints).toBeGreaterThan(150)
    expect(fit.usedPoints).toBeLessThan(230)
  })

  it('refuses a region with too few points', () => {
    expect(() => fitLineRegion([[0, 0], [1, 1]])).toThrow(/too few/)
  })
})

describe('fitCircleRegion', () => {
  it('votes out stray points around a circle', () => {
    const rand = mulberry32(5)
    const pts: Vec2[] = []
    for (let i = 0; i < 120; i++) {
      const a = (i / 120) * 2 * Math.PI
      pts.push([100 + 40 * Math.cos(a) + (rand() - 0.5) * 0.1, 80 + 40 * Math.sin(a) + (rand() - 0.5) * 0.1])
    }
    // A straight edge clipping the corner of the region.
    for (let i = 0; i < 40; i++) pts.push([60 + i, 140 + (rand() - 0.5) * 0.1])
    const fit = fitCircleRegion(pts)
    expect(fit.radius).toBeCloseTo(40, 1)
    expect(fit.center[0]).toBeCloseTo(100, 1)
    expect(fit.center[1]).toBeCloseTo(80, 1)
  })
})

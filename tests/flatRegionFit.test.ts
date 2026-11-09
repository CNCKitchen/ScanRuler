// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { fitCircleRegion, fitLineRegion } from '../src/core/flat/fit'
import type { Vec2 } from '../src/core/flat/types'
import { mulberry32 } from '../src/core/fit/ransac'
import { evaluateFlatSource } from '../src/core/flat/elements'

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

  it('takes its scatter floor in pixels, not in the sheet’s millimetres (issue 34)', () => {
    // 600 dpi: a pixel is 0.0423 mm. The edge with a micron of scatter, and
    // a stray run 0.2 mm off it — five pixels, no scatter of the edge's.
    const pixel = 25.4 / 600
    const rand = mulberry32(3)
    const pts: Vec2[] = []
    for (let i = 0; i < 200; i++) pts.push([i * 0.05, 10 + (rand() - 0.5) * 0.002])
    for (let i = 0; i < 40; i++) pts.push([i * 0.05, 10.2 + (rand() - 0.5) * 0.002])
    expect(fitLineRegion(pts, pixel).usedPoints).toBe(200)
    // Read as pixels, 0.2 is within the floor and the strays stay in.
    expect(fitLineRegion(pts).usedPoints).toBe(240)
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

describe('the inlier floor on a calibrated sheet', () => {
  // 10 px/mm: the measured edge at y = 5 mm with a twentieth of a pixel of
  // scatter, and strays from a neighbouring edge 3 px (0.3 mm) off it.
  const pts = (): Vec2[] => {
    const rand = mulberry32(3)
    const out: Vec2[] = []
    for (let i = 0; i < 200; i++) out.push([i * 0.05, 5 + (rand() - 0.5) * 0.01])
    for (let i = 0; i < 60; i++) out.push([i * 0.15, 5.3 + (rand() - 0.5) * 0.01])
    return out
  }

  it('is a fraction of a pixel, not of a document unit', () => {
    const fit = fitLineRegion(pts(), 0.1)
    // 0.35 mm of floor kept the strays and pulled the line ~0.07 mm off.
    expect(Math.abs(fit.center[1] - 5)).toBeLessThan(0.005)
    expect(fit.usedPoints).toBeLessThanOrEqual(200)
  })

  it('reaches the fit through a calibrated element', () => {
    const picks = pts().map(([x, y]): Vec2 => [x * 10, y * 10])
    const fit = evaluateFlatSource({ type: 'picks', method: 'flat-line-edge', picks }, { x: 10, y: 10 }, () => null)
    expect(fit.kind).toBe('line')
    if (fit.kind === 'line') expect(Math.abs(fit.center[1] - 5)).toBeLessThan(0.005)
  })
})

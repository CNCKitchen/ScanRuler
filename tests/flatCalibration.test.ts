// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { diameterCalibration, distanceCalibration, toDpi } from '../src/core/flat/calibration'

describe('distance calibration', () => {
  it('reads one factor off the full length when both axes calibrate together', () => {
    // 2362.2 px across 100 mm — a 600 dpi scanner dead on nominal.
    const f = distanceCalibration([100, 500], [2462.2, 500], 100, {
      current: null,
      splitAxes: false,
    })
    expect(f.x).toBeCloseTo(23.622, 3)
    expect(f.y).toBeCloseTo(23.622, 3)
    expect(toDpi(f.x)).toBeCloseTo(600, 1)
  })

  it('accepts a diagonal reference in isotropic mode', () => {
    const f = distanceCalibration([0, 0], [300, 400], 25, { current: null, splitAxes: false })
    expect(f.x).toBeCloseTo(20, 9)
    expect(f.y).toBeCloseTo(20, 9)
  })

  it('lands an axis-aligned reference on its axis, keeping the other', () => {
    const f = distanceCalibration([0, 100], [2000, 103], 100, {
      current: { x: 10, y: 11 },
      splitAxes: true,
    })
    // The slight y drift rides along in the length, not in the y factor.
    expect(f.x).toBeCloseTo(Math.hypot(2000, 3) / 100, 9)
    expect(f.y).toBe(11)
    const g = distanceCalibration([50, 0], [53, 1500], 75, {
      current: { x: 10, y: 11 },
      splitAxes: true,
    })
    expect(g.y).toBeCloseTo(Math.hypot(3, 1500) / 75, 9)
    expect(g.x).toBe(10)
  })

  it('adopts the measured factor for the other axis when none is held yet', () => {
    const f = distanceCalibration([0, 0], [2000, 0], 100, { current: null, splitAxes: true })
    expect(f.x).toBeCloseTo(20, 9)
    expect(f.y).toBeCloseTo(20, 9)
  })

  it('refuses a diagonal reference in per-axis mode', () => {
    expect(() =>
      distanceCalibration([0, 0], [1000, 900], 50, { current: null, splitAxes: true }),
    ).toThrow(/diagonal/)
  })

  it('refuses nonsense input', () => {
    expect(() =>
      distanceCalibration([0, 0], [100, 0], 0, { current: null, splitAxes: false }),
    ).toThrow(/positive/)
    expect(() =>
      distanceCalibration([5, 5], [5, 5], 10, { current: null, splitAxes: false }),
    ).toThrow(/coincide/)
  })
})

describe('diameter calibration', () => {
  it('reads the factor off a picked circle', () => {
    // A 20 mm gauge pin at 472.44 px diameter — 600 dpi dead on.
    const r = 236.22
    const picks = Array.from({ length: 8 }, (_, i) => {
      const a = (i / 8) * 2 * Math.PI
      return [1000 + r * Math.cos(a), 800 + r * Math.sin(a)] as [number, number]
    })
    const f = diameterCalibration(picks, 20)
    expect(f.x).toBeCloseTo(23.622, 3)
    expect(f.y).toBeCloseTo(23.622, 3)
  })

  it('refuses too few points and degenerate circles', () => {
    expect(() => diameterCalibration([[0, 0], [1, 1]], 10)).toThrow(/three points/)
    expect(() =>
      diameterCalibration(
        [
          [0, 0],
          [10, 0],
          [20, 0],
        ],
        10,
      ),
    ).toThrow()
    expect(() =>
      diameterCalibration(
        [
          [0, 0],
          [10, 0],
          [5, 5],
        ],
        0,
      ),
    ).toThrow(/positive/)
  })
})

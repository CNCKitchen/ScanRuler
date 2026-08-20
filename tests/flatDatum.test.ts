// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { datumFrame, fitInFrame, gridSpacing, toFrame } from '../src/core/flat/datum'
import { fitLinePoints, flatPoint } from '../src/core/flat/fit'

describe('datumFrame', () => {
  it('spans origin and +X from two pixel picks at the scale in force', () => {
    const f = datumFrame({ originPx: [100, 200], xRefPx: [300, 200] }, { x: 10, y: 10 })!
    expect(f.origin).toEqual([10, 20])
    expect(f.xDir[0]).toBeCloseTo(1, 12)
    expect(f.xDir[1]).toBeCloseTo(0, 12)
  })

  it('lets an anisotropic calibration bend the direction, as it must', () => {
    // 45° in pixels, but Y pixels are twice as fine as X pixels.
    const f = datumFrame({ originPx: [0, 0], xRefPx: [100, 100] }, { x: 10, y: 20 })!
    expect(Math.atan2(f.xDir[1], f.xDir[0])).toBeCloseTo(Math.atan2(5, 10), 9)
  })

  it('refuses coincident picks', () => {
    expect(datumFrame({ originPx: [5, 5], xRefPx: [5, 5] }, null)).toBeNull()
  })
})

describe('toFrame and fitInFrame', () => {
  const frame = datumFrame({ originPx: [100, 100], xRefPx: [100 + 70.71, 100 + 70.71] }, null)!

  it('reads a point in the rotated frame', () => {
    // A point one unit along the 45° axis.
    const p = toFrame(frame, [100 + Math.SQRT1_2, 100 + Math.SQRT1_2])
    expect(p[0]).toBeCloseTo(1, 6)
    expect(p[1]).toBeCloseTo(0, 6)
  })

  it('turns a line angle into a frame-relative one, leaving the length', () => {
    const line = fitLinePoints([
      [0, 0],
      [10, 10],
    ])
    const inFrame = fitInFrame(line, frame)
    if (inFrame.kind !== 'line') throw new Error('kind changed')
    expect(inFrame.length).toBeCloseTo(line.length, 12)
    // The 45° line reads as 0° in a 45° frame.
    expect(Math.atan2(inFrame.dir[1], inFrame.dir[0])).toBeCloseTo(0, 6)
  })

  it('is the identity without a frame', () => {
    const p = flatPoint([3, 4])
    expect(fitInFrame(p, null)).toBe(p)
  })
})

describe('gridSpacing', () => {
  it('walks the 1-2-5 ladder with zoom', () => {
    // Zoomed far in: 0.01 units per screen px → 0.5-unit lines are 50 px apart.
    expect(gridSpacing(0.01)).toBeCloseTo(0.5)
    // Overview: 0.5 units per screen px → 20-unit lines.
    expect(gridSpacing(0.5)).toBe(20)
    // Absurdly far out it stops at the coarsest rung rather than vanishing.
    expect(gridSpacing(1000)).toBe(100)
  })
})

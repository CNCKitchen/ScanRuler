// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { datumFrame, fitInFrame, gridSpacing, rollAxes, rollMap, sheetRoll, toFrame } from '../src/core/flat/datum'
import { fitLinePoints, flatPoint } from '../src/core/flat/fit'
import { fitSplinePoints } from '../src/core/flat/spline'

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

  it("moves a spline's points into the frame and turns its tangents with them", () => {
    const spline = fitSplinePoints(
      [
        [100, 100],
        [110, 110],
      ],
      [null, null],
      false,
    )
    const inFrame = fitInFrame(spline, frame)
    if (inFrame.kind !== 'spline') throw new Error('kind changed')
    expect(inFrame.points[0][0]).toBeCloseTo(0, 6)
    expect(inFrame.points[0][1]).toBeCloseTo(0, 6)
    expect(inFrame.points[1][0]).toBeCloseTo(Math.hypot(10, 10), 6)
    expect(inFrame.points[1][1]).toBeCloseTo(0, 6)
    // The 45° tangent reads as 0° in a 45° frame; the length rides along.
    expect(Math.atan2(inFrame.tangents[0][1], inFrame.tangents[0][0])).toBeCloseTo(0, 6)
    expect(inFrame.length).toBe(spline.length)
    expect(inFrame.fixed).toEqual([false, false])
  })

  it('is the identity without a frame', () => {
    const p = flatPoint([3, 4])
    expect(fitInFrame(p, null)).toBe(p)
  })
})

describe('sheetRoll', () => {
  it('is nothing for a sheet as scanned, and a quarter turn per turn', () => {
    expect(sheetRoll(null, 0)).toBe(0)
    expect(sheetRoll(null, 1)).toBeCloseTo(Math.PI / 2, 12)
    expect(sheetRoll(null, -1)).toBeCloseTo((3 * Math.PI) / 2, 12)
    expect(sheetRoll(null, 6)).toBeCloseTo(Math.PI, 12)
  })

  it('brings the alignment square: +X at 30° rolls the sheet back by 30°', () => {
    const xDir: [number, number] = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)]
    expect(sheetRoll(xDir, 0)).toBeCloseTo(-Math.PI / 6, 12)
    // The quarter turns go on top.
    expect(sheetRoll(xDir, 1)).toBeCloseTo(Math.PI / 2 - Math.PI / 6, 12)
  })

  it('maps points and names the screen axes exactly at the quarter turns', () => {
    // A quarter turn counter-clockwise: what was to the right goes up, so
    // document +X is the screen's up and document −Y its right.
    const quarter = sheetRoll(null, 1)
    expect(rollMap(quarter)([3, 4])).toEqual([-4, 3])
    expect(rollAxes(quarter)).toEqual({ right: [0, -1], up: [1, 0] })
    expect(rollAxes(0)).toEqual({ right: [1, 0], up: [0, 1] })
    expect(rollAxes(sheetRoll(null, 2))).toEqual({ right: [-1, 0], up: [0, -1] })
  })

  it('shows an aligned sheet with the alignment as its screen axes', () => {
    // +X picked pointing straight up the scan: the screen's right is +Y of the
    // document, its up is −X — the part turned a quarter turn clockwise.
    const axes = rollAxes(sheetRoll([0, 1], 0))
    expect(axes.right[0]).toBeCloseTo(0, 12)
    expect(axes.right[1]).toBeCloseTo(1, 12)
    expect(axes.up[0]).toBeCloseTo(-1, 12)
    expect(axes.up[1]).toBeCloseTo(0, 12)
    // A point one unit along the alignment lands one unit to the right.
    const p = rollMap(sheetRoll([0, 1], 0))([0, 1])
    expect(p[0]).toBeCloseTo(1, 12)
    expect(p[1]).toBeCloseTo(0, 12)
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

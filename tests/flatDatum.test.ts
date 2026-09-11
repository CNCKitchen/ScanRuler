// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import {
  datumFrame,
  describeShown,
  fitInFrame,
  frameMirrored,
  gridSpacing,
  poseAxes,
  poseMap,
  sheetPose,
  toFrame,
} from '../src/core/flat/datum'
import { fitLinePoints, flatPoint } from '../src/core/flat/fit'
import { fitSplinePoints } from '../src/core/flat/spline'
import type { FlatArcFit, Vec2 } from '../src/core/flat/types'

describe('datumFrame', () => {
  it('spans origin and +X from two pixel picks at the scale in force', () => {
    const f = datumFrame({ originPx: [100, 200], xRefPx: [300, 200] }, { x: 10, y: 10 })!
    expect(f.origin).toEqual([10, 20])
    expect(f.xDir[0]).toBeCloseTo(1, 12)
    expect(f.xDir[1]).toBeCloseTo(0, 12)
    // +Y a quarter turn counter-clockwise from +X: right-handed as scanned.
    expect(f.yDir[0]).toBeCloseTo(0, 12)
    expect(f.yDir[1]).toBeCloseTo(1, 12)
    expect(frameMirrored(f)).toBe(false)
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

describe('a mirrored frame', () => {
  // The same picks on a sheet shown mirrored: +X as picked, +Y the other way
  // round on the sheet — which is up the screen as shown, so the frame is
  // right-handed under the eye.
  const datum = { originPx: [100, 100] as Vec2, xRefPx: [200, 100] as Vec2 }
  const plain = datumFrame(datum, null)!
  const mirrored = datumFrame(datum, null, true)!

  it('is left-handed on the sheet, and reads a point above the axis as below it', () => {
    expect(frameMirrored(plain)).toBe(false)
    expect(frameMirrored(mirrored)).toBe(true)
    expect(toFrame(plain, [110, 105])).toEqual([10, 5])
    expect(toFrame(mirrored, [110, 105])).toEqual([10, -5])
  })

  it('turns a line angle round, leaving its length', () => {
    const line = fitLinePoints([
      [100, 100],
      [110, 110],
    ])
    const read = fitInFrame(line, mirrored)
    if (read.kind !== 'line') throw new Error('kind changed')
    expect(Math.atan2(read.dir[1], read.dir[0])).toBeCloseTo(-Math.PI / 4, 9)
    expect(read.length).toBeCloseTo(line.length, 12)
  })

  it("reads an arc counter-clockwise from where the sheet's ended", () => {
    // A quarter arc from 0° to 90° on the sheet runs from 0° down to −90° as
    // read; counter-clockwise, that is −90° to 0°, the sweep unchanged.
    const arc: FlatArcFit = { kind: 'arc', center: [100, 100], radius: 5, start: 0, sweep: Math.PI / 2, sigma: 0, usedPoints: 0 }
    const read = fitInFrame(arc, mirrored)
    if (read.kind !== 'arc') throw new Error('kind changed')
    expect(read.start).toBeCloseTo(-Math.PI / 2, 12)
    expect(read.sweep).toBe(Math.PI / 2)
    expect(read.center).toEqual([0, 0])
    // Its ends are the sheet's ends, read in the frame: (105, 100) and (100, 105).
    const at = (a: number): Vec2 => [read.center[0] + 5 * Math.cos(a), read.center[1] + 5 * Math.sin(a)]
    expect(at(read.start)[0]).toBeCloseTo(0, 12)
    expect(at(read.start)[1]).toBeCloseTo(-5, 12)
    expect(at(read.start + read.sweep)[0]).toBeCloseTo(5, 12)
    expect(at(read.start + read.sweep)[1]).toBeCloseTo(0, 12)
  })

  it("flips a spline's tangents with its points", () => {
    const spline = fitSplinePoints(
      [
        [100, 100],
        [110, 110],
      ],
      [null, null],
      false,
    )
    const read = fitInFrame(spline, mirrored)
    if (read.kind !== 'spline') throw new Error('kind changed')
    expect(read.points[1][0]).toBeCloseTo(10, 9)
    expect(read.points[1][1]).toBeCloseTo(-10, 9)
    expect(Math.atan2(read.tangents[0][1], read.tangents[0][0])).toBeCloseTo(-Math.PI / 4, 9)
    expect(read.length).toBe(spline.length)
  })
})

describe('sheetPose', () => {
  it('is nothing for a sheet as scanned, and a quarter turn per turn', () => {
    expect(sheetPose(null, 0)).toEqual({ roll: 0, mirror: false })
    expect(sheetPose(null, 1).roll).toBeCloseTo(Math.PI / 2, 12)
    expect(sheetPose(null, -1).roll).toBeCloseTo((3 * Math.PI) / 2, 12)
    expect(sheetPose(null, 6).roll).toBeCloseTo(Math.PI, 12)
  })

  it('brings the alignment square: +X at 30° rolls the sheet back by 30°', () => {
    const xDir: Vec2 = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)]
    expect(sheetPose(xDir, 0).roll).toBeCloseTo(-Math.PI / 6, 12)
    // The quarter turns go on top.
    expect(sheetPose(xDir, 1).roll).toBeCloseTo(Math.PI / 2 - Math.PI / 6, 12)
  })

  it('mirrors an aligned sheet across the alignment, +X still to the right', () => {
    const xDir: Vec2 = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)]
    const pose = sheetPose(xDir, 0, true)
    // Flipped across the document's X first, the alignment then lies at −30°
    // and the roll runs the other way to bring it square.
    expect(pose.roll).toBeCloseTo(Math.PI / 6, 12)
    const along = poseMap(pose)(xDir)
    expect(along[0]).toBeCloseTo(1, 12)
    expect(along[1]).toBeCloseTo(0, 12)
    // The frame's +Y on the sheet — a quarter turn counter-clockwise from
    // +X — lands pointing down the screen: a mirror, not a turn.
    const across = poseMap(pose)([-xDir[1], xDir[0]])
    expect(across[0]).toBeCloseTo(0, 12)
    expect(across[1]).toBeCloseTo(-1, 12)
    // The quarter turns still go on top.
    expect(sheetPose(xDir, 1, true).roll).toBeCloseTo(Math.PI / 2 + Math.PI / 6, 12)
  })

  it('maps points and names the screen axes exactly at the quarter turns', () => {
    // A quarter turn counter-clockwise: what was to the right goes up, so
    // document +X is the screen's up and document −Y its right.
    const quarter = sheetPose(null, 1)
    expect(poseMap(quarter)([3, 4])).toEqual([-4, 3])
    expect(poseAxes(quarter)).toEqual({ right: [0, -1], up: [1, 0] })
    expect(poseAxes(sheetPose(null, 0))).toEqual({ right: [1, 0], up: [0, 1] })
    expect(poseAxes(sheetPose(null, 2))).toEqual({ right: [-1, 0], up: [0, -1] })
  })

  it('mirrors across the document X axis first, then turns', () => {
    // Mirrored with no turns is the sheet flipped top-to-bottom; with a half
    // turn on top it is flipped left-to-right.
    const topBottom = sheetPose(null, 0, true)
    expect(poseMap(topBottom)([3, 4])).toEqual([3, -4])
    expect(poseAxes(topBottom)).toEqual({ right: [1, 0], up: [0, -1] })
    const leftRight = sheetPose(null, 2, true)
    expect(poseMap(leftRight)([3, 4])).toEqual([-3, 4])
    expect(poseAxes(leftRight)).toEqual({ right: [-1, 0], up: [0, 1] })
    // A quarter turn on a mirrored sheet swaps the axes without turning
    // the sense back: the reflection across the diagonal.
    expect(poseMap(sheetPose(null, 1, true))([3, 4])).toEqual([4, 3])
  })

  it('shows an aligned sheet with the alignment as its screen axes', () => {
    // +X picked pointing straight up the scan: the screen's right is +Y of the
    // document, its up is −X — the part turned a quarter turn clockwise.
    const axes = poseAxes(sheetPose([0, 1], 0))
    expect(axes.right[0]).toBeCloseTo(0, 12)
    expect(axes.right[1]).toBeCloseTo(1, 12)
    expect(axes.up[0]).toBeCloseTo(-1, 12)
    expect(axes.up[1]).toBeCloseTo(0, 12)
    // A point one unit along the alignment lands one unit to the right.
    const p = poseMap(sheetPose([0, 1], 0))([0, 1])
    expect(p[0]).toBeCloseTo(1, 12)
    expect(p[1]).toBeCloseTo(0, 12)
  })
})

describe('describeShown', () => {
  it('says how the sheet is shown, the mirror told from left-to-right', () => {
    expect(describeShown(0, false)).toBe('')
    expect(describeShown(1, false)).toBe('turned a quarter turn counter-clockwise')
    expect(describeShown(2, false)).toBe('turned upside down')
    expect(describeShown(3, false)).toBe('turned a quarter turn clockwise')
    expect(describeShown(2, true)).toBe('mirrored left-to-right')
    expect(describeShown(0, true)).toBe('mirrored top-to-bottom')
    expect(describeShown(3, true)).toBe('mirrored left-to-right and turned a quarter turn counter-clockwise')
    expect(describeShown(1, true)).toBe('mirrored left-to-right and turned a quarter turn clockwise')
    expect(describeShown(-2, true)).toBe('mirrored left-to-right')
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

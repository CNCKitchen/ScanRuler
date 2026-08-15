// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { ConstructionError, evaluateConstruction } from '../src/core/elements/construct'
import type { LineFit, PlaneFit, PointFit, SphereFit, CylinderFit, Vec3 } from '../src/core/types'

const stats = { sigma: 0, usedPoints: 0, regionSize: 0 }
const point = (center: Vec3): PointFit => ({ kind: 'point', center, ...stats })
const sphere = (center: Vec3, radius = 5): SphereFit => ({
  kind: 'sphere',
  center,
  radius,
  sigma: 0.001,
  usedPoints: 500,
  regionSize: 600,
})
const cylinder = (center: Vec3, axis: Vec3, length = 30): CylinderFit => ({
  kind: 'cylinder',
  center,
  axis,
  radius: 4,
  length,
  coverage: 360,
  sigma: 0.001,
  usedPoints: 500,
  regionSize: 600,
})
const planeZ = (center: Vec3, normal: Vec3, basisU: Vec3, basisV: Vec3): PlaneFit => ({
  kind: 'plane',
  center,
  normal,
  basisU,
  basisV,
  extentU: 10,
  extentV: 10,
  sigma: 0.001,
  usedPoints: 500,
  regionSize: 600,
})

const SIZE = 100

describe('point constructions', () => {
  it('builds a point from coordinates', () => {
    const p = evaluateConstruction('point-coords', [], [1, 2, 3], SIZE) as PointFit
    expect(p.kind).toBe('point')
    expect(p.center).toEqual([1, 2, 3])
  })

  it('builds the midpoint of two sphere centers', () => {
    const p = evaluateConstruction(
      'point-midpoint',
      [sphere([0, 0, 0]), sphere([10, 4, -2])],
      [],
      SIZE,
    ) as PointFit
    expect(p.center).toEqual([5, 2, -1])
  })
})

describe('line constructions', () => {
  it('builds a line through two points', () => {
    const l = evaluateConstruction(
      'line-two-points',
      [point([0, 0, 0]), point([0, 0, 8])],
      [],
      SIZE,
    ) as LineFit
    expect(l.dir[2]).toBeCloseTo(1, 9)
    expect(l.length).toBeCloseTo(8, 9)
    expect(l.center).toEqual([0, 0, 4])
  })

  it('rejects coincident points', () => {
    expect(() =>
      evaluateConstruction('line-two-points', [point([1, 1, 1]), point([1, 1, 1])], [], SIZE),
    ).toThrow(ConstructionError)
  })

  it('extracts a cylinder axis', () => {
    const l = evaluateConstruction(
      'line-axis',
      [cylinder([1, 2, 3], [0, 1, 0], 30)],
      [],
      SIZE,
    ) as LineFit
    expect(l.center).toEqual([1, 2, 3])
    expect(l.dir).toEqual([0, 1, 0])
    expect(l.length).toBeCloseTo(30, 9)
  })

  it('intersects two perpendicular planes along the expected direction', () => {
    // z = 2 floor and x = 3 wall meet in a line along Y through (3, ·, 2).
    const floor = planeZ([0, 0, 2], [0, 0, 1], [1, 0, 0], [0, 1, 0])
    const wall = planeZ([3, 0, 10], [1, 0, 0], [0, 1, 0], [0, 0, 1])
    const l = evaluateConstruction('line-plane-plane', [floor, wall], [], SIZE) as LineFit
    expect(Math.abs(l.dir[1])).toBeCloseTo(1, 9)
    expect(l.center[0]).toBeCloseTo(3, 9)
    expect(l.center[2]).toBeCloseTo(2, 9)
  })

  it('rejects parallel planes', () => {
    const a = planeZ([0, 0, 0], [0, 0, 1], [1, 0, 0], [0, 1, 0])
    const b = planeZ([0, 0, 5], [0, 0, 1], [1, 0, 0], [0, 1, 0])
    expect(() => evaluateConstruction('line-plane-plane', [a, b], [], SIZE)).toThrow(
      ConstructionError,
    )
  })
})

describe('plane constructions', () => {
  it('spans a plane through three points', () => {
    const p = evaluateConstruction(
      'plane-three-points',
      [point([0, 0, 5]), point([10, 0, 5]), point([0, 10, 5])],
      [],
      SIZE,
    ) as PlaneFit
    expect(Math.abs(p.normal[2])).toBeCloseTo(1, 9)
    expect(p.center[2]).toBeCloseTo(5, 9)
  })

  it('rejects collinear points', () => {
    expect(() =>
      evaluateConstruction(
        'plane-three-points',
        [point([0, 0, 0]), point([1, 0, 0]), point([2, 0, 0])],
        [],
        SIZE,
      ),
    ).toThrow(ConstructionError)
  })

  it('offsets a plane along its normal', () => {
    const src = planeZ([0, 0, 2], [0, 0, 1], [1, 0, 0], [0, 1, 0])
    const p = evaluateConstruction('plane-offset', [src], [3.5], SIZE) as PlaneFit
    expect(p.center[2]).toBeCloseTo(5.5, 9)
    expect(p.normal).toEqual(src.normal)
    expect(p.usedPoints).toBe(0)
  })

  it('builds the midplane of two opposing faces', () => {
    const top = planeZ([0, 0, 10], [0, 0, 1], [1, 0, 0], [0, 1, 0])
    const bottom = planeZ([0, 0, 0], [0, 0, -1], [1, 0, 0], [0, -1, 0])
    const p = evaluateConstruction('plane-midplane', [top, bottom], [], SIZE) as PlaneFit
    expect(p.center[2]).toBeCloseTo(5, 9)
    expect(Math.abs(p.normal[2])).toBeCloseTo(1, 9)
  })

  it('builds a plane from coordinates with a normalized normal', () => {
    const p = evaluateConstruction('plane-coords', [], [0, 0, 2, 1, 2, 3], SIZE) as PlaneFit
    expect(p.normal).toEqual([0, 0, 1])
    expect(p.center).toEqual([1, 2, 3])
    expect(p.extentU).toBeGreaterThan(0)
  })
})

// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import {
  assignDimensionRefs,
  evaluateDimension,
  evaluateDimensions,
  resolveDimensionType,
} from '../src/core/dimensions'
import type {
  CylinderFit,
  LineFit,
  PlaneFit,
  PointFit,
  SphereFit,
  Vec3,
} from '../src/core/types'

const stats = { sigma: 0, usedPoints: 0, regionSize: 0 }

const point = (center: Vec3): PointFit => ({ kind: 'point', center, ...stats })

const sphere = (center: Vec3, radius: number): SphereFit => ({
  kind: 'sphere',
  center,
  radius,
  sigma: 0.001,
  usedPoints: 500,
  regionSize: 600,
})

const cylinder = (center: Vec3, axis: Vec3, length = 40): CylinderFit => ({
  kind: 'cylinder',
  center,
  axis,
  radius: 5,
  length,
  coverage: 360,
  sigma: 0.001,
  usedPoints: 500,
  regionSize: 600,
})

const line = (center: Vec3, dir: Vec3, length = 40): LineFit => ({
  kind: 'line',
  center,
  dir,
  length,
  ...stats,
})

/** Plane with the given normal tilted from +Z around Y by `tiltDeg`. */
function plane(center: Vec3, extentU = 10, extentV = 10, tiltDeg = 0, flip = false): PlaneFit {
  const t = (tiltDeg * Math.PI) / 180
  const s = flip ? -1 : 1
  return {
    kind: 'plane',
    center,
    normal: [s * Math.sin(t), 0, s * Math.cos(t)],
    basisU: [Math.cos(t), 0, -Math.sin(t)],
    basisV: [0, 1, 0],
    extentU,
    extentV,
    sigma: 0.001,
    usedPoints: 500,
    regionSize: 600,
  }
}

describe('point – point', () => {
  it('measures the center distance with signed components', () => {
    const r = evaluateDimension('dist-point-point', [point([0, 0, 0]), sphere([3, 4, 0], 1)])
    expect(r.raw).toBeCloseTo(5, 9)
    expect(r.label).toBe('Center distance')
    expect(r.segment).toEqual([
      [0, 0, 0],
      [3, 4, 0],
    ])
    expect(r.detail).toContain('ΔX +3.000')
    expect(r.detail).toContain('ΔY +4.000')
  })

  it('subtracts and adds radii between two spheres', () => {
    const a = sphere([0, 0, 0], 2)
    const b = sphere([10, 0, 0], 3)
    expect(evaluateDimension('dist-point-point', [a, b], 'gap').raw).toBeCloseTo(5, 9)
    expect(evaluateDimension('dist-point-point', [a, b], 'span').raw).toBeCloseTo(15, 9)
    expect(evaluateDimension('dist-point-point', [a, b], 'center').raw).toBeCloseTo(10, 9)
  })

  it('warns when fitted spheres overlap', () => {
    const r = evaluateDimension(
      'dist-point-point',
      [sphere([0, 0, 0], 3), sphere([4, 0, 0], 3)],
      'gap',
    )
    expect(r.raw).toBeCloseTo(-2, 9)
    expect(r.warning).toMatch(/overlap/)
  })
})

describe('point – axis', () => {
  it('measures the perpendicular distance to the axis', () => {
    const r = evaluateDimension('dist-point-axis', [
      point([7, 0, 10]),
      cylinder([0, 0, 0], [0, 0, 1], 40),
    ])
    expect(r.raw).toBeCloseTo(7, 9)
    expect(r.warning).toBeUndefined()
  })

  it('warns when the foot lies beyond the measured section', () => {
    const r = evaluateDimension('dist-point-axis', [
      point([7, 0, 100]),
      cylinder([0, 0, 0], [0, 0, 1], 40),
    ])
    expect(r.raw).toBeCloseTo(7, 9)
    expect(r.warning).toMatch(/beyond the measured section/)
  })

  it('accepts a constructed line as the axis', () => {
    const r = evaluateDimension('dist-point-axis', [
      point([0, 3, 0]),
      line([0, 0, 0], [1, 0, 0], 40),
    ])
    expect(r.raw).toBeCloseTo(3, 9)
  })
})

describe('point – plane', () => {
  it('is signed along the plane normal', () => {
    const p = plane([0, 0, 0])
    expect(evaluateDimension('dist-point-plane', [point([0, 0, 5]), p]).raw).toBeCloseTo(5, 9)
    expect(evaluateDimension('dist-point-plane', [point([0, 0, -5]), p]).raw).toBeCloseTo(-5, 9)
    expect(evaluateDimension('dist-point-plane', [point([0, 0, 5]), p]).value).toBe('+5.000 mm')
  })

  it('warns when the projection leaves the measured patch', () => {
    const r = evaluateDimension('dist-point-plane', [point([100, 0, 5]), plane([0, 0, 0], 10, 10)])
    expect(r.raw).toBeCloseTo(5, 9)
    expect(r.warning).toMatch(/outside the measured plane patch/)
  })

  it('uses a sphere center as the point', () => {
    const r = evaluateDimension('dist-point-plane', [sphere([0, 0, 12], 3), plane([0, 0, 0])])
    expect(r.raw).toBeCloseTo(12, 9)
  })
})

describe('axis – axis', () => {
  it('measures parallel axes cleanly', () => {
    const r = evaluateDimension('dist-axis-axis', [
      cylinder([0, 0, 0], [0, 0, 1]),
      cylinder([10, 0, 0], [0, 0, 1]),
    ])
    expect(r.raw).toBeCloseTo(10, 9)
    expect(r.warning).toBeUndefined()
  })

  it('reports the closest approach of clearly skew axes with a warning', () => {
    // Perpendicular axes passing 4 apart, crossing near both midpoints.
    const r = evaluateDimension('dist-axis-axis', [
      cylinder([0, 0, 0], [0, 0, 1], 40),
      cylinder([0, 4, 0], [1, 0, 0], 40),
    ])
    expect(r.raw).toBeCloseTo(4, 9)
    expect(r.warning).toMatch(/closest approach/)
  })

  it('refuses a skew distance whose closest approach is off the measured sections', () => {
    const r = evaluateDimension('dist-axis-axis', [
      cylinder([0, 0, 0], [0, 0, 1], 40),
      cylinder([0, 4, 1000], [1, 0, 0], 40),
    ])
    expect(r.invalid).toMatch(/outside the measured sections/)
    expect(r.value).toBeUndefined()
  })
})

describe('axis – plane', () => {
  it('measures a parallel axis, signed along the normal', () => {
    const r = evaluateDimension('dist-axis-plane', [
      cylinder([0, 0, 8], [1, 0, 0]),
      plane([0, 0, 0]),
    ])
    expect(r.raw).toBeCloseTo(8, 9)
    expect(r.value).toBe('+8.000 mm')
  })

  it('refuses a clearly tilted axis', () => {
    const t = (10 * Math.PI) / 180
    const r = evaluateDimension('dist-axis-plane', [
      cylinder([0, 0, 8], [Math.cos(t), 0, Math.sin(t)]),
      plane([0, 0, 0]),
    ])
    expect(r.invalid).toMatch(/off parallel/)
  })
})

describe('plane – plane', () => {
  it('measures parallel planes', () => {
    const r = evaluateDimension('dist-plane-plane', [plane([0, 0, 2]), plane([0, 0, 0])])
    expect(r.raw).toBeCloseTo(2, 9)
    expect(r.warning).toBeUndefined()
  })

  it('measures opposing faces regardless of normal orientation', () => {
    const r = evaluateDimension('dist-plane-plane', [
      plane([0, 0, 2]),
      plane([0, 0, 0], 10, 10, 0, true),
    ])
    expect(r.raw).toBeCloseTo(2, 9)
  })

  it('warns between the warn and max fold angles', () => {
    const r = evaluateDimension('dist-plane-plane', [plane([0, 0, 2], 10, 10, 1), plane([0, 0, 0])])
    expect(r.value).toBeDefined()
    expect(r.warning).toMatch(/off parallel/)
  })

  it('refuses clearly non-parallel planes', () => {
    const r = evaluateDimension('dist-plane-plane', [plane([0, 0, 2], 10, 10, 5), plane([0, 0, 0])])
    expect(r.invalid).toMatch(/no meaning/)
  })

  it('warns when the measured patches do not overlap', () => {
    const r = evaluateDimension('dist-plane-plane', [plane([100, 0, 2]), plane([0, 0, 0], 10, 10)])
    expect(r.raw).toBeCloseTo(2, 9)
    expect(r.warning).toMatch(/do not overlap/)
  })
})

describe('angles', () => {
  it('folds axis – axis into 0–90° and hinges the arc at the crossing', () => {
    const r = evaluateDimension('angle-axis-axis', [
      cylinder([0, 0, 0], [0, 0, 1]),
      cylinder([0, 0, 0], [Math.SQRT1_2, 0, -Math.SQRT1_2]),
    ])
    expect(r.raw).toBeCloseTo(45, 6)
    expect(r.arc).toBeDefined()
    expect(r.arc!.vertex[0]).toBeCloseTo(0, 9)
    // The drawn opening must equal the reported angle.
    const [a, b] = [r.arc!.dirA, r.arc!.dirB]
    const opening = (Math.acos(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) * 180) / Math.PI
    expect(opening).toBeCloseTo(r.raw!, 6)
  })

  it('measures axis – plane as the angle to the surface, hinged at the pierce point', () => {
    const r = evaluateDimension('angle-axis-plane', [
      cylinder([0, 0, 10], [Math.SQRT1_2, 0, Math.SQRT1_2]),
      plane([0, 0, 0], 50, 50),
    ])
    expect(r.raw).toBeCloseTo(45, 6)
    // The axis through (0,0,10) at 45° pierces z=0 at (-10, 0, 0).
    expect(r.arc!.vertex[0]).toBeCloseTo(-10, 6)
    expect(r.arc!.vertex[2]).toBeCloseTo(0, 6)
    const [a, b] = [r.arc!.dirA, r.arc!.dirB]
    const opening = (Math.acos(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) * 180) / Math.PI
    expect(opening).toBeCloseTo(r.raw!, 6)
  })

  it('reports plane – plane over the full 0–180° via oriented normals', () => {
    const opposing = evaluateDimension('angle-plane-plane', [
      plane([0, 0, 2]),
      plane([0, 0, 0], 10, 10, 0, true),
    ])
    expect(opposing.raw).toBeCloseTo(180, 6)
    expect(opposing.detail).toContain('Supplement')
    const square = evaluateDimension('angle-plane-plane', [plane([0, 0, 0]), plane([0, 0, 0], 10, 10, 90)])
    expect(square.raw).toBeCloseTo(90, 6)
    // The square corner's arc hinges on the intersection line of the planes.
    expect(square.arc).toBeDefined()
    const v = square.arc!.vertex
    expect(v[2]).toBeCloseTo(0, 6) // on the z = 0 plane
    expect(v[0]).toBeCloseTo(0, 6) // on the tilted plane through the origin
  })
})

describe('evaluateDimensions', () => {
  it('resolves names and flags missing references', () => {
    const elements = [
      { id: 1, name: 'Sphere 1', fit: sphere([0, 0, 0], 1) },
      { id: 2, name: 'Sphere 2', fit: sphere([10, 0, 0], 1) },
      { id: 3, name: 'Broken', fit: undefined },
    ]
    const rows = evaluateDimensions(
      [
        { id: 1, type: 'dist-point-point', name: 'Distance 1', refs: [1, 2] },
        { id: 2, type: 'dist-point-point', name: 'Distance 2', refs: [1, 3] },
        { id: 3, type: 'dist-point-point', name: 'Distance 3', refs: [1, 99] },
      ],
      elements,
    )
    expect(rows[0].title).toBe('Sphere 1 → Sphere 2')
    expect(rows[0].value.raw).toBeCloseTo(10, 9)
    expect(rows[1].value.invalid).toMatch(/unavailable/)
    expect(rows[2].title).toBe('Sphere 1 → ?')
    expect(rows[2].value.invalid).toBeDefined()
  })
})

describe('resolveDimensionType', () => {
  it('keeps the current type while the selection still fits it', () => {
    expect(resolveDimensionType('dist-point-point', ['point'])).toBe('dist-point-point')
    expect(resolveDimensionType('dist-point-point', ['point', 'point'])).toBe('dist-point-point')
    // A single axis pick fits the second slot of Point - Axis.
    expect(resolveDimensionType('dist-point-axis', ['axis'])).toBe('dist-point-axis')
  })

  it('switches to the role-role type of the same group on an off-role first pick', () => {
    expect(resolveDimensionType('dist-point-point', ['plane'])).toBe('dist-plane-plane')
    expect(resolveDimensionType('dist-point-point', ['axis'])).toBe('dist-axis-axis')
    expect(resolveDimensionType('angle-plane-plane', ['axis'])).toBe('angle-axis-axis')
  })

  it('re-resolves against both roles on the second pick', () => {
    // First pick was a plane (draft moved to plane-plane), second is a sphere.
    expect(resolveDimensionType('dist-plane-plane', ['plane', 'point'])).toBe('dist-point-plane')
    expect(resolveDimensionType('dist-point-point', ['point', 'axis'])).toBe('dist-point-axis')
    expect(resolveDimensionType('angle-axis-axis', ['axis', 'plane'])).toBe('angle-axis-plane')
  })

  it('changes group only when the selection has no type in the current one', () => {
    // No angle dimension takes a point.
    expect(resolveDimensionType('angle-axis-axis', ['point'])).toBe('dist-point-point')
    expect(resolveDimensionType('angle-axis-axis', ['point', 'plane'])).toBe('dist-point-plane')
  })
})

describe('assignDimensionRefs', () => {
  it('places selections into slots by role, in pick order', () => {
    expect(
      assignDimensionRefs('dist-point-plane', [
        { id: 7, role: 'plane' },
        { id: 3, role: 'point' },
      ]),
    ).toEqual([3, 7])
    expect(assignDimensionRefs('dist-point-point', [{ id: 5, role: 'point' }])).toEqual([5, null])
    expect(
      assignDimensionRefs('dist-plane-plane', [
        { id: 1, role: 'plane' },
        { id: 2, role: 'plane' },
      ]),
    ).toEqual([1, 2])
  })
})

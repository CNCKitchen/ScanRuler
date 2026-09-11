// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import {
  assignDimensionRefs,
  evaluateDimension,
  evaluateDimensions,
  judgeLimit,
  pinNotes,
  resolveDimensionType,
  selectionFits,
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
    formError: 0.001,
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
    expect(evaluateDimension('dist-point-point', [a, b], { anchor: 'gap' }).raw).toBeCloseTo(5, 9)
    expect(evaluateDimension('dist-point-point', [a, b], { anchor: 'span' }).raw).toBeCloseTo(15, 9)
    expect(evaluateDimension('dist-point-point', [a, b], { anchor: 'center' }).raw).toBeCloseTo(10, 9)
  })

  it('warns when fitted spheres overlap', () => {
    const r = evaluateDimension('dist-point-point', [sphere([0, 0, 0], 3), sphere([4, 0, 0], 3)], {
      anchor: 'gap',
    })
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
    expect(resolveDimensionType('dist-point-point', ['sphere'])).toBe('dist-point-point')
    expect(resolveDimensionType('dist-point-point', ['point', 'sphere'])).toBe('dist-point-point')
    // A single axis pick fits the second slot of Point - Axis.
    expect(resolveDimensionType('dist-point-axis', ['cylinder'])).toBe('dist-point-axis')
    // A circle is a point by default but also an axis: on Axis – Axis it
    // stays, as the axis it can be.
    expect(resolveDimensionType('angle-axis-axis', ['circle'])).toBe('angle-axis-axis')
  })

  it('switches to the role-role type of the same group on an off-role first pick', () => {
    expect(resolveDimensionType('dist-point-point', ['plane'])).toBe('dist-plane-plane')
    expect(resolveDimensionType('dist-point-point', ['cylinder'])).toBe('dist-axis-axis')
    expect(resolveDimensionType('angle-plane-plane', ['line'])).toBe('angle-axis-axis')
  })

  it('re-resolves against both roles on the second pick', () => {
    // First pick was a plane (draft moved to plane-plane), second is a sphere.
    expect(resolveDimensionType('dist-plane-plane', ['plane', 'sphere'])).toBe('dist-point-plane')
    expect(resolveDimensionType('dist-point-point', ['point', 'cone'])).toBe('dist-point-axis')
    expect(resolveDimensionType('angle-axis-axis', ['cylinder', 'plane'])).toBe('angle-axis-plane')
  })

  it('changes group only when the selection has no type in the current one', () => {
    // No angle dimension takes a point.
    expect(resolveDimensionType('angle-axis-axis', ['point'])).toBe('dist-point-point')
    expect(resolveDimensionType('angle-axis-axis', ['point', 'plane'])).toBe('dist-point-plane')
  })

  it('keeps a diameter on anything round and leaves it for a second pick', () => {
    expect(resolveDimensionType('size-diameter', ['cylinder'])).toBe('size-diameter')
    expect(resolveDimensionType('size-diameter', ['circle'])).toBe('size-diameter')
    // A plane has no diameter: the least committed guess of the family.
    expect(resolveDimensionType('size-diameter', ['plane'])).toBe('dist-plane-plane')
    // Two spheres are a distance, not two diameters.
    expect(resolveDimensionType('size-diameter', ['sphere', 'sphere'])).toBe('dist-point-point')
  })
})

describe('assignDimensionRefs', () => {
  it('places selections into slots by role, in pick order', () => {
    expect(
      assignDimensionRefs('dist-point-plane', [
        { id: 7, kind: 'plane' },
        { id: 3, kind: 'sphere' },
      ]),
    ).toEqual([3, 7])
    expect(assignDimensionRefs('dist-point-point', [{ id: 5, kind: 'point' }])).toEqual([5, null])
    expect(
      assignDimensionRefs('dist-plane-plane', [
        { id: 1, kind: 'plane' },
        { id: 2, kind: 'plane' },
      ]),
    ).toEqual([1, 2])
  })

  it('seats a circle as the point unless only the axis slot is open', () => {
    expect(assignDimensionRefs('dist-point-axis', [{ id: 4, kind: 'circle' }])).toEqual([4, null])
    expect(
      assignDimensionRefs('dist-point-axis', [
        { id: 9, kind: 'sphere' },
        { id: 4, kind: 'circle' },
      ]),
    ).toEqual([9, 4])
  })

  it('narrows a slot to its kinds', () => {
    expect(assignDimensionRefs('size-diameter', [{ id: 2, kind: 'cylinder' }])).toEqual([2])
    expect(assignDimensionRefs('size-diameter', [{ id: 2, kind: 'cone' }])).toEqual([null])
  })

  it('keeps what fits when the whole selection cannot be seated', () => {
    expect(
      assignDimensionRefs('dist-plane-plane', [
        { id: 1, kind: 'plane' },
        { id: 2, kind: 'sphere' },
      ]),
    ).toEqual([1, null])
  })
})

describe('pinNotes', () => {
  it('names the elements under a tolerance and the verdict under anything with a limit', () => {
    const elements = [
      { id: 1, name: 'Top', fit: plane([0, 0, 5]) },
      { id: 2, name: 'Base', fit: plane([0, 0, 0]) },
    ]
    const [plain, limited, tolerance, failing] = evaluateDimensions(
      [
        { id: 1, type: 'dist-plane-plane', name: 'Distance 1', refs: [1, 2] },
        {
          id: 2,
          type: 'dist-plane-plane',
          name: 'Distance 2',
          refs: [1, 2],
          limit: { kind: 'band', nominal: 5, plus: 0.1, minus: 0.1 },
        },
        { id: 3, type: 'form-flatness', name: 'Flatness 1', refs: [1] },
        {
          id: 4,
          type: 'form-flatness',
          name: 'Flatness 2',
          refs: [1],
          limit: { kind: 'max', max: 0.0001 },
        },
      ],
      elements,
    )
    expect(pinNotes(plain)).toBeUndefined()
    expect(pinNotes(limited)).toEqual(['nominal 5.000 mm +0.100 mm / −0.100 mm · Δ +0.000 mm'])
    expect(pinNotes(tolerance)).toEqual(['Top'])
    expect(pinNotes(failing)).toEqual(['Top', 'limit 0.000 mm · Δ +0.001 mm', '0.001 mm over the limit'])
  })
})

describe('selectionFits', () => {
  it('says whether one more pick could still join the selection', () => {
    expect(selectionFits('dimension', ['plane'])).toBe(true)
    expect(selectionFits('dimension', ['plane', 'sphere'])).toBe(true)
    expect(selectionFits('dimension', ['plane', 'sphere', 'plane'])).toBe(false)
    // Only a tolerance seats a lone cylinder and a lone sphere together (coaxiality).
    expect(selectionFits('tolerance', ['sphere', 'cylinder'])).toBe(true)
  })
})

describe('diameter', () => {
  it('reads twice the fitted radius and pins to the feature', () => {
    const r = evaluateDimension('size-diameter', [cylinder([1, 2, 3], [0, 0, 1])])
    expect(r.raw).toBeCloseTo(10, 9)
    expect(r.value).toBe('10.000 mm')
    expect(r.anchor).toEqual([1, 2, 3])
    expect(r.segment).toBeUndefined()
  })

  it('has nothing to say about a plane', () => {
    expect(evaluateDimension('size-diameter', [plane([0, 0, 0])]).invalid).toMatch(/no diameter/)
  })
})

describe('limits', () => {
  it('judges a ceiling: within reads negative, over reads the excess', () => {
    const within = judgeLimit(0.031, { kind: 'max', max: 0.05 }, 'mm')
    expect(within.pass).toBe(true)
    expect(within.over).toBe(0)
    expect(within.deviation).toBeCloseTo(-0.019, 9)
    expect(within.allowance).toBe('limit 0.050 mm')
    expect(within.delta).toBe('Δ -0.019 mm')
    expect(within.alarm).toBeUndefined()

    const over = judgeLimit(0.062, { kind: 'max', max: 0.05 }, 'mm')
    expect(over.pass).toBe(false)
    expect(over.over).toBeCloseTo(0.012, 9)
    expect(over.alarm).toBe('0.012 mm over the limit')
  })

  it('judges a band about a nominal, either side', () => {
    const band = { kind: 'band' as const, nominal: 12, plus: 0.02, minus: 0.01 }
    const ok = judgeLimit(12.015, band, 'mm')
    expect(ok.pass).toBe(true)
    expect(ok.deviation).toBeCloseTo(0.015, 9)
    expect(ok.delta).toBe('Δ +0.015 mm')
    expect(ok.allowance).toBe('nominal 12.000 mm +0.020 mm / −0.010 mm')

    const high = judgeLimit(12.03, band, 'mm')
    expect(high.pass).toBe(false)
    expect(high.over).toBeCloseTo(0.01, 9)
    expect(high.alarm).toBe('0.010 mm over the upper limit')

    const low = judgeLimit(11.985, band, 'mm')
    expect(low.pass).toBe(false)
    expect(low.over).toBeCloseTo(-0.005, 9)
    expect(low.alarm).toBe('0.005 mm under the lower limit')
  })

  it('reads angles in degrees', () => {
    const v = judgeLimit(90.3, { kind: 'band', nominal: 90, plus: 0.5, minus: 0.5 }, '°')
    expect(v.pass).toBe(true)
    expect(v.delta).toBe('Δ +0.30°')
    expect(v.allowance).toBe('nominal 90.00° +0.50° / −0.50°')
  })

  it('rides along with the evaluated dimension, and only where there is a value', () => {
    const elements = [
      { id: 1, name: 'Sphere 1', fit: sphere([0, 0, 0], 1) },
      { id: 2, name: 'Sphere 2', fit: sphere([10, 0, 0], 1) },
    ]
    const rows = evaluateDimensions(
      [
        {
          id: 1,
          type: 'dist-point-point',
          name: 'Distance 1',
          refs: [1, 2],
          limit: { kind: 'band', nominal: 10, plus: 0.1, minus: 0.1 },
        },
        { id: 2, type: 'dist-point-point', name: 'Distance 2', refs: [1, 2] },
        {
          id: 3,
          type: 'dist-point-point',
          name: 'Distance 3',
          refs: [1, 99],
          limit: { kind: 'max', max: 1 },
        },
      ],
      elements,
    )
    expect(rows[0].verdict?.pass).toBe(true)
    expect(rows[0].verdict?.deviation).toBeCloseTo(0, 9)
    expect(rows[1].verdict).toBeUndefined()
    expect(rows[2].verdict).toBeUndefined()
  })
})

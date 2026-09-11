// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import {
  dimensionTypeInfo,
  evaluateDimension,
  evaluateDimensions,
  resolveDimensionType,
  assignDimensionRefs,
} from '../src/core/dimensions'
import { evaluateTolerance } from '../src/core/tolerances'
import type { CircleFit, CylinderFit, PlaneFit, SphereFit, Vec3 } from '../src/core/types'

const DEG = Math.PI / 180
const measured = { sigma: 0.002, usedPoints: 1234, regionSize: 1300 }

/** A fitted plane whose normal is tilted from +Z about Y by `tiltDeg` — its
 *  U axis lies in the tilt plane, so a tilt shows up along U. `flip` turns
 *  the normal to face the other way, as an opposing face does. */
function plane(
  center: Vec3,
  tiltDeg = 0,
  {
    extentU = 10,
    extentV = 10,
    flip = false,
    formError = 0.01,
    constructed = false,
  }: { extentU?: number; extentV?: number; flip?: boolean; formError?: number; constructed?: boolean } = {},
): PlaneFit {
  const t = tiltDeg * DEG
  const s = flip ? -1 : 1
  return {
    kind: 'plane',
    center,
    normal: [s * Math.sin(t), 0, s * Math.cos(t)],
    basisU: [Math.cos(t), 0, -Math.sin(t)],
    basisV: [0, 1, 0],
    extentU,
    extentV,
    ...(constructed ? { sigma: 0, usedPoints: 0, regionSize: 0 } : { ...measured, formError }),
  }
}

/** The scan points of a plane's patch on a half-millimetre grid, optionally
 *  with a cosine waviness of amplitude `wave` across V — five-millimetre
 *  period, so the grid samples its peaks and troughs exactly. */
function surfaceOf(p: PlaneFit, wave = 0): Float32Array {
  const out: number[] = []
  for (let s = -p.extentU; s <= p.extentU + 1e-9; s += 0.5) {
    for (let t = -p.extentV; t <= p.extentV + 1e-9; t += 0.5) {
      const w = wave * Math.cos((2 * Math.PI * t) / 5)
      for (let i = 0; i < 3; i++)
        out.push(p.center[i] + s * p.basisU[i] + t * p.basisV[i] + w * p.normal[i])
    }
  }
  return Float32Array.from(out)
}

function cylinder(
  center: Vec3,
  axis: Vec3,
  { length = 40, coverage = 360, formError = 0.02 as number | undefined } = {},
): CylinderFit {
  const n = Math.hypot(...axis)
  return {
    kind: 'cylinder',
    center,
    axis: [axis[0] / n, axis[1] / n, axis[2] / n],
    radius: 5,
    length,
    coverage,
    ...measured,
    formError,
  }
}

const sphere = (center: Vec3, formError: number | undefined = 0.005): SphereFit => ({
  kind: 'sphere',
  center,
  radius: 3,
  ...measured,
  formError,
})

const circle = (center: Vec3, formError?: number): CircleFit => ({
  kind: 'circle',
  center,
  normal: [0, 0, 1],
  radius: 4,
  sigma: 0.001,
  usedPoints: formError === undefined ? 0 : 5,
  regionSize: 0,
  formError,
})

/** A unit direction tilted from +Z about Y. */
const tiltedZ = (deg: number): Vec3 => [Math.sin(deg * DEG), 0, Math.cos(deg * DEG)]
/** A unit direction tilted from +X about Y, towards +Z. */
const tiltedX = (deg: number): Vec3 => [Math.cos(deg * DEG), 0, Math.sin(deg * DEG)]

describe('form', () => {
  it('reads the peak-to-peak form error the fit carries', () => {
    const r = evaluateTolerance('form-flatness', [plane([0, 0, 0], 0, { formError: 0.031 })])
    expect(r.label).toBe('Flatness')
    expect(r.raw).toBeCloseTo(0.031, 9)
    expect(r.value).toBe('0.031 mm')
    expect(r.anchor).toEqual([0, 0, 0])
    expect(r.detail).toMatch(/1,234 points/)
    expect(evaluateTolerance('form-cylindricity', [cylinder([0, 0, 0], [0, 0, 1])]).raw).toBeCloseTo(0.02, 9)
    expect(evaluateTolerance('form-sphericity', [sphere([1, 1, 1])]).raw).toBeCloseTo(0.005, 9)
    expect(evaluateTolerance('form-circularity', [circle([0, 0, 0], 0.004)]).raw).toBeCloseTo(0.004, 9)
  })

  it('has nothing to say about a constructed element, or the wrong kind', () => {
    expect(evaluateTolerance('form-flatness', [plane([0, 0, 0], 0, { constructed: true })]).invalid).toMatch(
      /constructed/,
    )
    expect(evaluateTolerance('form-circularity', [circle([0, 0, 0])]).invalid).toMatch(/constructed/)
    expect(evaluateTolerance('form-cylindricity', [plane([0, 0, 0])]).invalid).toMatch(/property of a cylinder/)
  })
})

describe('parallelism', () => {
  it('reads a plane off its surface: the tilt across the patch plus its own waviness', () => {
    const feature = plane([0, 0, 5], 0.5)
    const datum = plane([0, 0, 0])
    const r = evaluateTolerance('orient-parallelism', [feature, datum], {
      surfaces: [surfaceOf(feature, 0.02), null],
    })
    // Along the datum normal: ±10 mm of U at sin 0.5°, plus the ±0.02 wave.
    expect(r.raw).toBeCloseTo(20 * Math.sin(0.5 * DEG) + 2 * 0.02 * Math.cos(0.5 * DEG), 5)
    expect(r.detail).toBe('0.500° off parallel')
    expect(r.warning).toBeUndefined()
    expect(r.anchor).toEqual([0, 0, 5])
  })

  it('falls back to the drawn patch, and says so, when there is no surface', () => {
    const r = evaluateTolerance('orient-parallelism', [plane([0, 0, 5], 0.5), plane([0, 0, 0])])
    expect(r.raw).toBeCloseTo(20 * Math.sin(0.5 * DEG), 9)
    expect(r.warning).toMatch(/drawn patch/)
  })

  it('reads an opposing face the same as a facing one', () => {
    const facing = evaluateTolerance('orient-parallelism', [plane([0, 0, 5], 0.5), plane([0, 0, 0])])
    const opposing = evaluateTolerance('orient-parallelism', [
      plane([0, 0, 5], 0.5, { flip: true }),
      plane([0, 0, 0]),
    ])
    expect(opposing.raw).toBeCloseTo(facing.raw!, 9)
  })

  it('takes an axis by its ends: length times the sine of the tilt', () => {
    // Axis 0.3° off the datum plane.
    const toPlane = evaluateTolerance('orient-parallelism', [
      cylinder([0, 0, 8], tiltedX(0.3)),
      plane([0, 0, 0]),
    ])
    expect(toPlane.raw).toBeCloseTo(40 * Math.sin(0.3 * DEG), 9)
    expect(toPlane.detail).toBe('0.300° off parallel')
    // Axis 0.5° off the datum axis.
    const toAxis = evaluateTolerance('orient-parallelism', [
      cylinder([10, 0, 0], tiltedZ(0.5)),
      cylinder([0, 0, 0], [0, 0, 1]),
    ])
    expect(toAxis.raw).toBeCloseTo(40 * Math.sin(0.5 * DEG), 9)
  })

  it('reads a plane against a datum axis along the normal component across the axis', () => {
    // A face meant to run along the Z axis, its normal 0.4° out of the XY plane.
    const feature = plane([5, 0, 0], 90 - 0.4)
    const r = evaluateTolerance('orient-parallelism', [feature, cylinder([0, 0, 0], [0, 0, 1])], {
      surfaces: [surfaceOf(feature), null],
    })
    expect(r.raw).toBeCloseTo(20 * Math.sin(0.4 * DEG), 5)
  })

  it('warns about an axis resting on too little arc', () => {
    const r = evaluateTolerance('orient-parallelism', [
      cylinder([0, 0, 8], [1, 0, 0], { coverage: 60 }),
      plane([0, 0, 0]),
    ])
    expect(r.warning).toMatch(/60° of arc/)
  })
})

describe('perpendicularity', () => {
  it('reads a plane 0.2° off square across its patch', () => {
    const feature = plane([10, 0, 0], 89.8)
    const r = evaluateTolerance('orient-perpendicularity', [feature, plane([0, 0, 0])], {
      surfaces: [surfaceOf(feature), null],
    })
    expect(r.raw).toBeCloseTo(20 * Math.sin(0.2 * DEG), 5)
    expect(r.detail).toBe('0.200° off square')
  })

  it('reads an axis 0.25° off square to a plane, and 0.5° off square to an axis', () => {
    const toPlane = evaluateTolerance('orient-perpendicularity', [
      cylinder([0, 0, 20], tiltedZ(0.25)),
      plane([0, 0, 0]),
    ])
    expect(toPlane.raw).toBeCloseTo(40 * Math.sin(0.25 * DEG), 9)
    const toAxis = evaluateTolerance('orient-perpendicularity', [
      cylinder([0, 0, 0], tiltedX(0.5)),
      cylinder([0, 0, 0], [0, 0, 1]),
    ])
    expect(toAxis.raw).toBeCloseTo(40 * Math.sin(0.5 * DEG), 9)
  })

  it('reads a plane against a datum axis along the axis', () => {
    const feature = plane([0, 0, 20], 0.4)
    const r = evaluateTolerance('orient-perpendicularity', [feature, cylinder([0, 0, 0], [0, 0, 1])], {
      surfaces: [surfaceOf(feature), null],
    })
    expect(r.raw).toBeCloseTo(20 * Math.sin(0.4 * DEG), 5)
  })
})

describe('angularity', () => {
  it('needs the basic angle', () => {
    expect(evaluateTolerance('orient-angularity', [plane([0, 0, 0], 30), plane([0, 0, 0])]).invalid).toMatch(
      /basic angle/,
    )
  })

  it('reads zero on a plane at the basic angle, whichever way it leans', () => {
    const datum = plane([0, 0, 0])
    for (const tilt of [30, -30, 150]) {
      const feature = plane([0, 0, 0], tilt)
      const r = evaluateTolerance('orient-angularity', [feature, datum], {
        basic: 30,
        surfaces: [surfaceOf(feature), null],
      })
      // Zero to within the float32 the surface points are stored at.
      expect(r.raw).toBeLessThan(1e-5)
    }
  })

  it('reads the excess tilt across the patch, and names it', () => {
    const r = evaluateTolerance('orient-angularity', [plane([0, 0, 0], 30.5), plane([0, 0, 0])], {
      basic: 30,
    })
    expect(r.raw).toBeCloseTo(20 * Math.sin(0.5 * DEG), 9)
    expect(r.detail).toBe('0.500° off the basic 30.00°')
  })

  it('takes an axis at a basic angle to a plane', () => {
    const on = evaluateTolerance('orient-angularity', [cylinder([0, 0, 0], tiltedX(45)), plane([0, 0, 0])], {
      basic: 45,
    })
    expect(on.raw).toBeLessThan(1e-9)
    const off = evaluateTolerance('orient-angularity', [cylinder([0, 0, 0], tiltedX(46)), plane([0, 0, 0])], {
      basic: 45,
    })
    expect(off.raw).toBeCloseTo(40 * Math.sin(1 * DEG), 9)
  })
})

describe('coaxiality', () => {
  it('is twice the further end of a tilted, offset axis from the datum axis', () => {
    const r = evaluateTolerance('loc-coaxiality', [
      cylinder([0.01, 0, 0], tiltedZ(0.1)),
      cylinder([0, 0, 0], [0, 0, 1]),
    ])
    const farEnd = 0.01 + 20 * Math.sin(0.1 * DEG)
    expect(r.label).toBe('Coaxiality')
    expect(r.raw).toBeCloseTo(2 * farEnd, 9)
    expect(r.value).toBe(`Ø ${(2 * farEnd).toFixed(3)} mm`)
    // Pinned at the end that strays most: +Z end for a tilt towards +X.
    expect(r.anchor![2]).toBeCloseTo(20 * Math.cos(0.1 * DEG), 9)
    expect(r.warning).toBeUndefined()
  })

  it('is concentricity for a sphere: twice its centre offset', () => {
    const r = evaluateTolerance('loc-coaxiality', [sphere([0.03, 0.04, 5]), cylinder([0, 0, 0], [0, 0, 1])])
    expect(r.label).toBe('Concentricity')
    expect(r.raw).toBeCloseTo(0.1, 9)
    expect(r.detail).toMatch(/Centre 0.050 mm/)
  })

  it('warns when the feature reaches beyond the measured datum', () => {
    const r = evaluateTolerance('loc-coaxiality', [sphere([0, 0, 100]), cylinder([0, 0, 0], [0, 0, 1])])
    expect(r.warning).toMatch(/beyond the measured section/)
  })
})

describe('the registry', () => {
  it('lists the tolerances as their own family', () => {
    expect(dimensionTypeInfo('form-flatness').family).toBe('tolerance')
    expect(dimensionTypeInfo('orient-parallelism').slots.map((s) => s.label)).toEqual(['Feature', 'Datum'])
    expect(evaluateDimension('form-flatness', [plane([0, 0, 0], 0, { formError: 0.02 })]).raw).toBeCloseTo(0.02, 9)
  })

  it('never carries a click across families', () => {
    expect(resolveDimensionType('form-flatness', ['plane', 'plane'])).toBe('orient-parallelism')
    expect(resolveDimensionType('dist-point-point', ['plane', 'plane'])).toBe('dist-plane-plane')
    expect(resolveDimensionType('form-flatness', ['cylinder'])).toBe('form-cylindricity')
    expect(resolveDimensionType('orient-parallelism', ['cylinder'])).toBe('orient-parallelism')
    expect(resolveDimensionType('orient-parallelism', ['sphere'])).toBe('form-sphericity')
    expect(assignDimensionRefs('loc-coaxiality', [{ id: 3, kind: 'sphere' }, { id: 1, kind: 'cylinder' }])).toEqual([
      3, 1,
    ])
  })

  it('hands a plane feature its surface, and judges the value against its limit', () => {
    const feature = plane([0, 0, 5], 0.5)
    const elements = [
      { id: 1, name: 'Top', fit: feature },
      { id: 2, name: 'Base', fit: plane([0, 0, 0]) },
    ]
    const dims = [
      {
        id: 1,
        type: 'orient-parallelism',
        name: 'Parallelism 1',
        refs: [1, 2],
        limit: { kind: 'max' as const, max: 0.1 },
      },
    ]
    const asked: number[] = []
    const withSurface = evaluateDimensions(dims, elements, (id) => {
      asked.push(id)
      return id === 1 ? surfaceOf(feature, 0.02) : null
    })
    expect(asked).toEqual([1, 2])
    expect(withSurface[0].value.warning).toBeUndefined()
    expect(withSurface[0].verdict?.pass).toBe(false)
    expect(withSurface[0].verdict?.over).toBeCloseTo(
      20 * Math.sin(0.5 * DEG) + 2 * 0.02 * Math.cos(0.5 * DEG) - 0.1,
      5,
    )
    const without = evaluateDimensions(dims, elements)
    expect(without[0].value.warning).toMatch(/drawn patch/)
    expect(without[0].title).toBe('Top → Base')
  })
})

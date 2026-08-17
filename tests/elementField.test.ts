// SPDX-License-Identifier: AGPL-3.0-only
// Deviation of a scan from one fitted element. The three things that make it a
// measurement rather than a raw closest distance — the bound to the element as
// drawn, the material side, and the facing filter — are what is tested here,
// because each of them is a way the map can come out wrong while still looking
// plausible.
import { describe, expect, it } from 'vitest'
import {
  computeElementDeviation,
  DEFAULT_FACING_DEG,
  describeTarget,
  detectMaterialSide,
  isDeviationTarget,
} from '../src/core/deviation/elementField'
import { buildElementReport } from '../src/core/deviation/report'
import { deviationStats } from '../src/core/deviation/deviation'
import { applyExtension } from '../src/core/elements/extend'
import type { CylinderFit, PlaneFit, PointFit, SphereFit, Vec3 } from '../src/core/types'

const NO_RESIDUALS = { sigma: 0, usedPoints: 0, regionSize: 0 }
const FACING = { side: 1 as const, maxNormalDeviation: (DEFAULT_FACING_DEG * Math.PI) / 180 }
const ANY_FACING = { side: 1 as const, maxNormalDeviation: null }

/** A 20 × 20 mm patch of the z = 0 plane, facing +Z. */
function zPlane(halfSize = 10): PlaneFit {
  return {
    kind: 'plane',
    ...NO_RESIDUALS,
    center: [0, 0, 0],
    normal: [0, 0, 1],
    basisU: [1, 0, 0],
    basisV: [0, 1, 0],
    extentU: halfSize,
    extentV: halfSize,
  }
}

/** A cylinder of radius 5 and length 20 about the Z axis. */
function zCylinder(): CylinderFit {
  return {
    kind: 'cylinder',
    ...NO_RESIDUALS,
    center: [0, 0, 0],
    axis: [0, 0, 1],
    radius: 5,
    length: 20,
    coverage: 360,
  }
}

function ball(): SphereFit {
  return { kind: 'sphere', ...NO_RESIDUALS, center: [0, 0, 0], radius: 5 }
}

/** One vertex per point, each with the normal given — the shape of the buffers
 *  the viewport hands over. */
function scan(points: [Vec3, Vec3][]): { positions: Float32Array; normals: Float32Array } {
  const positions = new Float32Array(points.length * 3)
  const normals = new Float32Array(points.length * 3)
  points.forEach(([p, n], i) => {
    positions.set(p, i * 3)
    normals.set(n, i * 3)
  })
  return { positions, normals }
}

const UP: Vec3 = [0, 0, 1]
const DOWN: Vec3 = [0, 0, -1]

describe('which elements can be measured against', () => {
  it('takes the three kinds with a surface and refuses the two without', () => {
    expect(isDeviationTarget(zPlane())).toBe(true)
    expect(isDeviationTarget(zCylinder())).toBe(true)
    expect(isDeviationTarget(ball())).toBe(true)
    const point: PointFit = { kind: 'point', ...NO_RESIDUALS, center: [0, 0, 0] }
    // A distance to a point is unsigned, so there is no zero for a scale that
    // runs warm one way and cool the other.
    expect(isDeviationTarget(point)).toBe(false)
    expect(isDeviationTarget(undefined)).toBe(false)
  })
})

describe('deviation from a plane', () => {
  it('reads the signed height above the plane', () => {
    const { positions, normals } = scan([
      [[0, 0, 0.25], UP],
      [[3, -2, -0.5], UP],
      [[-7, 8, 0], UP],
    ])
    const v = computeElementDeviation(zPlane(), positions, normals, FACING)
    expect(v[0]).toBeCloseTo(0.25, 6)
    expect(v[1]).toBeCloseTo(-0.5, 6)
    expect(v[2]).toBeCloseTo(0, 6)
  })

  it('leaves everything outside the patch unmeasured', () => {
    // Dead level with the plane, but off the side of it — an infinite plane
    // would report a perfect zero here, which is exactly the lie to avoid.
    const { positions, normals } = scan([
      [[9.9, 0, 0.1], UP],
      [[10.1, 0, 0.1], UP],
      [[0, -40, 0.1], UP],
    ])
    const v = computeElementDeviation(zPlane(), positions, normals, FACING)
    expect(v[0]).toBeCloseTo(0.1, 6)
    expect(v[1]).toBeNaN()
    expect(v[2]).toBeNaN()
  })

  it('grows the measured region with the element as it is extended', () => {
    const fit = zPlane()
    const { positions, normals } = scan([[[14, 0, 0.2], UP]])
    expect(computeElementDeviation(fit, positions, normals, FACING)[0]).toBeNaN()
    // The grips are the region control: five millimetres onto each u edge takes
    // the patch out to ±15, and the point comes into the measurement.
    const wider = applyExtension(fit, { kind: 'plane', uMin: 5, uMax: 5, vMin: 0, vMax: 0 })
    expect(isDeviationTarget(wider)).toBe(true)
    if (!isDeviationTarget(wider)) return
    expect(computeElementDeviation(wider, positions, normals, FACING)[0]).toBeCloseTo(0.2, 6)
  })

  it('leaves the far side of a wall out, and takes it back when facing is off', () => {
    // A plane fitted on the top of a 10 mm plate. The underside lies inside the
    // footprint and faces the other way; reported, it would read as ten
    // millimetres of missing material.
    const { positions, normals } = scan([
      [[0, 0, 0.05], UP],
      [[0, 0, -10], DOWN],
    ])
    const filtered = computeElementDeviation(zPlane(), positions, normals, FACING)
    expect(filtered[0]).toBeCloseTo(0.05, 6)
    expect(filtered[1]).toBeNaN()

    const unfiltered = computeElementDeviation(zPlane(), positions, normals, ANY_FACING)
    expect(unfiltered[1]).toBeCloseTo(-10, 6)
  })

  it('turns the reading round with the material side', () => {
    // The same plate approached from underneath: the fit's normal points into
    // the material, so the raw height runs backwards and the side corrects it.
    const { positions, normals } = scan([[[0, 0, -0.3], DOWN]])
    const v = computeElementDeviation(zPlane(), positions, normals, {
      side: -1,
      maxNormalDeviation: (DEFAULT_FACING_DEG * Math.PI) / 180,
    })
    // 0.3 mm below a plane whose material is below it is 0.3 mm of extra
    // material, and extra material is always positive.
    expect(v[0]).toBeCloseTo(0.3, 6)
  })
})

describe('deviation from a cylinder', () => {
  it('reads the radial error and bounds it to the drawn length', () => {
    const out: Vec3 = [1, 0, 0]
    const { positions, normals } = scan([
      [[5.1, 0, 0], out],
      [[4.9, 0, 9], out],
      [[5.1, 0, 11], out],
    ])
    const v = computeElementDeviation(zCylinder(), positions, normals, FACING)
    expect(v[0]).toBeCloseTo(0.1, 5)
    expect(v[1]).toBeCloseTo(-0.1, 5)
    // Past the end of the tube as drawn.
    expect(v[2]).toBeNaN()
  })

  it('reads a bore the right way round', () => {
    // Inside a hole the material is outside the fitted radius, so a scan point
    // at a smaller radius is material intruding into the bore — too much of it.
    const inward: Vec3 = [-1, 0, 0]
    const { positions, normals } = scan([[[4.9, 0, 0], inward]])
    const v = computeElementDeviation(zCylinder(), positions, normals, {
      side: -1,
      maxNormalDeviation: (DEFAULT_FACING_DEG * Math.PI) / 180,
    })
    expect(v[0]).toBeCloseTo(0.1, 5)
  })

  it('leaves a point on the axis unmeasured', () => {
    const { positions, normals } = scan([[[0, 0, 0], [1, 0, 0]]])
    expect(computeElementDeviation(zCylinder(), positions, normals, ANY_FACING)[0]).toBeNaN()
  })
})

describe('deviation from a sphere', () => {
  it('reads the radial error everywhere, there being nothing to be outside of', () => {
    const { positions, normals } = scan([
      [[5.2, 0, 0], [1, 0, 0]],
      [[0, 0, -4.8], [0, 0, -1]],
    ])
    const v = computeElementDeviation(ball(), positions, normals, FACING)
    expect(v[0]).toBeCloseTo(0.2, 5)
    expect(v[1]).toBeCloseTo(-0.2, 5)
  })
})

describe('detecting which side the material is on', () => {
  it('reads a face from the scan normals around it', () => {
    const { positions, normals } = scan([
      [[0, 0, 0.02], UP],
      [[2, 1, -0.01], UP],
      [[-3, 4, 0.03], UP],
    ])
    expect(detectMaterialSide(zPlane(), positions, normals, 1)).toBe(1)
  })

  it('reads a plane fitted from inside the material as the other side', () => {
    const { positions, normals } = scan([
      [[0, 0, 0.02], DOWN],
      [[2, 1, -0.01], DOWN],
    ])
    expect(detectMaterialSide(zPlane(), positions, normals, 1)).toBe(-1)
  })

  it('reads a bore as the inner side', () => {
    // A hole scanned from within: every normal points back at the axis.
    const { positions, normals } = scan([
      [[5, 0, 0], [-1, 0, 0]],
      [[0, 5, 2], [0, -1, 0]],
      [[-5, 0, -2], [1, 0, 0]],
    ])
    expect(detectMaterialSide(zCylinder(), positions, normals, 1)).toBe(-1)
  })

  it('only judges by surface that is near the element and within it', () => {
    // The one facing point is far off the plane and the wrong-facing one is off
    // the side of the patch: neither may vote, so the element's own side stands.
    const { positions, normals } = scan([
      [[0, 0, 40], DOWN],
      [[80, 0, 0], DOWN],
    ])
    expect(detectMaterialSide(zPlane(), positions, normals, 1)).toBe(1)
  })

  it('falls back to the element’s own side with nothing to judge by', () => {
    expect(detectMaterialSide(zPlane(), new Float32Array(0), new Float32Array(0), 1)).toBe(1)
  })
})

describe('saying what the element is', () => {
  it('names the size that decides how much of the part is measured', () => {
    expect(describeTarget(zPlane())).toBe('plane, 20.0 × 20.0 mm as drawn')
    expect(describeTarget(zCylinder())).toBe('cylinder, ⌀10.000 mm × 20.0 mm as drawn')
    expect(describeTarget(ball())).toBe('sphere, ⌀10.000 mm')
  })
})

describe('the report', () => {
  it('says what the map means without an alignment to lean on', () => {
    const { positions, normals } = scan([
      [[0, 0, 0.1], UP],
      [[2, 2, -0.05], UP],
      [[-4, 1, 0.02], UP],
    ])
    const values = computeElementDeviation(zPlane(), positions, normals, FACING)
    const text = buildElementReport(
      'block.stl',
      'Plane 1',
      zPlane(),
      1,
      deviationStats(values, 3, 0.1),
      0.2,
      3,
      DEFAULT_FACING_DEG,
    )
    expect(text).toContain('Plane 1 — plane, 20.0 × 20.0 mm as drawn')
    // A reading is meaningless without the three things that bounded it.
    expect(text).toContain('the element as drawn')
    expect(text).toContain('max search distance  3 mm')
    expect(text).toContain('facing limit         60°')
    expect(text).toContain("the element's outward side")
    // …and without knowing there was no alignment in the way of it.
    expect(text).toContain('no alignment')
    expect(text).toContain('max             +0.1000 mm')
    expect(text).toContain('matched         3 of 3 scan points')
  })

  it('says so when the facing filter is off', () => {
    const text = buildElementReport(
      'block.stl',
      'Bore 2',
      zCylinder(),
      -1,
      deviationStats(new Float32Array([0.1, -0.1]), 3, 0.1),
      0.2,
      3,
      null,
    )
    expect(text).toContain('a bore or a shell')
    expect(text).toContain('any surface within the element counts')
  })
})

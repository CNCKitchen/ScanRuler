// SPDX-License-Identifier: AGPL-3.0-only
// Drawing an element past the surface it was measured on: the arithmetic of
// the four sides, and what the store does with them — an extension has to
// survive a re-fit, ride through an alignment and stay out of the measurement.
import { beforeEach, describe, expect, it } from 'vitest'
import {
  applyExtension,
  extendedSpans,
  isExtendable,
  isExtended,
  minSide,
  squareExtension,
  withSide,
  zeroExtension,
  type Extension,
} from '../src/core/elements/extend'
import { buildStepFile } from '../src/core/exportStep'
import { useStore } from '../src/state/store'
import type { CylinderFit, FitOutput, PlaneFit, SphereFit } from '../src/core/types'

const NO_STATS = { sigma: 0.002, usedPoints: 100, regionSize: 120 }

const cylinder: CylinderFit = {
  kind: 'cylinder',
  center: [0, 0, 10],
  axis: [0, 0, 1],
  radius: 4,
  length: 20,
  coverage: 360,
  ...NO_STATS,
}

const plane: PlaneFit = {
  kind: 'plane',
  center: [5, 5, 0],
  normal: [0, 0, 1],
  basisU: [1, 0, 0],
  basisV: [0, 1, 0],
  extentU: 7,
  extentV: 3,
  ...NO_STATS,
}

const sphere: SphereFit = { kind: 'sphere', center: [1, 2, 3], radius: 12.5, ...NO_STATS }

const cylExt = (start: number, end: number): Extension => ({ kind: 'cylinder', start, end })
const planeExt = (uMin: number, uMax: number, vMin: number, vMax: number): Extension => ({
  kind: 'plane',
  uMin,
  uMax,
  vMin,
  vMax,
})

describe('extending a cylinder', () => {
  it('grows each end along the axis and keeps the middle between them', () => {
    const out = applyExtension(cylinder, cylExt(5, 15)) as CylinderFit
    expect(out.length).toBeCloseTo(40, 12)
    // The far end moved 15 out and the near one 5 the other way: the middle
    // walks half of the difference along the axis.
    expect(out.center).toEqual([0, 0, 15])
    expect(out.radius).toBe(4)
    expect(out.axis).toEqual([0, 0, 1])
  })

  it('leaves the middle alone when both ends grow the same', () => {
    const out = applyExtension(cylinder, cylExt(3, 3)) as CylinderFit
    expect(out.length).toBeCloseTo(26, 12)
    expect(out.center).toEqual([0, 0, 10])
  })

  it('shrinks on a negative value', () => {
    const out = applyExtension(cylinder, cylExt(0, -4)) as CylinderFit
    expect(out.length).toBeCloseTo(16, 12)
    expect(out.center).toEqual([0, 0, 8])
  })

  it('carries the measurement through untouched', () => {
    const out = applyExtension(cylinder, cylExt(5, 5))
    expect(out.sigma).toBe(cylinder.sigma)
    expect(out.usedPoints).toBe(cylinder.usedPoints)
    expect((out as CylinderFit).coverage).toBe(360)
  })
})

describe('extending a plane', () => {
  it('grows one edge at a time, moving the patch with it', () => {
    const out = applyExtension(plane, planeExt(0, 10, 0, 0)) as PlaneFit
    expect(2 * out.extentU).toBeCloseTo(24, 12)
    expect(2 * out.extentV).toBeCloseTo(6, 12)
    expect(out.center).toEqual([10, 5, 0])
    expect(out.normal).toEqual([0, 0, 1])
  })

  it('stays put when opposite edges grow together', () => {
    const out = applyExtension(plane, planeExt(2, 2, 4, 4)) as PlaneFit
    expect(out.center).toEqual([5, 5, 0])
    expect(extendedSpans(plane, planeExt(2, 2, 4, 4))).toEqual([18, 14])
    expect(out.extentU).toBeCloseTo(9, 12)
    expect(out.extentV).toBeCloseTo(7, 12)
  })

  it('keeps the in-plane axes it was measured on', () => {
    const out = applyExtension(plane, planeExt(1, 2, 3, 4)) as PlaneFit
    expect(out.basisU).toEqual(plane.basisU)
    expect(out.basisV).toEqual(plane.basisV)
  })
})

describe('what may be extended', () => {
  it('is the cylinder and the plane, and nothing else', () => {
    expect(isExtendable(cylinder)).toBe(true)
    expect(isExtendable(plane)).toBe(true)
    expect(isExtendable(sphere)).toBe(false)
    expect(isExtendable(undefined)).toBe(false)
  })

  it('ignores an extension left over from another shape', () => {
    expect(applyExtension(cylinder, planeExt(5, 5, 5, 5))).toBe(cylinder)
    expect(applyExtension(sphere, cylExt(5, 5))).toBe(sphere)
  })

  it('knows when nothing has been extended', () => {
    expect(isExtended(zeroExtension(plane))).toBe(false)
    expect(isExtended(planeExt(0, 0, -0.5, 0))).toBe(true)
    expect(isExtended(undefined)).toBe(false)
  })
})

describe('the clamp on shrinking', () => {
  it('stops one side just short of taking the whole element away', () => {
    // 20 mm of cylinder, 6 already given back at the far end: 14 left to
    // give, less the sliver the clamp keeps back.
    expect(minSide(cylinder, cylExt(0, -6), 'start')).toBeCloseTo(-13.999, 6)
    const ext = withSide(cylinder, cylExt(0, -6), 'start', -100)
    expect((applyExtension(cylinder, ext) as CylinderFit).length).toBeGreaterThan(0)
    expect(extendedSpans(cylinder, ext)[0]).toBeCloseTo(0.001, 6)
  })

  it('measures each axis of a plane on its own', () => {
    // 14 mm across U, 6 across V.
    expect(minSide(plane, zeroExtension(plane), 'uMin')).toBeCloseTo(-13.999, 6)
    expect(minSide(plane, zeroExtension(plane), 'vMax')).toBeCloseTo(-5.999, 6)
    const ext = withSide(plane, zeroExtension(plane), 'vMax', -50)
    expect(extendedSpans(plane, ext)[1]).toBeCloseTo(0.001, 6)
    expect(extendedSpans(plane, ext)[0]).toBeCloseTo(14, 6)
  })

  it('lets a side that ran into the clamp come back out again', () => {
    let ext = withSide(plane, zeroExtension(plane), 'uMax', -50)
    ext = withSide(plane, ext, 'uMax', 6)
    expect(extendedSpans(plane, ext)[0]).toBeCloseTo(20, 6)
  })

  it('takes a value that is not a number as nothing at all', () => {
    expect(withSide(plane, zeroExtension(plane), 'uMax', NaN)).toEqual(zeroExtension(plane))
  })
})

describe('making a plane square', () => {
  it('grows the shorter axis out to the longer, evenly on both sides', () => {
    const ext = squareExtension(plane, undefined)
    expect(ext).toEqual(planeExt(0, 0, 4, 4))
    expect(extendedSpans(plane, ext)).toEqual([14, 14])
    const out = applyExtension(plane, ext) as PlaneFit
    expect(out.center).toEqual([5, 5, 0])
  })

  it('squares what is already there rather than starting over', () => {
    const ext = squareExtension(plane, planeExt(0, 6, 0, 0))
    expect(extendedSpans(plane, ext)).toEqual([20, 20])
    // The U edges keep what they were given; only V made up the difference.
    expect(ext).toEqual(planeExt(0, 6, 7, 7))
  })

  it('leaves a square patch alone', () => {
    const square = { ...plane, extentV: 7 }
    expect(squareExtension(square, undefined)).toEqual(zeroExtension(square))
  })

  it('never cuts the measured surface away', () => {
    const ext = squareExtension(plane, planeExt(0, 0, 20, 20)) as Extension & { uMin: number }
    expect(ext.uMin).toBeGreaterThan(0)
    expect(extendedSpans(plane, ext)).toEqual([46, 46])
  })
})

describe('an extension in the store', () => {
  const store = () => useStore.getState()
  const asOutput = (fit: CylinderFit): FitOutput => ({ ...fit, region: new Uint32Array([1, 2, 3]) })

  beforeEach(() => {
    store().beginLoad('test.stl')
    store().finishLoad(0, 0, 100, [0, 0, 0])
  })

  /** A fitted cylinder, the way a click on the scan makes one. */
  function fittedCylinder(): number {
    store().startDraft('cylinder')
    store().setDraftPicks([[1, 2, 3]])
    store().resolveDraft(asOutput(cylinder))
    const id = store().commitDraft()
    if (id === null) throw new Error('cylinder was not created')
    return id
  }

  it('is written back with the element and reaches the export', () => {
    store().startDraft('cylinder')
    store().setDraftPicks([[1, 2, 3]])
    store().resolveDraft(asOutput(cylinder))
    store().setDraftExtend('end', 10)
    const id = store().commitDraft()!
    const el = store().elements.find((e) => e.id === id)!

    expect(el.extend).toEqual(cylExt(0, 10))
    // The fit itself is untouched — that is the measurement.
    expect((el.fit as CylinderFit).length).toBe(20)

    const text = buildStepFile(
      [{ name: el.name, fit: applyExtension(el.fit!, el.extend) }],
      'scan.stl',
      '2026-08-16T12:00:00',
      'solids',
    )
    // 30 mm of cylinder now: the far rim moved out to z = 30, the near one
    // stayed where the fit put it.
    expect(text).toContain("CARTESIAN_POINT('',(0.,0.,0.))")
    expect(text).toContain("CARTESIAN_POINT('',(0.,0.,30.))")
  })

  it('survives a re-fit inside the draft', () => {
    store().startDraft('plane')
    store().setDraftPicks([[1, 2, 3]])
    store().resolveDraft({ ...plane, region: new Uint32Array([1]) })
    store().setDraftExtend('uMax', 8)
    // A change of outlier cut-off re-fits and resolves again; what the user
    // asked for stays asked for.
    store().resolveDraft({ ...plane, extentU: 7.5, region: new Uint32Array([1, 2]) })
    expect(store().draft!.extend).toEqual(planeExt(0, 8, 0, 0))
    expect(extendedSpans(store().draft!.fit as PlaneFit, store().draft!.extend)).toEqual([23, 6])
  })

  it('comes back when the element is re-opened, and can be reset', () => {
    store().startDraft('cylinder')
    store().setDraftPicks([[1, 2, 3]])
    store().resolveDraft(asOutput(cylinder))
    store().setDraftExtend('start', 4)
    const id = store().commitDraft()!

    store().editElement(id)
    expect(store().draft!.extend).toEqual(cylExt(4, 0))
    store().resetDraftExtend()
    store().commitDraft()
    // Back to nothing at all, not to an extension of nothing.
    expect(store().elements.find((e) => e.id === id)!.extend).toBeUndefined()
  })

  it('is a length, so an alignment leaves it exactly as it is', () => {
    store().startDraft('cylinder')
    store().setDraftPicks([[1, 2, 3]])
    store().resolveDraft(asOutput(cylinder))
    store().setDraftExtend('end', 6)
    const id = store().commitDraft()!

    store().applyAlignment({
      // A quarter turn about X, then a shift: the element moves, its size does
      // not.
      r: new Float64Array([1, 0, 0, 0, 0, -1, 0, 1, 0]),
      t: new Float64Array([10, 0, 0]),
    })
    const el = store().elements.find((e) => e.id === id)!
    expect(el.extend).toEqual(cylExt(0, 6))
    expect((el.fit as CylinderFit).length).toBe(20)
    expect(extendedSpans(el.fit as CylinderFit, el.extend)).toEqual([26])
  })

  it('is dropped when the draft ends up making something else', () => {
    const id = fittedCylinder()
    expect(store().elements.find((e) => e.id === id)!.extend).toBeUndefined()

    store().startDraft('plane')
    store().setDraftPicks([[1, 2, 3]])
    store().resolveDraft({ ...plane, region: new Uint32Array([1]) })
    store().setDraftExtend('uMax', 3)
    // A cylinder's extension can never be a plane's.
    expect(store().draft!.extend!.kind).toBe('plane')
  })
})

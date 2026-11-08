// SPDX-License-Identifier: AGPL-3.0-only
// The constructions of issues 45 and 46: centres, three planes, crossing
// lines (refused when skew), projection onto a plane, planes at an angle,
// through two lines, square to a plane through a line, tangent planes — and
// a construction unlinked from its sources.
import { describe, expect, it } from 'vitest'
import { creationMethod, evaluateConstruction } from '../src/core/elements/construct'
import type { CylinderFit, FitData, FitSettings, LineFit, PlaneFit, PointFit, SphereFit, TorusFit, Vec3 } from '../src/core/types'
import { freshDraft, unlinkedSource, type Element } from '../src/state/elementModel'

const stats = { sigma: 0, usedPoints: 0, regionSize: 0 }
const point = (center: Vec3): PointFit => ({ kind: 'point', center, ...stats })
const line = (center: Vec3, dir: Vec3, length = 20): LineFit => ({ kind: 'line', center, dir, length, ...stats })
const plane = (center: Vec3, normal: Vec3): PlaneFit => {
  const u: Vec3 = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  return { kind: 'plane', center, normal, basisU: u, basisV: u, extentU: 10, extentV: 10, ...stats }
}
const sphere = (center: Vec3, radius: number): SphereFit => ({ kind: 'sphere', center, radius, ...stats })
const cylinder = (center: Vec3, axis: Vec3, radius: number): CylinderFit => ({
  kind: 'cylinder', center, axis, radius, length: 30, coverage: 360, ...stats,
})
const SIZE = 100
const build = (method: string, refs: FitData[], params: number[] = []) => evaluateConstruction(method, refs, params, SIZE)
const close = (a: readonly number[], b: readonly number[], digits = 9) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits))
/** Signed distance from `p` to a plane. */
const off = (pl: PlaneFit, p: Vec3) => pl.normal.reduce((s, n, i) => s + n * (p[i] - pl.center[i]), 0)

describe('points', () => {
  it('takes the centre of a sphere, a circle or a torus', () => {
    const torus = { kind: 'torus', center: [1, 2, 3], axis: [0, 0, 1], majorRadius: 10, minorRadius: 2, ...stats } as unknown as TorusFit
    expect((build('point-center', [torus]) as PointFit).center).toEqual([1, 2, 3])
    expect((build('point-center', [sphere([4, 5, 6], 3)]) as PointFit).center).toEqual([4, 5, 6])
    expect(creationMethod('point', 'point-center').slots[0].kinds).toContain('torus')
  })

  it('finds the corner of three planes, and says why there is none', () => {
    const p = build('point-three-planes', [plane([5, 0, 0], [1, 0, 0]), plane([0, -3, 0], [0, 1, 0]), plane([0, 0, 7], [0, 0, 1])]) as PointFit
    close(p.center, [5, -3, 7])
    expect(() => build('point-three-planes', [plane([0, 0, 0], [1, 0, 0]), plane([2, 0, 0], [1, 0, 0]), plane([0, 0, 0], [0, 0, 1])])).toThrow(/Planes A and B are parallel/)
    // Three planes round the Z axis share it.
    const s = Math.SQRT1_2
    expect(() => build('point-three-planes', [plane([0, 0, 0], [1, 0, 0]), plane([0, 0, 0], [0, 1, 0]), plane([0, 0, 0], [s, s, 0])])).toThrow(/share a line/)
  })

  it('crosses two lines within the gap, and refuses skew ones', () => {
    const p = build('point-line-line', [line([0, 0, 0], [1, 0, 0]), line([3, 5, 0.02], [0, 1, 0])], [0.1]) as PointFit
    close(p.center, [3, 0, 0.01])
    // 0.5 apart, past a gap of 0.1: no intersection, and no stand-in for one.
    expect(() => build('point-line-line', [line([0, 0, 0], [1, 0, 0]), line([3, 5, 0.5], [0, 1, 0])], [0.1])).toThrow(/skew/)
    expect(() => build('point-line-line', [line([0, 0, 0], [1, 0, 0]), line([0, 1, 0], [1, 0, 0])], [0.1])).toThrow(/parallel/)
    // An axis is a line too.
    const q = build('point-line-line', [cylinder([0, 0, 0], [0, 0, 1], 4), line([-5, 0, 2], [1, 0, 0])], [0.1]) as PointFit
    close(q.center, [0, 0, 2])
  })

  it('projects a point onto a plane', () => {
    const p = build('point-project', [sphere([3, 4, 9], 2), plane([0, 0, 1], [0, 0, 1])]) as PointFit
    close(p.center, [3, 4, 1])
  })
})

describe('lines', () => {
  it('stands square to a plane through a point', () => {
    const l = build('line-plane-point', [plane([0, 0, 0], [0, 0, 1]), point([2, 3, 8])]) as LineFit
    close(l.dir, [0, 0, 1])
    close(l.center, [2, 3, 4])
  })

  it('projects a line onto a plane, and refuses one square to it', () => {
    const s = Math.SQRT1_2
    const l = build('line-project', [line([0, 0, 5], [s, 0, s]), plane([0, 0, 0], [0, 0, 1])]) as LineFit
    close(l.dir, [1, 0, 0])
    close(l.center, [0, 0, 0])
    expect(() => build('line-project', [line([1, 1, 5], [0, 0, 1]), plane([0, 0, 0], [0, 0, 1])])).toThrow(/projects to a single point/)
  })

  it('takes its coordinates back as given', () => {
    const l = build('line-coords', [], [0, 0, 2, 1, 2, 3, 40]) as LineFit
    expect(l.dir).toEqual([0, 0, 1])
    expect(l.center).toEqual([1, 2, 3])
    expect(l.length).toBe(40)
  })
})

describe('planes', () => {
  it('runs parallel to a plane through a point', () => {
    const p = build('plane-offset-point', [plane([0, 0, 0], [0, 0, 1]), point([5, 5, 12])]) as PlaneFit
    close(p.normal, [0, 0, 1])
    expect(off(p, [0, 0, 12])).toBeCloseTo(0, 9)
  })

  it('stands normal to a line through a point', () => {
    const p = build('plane-line-point', [line([0, 0, 0], [1, 0, 0]), point([7, 2, 3])]) as PlaneFit
    close(p.normal, [1, 0, 0])
    expect(off(p, [7, -5, 9])).toBeCloseTo(0, 9)
  })

  it('turns about an axis from its zero-angle plane', () => {
    // The X axis, lying in the XY plane: at 0° the XY plane itself, at 90°
    // the XZ plane.
    const xy = plane([0, 0, 0], [0, 0, 1])
    const x = line([0, 0, 0], [1, 0, 0])
    close((build('plane-angle', [x, xy], [0]) as PlaneFit).normal, [0, 0, 1])
    const at90 = build('plane-angle', [x, xy], [90]) as PlaneFit
    close(at90.normal.map(Math.abs), [0, 1, 0])
    const at30 = build('plane-angle', [x, xy], [30]) as PlaneFit
    // It contains the axis, and lies 30° off the zero plane.
    expect(off(at30, [9, 0, 0])).toBeCloseTo(0, 9)
    expect((Math.acos(Math.abs(at30.normal[2])) * 180) / Math.PI).toBeCloseTo(30, 9)
    // An axis piercing the zero plane square leaves 0° undefined.
    expect(() => build('plane-angle', [line([0, 0, 0], [0, 0, 1]), xy], [10])).toThrow(/square to the zero-angle plane/)
  })

  it('contains a line and stands square to a plane', () => {
    const p = build('plane-line-plane', [line([0, 0, 4], [1, 0, 0]), plane([0, 0, 0], [0, 0, 1])]) as PlaneFit
    close(p.normal.map(Math.abs), [0, 1, 0])
    expect(off(p, [3, 0, 4])).toBeCloseTo(0, 9)
    expect(() => build('plane-line-plane', [line([0, 0, 0], [0, 0, 1]), plane([0, 0, 0], [0, 0, 1])])).toThrow(/square to the plane/)
  })

  it('goes through two crossing or parallel lines, and refuses skew or coincident ones', () => {
    const crossing = build('plane-two-lines', [line([0, 0, 2], [1, 0, 0]), line([4, 0, 2], [0, 1, 0])], [0.1]) as PlaneFit
    close(crossing.normal.map(Math.abs), [0, 0, 1])
    expect(off(crossing, [9, 9, 2])).toBeCloseTo(0, 9)
    const parallel = build('plane-two-lines', [line([0, 0, 0], [1, 0, 0]), line([0, 0, 6], [1, 0, 0])]) as PlaneFit
    close(parallel.normal.map(Math.abs), [0, 1, 0])
    expect(() => build('plane-two-lines', [line([0, 0, 0], [1, 0, 0]), line([0, 0, 3], [0, 1, 0])], [0.1])).toThrow(/skew/)
    expect(() => build('plane-two-lines', [line([0, 0, 0], [1, 0, 0]), line([5, 0, 0], [1, 0, 0])])).toThrow(/are one/)
  })

  it('touches a sphere or a cylinder on the side facing a point', () => {
    const s = build('plane-tangent-sphere', [sphere([0, 0, 0], 5), point([0, 0, 20])]) as PlaneFit
    close(s.normal, [0, 0, 1])
    close(s.center, [0, 0, 5])
    const c = build('plane-tangent-cylinder', [cylinder([0, 0, 0], [0, 0, 1], 4), point([10, 0, 3])]) as PlaneFit
    close(c.normal, [1, 0, 0])
    expect(off(c, [4, 7, -9])).toBeCloseTo(0, 9)
    expect(() => build('plane-tangent-cylinder', [cylinder([0, 0, 0], [0, 0, 1], 4), point([0, 0, 3])])).toThrow(/axis/)
  })
})

describe('a construction unlinked from its sources', () => {
  const constructed = (method: string, fit: FitData, refs = [1, 2]): Element =>
    ({ id: 9, name: 'X', kind: fit.kind, fit, source: { type: 'constructed', method, refs, params: [] } }) as unknown as Element

  it('keeps its geometry as coordinates of its kind', () => {
    const l = line([1, 2, 3], [0, 1, 0], 12)
    expect(unlinkedSource(constructed('line-project', l))).toEqual({ type: 'constructed', method: 'line-coords', refs: [], params: [0, 1, 0, 1, 2, 3, 12] })
    const p = plane([0, 0, 4], [0, 0, 1])
    const frozen = unlinkedSource(constructed('plane-angle', p)) as { method: string; params: number[] }
    expect(frozen.method).toBe('plane-coords')
    const back = build('plane-coords', [], frozen.params) as PlaneFit
    close(back.normal, [0, 0, 1])
    close(back.center, [0, 0, 4])
  })

  it('has nothing to unlink from coordinates or with no sources', () => {
    expect(unlinkedSource(constructed('point-coords', point([1, 1, 1]), []))).toBeNull()
    expect(unlinkedSource(constructed('point-centroid', point([1, 1, 1]), []))).toBeNull()
  })

  it('starts a gap at its default', () => {
    const settings = {} as FitSettings
    expect(freshDraft('point', 'point-line-line', settings).params).toEqual([0.1])
    expect(freshDraft('plane', 'plane-angle', settings).params).toEqual([0])
  })
})

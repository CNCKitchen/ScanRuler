// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import {
  FLAT_DIMENSION_TYPES,
  evaluateFlatDimension,
  flatDimensionTypeInfo,
} from '../src/core/flat/dimensions'
import { fitCirclePoints, fitLinePoints, flatPoint } from '../src/core/flat/fit'
import { flatRoleOf } from '../src/core/flat/refs'

describe('the flat dimension table', () => {
  it('has unique ids and two slots everywhere', () => {
    const ids = FLAT_DIMENSION_TYPES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const t of FLAT_DIMENSION_TYPES) expect(t.slots.length).toBe(2)
  })

  it('refuses an unknown id', () => {
    expect(() => flatDimensionTypeInfo('flat-nonsense')).toThrow(/Unknown/)
  })

  it('reduces every kind to a role', () => {
    expect(flatRoleOf('point')).toBe('point')
    expect(flatRoleOf('circle')).toBe('point')
    expect(flatRoleOf('arc')).toBe('point')
    expect(flatRoleOf('line')).toBe('line')
  })
})

describe('point – point', () => {
  it('measures between a point and a circle center, with the deltas', () => {
    const c = fitCirclePoints([
      [13, 4],
      [10, 7],
      [7, 4],
    ])
    const v = evaluateFlatDimension('flat-dist-point-point', [flatPoint([1, 4]), c])
    expect(v.raw).toBeCloseTo(9, 9)
    expect(v.value).toBe('9.000 mm')
    expect(v.detail).toContain('ΔX +9.000')
    expect(v.detail).toContain('ΔY +0.000') // never "-0.000", however the floats land
    expect(v.segment).toBeDefined()
  })

  it('is invalid against a line', () => {
    const l = fitLinePoints([
      [0, 0],
      [1, 0],
    ])
    expect(evaluateFlatDimension('flat-dist-point-point', [flatPoint([0, 0]), l]).invalid).toBeDefined()
  })
})

describe('point – line', () => {
  it('drops the perpendicular', () => {
    const l = fitLinePoints([
      [0, 0],
      [10, 0],
    ])
    const v = evaluateFlatDimension('flat-dist-point-line', [flatPoint([5, 3]), l])
    expect(v.raw).toBeCloseTo(3, 9)
    expect(v.warning).toBeUndefined()
    expect(v.segment![1][0]).toBeCloseTo(5, 9)
    expect(v.segment![1][1]).toBeCloseTo(0, 9)
  })

  it('warns when the foot leaves the measured section', () => {
    const l = fitLinePoints([
      [0, 0],
      [10, 0],
    ])
    const v = evaluateFlatDimension('flat-dist-point-line', [flatPoint([30, 3]), l])
    expect(v.raw).toBeCloseTo(3, 9)
    expect(v.warning).toMatch(/beyond the measured section/)
  })
})

describe('line – line distance', () => {
  it('measures a slot width between parallel edges', () => {
    const a = fitLinePoints([
      [0, 0],
      [10, 0],
    ])
    const b = fitLinePoints([
      [0, 6.02],
      [10, 6.02],
    ])
    const v = evaluateFlatDimension('flat-dist-line-line', [a, b])
    expect(v.raw).toBeCloseTo(6.02, 9)
    expect(v.warning).toBeUndefined()
  })

  it('warns on a slight fold, and refuses a clear one', () => {
    const a = fitLinePoints([
      [0, 0],
      [10, 0],
    ])
    // 1° fold: within the reporting limit, past the warning limit.
    const slight = fitLinePoints([
      [0, 5],
      [10, 5 + Math.tan((1 * Math.PI) / 180) * 10],
    ])
    const warned = evaluateFlatDimension('flat-dist-line-line', [a, slight])
    expect(warned.value).toBeDefined()
    expect(warned.warning).toMatch(/off parallel/)
    // 10° fold: no meaningful single distance.
    const folded = fitLinePoints([
      [0, 5],
      [10, 5 + Math.tan((10 * Math.PI) / 180) * 10],
    ])
    const refused = evaluateFlatDimension('flat-dist-line-line', [a, folded])
    expect(refused.invalid).toMatch(/angle dimension/)
  })
})

describe('line – line angle', () => {
  it('reports the acute angle with its supplement, hinged at the crossing', () => {
    const a = fitLinePoints([
      [0, 0],
      [10, 0],
    ])
    const b = fitLinePoints([
      [5, -5],
      [10, 0.02],
    ])
    const v = evaluateFlatDimension('flat-angle-line-line', [a, b])
    expect(v.raw).toBeGreaterThan(44)
    expect(v.raw).toBeLessThan(46)
    expect(v.detail).toMatch(/Supplement/)
    expect(v.arc).toBeDefined()
    // The hinge sits where the lines cross — on line A (y = 0).
    expect(v.arc!.vertex[1]).toBeCloseTo(0, 6)
  })

  it('reads 90° for perpendicular edges', () => {
    const a = fitLinePoints([
      [0, 0],
      [10, 0],
    ])
    const b = fitLinePoints([
      [5, -5],
      [5, 5],
    ])
    const v = evaluateFlatDimension('flat-angle-line-line', [a, b])
    expect(v.raw).toBeCloseTo(90, 9)
  })
})

describe('unknown types', () => {
  it('come back invalid rather than throwing', () => {
    const v = evaluateFlatDimension('flat-nonsense', [flatPoint([0, 0]), flatPoint([1, 1])])
    expect(v.invalid).toMatch(/Unknown/)
  })
})

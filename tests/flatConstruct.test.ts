// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import {
  FLAT_METHODS,
  evaluateFlatConstruction,
  evaluateFlatPicks,
  flatMethod,
  flatMethodsForKind,
} from '../src/core/flat/construct'
import { fitCirclePoints, fitLinePoints, flatPoint } from '../src/core/flat/fit'

describe('the flat method table', () => {
  it('has unique ids and a method for every kind', () => {
    const ids = FLAT_METHODS.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const kind of ['point', 'line', 'circle', 'arc'] as const) {
      expect(flatMethodsForKind(kind).length).toBeGreaterThan(0)
    }
  })

  it('gives every pick method a minimum and every construction its slots', () => {
    for (const m of FLAT_METHODS) {
      if (m.mode === 'pick') expect(m.minPicks).toBeGreaterThan(0)
      else expect(m.slots!.length).toBeGreaterThan(0)
    }
  })

  it('refuses an unknown id', () => {
    expect(() => flatMethod('flat-nonsense')).toThrow(/Unknown/)
  })
})

describe('evaluateFlatPicks', () => {
  it('routes each pick method to its fit', () => {
    expect(evaluateFlatPicks('flat-point-pick', [[1, 2]]).kind).toBe('point')
    expect(
      evaluateFlatPicks('flat-line-pick', [
        [0, 0],
        [4, 0],
      ]).kind,
    ).toBe('line')
    expect(
      evaluateFlatPicks('flat-circle-pick', [
        [1, 0],
        [0, 1],
        [-1, 0],
      ]).kind,
    ).toBe('circle')
    expect(
      evaluateFlatPicks('flat-arc-pick', [
        [1, 0],
        [0, 1],
        [-1, 0],
      ]).kind,
    ).toBe('arc')
  })

  it('moves a picked point rather than adding to it', () => {
    const fit = evaluateFlatPicks('flat-point-pick', [
      [1, 1],
      [5, 6],
    ])
    if (fit.kind !== 'point') throw new Error('not a point')
    expect(fit.at).toEqual([5, 6])
  })
})

describe('flat constructions', () => {
  it('takes the midpoint of two points', () => {
    const fit = evaluateFlatConstruction('flat-point-midpoint', [
      flatPoint([0, 0]),
      flatPoint([4, 6]),
    ])
    if (fit.kind !== 'point') throw new Error('not a point')
    expect(fit.at).toEqual([2, 3])
  })

  it('takes the midpoint of two circle centers', () => {
    const c1 = fitCirclePoints([
      [1, 0],
      [0, 1],
      [-1, 0],
    ])
    const c2 = fitCirclePoints([
      [11, 0],
      [10, 1],
      [9, 0],
    ])
    const fit = evaluateFlatConstruction('flat-point-midpoint', [c1, c2])
    if (fit.kind !== 'point') throw new Error('not a point')
    expect(fit.at[0]).toBeCloseTo(5, 9)
    expect(fit.at[1]).toBeCloseTo(0, 9)
  })

  it('intersects two lines where they cross', () => {
    const a = fitLinePoints([
      [0, 0],
      [10, 0],
    ])
    const b = fitLinePoints([
      [3, -5],
      [3, 5],
    ])
    const fit = evaluateFlatConstruction('flat-point-intersect', [a, b])
    if (fit.kind !== 'point') throw new Error('not a point')
    expect(fit.at[0]).toBeCloseTo(3, 9)
    expect(fit.at[1]).toBeCloseTo(0, 9)
  })

  it('finds a corner beyond both measured segments', () => {
    // Two edges of a rounded corner: the fitted segments stop short of the
    // vertex, which is exactly why the construction exists.
    const a = fitLinePoints([
      [0, 0],
      [8, 0],
    ])
    const b = fitLinePoints([
      [10, 2],
      [10, 9],
    ])
    const fit = evaluateFlatConstruction('flat-point-intersect', [a, b])
    if (fit.kind !== 'point') throw new Error('not a point')
    expect(fit.at[0]).toBeCloseTo(10, 9)
    expect(fit.at[1]).toBeCloseTo(0, 9)
  })

  it('refuses to intersect parallel lines', () => {
    const a = fitLinePoints([
      [0, 0],
      [10, 0],
    ])
    const b = fitLinePoints([
      [0, 2],
      [10, 2],
    ])
    expect(() => evaluateFlatConstruction('flat-point-intersect', [a, b])).toThrow(/parallel/)
  })

  it('extracts a circle center as a point', () => {
    const c = fitCirclePoints([
      [7, 0],
      [5, 2],
      [3, 0],
    ])
    const fit = evaluateFlatConstruction('flat-point-center', [c])
    if (fit.kind !== 'point') throw new Error('not a point')
    expect(fit.at[0]).toBeCloseTo(5, 9)
    expect(fit.at[1]).toBeCloseTo(0, 9)
  })
})

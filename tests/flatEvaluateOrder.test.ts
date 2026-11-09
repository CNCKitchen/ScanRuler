// SPDX-License-Identifier: AGPL-3.0-only
// A 2D construction re-pointed at an element made after it: re-evaluated in
// id order, its source had no fit yet and it broke (issue 34).
import { describe, expect, it } from 'vitest'
import { evaluateFlatElements, type FlatElement } from '../src/core/flat/elements'

const point = (id: number, at: [number, number]): FlatElement =>
  ({ id, name: `P${id}`, visible: true, source: { type: 'picks', method: 'flat-point-pick', picks: [at] }, fit: null, error: null }) as unknown as FlatElement
const midpoint = (id: number, refs: number[]): FlatElement =>
  ({ id, name: `M${id}`, visible: true, source: { type: 'construct', method: 'flat-point-midpoint', refs }, fit: null, error: null }) as unknown as FlatElement

describe('evaluateFlatElements', () => {
  it('evaluates a construction after its sources, whatever their ids', () => {
    // The midpoint (1) is built from a point made after it (3).
    const out = evaluateFlatElements([midpoint(1, [2, 3]), point(2, [0, 0]), point(3, [10, 4])], null)
    expect(out.map((e) => e.id)).toEqual([1, 2, 3])
    expect(out[0].error).toBeNull()
    expect(out[0].fit).toMatchObject({ kind: 'point', at: [5, 2] })
  })

  it('reads a loop of references as unavailable rather than recursing', () => {
    const out = evaluateFlatElements([midpoint(1, [2, 3]), midpoint(2, [1, 3]), point(3, [0, 0])], null)
    expect(out[0].error ?? out[1].error).toMatch(/unavailable/)
  })
})

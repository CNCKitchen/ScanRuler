// SPDX-License-Identifier: AGPL-3.0-only
// The part's coordinate planes as a sketch sees them (core/re/datums.ts):
// the line each cuts the sheet in, a dimension from a point to it, and the
// solver holding that dimension while the point is otherwise free.

import { describe, expect, it } from 'vitest'
import { datumTraces, traceFoot, traceOffset, traceOf } from '../core/datums'
import { dimensionFor, dimPickAt } from '../core/draw'
import { addConstraint, addEntity, constraintEntities, emptySketch, entityOf, type SketchLine } from '../core/sketch'
import { measureDimension, solveSketch } from '../core/solver'
import type { SectionFrame } from '../../../src/core/section/frame'

/** A sketch on the XY plane whose sheet zero lies under the part's centre,
 *  30 along X and −20 along Y from the origin — what a coordinate plane
 *  "through the centre" gives. */
const OFF_CENTRE: SectionFrame = { origin: [30, -20, 5], normal: [0, 0, 1], basisU: [1, 0, 0], basisV: [0, 1, 0] }

describe('the traces of the coordinate planes', () => {
  it('are the two planes the sketch crosses, where the origin is — not where the sheet’s zero is', () => {
    const traces = datumTraces(OFF_CENTRE)
    expect(traces.map((t) => t.plane)).toEqual(['yz', 'zx'])
    const yz = traceOf(traces, 'yz')!
    // The YZ plane is x = 0: in the sheet, u = −30.
    expect(traceOffset(yz, [-30, 7])).toBeCloseTo(0, 12)
    expect(Math.abs(traceOffset(yz, [0, 0]))).toBeCloseTo(30, 12)
    const zx = traceOf(traces, 'zx')!
    expect(traceOffset(zx, [4, 20])).toBeCloseTo(0, 12)
    expect(traceFoot(zx, [4, 0])).toEqual([4, 20])
  })

  it('has all three on a plane that leans, and none of a plane it lies parallel to', () => {
    const s = Math.SQRT1_2
    const leaning: SectionFrame = { origin: [0, 0, 0], normal: [s, s, 0], basisU: [-s, s, 0], basisV: [0, 0, 1] }
    expect(datumTraces(leaning).map((t) => t.plane)).toEqual(['xy', 'yz', 'zx'])
    const onYZ: SectionFrame = { origin: [12, 0, 0], normal: [1, 0, 0], basisU: [0, 1, 0], basisV: [0, 0, 1] }
    expect(datumTraces(onYZ).map((t) => t.plane)).toEqual(['xy', 'zx'])
  })
})

describe('a dimension to a coordinate plane', () => {
  const traces = datumTraces(OFF_CENTRE)

  it('is picked on the plane’s line, after the pieces, and measured from the point to it', () => {
    const sketch = emptySketch()
    const line = addEntity(sketch, { kind: 'line', a: [0, 0], b: [10, 0] })
    // On the line: the piece. Off it, on u = −30: the plane.
    expect(dimPickAt(sketch, [3, 0.1], 0.5, traces)).toEqual({ kind: 'piece', id: line })
    expect(dimPickAt(sketch, [-30.2, 9], 0.5, traces)).toEqual({ kind: 'datum', plane: 'yz' })
    expect(dimPickAt(sketch, [-25, 9], 0.5, traces)).toBeNull()
    const dim = dimensionFor(sketch, { kind: 'point', anchor: { entity: line, at: 'b' } }, { kind: 'datum', plane: 'yz' }, traces)
    expect(dim).toMatchObject({ kind: 'distance', p: { entity: line, at: 'b' }, q: { datum: 'yz' }, value: 40 })
    // The other way round is the same dimension; a plane alone is none.
    expect(dimensionFor(sketch, { kind: 'datum', plane: 'yz' }, { kind: 'point', anchor: { entity: line, at: 'b' } }, traces)).toEqual(dim)
    expect(dimensionFor(sketch, { kind: 'datum', plane: 'yz' }, null, traces)).toBeNull()
  })

  it('takes a line that runs along the plane, and refuses one that crosses it', () => {
    const sketch = emptySketch()
    const along = addEntity(sketch, { kind: 'line', a: [2, 0], b: [2, 10] })
    const across = addEntity(sketch, { kind: 'line', a: [0, 0], b: [10, 3] })
    expect(dimensionFor(sketch, { kind: 'piece', id: along }, { kind: 'datum', plane: 'yz' }, traces)).toMatchObject({ q: { datum: 'yz' }, value: 32 })
    expect(dimensionFor(sketch, { kind: 'piece', id: across }, { kind: 'datum', plane: 'yz' }, traces)).toBeNull()
  })

  it('is held by the solver, and names only its point as what it stands on', () => {
    const sketch = emptySketch()
    const line = addEntity(sketch, { kind: 'line', a: [0, 0], b: [10, 0] })
    const id = addConstraint(sketch, { kind: 'distance', p: { entity: line, at: 'a' }, q: { datum: 'yz' }, value: 25 })
    addConstraint(sketch, { kind: 'length', entity: line, value: 10 })
    addConstraint(sketch, { kind: 'horizontal', entity: line })
    expect(constraintEntities(sketch.constraints.find((c) => c.id === id)!)).toEqual([line])
    const report = solveSketch(sketch, { datums: traces })
    expect(report.ok).toBe(true)
    const l = entityOf(sketch, line) as SketchLine
    // 25 from x = 0 on the side it was on: u = −30 + 25.
    expect(l.a[0]).toBeCloseTo(-5, 6)
    expect(l.b[0]).toBeCloseTo(5, 6)
    expect(measureDimension(sketch, 'distance', { entity: line, at: 'a' }, { datum: 'yz' }, traces)).toBeCloseTo(25, 6)
    // With no traces given the dimension holds nothing and breaks nothing.
    expect(solveSketch(sketch).ok).toBe(true)
  })
})

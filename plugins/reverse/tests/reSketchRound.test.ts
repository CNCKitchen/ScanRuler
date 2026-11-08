// SPDX-License-Identifier: AGPL-3.0-only
// The sketch round from the public tracker (issues 102, 103, 106, 107):
// distances along X or Y between two points, a line's middle and a round
// piece's quadrants as points for relations and dimensions, and Trim.

import { describe, expect, it } from 'vitest'
import { dimShape, dimStrokes, distanceAxisAt, type Dimension } from '../core/dimLayout'
import { coincidentFor, dimensionFor, dimPickAt, relPickAt } from '../core/draw'
import { addConstraint, addEntity, anchorPoint, emptySketch, entityOf, pickPointsOf, type SketchArc, type SketchLine } from '../core/sketch'
import { snapSketchPoint, trackingSnap } from '../core/snap'
import { useReverse } from '../state/reStore'
import { XY } from './reKit'
import { measureDimension, solveSketch } from '../core/solver'
import { crossingsOf, trimAt, trimPlan } from '../core/trim'

const close = (a: readonly number[], b: readonly number[], digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits))

describe('distances along X or Y (issue 106)', () => {
  it('holds two circles’ centres a ΔX and a ΔY apart, whatever the other way does', () => {
    const sketch = emptySketch()
    const a = addEntity(sketch, { kind: 'circle', c: [0, 0], r: 1.5, fixed: true })
    const b = addEntity(sketch, { kind: 'circle', c: [30, 12], r: 1.5 })
    addConstraint(sketch, { kind: 'distance', p: { entity: a, at: 'center' }, q: { entity: b, at: 'center' }, value: 40, axis: 'x' })
    addConstraint(sketch, { kind: 'distance', p: { entity: a, at: 'center' }, q: { entity: b, at: 'center' }, value: 20, axis: 'y' })
    const report = solveSketch(sketch)
    expect(report.ok).toBe(true)
    const c = (entityOf(sketch, b) as { c: [number, number] }).c
    expect(Math.abs(c[0])).toBeCloseTo(40, 6)
    expect(Math.abs(c[1])).toBeCloseTo(20, 6)
  })

  it('measures along an axis, and straight across without one', () => {
    const sketch = emptySketch()
    const p = addEntity(sketch, { kind: 'point', p: [1, 2] })
    const q = addEntity(sketch, { kind: 'point', p: [7, -6] })
    const pa = { entity: p, at: 'center' as const }
    const qa = { entity: q, at: 'center' as const }
    expect(measureDimension(sketch, 'distance', pa, qa)).toBeCloseTo(10)
    expect(measureDimension(sketch, 'distance', pa, qa, undefined, 'x')).toBeCloseTo(6)
    expect(measureDimension(sketch, 'distance', pa, qa, undefined, 'y')).toBeCloseTo(8)
  })

  it('reads the axis from where the number is pulled: above or below for ΔX, beside for ΔY, elsewhere straight', () => {
    const p: [number, number] = [0, 0]
    const q: [number, number] = [10, 6]
    expect(distanceAxisAt(p, q, [5, 12])).toBe('x')
    expect(distanceAxisAt(p, q, [5, -4])).toBe('x')
    expect(distanceAxisAt(p, q, [-3, 3])).toBe('y')
    expect(distanceAxisAt(p, q, [14, 3])).toBe('y')
    expect(distanceAxisAt(p, q, [5, 3])).toBeUndefined()
    expect(distanceAxisAt(p, q, [14, 12])).toBeUndefined()
    // Two points level have no ΔY to pull to.
    expect(distanceAxisAt([0, 0], [10, 0], [-4, 0])).toBeUndefined()
  })

  it('draws a ΔX level, its second extension line running from the point that lies off the first one’s level', () => {
    const sketch = emptySketch()
    const p = addEntity(sketch, { kind: 'point', p: [0, 0] })
    const q = addEntity(sketch, { kind: 'point', p: [10, 6] })
    const id = addConstraint(sketch, { kind: 'distance', p: { entity: p, at: 'center' }, q: { entity: q, at: 'center' }, value: 10, axis: 'x', place: { off: 9, along: 0 } })
    const shape = dimShape(sketch.constraints.find((c) => c.id === id) as Dimension, sketch, [], 1)
    expect(shape?.kind).toBe('linear')
    if (!shape || shape.kind !== 'linear') return
    close(shape.d, [1, 0])
    close(shape.q, [10, 0])
    expect(shape.lift).toEqual([0, 6])
    const strokes = dimStrokes(shape, 0.01, 20)
    // Two extension lines, the first from the origin up, the second from
    // (10, 6) up — both ending past the dimension line at y = 9.
    const ext = strokes.lines.filter((l) => Math.abs(l[0][0] - l[1][0]) < 1e-9)
    expect(ext).toHaveLength(2)
    expect(Math.min(...ext.map((l) => l[0][1]))).toBeCloseTo(0.03, 6)
    expect(ext.find((l) => Math.abs(l[0][0] - 10) < 1e-9)![0][1]).toBeGreaterThan(6)
  })
})

describe('middles and quadrants as points (issue 103)', () => {
  it('offers a line’s middle, an arc’s centre and the quadrants its sweep reaches, a circle’s four', () => {
    const sketch = emptySketch()
    const l = addEntity(sketch, { kind: 'line', a: [0, 0], b: [10, 0] })
    const c = addEntity(sketch, { kind: 'circle', c: [20, 0], r: 5 })
    // A quarter from 45° to 135°: q1 (90°) only.
    const a = addEntity(sketch, { kind: 'arc', c: [0, 20], r: 4, start: Math.PI / 4, sweep: Math.PI / 2 })
    expect(pickPointsOf(entityOf(sketch, l)!)).toEqual(['center'])
    expect(pickPointsOf(entityOf(sketch, c)!)).toEqual(['q0', 'q1', 'q2', 'q3'])
    expect(pickPointsOf(entityOf(sketch, a)!)).toEqual(['center', 'q1'])
    close(anchorPoint(entityOf(sketch, c)!, 'q1'), [20, 5])
    close(anchorPoint(entityOf(sketch, c)!, 'q2'), [15, 0])
    close(anchorPoint(entityOf(sketch, a)!, 'q1'), [0, 24])
  })

  it('picks a middle or a quadrant close to it, and the piece a little further off', () => {
    const sketch = emptySketch()
    const l = addEntity(sketch, { kind: 'line', a: [0, 0], b: [10, 0] })
    const c = addEntity(sketch, { kind: 'circle', c: [30, 3], r: 5 })
    const p = addEntity(sketch, { kind: 'point', p: [5, 9] })
    const middle = dimPickAt(sketch, [5.1, 0.1], 1)!
    const top = relPickAt(sketch, [30.1, 8.1], 1)!
    expect(middle).toEqual({ kind: 'point', anchor: { entity: l, at: 'center' }, of: l })
    expect(dimPickAt(sketch, [6, 0], 1)).toEqual({ kind: 'piece', id: l })
    expect(top).toEqual({ kind: 'point', anchor: { entity: c, at: 'q1' }, of: c })
    const point = { kind: 'point', anchor: { entity: p, at: 'center' } } as const
    // Beside a point of the sketch's own, the middle and the quadrant are
    // points: the distance to them, a coincidence there.
    expect(dimensionFor(sketch, point, middle)).toMatchObject({ kind: 'distance', q: { entity: l, at: 'center' }, value: 9 })
    expect(dimensionFor(sketch, top, point)).toMatchObject({ kind: 'distance', p: { entity: c, at: 'q1' } })
    expect(coincidentFor(sketch, point, middle)).toMatchObject({ kind: 'coincident', q: { entity: l, at: 'center' } })
    // Alone, or beside a piece or another middle, they stand for their piece:
    // a line's length, a circle's diameter, the distance between the two.
    expect(dimensionFor(sketch, middle, null)).toMatchObject({ kind: 'length', entity: l })
    expect(dimensionFor(sketch, top, null)).toMatchObject({ kind: 'diameter', entity: c })
    expect(dimensionFor(sketch, middle, top)).toMatchObject({ kind: 'distance', p: { entity: c, at: 'center' }, q: { line: l }, value: 3 })
  })

  it('holds a drawn end on a quadrant it snapped to, where the circle moves', () => {
    const sketch = emptySketch()
    const c = addEntity(sketch, { kind: 'circle', c: [0, 0], r: 5 })
    const snap = snapSketchPoint(sketch, [0.1, 5.05], 1)
    expect(snap.kind).toBe('quadrant')
    expect(snap.anchor).toEqual({ entity: c, at: 'q1' })
    const l = addEntity(sketch, { kind: 'line', a: [0, 5], b: [10, 12] })
    addConstraint(sketch, { kind: 'coincident', p: { entity: l, at: 'a' }, q: snap.anchor! })
    addConstraint(sketch, { kind: 'radius', entity: c, value: 8 })
    expect(solveSketch(sketch).ok).toBe(true)
    close((entityOf(sketch, l) as SketchLine).a, [...anchorPoint(entityOf(sketch, c)!, 'q1')], 5)
    expect((entityOf(sketch, l) as SketchLine).a[1] - (entityOf(sketch, c) as { c: number[] }).c[1]).toBeCloseTo(8, 5)
  })
})

describe('trim (issue 102)', () => {
  /** A plus sign: a level line from −10 to 10 crossed at −5 and 5 by two
   *  upright ones. */
  const plus = () => {
    const sketch = emptySketch()
    const h = addEntity(sketch, { kind: 'line', a: [-10, 0], b: [10, 0] })
    const v1 = addEntity(sketch, { kind: 'line', a: [-5, -5], b: [-5, 5] })
    const v2 = addEntity(sketch, { kind: 'line', a: [5, -5], b: [5, 5] })
    return { sketch, h, v1, v2 }
  }

  it('finds the crossings along a piece, its own ends left out', () => {
    const { sketch, h } = plus()
    const cuts = crossingsOf(sketch, entityOf(sketch, h) as SketchLine)
    expect(cuts.map((c) => c.p[0])).toEqual([-5, 5])
  })

  it('takes a middle stretch out and leaves two pieces in line, each end held on its cutter', () => {
    const { sketch, h, v1, v2 } = plus()
    addConstraint(sketch, { kind: 'horizontal', entity: h })
    const len = addConstraint(sketch, { kind: 'length', entity: h, value: 20 })
    const done = trimAt(sketch, h, [0, 0.1])
    expect(typeof done).not.toBe('string')
    if (typeof done === 'string') return
    expect(done.done).toBe('split')
    expect(done.dropped).toContain(len)
    const first = entityOf(sketch, h) as SketchLine
    const second = entityOf(sketch, done.made!) as SketchLine
    close(first.a, [-10, 0])
    close(first.b, [-5, 0])
    close(second.a, [5, 0])
    close(second.b, [10, 0])
    expect(sketch.constraints).toContainEqual(expect.objectContaining({ kind: 'pointOn', p: { entity: h, at: 'b' }, on: { line: v1 } }))
    expect(sketch.constraints).toContainEqual(expect.objectContaining({ kind: 'pointOn', p: { entity: done.made, at: 'a' }, on: { line: v2 } }))
    expect(sketch.constraints).toContainEqual(expect.objectContaining({ kind: 'collinear', line: done.made, on: { line: h } }))
    const report = solveSketch(sketch)
    expect(report.ok).toBe(true)
    close((entityOf(sketch, h) as SketchLine).b, [-5, 0], 5)
  })

  it('shortens a piece trimmed at its end, its far end’s relations gone and the near end’s kept', () => {
    const { sketch, h, v2 } = plus()
    const other = addEntity(sketch, { kind: 'line', a: [10, 0], b: [10, 8] })
    addConstraint(sketch, { kind: 'coincident', p: { entity: h, at: 'b' }, q: { entity: other, at: 'a' } })
    const keep = addEntity(sketch, { kind: 'line', a: [-10, 0], b: [-10, -8] })
    const kept = addConstraint(sketch, { kind: 'coincident', p: { entity: h, at: 'a' }, q: { entity: keep, at: 'a' } })
    const done = trimAt(sketch, h, [8, 0])
    if (typeof done === 'string') throw new Error(done)
    expect(done.done).toBe('end')
    close((entityOf(sketch, h) as SketchLine).b, [5, 0])
    expect(sketch.constraints.some((c) => c.kind === 'coincident' && c.q.entity === other)).toBe(false)
    expect(sketch.constraints.some((c) => c.id === kept)).toBe(true)
    expect(sketch.constraints).toContainEqual(expect.objectContaining({ kind: 'pointOn', p: { entity: h, at: 'b' }, on: { line: v2 } }))
  })

  it('takes a piece nothing crosses away whole', () => {
    const sketch = emptySketch()
    const l = addEntity(sketch, { kind: 'line', a: [0, 0], b: [10, 0] })
    addEntity(sketch, { kind: 'line', a: [0, 5], b: [10, 5] })
    addConstraint(sketch, { kind: 'horizontal', entity: l })
    const done = trimAt(sketch, l, [5, 0])
    if (typeof done === 'string') throw new Error(done)
    expect(done.done).toBe('removed')
    expect(entityOf(sketch, l)).toBeUndefined()
    expect(sketch.constraints).toHaveLength(0)
  })

  it('opens a circle crossed twice into the arc that is left, held where the cutter crossed', () => {
    const sketch = emptySketch()
    const c = addEntity(sketch, { kind: 'circle', c: [0, 0], r: 5 })
    const l = addEntity(sketch, { kind: 'line', a: [-10, 3], b: [10, 3] })
    // Clicked on the cap above the line: what is left is the larger arc below.
    const plan = trimPlan(sketch, c, [0, 5])
    if (typeof plan === 'string') throw new Error(plan)
    expect(plan.whole).toBe(false)
    const done = trimAt(sketch, c, [0, 5])
    if (typeof done === 'string') throw new Error(done)
    expect(done.done).toBe('opened')
    const arc = entityOf(sketch, c) as SketchArc
    expect(arc.kind).toBe('arc')
    // Counter-clockwise from the left crossing round the bottom to the right.
    close(anchorPoint(arc, 'a'), [-4, 3])
    close(anchorPoint(arc, 'b'), [4, 3])
    expect(arc.sweep).toBeGreaterThan(Math.PI)
    expect(sketch.constraints.filter((x) => x.kind === 'pointOn' && 'line' in x.on && x.on.line === l)).toHaveLength(2)
    expect(solveSketch(sketch).ok).toBe(true)
  })

  it('splits an arc, the far part held on its circle', () => {
    const sketch = emptySketch()
    const a = addEntity(sketch, { kind: 'arc', c: [0, 0], r: 5, start: 0, sweep: Math.PI })
    addEntity(sketch, { kind: 'line', a: [-2, -1], b: [-2, 10] })
    addEntity(sketch, { kind: 'line', a: [2, -1], b: [2, 10] })
    const done = trimAt(sketch, a, [0, 5])
    if (typeof done === 'string') throw new Error(done)
    expect(done.done).toBe('split')
    const kinds = sketch.constraints.filter((x) => x.kind === 'concentric' || x.kind === 'equal').map((x) => x.kind)
    expect(kinds.sort()).toEqual(['concentric', 'equal'])
    close(anchorPoint(entityOf(sketch, a)!, 'b'), [2, Math.sqrt(21)])
    close(anchorPoint(entityOf(sketch, done.made!)!, 'a'), [-2, Math.sqrt(21)])
    expect(solveSketch(sketch).ok).toBe(true)
  })

  it('holds a cut end coincident with the cutter’s end where it was cut at one', () => {
    const sketch = emptySketch()
    const h = addEntity(sketch, { kind: 'line', a: [0, 0], b: [10, 0] })
    // A T: the upright's foot on the level line.
    const t = addEntity(sketch, { kind: 'line', a: [4, 0], b: [4, 6] })
    const done = trimAt(sketch, h, [8, 0])
    if (typeof done === 'string') throw new Error(done)
    expect(sketch.constraints).toContainEqual(expect.objectContaining({ kind: 'coincident', p: { entity: h, at: 'b' }, q: { entity: t, at: 'a' } }))
  })

  it('refuses a spline and a projected piece', () => {
    const sketch = emptySketch()
    const s = addEntity(sketch, { kind: 'spline', pts: [[0, 0], [5, 3], [10, 0]] })
    const p = addEntity(sketch, { kind: 'line', a: [0, 0], b: [10, 0], projected: true, fixed: true })
    expect(typeof trimAt(sketch, s, [5, 3])).toBe('string')
    expect(typeof trimAt(sketch, p, [5, 0])).toBe('string')
  })
})

describe('tracking lines (issue 107)', () => {
  it('runs a line along X and Y from each tracked point, and takes where two cross', () => {
    const centre: [number, number] = [0, 0]
    const end: [number, number] = [20, 15]
    // Level with the centre, far along X: on its horizontal line.
    const level = trackingSnap([centre], [12, 0.3], 1)
    expect(level?.point).toEqual([12, 0])
    expect(level?.guides).toEqual([{ from: centre, to: [12, 0] }])
    // Under the end and level with the centre: where the two cross.
    const both = trackingSnap([end, centre], [19.6, 0.4], 1)
    expect(both?.point).toEqual([20, 0])
    expect(both?.guides).toHaveLength(2)
    // Near nothing: none; on the tracked point itself: none either.
    expect(trackingSnap([centre], [8, 8], 1)).toBeNull()
    expect(trackingSnap([centre], [0.2, 0.2], 1)).toBeNull()
  })

  it('places a drawn end level with a centre the hand passed over, a place only', () => {
    const sketch = emptySketch()
    addEntity(sketch, { kind: 'circle', c: [0, 0], r: 1.5 })
    const snap = snapSketchPoint(sketch, [30, 0.2], 1, { track: [[0, 0]] })
    expect(snap.kind).toBe('track')
    expect(snap.point).toEqual([30, 0])
    expect(snap.anchor).toBeNull()
    // An end within reach still wins over a tracking line.
    addEntity(sketch, { kind: 'line', a: [29.8, 0.4], b: [40, 10] })
    expect(snapSketchPoint(sketch, [30, 0.2], 1, { track: [[0, 0]] }).kind).toBe('anchor')
  })
})

describe('the panel’s tools', () => {
  const s = () => useReverse.getState()
  const start = () => {
    useReverse.setState({ features: [], nextFeatureId: 1, nextOfKind: {}, results: {}, bodies: [], sketchDraft: null, extrudeDraft: null, revolveDraft: null, past: [], future: [], selection: null, gripField: null, buildVersion: 0 })
    s().startSketch({ kind: 'world', axis: 'z', offset: 0 }, XY)
  }
  const RAW = { off: true }

  it('Point: one click, one point, held on the middle it snapped to', () => {
    start()
    s().setSketchTool('line')
    s().sketchClick([0, 0], 0.5, false, RAW)
    s().sketchClick([10, 0], 0.5, false, RAW)
    s().clearSelection()
    s().setSketchTool('point')
    s().sketchClick([5.1, 0.1], 0.5, false)
    const d = s().sketchDraft!
    const point = d.sketch.entities.find((e) => e.kind === 'point')!
    expect(point).toMatchObject({ p: [5, 0] })
    expect(d.sketch.constraints).toContainEqual(expect.objectContaining({ kind: 'coincident', p: { entity: point.id, at: 'center' }, q: { entity: 1, at: 'center' } }))
    expect(d.tool).toBe('point')
  })

  it('Trim: a click takes the stretch between the crossings, one undo step', () => {
    start()
    s().setSketch({
      entities: [
        { id: 1, kind: 'line', a: [-10, 0], b: [10, 0] },
        { id: 2, kind: 'line', a: [-5, -5], b: [-5, 5] },
        { id: 3, kind: 'line', a: [5, -5], b: [5, 5] },
      ],
      constraints: [],
      nextId: 4,
    })
    const steps = s().sketchDraft!.history.length
    s().setSketchTool('trim')
    s().sketchClick([0, 0.1], 0.5, false)
    const d = s().sketchDraft!
    expect(d.error).toBeNull()
    expect(d.sketch.entities.filter((e) => e.kind === 'line')).toHaveLength(4)
    expect(d.history.length).toBe(steps + 1)
    expect(d.report?.ok).toBe(true)
    s().undoSketch()
    expect(s().sketchDraft!.sketch.entities).toHaveLength(3)
  })

  it('Dimension: two centres, the number pulled above them, is their ΔX', () => {
    start()
    s().setSketch({
      entities: [
        { id: 1, kind: 'circle', c: [0, 0], r: 1 },
        { id: 2, kind: 'circle', c: [30, 12], r: 1 },
      ],
      constraints: [],
      nextId: 3,
    })
    // Selected as two pieces and dimensioned, the distance is in hand.
    s().setSketchTool('select')
    s().sketchClick([1, 0], 0.3, false)
    s().sketchClick([31, 12], 0.3, true)
    s().dimensionSelection()
    s().sketchClick([15, 25], 0.3, false)
    const dim = s().sketchDraft!.sketch.constraints.find((c) => c.kind === 'distance')
    expect(dim).toMatchObject({ axis: 'x', value: 30 })
    // And switched afterwards to ΔY, then straight across.
    s().setDistanceAxis(dim!.id, 'y')
    expect(s().sketchDraft!.sketch.constraints.find((c) => c.id === dim!.id)).toMatchObject({ axis: 'y', value: 12 })
    s().setDistanceAxis(dim!.id, null)
    const straight = s().sketchDraft!.sketch.constraints.find((c) => c.id === dim!.id) as { axis?: string; value: number }
    expect(straight.axis).toBeUndefined()
    expect(straight.value).toBeCloseTo(Math.hypot(30, 12))
  })
})

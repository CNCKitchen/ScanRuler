// SPDX-License-Identifier: AGPL-3.0-only
// Where a sketch click lands: on an end or a centre already there first,
// then the zero, then a drawn or projected piece, then a slice point, then
// a piece fitted to the slice, then the grid — each within reach — or
// exactly under the cursor with Alt; and what holds the
// point where it landed: everything of the sketch's own and the axes do,
// the slice and the grid do not. And what a drag does to a piece: an end moved, an
// arc's end swung round its centre, a piece carried, the sketch turned to
// lay a line along the sheet with the frame turning the other way.

import { describe, expect, it } from 'vitest'
import { detached, moveAnchor, rotateEntity, rotateSketch, translateEntity } from '../core/drag'
import { liftPoint } from '../core/features'
import { addConstraint, addEntity, addRectangle, anchorPoint, emptySketch, type SketchArc, type SketchLine } from '../core/sketch'
import { snapHold, snapSketchPoint } from '../core/snap'
import { datumTraces } from '../core/datums'
import { solveSketch } from '../core/solver'
import type { SectionFrame } from '../../../src/core/section/frame'
import { addScaled, cross, scale } from '../../../src/core/vec'

describe('snapping a sketch point', () => {
  const sketch = emptySketch()
  const line = addEntity(sketch, { kind: 'line', a: [0, 0], b: [10, 0] })
  addEntity(sketch, { kind: 'circle', c: [30, 30], r: 5 })

  it('takes an end within reach and names it, and a circle centre as an anchor to hold to', () => {
    const end = snapSketchPoint(sketch, [10.3, 0.2], 1)
    expect(end.kind).toBe('anchor')
    expect(end.point).toEqual([10, 0])
    expect(end.anchor).toEqual({ entity: line, at: 'b' })
    const centre = snapSketchPoint(sketch, [30.4, 29.8], 1)
    expect(centre.kind).toBe('anchor')
    expect(centre.point).toEqual([30, 30])
    expect(centre.anchor).toEqual({ entity: sketch.entities[1].id, at: 'center' })
    expect(snapHold(centre)).toEqual({ entity: sketch.entities[1].id, at: 'center' })
  })

  it('names the piece whose body it lands on, to be held on it; a slice point and the grid hold nothing', () => {
    const body = snapSketchPoint(sketch, [7.1, 0.3], 1)
    expect(body.kind).toBe('entity')
    expect(body.piece).toBe(line)
    expect(snapHold(body)).toEqual({ piece: line })
    // On the rim between two quadrants, which are points of their own.
    const rim = snapSketchPoint(sketch, [33.7, 33.7], 1)
    expect(rim.kind).toBe('entity')
    expect(snapHold(rim)).toEqual({ piece: sketch.entities[1].id })
    expect(snapHold(snapSketchPoint(sketch, [17.1, 0.3], 1, { chains: [[[17, 0.4]]] }))).toBeNull()
    expect(snapHold(snapSketchPoint(sketch, [20.4, 20.4], 1, { grid: 1 }))).toBeNull()
  })

  it('prefers a drawn piece to a slice point, a slice point to a fitted piece, and a piece to the grid', () => {
    const chains = [[[7, 0.4] as [number, number], [7.5, 0.4] as [number, number]]]
    // A line drawn by hand is what was meant where the scan runs beside it.
    const drawn = snapSketchPoint(sketch, [7.1, 0.3], 1, { chains, grid: 1 })
    expect(drawn.kind).toBe('entity')
    expect(drawn.piece).toBe(line)
    expect(drawn.point[1]).toBeCloseTo(0, 9)
    expect(drawn.point[0]).toBeCloseTo(7.1, 9)
    // A line fitted to the slice lies among its points: they come first.
    const scanned = emptySketch()
    const fit = addEntity(scanned, { kind: 'line', a: [0, 0], b: [10, 0], points: [[2, 0.1], [7, 0.4], [9, -0.1]], scatter: 0.1 })
    const edge = snapSketchPoint(scanned, [7.1, 0.3], 1, { chains, grid: 1 })
    expect(edge.kind).toBe('edge')
    expect(edge.point).toEqual([7, 0.4])
    expect(snapSketchPoint(scanned, [7.1, 0.3], 1, { grid: 1 }).piece).toBe(fit)
    const grid = snapSketchPoint(sketch, [20.2, 20.3], 1, { grid: 1 })
    expect(grid.kind).toBe('grid')
    expect(grid.point).toEqual([20, 20])
  })

  it('holds an end on a projected edge of the part, though the scan runs a hair beside it', () => {
    // A sketch on a face of a body: the face's edge projected, fixed, and
    // the slice of the scan along it a tenth off — as a scan lies by the
    // body modelled on it.
    const onFace = emptySketch()
    const edge = addEntity(onFace, { kind: 'line', a: [0, 10], b: [40, 10], fixed: true, projected: true })
    const slice: [number, number][] = Array.from({ length: 41 }, (_, i) => [i, 10.1])
    const snap = snapSketchPoint(onFace, [26.2, 10.05], 1, { chains: [slice] })
    expect(snap.kind).toBe('entity')
    expect(snapHold(snap)).toEqual({ piece: edge })
    expect(snap.point[1]).toBeCloseTo(10, 9)
  })

  it('takes the middle of a line, names it as the line’s centre anchor, and an end drawn there is held to it', () => {
    const mid = snapSketchPoint(sketch, [5.2, 0.3], 1)
    expect(mid.kind).toBe('midpoint')
    expect(mid.point).toEqual([5, 0])
    expect(mid.anchor).toEqual({ entity: line, at: 'center' })
    // Less far than an end reaches: beside the middle the line itself.
    expect(snapSketchPoint(sketch, [5.7, 0.3], 1).kind).toBe('entity')
    // Held: a line drawn from the middle follows when the first line moves.
    const held = emptySketch()
    const base = addEntity(held, { kind: 'line', a: [0, 0], b: [10, 0], fixed: true })
    const branch = addEntity(held, { kind: 'line', a: [5.4, 0.2], b: [5, 6] })
    addConstraint(held, { kind: 'coincident', p: { entity: branch, at: 'a' }, q: { entity: base, at: 'center' } })
    expect(solveSketch(held).ok).toBe(true)
    expect(anchorPoint(held.entities.find((e) => e.id === branch)!, 'a')[0]).toBeCloseTo(5, 6)
    expect(anchorPoint(held.entities.find((e) => e.id === branch)!, 'a')[1]).toBeCloseTo(0, 6)
  })

  it('lands nowhere out of reach, and nowhere at all with Alt', () => {
    const far = snapSketchPoint(sketch, [20.4, 20.4], 0.5, { grid: 1 })
    expect(far.kind).toBeNull()
    expect(far.point).toEqual([20.4, 20.4])
    const raw = snapSketchPoint(sketch, [10.1, 0.1], 1, { grid: 1, off: true })
    expect(raw.kind).toBeNull()
    expect(raw.point).toEqual([10.1, 0.1])
  })

  it('leaves out the piece being dragged', () => {
    const own = snapSketchPoint(sketch, [10.3, 0.2], 1, {}, new Set([line]))
    expect(own.kind).toBeNull()
  })
})

describe('moving a piece by hand', () => {
  it('moves a line end, carries a line by its middle, and moves a point', () => {
    const line: SketchLine = { id: 1, kind: 'line', a: [0, 0], b: [10, 0], points: [[1, 0], [2, 0]] }
    expect((moveAnchor(line, 'b', [10, 5]) as SketchLine).b).toEqual([10, 5])
    const carried = moveAnchor(line, 'center', [7, 2]) as SketchLine
    expect(carried.a).toEqual([2, 2])
    expect(carried.b).toEqual([12, 2])
    expect(carried.points).toEqual([[3, 2], [4, 2]])
    expect(moveAnchor({ id: 2, kind: 'point', p: [0, 0] }, 'center', [3, 4])).toMatchObject({ p: [3, 4] })
  })

  it('swings an arc end round its centre, keeping the radius and the other end', () => {
    const arc: SketchArc = { id: 1, kind: 'arc', c: [0, 0], r: 10, start: 0, sweep: Math.PI / 2 }
    const swung = moveAnchor(arc, 'b', [-7, 7]) as SketchArc
    expect(swung.r).toBe(10)
    expect(swung.start).toBe(0)
    expect(swung.sweep).toBeCloseTo((3 * Math.PI) / 4, 9)
    const endBefore = anchorPoint(arc, 'b')
    const other = moveAnchor(arc, 'a', [7, -7]) as SketchArc
    expect(anchorPoint(other, 'b')[0]).toBeCloseTo(endBefore[0], 9)
    expect(anchorPoint(other, 'b')[1]).toBeCloseTo(endBefore[1], 9)
    expect(other.start).toBeCloseTo(-Math.PI / 4, 9)
    expect(other.sweep).toBeCloseTo((3 * Math.PI) / 4, 9)
  })

  it('carries a circle and detaches a fitted piece from its points', () => {
    const circle = translateEntity({ id: 1, kind: 'circle', c: [1, 1], r: 2, points: [[3, 1]], scatter: 0.01 }, [1, 1])
    expect(circle).toMatchObject({ c: [2, 2], points: [[4, 2]] })
    const free = detached(circle)
    expect('points' in free).toBe(false)
    expect('scatter' in free).toBe(false)
    expect(free).toMatchObject({ c: [2, 2], r: 2 })
  })

  it('pulls a dragged end while the constraints hold: a horizontal line slides, not tilts', () => {
    const sketch = emptySketch()
    const id = addEntity(sketch, { kind: 'line', a: [0, 0], b: [10, 0] })
    addConstraint(sketch, { kind: 'horizontal', entity: id })
    // The hand pulls the end up and to the right.
    sketch.entities = sketch.entities.map((e) => (e.id === id ? moveAnchor(e, 'b', [14, 3]) : e))
    const report = solveSketch(sketch, { pull: [{ anchor: { entity: id, at: 'b' }, to: [14, 3] }] })
    expect(report.ok).toBe(true)
    const line = sketch.entities[0] as SketchLine
    expect(line.b[1]).toBeCloseTo(line.a[1], 5)
    expect(line.b[0]).toBeCloseTo(14, 2)
  })

  it('carries a joined neighbour along with the dragged end', () => {
    const sketch = emptySketch()
    const [bottom, right] = addRectangle(sketch, [0, 0], [10, 10])
    solveSketch(sketch)
    // Drag the bottom-right corner outward; the right side's foot follows.
    sketch.entities = sketch.entities.map((e) => (e.id === bottom ? moveAnchor(e, 'b', [14, 0]) : e))
    solveSketch(sketch, { pull: [{ anchor: { entity: bottom, at: 'b' }, to: [14, 0] }] })
    const b = sketch.entities.find((e) => e.id === bottom) as SketchLine
    const r = sketch.entities.find((e) => e.id === right) as SketchLine
    expect(b.b[0]).toBeCloseTo(14, 2)
    expect(r.a[0]).toBeCloseTo(b.b[0], 5)
    expect(r.a[1]).toBeCloseTo(b.b[1], 5)
  })
})

describe('aligning the sheet to a line', () => {
  it('turns every piece, arcs by their start angle, points and slice points along', () => {
    const angle = Math.PI / 2
    const line = rotateEntity({ id: 1, kind: 'line', a: [1, 0], b: [2, 0], points: [[1.5, 0]] }, angle) as SketchLine
    expect(line.a[0]).toBeCloseTo(0, 9)
    expect(line.a[1]).toBeCloseTo(1, 9)
    expect(line.b[1]).toBeCloseTo(2, 9)
    expect(line.points![0][1]).toBeCloseTo(1.5, 9)
    const arc = rotateEntity({ id: 2, kind: 'arc', c: [1, 0], r: 1, start: 0, sweep: 1 }, angle) as SketchArc
    expect(arc.c[1]).toBeCloseTo(1, 9)
    expect(arc.start).toBeCloseTo(angle, 9)
    expect(arc.sweep).toBe(1)
  })

  it('leaves every point where it was on the part once the frame turns the other way', () => {
    const frame: SectionFrame = { origin: [5, 5, 5], normal: [0, 0, 1], basisU: [1, 0, 0], basisV: [0, 1, 0] }
    const sketch = emptySketch()
    // A line 30° off the sheet's X.
    const theta = Math.PI / 6
    addEntity(sketch, { kind: 'line', a: [0, 0], b: [10 * Math.cos(theta), 10 * Math.sin(theta)] })
    addEntity(sketch, { kind: 'circle', c: [3, 4], r: 1 })
    const before = sketch.entities.map((e) => (e.kind === 'line' ? liftPoint(frame, e.b) : liftPoint(frame, (e as { c: [number, number] }).c)))
    rotateSketch(sketch, -theta)
    const basisU = addScaled(scale(frame.basisU, Math.cos(theta)), frame.basisV, Math.sin(theta))
    const turned: SectionFrame = { ...frame, basisU, basisV: cross(frame.normal, basisU) }
    const line = sketch.entities[0] as SketchLine
    expect(line.b[1]).toBeCloseTo(0, 9)
    expect(line.b[0]).toBeCloseTo(10, 9)
    const after = sketch.entities.map((e) => (e.kind === 'line' ? liftPoint(turned, e.b) : liftPoint(turned, (e as { c: [number, number] }).c)))
    for (let i = 0; i < before.length; i++) for (let k = 0; k < 3; k++) expect(after[i][k]).toBeCloseTo(before[i][k], 9)
  })
})

describe('the coordinate planes’ lines on the sheet', () => {
  const traces = datumTraces({ origin: [0, 0, 0], normal: [0, 0, 1], basisU: [1, 0, 0], basisV: [0, 1, 0] })

  it('take a point near them onto the line, name the plane, and are held to by a point-on relation', () => {
    const sketch = emptySketch()
    const onAxis = snapSketchPoint(sketch, [12, 0.5], 1, { datums: traces })
    expect(onAxis.kind).toBe('datum')
    expect(onAxis.point).toEqual([12, 0])
    expect(onAxis.datum).toBe('zx')
    expect(snapHold(onAxis)).toEqual({ datum: 'zx' })
    // Less far than an end: at 0.9 of the reach the axis is not taken.
    expect(snapSketchPoint(sketch, [12, 0.9], 1, { datums: traces }).kind).toBeNull()
    // An end within reach wins over the axis; a slice point loses to it.
    const line = addEntity(sketch, { kind: 'line', a: [12, 0.6], b: [30, 5] })
    expect(snapSketchPoint(sketch, [12, 0.5], 1, { datums: traces }).anchor).toEqual({ entity: line, at: 'a' })
    expect(snapSketchPoint(sketch, [20, 0.5], 1, { datums: traces, chains: [[[20, 0.4]]] }).kind).toBe('datum')
  })
})

describe('the origin on the sheet', () => {
  it('is a snap within reach, after the ends of the pieces', () => {
    const bare = snapSketchPoint(emptySketch(), [0.4, -0.3], 1)
    expect(bare.kind).toBe('origin')
    expect(bare.point).toEqual([0, 0])
    expect(bare.anchor).toBeNull()
    // Without the planes' lines, nothing holds a point at the zero.
    expect(snapHold(bare)).toBeNull()
    expect(snapSketchPoint(emptySketch(), [3, 0], 1).kind).toBeNull()
    // An end already on the origin is what the click takes, and is held.
    const sketch = emptySketch()
    const line = addEntity(sketch, { kind: 'line', a: [0, 0], b: [10, 0] })
    const end = snapSketchPoint(sketch, [0.4, -0.3], 1)
    expect(end.kind).toBe('anchor')
    expect(end.anchor).toEqual({ entity: line, at: 'a' })
  })

  it('holds a point that lands on it by the planes whose lines cross there', () => {
    const traces = datumTraces({ origin: [0, 0, 0], normal: [0, 0, 1], basisU: [1, 0, 0], basisV: [0, 1, 0] })
    const zero = snapSketchPoint(emptySketch(), [0.4, -0.3], 1, { datums: traces })
    expect(zero.kind).toBe('origin')
    expect(snapHold(zero)).toEqual({ origin: ['yz', 'zx'] })
    // A sheet whose zero no plane's line runs through: the zero is a place only.
    const lifted = datumTraces({ origin: [0, 0, 5], normal: [0, 0, 1], basisU: [1, 0, 0], basisV: [0, 1, 0] })
    expect(snapHold(snapSketchPoint(emptySketch(), [0.4, -0.3], 1, { datums: lifted }))).toEqual({ origin: ['yz', 'zx'] })
    const askew = datumTraces({ origin: [1, 0, 0], normal: [0, 0, 1], basisU: [1, 0, 0], basisV: [0, 1, 0] })
    expect(snapHold(snapSketchPoint(emptySketch(), [0.4, -0.3], 1, { datums: askew }))).toEqual({ origin: ['zx'] })
  })
})

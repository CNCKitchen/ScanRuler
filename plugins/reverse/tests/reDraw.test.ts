// SPDX-License-Identifier: AGPL-3.0-only
// What the sketch's drawing tools work out (core/re/draw.ts) and how the
// store uses it: a chain of lines, the tangent arc out of its last end, the
// Dimension and Relation tools that take what is clicked, and a click that
// selects and stays selected. Plain zustand, no DOM.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { arcAbout, circleFrom, DEFAULT_DRAW_MODES, dimensionFor, dimPickAt, drawClicks, outwardTangent, rectangleCorners, tangentArc } from '../core/draw'
import { addEntity, anchorPoint, emptySketch, entityOf } from '../core/sketch'
import { useReverse } from '../state/reStore'
import { useRePrefs } from '../state/rePrefs'
import { rigidCluster } from '../core/drag'
import { datumTraces } from '../core/datums'
import { XY } from './reKit'

const s = () => useReverse.getState()
const RAW = { off: true }

beforeEach(() => {
  useReverse.setState({ features: [], nextFeatureId: 1, nextOfKind: {}, results: {}, bodies: [], sketchDraft: null, extrudeDraft: null, revolveDraft: null, past: [], future: [], selection: null, gripField: null, buildVersion: 0 })
  s().startSketch({ kind: 'world', axis: 'z', offset: 0 }, XY)
})

describe('the tangent arc', () => {
  it('leaves its start along the tangent and ends on the point, turning left', () => {
    const arc = tangentArc([0, 0], [1, 0], [5, 5])!
    expect(arc.startsAtP).toBe(true)
    expect(arc.c[0]).toBeCloseTo(0)
    expect(arc.c[1]).toBeCloseTo(5)
    expect(arc.r).toBeCloseTo(5)
    expect(arc.sweep).toBeCloseTo(Math.PI / 2)
  })

  it('turning right it is stored counter-clockwise from the far end', () => {
    const arc = tangentArc([0, 0], [1, 0], [5, -5])!
    expect(arc.startsAtP).toBe(false)
    expect(arc.c[1]).toBeCloseTo(-5)
    expect(arc.sweep).toBeCloseTo(Math.PI / 2)
    // Anchor 'a' is at the far end, 'b' back at the start.
    expect(arc.c[0] + arc.r * Math.cos(arc.start)).toBeCloseTo(5)
    expect(arc.c[1] + arc.r * Math.sin(arc.start + arc.sweep)).toBeCloseTo(0)
  })

  it('there is none straight ahead', () => {
    expect(tangentArc([0, 0], [1, 0], [7, 0])).toBeNull()
  })

  it('an arc runs on counter-clockwise past its end, clockwise past its start', () => {
    const sketch = emptySketch()
    const id = addEntity(sketch, { kind: 'arc', c: [0, 0], r: 2, start: 0, sweep: Math.PI / 2 })
    const arc = entityOf(sketch, id)!
    const end = outwardTangent(arc, 'b')!
    expect(end[0]).toBeCloseTo(-1)
    expect(end[1]).toBeCloseTo(0)
    const start = outwardTangent(arc, 'a')!
    expect(start[0]).toBeCloseTo(0)
    expect(start[1]).toBeCloseTo(-1)
  })
})

describe('what two clicks dimension', () => {
  const sketch = emptySketch()
  const bottom = addEntity(sketch, { kind: 'line', a: [0, 0], b: [10, 0] })
  const top = addEntity(sketch, { kind: 'line', a: [0, 4], b: [10, 4.05] })
  const slanted = addEntity(sketch, { kind: 'line', a: [20, 0], b: [25, 5] })
  const hole = addEntity(sketch, { kind: 'circle', c: [5, 2], r: 1 })
  const round = addEntity(sketch, { kind: 'arc', c: [30, 0], r: 2, start: 0, sweep: Math.PI / 2 })
  const piece = (id: number) => ({ kind: 'piece', id }) as const

  it('one line is its length, one circle its diameter, one arc its radius', () => {
    expect(dimensionFor(sketch, piece(bottom), null)).toMatchObject({ kind: 'length', entity: bottom, value: 10 })
    expect(dimensionFor(sketch, piece(bottom), piece(bottom))).toMatchObject({ kind: 'length' })
    expect(dimensionFor(sketch, piece(hole), null)).toMatchObject({ kind: 'diameter', entity: hole, value: 2 })
    expect(dimensionFor(sketch, piece(round), null)).toMatchObject({ kind: 'radius', entity: round, value: 2 })
  })

  it('two nearly parallel lines are the distance between them, two others their angle', () => {
    const d = dimensionFor(sketch, piece(bottom), piece(top))!
    expect(d).toMatchObject({ kind: 'distance', q: { line: top } })
    expect('value' in d && d.value).toBeCloseTo(4, 1)
    expect(dimensionFor(sketch, piece(bottom), piece(slanted))).toMatchObject({ kind: 'angle', value: 45 })
  })

  it('an end and a line, a centre and a line, two ends', () => {
    const end = dimPickAt(sketch, [25.1, 5.1], 0.5)!
    expect(end).toEqual({ kind: 'point', anchor: { entity: slanted, at: 'b' } })
    expect(dimensionFor(sketch, end, piece(bottom))).toMatchObject({ kind: 'distance', p: { entity: slanted, at: 'b' }, q: { line: bottom }, value: 5 })
    expect(dimensionFor(sketch, piece(bottom), piece(hole))).toMatchObject({ kind: 'distance', p: { entity: hole, at: 'center' }, value: 2 })
    const corner = dimPickAt(sketch, [0, 0], 0.5)!
    expect(dimensionFor(sketch, corner, end)).toMatchObject({ kind: 'distance', p: { entity: bottom, at: 'a' }, q: { entity: slanted, at: 'b' } })
  })

  it('a line’s own end is no distance from it, and a point alone is nothing', () => {
    const corner = dimPickAt(sketch, [0, 0], 0.5)!
    expect(dimensionFor(sketch, corner, piece(bottom))).toBeNull()
    expect(dimensionFor(sketch, corner, null)).toBeNull()
  })

  it('a piece clicked along it picks the piece, its end the point — its very middle the middle, which alone stands for the piece', () => {
    expect(dimPickAt(sketch, [3, 0.1], 0.5)).toEqual({ kind: 'piece', id: bottom })
    expect(dimPickAt(sketch, [5, 0.1], 0.5)).toEqual({ kind: 'point', anchor: { entity: bottom, at: 'center' }, of: bottom })
    expect(dimensionFor(sketch, dimPickAt(sketch, [5, 0.1], 0.5)!, null)).toMatchObject({ kind: 'length', entity: bottom })
    expect(dimPickAt(sketch, [50, 50], 0.5)).toBeNull()
  })
})

describe('the Line tool draws a chain', () => {
  it('each line starts where the last ended, joined to it', () => {
    s().setSketchTool('line')
    s().sketchClick([0, 0], 0.5, false, RAW)
    s().sketchClick([10, 3], 0.5, false, RAW)
    expect(s().sketchDraft?.sketch.entities).toHaveLength(1)
    expect(s().sketchDraft?.pending).toEqual([[10, 3]])
    s().sketchClick([12, 9], 0.5, false, RAW)
    const d = s().sketchDraft!
    expect(d.sketch.entities).toHaveLength(2)
    expect(d.sketch.constraints.filter((c) => c.kind === 'coincident')).toHaveLength(1)
    expect(d.pending).toHaveLength(1)
  })

  it('a second click on the last end ends the chain and makes nothing', () => {
    s().setSketchTool('line')
    s().sketchClick([0, 0], 0.5, false, RAW)
    s().sketchClick([10, 3], 0.5, false, RAW)
    s().sketchClick([10, 3], 0.5, false, RAW)
    expect(s().sketchDraft?.sketch.entities).toHaveLength(1)
    expect(s().sketchDraft?.pending).toEqual([])
    expect(s().sketchDraft?.error).toBeNull()
  })

  it('landing on another piece’s end it has arrived', () => {
    s().setSketchTool('line')
    s().sketchClick([0, 0], 0.5, false, RAW)
    s().sketchClick([10, 3], 0.5, false, RAW)
    s().sketchClick([12, 9], 0.5, false, RAW)
    // Back onto the first line's start, snapping this time.
    s().sketchClick([0.1, 0.1], 0.5, false, {})
    const d = s().sketchDraft!
    expect(d.sketch.entities).toHaveLength(3)
    expect(d.pending).toEqual([])
    expect(d.found).toHaveLength(1)
  })

  it('the chain continues from where the solver put a line made level', () => {
    s().setSketchTool('line')
    s().sketchClick([0, 0], 0.5, false, RAW)
    s().sketchClick([10, 0.2], 0.5, false, RAW)
    const d = s().sketchDraft!
    const line = d.sketch.entities[0]
    expect(d.pending[0]).toEqual(anchorPoint(line, 'b'))
    expect(d.pending[0][1]).toBeCloseTo(anchorPoint(line, 'a')[1], 6)
  })

  it('a drag out of the last end is an arc tangent to the line, and the chain runs on from it', () => {
    s().setSketchTool('line')
    s().sketchClick([0, 0], 0.5, false, RAW)
    s().sketchClick([10, 0], 0.5, false, RAW)
    s().sketchTangentArc([15, 5], 0.5, RAW)
    const d = s().sketchDraft!
    expect(d.sketch.entities.map((e) => e.kind)).toEqual(['line', 'arc'])
    expect(d.sketch.constraints.some((c) => c.kind === 'tangent')).toBe(true)
    const arc = d.sketch.entities[1]
    expect(arc.kind === 'arc' && arc.r).toBeCloseTo(5, 3)
    expect(d.report?.ok).toBe(true)
    expect(d.pending[0][0]).toBeCloseTo(15, 3)
    expect(d.pending[0][1]).toBeCloseTo(5, 3)
    expect(d.chain).toEqual({ entity: arc.id, at: 'b' })
  })
})

describe('tools that take what is clicked', () => {
  const drawL = () => {
    s().setSketchTool('line')
    s().sketchClick([0, 0], 0.5, false, RAW)
    s().sketchClick([10, 0], 0.5, false, RAW)
    s().sketchClick([10, 8], 0.5, false, RAW)
    s().setSketchTool('select')
  }
  /** The two lines of the L, by id — ids run over pieces and relations alike. */
  const lines = () => s().sketchDraft!.sketch.entities.map((e) => e.id)

  it('Dimension: a line, then the bare sheet, is its length — put down there, opened to be typed into', () => {
    drawL()
    const steps = s().sketchDraft!.history.length
    s().setSketchTool('dimension')
    s().sketchClick([3, 0], 0.5, false)
    expect(s().sketchDraft?.dimPick).toEqual({ kind: 'piece', id: 1 })
    const focus = s().sketchDraft!.dimFocus ?? 0
    s().sketchClick([4, -6], 0.5, false)
    const d = s().sketchDraft!
    const dim = d.sketch.constraints.find((c) => c.kind === 'length')!
    expect(dim).toMatchObject({ entity: 1, value: 10 })
    // Where the click was: 1 mm left of the line's middle, 6 mm below it.
    expect(dim.place?.along).toBeCloseTo(-1, 6)
    expect(Math.abs(dim.place?.off ?? 0)).toBeCloseTo(6, 6)
    expect(d.selectedConstraint).toBe(dim.id)
    expect(d.dimFocus).toBe(focus + 1)
    expect(d.tool).toBe('dimension')
    expect(d.dimPick).toBeNull()
    expect(d.dimMade).toBeNull()
    // Made and put down in one step.
    expect(d.history).toHaveLength(steps + 1)
  })

  it('Dimension: one in hand is taken back by Escape, and by another tool — never made', () => {
    drawL()
    const steps = s().sketchDraft!.history.length
    s().setSketchTool('dimension')
    s().sketchClick([5, 0], 0.5, false)
    expect(s().sketchDraft!.dimMade).not.toBeNull()
    s().clearSelection()
    expect(s().sketchDraft!.sketch.constraints.some((c) => c.kind === 'length')).toBe(false)
    expect(s().sketchDraft!.history).toHaveLength(steps)
    expect(s().sketchDraft!.tool).toBe('dimension')
    // A pair in hand goes the same way.
    s().sketchClick([0, 0], 0.5, false)
    s().sketchClick([10, 4], 0.5, false)
    expect(s().sketchDraft!.sketch.constraints.some((c) => c.kind === 'distance')).toBe(true)
    s().setSketchTool('line')
    expect(s().sketchDraft!.sketch.constraints.some((c) => c.kind === 'distance')).toBe(false)
    expect(s().sketchDraft!.history).toHaveLength(steps)
  })

  it('Dimension: Enter puts the one in hand down where the layout has it', () => {
    drawL()
    s().setSketchTool('dimension')
    s().sketchClick([5, 0], 0.5, false)
    s().putDownDimension()
    const d = s().sketchDraft!
    const dim = d.sketch.constraints.find((c) => c.kind === 'length')!
    expect(dim.place).toBeUndefined()
    expect(d.dimMade).toBeNull()
    expect(d.selectedConstraint).toBe(dim.id)
  })

  it('Dimension: one click on a line is its length there and then, the line still in hand', () => {
    drawL()
    s().setSketchTool('dimension')
    s().sketchClick([3, 0], 0.5, false)
    const d = s().sketchDraft!
    const dim = d.sketch.constraints.find((c) => c.kind === 'length')!
    expect(dim).toMatchObject({ entity: 1, value: 10 })
    expect(d.selectedConstraint).toBe(dim.id)
    expect(d.dimPick).toEqual({ kind: 'piece', id: 1 })
    expect(d.dimMade).toBe(dim.id)
    // A second click on the same line puts it down there; a third makes no
    // second length, but opens the one it has for typing.
    s().sketchClick([3, 0], 0.5, false)
    expect(s().sketchDraft!.dimMade).toBeNull()
    const focus = s().sketchDraft!.dimFocus ?? 0
    s().sketchClick([3, 0], 0.5, false)
    expect(s().sketchDraft!.sketch.constraints.filter((c) => c.kind === 'length')).toHaveLength(1)
    expect(s().sketchDraft!.selectedConstraint).toBe(dim.id)
    expect(s().sketchDraft!.dimFocus).toBe(focus + 1)
  })

  it('Dimension: a second line turns the length into the angle between them, in one undo step', () => {
    drawL()
    const steps = s().sketchDraft!.history.length
    s().setSketchTool('dimension')
    s().sketchClick([3, 0], 0.5, false)
    s().sketchClick([10, 4], 0.5, false)
    const d = s().sketchDraft!
    expect(d.sketch.constraints.some((c) => c.kind === 'length')).toBe(false)
    const angle = d.sketch.constraints.find((c) => c.kind === 'angle')!
    expect(angle).toMatchObject({ value: 90 })
    expect(d.history).toHaveLength(steps + 1)
    // The angle is in hand in its turn, and the next click puts it down
    // whatever lies under it.
    expect(d.dimPick).toBeNull()
    expect(d.dimMade).toBe(angle.id)
    s().sketchClick([5, 0], 0.5, false)
    expect(s().sketchDraft!.dimMade).toBeNull()
    expect(s().sketchDraft!.sketch.constraints.filter((c) => 'value' in c)).toHaveLength(1)
    expect(s().sketchDraft!.history).toHaveLength(steps + 1)
    s().undoSketch()
    expect(s().sketchDraft!.sketch.constraints.some((c) => c.kind === 'angle' || c.kind === 'length')).toBe(false)
  })

  it('Dimension: a length typed over is done — the next click is a dimension of its own', () => {
    drawL()
    s().setSketchTool('dimension')
    s().sketchClick([3, 0], 0.5, false)
    const made = s().sketchDraft!.dimMade!
    s().setDimensionValue(made, 12)
    expect(s().sketchDraft!.dimPick).toBeNull()
    s().sketchClick([10, 4], 0.5, false)
    const dims = s().sketchDraft!.sketch.constraints.filter((c) => 'value' in c)
    expect(dims.map((c) => c.kind)).toEqual(['length', 'length'])
    expect(dims.map((c) => ('entity' in c ? c.entity : null))).toEqual(lines())
  })

  it('Dimension: a length taken as it stands with Enter is done as well', () => {
    drawL()
    s().setSketchTool('dimension')
    s().sketchClick([3, 0], 0.5, false)
    s().finishDimension(s().sketchDraft!.dimMade!)
    expect(s().sketchDraft!.dimPick).toBeNull()
    s().sketchClick([10, 4], 0.5, false)
    expect(s().sketchDraft!.sketch.constraints.filter((c) => 'value' in c).map((c) => c.kind)).toEqual(['length', 'length'])
  })

  it('Dimension: after a pair nothing of it stays in hand', () => {
    drawL()
    s().setSketchTool('dimension')
    // An end, then the other line: the distance between them, and the
    // operation done.
    s().sketchClick([0, 0], 0.5, false)
    s().sketchClick([10, 4], 0.5, false)
    expect(s().sketchDraft!.sketch.constraints.find((c) => c.kind === 'distance')).toBeDefined()
    expect(s().sketchDraft!.dimPick).toBeNull()
    expect(s().sketchDraft!.selection).toEqual([])
    // The next click puts it down, and the one after starts afresh: the
    // first line's length.
    s().sketchClick([3, 0], 0.5, false)
    expect(s().sketchDraft!.dimMade).toBeNull()
    s().sketchClick([3, 0], 0.5, false)
    expect(s().sketchDraft!.sketch.constraints.filter((c) => c.kind === 'length')).toHaveLength(1)
    expect(s().sketchDraft!.dimPick).toEqual({ kind: 'piece', id: 1 })
  })

  it('Dimension: an end, then a coordinate plane’s line, is the distance to the plane', () => {
    drawL()
    s().setSketchTool('dimension')
    s().sketchClick([10, 8], 0.5, false)
    // The YZ plane cuts this sheet along u = 0; clicked well off the pieces.
    s().sketchClick([0.1, 30], 0.5, false)
    const d = s().sketchDraft!
    expect(d.sketch.constraints.find((c) => c.kind === 'distance')).toMatchObject({ p: { at: 'b' }, q: { datum: 'yz' }, value: 10 })
    expect(d.report?.ok).toBe(true)
    s().setDimensionValue(d.selectedConstraint!, 14)
    const dim = d.sketch.constraints.find((c) => c.kind === 'distance')!
    const end = anchorPoint(entityOf(s().sketchDraft!.sketch, 'p' in dim ? dim.p.entity : -1)!, 'b')
    expect(Math.abs(end[0])).toBeCloseTo(14, 5)
  })

  it('Dimension: an end, then a line, is the distance between them', () => {
    drawL()
    s().setSketchTool('dimension')
    s().sketchClick([10, 8], 0.5, false)
    // Along the line, off its middle: the middle itself is a point to
    // measure to (reSketchRound.test.ts).
    s().sketchClick([3, 0], 0.5, false)
    expect(s().sketchDraft?.sketch.constraints.find((c) => c.kind === 'distance')).toMatchObject({ q: { line: 1 }, value: 8 })
  })

  it('a relation with nothing selected is put on the pieces clicked next, and stays in hand', () => {
    drawL()
    const before = s().sketchDraft!.sketch.constraints.length
    s().armRelation('perpendicular')
    s().sketchClick([5, 0], 0.5, false)
    expect(s().sketchDraft?.selection).toEqual([lines()[0]])
    s().sketchClick([10, 4], 0.5, false)
    const d = s().sketchDraft!
    expect(d.sketch.constraints).toHaveLength(before + 1)
    expect(d.sketch.constraints.at(-1)).toMatchObject({ kind: 'perpendicular', a: lines()[0], b: lines()[1] })
    expect(d.selection).toEqual([])
    expect(d.tool).toBe('relation')
  })

  it('the selection dimensions too', () => {
    drawL()
    s().sketchClick([5, 0], 0.5, false)
    s().sketchClick([10, 4], 0.5, false)
    s().dimensionSelection()
    const d = s().sketchDraft!
    const angle = d.sketch.constraints.find((c) => c.kind === 'angle')!
    expect(angle).toMatchObject({ value: 90 })
    // In hand with the Dimension tool, to be put down with a click.
    expect(d.tool).toBe('dimension')
    expect(d.dimMade).toBe(angle.id)
    expect(d.selection).toEqual([])
  })

  it('a circle’s diameter in hand pairs with another piece, as a length does', () => {
    s().setSketchTool('circle')
    s().sketchClick([20, 20], 0.01, false, RAW)
    s().sketchClick([22, 20], 0.01, false, RAW)
    s().setSketchTool('line')
    s().sketchClick([0, 0], 0.01, false, RAW)
    s().sketchClick([40, 0], 0.01, false, RAW)
    s().setSketchTool('dimension')
    s().sketchClick([20, 22], 0.5, false)
    expect(s().sketchDraft!.sketch.constraints.find((c) => c.kind === 'diameter')).toMatchObject({ value: 4 })
    s().sketchClick([30, 0], 0.5, false)
    const d = s().sketchDraft!
    expect(d.sketch.constraints.some((c) => c.kind === 'diameter')).toBe(false)
    expect(d.sketch.constraints.find((c) => c.kind === 'distance')).toMatchObject({ p: { at: 'center' }, value: 20 })
  })
})

describe('a click selects', () => {
  it('the press that might have been a drag leaves the selection to the click', () => {
    s().setSketchTool('line')
    s().sketchClick([0, 0], 0.5, false, RAW)
    s().sketchClick([10, 5], 0.5, false, RAW)
    s().setSketchTool('select')
    const history = s().sketchDraft!.history.length
    // Press and release without a move: the sheet reports the press, then the click.
    expect(s().sketchDragStart([5, 2.5], 0.5)).toBe(true)
    expect(s().sketchDraft?.selection).toEqual([])
    s().sketchClick([5, 2.5], 0.5, false)
    expect(s().sketchDraft?.selection).toEqual([1])
    expect(s().sketchDraft?.history).toHaveLength(history)
  })

  it('a drag selects the piece it carries and is one step of the history', () => {
    s().setSketchTool('line')
    s().sketchClick([0, 0], 0.5, false, RAW)
    s().sketchClick([10, 5], 0.5, false, RAW)
    s().setSketchTool('select')
    const history = s().sketchDraft!.history.length
    s().sketchDragStart([10, 5], 0.5)
    s().sketchDrag([12, 6], 0.5, RAW)
    s().sketchDrag([14, 7], 0.5, RAW)
    s().sketchDragEnd()
    expect(s().sketchDraft?.selection).toEqual([1])
    expect(s().sketchDraft?.history).toHaveLength(history + 1)
  })
})

describe('the ways a rectangle, a circle and an arc are drawn', () => {
  afterEach(() => useRePrefs.setState({ drawModes: DEFAULT_DRAW_MODES }))
  const draw = (tool: 'rectangle' | 'circle' | 'arc', clicks: [number, number][]) => {
    s().setSketchTool(tool)
    for (const c of clicks) s().sketchClick(c, 0.01, false, RAW)
    return s().sketchDraft!
  }
  const lines = () => s().sketchDraft!.sketch.entities.filter((e) => e.kind === 'line' && !e.construction)
  const corners = () => lines().map((e) => (e.kind === 'line' ? [Math.round(e.a[0] * 1e6) / 1e6, Math.round(e.a[1] * 1e6) / 1e6] : null))

  it('in the geometry: corners, circles and arcs from the clicks of each way', () => {
    expect(drawClicks('rectangle', { ...DEFAULT_DRAW_MODES, rectangle: 'threePoint' })).toBe(3)
    expect(drawClicks('circle', { ...DEFAULT_DRAW_MODES, circle: 'twoPoint' })).toBe(2)
    expect(rectangleCorners('center', [[5, 5], [8, 7]])).toEqual([[2, 3], [8, 3], [8, 7], [2, 7]])
    expect(rectangleCorners('corners', [[0, 0], [0, 7]])).toBeNull()
    const turned = rectangleCorners('threePoint', [[0, 0], [6, 8], [-4, 3]])!
    expect(turned[2][0]).toBeCloseTo(2)
    expect(turned[2][1]).toBeCloseTo(11)
    expect(rectangleCorners('threePoint', [[0, 0], [6, 8], [3, 4]])).toBeNull()
    expect(circleFrom('twoPoint', [[0, 0], [10, 0]])).toEqual({ c: [5, 0], r: 5 })
    const three = circleFrom('threePoint', [[0, 0], [10, 0], [5, 5]])!
    expect(three.c[0]).toBeCloseTo(5)
    expect(three.c[1]).toBeCloseTo(0)
    expect(three.r).toBeCloseTo(5)
    expect(circleFrom('threePoint', [[0, 0], [5, 0], [10, 0]])).toBeNull()
    const quarter = arcAbout([0, 0], [5, 0], [0, 7])!
    expect(quarter).toMatchObject({ r: 5, start: 0, startsAtP: true })
    expect(quarter.sweep).toBeCloseTo(Math.PI / 2)
    // The cursor clockwise of the start: the same quarter, run from its end.
    const back = arcAbout([0, 0], [5, 0], [0, -7])!
    expect(back.startsAtP).toBe(false)
    expect(back.start).toBeCloseTo(-Math.PI / 2)
    expect(back.sweep).toBeCloseTo(Math.PI / 2)
  })

  it('a rectangle about its centre: the centre a point where its diagonals cross, held where it was clicked', () => {
    useRePrefs.getState().setDrawMode('rectangle', 'center')
    s().setSketchTool('rectangle')
    // The first click on the sheet's zero: the centre is held there.
    s().sketchClick([0.01, 0.01], 0.5, false, { datums: datumTraces(XY) })
    s().sketchClick([10, 6], 0.01, false, RAW)
    const d = s().sketchDraft!
    expect(d.error).toBeNull()
    expect(corners()).toEqual([[-10, -6], [10, -6], [10, 6], [-10, 6]])
    const centre = d.sketch.entities.find((e) => e.kind === 'point')!
    expect(centre.construction).toBe(true)
    expect(d.sketch.entities.filter((e) => e.kind === 'line' && e.construction)).toHaveLength(2)
    expect(d.report?.ok).toBe(true)
    // Its width typed: it grows about the centre, which stays on the zero.
    const bottom = lines()[0].id
    s().setSketchTool('dimension')
    s().sketchClick([0, -6], 0.5, false)
    const width = s().sketchDraft!.sketch.constraints.find((c) => c.kind === 'length' && c.entity === bottom)!
    s().setDimensionValue(width.id, 30)
    const after = s().sketchDraft!
    const p = after.sketch.entities.find((e) => e.kind === 'point')!
    expect(p.kind === 'point' && Math.hypot(p.p[0], p.p[1])).toBeCloseTo(0, 6)
    const b = after.sketch.entities.find((e) => e.id === bottom)!
    expect(b.kind === 'line' && b.a[0]).toBeCloseTo(-15, 6)
    expect(b.kind === 'line' && b.b[0]).toBeCloseTo(15, 6)
  })

  it('a rectangle by three points, at an angle — and level when its first side is nearly so', () => {
    useRePrefs.getState().setDrawMode('rectangle', 'threePoint')
    const d = draw('rectangle', [[0, 0], [6, 8], [-4, 3]])
    expect(d.error).toBeNull()
    expect(lines()).toHaveLength(4)
    expect(d.sketch.constraints.filter((c) => c.kind === 'parallel')).toHaveLength(2)
    expect(d.sketch.constraints.filter((c) => c.kind === 'perpendicular')).toHaveLength(1)
    expect(d.report?.ok).toBe(true)
    const [, , far] = corners()
    expect(far![0]).toBeCloseTo(2)
    expect(far![1]).toBeCloseTo(11)
    s().clearSelection()
    const level = draw('rectangle', [[20, 0], [30, 0.1], [25, 5]])
    expect(level.sketch.constraints.filter((c) => c.kind === 'horizontal' || c.kind === 'vertical').length).toBeGreaterThanOrEqual(4)
    expect(level.report?.ok).toBe(true)
  })

  it('a circle by the ends of a diameter, and through three points — not through three in a line', () => {
    useRePrefs.getState().setDrawMode('circle', 'twoPoint')
    const two = draw('circle', [[0, 0], [10, 0]])
    expect(two.sketch.entities[0]).toMatchObject({ kind: 'circle', c: [5, 0], r: 5 })
    useRePrefs.getState().setDrawMode('circle', 'threePoint')
    const three = draw('circle', [[20, 0], [30, 0], [25, 5]])
    const c = three.sketch.entities[1]
    expect(c.kind === 'circle' && c.r).toBeCloseTo(5)
    const flat = draw('circle', [[40, 0], [45, 0], [50, 0]])
    expect(flat.error).toMatch(/lie on a line/)
    expect(flat.sketch.entities).toHaveLength(2)
  })

  it('an arc about its centre: the start gives the radius, the end only the direction', () => {
    useRePrefs.getState().setDrawMode('arc', 'center')
    const d = draw('arc', [[0, 0], [5, 0], [0, 9]])
    const arc = d.sketch.entities[0]
    expect(arc).toMatchObject({ kind: 'arc', c: [0, 0], r: 5, start: 0 })
    expect(arc.kind === 'arc' && arc.sweep).toBeCloseTo(Math.PI / 2)
  })
})

describe('a shape defined in all but its place', () => {
  /** A 20 × 10 rectangle at (10, 10), its width and height dimensioned. */
  const sized = () => {
    s().setSketchTool('rectangle')
    s().sketchClick([10, 10], 0.01, false, RAW)
    s().sketchClick([30, 20], 0.01, false, RAW)
    s().setSketchTool('dimension')
    for (const at of [[20, 10], [30, 15]] as [number, number][]) {
      s().sketchClick(at, 0.5, false)
      s().finishDimension(s().sketchDraft!.selectedConstraint!)
    }
    s().setSketchTool('select')
  }
  const corner = (i: number) => {
    const e = s().sketchDraft!.sketch.entities[i]
    return e.kind === 'line' ? e.a.map((v) => Math.round(v * 1e6) / 1e6) : null
  }

  it('follows the hand whole by a corner, at every step of the drag', () => {
    sized()
    expect(rigidCluster(s().sketchDraft!.sketch, { entity: 2, at: 'b' })).toEqual([1, 2, 3, 4])
    s().sketchDragStart([30, 20], 0.5)
    s().sketchDrag([30.5, 20.3], 0.5, {})
    expect(corner(2)).toEqual([30.5, 20.3])
    expect(corner(0)).toEqual([10.5, 10.3])
    s().sketchDrag([35, 23], 0.5, {})
    expect(corner(0)).toEqual([15, 13])
    s().sketchDragEnd()
    expect(corner(0)).toEqual([15, 13])
    expect(corner(2)).toEqual([35, 23])
  })

  it('goes any way by an edge, not only square to it', () => {
    sized()
    s().sketchDragStart([10, 15], 0.5)
    s().sketchDrag([6, 21], 0.5, {})
    s().sketchDragEnd()
    expect(corner(0)).toEqual([6, 16])
    expect(corner(2)).toEqual([26, 26])
  })

  it('is held where its corner is dropped on the sheet’s zero, and carried no more', () => {
    sized()
    s().sketchDragStart([10, 10], 0.5)
    s().sketchDrag([0.1, 0.1], 0.5, { datums: datumTraces(XY) })
    s().sketchDragEnd()
    expect(corner(0)).toEqual([0, 0])
    expect(s().sketchDraft!.report?.underConstrained).toEqual([])
    expect(rigidCluster(s().sketchDraft!.sketch, { entity: 2, at: 'b' })).toBeNull()
  })

  it('a shape with a freedom left is the solver’s: a corner of a bare rectangle resizes it', () => {
    s().setSketchTool('rectangle')
    s().sketchClick([10, 10], 0.01, false, RAW)
    s().sketchClick([30, 20], 0.01, false, RAW)
    s().setSketchTool('select')
    expect(rigidCluster(s().sketchDraft!.sketch, { entity: 2, at: 'b' })).toBeNull()
    s().sketchDragStart([30, 20], 0.5)
    s().sketchDrag([35, 23], 0.5, RAW)
    s().sketchDragEnd()
    const [x0, y0] = corner(0)!
    const [x2, y2] = corner(2)!
    expect([x0, y0, x2, y2].map((v) => Math.round(v * 1e3) / 1e3)).toEqual([10, 10, 35, 23])
  })
})

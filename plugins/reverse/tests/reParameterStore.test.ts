// SPDX-License-Identifier: AGPL-3.0-only
// The parameters in the Reverse engineer store: added, edited and refused;
// the features and sketches that read them following a change, with the
// rebuild and the undo step that brings both back; a number typed or a grip
// dragged letting an expression go; a rename written through; a remove
// refused while something reads the parameter. Plain zustand, no DOM.

import { beforeEach, describe, expect, it } from 'vitest'
import { lineLength } from '../core/sketch'
import { gripFieldValue, useReverse } from '../state/reStore'
import type { ExtrudeFeature, SketchFeature } from '../core/features'
import { XY } from './reKit'
import { drivenBy } from '../core/parameters'

const s = () => useReverse.getState()

/** A sketch with one closed square, its bottom side dimensioned to `expr`
 *  (or a number), finished. Returns the feature id and the dimension's. */
function finishSquare(size = 10, expr: string | null = null): { id: number; dim: number } {
  s().startSketch({ kind: 'world', axis: 'z', offset: 0 }, XY)
  s().setSketchTool('rectangle')
  s().sketchClick([0, 0], 0.5, false, { off: true })
  s().sketchClick([size, size], 0.5, false, { off: true })
  s().setSketchTool('select')
  s().sketchClick([size / 2, 0], 0.5, false, { off: true })
  s().addDimension('length', size)
  const dim = s().sketchDraft!.selectedConstraint!
  if (expr) s().setDimensionValue(dim, size, expr)
  const id = s().commitSketch()
  if (id === null) throw new Error('the square did not finish')
  return { id, dim }
}

const bottomLength = (f: SketchFeature): number => {
  const e = f.sketch.entities[0]
  return e.kind === 'line' ? lineLength(e) : NaN
}

beforeEach(() => {
  s().reset()
  useReverse.setState({ nextFeatureId: 1, nextOfKind: {}, nextParameterId: 1 })
})

describe('a round piece’s dimension', () => {
  it('goes from the radius to the diameter and back, its size and its expression held, one step each', () => {
    const bore = s().addParameter()
    s().setParameter(bore, { name: 'bore', expression: '3' })
    s().startSketch({ kind: 'world', axis: 'z', offset: 0 }, XY)
    s().setSketchTool('circle')
    s().sketchClick([0, 0], 0.5, false, { off: true })
    s().sketchClick([3, 0], 0.5, false, { off: true })
    s().setSketchTool('select')
    s().sketchClick([0, 3], 0.5, false, { off: true })
    s().addDimension('radius', 3)
    const dim = s().sketchDraft!.selectedConstraint!
    s().setDimensionValue(dim, 3, 'bore')
    const steps = s().sketchDraft!.history.length
    s().setDimensionForm(dim, 'diameter')
    const held = () => s().sketchDraft!.sketch.constraints.find((c) => c.id === dim)
    expect(held()).toMatchObject({ kind: 'diameter', value: 6, expr: '2 * (bore)' })
    expect(s().sketchDraft!.history.length).toBe(steps + 1)
    // Typed with its letter: Ø10 over a Ø, R4 over it — the value with it.
    s().setDimensionForm(dim, 'radius', 4, null)
    expect(held()).toMatchObject({ kind: 'radius', value: 4 })
    expect(held()).not.toHaveProperty('expr')
    const circle = s().sketchDraft!.sketch.entities.find((e) => e.kind === 'circle')
    expect(circle?.kind === 'circle' && circle.r).toBeCloseTo(4, 6)
    s().setDimensionForm(dim, 'diameter')
    expect(held()).toMatchObject({ kind: 'diameter', value: 8 })
  })
})

describe('the parameter list', () => {
  it('adds a parameter at zero, named in turn, and takes its name, kind and expression', () => {
    const id = s().addParameter()
    expect(s().parameters).toEqual([{ id, name: 'p1', kind: 'length', expression: '0' }])
    expect(s().parameterTable.readings[0]).toMatchObject({ value: 0, error: null })
    expect(s().addParameter('integer')).toBe(id + 1)
    expect(s().parameters[1]).toMatchObject({ name: 'p2', kind: 'integer' })
    expect(s().setParameter(id, { name: 'height', expression: '25.4 / 2' })).toBeNull()
    expect(s().parameters[0]).toMatchObject({ name: 'height', expression: '25.4 / 2' })
    expect(s().parameterTable.readings[0].value).toBeCloseTo(12.7)
    expect(s().setParameter(id + 1, { name: 'count', expression: 'round(height / 2 mm)', comment: 'how many' })).toBeNull()
    expect(s().parameterTable.readings[1]).toMatchObject({ value: 6, error: null })
    expect(s().parameters[1]).toMatchObject({ comment: 'how many' })
  })

  it('refuses what will not do and changes nothing', () => {
    const id = s().addParameter()
    s().setParameter(id, { name: 'width', expression: '40' })
    const before = s().parameters
    expect(s().setParameter(id, { name: 'sin' })).toContain('keep')
    expect(s().setParameter(id, { name: '2w' })).toContain('a letter or an underscore')
    expect(s().setParameter(id, { expression: 'nothing + 1' })).toBe('there is no parameter “nothing”')
    expect(s().setParameter(id, { expression: '1 /' })).toContain('expected')
    expect(s().setParameter(id, { kind: 'integer', expression: '7.3' })).toContain('not whole')
    expect(s().parameters).toBe(before)
    // An edit that would leave another parameter without a value is refused too.
    const other = s().addParameter()
    expect(s().setParameter(other, { name: 'half', expression: 'width / 2' })).toBeNull()
    expect(s().setParameter(id, { kind: 'angle' })).toContain('would leave “half” with no value')
    expect(s().parameters[0]).toMatchObject({ kind: 'length' })
    // A refused edit is no undo step: two adds and two edits.
    expect(s().past).toHaveLength(4)
  })

  it('refuses a remove while anything reads the parameter', () => {
    const id = s().addParameter()
    s().setParameter(id, { name: 'width', expression: '40' })
    const half = s().addParameter()
    s().setParameter(half, { name: 'half', expression: 'width / 2' })
    expect(s().removeParameter(id)).toContain('half')
    expect(s().removeParameter(half)).toBeNull()
    expect(s().removeParameter(id)).toBeNull()
    expect(s().parameters).toEqual([])
  })
})

describe('a feature reading a parameter', () => {
  it('follows the parameter, rebuilds, and comes back with it on undo', () => {
    const height = s().addParameter()
    s().setParameter(height, { name: 'height', expression: '20' })
    const { id: sketch } = finishSquare()
    s().startExtrude(sketch)
    s().setExtrude({ extent: { kind: 'distance', from: 0, to: 25 } })
    s().setDraftExpr('extent.to', 'height + 5')
    expect(s().extrudeDraft?.exprs).toEqual({ 'extent.to': 'height + 5' })
    const id = s().commitExtrude()!
    const feature = () => s().features.find((f) => f.id === id) as ExtrudeFeature
    expect(feature()).toMatchObject({ extent: { to: 25 }, exprs: { 'extent.to': 'height + 5' } })
    const built = s().buildVersion
    expect(s().setParameter(height, { expression: '30' })).toBeNull()
    expect(feature().extent).toEqual({ kind: 'distance', from: 0, to: 35 })
    expect(s().buildVersion).toBe(built + 1)
    // A change that moves no number asks for no rebuild.
    s().setParameter(height, { comment: 'the boss' })
    expect(s().buildVersion).toBe(built + 1)
    // Undo takes the parameter and the number back together; redo brings both.
    s().undoFeatures()
    s().undoFeatures()
    expect(s().parameters[0]).toMatchObject({ expression: '20' })
    expect(s().parameterTable.readings[0].value).toBe(20)
    expect(feature().extent).toEqual({ kind: 'distance', from: 0, to: 25 })
    s().redoFeatures()
    expect(feature().extent).toEqual({ kind: 'distance', from: 0, to: 35 })
    expect(s().parameterTable.readings[0].value).toBe(30)
  })

  it('reopens with its expression, and lets it go for a number typed or a grip dragged', () => {
    const height = s().addParameter()
    s().setParameter(height, { name: 'height', expression: '20' })
    const { id: sketch } = finishSquare()
    s().startExtrude(sketch)
    s().setExtrude({ extent: { kind: 'distance', from: 0, to: 20 } })
    s().setDraftExpr('extent.to', 'height')
    const id = s().commitExtrude()!
    s().editExtrude(id)
    expect(s().extrudeDraft?.exprs).toEqual({ 'extent.to': 'height' })
    expect(gripFieldValue({ ...s(), gripField: 'extrudeTo' })).toEqual({ value: 20, unit: 'mm', expr: 'height' })
    // A plain number typed in the box.
    s().setDraftExpr('extent.to', null)
    expect(s().extrudeDraft?.exprs).toBeUndefined()
    s().setDraftExpr('extent.to', 'height')
    // The arrow dragged.
    s().gripDrag('extrudeTo', 0, 'start')
    s().gripDrag('extrudeTo', 5, 'move')
    s().gripDrag('extrudeTo', 5, 'end')
    expect(s().extrudeDraft?.extent).toEqual({ kind: 'distance', from: 0, to: 25 })
    expect(s().extrudeDraft?.exprs).toBeUndefined()
    s().setDraftExpr('extent.to', 'height')
    // The number typed on the grip.
    s().setGripValue('extrudeTo', 30)
    expect(s().extrudeDraft?.exprs).toBeUndefined()
    s().setDraftExpr('extent.to', 'height')
    s().commitExtrude()
    expect((s().features.find((f) => f.id === id) as ExtrudeFeature).exprs).toEqual({ 'extent.to': 'height' })
    // The row's number typed over.
    s().setKeyParameter(id, 12)
    expect(s().features.find((f) => f.id === id)).toMatchObject({ extent: { to: 12 } })
    expect((s().features.find((f) => f.id === id) as ExtrudeFeature).exprs).toBeUndefined()
    // A parameter nothing reads any more can go.
    expect(s().removeParameter(height)).toBeNull()
  })

  it('is named when its parameter is to be removed, and follows a rename', () => {
    const height = s().addParameter()
    s().setParameter(height, { name: 'height', expression: '20' })
    const { id: sketch } = finishSquare()
    s().startExtrude(sketch)
    s().setDraftExpr('extent.to', 'height * 2')
    expect(s().removeParameter(height)).toContain('the feature being set up')
    expect(s().setParameter(height, { name: 'h' })).toBeNull()
    expect(s().extrudeDraft?.exprs).toEqual({ 'extent.to': 'h * 2' })
    const id = s().commitExtrude()!
    expect(s().removeParameter(height)).toContain('Extrude 1')
    expect(s().setParameter(height, { name: 'tall' })).toBeNull()
    expect((s().features.find((f) => f.id === id) as ExtrudeFeature).exprs).toEqual({ 'extent.to': 'tall * 2' })
    expect(s().features.find((f) => f.id === id)).toMatchObject({ extent: { to: 40 } })
  })
})

describe('a sketch dimension reading a parameter', () => {
  it('is solved again when the parameter changes, the features on the sketch keeping their regions', () => {
    const width = s().addParameter()
    s().setParameter(width, { name: 'width', expression: '10' })
    const { id: sketchId, dim } = finishSquare(10, 'width')
    const sketch = () => s().features.find((f) => f.id === sketchId) as SketchFeature
    expect(sketch().sketch.constraints.find((c) => c.id === dim)).toMatchObject({ value: 10, expr: 'width' })
    s().startExtrude(sketchId)
    const extrude = s().commitExtrude()!
    const regions = (s().features.find((f) => f.id === extrude) as ExtrudeFeature).regions
    expect(regions).toHaveLength(1)
    const built = s().buildVersion
    expect(s().setParameter(width, { expression: '30' })).toBeNull()
    expect(bottomLength(sketch())).toBeCloseTo(30, 6)
    expect(sketch().sketch.constraints.find((c) => c.id === dim)).toMatchObject({ value: 30 })
    expect(s().buildVersion).toBe(built + 1)
    expect((s().features.find((f) => f.id === extrude) as ExtrudeFeature).regions).toHaveLength(1)
    expect(s().removeParameter(width)).toContain('Sketch 1')
    s().undoFeatures()
    expect(bottomLength(sketch())).toBeCloseTo(10, 6)
  })

  it('follows the parameter while the sketch is open, as a step of the sketch’s own history', () => {
    const width = s().addParameter()
    s().setParameter(width, { name: 'width', expression: '10' })
    s().startSketch({ kind: 'world', axis: 'z', offset: 0 }, XY)
    s().setSketchTool('rectangle')
    s().sketchClick([0, 0], 0.5, false, { off: true })
    s().sketchClick([10, 10], 0.5, false, { off: true })
    s().setSketchTool('select')
    s().sketchClick([5, 0], 0.5, false, { off: true })
    s().addDimension('length', 10)
    const dim = s().sketchDraft!.selectedConstraint!
    s().setDimensionValue(dim, 10, 'width')
    const steps = s().sketchDraft!.history.length
    // A plain number typed over lets the expression go.
    s().setDimensionValue(dim, 10, null)
    expect(s().sketchDraft!.sketch.constraints.find((c) => c.id === dim)).not.toHaveProperty('expr')
    s().setDimensionValue(dim, 10, 'width')
    expect(s().removeParameter(width)).toContain('the sketch being drawn')
    expect(s().setParameter(width, { expression: '20' })).toBeNull()
    const d = s().sketchDraft!
    const bottom = d.sketch.entities[0]
    expect(bottom.kind === 'line' && lineLength(bottom)).toBeCloseTo(20, 6)
    expect(d.history).toHaveLength(steps + 3)
    s().undoSketch()
    const back = s().sketchDraft!.sketch.entities[0]
    expect(back.kind === 'line' && lineLength(back)).toBeCloseTo(10, 6)
    // A rename reaches into the open sketch.
    expect(s().setParameter(width, { name: 'w' })).toBeNull()
    expect(s().sketchDraft!.sketch.constraints.find((c) => c.id === dim)).toMatchObject({ expr: 'w' })
  })
})

describe('what a parameter drives, and one marked important (issue 21)', () => {
  it('drives the sketch whose dimension reads it and the extrude on that sketch, and through another parameter an extrude’s depth', () => {
    const w = s().addParameter()
    s().setParameter(w, { name: 'w', expression: '10' })
    const deep = s().addParameter()
    s().setParameter(deep, { name: 'deep', expression: 'w / 2' })
    const idle = s().addParameter()
    s().setParameter(idle, { name: 'spare', expression: '3' })
    const { id: square } = finishSquare(10, 'w')
    s().startExtrude(square)
    s().setExtrude({ extent: { kind: 'distance', from: 0, to: 5 } })
    s().setDraftExpr('extent.to', 'deep')
    const extrude = s().commitExtrude()!
    const { id: other } = finishSquare(4)
    s().startExtrude(other)
    s().setExtrude({ extent: { kind: 'distance', from: 0, to: 2 } })
    const plain = s().commitExtrude()!
    const all = [...s().features]
    // w: the square's dimension, so the square and the extrude on it — and
    // the depth through deep.
    expect(drivenBy('w', s().parameters, all).sort()).toEqual([square, extrude].sort())
    expect(drivenBy('deep', s().parameters, all)).toEqual([extrude])
    expect(drivenBy('spare', s().parameters, all)).toEqual([])
    expect(drivenBy('w', s().parameters, all)).not.toContain(plain)
  })

  it('is marked important and back, a step each, and lit while pointed at without a step', () => {
    const a = s().addParameter()
    s().setParameter(a, { name: 'a', expression: '1' })
    const past = s().past.length
    expect(s().setParameter(a, { pinned: true })).toBeNull()
    expect(s().parameters[0].pinned).toBe(true)
    expect(s().past.length).toBe(past + 1)
    expect(s().setParameter(a, { pinned: false })).toBeNull()
    expect('pinned' in s().parameters[0]).toBe(false)
    s().setParameterLit(a)
    expect(s().parameterLit).toBe(a)
    expect(s().past.length).toBe(past + 2)
    s().setParameterLit(null)
    expect(s().parameterLit).toBeNull()
  })
})

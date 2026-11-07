// SPDX-License-Identifier: AGPL-3.0-only
// The Reverse engineer store: the undo stack over the feature list, the
// sketch's exits, and the paths from a sketch straight into a feature.
// Plain zustand, no DOM.

import { beforeEach, describe, expect, it } from 'vitest'
import { datumTraces } from '../core/datums'
import { addEntity, emptySketch, fixedEntityOf, fixedPieces, fixId } from '../core/sketch'
import type { SectionFrame } from '../../../src/core/section/frame'
import { coordinatePlaneShown, editingFeatureId, featuresToBuild, gripFieldValue, nameBodies, sketchHoverAt, useReverse, withKeyParameter } from '../state/reStore'
import { islandId } from '../core/features'
import { useStore } from '../../../src/state/store'
import { XY } from './reKit'

const s = () => useReverse.getState()

/** A sketch with one closed square, finished. Returns its feature id. */
function finishSquare(size = 10): number {
  s().startSketch({ kind: 'world', axis: 'z', offset: 0 }, XY)
  s().setSketchTool('rectangle')
  s().sketchClick([0, 0], 0.5, false, { off: true })
  s().sketchClick([size, size], 0.5, false, { off: true })
  const id = s().commitSketch()
  if (id === null) throw new Error('the square did not finish')
  return id
}

beforeEach(() => {
  useReverse.setState({
    features: [],
    rolledBack: [],
    featureDraft: null,
    nextFeatureId: 1,
    nextOfKind: {},
    results: {},
    bodies: [],
    sketchDraft: null,
    extrudeDraft: null,
    revolveDraft: null,
    past: [],
    future: [],
    selection: null,
    gripField: null,
    buildVersion: 0,
  })
})

describe('feature undo', () => {
  it('takes a finished sketch back and brings it again', () => {
    finishSquare()
    expect(s().features).toHaveLength(1)
    expect(s().canUndo()).toBe(true)
    expect(s().canRedo()).toBe(false)
    s().undoFeatures()
    expect(s().features).toHaveLength(0)
    expect(s().canRedo()).toBe(true)
    s().redoFeatures()
    expect(s().features).toHaveLength(1)
    expect(s().features[0].name).toBe('Sketch 1')
  })

  it('restores the names and ids the list had, so a redone feature is the same feature', () => {
    const id = finishSquare()
    s().startExtrude(id)
    const eid = s().commitExtrude()
    expect(eid).not.toBeNull()
    expect(s().features.map((f) => f.id)).toEqual([id, eid])
    s().undoFeatures()
    s().undoFeatures()
    expect(s().features).toHaveLength(0)
    expect(s().nextFeatureId).toBe(1)
    s().redoFeatures()
    s().redoFeatures()
    expect(s().features.map((f) => f.id)).toEqual([id, eid])
    expect(s().nextFeatureId).toBe(eid! + 1)
    expect(s().features[1].name).toBe('Extrude 1')
  })

  it('a new commit after an undo drops what could have been redone', () => {
    finishSquare()
    s().undoFeatures()
    expect(s().canRedo()).toBe(true)
    finishSquare(20)
    expect(s().canRedo()).toBe(false)
    expect(s().features).toHaveLength(1)
  })

  it('undoes a removal and a visibility toggle', () => {
    const id = finishSquare()
    s().toggleFeatureVisible(id)
    expect(s().features[0].visible).toBe(false)
    s().undoFeatures()
    expect(s().features[0].visible).toBe(true)
    s().removeFeature(id)
    expect(s().features).toHaveLength(0)
    s().undoFeatures()
    expect(s().features).toHaveLength(1)
  })

  it('hides the sketch a new extrude used, the undo showing it again, an edit leaving the eye alone', () => {
    const id = finishSquare()
    s().startExtrude(id)
    const eid = s().commitExtrude()!
    expect(s().features[0].visible).toBe(false)
    s().undoFeatures()
    expect(s().features[0].visible).toBe(true)
    s().redoFeatures()
    s().toggleFeatureVisible(id)
    expect(s().features[0].visible).toBe(true)
    s().editExtrude(eid)
    s().commitExtrude()
    expect(s().features[0].visible).toBe(true)
  })

  it('hides a sketch an edit takes on — a station added to a loft, an extrude moved onto another sketch — as a new feature’s', () => {
    const a = finishSquare(), b = finishSquare(20)
    s().startFeature('loft', { sketches: [a, b] })
    const loft = s().commitFeature()!
    expect(s().features.filter((f) => f.kind === 'sketch').map((f) => f.visible)).toEqual([false, false])
    // A station drawn after, shown as it is drawn, taken into the loft.
    const c = finishSquare(30)
    s().toggleFeatureVisible(a)
    s().editFeature(loft)
    s().setFeatureDraft({ sketches: [a, b, c] })
    s().commitFeature()
    const shown = () => Object.fromEntries(s().features.filter((f) => f.kind === 'sketch').map((f) => [f.id, f.visible]))
    // The one it had all along, shown by the person, stays shown.
    expect(shown()).toEqual({ [a]: true, [b]: false, [c]: false })
    // An extrude moved onto another sketch: that one is put away.
    const d = finishSquare(40)
    s().startExtrude(a)
    const eid = s().commitExtrude()!
    s().editExtrude(eid)
    s().setExtrude({ sketchId: d })
    s().commitExtrude()
    expect(shown()[d]).toBe(false)
  })

  it('closes an open feature editor rather than leaving it on a list that changed under it', () => {
    const id = finishSquare()
    s().startExtrude(id)
    expect(s().extrudeDraft).not.toBeNull()
    s().undoFeatures()
    expect(s().extrudeDraft).toBeNull()
    expect(s().features).toHaveLength(0)
  })

  it('asks for a rebuild', () => {
    const before = s().buildVersion
    finishSquare()
    const after = s().buildVersion
    expect(after).toBeGreaterThan(before)
    s().undoFeatures()
    expect(s().buildVersion).toBeGreaterThan(after)
  })

  it('does nothing with nothing to undo', () => {
    s().undoFeatures()
    s().redoFeatures()
    expect(s().features).toHaveLength(0)
    expect(s().canUndo()).toBe(false)
  })
})

describe('a sketch started on a plane by reference', () => {
  it('opens on a measured plane where it stands, and refuses one that is gone', () => {
    const fit = { kind: 'plane' as const, center: [0, 0, 7] as [number, number, number], normal: [0, 0, 1] as [number, number, number], sigma: 0, usedPoints: 0, regionSize: 0 }
    useStore.setState({ elements: [{ id: 4, kind: 'plane', name: 'Plane 1', color: '#888', source: { type: 'picked' }, status: 'done', visible: true, fit }] as never })
    s().setSelection({ kind: 'element', id: 4, name: 'Plane 1', at: { x: 0, y: 0 } })
    expect(s().startSketchOn({ kind: 'plane', id: 4 })).toBe(true)
    const d = s().sketchDraft!
    expect(d.plane).toEqual({ kind: 'plane', id: 4 })
    expect(d.frame.origin[2]).toBeCloseTo(7)
    expect(s().selection).toBeNull()
    s().discardSketch()
    expect(s().startSketchOn({ kind: 'plane', id: 99 })).toBe(false)
    expect(s().sketchDraft).toBeNull()
    useStore.setState({ elements: [] })
  })
})

describe('a Fix among the relations', () => {
  it('is selected and removed as a relation is, and comes back on undo', () => {
    s().startSketch({ kind: 'world', axis: 'z', offset: 0 }, XY)
    s().setSketchTool('line')
    s().sketchClick([0, 0], 0.01, false, { off: true })
    s().sketchClick([10, 3], 0.01, false, { off: true })
    s().setSketchTool('select')
    const line = s().sketchDraft!.sketch.entities[0].id
    s().sketchClick([5, 1.5], 0.5, false)
    s().toggleFixedSelected()
    expect(fixedPieces(s().sketchDraft!.sketch).map((e) => e.id)).toEqual([line])
    // Its glyph or its row clicked selects it; Delete takes it off.
    s().selectConstraint(fixId(line))
    expect(fixedEntityOf(s().sketchDraft!.selectedConstraint!)).toBe(line)
    s().removeSelectedConstraint()
    expect(fixedPieces(s().sketchDraft!.sketch)).toEqual([])
    expect(s().sketchDraft!.sketch.entities).toHaveLength(1)
    expect(s().sketchDraft!.selectedConstraint).toBeNull()
    s().undoSketch()
    expect(fixedPieces(s().sketchDraft!.sketch).map((e) => e.id)).toEqual([line])
  })
})

describe('a selection box', () => {
  const box = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]

  it('takes a window’s pieces or a crossing box’s in place of the selection, or adds them with Ctrl, and only with the Select tool', () => {
    s().startSketch({ kind: 'world', axis: 'z', offset: 0 }, XY)
    s().setSketchTool('rectangle')
    s().sketchClick([0, 0], 0.5, false, { off: true })
    s().sketchClick([10, 10], 0.5, false, { off: true })
    s().setSketchTool('line')
    s().sketchClick([20, 0], 0.01, false, { off: true })
    s().sketchClick([30, 0], 0.01, false, { off: true })
    s().setSketchTool('select')
    const pieces = s().sketchDraft!.sketch.entities
    const square = pieces.filter((e) => e.kind === 'line' && Math.max(e.a[0], e.b[0]) < 15).map((e) => e.id)
    const lone = pieces.find((e) => e.kind === 'line' && e.a[0] > 15)!.id
    expect(square).toHaveLength(4)

    // Rightward round the square: its four sides, not the lone line.
    s().sketchBoxSelect(box(-1, -1, 11, 11), false, false)
    expect(s().sketchDraft!.selection).toEqual(square)
    // Leftward over the square's foot and the lone line: the bottom and the
    // right side it touches, and the lone line, in place of the four.
    s().sketchBoxSelect(box(5, -1, 25, 1), true, false)
    expect(s().sketchDraft!.selection).toHaveLength(3)
    expect(s().sketchDraft!.selection).toContain(lone)
    // Ctrl adds the square's other two sides, once each.
    s().sketchBoxSelect(box(-1, -1, 11, 11), false, true)
    expect([...s().sketchDraft!.selection].sort()).toEqual([...square, lone].sort())
    // A drawing tool in hand takes no box.
    s().setSketchTool('line')
    s().sketchBoxSelect(box(-100, -100, 100, 100), false, false)
    expect(s().sketchDraft!.selection).toHaveLength(5)
    // An empty window clears the selection.
    s().setSketchTool('select')
    s().sketchBoxSelect(box(50, 50, 60, 60), false, false)
    expect(s().sketchDraft!.selection).toEqual([])
  })
})

describe('the sketch’s exits', () => {
  it('Finish on an empty sketch creates nothing and closes the box', () => {
    s().startSketch({ kind: 'world', axis: 'z', offset: 0 }, XY)
    expect(s().commitSketch()).toBeNull()
    expect(s().sketchDraft).toBeNull()
    expect(s().features).toHaveLength(0)
    expect(s().canUndo()).toBe(false)
  })

  it('a discarded new sketch is Finish then Undo', () => {
    finishSquare()
    s().undoFeatures()
    expect(s().features).toHaveLength(0)
    expect(s().sketchDraft).toBeNull()
  })
})

describe('from the sketch into a feature', () => {
  it('Extrude in the sketch box finishes the sketch and opens the extrude with its one region picked', () => {
    s().startSketch({ kind: 'world', axis: 'z', offset: 0 }, XY)
    s().setSketchTool('rectangle')
    s().sketchClick([0, 0], 0.5, false, { off: true })
    s().sketchClick([10, 10], 0.5, false, { off: true })
    expect(s().sketchDraft?.found).toHaveLength(1)
    s().finishAndExtrude()
    expect(s().sketchDraft).toBeNull()
    expect(s().features).toHaveLength(1)
    const d = s().extrudeDraft
    expect(d?.sketchId).toBe(s().features[0].id)
    expect(d?.regions).toHaveLength(1)
  })

  it('with several regions the sketch keys pick them all — the panel’s keys leave the choice on the part', () => {
    const twoSquares = () => {
      s().startSketch({ kind: 'world', axis: 'z', offset: 0 }, XY)
      s().setSketchTool('rectangle')
      s().sketchClick([0, 0], 0.5, false, { off: true })
      s().sketchClick([10, 10], 0.5, false, { off: true })
      s().sketchClick([20, 0], 0.5, false, { off: true })
      s().sketchClick([30, 10], 0.5, false, { off: true })
      expect(s().sketchDraft?.found).toHaveLength(2)
    }
    twoSquares()
    s().finishAndRevolve()
    expect(s().revolveDraft?.regions).toHaveLength(2)
    expect(s().revolveDraft?.sketchId).toBe(s().features[0].id)
    s().cancelRevolve()
    twoSquares()
    s().finishAndExtrude()
    const sketch = s().features[1].id
    expect(s().extrudeDraft?.sketchId).toBe(sketch)
    expect(s().extrudeDraft?.regions).toHaveLength(2)
    s().cancelExtrude()
    s().startExtrude(sketch)
    expect(s().extrudeDraft?.regions).toHaveLength(0)
  })

  it('Cut chosen turns the extrude the other way, and back out of Cut turns it again', () => {
    const id = finishSquare()
    s().startExtrude(id)
    s().setExtrude({ extent: { kind: 'distance', from: -1, to: 10 } })
    s().setExtrudeOp('cut')
    expect(s().extrudeDraft?.op).toBe('cut')
    expect(s().extrudeDraft?.extent).toEqual({ kind: 'distance', from: 1, to: -10 })
    s().setExtrudeOp('join')
    expect(s().extrudeDraft?.extent).toEqual({ kind: 'distance', from: -1, to: 10 })
    // Join to a body of its own goes the same way.
    s().setExtrudeOp('new')
    expect(s().extrudeDraft?.extent).toEqual({ kind: 'distance', from: -1, to: 10 })
    // To next and to last look the other way.
    s().setExtrude({ extent: { kind: 'toNext', from: 0 } })
    s().setExtrudeOp('cut')
    expect(s().extrudeDraft?.extent).toEqual({ kind: 'toNext', from: 0, reverse: true })
    // A command's op names its extent with it: nothing turns.
    s().setExtrude({ op: 'join', extent: { kind: 'distance', from: 0, to: 5 } })
    s().setExtrude({ op: 'cut' })
    expect(s().extrudeDraft?.extent).toEqual({ kind: 'distance', from: 0, to: 5 })
  })

  it('a region chip opens the extrude on that region of that sketch', () => {
    const id = finishSquare()
    const key = s().features[0].kind === 'sketch' ? undefined : undefined
    void key
    s().startExtrude(id, ['nope'])
    expect(s().extrudeDraft?.sketchId).toBe(id)
    expect(s().extrudeDraft?.regions).toEqual(['nope'])
  })

  it('an element chip opens the revolve with the axis set', () => {
    finishSquare()
    s().startRevolve(null, null, { kind: 'element', id: 7 })
    expect(s().revolveDraft?.axis).toEqual({ kind: 'element', id: 7 })
    expect(s().revolveDraft?.sketchId).toBe(s().features[0].id)
    expect(s().revolveDraft?.regions).toHaveLength(1)
  })
})

describe('inferred relations', () => {
  it('a line drawn within 3° of the sheet’s X gets a horizontal it can shed', () => {
    s().startSketch({ kind: 'world', axis: 'z', offset: 0 }, XY)
    s().setSketchTool('line')
    s().sketchClick([0, 0], 0.5, false, { off: true })
    s().sketchClick([10, 0.3], 0.5, false, { off: true })
    const d = s().sketchDraft!
    const h = d.sketch.constraints.find((c) => c.kind === 'horizontal')
    expect(h).toBeDefined()
    expect(h?.inferred).toBe(true)
    // Met exactly: the line is level after the solve.
    const line = d.sketch.entities[0]
    if (line.kind !== 'line') throw new Error('not a line')
    expect(Math.abs(line.a[1] - line.b[1])).toBeLessThan(1e-6)
    s().selectConstraint(h!.id)
    s().removeSelectedConstraint()
    expect(s().sketchDraft!.sketch.constraints.some((c) => c.kind === 'horizontal')).toBe(false)
  })

  it('a line well off both axes gets none', () => {
    s().startSketch({ kind: 'world', axis: 'z', offset: 0 }, XY)
    s().setSketchTool('line')
    s().sketchClick([0, 0], 0.5, false, { off: true })
    s().sketchClick([10, 3], 0.5, false, { off: true })
    expect(s().sketchDraft!.sketch.constraints).toHaveLength(0)
  })
})

describe('the rollback bar', () => {
  it('sets the features below it aside, and what is made next goes in at the bar', () => {
    const sketch = finishSquare()
    s().startExtrude(sketch)
    const extrude = s().commitExtrude()!
    const second = finishSquare(4)
    expect(s().features.map((f) => f.id)).toEqual([sketch, extrude, second])
    const built = s().buildVersion
    s().rollTo(1)
    expect(s().features.map((f) => f.id)).toEqual([sketch])
    expect(s().rolledBack.map((f) => f.id)).toEqual([extrude, second])
    expect(s().buildVersion).toBeGreaterThan(built)
    // Not an undo step: nothing of the model changed.
    const steps = s().past.length
    const inserted = finishSquare(2)
    expect(s().past.length).toBe(steps + 1)
    expect(s().features.map((f) => f.id)).toEqual([sketch, inserted])
    s().rollTo(null)
    expect(s().features.map((f) => f.id)).toEqual([sketch, inserted, extrude, second])
    expect(s().rolledBack).toHaveLength(0)
  })

  it('travels with undo, keeps a feature others below it stand on, and stands still under an open editor', () => {
    const sketch = finishSquare()
    s().startExtrude(sketch)
    s().commitExtrude()
    s().rollTo(1)
    // The extrude below the bar is built on the sketch.
    s().removeFeature(sketch)
    expect(s().features).toHaveLength(1)
    finishSquare(3)
    s().undoFeatures()
    expect(s().features).toHaveLength(1)
    expect(s().rolledBack).toHaveLength(1)
    s().startSketch({ kind: 'world', axis: 'z', offset: 0 }, XY)
    s().rollTo(null)
    expect(s().rolledBack).toHaveLength(1)
    expect(s().sketchDraft).not.toBeNull()
    s().discardSketch()
    s().rollTo(0)
    expect(s().features).toHaveLength(0)
    expect(s().rolledBack).toHaveLength(2)
  })
})

describe('a feature reopened for editing', () => {
  it('is built without itself and what came after, and the part comes forward again when the box closes', () => {
    const sketch = finishSquare()
    s().startExtrude(sketch)
    const extrude = s().commitExtrude()!
    const second = finishSquare(4)
    s().startExtrude(second)
    const third = s().commitExtrude()!
    expect(featuresToBuild(s()).map((f) => f.id)).toEqual([sketch, extrude, second, third])
    const built = s().buildVersion
    s().editExtrude(extrude)
    expect(editingFeatureId(s())).toBe(extrude)
    expect(featuresToBuild(s()).map((f) => f.id)).toEqual([sketch])
    expect(s().buildVersion).toBeGreaterThan(built)
    const opened = s().buildVersion
    s().cancelExtrude()
    expect(editingFeatureId(s())).toBeNull()
    expect(featuresToBuild(s()).map((f) => f.id)).toEqual([sketch, extrude, second, third])
    expect(s().buildVersion).toBeGreaterThan(opened)
    // A sketch reopened rolls the part back to before it as well.
    s().editSketch(second)
    expect(featuresToBuild(s()).map((f) => f.id)).toEqual([sketch, extrude])
    s().discardSketch()
    expect(featuresToBuild(s())).toHaveLength(4)
  })

  it('leaves a sketch closed with nothing done exactly as it was: the same list to build, and no undo step', () => {
    const sketch = finishSquare()
    s().startExtrude(sketch)
    s().commitExtrude()
    const features = s().features
    const past = s().past.length
    s().editSketch(sketch)
    // A tool picked up and a drawing begun and taken back are no change.
    s().setSketchTool('rectangle')
    s().sketchClick([20, 0], 0.5, false, { off: true })
    s().sketchClick([25, 5], 0.5, false, { off: true })
    s().undoSketch()
    const opened = s().buildVersion
    expect(s().commitSketch()).toBe(sketch)
    expect(s().sketchDraft).toBeNull()
    expect(s().features).toBe(features)
    expect(featuresToBuild(s())).toBe(features)
    expect(s().past).toHaveLength(past)
    expect(s().buildVersion).toBeGreaterThan(opened)
    // A new name is a change, and so is a piece drawn.
    s().editSketch(sketch)
    s().setSketchName('Base')
    s().commitSketch()
    expect(s().features[0].name).toBe('Base')
    expect(s().past).toHaveLength(past + 1)
    s().editSketch(sketch)
    s().setSketchTool('rectangle')
    s().sketchClick([20, 0], 0.5, false, { off: true })
    s().sketchClick([25, 5], 0.5, false, { off: true })
    s().commitSketch()
    const kept = s().features[0]
    expect(kept.kind === 'sketch' && kept.sketch.entities.length).toBe(8)
    expect(s().past).toHaveLength(past + 2)
  })

  it('does not roll back while a new feature is set up', () => {
    const sketch = finishSquare()
    s().startExtrude(sketch)
    expect(editingFeatureId(s())).toBeNull()
    expect(featuresToBuild(s()).map((f) => f.id)).toEqual([sketch])
  })
})

describe('an extrude’s end through a point on the part', () => {
  it('puts To at a point in front of the sketch plane and From at one behind it, in either order', () => {
    const sketch = finishSquare()
    s().startExtrude(sketch)
    expect(s().extrudeToPoint([3, 3, 17.456])).toMatch(/^To = 17\.46/)
    expect(s().extrudeDraft?.extent).toEqual({ kind: 'distance', from: 0, to: 17.46 })
    expect(s().extrudeToPoint([50, -20, -6])).toMatch(/^From = -6\.00.*behind the sketch plane/)
    expect(s().extrudeDraft?.extent).toEqual({ kind: 'distance', from: -6, to: 17.46 })
    // The bottom first, then the top: the same body.
    s().setExtrude({ extent: { kind: 'distance', from: 0, to: 10 } })
    expect(s().extrudeToPoint([0, 0, -6])).toMatch(/^From = -6\.00/)
    expect(s().extrudeToPoint([0, 0, 17.456])).toMatch(/^To = 17\.46/)
    expect(s().extrudeDraft?.extent).toEqual({ kind: 'distance', from: -6, to: 17.46 })
  })

  it('says why a click gave nothing, and sets the start of an extent that ends on the part', () => {
    const sketch = finishSquare()
    s().startExtrude(sketch)
    // A point on the plane, with From on it: To would meet From.
    expect(s().extrudeToPoint([0, 0, 0])).toMatch(/no height/)
    s().setExtrude({ extent: { kind: 'toLast', from: 0 } })
    expect(s().extrudeToPoint([0, 0, 5])).toMatch(/^From = 5\.00/)
    expect(s().extrudeToPoint([0, 0, -5])).toMatch(/^From = -5\.00/)
  })
})

describe('Coincident in the sketch', () => {
  const sk = () => s().sketchDraft!

  it('takes an end then a line, a line then a coordinate plane’s line, and two ends — as CAD does', () => {
    s().startSketch({ kind: 'world', axis: 'z', offset: 0 }, XY)
    s().setSketchTool('line')
    s().sketchClick([5, 10], 0.5, false, { off: true })
    s().sketchClick([25, 12], 0.5, false, { off: true })
    s().sketchClick([25, 12], 0.5, false, { off: true })
    s().setSketchTool('line')
    s().sketchClick([0, 30], 0.5, false, { off: true })
    s().sketchClick([40, 30], 0.5, false, { off: true })
    s().sketchClick([40, 30], 0.5, false, { off: true })
    const [first, second] = sk().sketch.entities.map((e) => e.id)
    // An end onto a line: the point lies on it.
    s().armRelation('coincident')
    s().sketchClick([5, 10], 0.5, false)
    expect(sk().relPicks).toEqual([{ kind: 'point', anchor: { entity: first, at: 'a' } }])
    s().sketchClick([20, 30], 0.5, false)
    expect(sk().relPicks).toEqual([])
    const on = sk().sketch.constraints.find((c) => c.kind === 'pointOn')
    expect(on && on.kind === 'pointOn' && on.on).toEqual({ line: second })
    expect(sk().report?.ok).toBe(true)
    // Both pieces are free, so both moved to meet: the end lies on the
    // line wherever the two settled.
    const end = (sk().sketch.entities[0] as { a: [number, number] }).a
    const other = sk().sketch.entities[1] as { a: [number, number]; b: [number, number] }
    const dir = [other.b[0] - other.a[0], other.b[1] - other.a[1]]
    const off = ((end[0] - other.a[0]) * -dir[1] + (end[1] - other.a[1]) * dir[0]) / Math.hypot(dir[0], dir[1])
    expect(off).toBeCloseTo(0, 5)
    // The relation stays in hand: a line onto the YZ plane's line (x = 0),
    // the line clicked in its middle where it settled.
    expect(sk().tool).toBe('relation')
    s().sketchClick([(other.a[0] + other.b[0]) / 2, (other.a[1] + other.b[1]) / 2], 0.5, false)
    expect(sk().relPicks).toEqual([{ kind: 'piece', id: second }])
    s().sketchClick([0, 50], 0.5, false)
    const along = sk().sketch.constraints.find((c) => c.kind === 'collinear')
    expect(along && along.kind === 'collinear' && along.on).toEqual({ datum: 'yz' })
    expect((sk().sketch.entities[1] as { a: [number, number]; b: [number, number] }).b[0]).toBeCloseTo(0, 6)
    // Two round pieces are refused with a reason, and the picks let go.
    s().setSketchTool('circle')
    s().sketchClick([60, 60], 0.5, false, { off: true })
    s().sketchClick([65, 60], 0.5, false, { off: true })
    s().setSketchTool('circle')
    s().sketchClick([80, 60], 0.5, false, { off: true })
    s().sketchClick([83, 60], 0.5, false, { off: true })
    s().armRelation('coincident')
    s().sketchClick([65, 60], 0.5, false)
    s().sketchClick([83, 60], 0.5, false)
    expect(sk().error).toMatch(/Tangent or Concentric/)
    expect(sk().relPicks).toEqual([])
    s().discardSketch()
  })

  it('with two lines selected lays one along the other', () => {
    s().startSketch({ kind: 'world', axis: 'z', offset: 0 }, XY)
    s().setSketchTool('line')
    s().sketchClick([0, 0], 0.5, false, { off: true })
    s().sketchClick([20, 0], 0.5, false, { off: true })
    s().sketchClick([20, 0], 0.5, false, { off: true })
    s().setSketchTool('line')
    s().sketchClick([30, 4], 0.5, false, { off: true })
    s().sketchClick([50, 6], 0.5, false, { off: true })
    s().sketchClick([50, 6], 0.5, false, { off: true })
    s().setSketchTool('select')
    s().sketchClick([10, 0], 0.5, false, { off: true })
    s().sketchClick([40, 5], 0.5, true, { off: true })
    expect(sk().selection).toHaveLength(2)
    s().addRelation('coincident')
    expect(sk().sketch.constraints.some((c) => c.kind === 'collinear')).toBe(true)
    expect(sk().report?.ok).toBe(true)
    s().discardSketch()
  })

  it('holds a drawn end on a coordinate plane’s line it snapped to', () => {
    s().startSketch({ kind: 'world', axis: 'z', offset: 0 }, XY)
    const datums = datumTraces(XY)
    s().setSketchTool('line')
    s().sketchClick([10, 0.3], 1, false, { datums })
    s().sketchClick([30, 20], 1, false, { off: true })
    const held = sk().sketch.constraints.find((c) => c.kind === 'pointOn')
    expect(held && held.kind === 'pointOn' && held.on).toEqual({ datum: 'zx' })
    expect((sk().sketch.entities[0] as { a: [number, number] }).a).toEqual([10, 0])
    s().discardSketch()
  })
})

describe('what a new solid joins', () => {
  const body = (id: number, surface: boolean) => ({ id, name: `Body ${id}`, visible: true, volume: surface ? 0 : 100, faces: 6, closed: !surface, triangles: 12, surface })

  it('is whatever it meets: there is no body to choose', () => {
    const sketch = finishSquare()
    useReverse.setState({ bodies: [body(2, false), body(5, true)] })
    s().startExtrude(sketch)
    expect(s().extrudeDraft?.op).toBe('join')
    expect(s().extrudeDraft).not.toHaveProperty('target')
    s().startRevolve(sketch)
    expect(s().revolveDraft?.op).toBe('join')
    s().startFeature('fillet')
    const fd = s().featureDraft
    expect(fd?.kind === 'fillet' ? fd.body : null).toBe(2)
  })

  it('joins with no body there at all, and the first makes one', () => {
    const sketch = finishSquare()
    useReverse.setState({ bodies: [body(5, true)] })
    s().startExtrude(sketch)
    expect(s().extrudeDraft?.op).toBe('join')
  })

  it('is a body of its own for an extracted element', () => {
    useReverse.setState({ bodies: [body(2, false)] })
    s().startFeature('extract')
    const fd = s().featureDraft
    expect(fd?.kind === 'extract' ? fd.op : null).toBe('new')
  })
})

describe('what the cursor lights in a sketch', () => {
  it('is what a click would take, for every tool that picks', () => {
    s().startSketch({ kind: 'world', axis: 'z', offset: 0 }, XY)
    s().setSketchTool('line')
    const line = (a: [number, number], b: [number, number]) => {
      s().sketchClick(a, 0.2, false, { off: true })
      s().sketchClick(b, 0.2, false, { off: true })
      s().setSketchTool('line')
    }
    // A chain: the bottom and the side meet in a corner.
    s().sketchClick([0, 0], 0.2, false, { off: true })
    s().sketchClick([10, 0], 0.2, false, { off: true })
    s().sketchClick([10, 8], 0.2, false, { off: true })
    s().setSketchTool('line')
    line([0, 5], [6, 9])
    const [bottom, side, slant] = s().sketchDraft!.sketch.entities.map((e) => e.id)
    const at = (p: [number, number]) => sketchHoverAt(s().sketchDraft!, p, 0.5)
    // A relation in hand — Parallel — lights the piece it would take.
    s().armRelation('parallel')
    expect(at([5, 0.1])).toEqual({ pieces: [bottom], point: null, datum: null })
    expect(at([3, 7])).toEqual({ pieces: [slant], point: null, datum: null })
    expect(at([30, 30])).toBeNull()
    // Dimension: an end wins over its line, a plane's line where nothing is.
    s().setSketchTool('dimension')
    expect(at([10.1, 7.9])).toEqual({ pieces: [], point: [10, 8], datum: null })
    expect(at([10, 4])).toEqual({ pieces: [side], point: null, datum: null })
    expect(at([-30, 0.1])?.datum).not.toBeNull()
    // With a length in hand, only what it would pair with: the side, for the
    // angle — not the line itself, nor the bare sheet, where a click puts
    // the number down.
    s().sketchClick([5, 0], 0.2, false)
    expect(at([10, 4])).toEqual({ pieces: [side], point: null, datum: null })
    expect(at([5, 0.1])).toBeNull()
    expect(at([30, 30])).toBeNull()
    // Paired, nothing: the next click puts it down wherever it lands.
    s().sketchClick([10, 4], 0.2, false)
    expect(at([3, 7])).toBeNull()
    // A round goes into a corner: both its lines and the corner.
    s().setSketchTool('fillet')
    const corner = at([10, 0.1])
    expect([...(corner?.pieces ?? [])].sort((x, y) => x - y)).toEqual([bottom, side])
    expect(corner?.point).toEqual([10, 0])
    // The arrow lights a piece; a drawing tool shows its own snap instead.
    s().setSketchTool('select')
    expect(at([5, 0])?.pieces).toEqual([bottom])
    s().setSketchTool('line')
    expect(at([5, 0])).toBeNull()
  })
})

describe('Symmetric in the sketch', () => {
  it('takes two pieces and then the line they mirror about', () => {
    s().startSketch({ kind: 'world', axis: 'z', offset: 0 }, XY)
    s().setSketchTool('line')
    const line = (a: [number, number], b: [number, number]) => {
      s().sketchClick(a, 0.2, false, { off: true })
      s().sketchClick(b, 0.2, false, { off: true })
      s().setSketchTool('line')
    }
    line([0, -10], [0.5, 10])
    line([-6, 1], [-3, 5])
    line([7, 0], [2.5, 5.5])
    const [axis, left, right] = s().sketchDraft!.sketch.entities.map((e) => e.id)
    s().armRelation('symmetric')
    s().sketchClick([-4.5, 3], 0.5, false)
    s().sketchClick([4.75, 2.75], 0.5, false)
    expect(s().sketchDraft!.sketch.constraints.filter((c) => c.kind === 'symmetric')).toHaveLength(0)
    s().sketchClick([0.25, 0], 0.5, false)
    const made = s().sketchDraft!.sketch.constraints.filter((c) => c.kind === 'symmetric')
    expect(made).toHaveLength(2)
    expect(made.every((c) => c.kind === 'symmetric' && typeof c.about === 'object' && 'line' in c.about && c.about.line === axis)).toBe(true)
    expect(made.map((c) => (c.kind === 'symmetric' ? [c.p.entity, c.q.entity] : []))).toEqual([[left, right], [left, right]])
    expect(s().sketchDraft!.error).toBeNull()
    // In hand for the next pair.
    expect(s().sketchDraft!.armedRelation).toBe('symmetric')
    expect(s().sketchDraft!.selection).toEqual([])
  })

  it("takes a coordinate plane's line on the sheet as the mirror line", () => {
    s().startSketch({ kind: 'world', axis: 'z', offset: 0 }, XY)
    s().setSketchTool('line')
    const line = (a: [number, number], b: [number, number]) => {
      s().sketchClick(a, 0.2, false, { off: true })
      s().sketchClick(b, 0.2, false, { off: true })
      s().setSketchTool('line')
    }
    line([-6, 1], [-3, 5])
    line([7, 0], [2.5, 5.5])
    const [left, right] = s().sketchDraft!.sketch.entities.map((e) => e.id)
    s().armRelation('symmetric')
    s().sketchClick([-4.5, 3], 0.5, false)
    s().sketchClick([4.75, 2.75], 0.5, false)
    // The YZ plane cuts the sheet in the line u = 0: clicked well away from the pieces.
    s().sketchClick([0.1, -20], 0.5, false)
    const made = s().sketchDraft!.sketch.constraints.filter((c) => c.kind === 'symmetric')
    expect(made).toHaveLength(2)
    expect(made.every((c) => c.kind === 'symmetric' && typeof c.about === 'object' && 'datum' in c.about && c.about.datum === 'yz')).toBe(true)
    expect(s().sketchDraft!.error).toBeNull()
    // Held: the two lines are now mirror images in u.
    const l = s().sketchDraft!.sketch.entities.find((e) => e.id === left)
    const r = s().sketchDraft!.sketch.entities.find((e) => e.id === right)
    if (l?.kind !== 'line' || r?.kind !== 'line') throw new Error('not lines')
    expect(l.a[0] + r.a[0]).toBeCloseTo(0, 3)
    expect(l.a[1] - r.a[1]).toBeCloseTo(0, 3)
    expect(l.b[0] + r.b[0]).toBeCloseTo(0, 3)
    expect(l.b[1] - r.b[1]).toBeCloseTo(0, 3)
    expect(s().sketchDraft!.armedRelation).toBe('symmetric')
    expect(s().sketchDraft!.selection).toEqual([])
    // A click on the bare sheet away from every plane's line puts the pair down.
    s().sketchClick([-4.5, 3], 0.5, false)
    s().sketchClick([4.75, 2.75], 0.5, false)
    s().sketchClick([12, -12], 0.5, false)
    expect(s().sketchDraft!.sketch.constraints.filter((c) => c.kind === 'symmetric')).toHaveLength(2)
    expect(s().sketchDraft!.selection).toEqual([])
  })

  it('with the two selected, the key takes the relation in hand for the mirror line', () => {
    s().startSketch({ kind: 'world', axis: 'z', offset: 0 }, XY)
    s().setSketchTool('circle')
    s().sketchClick([-5, 0], 0.2, false, { off: true })
    s().sketchClick([-4, 0], 0.2, false, { off: true })
    s().sketchClick([5.5, 0.5], 0.2, false, { off: true })
    s().sketchClick([6.5, 0.5], 0.2, false, { off: true })
    s().setSketchTool('select')
    s().sketchClick([-4, 0], 0.3, false)
    s().sketchClick([6.5, 0.5], 0.3, false)
    s().addRelation('symmetric')
    expect(s().sketchDraft!.tool).toBe('relation')
    expect(s().sketchDraft!.armedRelation).toBe('symmetric')
    expect(s().sketchDraft!.selection).toHaveLength(2)
    // Another tool puts it down.
    s().setSketchTool('line')
    expect(s().sketchDraft!.armedRelation).toBeNull()
  })
})

describe('the sketch draft type', () => {
  it('starts with an empty sketch', () => {
    s().startSketch({ kind: 'world', axis: 'z', offset: 0 }, XY)
    expect(s().sketchDraft?.sketch).toEqual(emptySketch())
  })
})

describe('a sketch on a body’s face after a build', () => {
  it('is kept where the build found the face, with no undo step and no rebuild', () => {
    const face = { kind: 'plane' as const, centroid: [20, 10, 10] as [number, number, number], dir: [0, 0, 1] as [number, number, number], area: 800, origin: 2 }
    const at10: SectionFrame = { origin: [0, 0, 10], normal: [0, 0, 1], basisU: [1, 0, 0], basisV: [0, 1, 0] }
    const at12: SectionFrame = { ...at10, origin: [0, 0, 12] }
    useReverse.setState({
      features: [{ id: 3, kind: 'sketch', name: 'Sketch 3', plane: { kind: 'bodyFace', body: 2, face, frame: at10 }, frame: at10, sketch: emptySketch(), visible: true }],
      buildVersion: 7,
    })
    s().finishBuild([{ id: 4, status: 'ok', sketchFrame: { sketchId: 3, frame: at12 } }], [])
    const sketch = s().features[0]
    expect(sketch.kind === 'sketch' && sketch.frame).toEqual(at12)
    expect(sketch.kind === 'sketch' && sketch.plane.kind === 'bodyFace' && sketch.plane.frame).toEqual(at12)
    expect(s().buildVersion).toBe(7)
    expect(s().past).toEqual([])
    // The same frame again changes nothing.
    const before = s().features
    s().finishBuild([{ id: 4, status: 'ok', sketchFrame: { sketchId: 3, frame: at12 } }], [])
    expect(s().features[0]).toBe(before[0])
  })

  it('keeps a sketch whose projected pieces the build took again as the build solved it, with no undo step and no rebuild', () => {
    const at10: SectionFrame = { origin: [0, 0, 10], normal: [0, 0, 1], basisU: [1, 0, 0], basisV: [0, 1, 0] }
    const drawn = emptySketch()
    addEntity(drawn, { kind: 'line', a: [0, 0], b: [40, 0], fixed: true, projected: true, source: { sketch: 1, entity: 1 } })
    const solved = emptySketch()
    addEntity(solved, { kind: 'line', a: [0, 0], b: [30, 0], fixed: true, projected: true, source: { sketch: 1, entity: 1 } })
    useReverse.setState({
      features: [{ id: 3, kind: 'sketch', name: 'Sketch 3', plane: { kind: 'world', axis: 'z', offset: 10 }, frame: at10, sketch: drawn, visible: true }],
      buildVersion: 7,
      past: [],
    })
    s().finishBuild([{ id: 3, status: 'ok', sketch: solved }], [])
    const sketch = s().features[0]
    expect(sketch.kind === 'sketch' && sketch.sketch).toBe(solved)
    expect(sketch.kind === 'sketch' && sketch.frame).toBe(at10)
    expect(s().buildVersion).toBe(7)
    expect(s().past).toEqual([])
  })
})

describe('the body list', () => {
  it('names the bodies Solid and Shell in the order of the features that made them', () => {
    const body = (id: number, surface = false) => ({ id, name: `feature ${id}`, visible: true, volume: 1, faces: 6, closed: !surface, triangles: 12, surface })
    useReverse.setState({
      features: [
        { id: 1, kind: 'sheet', name: 'Sheet 1', sketchId: 0, from: 0, to: 1, visible: true },
        { id: 2, kind: 'extrude', name: 'Extrude 1', sketchId: 0, regions: [], extent: { kind: 'distance', from: 0, to: 1 }, op: 'new', visible: true },
        { id: 3, kind: 'extrude', name: 'Extrude 2', sketchId: 0, regions: [], extent: { kind: 'distance', from: 0, to: 1 }, op: 'new', visible: true },
      ],
    })
    // Handed over out of order, named by the features' order all the same.
    s().finishBuild([], [body(3), body(1, true), body(2)])
    expect(s().bodies.map((b) => [b.id, b.name])).toEqual([
      [3, 'Solid 2'],
      [1, 'Shell 1'],
      [2, 'Solid 1'],
    ])
    expect(nameBodies([{ id: 9, name: '' }], [])[0].name).toBe('Solid 1')
    // The further bodies a step left are named after its first, in their
    // order — a cut through a bar's waist in Extrude 1's place.
    const named = nameBodies([body(islandId(2, 1)), body(3), body(2), body(islandId(2, 2))], s().features)
    expect(named.map((b) => b.name)).toEqual(['Solid 2', 'Solid 4', 'Solid 1', 'Solid 3'])
  })

  it('shows the coordinate planes on a blank stage and hides them over a scan, until an eye says otherwise', () => {
    useReverse.setState({ planesShown: {} })
    expect(coordinatePlaneShown(s().planesShown, 'z', false)).toBe(true)
    expect(coordinatePlaneShown(s().planesShown, 'z', true)).toBe(false)
    s().setPlaneShown('z', false)
    s().setPlaneShown('x', true)
    expect(coordinatePlaneShown(s().planesShown, 'z', false)).toBe(false)
    expect(coordinatePlaneShown(s().planesShown, 'x', true)).toBe(true)
    // The plane left alone still follows the stage.
    expect(coordinatePlaneShown(s().planesShown, 'y', true)).toBe(false)
    // A new scan starts from the stage's own say again.
    s().reset()
    expect(s().planesShown).toEqual({})
  })
})

describe('what a snap holds a drawn end to', () => {
  const traces = datumTraces(XY)

  it('a line drawn from the body of another is held on it, and one drawn to an axis or the zero is held there', () => {
    s().startSketch({ kind: 'world', axis: 'z', offset: 0 }, XY)
    s().setSketchTool('line')
    s().sketchClick([0, 10], 0.5, false, { off: true })
    s().sketchClick([20, 10], 0.5, false, { off: true })
    s().setSketchTool('select')
    const base = s().sketchDraft!.sketch.entities[0].id
    // From the side of the first line, up to the X axis: on the body of
    // the piece, then on the plane's line.
    s().setSketchTool('line')
    s().sketchClick([8, 10.3], 0.5, false, { datums: traces })
    s().sketchClick([8, 0.3], 0.5, false, { datums: traces })
    const sketch = s().sketchDraft!.sketch
    const branch = sketch.entities[1]
    expect(branch.kind).toBe('line')
    expect(sketch.constraints.some((c) => c.kind === 'pointOn' && 'line' in c.on && c.on.line === base && c.p.entity === branch.id && c.p.at === 'a')).toBe(true)
    expect(sketch.constraints.some((c) => c.kind === 'pointOn' && 'datum' in c.on && c.on.datum === 'zx' && c.p.entity === branch.id && c.p.at === 'b')).toBe(true)
    // The chain runs on from the axis; on to the zero, where it arrives.
    expect(s().sketchDraft!.chain).toEqual({ entity: branch.id, at: 'b' })
    s().sketchClick([0.2, -0.2], 0.5, false, { datums: traces })
    const after = s().sketchDraft!.sketch
    const last = after.entities[2]
    expect(after.constraints.filter((c) => c.kind === 'pointOn' && 'datum' in c.on && c.p.entity === last.id && c.p.at === 'b').map((c) => (c.kind === 'pointOn' && 'datum' in c.on ? c.on.datum : ''))).toEqual(['yz', 'zx'])
    expect(s().sketchDraft!.chain).toBeNull()
  })

  it('a circle drawn with its centre on a line is held there; an end joined to an end is not held on the body as well', () => {
    s().startSketch({ kind: 'world', axis: 'z', offset: 0 }, XY)
    s().setSketchTool('line')
    s().sketchClick([0, 0], 0.5, false, { off: true })
    s().sketchClick([20, 0], 0.5, false, { off: true })
    s().setSketchTool('select')
    const base = s().sketchDraft!.sketch.entities[0].id
    s().setSketchTool('circle')
    s().sketchClick([10, 0.3], 0.5, false, {})
    s().sketchClick([13, 0], 0.5, false, { off: true })
    const sketch = s().sketchDraft!.sketch
    const circle = sketch.entities[1]
    expect(circle.kind).toBe('circle')
    expect(sketch.constraints.some((c) => c.kind === 'pointOn' && 'line' in c.on && c.on.line === base && c.p.entity === circle.id && c.p.at === 'center')).toBe(true)
    // A line from the base line's end: coincident to the end, and nothing more.
    s().setSketchTool('line')
    s().sketchClick([20.2, 0.1], 0.5, false, {})
    s().sketchClick([30, 10], 0.5, false, { off: true })
    const more = s().sketchDraft!.sketch
    const leg = more.entities[2]
    expect(more.constraints.filter((c) => c.kind === 'coincident' && [c.p, c.q].some((a) => a.entity === leg.id))).toHaveLength(1)
    expect(more.constraints.some((c) => c.kind === 'pointOn' && c.p.entity === leg.id)).toBe(false)
  })
})

/** A sketch with a 2 × 2 square standing 5 mm off the Y axis, finished. */
function finishOffAxisSquare(): number {
  s().startSketch({ kind: 'world', axis: 'z', offset: 0 }, XY)
  s().setSketchTool('rectangle')
  s().sketchClick([5, 0], 0.01, false, { off: true })
  s().sketchClick([7, 2], 0.01, false, { off: true })
  const id = s().commitSketch()
  if (id === null) throw new Error('the square did not finish')
  return id
}

describe('a coil', () => {
  it('starts with a pitch half again the profile’s reach along the axis, and three turns', () => {
    const sketch = finishOffAxisSquare()
    s().startRevolve(sketch, null, { kind: 'world', axis: 'y' })
    expect(s().revolveDraft).toMatchObject({ angleDeg: 360, pitch: 0, leftHanded: false })
    s().setRevolveCoil(true)
    // 2 mm along Y: 3 mm a turn.
    expect(s().revolveDraft).toMatchObject({ pitch: 3, angleDeg: 1080 })
    // The ring wound on past a full turn.
    s().gripDrag('turn', 0, 'start')
    s().gripDrag('turn', 720, 'move')
    s().gripDrag('turn', 720, 'end')
    expect(s().revolveDraft?.angleDeg).toBe(1800)
    s().setRevolve({ leftHanded: true })
    const id = s().commitRevolve()!
    expect(s().features.find((f) => f.id === id)).toMatchObject({ kind: 'revolve', name: 'Coil 1', pitch: 3, leftHanded: true, angleDeg: 1800 })
  })

  it('reopens as a coil, and made plain again stops at a full turn and keeps no pitch', () => {
    const sketch = finishOffAxisSquare()
    s().startRevolve(sketch, null, { kind: 'world', axis: 'y' })
    s().setRevolveCoil(true)
    const id = s().commitRevolve()!
    s().editRevolve(id)
    expect(s().revolveDraft).toMatchObject({ pitch: 3, leftHanded: false, angleDeg: 1080 })
    s().setRevolveCoil(false)
    expect(s().revolveDraft).toMatchObject({ pitch: 0, angleDeg: 360 })
    s().commitRevolve()
    const plain = s().features.find((f) => f.id === id)!
    expect(plain).toMatchObject({ kind: 'revolve', angleDeg: 360 })
    expect('pitch' in plain || 'leftHanded' in plain).toBe(false)
  })

  it('keeps a plain revolve to a full turn however the angle is given', () => {
    const sketch = finishOffAxisSquare()
    s().startRevolve(sketch, null, { kind: 'world', axis: 'y' })
    s().setRevolve({ angleDeg: 900 })
    expect(s().revolveDraft?.angleDeg).toBe(360)
    s().setGripValue('turn', 900)
    expect(s().revolveDraft?.angleDeg).toBe(360)
    const id = s().commitRevolve()!
    const plain = s().features.find((f) => f.id === id)!
    expect(withKeyParameter(plain, 720)).toMatchObject({ angleDeg: 360 })
    expect(withKeyParameter({ ...plain, pitch: 2 } as typeof plain, 720)).toMatchObject({ angleDeg: 720 })
  })
})

describe('the taper grip', () => {
  it('leans the sides out as it is pulled out, read and typed as a taper', () => {
    const sketch = finishSquare()
    s().startExtrude(sketch)
    // To 10 mm: a pull of 10 mm out puts the far edge at 45°.
    s().gripDrag('taper', 0, 'start')
    s().gripDrag('taper', 10, 'move')
    s().gripDrag('taper', 10, 'end')
    expect(s().extrudeDraft?.draftDeg).toBe(-45)
    expect(gripFieldValue(s())).toEqual({ value: 45, unit: '°' })
    // Typed: a negative taper leans in, the draft the feature keeps.
    s().setGripValue('taper', -5)
    expect(s().extrudeDraft?.draftDeg).toBe(5)
    // The distance arrows still move the distance.
    s().gripDrag('extrudeTo', 0, 'start')
    s().gripDrag('extrudeTo', 5, 'move')
    s().gripDrag('extrudeTo', 5, 'end')
    expect(s().extrudeDraft?.extent).toEqual({ kind: 'distance', from: 0, to: 15 })
    expect(s().extrudeDraft?.draftDeg).toBe(5)
  })
})

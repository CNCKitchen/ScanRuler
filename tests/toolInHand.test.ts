// SPDX-License-Identifier: AGPL-3.0-only
// The kind stays in hand after Create in both Measure workspaces, the way a
// sketch tool stays in hand until it is put down: Create leaves an empty box
// of the same kind on the same method, Add dimension the same for its type,
// and Escape empties a box with picks in it before it puts the kind down. An
// empty box in hand is not in anyone's way — not the row keys', not undo's.
import { beforeEach, describe, expect, it } from 'vitest'
import { draftHolds, useStore } from '../src/state/store'
import { flatDraftHolds, flatEditorOpen, useFlat } from '../src/state/flatStore'
import { historyBlocked } from '../src/state/historyStore'
import type { Vec3 } from '../src/core/types'

const store = () => useStore.getState()

/** A point picked on the scan, the way the viewport feeds one in. */
function pick(center: Vec3) {
  store().setDraftPicks([[0, 0, 0]], [center])
  store().resolveDraft({ kind: 'point', center, sigma: 0, usedPoints: 0, regionSize: 0, region: new Uint32Array(0) })
}

function pickPoint(center: Vec3): number {
  if (store().draft?.kind !== 'point') store().startDraft('point')
  pick(center)
  const id = store().commitDraft()
  if (id === null) throw new Error('point was not created')
  return id
}

describe('the kind in hand in the 3D Measure workspace', () => {
  beforeEach(() => {
    store().beginLoad('test.stl')
    store().finishLoad(0, 0, 100, [0, 0, 0])
  })

  it('stays in hand after Create, its box empty, on the same method and settings', () => {
    store().startDraft('point')
    const settings = store().draft!.settings
    pick([1, 2, 3])
    expect(store().commitDraft()).not.toBeNull()
    const next = store().draft
    expect(next).toMatchObject({ kind: 'point', method: 'pick', picks: [], status: 'empty' })
    expect(next!.fit).toBeUndefined()
    expect(next!.settings).toBe(settings)
    // Nothing in the box: Create makes nothing, and the next pick makes the next point.
    expect(store().commitDraft()).toBeNull()
    pick([4, 5, 6])
    expect(store().commitDraft()).not.toBeNull()
    expect(store().elements.map((e) => e.name)).toEqual(['Point 1', 'Point 2'])
    expect(store().draft?.kind).toBe('point')
  })

  it('is put down by an edit saved', () => {
    const a = pickPoint([0, 0, 0])
    store().cancelDraft()
    store().editElement(a)
    expect(store().draft?.editId).toBe(a)
    expect(store().commitDraft()).toBe(a)
    expect(store().draft).toBeNull()
  })

  it('goes back to the dimension when the point was picked for one of its slots', () => {
    const a = pickPoint([0, 0, 0])
    store().startDimension('dist-point-point')
    expect(store().draft).toBeNull()
    store().beginDimensionPick(1)
    expect(store().draft?.kind).toBe('point')
    pick([10, 0, 0])
    const b = store().commitDraft()
    expect(store().draft).toBeNull()
    expect(store().dimDraft?.refs).toEqual([null, b])
    expect(a).not.toBe(b)
  })

  it('keeps the dimension box open for the next of its type, and closes it after an edit', () => {
    const a = pickPoint([0, 0, 0])
    const b = pickPoint([10, 0, 0])
    store().startDimension('dist-point-point')
    store().setDimensionRef(0, a)
    store().setDimensionRef(1, b)
    store().commitDimension()
    expect(store().dimensions).toHaveLength(1)
    expect(store().dimDraft).toEqual({ type: 'dist-point-point', refs: [null, null], anchor: 'center', pickSlot: null })
    store().setDimensionRef(0, b)
    store().setDimensionRef(1, a)
    store().commitDimension()
    expect(store().dimensions).toHaveLength(2)
    store().cancelDimension()
    store().editDimension(store().dimensions[0].id)
    store().commitDimension()
    expect(store().dimDraft).toBeNull()
  })

  it('is put down by a dimension started or edited, as by an alignment or a section', () => {
    const a = pickPoint([0, 0, 0])
    const b = pickPoint([10, 0, 0])
    expect(store().draft).not.toBeNull()
    store().startDimension('dist-point-point')
    expect(store().draft).toBeNull()
    store().setDimensionRef(0, a)
    store().setDimensionRef(1, b)
    store().commitDimension()
    store().cancelDimension()
    store().startDraft('plane')
    store().editDimension(store().dimensions[0].id)
    expect(store().draft).toBeNull()
  })

  it('restarts on the same kind and method, and never an edit', () => {
    store().startDraft('point')
    pick([1, 1, 1])
    expect(store().draft?.status).toBe('ready')
    store().restartDraft()
    expect(store().draft).toMatchObject({ kind: 'point', method: 'pick', picks: [], status: 'empty' })
    const a = pickPoint([0, 0, 0])
    store().editElement(a)
    store().restartDraft()
    expect(store().draft?.editId).toBe(a)
  })

  it('holds nothing while its box is empty, so the row keys and undo stay live', () => {
    expect(draftHolds(null)).toBe(false)
    store().startDraft('point')
    expect(draftHolds(store().draft)).toBe(false)
    expect(historyBlocked()).toBe(false)
    pick([1, 1, 1])
    expect(draftHolds(store().draft)).toBe(true)
    expect(historyBlocked()).toBe(true)
    const a = store().commitDraft()!
    expect(draftHolds(store().draft)).toBe(false)
    expect(historyBlocked()).toBe(false)
    store().editElement(a)
    expect(draftHolds(store().draft)).toBe(true)
    store().cancelDraft()
    store().startDraft('line')
    store().setDraftMethod('line-two-points')
    expect(draftHolds(store().draft)).toBe(false)
    store().setDraftRef(0, a)
    expect(draftHolds(store().draft)).toBe(true)
  })

  it('keeps the empty dimension box out of the way of undo too', () => {
    const a = pickPoint([0, 0, 0])
    const b = pickPoint([10, 0, 0])
    store().startDimension('dist-point-point')
    expect(historyBlocked()).toBe(false)
    store().setDimensionRef(0, a)
    expect(historyBlocked()).toBe(true)
    store().setDimensionRef(1, b)
    store().commitDimension()
    expect(historyBlocked()).toBe(false)
  })
})

describe('the kind in hand in the 2D Measure workspace', () => {
  beforeEach(() => {
    useFlat.setState({
      elements: [],
      draft: null,
      nextId: 1,
      nameCounts: {},
      dimensions: [],
      dimDraft: null,
      nextDimId: 1,
      dimCounts: {},
      pxPerMm: null,
      calSource: 'none',
      tool: { kind: 'none' },
      splitAxes: false,
    })
    useFlat.getState().finishImageLoad('t.png', 1000, 800, { x: 10, y: 10 })
  })

  const flat = () => useFlat.getState()

  it('stays in hand after Create, its box empty, on the same method', () => {
    flat().startDraft('point', 'flat-point-pick')
    flat().addDraftPick([100, 100])
    expect(flat().commitDraft()).toBe(1)
    expect(flat().draft).toMatchObject({ kind: 'point', method: 'flat-point-pick', picks: [], fit: null })
    expect(flat().commitDraft()).toBeNull()
    flat().addDraftPick([200, 200])
    expect(flat().commitDraft()).toBe(2)
    expect(flat().elements.map((e) => e.name)).toEqual(['Point 1', 'Point 2'])
  })

  it('is put down by an edit saved', () => {
    flat().startDraft('point', 'flat-point-pick')
    flat().addDraftPick([100, 100])
    flat().commitDraft()
    flat().cancelDraft()
    flat().editElement(1)
    expect(flat().commitDraft()).toBe(1)
    expect(flat().draft).toBeNull()
  })

  it('backs out one step at a time: the picks first, then the kind', () => {
    flat().startDraft('point', 'flat-point-pick')
    flat().addDraftPick([100, 100])
    expect(flat().retreat()).toBe(true)
    expect(flat().draft).toMatchObject({ kind: 'point', picks: [] })
    expect(flat().retreat()).toBe(true)
    expect(flat().draft).toBeNull()
    expect(flat().retreat()).toBe(false)
  })

  it('closes an edit on the first step, picks and all', () => {
    flat().startDraft('point', 'flat-point-pick')
    flat().addDraftPick([100, 100])
    flat().commitDraft()
    flat().editElement(1)
    expect(flat().retreat()).toBe(true)
    expect(flat().draft).toBeNull()
    expect(flat().elements[0].source).toMatchObject({ picks: [[100, 100]] })
  })

  it('keeps the dimension box open for the next of its type, and is put down by one started', () => {
    flat().startDraft('point', 'flat-point-pick')
    flat().addDraftPick([100, 100])
    flat().commitDraft()
    flat().addDraftPick([300, 100])
    flat().commitDraft()
    expect(flat().draft).not.toBeNull()
    flat().startDimDraft()
    expect(flat().draft).toBeNull()
    const type = flat().dimDraft!.type
    flat().setDimRef(0, 1)
    flat().setDimRef(1, 2)
    flat().commitDim()
    expect(flat().dimensions).toHaveLength(1)
    expect(flat().dimDraft).toEqual({ type, refs: [null, null] })
    flat().editDimension(flat().dimensions[0].id)
    flat().commitDim()
    expect(flat().dimDraft).toBeNull()
  })

  it('holds nothing while its box is empty, so the row keys and undo stay live', () => {
    expect(flatDraftHolds(null)).toBe(false)
    flat().startDraft('point', 'flat-point-pick')
    const s = () => ({ tool: flat().tool, draft: flat().draft, dimDraft: flat().dimDraft })
    expect(flatDraftHolds(flat().draft)).toBe(false)
    expect(flatEditorOpen(s())).toBe(false)
    expect(historyBlocked()).toBe(false)
    flat().addDraftPick([100, 100])
    expect(flatDraftHolds(flat().draft)).toBe(true)
    expect(flatEditorOpen(s())).toBe(true)
    expect(historyBlocked()).toBe(true)
    flat().commitDraft()
    expect(flatEditorOpen(s())).toBe(false)
    expect(historyBlocked()).toBe(false)
    flat().editElement(1)
    expect(flatEditorOpen(s())).toBe(true)
  })
})

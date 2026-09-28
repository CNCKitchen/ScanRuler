// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useStore } from '../src/state/store'
import { useFlat } from '../src/state/flatStore'
import { useDeviation } from '../src/state/deviationStore'
import { useThickness } from '../src/state/thicknessStore'
import { useShell } from '../src/state/shellStore'
import { beginHistoryGroup, endHistoryGroup, clearHistory, configureHistory, historyAction, historyAsync, installHistory, undo, redo, useHistory } from '../src/state/historyStore'
import { frameKey, type SectionFrame } from '../src/core/section/frame'

const m = () => useStore.getState(), f = () => useFlat.getState(), d = () => useDeviation.getState()
const t = () => useThickness.getState(), h = () => useHistory.getState()
const XY: SectionFrame = { origin: [0, 0, 0], normal: [0, 0, 1], basisU: [1, 0, 0], basisV: [0, 1, 0] }
let uninstall: () => void
let unconfigure: () => void
beforeEach(() => {
  useStore.setState(useStore.getInitialState(), true)
  useFlat.setState(useFlat.getInitialState(), true)
  useDeviation.setState(useDeviation.getInitialState(), true)
  useThickness.setState(useThickness.getInitialState(), true)
  useShell.getState().setWorkspace('elements')
  clearHistory()
  unconfigure = configureHistory({})
  uninstall = installHistory()
})
afterEach(() => { uninstall(); unconfigure() })

function plane() {
  m().startDraft('plane')
  m().resolveDraft({ kind: 'plane', center: [0, 0, 0], normal: [0, 0, 1], basisU: [1, 0, 0], basisV: [0, 1, 0], extentU: 10, extentV: 10,
    sigma: 0, usedPoints: 3, regionSize: 3, region: new Uint32Array([0, 1, 2]) })
  return m().commitDraft()!
}
function flatPoint() {
  f().startDraft('point', 'flat-point-pick')
  f().addDraftPick([100, 200])
  return f().commitDraft()!
}

describe('project history', () => {
  it('undoes and redoes chronologically across all four workspaces with stable IDs', async () => {
    plane()
    useShell.getState().setWorkspace('flat')
    f().finishImageLoad('image.png', 1000, 800, { x: 10, y: 10 })
    flatPoint()
    useShell.getState().setWorkspace('deviation')
    d().addProbe([1, 2, 3], 0.1)
    useShell.getState().setWorkspace('thickness')
    t().addProbe([3, 2, 1], 2)
    expect(h().past).toHaveLength(4)
    for (const workspace of ['thickness', 'deviation', 'flat', 'elements']) {
      await undo()
      expect(useShell.getState().workspace).toBe(workspace)
    }
    expect([m().elements.length, f().elements.length, d().probes.length, t().probes.length]).toEqual([0, 0, 0, 0])
    for (let i = 0; i < 4; i++) await redo()
    expect([m().elements[0].id, f().elements[0].id, d().probes[0].id, t().probes[0].id]).toEqual([1, 1, 1, 1])
  })

  it('restores a deleted element, its dimension, and the deviation target and pins together', async () => {
    const id = plane()
    m().startDimension('form-flatness')
    m().setDimensionRef(0, id)
    m().commitDimension()
    d().setSource('element'); d().setTarget(id); d().addProbe([0, 0, 0], 0)
    clearHistory()
    m().removeElement(id)
    expect(m().dimensions).toHaveLength(0)
    expect(d().targetId).toBeNull()
    await undo()
    expect(m().dimensions).toHaveLength(1)
    expect(d().targetId).toBe(id)
    expect(d().probes).toHaveLength(1)
    await redo()
    expect(m().elements).toHaveLength(0)
    expect(d().probes).toHaveLength(0)
  })

  it('restores a deleted section and its active 2D sheet as one step', async () => {
    useStore.setState({ sections: [{ id: 7, name: 'Section 1', color: '#ff8800', ref: null, offset: 0, frame: XY, visible: true, cutKey: frameKey(XY) }] })
    f().setSubject({ kind: 'section', id: 7 })
    flatPoint()
    clearHistory()
    m().removeSection(7)
    expect(f().subject.kind).toBe('image')
    await undo()
    expect(m().sections[0].id).toBe(7)
    expect(f().subject).toEqual({ kind: 'section', id: 7 })
    expect(f().elements).toHaveLength(1)
    await redo()
    expect(m().sections).toHaveLength(0)
    expect(f().subject.kind).toBe('image')
  })

  it('restores the correct 2D sheet after sheet navigation', async () => {
    f().setSubject({ kind: 'section', id: 7 })
    flatPoint()
    f().setSubject({ kind: 'image' })
    await undo()
    expect(f().subject).toEqual({ kind: 'section', id: 7 })
    expect(f().elements).toHaveLength(0)
    await redo()
    expect(f().elements).toHaveLength(1)
  })

  it('restores calibration and the measurements derived from it', async () => {
    f().finishImageLoad('image.png', 1000, 800, { x: 10, y: 10 })
    flatPoint()
    const original = f().elements
    f().startCalibration('distance')
    f().addCalPick([0, 0]); f().addCalPick([100, 0])
    expect(f().applyCalibration(20)).toBeNull()
    expect(f().pxPerMm).toEqual({ x: 5, y: 5 })
    await undo()
    expect(f().pxPerMm).toEqual({ x: 10, y: 10 })
    expect(f().elements).toBe(original)
    await redo()
    expect(f().pxPerMm).toEqual({ x: 5, y: 5 })
  })

  it('groups a gesture and nested commands into one undo step', async () => {
    const original = t().limit
    beginHistoryGroup()
    t().setLimit(2); t().setLimit(3); t().setLimit(4)
    endHistoryGroup()
    expect(h().past).toHaveLength(1)
    await undo()
    expect(t().limit).toBe(original)
    await redo()
    expect(t().limit).toBe(4)
    historyAction('two scales', () => { t().setLow(2); d().setRange(3) })
    expect(h().past).toHaveLength(2)
    await undo()
    expect(t().low).toBe(0)
    expect(d().range).not.toBe(3)
  })

  it('does not record worker results, navigation, or empty commits', () => {
    m().commitDraft(); f().commitDraft()
    t().resolve(1, 5)
    d().resolveElementMap(1)
    useShell.getState().setWorkspace('flat')
    expect(h().past).toHaveLength(0)
  })

  it('restores count edits and groups live note edits without an empty finish step', async () => {
    f().startCount(); f().addCountPick([10, 20]); f().addCountPick([30, 40]); f().finishCount()
    await undo()
    expect(f().counts).toHaveLength(0)
    await redo()
    expect(f().counts[0].picks).toHaveLength(2)
    beginHistoryGroup()
    f().addNote([10, 10]); f().setNoteText(1, 'first'); f().setNoteText(1, 'finished note'); f().finishNote()
    endHistoryGroup()
    expect(h().past).toHaveLength(2)
    await undo()
    expect(f().notes).toHaveLength(0)
    await redo()
    expect(f().notes[0].text).toBe('finished note')
    const count = h().past.length
    f().editNote(1); f().finishNote()
    expect(h().past).toHaveLength(count)
  })

  it('drops redo on a new edit and bounds retained history', async () => {
    t().setLimit(2); t().setLimit(3)
    await undo()
    t().setLimit(4)
    expect(h().future).toHaveLength(0)
    for (let i = 0; i < 100; i++) t().setLimit(10 + i)
    expect(h().past).toHaveLength(64)
    clearHistory()
    await undo()
    expect(t().limit).toBe(109)
  })

  it('blocks document undo while an unfinished editor or computation owns state', async () => {
    plane()
    // An empty dimension box — the one Add dimension leaves open for the
    // next — is not in the way; one with a slot filled is.
    m().startDimension('form-flatness')
    m().setDimensionRef(0, m().elements[0].id)
    await undo()
    expect(m().elements).toHaveLength(1)
    expect(m().dimDraft).not.toBeNull()
    m().cancelDimension()
    useThickness.setState({ status: 'running' })
    await undo()
    expect(m().elements).toHaveLength(1)
    useThickness.setState({ status: 'idle' })
    await undo()
    expect(m().elements).toHaveLength(0)
  })

  it('preserves the entry if geometry restoration fails before state is changed', async () => {
    unconfigure(); unconfigure = configureHistory({ beforeRestore: async () => { throw new Error('worker unavailable') } })
    t().setLimit(5)
    await undo()
    expect(t().limit).toBe(5)
    expect(h().past).toHaveLength(1)
    expect(h().future).toHaveLength(0)
    expect(h().restoring).toBe(false)
    expect(m().errorText).toContain('worker unavailable')
  })

  it('does not resurrect an async command belonging to a replaced source', async () => {
    await historyAsync('old command', async () => {
      t().setLimit(2)
      clearHistory()
      await Promise.resolve()
    })
    expect(h().past).toHaveLength(0)
  })

  it('restores the external marked region together with its settings and pins', async () => {
    let scope: Uint32Array | null = new Uint32Array([1, 2])
    unconfigure(); unconfigure = configureHistory({ getScope: () => scope, setScope: (value) => { scope = value } })
    d().setSource('element'); d().setTargetScope('marked'); d().markScope(2); d().addProbe([0, 0, 0], 0.2)
    clearHistory()
    historyAction('Mark region', () => { scope = new Uint32Array([3]); d().markScope(1) })
    expect(d().probes).toHaveLength(0)
    await undo()
    expect([...scope!]).toEqual([1, 2])
    expect(d().scopeCount).toBe(2)
    expect(d().probes).toHaveLength(1)
    await redo()
    expect([...scope!]).toEqual([3])
    expect(d().probes).toHaveLength(0)
  })
})


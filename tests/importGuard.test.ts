// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { importWouldDiscardWork } from '../src/app/importGuard'
import { forgetKeptParts, keepUnownedParts, registerProjectSection } from '../src/app/projectSections'
import { blankManifest } from '../src/app/project'
import { useStore } from '../src/state/store'
import { useFlat } from '../src/state/flatStore'
import { useDeviation } from '../src/state/deviationStore'
import { useThickness } from '../src/state/thicknessStore'
import { clearHistory, configureHistory, historyAction, undo, useHistory } from '../src/state/historyStore'

let unconfigure: () => void
beforeEach(() => {
  useStore.setState(useStore.getInitialState(), true)
  useFlat.setState(useFlat.getInitialState(), true)
  useDeviation.setState(useDeviation.getInitialState(), true)
  useThickness.setState(useThickness.getInitialState(), true)
  clearHistory()
  forgetKeptParts()
  unconfigure = configureHistory({})
})
afterEach(() => unconfigure())

describe('work protected by browser replacement imports', () => {
  it('does not warn for source files and empty editors alone', () => {
    useStore.setState({ fileName: 'scan.obj' })
    useDeviation.setState({ nominalName: 'reference.obj' })
    useFlat.setState({ imageName: 'image.png' })
    useStore.getState().startDraft('point')
    useFlat.getState().startDraft('point', 'flat-point-pick')
    expect(importWouldDiscardWork()).toBe(false)
  })

  it('protects a picked point that has not yet become a measurement', () => {
    useStore.getState().startDraft('point')
    useStore.getState().setDraftPicks([[1, 2, 3]])
    expect(importWouldDiscardWork()).toBe(true)
  })

  it('protects unfinished and committed image-sheet measurements', () => {
    useFlat.getState().startDraft('point', 'flat-point-pick')
    useFlat.getState().addDraftPick([10, 20])
    expect(importWouldDiscardWork()).toBe(true)
    useFlat.getState().commitDraft()
    expect(importWouldDiscardWork()).toBe(true)
  })

  it('protects work held only in redo after the last change was undone', async () => {
    historyAction('Pin a reading', () => useThickness.getState().addProbe([1, 2, 3], 2))
    await undo()
    expect(useThickness.getState().probes).toHaveLength(0)
    expect(useHistory.getState().past).toHaveLength(0)
    expect(useHistory.getState().future).toHaveLength(1)
    expect(importWouldDiscardWork()).toBe(true)
  })

  it('protects comparison picks even before an alignment exists', () => {
    useDeviation.getState().startPicking()
    useDeviation.setState({ pendingScan: [1, 2, 3] })
    expect(importWouldDiscardWork()).toBe(true)
    useDeviation.setState({ pendingScan: null, pairs: [{ scan: [1, 2, 3], nominal: [4, 5, 6] }] })
    expect(importWouldDiscardWork()).toBe(true)
  })

  it('protects a plugin editor whose work is not yet saved in the project', () => {
    const unregister = registerProjectSection({ key: 'testDraft', collect: () => undefined, prepare: () => () => {}, hasDraft: () => true })
    try { expect(importWouldDiscardWork()).toBe(true) }
    finally { unregister() }
  })

  it('protects project content from a plugin that is not installed in this build', () => {
    const manifest = blankManifest('test')
    keepUnownedParts({ ...manifest, futurePlugin: { features: [{ id: 1 }] } }, new Map())
    expect(importWouldDiscardWork()).toBe(true)
  })
})

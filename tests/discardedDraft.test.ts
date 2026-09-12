// SPDX-License-Identifier: AGPL-3.0-only
// A draft closed with a marked surface on it is not gone: the store keeps it,
// marking and all, until the next draft starts, and can put it back. Escape
// is the key reached for to get the camera back, and a second press — or a
// slip onto Cancel, or another editor taking the panel — must not cost the
// minutes a marking took.
import { beforeEach, describe, expect, it } from 'vitest'
import { creationMethod, takesSurface } from '../src/core/elements/construct'
import type { FitOutput, PlaneFit } from '../src/core/types'
import { useStore } from '../src/state/store'

const store = () => useStore.getState()

const marking = new Uint32Array([3, 5, 8, 13, 21])

const plane: PlaneFit = {
  kind: 'plane',
  center: [0, 0, 0],
  normal: [0, 0, 1],
  basisU: [1, 0, 0],
  basisV: [0, 1, 0],
  extentU: 10,
  extentV: 10,
  sigma: 0.002,
  usedPoints: 5,
  regionSize: 5,
}
const asOutput = (fit: PlaneFit): FitOutput => ({ ...fit, region: new Uint32Array([1, 2, 3]) })

/** A symmetry-plane draft being searched on a marked surface. */
function markedSearch() {
  store().startDraft('plane')
  store().setDraftMethod('plane-symmetry')
  store().setSelectMode('paint')
  store().setDraftSelection(marking)
}

/** A plane being fitted to a hand-marked surface, fit landed. */
function markedFit() {
  store().startDraft('plane')
  store().setSelectMode('paint')
  store().setDraftSelection(marking)
  store().resolveDraft(asOutput(plane))
}

beforeEach(() => {
  store().beginLoad('test.stl')
  store().finishLoad(0, 0, 100, [0, 0, 0])
  store().setSelectMode('auto')
})

describe('a draft discarded with a marking on it', () => {
  it('is kept by the store, marking and all, and comes back on request', () => {
    markedSearch()
    store().cancelDraft()
    expect(store().draft).toBeNull()
    expect(store().discarded?.method).toBe('plane-symmetry')
    expect(Array.from(store().discarded!.selection!)).toEqual([3, 5, 8, 13, 21])

    store().restoreDraft()
    const d = store().draft!
    expect(d.kind).toBe('plane')
    expect(d.method).toBe('plane-symmetry')
    expect(Array.from(d.selection!)).toEqual([3, 5, 8, 13, 21])
    // Back to be measured on the marking again, not carrying stale numbers.
    expect(d.status).toBe('empty')
    expect(d.fit).toBeUndefined()
    // Under the marking tools, whatever the surface mode had been switched to.
    expect(store().selectMode).toBe('paint')
    expect(store().discarded).toBeNull()
  })

  it('keeps a hand-marked fit the same way', () => {
    markedFit()
    expect(store().draft?.status).toBe('ready')
    store().cancelDraft()
    const kept = store().discarded!
    expect(takesSurface(creationMethod(kept.kind, kept.method))).toBe(true)
    expect(kept.selection).toBe(marking)
    store().restoreDraft()
    expect(store().draft?.selection).toBe(marking)
    expect(store().draft?.status).toBe('empty')
  })

  it('keeps nothing for a draft without a marking, or whose marking was rubbed out', () => {
    store().startDraft('plane')
    store().setDraftPicks([[1, 2, 3]])
    store().resolveDraft(asOutput(plane))
    store().cancelDraft()
    expect(store().discarded).toBeNull()

    markedSearch()
    store().setDraftSelection(null)
    store().cancelDraft()
    expect(store().discarded).toBeNull()

    markedSearch()
    store().setDraftSelection(new Uint32Array(0))
    store().cancelDraft()
    expect(store().discarded).toBeNull()
  })

  it('is let go when the next draft starts, when an element is re-opened, when a scan loads, or on request', () => {
    markedSearch()
    store().cancelDraft()
    store().startDraft('sphere')
    expect(store().discarded).toBeNull()
    store().cancelDraft()

    markedSearch()
    store().cancelDraft()
    store().forgetDiscarded()
    expect(store().discarded).toBeNull()

    markedSearch()
    store().cancelDraft()
    expect(store().discarded).not.toBeNull()
    store().beginLoad('other.stl')
    expect(store().discarded).toBeNull()
  })

  it('is kept when an alignment, a section or a dimension pick takes the panel', () => {
    markedSearch()
    store().startAlignment()
    expect(store().draft).toBeNull()
    expect(store().discarded?.selection).toBe(marking)
    store().cancelAlignment()
    store().restoreDraft()
    expect(store().draft?.method).toBe('plane-symmetry')
    expect(store().alignDraft).toBeNull()

    store().cancelDraft()
    markedSearch()
    store().startSection()
    expect(store().discarded?.selection).toBe(marking)
    store().cancelSection()
    store().restoreDraft()
    expect(store().draft?.selection).toBe(marking)
    expect(store().sectionDraft).toBeNull()
  })

  it('does not come back over an open draft', () => {
    markedSearch()
    store().cancelDraft()
    store().startDraft('cylinder')
    // The new draft cleared it — and even a stale one could not replace an
    // open draft.
    useStore.setState({ discarded: { ...store().draft!, selection: marking } })
    store().restoreDraft()
    expect(store().draft?.kind).toBe('cylinder')
    expect(store().draft?.selection).toBeUndefined()
  })

  it('brings an edit of an element deleted meanwhile back as a new element, and drops a seed that went', () => {
    // An element fitted to a marked surface, re-opened, then abandoned.
    markedFit()
    const id = store().commitDraft()!
    store().editElement(id)
    expect(store().draft?.editId).toBe(id)
    store().cancelDraft()
    expect(store().discarded?.editId).toBe(id)
    store().removeElement(id)
    store().restoreDraft()
    expect(store().draft?.editId).toBeUndefined()
    expect(store().draft?.name).toBeUndefined()
    expect(store().draft?.selection?.length).toBe(marking.length)
    store().cancelDraft()

    // A symmetry search seeded from a plane deleted meanwhile starts from the
    // principal planes instead.
    markedFit()
    const seed = store().commitDraft()!
    markedSearch()
    store().setDraftSeed(seed)
    store().cancelDraft()
    store().removeElement(seed)
    store().restoreDraft()
    expect(store().draft?.seed).toBeNull()
  })
})

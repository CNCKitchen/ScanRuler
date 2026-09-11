// SPDX-License-Identifier: AGPL-3.0-only
// The outlier cut-off is each element's own: a draft starts on the setting
// last chosen, a re-opened element brings the one it was measured with, a
// change re-fits that draft alone, and the summary says which cut-off every
// fitted element rests on.
import { beforeEach, describe, expect, it } from 'vitest'
import { buildSummary } from '../src/core/summary'
import { useStore } from '../src/state/store'
import type { FitOutput, PlaneFit, SphereFit } from '../src/core/types'

const store = () => useStore.getState()

const STATS = { sigma: 0.002, usedPoints: 100, regionSize: 120 }

const plane: PlaneFit = {
  kind: 'plane',
  center: [0, 0, 0],
  normal: [0, 0, 1],
  basisU: [1, 0, 0],
  basisV: [0, 1, 0],
  extentU: 10,
  extentV: 10,
  ...STATS,
}

const ball: SphereFit = { kind: 'sphere', center: [0, 0, 20], radius: 6, ...STATS }

const asOutput = (fit: PlaneFit | SphereFit): FitOutput => ({ ...fit, region: new Uint32Array([1, 2, 3]) })

/** A fitted element the way the pipeline makes one: a draft, a pick, the fit
 *  landing, the element committed — with the cut-off changed on the way if
 *  asked. */
function fitted(fit: PlaneFit | SphereFit, sigma?: 0 | 1 | 2 | 3): number {
  store().startDraft(fit.kind)
  store().setDraftPicks([[1, 2, 3]])
  if (sigma !== undefined) store().setDraftSigma(sigma)
  store().resolveDraft(asOutput(fit))
  const id = store().commitDraft()
  if (id === null) throw new Error('not created')
  return id
}

const sourceOf = (id: number) => {
  const el = store().elements.find((e) => e.id === id)!
  if (el.source.type !== 'fitted') throw new Error('not a fitted element')
  return el.source
}

beforeEach(() => {
  store().beginLoad('test.stl')
  store().finishLoad(0, 0, 100, [0, 0, 0])
  useStore.setState({ settings: { method: 'gaussian', sigma: 3 } })
})

describe('the fit settings of an element', () => {
  it('start a new draft on the session default and go into the element with it', () => {
    store().startDraft('plane')
    expect(store().draft!.settings).toEqual({ method: 'gaussian', sigma: 3 })
    store().cancelDraft()
    const id = fitted(plane)
    expect(sourceOf(id).settings).toEqual({ method: 'gaussian', sigma: 3 })
  })

  it('are the draft\'s own: a change leaves every other element as it was', () => {
    const a = fitted(plane)
    const b = fitted(ball, 1)
    expect(sourceOf(a).settings.sigma).toBe(3)
    expect(sourceOf(b).settings.sigma).toBe(1)
    // A hand-marked surface carries the setting the same way.
    store().startDraft('plane')
    store().setDraftSelection(new Uint32Array([7, 8, 9]))
    store().setDraftSigma(0)
    store().resolveDraft(asOutput(plane))
    const c = store().commitDraft()!
    expect(sourceOf(c)).toEqual({
      type: 'fitted',
      seeds: [],
      selection: new Uint32Array([7, 8, 9]),
      settings: { method: 'gaussian', sigma: 0 },
    })
    expect(sourceOf(a).settings.sigma).toBe(3)
    expect(sourceOf(b).settings.sigma).toBe(1)
  })

  it('are remembered as the default the next new element starts with', () => {
    fitted(plane, 2)
    expect(store().settings.sigma).toBe(2)
    store().startDraft('sphere')
    expect(store().draft!.settings.sigma).toBe(2)
    // The choice is kept even when the draft is thrown away.
    store().setDraftSigma(1)
    store().cancelDraft()
    expect(store().settings.sigma).toBe(1)
  })

  it('come back with a re-opened element, whatever has been chosen since', () => {
    const a = fitted(plane, 1)
    fitted(ball, 0)
    expect(store().settings.sigma).toBe(0)
    store().editElement(a)
    expect(store().draft!.settings.sigma).toBe(1)
    // Written back with the element, changed or not.
    store().setDraftSigma(2)
    store().resolveDraft(asOutput(plane))
    expect(store().commitDraft()).toBe(a)
    expect(sourceOf(a).settings.sigma).toBe(2)
  })

  it('survive a change of creation method inside the draft', () => {
    store().startDraft('plane')
    store().setDraftSigma(1)
    store().setDraftMethod('plane-three-points')
    expect(store().draft!.settings.sigma).toBe(1)
    store().setDraftMethod('fit')
    expect(store().draft!.settings.sigma).toBe(1)
  })

  it('are read out per element in the summary', () => {
    fitted(plane, 3)
    fitted(ball, 0)
    const text = buildSummary('t.stl', store().elements, [])
    expect(text).toContain('Method: Gaussian best-fit\n')
    expect(text).not.toContain('Method: Gaussian best-fit,')
    expect(text).toContain('Plane 1\n  point:')
    expect(text).toContain('used points: 100 of 120 (3 sigma cut-off)')
    expect(text).toContain('used points: 100 of 120 (all points)')
  })
})

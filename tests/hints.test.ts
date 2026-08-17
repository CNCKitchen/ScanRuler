// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { nextHint, type HintInput } from '../src/core/hints'
import { hasLearned, useHintPrefs } from '../src/state/hintStore'

/** A loaded scan and nothing done to it yet, in the measure workspace. */
function base(over: Partial<HintInput> = {}): HintInput {
  return {
    workspace: 'elements',
    busy: false,
    scanLoaded: true,
    fittedElements: 0,
    dimensions: 0,
    draftOpen: false,
    dimDraftOpen: false,
    alignDraftOpen: false,
    onElement: false,
    referenceLoaded: false,
    aligned: false,
    mapReady: false,
    hasTargetElement: false,
    targetChosen: false,
    thicknessReady: false,
    ...over,
  }
}

/** The target named, for the cases where only that matters. */
function target(m: HintInput): string | null {
  const r = nextHint(m)
  return typeof r === 'object' && r !== null ? r.target : null
}

describe('hint ladder', () => {
  it('asks for the scan first, in every workspace', () => {
    for (const workspace of ['elements', 'deviation', 'thickness'] as const) {
      expect(target(base({ workspace, scanLoaded: false }))).toBe('open-scan')
    }
  })

  it('says nothing while the tool is working', () => {
    expect(nextHint(base({ busy: true }))).toBeNull()
    expect(nextHint(base({ busy: true, scanLoaded: false }))).toBeNull()
  })

  it('walks the measure workspace from the scan to a dimension', () => {
    expect(target(base())).toBe('kindrow')
    expect(target(base({ draftOpen: true }))).toBe('create-element')
    // A second element, because a dimension is measured between two.
    expect(target(base({ fittedElements: 1 }))).toBe('kindrow')
    expect(target(base({ fittedElements: 2 }))).toBe('new-dimension')
    expect(target(base({ fittedElements: 2, dimDraftOpen: true }))).toBe('add-dimension')
    expect(nextHint(base({ fittedElements: 2, dimensions: 1 }))).toBe('done')
  })

  it('is finished by a dimension that took only one element', () => {
    expect(nextHint(base({ fittedElements: 1, dimensions: 1 }))).toBe('done')
  })

  it('stands aside while the alignment editor is open', () => {
    expect(nextHint(base({ fittedElements: 2, alignDraftOpen: true }))).toBeNull()
  })

  it('walks the deviation workspace from the reference to the map', () => {
    const dev = (over: Partial<HintInput>) => target(base({ workspace: 'deviation', ...over }))
    expect(dev({})).toBe('open-reference')
    expect(dev({ referenceLoaded: true })).toBe('align-auto')
    expect(dev({ referenceLoaded: true, aligned: true })).toBe('measure-deviation')
    expect(
      nextHint(base({ workspace: 'deviation', referenceLoaded: true, aligned: true, mapReady: true })),
    ).toBe('done')
  })

  it('measures against an element without a reference or an alignment', () => {
    const dev = (over: Partial<HintInput>) =>
      target(base({ workspace: 'deviation', onElement: true, ...over }))
    expect(dev({})).toBe('target-goto-measure')
    expect(dev({ hasTargetElement: true })).toBe('target-select')
    expect(
      nextHint(
        base({ workspace: 'deviation', onElement: true, hasTargetElement: true, targetChosen: true }),
      ),
    ).toBe('done')
  })

  it('is two steps deep in the thickness workspace', () => {
    expect(target(base({ workspace: 'thickness' }))).toBe('measure-thickness')
    expect(nextHint(base({ workspace: 'thickness', thicknessReady: true }))).toBe('done')
  })
})

// The rule these enforce is that finishing a workspace once is not enough to
// conclude the user has learned it — a reload has to give the hints back.
describe('when a workspace stops hinting', () => {
  const s = () => useHintPrefs.getState()

  it('counts a workspace once however often it is finished in one visit', () => {
    s().setOn(true) // a clean slate, and the visit counter with it
    s().markRun('elements')
    s().markRun('elements')
    s().markRun('elements')
    expect(s().runs.elements).toBe(1)
    expect(hasLearned(s(), 'elements')).toBe(false)
  })

  it('takes two visits, and only counts the workspace that was finished', () => {
    expect(hasLearned({ runs: {} }, 'elements')).toBe(false)
    expect(hasLearned({ runs: { elements: 1 } }, 'elements')).toBe(false)
    expect(hasLearned({ runs: { elements: 2 } }, 'elements')).toBe(true)
    expect(hasLearned({ runs: { elements: 2 } }, 'deviation')).toBe(false)
  })

  it('gives everything back when the switch is turned on again', () => {
    s().setOn(true)
    s().markRun('deviation')
    expect(s().runs.deviation).toBe(1)
    s().setOn(false)
    s().setOn(true)
    expect(s().runs).toEqual({})
    expect(hasLearned(s(), 'deviation')).toBe(false)
  })
})

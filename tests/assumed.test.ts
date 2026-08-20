// SPDX-License-Identifier: AGPL-3.0-only
// The assumed design dimension beside a measurement: the suggestion it is
// prefilled with, the typo check on what gets typed, and what the store and
// the STEP export do with it — an assumed diameter has to survive a re-fit
// and an edit, reach the export only when asked for, and stay out of the
// measurement itself.
import { beforeEach, describe, expect, it } from 'vitest'
import {
  applyAssumed,
  assumedWarning,
  hasDiameter,
  suggestedAssumed,
} from '../src/core/elements/assumed'
import { buildStepFile } from '../src/core/exportStep'
import { buildSummary } from '../src/core/summary'
import { useStore } from '../src/state/store'
import type { CircleFit, CylinderFit, FitOutput, PlaneFit, SphereFit } from '../src/core/types'

const NO_STATS = { sigma: 0.002, usedPoints: 100, regionSize: 120 }

const sphere: SphereFit = { kind: 'sphere', center: [1, 2, 3], radius: 2.99, ...NO_STATS }

const cylinder: CylinderFit = {
  kind: 'cylinder',
  center: [0, 0, 10],
  axis: [0, 0, 1],
  radius: 4,
  length: 20,
  coverage: 360,
  ...NO_STATS,
}

const circle: CircleFit = { kind: 'circle', center: [0, 0, 0], normal: [0, 0, 1], radius: 6.215, ...NO_STATS }

const plane: PlaneFit = {
  kind: 'plane',
  center: [5, 5, 0],
  normal: [0, 0, 1],
  basisU: [1, 0, 0],
  basisV: [0, 1, 0],
  extentU: 7,
  extentV: 3,
  ...NO_STATS,
}

describe('the suggested assumed dimension', () => {
  it('finds the round design value a measurement plausibly came from', () => {
    expect(suggestedAssumed(5.98)).toBe(6)
    expect(suggestedAssumed(12.43)).toBe(12.5)
    expect(suggestedAssumed(19.9)).toBe(20)
    expect(suggestedAssumed(7.76)).toBe(7.8)
    expect(suggestedAssumed(300.4)).toBe(300)
  })

  it('prefers the coarsest step that is still credible', () => {
    // 148.637 is 1.36 mm from 150 — too far to be scan noise on this scale —
    // but 0.137 from 148.5, which is exactly the kind of value parts are
    // drawn at.
    expect(suggestedAssumed(148.637)).toBe(148.5)
  })

  it('leaves a value that is already round exactly where it is', () => {
    expect(suggestedAssumed(6)).toBe(6)
    expect(suggestedAssumed(12.5)).toBe(12.5)
  })

  it('falls back to the measurement itself when nothing round is near', () => {
    // Nothing on the design grid gets near a feature this small.
    expect(suggestedAssumed(0.004)).toBe(0.004)
  })
})

describe('the typo check', () => {
  it('accepts a value close to the measurement', () => {
    expect(assumedWarning(5.98, 6)).toBeNull()
    expect(assumedWarning(5.98, 6.4)).toBeNull()
    expect(assumedWarning(148.6, 150)).toBeNull()
  })

  it('flags a value that is off by more than a design decision could be', () => {
    expect(assumedWarning(5.98, 60)).toMatch(/check for a typo/)
    expect(assumedWarning(5.98, 0.6)).toMatch(/check for a typo/)
    expect(assumedWarning(5.98, 6.6)).toMatch(/check for a typo/)
  })

  it('scales its limit with the feature', () => {
    // 5% of 148.6 is far more than the flat half-millimetre.
    expect(assumedWarning(148.6, 154)).toBeNull()
    expect(assumedWarning(148.6, 160)).toMatch(/check for a typo/)
  })

  it('says how far off the value is', () => {
    expect(assumedWarning(5.98, 60)).toContain('54.02 mm')
    expect(assumedWarning(5.98, 60)).toContain('Ø 5.98 mm')
  })

  it('leaves nonsense to the input clamp', () => {
    expect(assumedWarning(5.98, NaN)).toBeNull()
    expect(assumedWarning(5.98, -2)).toBeNull()
  })
})

describe('applying an assumed dimension', () => {
  it('swaps the radius and nothing else', () => {
    const out = applyAssumed(cylinder, 8.5) as CylinderFit
    expect(out.radius).toBe(4.25)
    expect(out.length).toBe(20)
    expect(out.center).toEqual([0, 0, 10])
    expect(out.sigma).toBe(cylinder.sigma)
  })

  it('is the identity without a value, on the wrong kind, or on nonsense', () => {
    expect(applyAssumed(cylinder, undefined)).toBe(cylinder)
    expect(applyAssumed(plane, 6)).toBe(plane)
    expect(applyAssumed(sphere, 0)).toBe(sphere)
    expect(applyAssumed(sphere, NaN)).toBe(sphere)
    // A value that merely restates the measurement changes nothing.
    expect(applyAssumed(cylinder, 8)).toBe(cylinder)
  })

  it('exists for exactly the kinds defined by a diameter', () => {
    expect(hasDiameter(sphere)).toBe(true)
    expect(hasDiameter(cylinder)).toBe(true)
    expect(hasDiameter(circle)).toBe(true)
    expect(hasDiameter(plane)).toBe(false)
    expect(hasDiameter(undefined)).toBe(false)
  })
})

describe('an assumed dimension in the store', () => {
  const store = () => useStore.getState()
  const asOutput = (fit: SphereFit | PlaneFit): FitOutput => ({
    ...fit,
    region: new Uint32Array([1, 2, 3]),
  })

  beforeEach(() => {
    store().beginLoad('test.stl')
    store().finishLoad(0, 0, 100, [0, 0, 0])
  })

  function draftSphere(): void {
    store().startDraft('sphere')
    store().setDraftPicks([[1, 2, 3]])
    store().resolveDraft(asOutput(sphere))
  }

  it('commits with the suggestion when the field was never touched', () => {
    draftSphere()
    const id = store().commitDraft()!
    // Measured Ø 5.98 — the element goes out assumed to be the Ø 6 it was
    // designed at.
    expect(store().elements.find((e) => e.id === id)!.assumed).toBe(6)
  })

  it('keeps what was typed instead, through commit and re-opening', () => {
    draftSphere()
    store().setDraftAssumed(6.02)
    const id = store().commitDraft()!
    expect(store().elements.find((e) => e.id === id)!.assumed).toBe(6.02)

    store().editElement(id)
    expect(store().draft!.assumed).toBe(6.02)
    // A re-fit inside the draft (a changed outlier cut-off) does not touch it.
    store().resolveDraft(asOutput({ ...sphere, radius: 2.987 }))
    expect(store().draft!.assumed).toBe(6.02)
  })

  it('ignores values that are not a positive number', () => {
    draftSphere()
    store().setDraftAssumed(NaN)
    store().setDraftAssumed(-3)
    store().setDraftAssumed(0)
    expect(store().draft!.assumed).toBeUndefined()
  })

  it('never lands on a kind without a diameter', () => {
    store().startDraft('plane')
    store().setDraftPicks([[1, 2, 3]])
    store().resolveDraft(asOutput(plane))
    store().setDraftAssumed(6)
    const id = store().commitDraft()!
    expect(store().elements.find((e) => e.id === id)!.assumed).toBeUndefined()
  })

  it('rides through an alignment untouched — it is a size, not a position', () => {
    draftSphere()
    store().setDraftAssumed(6)
    const id = store().commitDraft()!
    store().applyAlignment({
      r: new Float64Array([1, 0, 0, 0, 0, -1, 0, 1, 0]),
      t: new Float64Array([10, 0, 0]),
    })
    expect(store().elements.find((e) => e.id === id)!.assumed).toBe(6)
  })
})

describe('the assumed dimension on the way out', () => {
  it('reaches the STEP text only when applied', () => {
    const measured = buildStepFile(
      [{ name: 'Cylinder 1', fit: cylinder }],
      'scan.stl',
      '2026-08-20T12:00:00',
      'surfaces',
    )
    expect(measured).toContain('CYLINDRICAL_SURFACE')
    expect(measured).toContain(',4.)')

    const assumed = buildStepFile(
      [{ name: 'Cylinder 1', fit: applyAssumed(cylinder, 8.5) }],
      'scan.stl',
      '2026-08-20T12:00:00',
      'surfaces',
    )
    expect(assumed).toContain(',4.25)')
    expect(assumed).not.toContain(',4.)')
  })

  it('is reported beside the measurement in the summary, never instead of it', () => {
    const text = buildSummary(
      'scan.stl',
      { method: 'gaussian', sigma: 3 },
      [
        {
          id: 1,
          name: 'Sphere 1',
          kind: 'sphere',
          source: { type: 'fitted', seeds: [] },
          fit: sphere,
          assumed: 6,
        },
      ],
      [],
    )
    expect(text).toContain('diameter: 5.9800 mm')
    expect(text).toContain('assumed diameter: 6.0000 mm')
  })

  it('stays out of the summary when it merely restates the measurement', () => {
    const text = buildSummary(
      'scan.stl',
      { method: 'gaussian', sigma: 3 },
      [
        {
          id: 1,
          name: 'Sphere 1',
          kind: 'sphere',
          source: { type: 'fitted', seeds: [] },
          fit: { ...sphere, radius: 3 },
          assumed: 6,
        },
      ],
      [],
    )
    expect(text).not.toContain('assumed diameter')
  })
})

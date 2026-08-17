// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it } from 'vitest'
import { useDeviation } from '../src/state/deviationStore'
import { identityRigid } from '../src/core/deviation/rigid'
import type { AlignResult } from '../src/core/deviation/align'

function doneAlign(): AlignResult {
  return {
    transform: identityRigid(),
    source: 'auto',
    rms: 0.05,
    meanDistance: 0.04,
    iterations: 10,
    matched: 1000,
    sampled: 1000,
    ambiguous: false,
  }
}

beforeEach(() => {
  useDeviation.getState().clearAlign()
  useDeviation.getState().clearElementMap()
  useDeviation.setState({
    source: 'reference',
    rangeAuto: true,
    maxDistanceAuto: true,
    mapVersion: 0,
    elementVersion: 0,
  })
})

describe('deviation store', () => {
  it('keeps a good alignment when the measurement fails', () => {
    const s = () => useDeviation.getState()
    s().resolveAlign(doneAlign())
    s().beginMap()
    s().failMap('worker died')
    expect(s().mapStatus).toBe('idle')
    expect(s().alignStatus).toBe('done')
    expect(s().align).not.toBeNull()
    expect(s().alignMessage).toBe('worker died')
  })

  it('applies the suggested search distance until the user overrides it', () => {
    const s = () => useDeviation.getState()
    s().resolveMap(0.4, 2.5)
    expect(s().maxDistance).toBe(2.5)
    // Still automatic, so a re-measure may move it.
    s().resolveMap(0.4, 1.5)
    expect(s().maxDistance).toBe(1.5)
    // The user's word beats every later suggestion…
    s().setMaxDistance(5)
    s().resolveMap(0.4, 2.5)
    expect(s().maxDistance).toBe(5)
    // …until a fresh session clears the override.
    s().clearAlign()
    s().resolveMap(0.4, 2.5)
    expect(s().maxDistance).toBe(2.5)
  })
})

describe('measuring against a reference part or an element', () => {
  const s = () => useDeviation.getState()

  it('keeps both maps, so switching what is measured against loses neither', () => {
    s().resolveAlign(doneAlign())
    s().resolveMap(0.4, 2.5)
    s().setSource('element')
    s().setTarget(7, -1)
    s().resolveElementMap(0.2)
    expect(s().elementStatus).toBe('ready')
    // The reference map is still measured under the alignment it was measured
    // under — switching is a change of what is being read, not of what is known.
    expect(s().mapStatus).toBe('ready')
    expect(s().align).not.toBeNull()
    s().setSource('reference')
    expect(s().mapStatus).toBe('ready')
    expect(s().elementStatus).toBe('ready')
  })

  it('drops the pinned readings on the way between them', () => {
    s().resolveAlign(doneAlign())
    s().resolveMap(0.4, 2.5)
    s().addProbe([1, 2, 3], 0.12)
    expect(s().probes).toHaveLength(1)
    // A reading off one map and a reading off the other are both millimetres on
    // the same part and look identical on it.
    s().setSource('element')
    expect(s().probes).toHaveLength(0)
  })

  it('takes the map with the element it was measured against', () => {
    s().setSource('element')
    s().setTarget(7, 1)
    s().resolveElementMap(0.2)
    s().setTarget(9, -1)
    expect(s().elementStatus).toBe('idle')
    expect(s().targetId).toBe(9)
    expect(s().targetSide).toBe(-1)
  })

  it('leaves the reference readout alone when the element map is cleared behind it', () => {
    s().resolveAlign(doneAlign())
    s().resolveMap(0.4, 2.5)
    s().setSource('element')
    s().setTarget(7, 1)
    s().resolveElementMap(0.2)
    s().setSource('reference')
    s().setReadout(
      { min: -1, max: 1, mean: 0, rms: 0.1, sigma: 0.1, measured: 10, total: 10, withinTolerance: 9, tolerance: 0.1 },
      { bins: Uint32Array.of(1), low: -1, high: 1, peak: 1 },
    )
    // The element the other map was measured against goes away — deleted in the
    // measure workspace — while the reference map is the one on screen.
    s().clearElementMap()
    expect(s().elementStatus).toBe('idle')
    expect(s().stats).not.toBeNull()
    expect(s().histogram).not.toBeNull()
  })

  it('clamps the facing limit and lets it be switched off', () => {
    s().setTargetFacing(200)
    expect(s().targetFacingDeg).toBe(90)
    s().setTargetFacing(0)
    expect(s().targetFacingDeg).toBe(1)
    s().setTargetFacing(null)
    expect(s().targetFacingDeg).toBeNull()
  })

  it('flips the material side', () => {
    s().setTarget(7, 1)
    s().flipTargetSide()
    expect(s().targetSide).toBe(-1)
    s().flipTargetSide()
    expect(s().targetSide).toBe(1)
  })
})

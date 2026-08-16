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
  useDeviation.setState({ rangeAuto: true, maxDistanceAuto: true, mapVersion: 0 })
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

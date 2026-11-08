// SPDX-License-Identifier: AGPL-3.0-only
// The wheel's zoom by how far it scrolled (issue 34): a trackpad's small
// deltas each took a full step, and a sideways scroll zoomed out.
import { describe, expect, it } from 'vitest'
import { wheelZoomFactor } from '../src/viewer/orthoNav'

describe('wheelZoomFactor', () => {
  it('zooms a mouse notch 1.1×, in either scheme', () => {
    expect(wheelZoomFactor(-100, 0, false)).toBeCloseTo(1.1, 12)
    expect(wheelZoomFactor(100, 0, false)).toBeCloseTo(1 / 1.1, 12)
    expect(wheelZoomFactor(-100, 0, true)).toBeCloseTo(1 / 1.1, 12)
    // Firefox counts three lines a notch.
    expect(wheelZoomFactor(-3, 1, false)).toBeCloseTo(1.1, 12)
  })

  it('zooms a trackpad by as much as it scrolled, not a step a delta', () => {
    // Twenty deltas of 5 px: one notch in all.
    const total = Array.from({ length: 20 }, () => wheelZoomFactor(-5, 0, false)).reduce((a, b) => a * b, 1)
    expect(total).toBeCloseTo(1.1, 12)
    expect(wheelZoomFactor(-5, 0, false)).toBeLessThan(1.01)
  })

  it('does nothing for a scroll with no vertical part, and caps a burst', () => {
    expect(wheelZoomFactor(0, 0, false)).toBe(1)
    expect(wheelZoomFactor(-0, 0, true)).toBe(1)
    expect(wheelZoomFactor(-5000, 0, false)).toBeCloseTo(1.1 ** 3, 12)
    expect(wheelZoomFactor(-1, 2, false)).toBeCloseTo(1.1 ** 3, 12)
  })
})

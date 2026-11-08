// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { deviationStats } from '../src/core/deviation/deviation'
import { thicknessStats } from '../src/core/thickness/thickness'
import { fieldHistogram } from '../src/core/field/stats'
import {
  cachedDeviationStats,
  cachedHistogram,
  cachedThicknessStats,
} from '../src/core/field/readoutCache'

function map(n = 500): Float32Array {
  const v = new Float32Array(n)
  for (let i = 0; i < n; i++) v[i] = Math.sin(i * 0.37) * 0.8
  v[3] = NaN
  return v
}

describe('readout cache', () => {
  it('hands back the same object for the same arguments', () => {
    const v = map()
    expect(cachedHistogram(v, 1, -0.5, 0.5, -1, 1)).toBe(cachedHistogram(v, 1, -0.5, 0.5, -1, 1))
    expect(cachedDeviationStats(v, 1, 1, 0.1)).toBe(cachedDeviationStats(v, 1, 1, 0.1))
    expect(cachedThicknessStats(v, 1, 0.2)).toBe(cachedThicknessStats(v, 1, 0.2))
  })

  it('recomputes when the same array arrives under a new version', () => {
    const v = map()
    const hist = cachedHistogram(v, 1, -0.5, 0.5, -1, 1)
    const dev = cachedDeviationStats(v, 1, 1, 0.1)
    const thick = cachedThicknessStats(v, 1, 0.2)
    for (let i = 0; i < v.length; i += 2) v[i] += 0.3
    const hist2 = cachedHistogram(v, 2, -0.5, 0.5, -1, 1)
    const dev2 = cachedDeviationStats(v, 2, 1, 0.1)
    const thick2 = cachedThicknessStats(v, 2, 0.2)
    expect(hist2).not.toBe(hist)
    expect(dev2).not.toBe(dev)
    expect(thick2).not.toBe(thick)
    expect(hist2).toEqual(fieldHistogram(v, -0.5, 0.5, -1, 1))
    expect(dev2).toEqual(deviationStats(v, 1, 0.1))
    expect(thick2).toEqual(thicknessStats(v, 0.2))
  })

  it('recomputes the figure whose argument moved and keeps the other', () => {
    const v = map()
    const hist = cachedHistogram(v, 1, -0.5, 0.5, -1, 1)
    const dev = cachedDeviationStats(v, 1, 1, 0.1)
    // A range change moves the histogram only: the tally does not read the range.
    const hist2 = cachedHistogram(v, 1, -0.25, 0.25, -1, 1)
    expect(hist2).not.toBe(hist)
    expect(hist2).toEqual(fieldHistogram(v, -0.25, 0.25, -1, 1))
    expect(cachedDeviationStats(v, 1, 1, 0.1)).toBe(dev)
    // A tolerance change moves the tally only.
    const dev2 = cachedDeviationStats(v, 1, 1, 0.2)
    expect(dev2).not.toBe(dev)
    expect(dev2).toEqual(deviationStats(v, 1, 0.2))
    expect(cachedHistogram(v, 1, -0.25, 0.25, -1, 1)).toBe(hist2)
  })

  it('keeps separate results for separate arrays', () => {
    const a = map()
    const b = map(300)
    const ha = cachedHistogram(a, 1, -0.5, 0.5, -1, 1)
    const hb = cachedHistogram(b, 1, -0.5, 0.5, -1, 1)
    expect(hb).not.toBe(ha)
    expect(cachedHistogram(a, 1, -0.5, 0.5, -1, 1)).toBe(ha)
  })
})

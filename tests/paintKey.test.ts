// SPDX-License-Identifier: AGPL-3.0-only
// The key a painted colour buffer is remembered by: the same key must mean the
// same bytes out of `paintField`, and any input a paint reads must move it.
import { describe, expect, it } from 'vitest'
import { COLORMAPS, colormapById, paintField, paintKey, type FieldScale } from '../src/core/field/colormap'
import { deviationScale } from '../src/core/deviation/deviation'
import { thicknessScale } from '../src/core/thickness/thickness'

const SCALE: FieldScale = { low: -0.5, high: 0.5, bands: null, validMin: -2, validMax: 2 }

describe('paintKey', () => {
  it('is the same for the same inputs, whichever object the scale is', () => {
    expect(paintKey(3, { ...SCALE }, 'jet')).toBe(paintKey(3, SCALE, 'jet'))
    expect(paintKey(3, deviationScale(0.5, 2, null), 'jet')).toBe(paintKey(3, deviationScale(0.5, 2, null), 'jet'))
  })

  it('moves with the version', () => {
    expect(paintKey(4, SCALE, 'jet')).not.toBe(paintKey(3, SCALE, 'jet'))
  })

  it('moves with the colour map', () => {
    const keys = new Set(COLORMAPS.map((m) => paintKey(1, SCALE, m.id)))
    expect(keys.size).toBe(COLORMAPS.length)
  })

  it('moves with every part of the scale a paint reads', () => {
    const base = paintKey(1, SCALE, 'jet')
    const variants: FieldScale[] = [
      { ...SCALE, low: -0.6 },
      { ...SCALE, high: 0.6 },
      { ...SCALE, bands: 5 },
      { ...SCALE, validMin: -3 },
      { ...SCALE, validMax: 3 },
      { ...SCALE, reversed: true },
    ]
    for (const v of variants) expect(paintKey(1, v, 'jet')).not.toBe(base)
    expect(new Set(variants.map((v) => paintKey(1, v, 'jet'))).size).toBe(variants.length)
  })

  it('tells band counts apart, and unbanded from banded', () => {
    expect(paintKey(1, { ...SCALE, bands: 5 }, 'jet')).not.toBe(paintKey(1, { ...SCALE, bands: 7 }, 'jet'))
    expect(paintKey(1, { ...SCALE, bands: null }, 'jet')).not.toBe(paintKey(1, { ...SCALE, bands: 2 }, 'jet'))
  })

  it('is the same for an absent reversed flag and a false one', () => {
    expect(paintKey(1, { ...SCALE, reversed: false }, 'jet')).toBe(paintKey(1, SCALE, 'jet'))
  })

  it('holds the infinite ends of the reference and thickness windows', () => {
    const a = paintKey(1, thicknessScale(1, 5, null), 'jet')
    expect(a).toContain('Infinity')
    expect(paintKey(1, { ...thicknessScale(1, 5, null), validMax: 50 }, 'jet')).not.toBe(a)
  })

  it('stands for the bytes: equal keys paint equal buffers', () => {
    const values = Float32Array.from([-1, -0.4, -0.1, 0, 0.1, 0.4, 1, 5, NaN])
    const paint = (scale: FieldScale, id: string): Uint8Array => {
      const out = new Uint8Array(values.length * 3)
      paintField(values, scale, colormapById(id), out)
      return out
    }
    const scales: FieldScale[] = [
      SCALE,
      { ...SCALE },
      { ...SCALE, bands: 5 },
      { ...SCALE, reversed: true },
      { ...SCALE, validMax: 0.2 },
      { ...SCALE, high: 0.2 },
    ]
    const seen = new Map<string, Uint8Array>()
    for (const scale of scales) {
      for (const id of ['jet', 'viridis']) {
        const key = paintKey(1, scale, id)
        const bytes = paint(scale, id)
        const prior = seen.get(key)
        if (prior) expect(bytes).toEqual(prior)
        seen.set(key, bytes)
      }
    }
    // The copy of SCALE shares its keys; every other scale and map is its own.
    expect(seen.size).toBe((scales.length - 1) * 2)
  })
})

// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import {
  COLORMAPS,
  colormapById,
  legendGradient,
  paintField,
  rampColor,
  scaleCaps,
  UNMEASURED_RGB,
  type Colormap,
  type Rgb,
} from '../src/core/field/colormap'
import { deviationScale } from '../src/core/deviation/deviation'
import { thicknessScale } from '../src/core/thickness/thickness'
import { usePrefs } from '../src/state/prefsStore'

function at(map: Colormap, t: number): [number, number, number] {
  const c: [number, number, number] = [0, 0, 0]
  rampColor(map, t, c)
  return c
}

const hex = (c: Rgb): string =>
  '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()

/** CIELAB of an sRGB colour under D65 — how far apart two colours look,
 *  rather than how far apart their bytes are. */
function lab(c: Rgb): [number, number, number] {
  const lin = c.map((v) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  const x = (0.4124 * lin[0] + 0.3576 * lin[1] + 0.1805 * lin[2]) / 0.95047
  const y = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
  const z = (0.0193 * lin[0] + 0.1192 * lin[1] + 0.9505 * lin[2]) / 1.08883
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116)
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))]
}

const deltaE = (a: Rgb, b: Rgb): number => {
  const p = lab(a)
  const q = lab(b)
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
}

describe('the colour maps', () => {
  it('offers jet first, then the eight of the viridis package', () => {
    expect(COLORMAPS.map((m) => m.id)).toEqual([
      'jet',
      'viridis',
      'magma',
      'plasma',
      'inferno',
      'cividis',
      'mako',
      'rocket',
      'turbo',
    ])
    expect(colormapById('jet').label).toBe('Jet')
  })

  it('falls back to jet for a map this version does not know', () => {
    expect(colormapById('rainbow').id).toBe('jet')
    expect(colormapById(null).id).toBe('jet')
    expect(colormapById(undefined).id).toBe('jet')
  })

  it('keeps jet as it was, a saturated green pinned in the middle', () => {
    const jet = colormapById('jet')
    expect(at(jet, 0)).toEqual([0, 0, 255])
    expect(at(jet, 0.25)).toEqual([0, 255, 255])
    expect(at(jet, 0.5)).toEqual([0, 200, 0])
    expect(at(jet, 0.75)).toEqual([255, 255, 0])
    expect(at(jet, 1)).toEqual([255, 0, 0])
    expect(jet.under).toEqual([0, 0, 110])
    expect(jet.over).toEqual([130, 0, 0])
  })

  it('reads the published tables, colour for colour', () => {
    // The ends R's viridisLite gives — viridis(2), magma(2) and so on.
    const ends: Record<string, [string, string]> = {
      viridis: ['#440154', '#FDE725'],
      magma: ['#000004', '#FCFDBF'],
      plasma: ['#0D0887', '#F0F921'],
      inferno: ['#000004', '#FCFFA4'],
      cividis: ['#00204D', '#FFEA46'],
      mako: ['#0B0405', '#DEF5E5'],
      rocket: ['#03051A', '#FAEBDD'],
      turbo: ['#30123B', '#7A0403'],
    }
    for (const [id, [low, high]] of Object.entries(ends)) {
      const map = colormapById(id)
      expect(map.id).toBe(id)
      expect(map.stops.length).toBe(256 * 3)
      expect(hex(at(map, 0))).toBe(low)
      expect(hex(at(map, 1))).toBe(high)
    }
    // Between two entries of a table, a straight line between them.
    const viridis = colormapById('viridis')
    const a = at(viridis, 100 / 255)
    const b = at(viridis, 101 / 255)
    const mid = at(viridis, 100.5 / 255)
    for (let k = 0; k < 3; k++) expect(Math.abs(mid[k] - (a[k] + b[k]) / 2)).toBeLessThanOrEqual(0.5)
  })

  it('caps every map in colours it never uses, far from the bare grey and from each other', () => {
    // Jet's own caps sit about 45 apart from its ramp; every map's must do as
    // well, or an off-scale reading could pass for an end of the scale.
    for (const map of COLORMAPS) {
      const ramp = Array.from({ length: 256 }, (_, i) => at(map, i / 255))
      for (const cap of [map.under, map.over]) {
        const nearest = Math.min(...ramp.map((c) => deltaE(c, cap)))
        expect(nearest, `${map.id} cap ${hex(cap)} against its ramp`).toBeGreaterThan(40)
        expect(deltaE(cap, UNMEASURED_RGB), `${map.id} cap ${hex(cap)} against bare`).toBeGreaterThan(40)
      }
      expect(deltaE(map.under, map.over), `${map.id} caps against each other`).toBeGreaterThan(40)
    }
  })

  it('paints the chosen map, each off-scale reading in the cap of the end it ran off', () => {
    const viridis = colormapById('viridis')
    const values = Float32Array.from([0, 2, -2, 50])
    const out = new Uint8Array(12)
    paintField(values, deviationScale(1, 10, null), viridis, out)
    expect(Array.from(out.slice(0, 3))).toEqual(at(viridis, 0.5))
    expect(Array.from(out.slice(3, 6))).toEqual([...viridis.over])
    expect(Array.from(out.slice(6, 9))).toEqual([...viridis.under])
    expect(Array.from(out.slice(9, 12))).toEqual([...UNMEASURED_RGB])

    // Thickness runs the ramp the other way, and its caps with it: thin is
    // the high end, so a wall thinner than the scale wears the high end's cap.
    const thick = thicknessScale(1, 3, null)
    paintField(Float32Array.from([0.5, 3.5, 1]), thick, viridis, out)
    expect(Array.from(out.slice(0, 3))).toEqual([...viridis.over])
    expect(Array.from(out.slice(3, 6))).toEqual([...viridis.under])
    expect(Array.from(out.slice(6, 9))).toEqual(at(viridis, 1))
    expect(scaleCaps(thick, viridis)).toEqual({ low: viridis.over, high: viridis.under })
    expect(scaleCaps(deviationScale(1, 10, null), viridis)).toEqual({
      low: viridis.under,
      high: viridis.over,
    })
  })

  it('draws the legend in the chosen map, the way round the map runs', () => {
    const viridis = colormapById('viridis')
    const up = legendGradient(viridis, null)
    expect(up.startsWith('linear-gradient(to top, rgb(68,1,84) 0.00%')).toBe(true)
    expect(up.endsWith('rgb(253,231,37) 100.00%)')).toBe(true)
    expect(legendGradient(viridis, null, true).endsWith('rgb(68,1,84) 100.00%)')).toBe(true)
    expect(legendGradient(viridis, 4, false, 'right').startsWith('linear-gradient(to right, ')).toBe(true)
  })

  it('is remembered as a preference, and an unknown one is jet', () => {
    usePrefs.getState().setColormap('mako')
    expect(usePrefs.getState().colormap).toBe('mako')
    usePrefs.getState().setColormap('nonsense' as never)
    expect(usePrefs.getState().colormap).toBe('jet')
  })
})

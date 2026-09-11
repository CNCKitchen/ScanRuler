// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  DEFAULT_THEME,
  STAGE_DARK,
  STAGE_LIGHT,
  VIEW_THEMES,
  sceneTheme,
  setSurfaceColor,
  themeById,
} from '../src/viewer/viewThemes'
import { UNMEASURED_RGB } from '../src/core/field/colormap'
import { PALETTE } from '../src/state/palette'

/** The colour schemes are a way of looking, never a way of measuring. These
 *  pin the two things that would make one a lie: a scheme whose bare surface
 *  could be mistaken for a reading, and a reference part wearing the scan's
 *  own colour. */
describe('viewport colour schemes', () => {
  it('has unique ids and a default among them', () => {
    const ids = VIEW_THEMES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain(DEFAULT_THEME.id)
  })

  it('falls back to the default for unknown ids', () => {
    expect(themeById('scanner').id).toBe('scanner')
    expect(themeById('not-a-scheme').id).toBe(DEFAULT_THEME.id)
    expect(themeById(null).id).toBe(DEFAULT_THEME.id)
    expect(themeById(undefined).id).toBe(DEFAULT_THEME.id)
  })

  it('dresses a scheme for the dark chassis without touching what it measures', () => {
    for (const t of VIEW_THEMES) {
      expect(sceneTheme(t.id, false)).toBe(t)
      expect(t.stage).toBe(STAGE_LIGHT)
      const dark = sceneTheme(t.id, true)
      expect(dark.id).toBe(t.id)
      expect(dark.stage).toBe(STAGE_DARK)
      // The part is the same material under the same lights on either chassis
      // — only the stage behind it and the marks drawn over it change.
      expect(dark.surface).toEqual(t.surface)
      expect(dark.nominal).toBe(t.nominal)
      expect(dark.backface).toBe(t.backface)
      expect(dark.finish).toEqual(t.finish)
      expect(dark.lights).toEqual(t.lights)
    }
    expect(sceneTheme('not-a-scheme', true).id).toBe(DEFAULT_THEME.id)
  })

  it('lifts the studio scheme’s ink off the dark stage', () => {
    // The callout lines between elements float over the stage rather than the
    // part, so the studio's ink would vanish on the dark chassis. The scanner
    // scheme's marks are white and amber already and are left alone.
    const lum = (hex: number) =>
      (0.2126 * ((hex >> 16) & 255) + 0.7152 * ((hex >> 8) & 255) + 0.0722 * (hex & 255)) / 255
    const studio = sceneTheme('studio', true)
    expect(lum(studio.accents.callout)).toBeGreaterThan(0.6)
    expect(lum(themeById('studio').accents.callout)).toBeLessThan(0.3)
    expect(studio.accents.marqueeStroke).not.toBe(themeById('studio').accents.marqueeStroke)
    const scanner = sceneTheme('scanner', true)
    expect(scanner.accents).toBe(themeById('scanner').accents)
  })

  it('never dresses the reference in the scan’s own colour', () => {
    for (const t of VIEW_THEMES) {
      const surface = (t.surface[0] << 16) | (t.surface[1] << 8) | t.surface[2]
      expect(t.nominal, `${t.id} reference`).not.toBe(surface)
      expect(t.backface, `${t.id} back faces`).not.toBe(surface)
    }
  })

  it('keeps every element colour clear of the bare surface it is painted on', () => {
    // An element's region is tinted straight onto the scan, so a scheme whose
    // bare surface sat on top of one of the eight would make that element's
    // surface invisible. Weighted RGB (2, 4, 3) — the cheap standard stand-in
    // for how far apart two colours actually look.
    for (const t of VIEW_THEMES) {
      for (const hex of PALETTE) {
        const p = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
        const d = Math.sqrt(
          2 * (p[0] - t.surface[0]) ** 2 +
            4 * (p[1] - t.surface[1]) ** 2 +
            3 * (p[2] - t.surface[2]) ** 2,
        )
        expect(d, `${t.id} surface against ${hex}`).toBeGreaterThan(90)
      }
    }
  })

  it('keeps the working accents clear of the surface they are drawn on', () => {
    // The brush footprint and the callout lines sit right on the bare surface,
    // and an accent the surface swallows is invisible exactly where the user
    // is looking — the scanner scheme exists because ink and the palette's
    // blues vanish on its blue. Same weighted distance as the palette check.
    for (const t of VIEW_THEMES) {
      const accents: Record<string, number> = {
        brushErase: t.accents.brushErase,
        callout: t.accents.callout,
      }
      if (t.accents.brushRing !== null) accents.brushRing = t.accents.brushRing
      for (const [name, hex] of Object.entries(accents)) {
        const p = [16, 8, 0].map((s) => (hex >> s) & 0xff)
        const d = Math.sqrt(
          2 * (p[0] - t.surface[0]) ** 2 +
            4 * (p[1] - t.surface[1]) ** 2 +
            3 * (p[2] - t.surface[2]) ** 2,
        )
        expect(d, `${t.id} ${name}`).toBeGreaterThan(90)
      }
    }
  })

  it('paints a flat part the shade a vertex-coloured one comes out', () => {
    // The split view puts a flat-coloured reference beside the vertex-coloured
    // scan and claims they are the same material. three.js colour-manages
    // material.color but hands vertex colours to the shader untouched, so the
    // bytes have to go in as working-space values: setHex would take them for
    // sRGB, convert them, and land the reference a whole gamma darker than the
    // scan next to it.
    const color = new THREE.Color()
    for (const t of VIEW_THEMES) {
      setSurfaceColor(color, t)
      expect([color.r, color.g, color.b].map((c) => Math.round(c * 255)), t.id).toEqual([
        ...t.surface,
      ])
    }
  })

  it('leaves the map its own unmeasured grey to fall back on', () => {
    // The bare surface is the scheme's; the grey a map paints where nothing was
    // measured is the map's, and stays put — on a coloured ramp it has to be a
    // tone no band of the ramp owns, whatever stage the part is standing on.
    expect(UNMEASURED_RGB).toEqual([126, 131, 138])
    expect(themeById('studio').surface).toEqual(UNMEASURED_RGB)
  })
})

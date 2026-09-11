// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import {
  LINE_MAX,
  LINE_MIN,
  LINE_STEP,
  SECTION_LINE_DEFAULT,
  SHEET_LINE_DEFAULT,
  clampLineWidth,
} from '../src/viewer/lineWidths'

/** The line-width settings come out of storage as strings, and out of a
 *  slider as numbers; either way what reaches a scene has to be a width it
 *  can draw. */
describe('line width settings', () => {
  it('ships defaults inside the range the sliders run over', () => {
    for (const d of [SECTION_LINE_DEFAULT, SHEET_LINE_DEFAULT]) {
      expect(d).toBeGreaterThanOrEqual(LINE_MIN)
      expect(d).toBeLessThanOrEqual(LINE_MAX)
      expect(clampLineWidth(d, 99)).toBe(d)
    }
  })

  it('reads what storage holds and falls back to the default for anything else', () => {
    expect(clampLineWidth('3.5', SECTION_LINE_DEFAULT)).toBe(3.5)
    expect(clampLineWidth(3, SECTION_LINE_DEFAULT)).toBe(3)
    expect(clampLineWidth(null, SECTION_LINE_DEFAULT)).toBe(SECTION_LINE_DEFAULT)
    expect(clampLineWidth('', SHEET_LINE_DEFAULT)).toBe(SHEET_LINE_DEFAULT)
    expect(clampLineWidth('wide', SHEET_LINE_DEFAULT)).toBe(SHEET_LINE_DEFAULT)
    expect(clampLineWidth(NaN, SHEET_LINE_DEFAULT)).toBe(SHEET_LINE_DEFAULT)
    expect(clampLineWidth(Infinity, SHEET_LINE_DEFAULT)).toBe(SHEET_LINE_DEFAULT)
  })

  it('keeps a width on the slider’s steps and inside its range', () => {
    expect(clampLineWidth(0, 2.5)).toBe(LINE_MIN)
    expect(clampLineWidth(-4, 2.5)).toBe(LINE_MIN)
    expect(clampLineWidth(40, 2.5)).toBe(LINE_MAX)
    expect(clampLineWidth(2.74, 2.5)).toBe(2.5)
    expect(clampLineWidth(2.76, 2.5)).toBe(3)
    expect((clampLineWidth(4.1, 2.5) / LINE_STEP) % 1).toBe(0)
  })
})

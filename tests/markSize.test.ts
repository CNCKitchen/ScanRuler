// SPDX-License-Identifier: AGPL-3.0-only
// Settings → Points and grips: the factor on every mark held at a size on
// the screen, stored and read back within its range (issue 47).

import { describe, expect, it } from 'vitest'
import { clampMarkSize, MARK_SIZE_DEFAULT, MARK_SIZE_MAX, MARK_SIZE_MIN } from '../src/viewer/markSize'

describe('the size of the marks on the screen', () => {
  it('is 1 where nothing usable is stored', () => {
    for (const v of [null, undefined, '', 'big', NaN]) expect(clampMarkSize(v)).toBe(MARK_SIZE_DEFAULT)
    expect(MARK_SIZE_DEFAULT).toBe(1)
  })

  it('keeps to its range and its steps', () => {
    expect(clampMarkSize('1.5')).toBe(1.5)
    expect(clampMarkSize(1.6)).toBe(1.5)
    expect(clampMarkSize(0.1)).toBe(MARK_SIZE_MIN)
    expect(clampMarkSize(9)).toBe(MARK_SIZE_MAX)
  })
})

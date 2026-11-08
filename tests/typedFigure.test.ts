// SPDX-License-Identifier: AGPL-3.0-only
// A number field emptied or holding a typo commits nothing: Number('') is 0,
// so reading the value straight cleared a field to zero (issue 34).
import { describe, expect, it } from 'vitest'
import { typedFigure } from '../src/ui/NumberField'

const input = (value: string, badInput = false) =>
  ({ value, validity: { badInput } }) as unknown as HTMLInputElement

describe('typedFigure', () => {
  it('reads a typed figure', () => {
    expect(typedFigure(input('12.5'))).toBe(12.5)
    expect(typedFigure(input(' -0.25 '))).toBe(-0.25)
    expect(typedFigure(input('0'))).toBe(0)
  })

  it('reads an emptied field or a typo as no figure, not zero', () => {
    expect(typedFigure(input(''))).toBeNull()
    expect(typedFigure(input('   '))).toBeNull()
    // A number input reports "0.1.2" as an empty value with badInput set.
    expect(typedFigure(input('', true))).toBeNull()
  })
})

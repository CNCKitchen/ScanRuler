// SPDX-License-Identifier: AGPL-3.0-only
// Expressions and parameter tables deep enough to run out of stack, as a
// project file can hold them: an error of the expression, never a throw.
import { describe, expect, it } from 'vitest'
import { evaluate } from '../core/expression'
import { evaluateParameters, type Parameter } from '../core/parameters'

describe('a deep expression', () => {
  it('is refused, not thrown', () => {
    const deep = '('.repeat(200_000) + '1' + ')'.repeat(200_000)
    const r = evaluate(deep, () => undefined)
    expect(r.ok).toBe(false)
    const nested = '('.repeat(1000) + '1' + ')'.repeat(1000)
    expect(evaluate(nested, () => undefined)).toMatchObject({ ok: false, error: 'nests too deeply' })
    expect(evaluate('-'.repeat(1000) + '1', () => undefined)).toMatchObject({ ok: false, error: 'nests too deeply' })
  })
})

describe('a long chain of parameters', () => {
  it('reads to the end without running out of stack', () => {
    const n = 30_000
    const chain: Parameter[] = Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `p${i}`, kind: 'number', expression: i === 0 ? '1' : `p${i - 1} + 1` }))
    const table = evaluateParameters(chain.reverse())
    expect(table.readings[0]).toMatchObject({ name: `p${n - 1}`, value: n, error: null })
  })

  it('still says where a loop goes round', () => {
    const table = evaluateParameters([
      { id: 1, name: 'a', kind: 'number', expression: 'b + 1' },
      { id: 2, name: 'b', kind: 'number', expression: 'a + 1' },
      { id: 3, name: 'c', kind: 'number', expression: '2' },
    ])
    expect(table.readings.map((r) => r.error)).toEqual(['goes round in a loop: a → b → a', 'goes round in a loop: a → b → a', null])
  })
})

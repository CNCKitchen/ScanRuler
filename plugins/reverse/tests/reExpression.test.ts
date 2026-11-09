// SPDX-License-Identifier: AGPL-3.0-only
// The expression language of the number fields: what it reads, what it
// refuses and how it says so, and the two readings that do not evaluate —
// the names an expression uses, and a name rewritten.

import { describe, expect, it } from 'vitest'
import { ANGLE, evaluate, evaluateFor, formatValue, isPlainNumber, LENGTH, plainNumber, references, renameIn, UNITLESS, validName, type Scope, type Value } from '../core/expression'

const scope =
  (vars: Record<string, Value>): Scope =>
  (name) =>
    vars[name]

const none: Scope = () => undefined
const mm = (value: number): Value => ({ value, dim: LENGTH })
const deg = (value: number): Value => ({ value, dim: ANGLE })
const num = (value: number): Value => ({ value, dim: UNITLESS })

function value(src: string, s: Scope = none): number {
  const r = evaluate(src, s)
  if (!r.ok) throw new Error(`${src}: ${r.error}`)
  return r.value
}

function error(src: string, s: Scope = none): string {
  const r = evaluate(src, s)
  if (r.ok) throw new Error(`${src} evaluated to ${r.value}`)
  return r.error
}

describe('arithmetic', () => {
  it('reads numbers, the four operations and a power in the usual order', () => {
    expect(value('2 + 3 * 4')).toBe(14)
    expect(value('(2 + 3) * 4')).toBe(20)
    expect(value('25.4 / 12')).toBeCloseTo(2.11667, 5)
    expect(value('10 - 2 - 3')).toBe(5)
    expect(value('24 / 4 / 2')).toBe(3)
    expect(value('2 ^ 3 ^ 2')).toBe(512)
    expect(value('.5 + 1e1')).toBe(10.5)
  })

  it('binds unary minus under a power and over a product', () => {
    expect(value('-2 ^ 2')).toBe(-4)
    expect(value('(-2) ^ 2')).toBe(4)
    expect(value('2 ^ -1')).toBe(0.5)
    expect(value('-2 * -3')).toBe(6)
    expect(value('+4')).toBe(4)
    expect(value('--4')).toBe(4)
  })

  it('knows the functions, in degrees', () => {
    expect(value('sin(30)')).toBeCloseTo(0.5)
    expect(value('cos(60 deg)')).toBeCloseTo(0.5)
    expect(value('tan(45)')).toBeCloseTo(1)
    expect(value('asin(0.5)')).toBeCloseTo(30)
    expect(value('acos(0.5)')).toBeCloseTo(60)
    expect(value('atan(1)')).toBeCloseTo(45)
    expect(value('atan2(1, 1)')).toBeCloseTo(45)
    expect(value('sqrt(16)')).toBe(4)
    expect(value('abs(-3)')).toBe(3)
    expect(value('min(3, 1, 2)')).toBe(1)
    expect(value('max(3, 1, 2)')).toBe(3)
    expect(value('floor(2.7)')).toBe(2)
    expect(value('ceil(2.2)')).toBe(3)
    expect(value('round(2.5)')).toBe(3)
    expect(value('pow(2, 10)')).toBe(1024)
    expect(value('2 * pi')).toBeCloseTo(6.2832, 4)
    expect(value('e')).toBeCloseTo(2.7183, 4)
  })

  it('reads units into millimetres and degrees', () => {
    expect(value('1 in')).toBeCloseTo(25.4)
    expect(value('1in')).toBeCloseTo(25.4)
    expect(value('2 cm')).toBe(20)
    expect(value('0.5 m')).toBe(500)
    expect(value('10 mm')).toBe(10)
    expect(value('pi rad')).toBeCloseTo(180)
    expect(value('30°')).toBe(30)
    expect(evaluate('1 in', none)).toMatchObject({ dim: LENGTH })
    expect(evaluate('1 rad', none)).toMatchObject({ dim: ANGLE })
  })

  it('reads parameters from the scope', () => {
    const s = scope({ width: mm(40), count: num(4) })
    expect(value('width / 2', s)).toBe(20)
    expect(value('width + 10', s)).toBe(50)
    expect(value('width / count', s)).toBe(10)
    expect(value('threadlength+10', scope({ threadlength: mm(25) }))).toBe(35)
  })
})

describe('refusals', () => {
  it('say what is wrong and where', () => {
    expect(evaluate('', none)).toMatchObject({ ok: false, error: 'nothing to read' })
    expect(evaluate('2 +', none)).toMatchObject({ ok: false, at: [3, 3] })
    expect(error('2 + * 3')).toContain('where a number was expected')
    expect(error('(2 + 3')).toContain('not closed')
    expect(error('2 + 3)')).toContain('“)”')
    expect(error('2 3')).toContain('where an operator was expected')
    expect(error('2 # 3')).toContain('“#”')
    expect(evaluate('width', none)).toMatchObject({ ok: false, error: 'there is no parameter “width”', at: [0, 5] })
    expect(error('foo(2)')).toContain('no function “foo”')
    expect(error('sin')).toContain('is a function')
    expect(error('sin(1, 2)')).toContain('takes one argument')
    expect(error('1 / 0')).toBe('divides by zero')
    expect(error('sqrt(-1)')).toContain('negative')
    // A decimal comma says so (issue 34): the hint never fired before.
    expect(error('2,5')).toContain('the decimal point is a dot')
  })

  it('never read a name an object inherits as a unit or a constant (issue 34)', () => {
    // `constructor` read as a unit, and threw a raw TypeError.
    expect(error('10 constructor + 1 mm')).toContain('where an operator was expected')
    expect(error('toString')).toContain('no parameter “toString”')
    // A parameter by such a name is read like any other.
    const own: Scope = (name) => (name === 'constructor' ? mm(4) : name === 'toString' ? num(2) : undefined)
    expect(value('constructor * toString', own)).toBe(8)
  })

  it('keep lengths, angles and numbers apart', () => {
    const s = scope({ width: mm(40), height: mm(20), turn: deg(30), count: num(4) })
    expect(error('width + turn', s)).toBe('a length and an angle cannot be added')
    expect(error('width - count', s)).toBe('a length and a number cannot be subtracted')
    expect(evaluate('width * height', s)).toMatchObject({ ok: true, dim: { mm: 2, deg: 0 } })
    expect(evaluate('width / height', s)).toMatchObject({ ok: true, dim: UNITLESS })
    expect(evaluate('width * count', s)).toMatchObject({ ok: true, dim: LENGTH })
    expect(evaluate('sin(turn) * width', s)).toMatchObject({ ok: true, dim: LENGTH })
    expect(evaluate('atan(width / height)', s)).toMatchObject({ ok: true, dim: ANGLE })
    expect(evaluate('sqrt(width * height)', s)).toMatchObject({ ok: true, dim: LENGTH })
    expect(error('sqrt(width)', s)).toContain('no kind of quantity')
    expect(error('sin(width)', s)).toBe('sin() takes an angle, not a length')
    expect(error('asin(width)', s)).toBe('asin() takes a plain number, not a length')
    expect(error('width ^ 0.5', s)).toContain('cannot be raised')
    expect(evaluate('width ^ 2', s)).toMatchObject({ ok: true, dim: { mm: 2, deg: 0 } })
    expect(error('2 ^ width', s)).toContain('a power must be a plain number')
    expect(error('min(width, turn)', s)).toContain('cannot be compared in min()')
    expect(error('atan2(width, count)', s)).toContain('atan2()')
    expect(evaluate('max(width, 10)', s)).toMatchObject({ ok: true, value: 40, dim: LENGTH })
  })

  it('refuse what does not come out as a number', () => {
    expect(error('10 ^ 400')).toContain('does not come out')
  })
})

describe('evaluateFor a field', () => {
  const s = scope({ width: mm(40), turn: deg(30), count: num(4), ratio: num(0.5) })

  it('reads a bare number in the field’s unit', () => {
    expect(evaluateFor('10', 'length', s)).toMatchObject({ ok: true, value: 10, dim: LENGTH })
    expect(evaluateFor('10', 'angle', s)).toMatchObject({ ok: true, value: 10, dim: ANGLE })
    expect(evaluateFor('25.4/12', 'length', s)).toMatchObject({ ok: true, dim: LENGTH })
    expect(evaluateFor('2*3', 'integer', s)).toMatchObject({ ok: true, value: 6 })
  })

  it('takes the field’s own kind and refuses another', () => {
    expect(evaluateFor('width / 2', 'length', s)).toMatchObject({ ok: true, value: 20 })
    expect(evaluateFor('width + 10', 'length', s)).toMatchObject({ ok: true, value: 50 })
    expect(evaluateFor('turn * 2', 'angle', s)).toMatchObject({ ok: true, value: 60 })
    expect(evaluateFor('width', 'angle', s)).toMatchObject({ ok: false, error: 'comes out as a length; an angle is wanted here' })
    expect(evaluateFor('count', 'length', s)).toMatchObject({ ok: false, error: 'comes out as a number; a length is wanted here — a number with a unit, “10 mm”, makes it one' })
    expect(evaluateFor('count * 2 mm', 'length', s)).toMatchObject({ ok: true, value: 8 })
    expect(evaluateFor('width * width', 'length', s)).toMatchObject({ ok: false, error: 'comes out as an area (mm²); a length is wanted here' })
    expect(evaluateFor('width', 'number', s)).toMatchObject({ ok: false, error: 'comes out as a length; a number is wanted here' })
    expect(evaluateFor('width / 10 mm', 'integer', s)).toMatchObject({ ok: true, value: 4 })
    expect(evaluateFor('ratio * 2', 'number', s)).toMatchObject({ ok: true, value: 1 })
  })

  it('asks a whole-number parameter to come out whole, and lets a count field round', () => {
    expect(evaluateFor('7.3', 'integer', s, { whole: true })).toMatchObject({ ok: false, error: 'comes out 7.3, not whole — round(), floor() or ceil() make it so' })
    expect(evaluateFor('round(7.3)', 'integer', s, { whole: true })).toMatchObject({ ok: true, value: 7 })
    expect(evaluateFor('7.3', 'integer', s)).toMatchObject({ ok: true, value: 7.3 })
    expect(evaluateFor('6.0000000001', 'integer', s, { whole: true })).toMatchObject({ ok: true })
  })
})

describe('reading without evaluating', () => {
  it('finds the names an expression uses, once each, in order', () => {
    expect(references('width + height * width')).toEqual(['width', 'height'])
    expect(references('sin(turn) * 2 mm + pi')).toEqual(['turn'])
    expect(references('25.4 / 12')).toEqual([])
    expect(references('width +')).toEqual(['width'])
    expect(references('width # height')).toEqual(['width', 'height'])
  })

  it('renames a parameter and leaves the rest as typed', () => {
    expect(renameIn('thread + threadlength*2', 'thread', 'pitch')).toBe('pitch + threadlength*2')
    expect(renameIn('width/2 + width', 'width', 'w')).toBe('w/2 + w')
    expect(renameIn('sin(width)', 'sin', 'cos')).toBe('sin(width)')
    expect(renameIn('width +', 'width', 'w')).toBe('w +')
    expect(renameIn('a + b', 'c', 'd')).toBe('a + b')
  })

  it('tells a plain number from an expression', () => {
    expect(isPlainNumber('25')).toBe(true)
    expect(isPlainNumber(' 2.5 ')).toBe(true)
    expect(isPlainNumber('25 mm')).toBe(false)
    expect(isPlainNumber('-25')).toBe(false)
    expect(isPlainNumber('25/2')).toBe(false)
    expect(isPlainNumber('width')).toBe(false)
    expect(plainNumber('12.5')).toBe(12.5)
    expect(plainNumber('12.5/2')).toBeNull()
  })

  it('judges a parameter name', () => {
    expect(validName('width')).toBe(true)
    expect(validName('_w2')).toBe(true)
    expect(validName('2w')).toBe(false)
    expect(validName('thread length')).toBe(false)
    expect(validName('sin')).toBe(false)
    expect(validName('mm')).toBe(false)
    expect(validName('pi')).toBe(false)
    expect(validName('')).toBe(false)
  })

  it('writes a value in its unit', () => {
    expect(formatValue(35, 'length')).toBe('35 mm')
    expect(formatValue(2.116666, 'length')).toBe('2.117 mm')
    expect(formatValue(30, 'angle')).toBe('30°')
    expect(formatValue(6.9, 'integer')).toBe('7')
    expect(formatValue(0.5, 'number')).toBe('0.5')
  })
})

describe('renaming in a broken expression (issue 34)', () => {
  it('leaves the exponent of a number alone', () => {
    // Broken (a stray #), so renaming falls back on the loose reading,
    // which took the e3 of 1e3 for a name.
    expect(renameIn('1e3 * e3 #', 'e3', 'k')).toBe('1e3 * k #')
  })
})

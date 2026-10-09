// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { arr, bool, bytes, enumOf, int, num, obj, oneOf, str, validate, vec3 } from '../src/commands/schema'

describe('command input schemas', () => {
  it('checks the scalar types and their bounds', () => {
    expect(validate(num(), 1.5)).toEqual([])
    expect(validate(num(), Infinity)).toEqual(['input: expected a finite number'])
    expect(validate(num(), '1')).toEqual(['input: expected a finite number'])
    expect(validate(int(), 2.5)).toEqual(['input: expected a whole number'])
    expect(validate(num(undefined, { minimum: 0 }), -1)).toEqual(['input: must be at least 0'])
    expect(validate(num(undefined, { exclusiveMinimum: 0 }), 0)).toEqual(['input: must be more than 0'])
    expect(validate(num(undefined, { maximum: 90 }), 91)).toEqual(['input: must be at most 90'])
    expect(validate(bool(), 'yes')).toEqual(['input: expected true or false'])
    expect(validate(str(undefined, { minLength: 1 }), '')).toEqual(['input: expected at least 1 character'])
    expect(validate(enumOf(['mm', 'in']), 'cm')).toEqual(['input: expected one of "mm", "in"'])
    expect(enumOf([3, 2, 1, 0]).type).toBe('integer')
  })

  it('takes bytes only as bytes', () => {
    expect(validate(bytes('a file'), new Uint8Array(3))).toEqual([])
    expect(validate(bytes('a file'), 'AAAA')).toEqual(["input: expected the file's bytes"])
  })

  it('checks lists, their length and every item', () => {
    expect(validate(vec3('p'), [1, 2, 3])).toEqual([])
    expect(validate(vec3('p'), [1, 2])).toEqual(['input: expected at least 3 items'])
    expect(validate(vec3('p'), [1, 2, 3, 4])).toEqual(['input: expected at most 3 items'])
    expect(validate(arr(int()), [1, 'x', 2.5])).toEqual(['input[1]: expected a finite number', 'input[2]: expected a whole number'])
  })

  it('names missing and unknown fields by their path', () => {
    const schema = obj({ kind: enumOf(['plane', 'sphere']), at: obj({ point: vec3('p') }, ['point']) }, ['kind'])
    expect(validate(schema, { kind: 'plane' })).toEqual([])
    expect(validate(schema, {})).toEqual(['input.kind: required'])
    expect(validate(schema, { kind: 'plane', knd: 1 })).toEqual(['input.knd: not a known field'])
    expect(validate(schema, { kind: 'plane', at: { point: [0, 0] } })).toEqual(['input.at.point: expected at least 3 items'])
    expect(validate(schema, [1])).toEqual(['input: expected an object'])
    // An absent optional field is no field at all.
    expect(validate(schema, { kind: 'plane', at: undefined })).toEqual([])
  })

  it('takes exactly one branch of a oneOf, and says which were on offer', () => {
    const at = oneOf([obj({ vertex: int() }, ['vertex']), obj({ point: vec3('p') }, ['point'])])
    expect(validate(at, { vertex: 4 })).toEqual([])
    expect(validate(at, { point: [1, 2, 3] })).toEqual([])
    const errors = validate(at, { pont: [1, 2, 3] })
    expect(errors[0]).toBe('input: expected one of { vertex }, { point }')
    expect(validate(oneOf([num(), int()]), 2)).toEqual(['input: matches more than one of number, integer'])
    const ref = oneOf([int(), str()])
    expect(validate(ref, 'Sphere 1')).toEqual([])
    expect(validate(ref, 3)).toEqual([])
  })

  it('stays plain JSON, as it goes out to a tool list', () => {
    const schema = obj({ at: oneOf([obj({ vertex: int() }, ['vertex'])]), file: bytes('f') }, ['at'], 'A command.')
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema)
  })
})

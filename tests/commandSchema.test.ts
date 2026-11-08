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
    expect(validate(schema, { kind: 'plane', knd: 1 })).toEqual(['input.knd: not a known field — the fields here: kind, at'])
    // type for kind, as other tools name it, is pointed at kind.
    expect(validate(obj({ kind: str(), at: num() }), { type: 'plane' })).toEqual(['input.type: not a known field — kind takes it here (kind: "plane"); the fields here: kind, at'])
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

  it('refuses a value by the branch of its own type, not by the first branch as near', () => {
    const query = { ...obj({ kind: str(), sides: obj({}) }), title: 'query' }
    const pick = oneOf([int('i', { minimum: 0 }), { ...obj({ mid: vec3('m'), dir: vec3('d') }, ['mid', 'dir']), title: 'fingerprint' }, query])
    // An object as far from the query as an integer is from a number: the query says why.
    expect(validate(pick, { where: { sides: {} } }, 'input.edges[0]')).toEqual([
      'input.edges[0]: expected one of integer, fingerprint, query',
      'input.edges[0].where: not a known field — the fields here: kind, sides',
    ])
    // Further off the query than any number is: still the query, as an object.
    expect(validate(pick, { where: 1, more: 2 }).slice(1)).toEqual(['input.where: not a known field — the fields here: kind, sides', 'input.more: not a known field — the fields here: kind, sides'])
    expect(validate(pick, -1).slice(1)).toEqual(['input: must be at least 0'])
    // A value no branch's type fits: the nearest, as before.
    expect(validate(oneOf([int(), str()]), true)).toEqual(['input: expected one of integer, string', 'input: expected a finite number'])
    // A branch is of a type through its own oneOf, and an enum by its values.
    expect(validate(oneOf([num(), oneOf([enumOf(['all']), arr(int())])]), 'some').at(-1)).toBe('input: expected one of "all"')
  })

  it('takes "true" and "false" for a boolean where the string does not fit, and hands on the boolean', () => {
    const schema = obj({ audit: oneOf([bool(), enumOf(['full'])]), on: bool(), flags: arr(bool()), name: oneOf([bool(), str()]) })
    const input: Record<string, unknown> = { audit: 'false', on: 'true', flags: ['false', true], name: 'false' }
    expect(validate(schema, input)).toEqual([])
    // Mended in place, so the command gets the booleans; a string that
    // fits as a string stays one.
    expect(input).toEqual({ audit: false, on: true, flags: [false, true], name: 'false' })
    expect(validate(schema, { audit: 'full' })).toEqual([])
    expect(validate(bool(), 'yes')).toEqual(['input: expected true or false'])
    expect(validate(obj({ on: bool() }), { on: 'False' })).toEqual(['input.on: expected true or false'])
  })

  it('refuses a name given for a number another field takes it in, saying how to write it', () => {
    const schema = { ...obj({ radius: num(), count: int(), extent: obj({ to: oneOf([num(), enumOf(['fit'])]) }), exprs: obj({}) }, ['radius']), names: { field: 'exprs', slots: ['radius', 'extent.to'] } }
    expect(validate(schema, { radius: 'r' }, 'input.feature')).toEqual(['input.feature.radius: "r" is a name or an expression, and this field takes a number — give exprs: { radius: "r" }, with any number here (the expression sets it)'])
    expect(validate(schema, { radius: 1, extent: { to: 'h / 2' } })).toEqual(['input.extent.to: "h / 2" is a name or an expression, and this field takes a number — give exprs: { "extent.to": "h / 2" }'])
    // A string the field takes stays; a field with no slot says what it did.
    expect(validate(schema, { radius: 1, extent: { to: 'fit' } })).toEqual([])
    expect(validate(schema, { radius: 1, count: 'n' })).toEqual(['input.count: expected a finite number'])
    expect(validate(obj({ radius: num() }), { radius: 'r' })).toEqual(['input.radius: expected a finite number'])
    // A vector where an angle goes is answered with what the number is.
    expect(validate(obj({ dir: num('Radians from +u.') }), { dir: [1, 0] })).toEqual(['input.dir: expected a finite number, not a list — Radians from +u.'])
  })

  it('refuses a name given for an id that has a name beside it, saying where the name goes', () => {
    const byIdOrName = (k: string) => obj({ kind: enumOf([k]), id: int(), name: str(undefined, { minLength: 1 }) }, ['kind'])
    const plane = oneOf([{ ...byIdOrName('section'), title: 'section' }, { ...byIdOrName('plane'), title: 'plane' }])
    const errors = validate(obj({ plane }), { plane: { kind: 'plane', id: 'Key top' } })
    expect(errors.at(-1)).toBe('input.plane.id: "Key top" is a name, and id takes a number — a name goes in name: give name: "Key top" in place of id')
    expect(validate(obj({ plane }), { plane: { kind: 'plane', name: 'Key top' } })).toEqual([])
    // A number written as a string, an id with no name beside it, or an id
    // that takes a string itself: as before.
    expect(validate(byIdOrName('plane'), { kind: 'plane', id: '12' })).toEqual(['input.id: expected a finite number'])
    expect(validate(obj({ id: int() }), { id: 'Key top' })).toEqual(['input.id: expected a finite number'])
    expect(validate(obj({ id: oneOf([num(), str()]), name: str() }), { id: 'Key top' })).toEqual([])
  })

  it('stays plain JSON, as it goes out to a tool list', () => {
    const schema = obj({ at: oneOf([obj({ vertex: int() }, ['vertex'])]), file: bytes('f') }, ['at'], 'A command.')
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema)
  })
})

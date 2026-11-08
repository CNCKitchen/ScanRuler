// SPDX-License-Identifier: AGPL-3.0-only
// The JSON Schema subset the commands describe their input in, and the check
// that holds an input to it. Hand-rolled rather than a dependency: the subset
// is small — objects, arrays, strings, numbers with bounds, integers,
// booleans, enums and oneOf — and the same schemas go out to an agent's tool
// list unchanged, so they stay plain JSON with nothing of a library in them.
//
// Two additions to the standard: `format: 'binary'` on a string marks bytes —
// a file's contents. The page takes them as a Uint8Array; whatever carries
// the command to the page decides how they travel (see bridge.ts). And
// `names` on an object says which of its number fields may be given by a
// name or an expression in another field instead, so that a string given
// for one is refused with the way to write it.

export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
  description?: string
  title?: string
  properties?: Record<string, JsonSchema>
  required?: readonly string[]
  additionalProperties?: boolean
  items?: JsonSchema
  minItems?: number
  maxItems?: number
  enum?: readonly (string | number | boolean | null)[]
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  minLength?: number
  oneOf?: readonly JsonSchema[]
  format?: 'binary'
  default?: unknown
  /** The number fields of this object, at any depth below it, by their
   *  path from it (`radius`, `extent.to`), that take a name or an expression
   *  in `field` instead — `{ radius: "r" }` there. A string given for one
   *  is refused saying so, not as a number missing. */
  names?: { field: string; slots: readonly string[] }
}

/** An object's `names`, and the path it stands at. */
type NamesAt = { field: string; slots: readonly string[]; at: string }

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array)

/** A name for a schema in a message: its title, the one property it requires
 *  — what tells the branches of a discriminated oneOf apart — or its type. */
function nameOf(schema: JsonSchema): string {
  if (schema.title) return schema.title
  if (schema.type === 'object' && schema.required?.length === 1) return `{ ${schema.required[0]} }`
  return schema.type ?? 'value'
}

/** A schema a boolean fits: a boolean, or a oneOf with a boolean branch. */
const takesBoolean = (schema: JsonSchema): boolean => schema.type === 'boolean' || !!schema.oneOf?.some(takesBoolean)

/** A schema a number fits: a number, or a oneOf with a number branch. */
const takesNumber = (schema: JsonSchema): boolean => schema.type === 'number' || schema.type === 'integer' || !!schema.oneOf?.some(takesNumber)

/** Whether a schema is of the value's type — an object for an object, a
 *  number or an integer for a number, … — or has a oneOf branch that is,
 *  however the value breaks it otherwise. An untyped schema is of any. */
function takesTypeOf(schema: JsonSchema, value: unknown): boolean {
  if (schema.oneOf) return schema.oneOf.some((b) => takesTypeOf(b, value))
  switch (schema.type) {
    case undefined:
      return !schema.enum || schema.enum.some((e) => typeof e === typeof value && (e === null) === (value === null))
    case 'null':
      return value === null
    case 'boolean':
      return typeof value === 'boolean'
    case 'string':
      return schema.format === 'binary' ? value instanceof Uint8Array : typeof value === 'string'
    case 'number':
    case 'integer':
      return typeof value === 'number'
    case 'array':
      return Array.isArray(value)
    case 'object':
      return isObject(value)
  }
}

/** The refusal of a string given where a number goes, for a field that
 *  takes a name or an expression elsewhere (`names`) — null for any other
 *  field, or a string the field takes as it is. */
function nameGiven(names: NamesAt | undefined, path: string, schema: JsonSchema, value: unknown, required: boolean): string | null {
  if (!names || typeof value !== 'string' || !takesNumber(schema)) return null
  const slot = path.slice(names.at.length + 1)
  if (!path.startsWith(`${names.at}.`) || !names.slots.includes(slot)) return null
  if (validate(schema, value).length === 0) return null
  return `${path}: ${JSON.stringify(value)} is a name or an expression, and this field takes a number — give ${names.field}: { ${slot.includes('.') ? JSON.stringify(slot) : slot}: ${JSON.stringify(value)} }${required ? `, with any number here (the expression sets it)` : ''}`
}

/** The refusal of a name given for an object's number `id`, where the
 *  object takes a `name` beside it — `{ kind: "plane", id: "Key top" }` —
 *  null for any other field or value. Refused, not moved across: the one
 *  thing the check mends is a value's type in its own field, and a value
 *  moved into another field in one branch of a oneOf would be what the
 *  branches after it are checked with. */
function nameForId(schema: JsonSchema, key: string, path: string, value: unknown): string | null {
  if (key !== 'id' || typeof value !== 'string' || !value.trim() || Number.isFinite(Number(value))) return null
  const id = schema.properties?.id
  const name = schema.properties?.name
  if (!id || !name || takesTypeOf(id, value) || !takesTypeOf(name, value)) return null
  return `${path}: ${JSON.stringify(value)} is a name, and id takes a number — a name goes in name: give name: ${JSON.stringify(value)} in place of id`
}

/** Field names other schemas use for what this one calls otherwise. */
const SAID_AS: Record<string, string> = { type: 'kind' }

/** The field an unknown key is likely meant for, said before the list —
 *  `type: "line"` where pieces take `kind` — or nothing. */
function saidAs(key: string, schema: JsonSchema, value: unknown): string {
  const meant = SAID_AS[key]
  if (!meant || !schema.properties?.[meant]) return ''
  return `${meant} takes it here (${meant}: ${JSON.stringify(value)}); `
}

/** `"true"` or `"false"` where a boolean fits and the string does not, as
 *  the boolean — some agents' clients send every value as a string. The
 *  value as it was otherwise. */
function asBoolean(schema: JsonSchema, value: unknown): unknown {
  if ((value !== 'true' && value !== 'false') || !takesBoolean(schema)) return value
  if (validate(schema, value).length === 0) return value
  const flag = value === 'true'
  return validate(schema, flag).length === 0 ? flag : value
}

/**
 * Every way `value` breaks `schema`, as one line each, starting with the path
 * to the offending part — `at.point: expected 3 items`. Empty when it fits.
 *
 * It mends one thing in place, so that the command gets what was meant: a
 * field or a list item given as `"true"` or `"false"` where only a boolean
 * fits becomes that boolean. A name given for an `id` that has a `name`
 * beside it is refused saying where the name goes.
 */
export function validate(schema: JsonSchema, value: unknown, path = 'input', within?: NamesAt): string[] {
  const names = schema.names ? { ...schema.names, at: path } : within
  if (schema.oneOf) {
    const results = schema.oneOf.map((branch) => validate(branch, value, path, names))
    const passing = results.filter((r) => r.length === 0).length
    if (passing === 1) return []
    if (passing > 1) return [`${path}: matches more than one of ${schema.oneOf.map(nameOf).join(', ')}`]
    // The branch that got furthest says the most about what was meant —
    // of the branches the value's type fits, where any does: an object
    // given where an index or a query goes is refused as a query, not as
    // a number it never was.
    const fitting = results.filter((_, i) => takesTypeOf(schema.oneOf![i], value))
    const closest = (fitting.length ? fitting : results).reduce((a, b) => (b.length < a.length ? b : a))
    return results.length === 1 ? closest : [`${path}: expected one of ${schema.oneOf.map(nameOf).join(', ')}`, ...closest]
  }
  if (schema.enum && !schema.enum.includes(value as string)) {
    return [`${path}: expected one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`]
  }
  switch (schema.type) {
    case undefined:
      return []
    case 'null':
      return value === null ? [] : [`${path}: expected null`]
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${path}: expected true or false`]
    case 'string': {
      if (schema.format === 'binary') {
        return value instanceof Uint8Array ? [] : [`${path}: expected the file's bytes`]
      }
      if (typeof value !== 'string') return [`${path}: expected a string`]
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        return [`${path}: expected at least ${schema.minLength} character${schema.minLength === 1 ? '' : 's'}`]
      }
      return []
    }
    case 'number':
    case 'integer': {
      // A list or an object where one number goes is a shape misread — a
      // direction as a vector where it is an angle: the field's own words
      // say what the number is.
      if (typeof value === 'object' && value !== null && schema.description) return [`${path}: expected a finite number, not ${Array.isArray(value) ? 'a list' : 'an object'} — ${schema.description}`]
      if (typeof value !== 'number' || !Number.isFinite(value)) return [`${path}: expected a finite number`]
      if (schema.type === 'integer' && !Number.isInteger(value)) return [`${path}: expected a whole number`]
      if (schema.minimum !== undefined && value < schema.minimum) return [`${path}: must be at least ${schema.minimum}`]
      if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
        return [`${path}: must be more than ${schema.exclusiveMinimum}`]
      }
      if (schema.maximum !== undefined && value > schema.maximum) return [`${path}: must be at most ${schema.maximum}`]
      return []
    }
    case 'array': {
      if (!Array.isArray(value)) return [`${path}: expected a list`]
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        return [`${path}: expected at least ${schema.minItems} item${schema.minItems === 1 ? '' : 's'}`]
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        return [`${path}: expected at most ${schema.maxItems} item${schema.maxItems === 1 ? '' : 's'}`]
      }
      if (!schema.items) return []
      return value.flatMap((item, i) => {
        const meant = asBoolean(schema.items!, item)
        if (meant !== item) value[i] = meant
        return validate(schema.items!, meant, `${path}[${i}]`, names)
      })
    }
    case 'object': {
      if (!isObject(value)) return [`${path}: expected an object`]
      const errors: string[] = []
      for (const key of schema.required ?? []) {
        if (value[key] === undefined) errors.push(`${path}.${key}: required`)
      }
      for (const [key, v] of Object.entries(value)) {
        if (v === undefined) continue
        const prop = schema.properties?.[key]
        if (prop) {
          const meant = asBoolean(prop, v)
          if (meant !== v) value[key] = meant
          const named = nameGiven(names, `${path}.${key}`, prop, meant, !!schema.required?.includes(key)) ?? nameForId(schema, key, `${path}.${key}`, meant)
          if (named) errors.push(named)
          else errors.push(...validate(prop, meant, `${path}.${key}`, names))
        }
        else if (schema.additionalProperties === false) errors.push(`${path}.${key}: not a known field — ${saidAs(key, schema, v)}the fields here: ${Object.keys(schema.properties ?? {}).join(', ') || 'none'}`)
      }
      return errors
    }
  }
}

// ---- Size ------------------------------------------------------------------------

/**
 * How large and how deep a command's input schema may be. An agent's client
 * turns a tool whose schema is too large down, and may not say so: Claude
 * Desktop refused one of 82 kB nested twenty deep — "a problem with that
 * connector" — and takes the app's own, up to 4 kB and eleven deep. The
 * budget keeps a margin over what has been seen taken, well short of what
 * was refused; a larger shape is listed loosely and checked when the
 * command runs. registerCommands refuses a command over it.
 */
export const SCHEMA_BUDGET = { bytes: 8_000, depth: 12 } as const

/** A schema's size as JSON, and how deep its objects and lists nest. */
export function schemaWeight(schema: JsonSchema): { bytes: number; depth: number } {
  const depth = (v: unknown): number => (v !== null && typeof v === 'object' ? 1 + Math.max(0, ...Object.values(v as object).map(depth)) : 0)
  return { bytes: JSON.stringify(schema).length, depth: depth(schema) }
}

// ---- Builders ----------------------------------------------------------------
// Shorthand for the schemas the commands declare. Each returns plain JSON.

type Extra = Omit<JsonSchema, 'type'>

export const str = (description?: string, extra: Extra = {}): JsonSchema => ({ type: 'string', ...(description ? { description } : {}), ...extra })
export const num = (description?: string, extra: Extra = {}): JsonSchema => ({ type: 'number', ...(description ? { description } : {}), ...extra })
export const int = (description?: string, extra: Extra = {}): JsonSchema => ({ type: 'integer', ...(description ? { description } : {}), ...extra })
export const bool = (description?: string, extra: Extra = {}): JsonSchema => ({ type: 'boolean', ...(description ? { description } : {}), ...extra })
/** Any object: what the schema does not spell out is checked when the
 *  command runs. */
export const anyObject = (description: string, extra: Extra = {}): JsonSchema => ({ type: 'object', description, ...extra })
export const bytes = (description: string): JsonSchema => ({ type: 'string', format: 'binary', description })
export const oneOf = (branches: JsonSchema[], description?: string): JsonSchema => ({ oneOf: branches, ...(description ? { description } : {}) })
export const enumOf = <T extends string | number>(values: readonly T[], description?: string): JsonSchema => ({
  type: typeof values[0] === 'number' ? (values.every(Number.isInteger) ? 'integer' : 'number') : 'string',
  enum: values,
  ...(description ? { description } : {}),
})
export const arr = (items: JsonSchema, description?: string, extra: Extra = {}): JsonSchema => ({
  type: 'array',
  items,
  ...(description ? { description } : {}),
  ...extra,
})

/** An object with these properties, the ones in `required` required, nothing
 *  else allowed: a typo in a field name is an error, not a default. */
export function obj(properties: Record<string, JsonSchema>, required: readonly string[] = [], description?: string): JsonSchema {
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
    ...(description ? { description } : {}),
  }
}

/** Three coordinates in millimetres. */
export const vec3 = (description: string): JsonSchema => arr(num(), description, { minItems: 3, maxItems: 3 })

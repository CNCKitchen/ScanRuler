// SPDX-License-Identifier: AGPL-3.0-only
// The JSON Schema subset the commands describe their input in, and the check
// that holds an input to it. Hand-rolled rather than a dependency: the subset
// is small — objects, arrays, strings, numbers with bounds, integers,
// booleans, enums and oneOf — and the same schemas go out to an agent's tool
// list unchanged, so they stay plain JSON with nothing of a library in them.
//
// One addition to the standard: `format: 'binary'` on a string marks bytes —
// a file's contents. The page takes them as a Uint8Array; whatever carries
// the command to the page decides how they travel (see bridge.ts).

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
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array)

/** A name for a schema in a message: its title, the one property it requires
 *  — what tells the branches of a discriminated oneOf apart — or its type. */
function nameOf(schema: JsonSchema): string {
  if (schema.title) return schema.title
  if (schema.type === 'object' && schema.required?.length === 1) return `{ ${schema.required[0]} }`
  return schema.type ?? 'value'
}

/**
 * Every way `value` breaks `schema`, as one line each, starting with the path
 * to the offending part — `at.point: expected 3 items`. Empty when it fits.
 */
export function validate(schema: JsonSchema, value: unknown, path = 'input'): string[] {
  if (schema.oneOf) {
    const results = schema.oneOf.map((branch) => validate(branch, value, path))
    const passing = results.filter((r) => r.length === 0).length
    if (passing === 1) return []
    if (passing > 1) return [`${path}: matches more than one of ${schema.oneOf.map(nameOf).join(', ')}`]
    // The branch that got furthest says the most about what was meant.
    const closest = results.reduce((a, b) => (b.length < a.length ? b : a))
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
      return value.flatMap((item, i) => validate(schema.items!, item, `${path}[${i}]`))
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
        if (prop) errors.push(...validate(prop, v, `${path}.${key}`))
        else if (schema.additionalProperties === false) errors.push(`${path}.${key}: not a known field`)
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

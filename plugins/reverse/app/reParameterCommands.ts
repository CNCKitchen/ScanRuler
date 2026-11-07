// SPDX-License-Identifier: AGPL-3.0-only
// reverse.parameter.*: the parameter table listed, added to, set, renamed
// and removed — a change rebuilding every feature that reads it.

import { invalid } from '../../../src/commands/core/common'
import { arr, obj, str, validate } from '../../../src/commands/schema'
import { type Command, CommandError } from '../../../src/plugins/api'
import type { Feature } from '../core/features'
import { evaluateParameters, nameProblem } from '../core/parameters'
import { bodiesChanged, bodyRows, failures } from './reCommandAnswers'
import { byName, change, re, type Ref, session } from './reCommandCore'
import { parametersOut } from './reReadout'
import { featureRef, parameterKind } from './reSchemas'
import { type ReverseSession, reverseSession } from './reSession'

function parameterNamed(ref: Ref) {
  const params = re().parameters
  if (typeof ref === 'string') return byName(params, ref, 'parameter')
  const p = params.find((x) => x.id === ref)
  if (!p) throw new CommandError('not_found', `There is no parameter ${ref}.`)
  return p
}

/** What a change of the parameters moved: the features whose numbers or
 *  sketches it changed. */
function moved(before: readonly Feature[]): string[] {
  return re()
    .features.filter((f) => !before.includes(f))
    .map((f) => f.name)
}

/** What each parameter comes to now, by id — to tell which others a
 *  change carried along. */
const parameterValues = () => new Map(parametersOut().map((p) => [p.id, p.value]))

/** What a change of the parameters answers: the parameters it made or
 *  changed, the others whose value followed, the features whose numbers
 *  moved and the bodies the rebuild changed — not the whole table, which
 *  reverse.parameter.list gives. */
function parameterAnswer(s: ReverseSession, ids: readonly number[], before: readonly Feature[], bodiesBefore: Map<number, string>, valuesBefore: Map<number, number | null>, many = false) {
  const rows = parametersOut()
  const own = ids.map((id) => rows.find((p) => p.id === id) ?? null)
  const followed = rows.filter((p) => !ids.includes(p.id) && valuesBefore.has(p.id) && valuesBefore.get(p.id) !== p.value).map((p) => ({ name: p.name, value: p.value }))
  return {
    ...(many ? { parameters: own } : { parameter: own[0] }),
    ...(followed.length > 0 ? { followed } : {}),
    changed: moved(before),
    bodies: bodiesChanged(s, bodiesBefore),
    ...(failures().length > 0 ? { failed: failures() } : {}),
  }
}

export const parameterList: Command = {
  name: 'list',
  title: 'List the parameters',
  description: 'The model’s parameters: name, kind (length mm, angle °, integer, number), the expression, what it comes to, why it has no value if it has none, and usedBy: the features reading it with the fields they read it in (a feature’s field path, or "dimension <id>" in a sketch) and the parameters reading it. usedBy empty, or drivesNothing, is a parameter no face follows: not a driver of the part.',
  input: obj({}),
  readOnly: true,
  run: async () => ({ parameters: parametersOut() }),
}

type ParameterKindIn = 'length' | 'angle' | 'integer' | 'number'

interface NewParameter { name: string; expression: string; kind?: ParameterKindIn; comment?: string }

const newParameter = {
  name: str('The name expressions use.', { minLength: 1 }),
  expression: str('Its value: a number, with a unit if you like ("12", "0.5 in"), or arithmetic over other parameters.', { minLength: 1 }),
  kind: parameterKind,
  comment: str('A note on what it is for.'),
}

export const parameterAdd: Command<Partial<NewParameter> & { parameters?: NewParameter[] }> = {
  name: 'add',
  title: 'Add a parameter',
  description:
    'A named number for the whole model, as the panel’s Parameters section adds one — "l1" = "12", "d" = "3 mm", "head" = "1.8 * d". Sketch dimensions and feature fields read it by name in their expressions and follow it when it changes. A name is a letter or an underscore, then letters, digits and underscores, not a unit or a function name. parameters adds several in one step, in order — a later one may read an earlier one; one refused adds none. Returns the parameter (or parameters) added, not the whole table (reverse.parameter.list).',
  input: obj({
    ...newParameter,
    parameters: arr({ type: 'object' }, 'Several parameters in place of name and expression, each { name, expression, kind?, comment? }, added in order as one step.', { minItems: 1 }),
  }),
  label: ({ name, parameters }) => (parameters ? `add ${parameters.length} parameters` : `add parameter ${name}`),
  run: async ({ parameters, ...one }) => {
    if ((parameters === undefined) === (one.name === undefined && one.expression === undefined)) invalid('Give name and expression, or parameters — one of them.')
    if (!parameters && (one.name === undefined || one.expression === undefined)) invalid('Give both name and expression.')
    // Each of several held to the one's fields here: the tool lists them
    // once.
    parameters?.forEach((p, i) => {
      const errors = validate(obj(newParameter, ['name', 'expression']), p, `input.parameters[${i}]`)
      if (errors.length > 0) invalid(errors.join('; '))
    })
    const wanted: NewParameter[] = parameters ?? [one as NewParameter]
    // Every one checked against the table as the ones before it leave it,
    // before any is added.
    const table = [...re().parameters]
    wanted.forEach(({ name, expression, kind = 'length' }, i) => {
      const at = parameters ? `parameters[${i}] ` : ''
      const problem = nameProblem(name, table)
      if (problem) invalid(`${at}“${name}”: ${problem}.`)
      table.push({ id: -1 - i, name, kind, expression })
      const trial = evaluateParameters(table).readings.find((r) => r.id === -1 - i)
      if (trial?.error) invalid(`${at}${name} = ${expression}: ${trial.error}.`)
    })
    const before = re().features
    const bodiesBefore = bodyRows(reverseSession())
    const valuesBefore = parameterValues()
    const ids = await change(() => {
      const made: number[] = []
      for (const { name, expression, kind = 'length', comment } of wanted) {
        const id = re().addParameter(kind)
        made.push(id)
        const why = re().setParameter(id, { name, expression, ...(comment ? { comment } : {}) })
        if (why) {
          for (const m of made) re().removeParameter(m)
          invalid(parameters ? `${name}: ${why}` : why)
        }
      }
      return made
    })
    return parameterAnswer(session(), ids, before, bodiesBefore, valuesBefore, parameters !== undefined)
  },
}

export const parameterSet: Command<{ parameter?: Ref; name?: string; expression?: string; kind?: ParameterKindIn; comment?: string }> = {
  name: 'set',
  title: 'Set a parameter',
  description:
    'Give a parameter a new expression (or kind, or comment), as typing it into its row does: every sketch dimension and feature field that reads it follows, the sketches are solved again, and the part is rebuilt. The parameter by parameter (its name or id), or by name as reverse.parameter.add names it. Refused, with why, when the expression does not evaluate or would leave another parameter without a value. Returns the parameter, the other parameters whose value followed it, the features it changed and the bodies the rebuild changed.',
  input: obj({ parameter: featureRef('parameter'), name: str('The parameter’s name, in place of parameter.', { minLength: 1 }), expression: str('The new expression.', { minLength: 1 }), kind: parameterKind, comment: str() }),
  label: ({ parameter, name, expression }) => `set ${typeof (parameter ?? name) === 'string' ? (parameter ?? name) : `parameter ${parameter}`}${expression !== undefined ? ` = ${expression}` : ''}`,
  run: async ({ parameter, name, expression, kind, comment }) => {
    if (parameter !== undefined && name !== undefined) invalid('Give the parameter by parameter or by name, not both — reverse.parameter.rename renames it.')
    if (parameter === undefined && name === undefined) invalid('parameter: required — the parameter to set, by its name or id (name: takes it too).')
    const p = parameterNamed((parameter ?? name)!)
    const before = re().features
    const bodiesBefore = bodyRows(reverseSession())
    const valuesBefore = parameterValues()
    await change(() => {
      const why = re().setParameter(p.id, { ...(expression !== undefined ? { expression } : {}), ...(kind ? { kind } : {}), ...(comment !== undefined ? { comment } : {}) })
      if (why) invalid(`${p.name}: ${why}.`)
    })
    return parameterAnswer(session(), [p.id], before, bodiesBefore, valuesBefore)
  },
}

export const parameterRename: Command<{ parameter: Ref; name: string }> = {
  name: 'rename',
  title: 'Rename a parameter',
  description: 'Rename a parameter, and with it every expression that reads it — the features’ fields, the sketch dimensions and the other parameters. Returns the parameter and the features whose expressions were rewritten.',
  input: obj({ parameter: featureRef('parameter'), name: str('The new name.', { minLength: 1 }) }, ['parameter', 'name']),
  label: ({ parameter, name }) => `rename ${typeof parameter === 'string' ? parameter : `parameter ${parameter}`} to ${name}`,
  run: async ({ parameter, name }) => {
    const p = parameterNamed(parameter)
    const before = re().features
    const bodiesBefore = bodyRows(reverseSession())
    const valuesBefore = parameterValues()
    await change(() => {
      const why = re().setParameter(p.id, { name })
      if (why) invalid(`“${name}”: ${why}.`)
    })
    return parameterAnswer(session(), [p.id], before, bodiesBefore, valuesBefore)
  },
}

export const parameterRemove: Command<{ parameter: Ref }> = {
  name: 'remove',
  title: 'Remove a parameter',
  description: 'Take a parameter out of the table. Refused while anything reads it — take it out of those expressions first (a number set over a field’s expression lets it go).',
  input: obj({ parameter: featureRef('parameter') }, ['parameter']),
  label: ({ parameter }) => `remove parameter ${typeof parameter === 'string' ? parameter : parameter}`,
  run: async ({ parameter }) => {
    const p = parameterNamed(parameter)
    await change(() => {
      const why = re().removeParameter(p.id)
      if (why) throw new CommandError('invalid_state', why)
    })
    return { removed: { id: p.id, name: p.name }, left: re().parameters.length }
  },
}

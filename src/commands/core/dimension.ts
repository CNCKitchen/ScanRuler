// SPDX-License-Identifier: AGPL-3.0-only
// Dimensions and tolerances: measured between elements, held to limits,
// removed. Each goes through the panel's dimension box — opened, filled,
// added and closed again.

import {
  assignDimensionRefs,
  dimensionTypeInfo,
  dimensionTypes,
  evaluateDimension,
  type Dimension,
  type Limit,
  type SphereAnchor,
} from '../../core/dimensions'
import type { FitData } from '../../core/types'
import { useStore } from '../../state/store'
import { elementRefSchema, measuredElement, type ElementRef } from '../refs'
import { arr, enumOf, int, num, obj, oneOf, str, type JsonSchema } from '../schema'
import { describeDimension, evaluatedDimensions } from '../state'
import { CommandError, type Command } from '../types'
import { requireMeasureFree, showWorkspace } from './common'

const typeIds = () => dimensionTypes().map((t) => t.id)

const limitSchema: JsonSchema = oneOf(
  [
    obj({ kind: enumOf(['max'], 'A ceiling.'), max: num('The value may be this and no more — a tolerance zone’s width, mm or degrees.') }, ['kind', 'max']),
    obj(
      {
        kind: enumOf(['band'], 'A nominal with an allowance either side.'),
        nominal: num('The nominal value, mm or degrees.'),
        plus: num('How far above it is allowed.', { minimum: 0 }),
        minus: num('How far below it is allowed (a positive number).', { minimum: 0 }),
      },
      ['kind', 'nominal', 'plus', 'minus'],
    ),
  ],
  'What the value is checked against; the readout and the report then carry a pass or fail verdict.',
)

const dimensionRefSchema = (description: string): JsonSchema =>
  oneOf([int('The dimension’s id.', { minimum: 1 }), str('Its name — "Distance 1".', { minLength: 1 })], description)

/** The dimension an id or a name stands for. */
function findDimension(ref: number | string): Dimension {
  const { dimensions } = useStore.getState()
  const hits =
    typeof ref === 'number'
      ? dimensions.filter((d) => d.id === ref)
      : dimensions.filter((d) => d.name.trim().toLowerCase() === ref.trim().toLowerCase())
  if (hits.length === 0) throw new CommandError('not_found', `There is no dimension ${typeof ref === 'number' ? ref : `named "${ref}"`}.`)
  if (hits.length > 1) throw new CommandError('invalid_input', `${hits.length} dimensions are named "${ref}" — name it by its id.`)
  return hits[0]
}

const described = (id: number) => {
  const row = evaluatedDimensions().find((r) => r.dim.id === id)
  if (!row) throw new CommandError('internal', 'The dimension is not in the list.')
  return describeDimension(row)
}

/** Close the box the panel leaves open for the next dimension. */
const closeBox = () => {
  if (useStore.getState().dimDraft) useStore.getState().cancelDimension()
}

/** Re-open a dimension, change it with `change`, save it — the edit the
 *  panel's row opens. */
function editDimension(id: number, change: () => void) {
  useStore.getState().editDimension(id)
  try {
    change()
    useStore.getState().commitDimension()
  } finally {
    closeBox()
  }
}

const add: Command<{
  refs: ElementRef[]
  type?: string
  anchor?: SphereAnchor
  limit?: Limit
  basic?: number
  name?: string
}> = {
  name: 'add',
  title: 'Add a dimension',
  description:
    'Measure between elements, or a size or tolerance of one, as the panel’s dimension box does. refs are the elements by id or name. Without type, the type follows the elements as clicking them in the viewport does — two spheres or points give their centre distance, two planes their distance, a plane and an axis their distance, and so on. With type, it is one of: ' +
    dimensionTypes()
      .map((t) => `${t.id} (${t.slots.map((s) => s.label).join(', ')})`)
      .join('; ') +
    '. anchor, for two spheres: center (default), gap or span. limit holds the value to a ceiling or a nominal ± band. Returns the dimension with its value (mm or degrees, finer than the panel shows it), the formatted value the panel shows, and the verdict. One undo step.',
  input: obj(
    {
      refs: arr(elementRefSchema('An element.'), 'The elements, in slot order.', { minItems: 1, maxItems: 3 }),
      type: str('The dimension type — see the description. Optional.', { minLength: 1 }),
      anchor: enumOf(['center', 'gap', 'span'] as SphereAnchor[], 'Between two spheres: centre to centre (default), the gap between their surfaces, or the span across them.'),
      limit: limitSchema,
      basic: num('An angularity’s basic angle, degrees.'),
      name: str('A name for it; otherwise it is numbered — "Distance 2".', { minLength: 1 }),
    },
    ['refs'],
  ),
  label: () => 'add dimension',
  run: async (input) => {
    requireMeasureFree()
    if (input.type !== undefined && !typeIds().includes(input.type)) {
      throw new CommandError('invalid_input', `There is no dimension type "${input.type}" — there are ${typeIds().join(', ')}.`)
    }
    const els = input.refs.map((ref) => measuredElement(ref))
    showWorkspace('elements')
    const before = useStore.getState().nextDimensionId
    try {
      const store = useStore.getState()
      if (input.type) {
        const refs = assignDimensionRefs(input.type, els.map((e) => ({ id: e.id, kind: e.kind })))
        const info = dimensionTypeInfo(input.type)
        if (refs.some((r) => r === null) || els.length !== info.slots.length) {
          throw new CommandError(
            'invalid_input',
            `A ${info.label} ${info.family === 'tolerance' ? 'tolerance' : 'dimension'} takes ${info.slots.map((s) => s.label).join(' and ')} — ${els.map((e) => e.name).join(', ')} do not seat in it.`,
          )
        }
        store.startDimension(input.type)
        refs.forEach((id, slot) => useStore.getState().setDimensionRef(slot, id))
      } else {
        // The viewport's way: each element clicked in turn, the type
        // following what has been picked.
        store.startDimension('dist-point-point')
        for (const el of els) useStore.getState().selectDimensionElement(el.id)
        const dd = useStore.getState().dimDraft!
        if (dd.refs.some((r) => r === null) || els.some((e) => !dd.refs.includes(e.id))) {
          throw new CommandError('invalid_input', `${els.map((e) => e.name).join(' and ')} make no dimension on their own — name a type.`)
        }
      }
      if (input.anchor) useStore.getState().setDimensionAnchor(input.anchor)
      if (input.limit) useStore.getState().setDimensionLimit(input.limit)
      if (input.basic !== undefined) useStore.getState().setDimensionBasic(input.basic)
      // What the Add button is held to: a value to show.
      const dd = useStore.getState().dimDraft!
      const fits = dd.refs.map((id) => useStore.getState().elements.find((e) => e.id === id)?.fit) as FitData[]
      const preview = evaluateDimension(dd.type, fits, { anchor: dd.anchor, basic: dd.basic })
      if (preview.invalid) throw new CommandError('invalid_input', `${dimensionTypeInfo(dd.type).label}: ${preview.invalid}`)
      useStore.getState().commitDimension()
    } finally {
      closeBox()
    }
    const id = before
    if (!useStore.getState().dimensions.some((d) => d.id === id)) throw new CommandError('failed', 'The dimension could not be added.')
    if (input.name) editDimension(id, () => useStore.getState().setDimensionName(input.name!))
    return { dimension: described(id) }
  },
}

const setLimit: Command<{ dimension: number | string; limit: Limit | null }> = {
  name: 'set_limit',
  title: 'Set a dimension’s limit',
  description: 'Hold a dimension to a limit — a ceiling, or a nominal ± band — or take it off with null. Returns the dimension with its verdict. One undo step.',
  input: obj(
    {
      dimension: dimensionRefSchema('The dimension.'),
      limit: oneOf([limitSchema, { type: 'null', description: 'No limit.' }], 'The limit, or null for none.'),
    },
    ['dimension', 'limit'],
  ),
  label: () => 'set limit',
  run: async ({ dimension, limit }) => {
    requireMeasureFree()
    const d = findDimension(dimension)
    editDimension(d.id, () => useStore.getState().setDimensionLimit(limit ?? undefined))
    return { dimension: described(d.id) }
  },
}

const setBasic: Command<{ dimension: number | string; basic: number | null }> = {
  name: 'set_basic',
  title: 'Set an angularity’s basic angle',
  description: 'The basic angle an angularity tolerance is read against, in degrees, or null to take it off. One undo step.',
  input: obj(
    {
      dimension: dimensionRefSchema('The angularity.'),
      basic: oneOf([num('Degrees.'), { type: 'null', description: 'None.' }], 'The basic angle.'),
    },
    ['dimension', 'basic'],
  ),
  label: () => 'set basic angle',
  run: async ({ dimension, basic }) => {
    requireMeasureFree()
    const d = findDimension(dimension)
    editDimension(d.id, () => useStore.getState().setDimensionBasic(basic ?? undefined))
    return { dimension: described(d.id) }
  },
}

const remove: Command<{ dimension: number | string }> = {
  name: 'remove',
  title: 'Delete a dimension',
  description: 'Delete a dimension or tolerance. One undo step.',
  input: obj({ dimension: dimensionRefSchema('The dimension.') }, ['dimension']),
  label: () => 'delete dimension',
  run: async ({ dimension }) => {
    const d = findDimension(dimension)
    useStore.getState().removeDimension(d.id)
    return { removed: { id: d.id, name: d.name } }
  },
}

export const dimensionCommands = [add, setLimit, setBasic, remove]

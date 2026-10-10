// SPDX-License-Identifier: AGPL-3.0-only
// The part's coordinate system: a 3-2-1 datum alignment, the pose the scan
// suggests for itself, that pose settled on the mirror plane, and the way
// back. Each is set up in the panel's alignment box and confirmed, as a
// person does it — the elements, dimensions and sections move with the part.

import { ALIGN_PICK_COUNT, type AxisDir } from '../../core/alignment'
import type { Rigid } from '../../core/deviation/rigid'
import type { Vec3 } from '../../core/types'
import { alignCenterOf, alignmentPreview, useStore, type AlignSlot } from '../../state/store'
import { commandHost } from '../host'
import { elementRefSchema, measuredElement, requireScan, type ElementRef } from '../refs'
import { arr, enumOf, obj, oneOf, vec3, type JsonSchema } from '../schema'
import { describeElement, rigidJson } from '../state'
import { CommandError, type Command } from '../types'
import { lastError, requireMeasureFree, showWorkspace } from './common'

const AXES: readonly AxisDir[] = ['x+', 'x-', 'y+', 'y-', 'z+', 'z-']

type Slot =
  | { element: ElementRef }
  | { points: Vec3[] }
  | { point: Vec3 }

const slotSchema = (what: string, count: number, points: string): JsonSchema =>
  oneOf(
    [
      obj({ element: elementRefSchema(`A measured element for ${what}.`) }, ['element']),
      count === 1
        ? obj({ point: vec3(`A point for ${what}, mm.`) }, ['point'])
        : obj({ points: arr(vec3('A point, mm.'), `${count} points on the scan for ${what} — ${points}.`, { minItems: count, maxItems: count }) }, ['points']),
    ],
    `${what[0].toUpperCase()}${what.slice(1)}: an element, or ${count === 1 ? 'a point' : `${count} points`} on the scan.`,
  )

/** The outward normal at a point on the scan, from the vertex nearest it. */
async function normalAt(p: Vec3): Promise<Vec3> {
  const spot = await commandHost().session.clientRef.current!.nearest({ point: p })
  return spot.normal
}

/** Fill a slot of the open alignment box, by element or by points. */
async function fillSlot(slot: AlignSlot, value: Slot) {
  if ('element' in value) {
    useStore.getState().setAlignmentRef(slot, measuredElement(value.element).id)
    return
  }
  const points = 'points' in value ? value.points : [value.point]
  if (points.length !== ALIGN_PICK_COUNT[slot]) {
    throw new CommandError('invalid_input', `The ${slot} slot takes ${ALIGN_PICK_COUNT[slot]} point${ALIGN_PICK_COUNT[slot] === 1 ? '' : 's'}.`)
  }
  useStore.getState().beginAlignmentPick(slot)
  for (const p of points) useStore.getState().addAlignmentPick(p, slot === 'primary' ? await normalAt(p) : [0, 0, 1])
}

/** Confirm the pose the box holds — the Confirm alignment button. */
async function applyOpenBox(): Promise<Rigid> {
  const s = useStore.getState()
  const ad = s.alignDraft
  if (!ad) throw new CommandError('internal', 'The alignment box is not open.')
  const { preview, error } = alignmentPreview(ad, s.elements, s.modelSize, alignCenterOf(s))
  if (!preview) throw new CommandError('invalid_input', error ?? 'The alignment needs a levelling face or a zero point.')
  if (!(await commandHost().session.alignment.applyAlignment(preview.rigid))) {
    throw new CommandError('failed', lastError('The alignment could not be applied.'))
  }
  return preview.rigid
}

const closeBox = () => {
  if (useStore.getState().alignDraft) useStore.getState().cancelAlignment()
}

type Detail = 'brief' | 'full'

const detailIn = enumOf(['brief', 'full'], 'brief (the default): the transform and how many elements moved with the part. full: every element where it now is, as the list gives it.')

/** The elements after an alignment: how many moved with the part — or,
 *  with detail full, each where it now is. */
const elementsOut = (detail: Detail | undefined) => {
  const elements = useStore.getState().elements
  return detail === 'full' ? elements.map(describeElement) : elements.length
}

/** What an alignment leaves: the step applied, the whole alignment the part
 *  now carries when that is more than the step, and the elements. */
const applied = (step: Rigid, detail: Detail | undefined, extra: Record<string, unknown> = {}) => {
  const now = rigidJson(useStore.getState().appliedAlignment)
  const out = rigidJson(step)
  return {
    applied: out,
    ...(detail === 'full' || JSON.stringify(now) !== JSON.stringify(out) ? { appliedAlignment: now } : {}),
    ...extra,
    elements: elementsOut(detail),
  }
}

const datum: Command<{
  primary?: Slot
  primaryAxis?: AxisDir
  secondary?: Slot
  secondaryAxis?: AxisDir
  origin?: Slot
  detail?: Detail
}> = {
  name: 'datum',
  title: 'Align the part to datums',
  description:
    'A 3-2-1 alignment, as the panel’s alignment box sets it up: primary levels the part — a plane (or 3 points on a face) whose outward normal becomes primaryAxis (default z-, the face the part stands on facing down); secondary turns it — a line, axis or plane (or 2 points along an edge) laid along secondaryAxis (default x+); origin is the zero point — a point, sphere or circle (or 1 point). Each is an element by id or name, or points on the scan in mm. An origin alone moves the part without turning it. Everything measured moves with the part. Returns the transform applied — the whole alignment the part carries, when it was aligned before — and how many elements moved with it. One undo step.',
  input: obj({
    primary: slotSchema('levelling', 3, 'they span the face'),
    primaryAxis: enumOf(AXES, 'The axis the primary’s outward normal becomes — default z-.'),
    secondary: slotSchema('rotation', 2, 'they run along the edge'),
    secondaryAxis: enumOf(AXES, 'The axis the secondary runs along — default x+.'),
    origin: slotSchema('the zero point', 1, ''),
    detail: detailIn,
  }),
  label: () => 'datum alignment',
  run: async (input) => {
    requireScan()
    requireMeasureFree()
    if (!input.primary && !input.origin) throw new CommandError('invalid_input', 'Give a primary (levelling) datum, an origin, or both.')
    showWorkspace('elements')
    try {
      useStore.getState().startAlignment()
      if (input.primary) await fillSlot('primary', input.primary)
      if (input.primaryAxis) useStore.getState().setAlignmentAxis('primary', input.primaryAxis)
      if (input.secondary) await fillSlot('secondary', input.secondary)
      if (input.secondaryAxis) useStore.getState().setAlignmentAxis('secondary', input.secondaryAxis)
      if (input.origin) await fillSlot('origin', input.origin)
      return applied(await applyOpenBox(), input.detail)
    } finally {
      closeBox()
    }
  },
}

const auto: Command<{ detail?: Detail }> = {
  name: 'auto',
  title: 'Auto-align the part',
  description:
    'Read a coordinate system off the scan and apply it, as Auto-align then Confirm alignment do: the directions most faces are square to and the axis round walls run along, the part standing on its base, its long side along X. Returns what the pose was read from, the transform and how many elements moved with it. One undo step.',
  input: obj({ detail: detailIn }),
  label: () => 'auto-align',
  run: async ({ detail }) => {
    requireScan()
    requireMeasureFree()
    showWorkspace('elements')
    try {
      if (!(await commandHost().session.alignment.proposeAutoAlign())) {
        throw new CommandError('failed', lastError('Auto-align found no pose.'))
      }
      const note = useStore.getState().alignDraft?.proposal
      return applied(await applyOpenBox(), detail, { note })
    } finally {
      closeBox()
    }
  },
}

const symmetry: Command<{ detail?: Detail }> = {
  name: 'symmetry',
  title: 'Align the part on its symmetry plane',
  description:
    'Settle the part’s pose on its mirror plane and apply it, as Use symmetry then Confirm alignment do: the pose is Auto-align’s, the mirror plane a measured symmetry plane or one searched for on the scan; the axis nearest its normal is turned onto it and the zero point put on it. Refuses when the scan has no symmetry plane. Returns the note on what it settled on, the transform and how many elements moved with it. One undo step.',
  input: obj({ detail: detailIn }),
  label: () => 'symmetry alignment',
  run: async ({ detail }) => {
    requireScan()
    requireMeasureFree()
    showWorkspace('elements')
    try {
      if (!(await commandHost().session.alignment.proposeSymmetry())) {
        throw new CommandError('failed', lastError('No symmetry plane was found.'))
      }
      const note = useStore.getState().alignDraft?.proposal
      return applied(await applyOpenBox(), detail, { note })
    } finally {
      closeBox()
    }
  },
}

const clear: Command<{ detail?: Detail }> = {
  name: 'clear',
  title: 'Reset the alignment',
  description: 'Put the part back in the coordinates the scanner delivered it in, with everything measured on it. Returns how many elements moved with it. One undo step.',
  input: obj({ detail: detailIn }),
  label: () => 'reset alignment',
  run: async ({ detail }) => {
    requireScan()
    requireMeasureFree()
    const total = useStore.getState().appliedAlignment
    if (!total) throw new CommandError('invalid_state', 'The part is in scan coordinates already.')
    showWorkspace('elements')
    if (!(await commandHost().session.alignment.resetAlignment())) {
      throw new CommandError('failed', lastError('The alignment could not be reset.'))
    }
    return { appliedAlignment: null, elements: elementsOut(detail) }
  },
}

export const alignCommands = [datum, auto, symmetry, clear]

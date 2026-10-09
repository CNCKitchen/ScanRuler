// SPDX-License-Identifier: AGPL-3.0-only
// 2D Measure: a flatbed image or a section laid on the sheet, calibrated,
// aligned, measured. A place on the sheet is given in the sheet's own
// coordinates — millimetres once the image is calibrated (a section always
// is), pixels before — and goes in as a click on the sheet does, snapping to
// the detected edges the way a click does.

import { flatMethodsForKind } from '../../core/flat/construct'
import { FLAT_DIMENSION_TYPES, flatDimensionTypeInfo } from '../../core/flat/dimensions'
import { flatRoleOf } from '../../core/flat/refs'
import type { FlatElementKind, Vec2 } from '../../core/flat/types'
import { buildFlatReport } from '../../core/flat/report'
import { flatReportInput } from '../../app/flatReport'
import { useFlat, type CalMode } from '../../state/flatStore'
import { commandHost } from '../host'
import { arr, bytes, enumOf, int, num, obj, oneOf, str, type JsonSchema } from '../schema'
import { describeFlat } from '../state'
import { CommandError, type Command } from '../types'
import { fileNameSchema, fileOf, lastError, requireFlatFree, showWorkspace } from './common'

const KINDS: readonly FlatElementKind[] = ['point', 'line', 'circle', 'arc', 'spline']

const spotSchema = (description: string): JsonSchema => arr(num(), description, { minItems: 2, maxItems: 2 })
const spotsSchema = (description: string, minItems = 1): JsonSchema =>
  arr(spotSchema('A place on the sheet, [x, y] in the sheet’s units.'), description, { minItems })

const flatRefSchema = (description: string): JsonSchema =>
  oneOf([int('The 2D element’s id.', { minimum: 1 }), str('Its name — "Line 1".', { minLength: 1 })], description)

function requireSheet() {
  const f = useFlat.getState()
  if (f.subject.kind === 'image' && !f.imageName) {
    throw new CommandError('invalid_state', 'Nothing is on the 2D sheet — open an image with flat.open_image, or cut a section.')
  }
}

function findFlatElement(ref: number | string) {
  const { elements } = useFlat.getState()
  const hits =
    typeof ref === 'number'
      ? elements.filter((e) => e.id === ref)
      : elements.filter((e) => e.name.trim().toLowerCase() === ref.trim().toLowerCase())
  if (hits.length === 0) throw new CommandError('not_found', `There is no 2D element ${typeof ref === 'number' ? ref : `named "${ref}"`}.`)
  if (hits.length > 1) throw new CommandError('invalid_input', `${hits.length} 2D elements are named "${ref}" — name it by its id.`)
  return hits[0]
}

/** A click on the sheet at `spot`, as the viewport hands one to the store —
 *  snapping within about ten image pixels, as a click at 100 % does. */
function clickSheet(spot: Vec2) {
  const f = useFlat.getState()
  const pxPerUnit = f.pxPerMm?.x ?? 1
  f.stageClick(spot, { alt: false, unitsPerScreenPx: 1 / pxPerUnit }, commandHost().flat?.edgeIndex() ?? null)
}

const describeElement = (id: number) => {
  const e = useFlat.getState().elements.find((x) => x.id === id)!
  return { id: e.id, name: e.name, kind: e.kind, fit: e.fit ?? null }
}

const openImage: Command<{ bytes: Uint8Array; name: string }> = {
  name: 'open_image',
  title: 'Open a flatbed image',
  description:
    'Open a flatbed scan of a part — PNG or JPEG, at the highest optical resolution — on the 2D sheet, in place of the image there was. The scale it declares about itself is taken until it is calibrated. Needs the browser. Returns the 2D state. Not undoable: a new image starts a new history.',
  input: obj({ bytes: bytes('The file’s contents.'), name: fileNameSchema('"part.png"') }, ['bytes', 'name']),
  history: false,
  run: async ({ bytes: data, name }) => {
    const flat = commandHost().flat
    if (!flat) throw new CommandError('unavailable', 'Opening an image needs the browser.')
    showWorkspace('flat')
    await flat.openImage(fileOf(data, name))
    if (useFlat.getState().imageName !== name) throw new CommandError('failed', lastError(`${name} could not be opened.`))
    return { flat: describeFlat() }
  },
}

const calibrate: Command<{ mode: CalMode; points: Vec2[]; mm: number }> = {
  name: 'calibrate',
  title: 'Calibrate the image',
  description:
    'Set the image’s scale against a known length, as the Calibrate tool does: distance takes two places a known distance apart, diameter three or more on a circle of known diameter; mm is that length. Every measurement on the image follows the new scale. Returns the calibration. One undo step.',
  input: obj(
    {
      mode: enumOf(['distance', 'diameter'] as CalMode[], 'distance (two places) or diameter (three or more on a circle).'),
      points: spotsSchema('The places, in the sheet’s units as they are now.', 2),
      mm: num('The true length, mm.', { exclusiveMinimum: 0 }),
    },
    ['mode', 'points', 'mm'],
  ),
  label: () => 'calibrate',
  run: async ({ mode, points, mm }) => {
    requireSheet()
    requireFlatFree()
    if (useFlat.getState().subject.kind !== 'image') throw new CommandError('invalid_state', 'A section is in millimetres already.')
    if (mode === 'distance' && points.length !== 2) throw new CommandError('invalid_input', 'distance takes two places.')
    if (mode === 'diameter' && points.length < 3) throw new CommandError('invalid_input', 'diameter takes three places or more.')
    showWorkspace('flat')
    useFlat.getState().startCalibration(mode)
    try {
      for (const p of points) clickSheet(p)
      const error = useFlat.getState().applyCalibration(mm)
      if (error) throw new CommandError('invalid_input', error)
    } finally {
      if (useFlat.getState().tool.kind === 'calibrate') useFlat.getState().cancelCalibration()
    }
    return { calibration: describeFlat().calibration }
  },
}

const setAlignment: Command<{ origin?: Vec2; xAxis?: Vec2; clear?: boolean }> = {
  name: 'set_alignment',
  title: 'Align the sheet',
  description:
    'Put the sheet’s zero point at origin and its X axis through xAxis, as the Align tool’s two clicks do — every coordinate on the sheet is then read in that frame. clear: true takes the alignment off. Returns the 2D state. One undo step.',
  input: obj({
    origin: spotSchema('The zero point, in the sheet’s units.'),
    xAxis: spotSchema('A place on the +X axis.'),
    clear: { type: 'boolean', description: 'Take the alignment off instead.' },
  }),
  label: () => 'align sheet',
  run: async ({ origin, xAxis, clear }) => {
    requireSheet()
    requireFlatFree()
    showWorkspace('flat')
    if (clear) {
      useFlat.getState().clearDatum()
      return { flat: describeFlat() }
    }
    if (!origin || !xAxis) throw new CommandError('invalid_input', 'Give origin and xAxis, or clear: true.')
    useFlat.getState().startDatum()
    try {
      clickSheet(origin)
      clickSheet(xAxis)
    } finally {
      if (useFlat.getState().tool.kind === 'datum') useFlat.getState().cancelDatum()
    }
    if (!useFlat.getState().datum) throw new CommandError('failed', 'The sheet could not be aligned.')
    return { flat: describeFlat() }
  },
}

const detectEdges: Command<{ sensitivity?: number }> = {
  name: 'detect_edges',
  title: 'Detect the image’s edges',
  description:
    'Find the edges in the image again at a sensitivity from 0 (only the strongest) to 1 (every faint one) — what the seed and edge methods of flat.fit and the snapping of every place follow. Needs the browser. Returns how many edge chains were found.',
  input: obj({ sensitivity: num('0 to 1.', { minimum: 0, maximum: 1 }) }),
  label: () => 'detect edges',
  run: async ({ sensitivity }) => {
    const flat = commandHost().flat
    if (!flat) throw new CommandError('unavailable', 'Edge detection needs the browser.')
    requireSheet()
    showWorkspace('flat')
    const chains = await flat.detectEdges(sensitivity ?? useFlat.getState().edgeSensitivity)
    return { chains }
  },
}

const fit: Command<{ kind: FlatElementKind; method?: string; points?: Vec2[]; refs?: (number | string)[]; name?: string }> = {
  name: 'fit',
  title: 'Fit a 2D element',
  description:
    'Make a 2D element on the sheet as its tool does — kind point, line, circle, arc or spline, by a method of that kind: ' +
    KINDS.map((k) => `${k}: ${flatMethodsForKind(k).map((m) => `${m.id} (${m.mode})`).join(', ')}`).join('; ') +
    '. A pick method takes points, the places clicked; a seed method one place on a detected edge, grown along it; an edge method a place on an edge, taken whole; a construct method refs, other 2D elements by id or name. Returns the element with its fit. One undo step.',
  input: obj(
    {
      kind: enumOf(KINDS, 'What to make.'),
      method: str('The method — see the description; the kind’s first pick method by default.', { minLength: 1 }),
      points: spotsSchema('The places, in the sheet’s units.'),
      refs: arr(flatRefSchema('A 2D element.'), 'construct: the source elements.'),
      name: str('A name for it.', { minLength: 1 }),
    },
    ['kind'],
  ),
  label: ({ kind }) => `fit 2D ${kind}`,
  run: async ({ kind, method, points, refs, name }) => {
    requireSheet()
    requireFlatFree()
    const id = method ?? flatMethodsForKind(kind).find((m) => m.mode === 'pick')?.id ?? flatMethodsForKind(kind)[0].id
    const m = flatMethodsForKind(kind).find((x) => x.id === id)
    if (!m) throw new CommandError('invalid_input', `A 2D ${kind} has no method "${id}" — it has ${flatMethodsForKind(kind).map((x) => x.id).join(', ')}.`)
    showWorkspace('flat')
    const f = useFlat.getState()
    f.startDraft(kind, m.id)
    try {
      if (m.mode === 'construct') {
        const slots = m.slots ?? []
        if ((refs ?? []).length !== slots.length) throw new CommandError('invalid_input', `${m.label} takes ${slots.length} source element${slots.length === 1 ? '' : 's'}.`)
        refs!.forEach((ref, slot) => useFlat.getState().setDraftRef(slot, findFlatElement(ref).id))
      } else {
        if (!points?.length) throw new CommandError('invalid_input', `${m.label} takes points.`)
        for (const p of points) clickSheet(p)
      }
      const draft = useFlat.getState().draft
      if (!draft?.fit) throw new CommandError('failed', draft?.error ?? `${m.label} has nothing to fit yet — give more points.`)
      const created = useFlat.getState().commitDraft()
      if (created === null) throw new CommandError('failed', 'The element could not be created.')
      if (name) {
        useFlat.getState().editElement(created)
        useFlat.getState().setDraftName(name)
        useFlat.getState().commitDraft()
      }
      return { element: describeElement(created) }
    } finally {
      if (useFlat.getState().draft) useFlat.getState().cancelDraft()
    }
  },
}

const dimensionAdd: Command<{ refs: (number | string)[]; type?: string; name?: string }> = {
  name: 'dimension_add',
  title: 'Add a 2D dimension',
  description:
    'Measure between two 2D elements: ' +
    FLAT_DIMENSION_TYPES.map((t) => `${t.id} (${t.slots.map((s) => s.role).join(', ')})`).join(', ') +
    '. Points, circles and arcs count as their point (centre), lines as lines. Without type, the first that takes the two elements in the order given. Returns the dimensions on the sheet. One undo step.',
  input: obj(
    {
      refs: arr(flatRefSchema('A 2D element.'), 'The two elements.', { minItems: 2, maxItems: 2 }),
      type: enumOf(FLAT_DIMENSION_TYPES.map((t) => t.id), 'The dimension type.'),
      name: str('A name for it.', { minLength: 1 }),
    },
    ['refs'],
  ),
  label: () => 'add 2D dimension',
  run: async ({ refs, type, name }) => {
    requireSheet()
    requireFlatFree()
    const els = refs.map(findFlatElement)
    const roles = els.map((e) => flatRoleOf(e.kind))
    const fits = (id: string) => flatDimensionTypeInfo(id).slots.every((s, i) => s.role === roles[i])
    const chosen = type ?? FLAT_DIMENSION_TYPES.find((t) => fits(t.id))?.id
    if (!chosen || !fits(chosen)) {
      throw new CommandError('invalid_input', `${els.map((e) => e.name).join(' and ')} make no ${type ?? '2D'} dimension in that order.`)
    }
    showWorkspace('flat')
    const id = useFlat.getState().nextDimId
    useFlat.getState().startDimDraft()
    try {
      useFlat.getState().setDimType(chosen)
      els.forEach((e, slot) => useFlat.getState().setDimRef(slot, e.id))
      useFlat.getState().commitDim()
      if (!useFlat.getState().dimensions.some((d) => d.id === id)) throw new CommandError('failed', 'The dimension could not be added.')
      if (name) {
        // A name is the edit box's to give, as in the panel.
        useFlat.getState().editDimension(id)
        useFlat.getState().setDimName(name)
        useFlat.getState().commitDim()
      }
    } finally {
      if (useFlat.getState().dimDraft) useFlat.getState().cancelDimDraft()
    }
    return { flat: describeFlat(), report: buildFlatReport(flatReportInput()) }
  },
}

const report: Command = {
  name: 'report',
  title: 'Get the 2D report',
  description: 'The 2D Measure report as its Copy button gives it: the image or section, the scale it rests on, the alignment, every element and dimension.',
  input: obj({}),
  readOnly: true,
  run: async () => {
    requireSheet()
    return { text: buildFlatReport(flatReportInput()) }
  },
}

export const flatCommands = [openImage, calibrate, setAlignment, detectEdges, fit, dimensionAdd, report]

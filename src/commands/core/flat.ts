// SPDX-License-Identifier: AGPL-3.0-only
// 2D Measure: a flatbed image or a section laid on the sheet, calibrated,
// aligned, measured. A place on the sheet is given in the sheet's own
// coordinates — millimetres once the image is calibrated (a section always
// is), pixels before; on an image the origin is its bottom-left corner, +X
// to the right, +Y up, whatever the alignment or the turns show — and goes
// in as a click on the sheet does, snapping to the detected edges the way a
// click does. An edge is also named by its chain: its number in the
// detection, which holds until the edges are found again.

import { collectsEdgePoints, flatMethodsForKind } from '../../core/flat/construct'
import { FLAT_DIMENSION_TYPES, flatDimensionTypeInfo } from '../../core/flat/dimensions'
import { chainEnters, chainNearest, chainPoints, chainPolyline, chainSummary, chainTotal } from '../../core/flat/chains'
import type { EdgeChains } from '../../core/flat/edges'
import type { FlatObject, FlatObjects } from '../../core/flat/objects'
import type { ProfileAbout } from '../../core/flat/profile'
import { flatRoleOf } from '../../core/flat/refs'
import { simplifyRun } from '../../core/flat/simplify'
import { thinEdgePoints, type EdgeIndex } from '../../core/flat/snap'
import type { FlatElementKind, Vec2 } from '../../core/flat/types'
import { buildFlatReport } from '../../core/flat/report'
import { flatExportStem, flatReportInput } from '../../app/flatReport'
import { sheetCounts, sheetDimensions, sheetElements, sheetFrame, sheetNotes, sheetScale } from '../../app/flatSheet'
import { docToPx } from '../../state/flatModel'
import { useFlat, type CalMode } from '../../state/flatStore'
import { commandHost } from '../host'
import { refOf } from '../refs'
import { arr, bool, bytes, enumOf, int, num, obj, oneOf, str, type JsonSchema } from '../schema'
import { describeFlat } from '../state'
import { CommandError, type Command } from '../types'
import { fileNameSchema, fileOf, lastError, requireFlatFree, showWorkspace, waitFor } from './common'

const KINDS: readonly FlatElementKind[] = ['point', 'line', 'circle', 'arc', 'spline']

const spotSchema = (description: string): JsonSchema => arr(num(), description, { minItems: 2, maxItems: 2 })
const spotsSchema = (description: string, minItems = 1): JsonSchema =>
  arr(spotSchema('A place on the sheet, [x, y] in the sheet’s units.'), description, { minItems })
const boxSchema = (description: string): JsonSchema =>
  obj({ min: spotSchema('The lowest corner.'), max: spotSchema('The highest corner.') }, ['min', 'max'], description)
const chainIdsSchema = (description: string): JsonSchema => arr(int(undefined, { minimum: 0 }), description, { minItems: 1 })

const flatRefSchema = (description: string): JsonSchema =>
  oneOf([int('The 2D element’s id.', { minimum: 1 }), str('Its name — "Line 1".', { minLength: 1 })], description)

type Box = { min: Vec2; max: Vec2 }

function requireSheet() {
  const f = useFlat.getState()
  if (f.subject.kind === 'image' && !f.imageName) {
    throw new CommandError('invalid_state', 'Nothing is on the 2D sheet — open an image with flat.open_image, or cut a section.')
  }
}

function findFlatElement(given: number | string) {
  const { elements } = useFlat.getState()
  const ref = refOf(elements, given)
  const hits =
    typeof ref === 'number'
      ? elements.filter((e) => e.id === ref)
      : elements.filter((e) => e.name.trim().toLowerCase() === ref.trim().toLowerCase())
  if (hits.length === 0) throw new CommandError('not_found', `There is no 2D element ${typeof ref === 'number' ? ref : `named "${ref}"`}.`)
  if (hits.length > 1) throw new CommandError('invalid_input', `${hits.length} 2D elements are named "${ref}" — name it by its id.`)
  return hits[0]
}

/** A dimension, a note or a tally by id — or, for those that have one, by
 *  name — on the sheet on the stage. */
function findOnSheet<T extends { id: number; name?: string }>(list: readonly T[], given: number | string, what: string): T {
  const ref = refOf(list, given)
  const hits =
    typeof ref === 'number'
      ? list.filter((x) => x.id === ref)
      : list.filter((x) => x.name?.trim().toLowerCase() === ref.trim().toLowerCase())
  if (hits.length === 0) throw new CommandError('not_found', `There is no ${what} ${typeof ref === 'number' ? ref : `named "${ref}"`} on the sheet.`)
  if (hits.length > 1) throw new CommandError('invalid_input', `${hits.length} ${what}s are named "${ref}" — name it by its id.`)
  return hits[0]
}

/** A note's text as the Text tool keeps it: one line, a line break written
 *  as " / ". */
const oneLine = (text: string) => text.trim().replace(/\s*\n\s*/g, ' / ')

/** The sheet's units, for the answers. */
const unitNow = () => (useFlat.getState().pxPerMm ? 'mm' : 'px')

/** Image pixels (the frame picks are kept in) as a place on the sheet. */
function pxToDoc(px: Vec2): Vec2 {
  const unit = sheetScale(useFlat.getState())
  return [px[0] * unit.x, px[1] * unit.y]
}

/** How far a place snaps or a click reaches, in image pixels: `reach` in
 *  the sheet's units, or the ten image pixels a click at 100 % reaches. */
function reachPx(reach: number | undefined): number {
  return reach === undefined ? 10 : reach * (useFlat.getState().pxPerMm?.x ?? 1)
}

/** A click on the sheet at `spot`, as the viewport hands one to the store,
 *  reaching `radiusPx` image pixels for an edge — the reach a click has at
 *  the zoom where ten screen pixels are that many. */
function clickSheet(spot: Vec2, radiusPx = 10) {
  const f = useFlat.getState()
  const pxPerUnit = f.pxPerMm?.x ?? 1
  f.stageClick(spot, { alt: false, unitsPerScreenPx: radiusPx / (10 * pxPerUnit) }, commandHost().flat?.edgeIndex() ?? null)
}

/** The sheet's edges once any detection running has finished — the chains
 *  and the index over them — or a refusal saying why there are none. */
async function settledEdges(): Promise<{ chains: EdgeChains; index: EdgeIndex; kind: 'image' | 'section' }> {
  const flat = commandHost().flat
  if (!flat) throw new CommandError('unavailable', 'The detected edges are the browser’s.')
  requireSheet()
  if (useFlat.getState().edgeStatus === 'running') await waitFor(() => useFlat.getState().edgeStatus !== 'running', 'the edges to be found')
  const view = flat.sheet()
  const index = flat.edgeIndex()
  if (!view?.chains || !index || chainTotal(view.chains) === 0) {
    throw new CommandError('invalid_state', 'No edges are detected on the sheet — flat.detect_edges finds them, more faintly at a higher sensitivity.')
  }
  return { chains: view.chains, index, kind: view.kind }
}

/** Chains by number, checked against the sheet's. */
function checkChains(chains: EdgeChains, ids: readonly number[]): void {
  const total = chainTotal(chains)
  for (const id of ids) {
    if (id >= total) throw new CommandError('not_found', `There is no chain ${id} — the sheet has ${total}, numbered 0 to ${total - 1}; flat.edges lists them.`)
  }
}

/** Why a click at `spot` found no edge, and where the nearest one is — so a
 *  near miss says where to click instead. */
function missedEdge(spot: Vec2, index: EdgeIndex, radiusPx: number): string {
  const unit = unitNow()
  const px = docToPx(useFlat.getState(), spot)
  const sheetPx = pxToDoc([1, 1])[0]
  const reach = `${+(radiusPx * sheetPx).toPrecision(3)} ${unit}`
  for (let r = radiusPx * 4; r < 1e6; r *= 4) {
    const hit = index.nearestOnChain(px[0], px[1], r)
    if (!hit) continue
    const at = pxToDoc(hit.at).map((v) => +v.toPrecision(6))
    return `No detected edge within ${reach} of [${spot.join(', ')}] — the nearest is chain ${hit.chain}, ${+(hit.distance * sheetPx).toPrecision(3)} ${unit} away at [${at.join(', ')}]: click there, or name it with chains: [${hit.chain}].`
  }
  return `No detected edge within ${reach} of [${spot.join(', ')}], nor anywhere near.`
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
    'Set the image’s scale against a known length, as the Calibrate tool does: distance takes two places a known distance apart, diameter three or more on a circle of known diameter; mm is that length. Every measurement follows the new scale, and the edges are found again (their chain numbers change). Returns the calibration. One undo step.',
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
    'Put the part’s zero point at origin and its X axis through xAxis, as the Align tool’s two clicks do: the report, the panel and the exports then read in that frame. Places given to the commands stay the sheet’s own. clear: true takes the alignment off. Returns the 2D state. One undo step.',
  input: obj({
    origin: spotSchema('The zero point, in the sheet’s units.'),
    xAxis: spotSchema('A place on the +X axis.'),
    clear: bool('Take the alignment off instead.'),
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
    'Find the edges in the image again at a sensitivity from 0 (only the strongest) to 1 (every faint one) — what the edge methods of flat.fit and the snapping of every place follow. The chains are numbered afresh. Needs the browser. Returns how many edge chains were found.',
  input: obj({ sensitivity: num('0 to 1.', { minimum: 0, maximum: 1 }) }),
  label: () => 'detect edges',
  run: async ({ sensitivity }, ctx) => {
    const flat = commandHost().flat
    if (!flat) throw new CommandError('unavailable', 'Edge detection needs the browser.')
    requireSheet()
    showWorkspace('flat')
    const chains = await flat.detectEdges(sensitivity ?? useFlat.getState().edgeSensitivity, ctx.signal)
    return { chains }
  },
}

type PickAnswer = { at: Vec2; chain?: number; moved?: number }

const fit: Command<{
  kind: FlatElementKind
  method?: string
  points?: Vec2[]
  chains?: number[]
  box?: Box
  refs?: (number | string)[]
  name?: string
  snap?: boolean
  reach?: number
}> = {
  name: 'fit',
  title: 'Fit a 2D element',
  description:
    'Make a 2D element on the sheet as its tool does — kind point, line, circle, arc or spline, by a method of that kind: ' +
    KINDS.map((k) => `${k}: ${flatMethodsForKind(k).map((m) => `${m.id} (${m.mode})`).join(', ')}`).join('; ') +
    '. A pick method takes points, the places clicked (snapped to the nearest edge within reach unless snap: false; picks says where each landed); a seed method one place on an edge and grows along it; an edge method a place on an edge taken whole, or chains and box; a construct method refs, other 2D elements. Returns the element with its fit. One undo step.',
  input: obj(
    {
      kind: enumOf(KINDS, 'What to make.'),
      method: str('The method — see the description; the kind’s first pick method by default.', { minLength: 1 }),
      points: spotsSchema('The places, in the sheet’s units.'),
      chains: chainIdsSchema('Edge chains by number, taken whole (edge or seed methods).'),
      box: boxSchema('Edge points inside this box, sheet units (edge or seed methods).'),
      refs: arr(flatRefSchema('A 2D element.'), 'construct: the source elements.'),
      name: str('A name for it.', { minLength: 1 }),
      snap: bool('Picks snap to the nearest edge within reach; true by default.'),
      reach: num('How far a place reaches for an edge, sheet units; ten image pixels by default.', { exclusiveMinimum: 0 }),
    },
    ['kind'],
  ),
  label: ({ kind }) => `fit 2D ${kind}`,
  run: async ({ kind, method, points, chains, box, refs, name, snap, reach }) => {
    requireSheet()
    requireFlatFree()
    const methods = flatMethodsForKind(kind)
    const byEdges = chains !== undefined || box !== undefined
    const id =
      method ??
      (byEdges ? methods.find((m) => m.mode === 'edge')?.id : undefined) ??
      methods.find((m) => m.mode === 'pick')?.id ??
      methods[0].id
    const m = methods.find((x) => x.id === id)
    if (!m) throw new CommandError('invalid_input', `A 2D ${kind} has no method "${id}" — it has ${methods.map((x) => x.id).join(', ')}.`)
    if (byEdges && !collectsEdgePoints(m)) {
      throw new CommandError('invalid_input', `${m.label} takes ${m.mode === 'construct' ? 'refs' : 'points'}; chains and box are for the edge methods of a line, circle or arc.`)
    }
    const edges = byEdges || m.mode === 'seed' || m.mode === 'edge' ? await settledEdges() : null
    if (chains && edges) checkChains(edges.chains, chains)
    showWorkspace('flat')
    useFlat.getState().startDraft(kind, m.id)
    let picks: PickAnswer[] | undefined
    try {
      if (m.mode === 'construct') {
        const slots = m.slots ?? []
        const given = (refs ?? []).length
        if (m.repeat ? given < slots.length : given !== slots.length) throw new CommandError('invalid_input', `${m.label} takes ${m.repeat ? `${slots.length} or more` : slots.length} source element${slots.length === 1 ? '' : 's'}.`)
        refs!.forEach((ref, slot) => useFlat.getState().setDraftRef(slot, findFlatElement(ref).id))
      } else if (byEdges) {
        const collected = edgePointsOf(edges!, chains, box)
        if (collected.length === 0) throw new CommandError('invalid_input', chains ? 'No point of those chains lies inside the box.' : 'No detected edge point lies inside the box.')
        useFlat.getState().addDraftPoints(thinEdgePoints(collected))
      } else {
        if (!points?.length) throw new CommandError('invalid_input', `${m.label} takes points.`)
        if (m.mode === 'pick') picks = placePicks(points, snap, reach)
        else {
          const radius = reachPx(reach)
          for (const p of points) {
            const px = docToPx(useFlat.getState(), p)
            if (!edges!.index.nearestOnChain(px[0], px[1], radius)) throw new CommandError('invalid_input', missedEdge(p, edges!.index, radius))
            clickSheet(p, radius)
          }
        }
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
      return { element: describeElement(created), ...(picks ? { picks } : {}) }
    } finally {
      if (useFlat.getState().draft) useFlat.getState().cancelDraft()
    }
  },
}

/** The edge points (image pixels) of whole chains, or of every chain inside
 *  a box, or of those chains inside it. */
function edgePointsOf(edges: { chains: EdgeChains; index: EdgeIndex }, chains: number[] | undefined, box: Box | undefined): Vec2[] {
  const f = useFlat.getState()
  const lo = box && docToPx(f, box.min)
  const hi = box && docToPx(f, box.max)
  const inside = (p: Vec2) =>
    !lo || !hi || (p[0] >= Math.min(lo[0], hi[0]) && p[0] <= Math.max(lo[0], hi[0]) && p[1] >= Math.min(lo[1], hi[1]) && p[1] <= Math.max(lo[1], hi[1]))
  if (!chains) return lo && hi ? edges.index.inBox(lo[0], lo[1], hi[0], hi[1]) : []
  // The chains are in image pixels — the frame picks are kept in — so they
  // go in as they are.
  return chains.flatMap((c) => chainPoints(edges.chains, c, { x: 1, y: 1 }).filter(inside))
}

/** Hand-placed picks: each snapped to the nearest edge within reach — or
 *  left where it was put — and said where it landed. */
function placePicks(points: Vec2[], snap: boolean | undefined, reach: number | undefined): PickAnswer[] {
  const index = commandHost().flat?.edgeIndex() ?? null
  const radius = reachPx(reach)
  const snapping = (snap ?? useFlat.getState().snapToEdge) && index !== null
  return points.map((spot) => {
    const px = docToPx(useFlat.getState(), spot)
    const hit = snapping ? index!.nearestOnChain(px[0], px[1], radius) : null
    useFlat.getState().addDraftPick(hit ? hit.at : px)
    if (!hit) return { at: spot }
    const at = pxToDoc(hit.at)
    return { at, chain: hit.chain, moved: Math.hypot(at[0] - spot[0], at[1] - spot[1]) }
  })
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

const noteAdd: Command<{ text: string; at: Vec2 }> = {
  name: 'note_add',
  title: 'Write a note on the sheet',
  description:
    'Write a text note on the 2D sheet, as the Text tool does — one line, a line break written as " / "; at is its lower-left corner, sheet units. It is drawn on the stage and in flat.render, written into the SVG and DXF exports and listed in the report. Returns the note with its id. One undo step.',
  input: obj({ text: str('What it says.', { minLength: 1 }), at: spotSchema('Its lower-left corner.') }, ['text', 'at']),
  label: () => 'add 2D note',
  run: async ({ text, at }) => {
    requireSheet()
    requireFlatFree()
    const line = oneLine(text)
    if (line === '') throw new CommandError('invalid_input', 'A note needs some text.')
    showWorkspace('flat')
    const f = useFlat.getState()
    const id = f.nextNoteId
    f.addNote(docToPx(f, at))
    useFlat.getState().setNoteText(id, line)
    useFlat.getState().finishNote()
    return { note: { id, text: line, at } }
  },
}

const edit: Command<{
  element?: number | string
  dimension?: number | string
  note?: number
  count?: number | string
  name?: string
  text?: string
  at?: Vec2
  visible?: boolean
}> = {
  name: 'edit',
  title: 'Change a 2D element, dimension, note or count',
  description:
    'Change one thing on the 2D sheet, by id or name: an element, a dimension or a count takes a new name; a note new text or a new place (at, its lower-left corner); any of them visible: false to leave it out of the stage, the picture and the exports. Returns the 2D state. One undo step.',
  input: obj({
    element: flatRefSchema('A 2D element.'),
    dimension: oneOf([int('Its id.', { minimum: 1 }), str('Its name — "Distance 1".', { minLength: 1 })], 'A 2D dimension.'),
    note: int('A note, by its id.', { minimum: 1 }),
    count: oneOf([int('Its id.', { minimum: 1 }), str('Its name — "Count 1".', { minLength: 1 })], 'A count (tally).'),
    name: str('The new name.', { minLength: 1 }),
    text: str('A note’s new text.', { minLength: 1 }),
    at: spotSchema('A note’s new lower-left corner.'),
    visible: bool('Shown, or left out.'),
  }),
  label: () => 'change 2D sheet',
  run: async ({ element, dimension, note, count, name, text, at, visible }) => {
    requireSheet()
    requireFlatFree()
    const named = [element, dimension, note, count].filter((x) => x !== undefined).length
    if (named !== 1) throw new CommandError('invalid_input', 'Name one thing: element, dimension, note or count.')
    if (note === undefined && (text !== undefined || at !== undefined)) throw new CommandError('invalid_input', 'text and at are a note’s.')
    if (note !== undefined && name !== undefined) throw new CommandError('invalid_input', 'A note has text, not a name.')
    if ([name, text, at, visible].every((x) => x === undefined)) throw new CommandError('invalid_input', 'Say what to change: name, text, at or visible.')
    const f = useFlat.getState()
    showWorkspace('flat')
    if (element !== undefined) {
      const el = findFlatElement(element)
      if (name !== undefined) {
        // A name is the edit box's to give, as in the panel — and an element
        // that cannot be fitted any more cannot be saved again.
        f.editElement(el.id)
        useFlat.getState().setDraftName(name)
        const saved = useFlat.getState().commitDraft()
        if (useFlat.getState().draft) useFlat.getState().cancelDraft()
        if (saved === null) throw new CommandError('invalid_state', `${el.name} has no fit${el.error ? ` — ${el.error}` : ''}; remove it with flat.remove instead.`)
      }
      if (visible !== undefined && el.visible !== visible) useFlat.getState().toggleElementVisible(el.id)
    } else if (dimension !== undefined) {
      const d = findOnSheet(f.dimensions, dimension, 'dimension')
      if (name !== undefined) {
        f.editDimension(d.id)
        useFlat.getState().setDimName(name)
        useFlat.getState().commitDim()
        if (useFlat.getState().dimDraft) useFlat.getState().cancelDimDraft()
      }
      if (visible !== undefined && d.visible !== visible) useFlat.getState().toggleDimensionVisible(d.id)
    } else if (note !== undefined) {
      const n = findOnSheet(f.notes, note, 'note')
      if (text !== undefined) {
        if (oneLine(text) === '') throw new CommandError('invalid_input', 'A note needs some text — flat.remove takes it away.')
        f.setNoteText(n.id, oneLine(text))
      }
      if (at !== undefined) useFlat.getState().moveNote(n.id, docToPx(f, at))
      if (visible !== undefined && n.visible !== visible) useFlat.getState().toggleNoteVisible(n.id)
    } else {
      const c = findOnSheet(f.counts, count!, 'count')
      if (name !== undefined) f.renameCount(c.id, name)
      if (visible !== undefined && c.visible !== visible) useFlat.getState().toggleCountVisible(c.id)
    }
    return { flat: describeFlat() }
  },
}

const remove: Command<{ elements?: (number | string)[]; dimensions?: (number | string)[]; notes?: number[]; counts?: (number | string)[] }> = {
  name: 'remove',
  title: 'Remove from the 2D sheet',
  description:
    'Remove elements, dimensions, notes and counts from the 2D sheet, each by id or name (a note by id) — all of them or none. An element built on a removed one stays and says it has lost its source, a dimension on one turns invalid; the answer names them. Returns what is left. One undo step.',
  input: obj({
    elements: arr(flatRefSchema('A 2D element.')),
    dimensions: arr(oneOf([int(undefined, { minimum: 1 }), str(undefined, { minLength: 1 })]), 'Dimensions, by id or name.'),
    notes: arr(int(undefined, { minimum: 1 }), 'Notes, by id.'),
    counts: arr(oneOf([int(undefined, { minimum: 1 }), str(undefined, { minLength: 1 })]), 'Counts, by id or name.'),
  }),
  label: () => 'remove from 2D sheet',
  run: async ({ elements = [], dimensions = [], notes = [], counts = [] }) => {
    requireSheet()
    requireFlatFree()
    const f = useFlat.getState()
    // Every name is checked before anything goes, so a typo removes nothing.
    const els = elements.map(findFlatElement)
    const dims = dimensions.map((d) => findOnSheet(f.dimensions, d, 'dimension'))
    const ns = notes.map((n) => findOnSheet(f.notes, n, 'note'))
    const cs = counts.map((c) => findOnSheet(f.counts, c, 'count'))
    if (els.length + dims.length + ns.length + cs.length === 0) throw new CommandError('invalid_input', 'Name something to remove.')
    showWorkspace('flat')
    for (const e of els) useFlat.getState().deleteElement(e.id)
    for (const d of dims) useFlat.getState().deleteDimension(d.id)
    for (const n of ns) useFlat.getState().deleteNote(n.id)
    for (const c of cs) useFlat.getState().deleteCount(c.id)
    const after = useFlat.getState()
    const live = new Set(after.elements.map((e) => e.id))
    return {
      removed: [...els.map((e) => e.name), ...dims.map((d) => d.name), ...ns.map((n) => `note ${n.id}`), ...cs.map((c) => c.name)],
      unfit: after.elements.filter((e) => !e.fit).map((e) => e.name),
      invalidDimensions: after.dimensions.filter((d) => d.refs.some((r) => !live.has(r))).map((d) => d.name),
      flat: describeFlat(),
    }
  },
}

const frameSchema = oneOf(
  [
    obj({ min: spotSchema('The lowest corner.'), max: spotSchema('The highest corner.') }, ['min', 'max'], 'A box on the sheet.'),
    obj(
      {
        at: spotSchema('Its centre.'),
        size: oneOf([num(undefined, { exclusiveMinimum: 0 }), arr(num(undefined, { exclusiveMinimum: 0 }), undefined, { minItems: 2, maxItems: 2 })], 'Its side, or [width, height].'),
      },
      ['at', 'size'],
      'A box round a place.',
    ),
  ],
  'What to picture, in the sheet’s units — the whole sheet by default.',
)

const RENDER_KEYS = ['image', 'edges', 'chains', 'elements', 'dimensions', 'notes', 'labels', 'grid'] as const
type RenderKey = (typeof RENDER_KEYS)[number]

const render: Command<{
  frame?: { min: Vec2; max: Vec2 } | { at: Vec2; size: number | [number, number] }
  width?: number
  height?: number
  show?: Partial<Record<RenderKey, boolean>>
}> = {
  name: 'render',
  title: 'Picture the sheet',
  description:
    'A picture of the 2D sheet as a PNG, as the sheet lies in its own units — +X right, +Y up, whatever the alignment or turns — with a grid and its values along the top and left edges. map says where it lies: picture pixel (column c, row r from the top) is the sheet place [left + c·unitsPerPx, top − r·unitsPerPx]. frame zooms in on a box. show puts layers in or out: image, edges (the detected chains), chains (their numbers), elements (with counts and the alignment), dimensions, notes, labels, grid. 800 px on the long side by default, up to 2048. Needs the browser.',
  input: obj({
    frame: frameSchema,
    width: int('Pixels across, 64 to 2048.', { minimum: 64, maximum: 2048 }),
    height: int('Pixels down, 64 to 2048.', { minimum: 64, maximum: 2048 }),
    show: obj(Object.fromEntries(RENDER_KEYS.map((k) => [k, bool()])), [], 'Layers in (true) or out (false).'),
  }),
  readOnly: true,
  returnsFile: true,
  returnsImage: true,
  scene: true,
  run: async ({ frame, width, height, show }) => {
    const flat = commandHost().flat
    if (!flat || typeof OffscreenCanvas === 'undefined') throw new CommandError('unavailable', 'A picture of the sheet needs the browser.')
    requireSheet()
    if (useFlat.getState().edgeStatus === 'running') await waitFor(() => useFlat.getState().edgeStatus !== 'running', 'the edges to be found')
    const view = flat.sheet()
    if (!view) throw new CommandError('invalid_state', 'The sheet is not laid yet — its section is still being cut.')
    const s = useFlat.getState()
    const on: Record<RenderKey, boolean> = { image: true, edges: s.showEdges, chains: true, elements: true, dimensions: true, notes: true, labels: true, grid: true, ...show }
    const box = !frame
      ? view.bounds
      : 'min' in frame
        ? frame
        : (() => {
            const [w, h] = typeof frame.size === 'number' ? [frame.size, frame.size] : frame.size
            return { min: [frame.at[0] - w / 2, frame.at[1] - h / 2] as Vec2, max: [frame.at[0] + w / 2, frame.at[1] + h / 2] as Vec2 }
          })()
    if (!(box.max[0] > box.min[0] && box.max[1] > box.min[1])) throw new CommandError('invalid_input', 'frame: max must lie above and to the right of min.')
    const { pictureFrame, pictureGridStep, sheetPicturePng } = await import('../../app/flatPicture')
    const pf = pictureFrame(box, width, height)
    const scale = sheetScale(s)
    const bytes = await sheetPicturePng({
      frame: pf,
      image: on.image && view.bitmap ? { bitmap: view.bitmap, scale } : null,
      chains: on.edges ? view.chains : null,
      chainUnit: scale,
      chainIds: on.edges && on.chains,
      elements: on.elements ? sheetElements(s) : [],
      counts: on.elements ? sheetCounts(s) : [],
      datum: on.elements ? sheetFrame(s) : null,
      dimensions: on.dimensions ? sheetDimensions(s) : [],
      notes: on.notes ? sheetNotes(s).filter((n) => n.text.trim() !== '') : [],
      grid: on.grid,
      labels: on.labels,
    })
    return {
      file: { name: `${flatExportStem()}-sheet.png`, mimeType: 'image/png', bytes },
      width: pf.width,
      height: pf.height,
      unit: unitNow(),
      map: { left: pf.left, top: pf.top, unitsPerPx: pf.unitsPerPx },
      ...(on.grid ? { grid: pictureGridStep(pf) } : {}),
    }
  },
}

const edges: Command<{ box?: Box; near?: Vec2; reach?: number; minLength?: number; tolerance?: number; limit?: number }> = {
  name: 'edges',
  title: 'List the detected edges',
  description:
    'The edge chains detected on the sheet, by number — what flat.fit takes as chains. Each with its length, whether it closes, its point count and box, in the sheet’s units; the longest first, or with near the nearest first (each with its nearest point and distance; within reach only, when given). box keeps the chains that enter it, minLength the long ones. tolerance adds each chain’s polyline thinned to that (5000 points at most over all). limit chains at most, 50 by default. Trap: the numbers change when the edges are found again. Changes nothing.',
  input: obj({
    box: boxSchema('Only chains with a point in this box.'),
    near: spotSchema('Nearest this place first.'),
    reach: num('With near: only chains this close.', { exclusiveMinimum: 0 }),
    minLength: num('Only chains at least this long.', { minimum: 0 }),
    tolerance: num('Add each chain’s polyline, thinned to this.', { exclusiveMinimum: 0 }),
    limit: int('Chains at most — 50 by default.', { minimum: 1, maximum: 2000 }),
  }),
  readOnly: true,
  run: async ({ box, near, reach, minLength, tolerance, limit }) => {
    const { chains, kind } = await settledEdges()
    const unit = sheetScale(useFlat.getState())
    // A traced loop ends a pixel or so from where it began; a section's
    // loop repeats its first point.
    const closeGap = kind === 'image' ? 2 : 1e-9
    const rows: (ReturnType<typeof chainSummary> & { nearest?: { at: Vec2; distance: number } })[] = []
    for (let c = 0; c < chainTotal(chains); c++) {
      const sum = chainSummary(chains, c, unit, closeGap)
      if (minLength !== undefined && sum.length < minLength) continue
      if (box && (sum.box.max[0] < box.min[0] || sum.box.min[0] > box.max[0] || sum.box.max[1] < box.min[1] || sum.box.min[1] > box.max[1] || !chainEnters(chains, c, unit, box))) continue
      if (near) {
        const nearest = chainNearest(chains, c, unit, near)
        if (reach !== undefined && nearest.distance > reach) continue
        rows.push({ ...sum, nearest })
      } else rows.push(sum)
    }
    rows.sort(near ? (a, b) => a.nearest!.distance - b.nearest!.distance : (a, b) => b.length - a.length)
    const listed = rows.slice(0, limit ?? 50)
    let budget = 5000
    let thinnedOut = 0
    return {
      chains: chainTotal(chains),
      matched: rows.length,
      unit: unitNow(),
      items: listed.map((row) => {
        let polyline: Vec2[] | undefined
        if (tolerance !== undefined) {
          const line = chainPolyline(chains, row.id, unit, tolerance)
          if (line.length <= budget) {
            polyline = line
            budget -= line.length
          } else thinnedOut++
        }
        return { ...row, ...(polyline ? { polyline } : {}) }
      }),
      ...(thinnedOut ? { polylinesLeftOut: thinnedOut } : {}),
    }
  },
}

/** The parts the last flat.objects found, kept for flat.profile to take an
 *  outline from — with the image they were found on (its grey levels, a
 *  buffer each image has its own) and the scale they were measured at, so
 *  a new image or a new calibration is not mistaken for the old. */
let lastObjects: { gray: Uint8Array; scale: string; objects: FlatObject[] } | null = null
const scaleKey = () => {
  const px = useFlat.getState().pxPerMm
  return px ? `${px.x}:${px.y}` : 'px'
}

const deg = (rad: number) => (rad * 180) / Math.PI

const objects: Command<{ threshold?: number; dark?: boolean; minArea?: number; outline?: number; limit?: number }> = {
  name: 'objects',
  title: 'Find the parts on the image',
  description:
    'The separate parts on the flatbed image, parted from the background by a grey level (Otsu’s unless threshold is given) and numbered in reading order — what flat.profile takes by number. Returns each with area, holes, box, centroid, equivalentDiameter, feret (largest and smallest caliper widths with their directions), axisAngle, chains (the edge chains along its outline) and, with outline, its polygon. Trap: minArea drops smaller ones, 1 mm² by default. Changes nothing.',
  input: obj({
    threshold: int('Grey level, 0 to 255.', { minimum: 0, maximum: 255 }),
    dark: bool('The parts are darker than the background.'),
    minArea: num('The smallest part, in the sheet’s units squared.', { minimum: 0 }),
    outline: num('Add each outline, thinned to this, in the sheet’s units.', { exclusiveMinimum: 0 }),
    limit: int('Parts at most — 100 by default.', { minimum: 1, maximum: 1000 }),
  }),
  readOnly: true,
  run: async ({ threshold, dark, minArea, outline, limit }) => {
    const flat = commandHost().flat
    if (!flat) throw new CommandError('unavailable', 'Finding the parts needs the browser.')
    requireSheet()
    const g = flat.gray()
    if (!g) throw new CommandError('invalid_state', 'Parts are found on an image; a section’s outlines are its edge chains — flat.edges.')
    const s = useFlat.getState()
    const scale = sheetScale(s)
    const { findObjects } = await import('../../core/flat/objects')
    const found = findObjects(g.gray, g.width, g.height, {
      threshold,
      dark,
      minArea: minArea ?? (s.pxPerMm ? 1 : (600 / 25.4) ** 2),
      scale,
    })
    lastObjects = { gray: g.gray, scale: scaleKey(), objects: found.objects }
    const along = outlineChains(found, flat.sheet()?.chains ?? null, scale)
    return {
      threshold: found.threshold,
      dark: found.dark,
      unit: unitNow(),
      found: found.objects.length,
      objects: found.objects.slice(0, limit ?? 100).map((o, i) => ({
        id: i + 1,
        area: o.area,
        holes: o.holes,
        box: o.box,
        centroid: o.centroid,
        equivalentDiameter: o.equivalentDiameter,
        feret: { max: o.feret.max, maxAngle: deg(o.feret.maxAngle), min: o.feret.min, minAngle: deg(o.feret.minAngle) },
        axisAngle: deg(o.axisAngle),
        chains: along[i],
        ...(outline !== undefined ? { outline: thinOutline(o.outline, outline) } : {}),
      })),
    }
  },
}

/** The edge chains along each part's outline, longest first, six at most:
 *  a chain belongs to the part whose material most of its points lie on or
 *  beside — an edge runs between a part and the background, so each point
 *  is looked for a pixel and a half either way. */
function outlineChains(found: FlatObjects, chains: EdgeChains | null, scale: { x: number; y: number }): number[][] {
  const out: { id: number; length: number }[][] = found.objects.map(() => [])
  if (!chains) return out.map(() => [])
  const dx = 1.5 * scale.x
  const dy = 1.5 * scale.y
  for (let c = 0; c < chainTotal(chains); c++) {
    const [from, to] = [chains.offsets[c], chains.offsets[c + 1]]
    if (to - from < 8) continue
    const samples = Math.min(12, to - from)
    const votes = new Map<number, number>()
    for (let k = 0; k < samples; k++) {
      const i = from + Math.floor(((to - from - 1) * k) / Math.max(1, samples - 1))
      const x = chains.points[i * 2] * scale.x
      const y = chains.points[i * 2 + 1] * scale.y
      const spots: Vec2[] = [[x, y], [x + dx, y], [x - dx, y], [x, y + dy], [x, y - dy]]
      const hit = spots.map((p) => found.objectAt(p[0], p[1])).find((j) => j >= 0)
      if (hit !== undefined) votes.set(hit, (votes.get(hit) ?? 0) + 1)
    }
    const [best, n] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0] ?? [-1, 0]
    if (best >= 0 && n >= 0.6 * samples) out[best].push({ id: c, length: chainSummary(chains, c, scale, 2).length })
  }
  return out.map((list) => list.sort((a, b) => b.length - a.length).slice(0, 6).map((x) => x.id))
}

/** A closed outline (flattened x,y) thinned to a tolerance, as [x, y]
 *  pairs. */
function thinOutline(outline: ArrayLike<number>, tolerance: number): Vec2[] {
  const n = outline.length / 2
  // Thinned as a run that comes back to its start: the first point repeated
  // at the end, then dropped again from the answer.
  const ring = new Float64Array(outline.length + 2)
  ring.set(Array.from(outline))
  ring[outline.length] = outline[0]
  ring[outline.length + 1] = outline[1]
  return simplifyRun(ring, 0, n + 1, tolerance)
    .slice(0, -1)
    .map((i) => [ring[i * 2], ring[i * 2 + 1]])
}

/** The centre and long axis of a cloud of outline points. */
function ownAxes(points: readonly Vec2[]): { centroid: Vec2; axisAngle: number } {
  let sx = 0, sy = 0
  for (const p of points) {
    sx += p[0]
    sy += p[1]
  }
  const cx = sx / points.length
  const cy = sy / points.length
  let xx = 0, yy = 0, xy = 0
  for (const p of points) {
    xx += (p[0] - cx) ** 2
    yy += (p[1] - cy) ** 2
    xy += (p[0] - cx) * (p[1] - cy)
  }
  return { centroid: [cx, cy], axisAngle: 0.5 * Math.atan2(2 * xy, xx - yy) }
}

const profile: Command<{
  object?: number
  chains?: number[]
  about?: number | string
  axis?: 'radial' | 'axial'
  samples?: number
  prominence?: number
  mark?: boolean
  points?: boolean
}> = {
  name: 'profile',
  title: 'Profile an outline and count its peaks',
  description:
    'An outline read against a centre (radial, the default: a part seen from above) or along an axis (axial: a part lying on its side, each side apart), and its peaks counted — the teeth of a knurl or a gear. The outline is an object of the last flat.objects by number, or edge chains by number; about is the element it is read about, else the outline’s own centre or long axis. Returns per side the count, pitch, envelope (max, min, mean peak, mean valley; radial also as diameters) and every peak’s position; points adds the sampled profile. Trap: a peak must stand prominence above the higher valley either side (0.3 of the profile’s spread by default). mark: true puts a count on the sheet — one undo step; otherwise nothing changes.',
  input: obj({
    object: int('An object of the last flat.objects, by number.', { minimum: 1 }),
    chains: chainIdsSchema('Edge chains by number, as one outline.'),
    about: flatRefSchema('A circle, arc or point (radial), or a line (axial).'),
    axis: enumOf(['radial', 'axial'] as const, 'Without about: radial about the outline’s centre (the default), or axial along its long axis.'),
    samples: int('Bins round the turn or along the axis; from the point count by default.', { minimum: 16, maximum: 20000 }),
    prominence: num('How far a peak must stand out, sheet units.', { exclusiveMinimum: 0 }),
    mark: bool('Put a count on every peak.'),
    points: bool('Add the sampled profile.'),
  }),
  label: ({ mark }) => (mark ? 'mark profile peaks' : 'profile'),
  run: async ({ object, chains, about, axis, samples, prominence, mark, points }) => {
    requireSheet()
    if (mark) requireFlatFree()
    if ((object === undefined) === (chains === undefined)) throw new CommandError('invalid_input', 'Give the outline: object, or chains.')
    const s = useFlat.getState()
    const scale = sheetScale(s)
    let outline: ArrayLike<number>
    let own: { centroid: Vec2; axisAngle: number }
    let label: string
    if (object !== undefined) {
      if (!lastObjects || lastObjects.gray !== commandHost().flat?.gray()?.gray || lastObjects.scale !== scaleKey()) {
        throw new CommandError('invalid_state', 'Find the parts with flat.objects first — on this image, at this scale.')
      }
      const o = lastObjects.objects[object - 1]
      if (!o) throw new CommandError('not_found', `There is no object ${object} — flat.objects found ${lastObjects.objects.length}.`)
      outline = o.outline
      own = { centroid: o.centroid, axisAngle: o.axisAngle }
      label = `object ${object}`
    } else {
      const { chains: all } = await settledEdges()
      checkChains(all, chains!)
      const pts = chains!.flatMap((c) => chainPoints(all, c, scale))
      outline = Float64Array.from(pts.flat())
      own = ownAxes(pts)
      label = `chain${chains!.length > 1 ? 's' : ''} ${chains!.join(', ')}`
    }
    let around: ProfileAbout
    if (about !== undefined) {
      const el = findFlatElement(about)
      const f = el.fit
      if (!f) throw new CommandError('invalid_state', `${el.name} has no fit${el.error ? ` — ${el.error}` : ''}.`)
      if (f.kind === 'circle' || f.kind === 'arc') around = { kind: 'radial', center: f.center }
      else if (f.kind === 'point') around = { kind: 'radial', center: f.at }
      else if (f.kind === 'line') around = { kind: 'axial', origin: f.center, dir: f.dir }
      else throw new CommandError('invalid_input', 'about takes a circle, an arc or a point (radial), or a line (axial).')
      if (axis && axis !== around.kind) throw new CommandError('invalid_input', `${el.name} is a ${el.kind}: it reads ${around.kind}.`)
    } else {
      around =
        axis === 'axial'
          ? { kind: 'axial', origin: own.centroid, dir: [Math.cos(own.axisAngle), Math.sin(own.axisAngle)] }
          : { kind: 'radial', center: own.centroid }
    }
    // The outline's own noise: a pixel and a half of an image's, a hundredth
    // of a millimetre of a section's cut.
    const floor = s.subject.kind === 'image' ? 1.5 * Math.max(scale.x, scale.y) : 0.01
    const { outlineProfile } = await import('../../core/flat/profile')
    const prof = outlineProfile(outline, around, { samples, prominence, floor })
    const radial = prof.kind === 'radial'
    const sides = prof.sides.map((side, i) => ({
      ...(radial ? {} : { side: i === 0 ? 'left' : 'right' }),
      count: side.peaks.length,
      pitch: side.pitch === null ? null : radial ? deg(side.pitch) : side.pitch,
      envelope: { max: side.max, min: side.min, peakMean: side.peakMean, valleyMean: side.valleyMean },
      ...(radial
        ? {
            diameter: {
              max: 2 * side.max,
              peaks: side.peakMean === null ? null : 2 * side.peakMean,
              valleys: side.valleyMean === null ? null : 2 * side.valleyMean,
            },
          }
        : {}),
      peaks: side.peaks.map((p) => (radial ? { angle: deg(p.position), at: p.at } : { position: p.position, at: p.at })),
      ...(points ? { samples: everyKth(side.samples, 720).map(([pos, v]) => [radial ? deg(pos) : pos, v]) } : {}),
    }))
    const marked: string[] = []
    if (mark) {
      showWorkspace('flat')
      prof.sides.forEach((side, i) => {
        if (side.peaks.length === 0) return
        const id = useFlat.getState().nextCountId
        useFlat.getState().startCount()
        for (const p of side.peaks) useFlat.getState().addCountPick(docToPx(useFlat.getState(), p.at))
        useFlat.getState().finishCount()
        const name = `Peaks, ${label}${radial ? '' : i === 0 ? ', left' : ', right'}`
        useFlat.getState().renameCount(id, name)
        marked.push(name)
      })
    }
    return {
      outline: label,
      about: around.kind === 'radial' ? { radial: around.center } : { axial: { origin: around.origin, dir: around.dir } },
      unit: unitNow(),
      prominence: prof.prominence,
      sides,
      ...(mark ? { counts: marked } : {}),
    }
  },
}

/** At most `cap` of a list, every k-th, the last kept. */
function everyKth<T>(list: readonly T[], cap: number): T[] {
  if (list.length <= cap) return [...list]
  const k = Math.ceil(list.length / cap)
  return list.filter((_, i) => i % k === 0 || i === list.length - 1)
}

const report: Command = {
  name: 'report',
  title: 'Get the 2D report',
  description: 'The 2D Measure report as its Copy button gives it: the image or section, the scale it rests on, the alignment, every element, dimension, count and note.',
  input: obj({}),
  readOnly: true,
  run: async () => {
    requireSheet()
    return { text: buildFlatReport(flatReportInput()) }
  },
}

export const flatCommands = [openImage, calibrate, setAlignment, detectEdges, fit, dimensionAdd, noteAdd, edit, remove, render, edges, objects, profile, report]

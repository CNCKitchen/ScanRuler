// SPDX-License-Identifier: AGPL-3.0-only
// The 2D Measure workspace's data and the pure rules over it: what a sheet
// holds and the scale it rests on, the draft an element is fitted in, the
// tools in hand, the counts and notes. The state and its actions are
// flatStore's, which re-exports these.

import { FitError } from '../core/fit/errors'
import { flatMethod } from '../core/flat/construct'
import type { FlatDatum } from '../core/flat/datum'
import type { FlatDimension, FlatDimensionGroup } from '../core/flat/dimensions'
import { evaluateFlatSource, flatDependentsOf, type FlatElement, flatPicksReady, type FlatSource } from '../core/flat/elements'
import type { PixelsPerMm } from '../core/flat/image'
import type { FlatElementKind, FlatFit, Vec2 } from '../core/flat/types'
import { PALETTE } from './palette'

/** What the numbers on screen rest on. `metadata` is the file's own claim —
 *  honest to measure with, nominal until verified; `measured` is a
 *  calibration taken against a reference; `none` is bare pixels; `section`
 *  is a cut through the 3D scan, whose sheet is millimetres by construction. */
export type CalSource = 'none' | 'metadata' | 'measured' | 'section'

/** What lies on the sheet: the flatbed image, or a section cut through the
 *  3D scan — see state/store's Section. One at a time: they lie in different
 *  planes and have nothing to say to each other. */
export type FlatSubject = { kind: 'image' } | { kind: 'section'; id: number }

/** The key a subject's sheet is stashed under while another is on the stage. */
export function sheetKeyOf(subject: FlatSubject): string {
  return subject.kind === 'image' ? 'image' : `section:${subject.id}`
}

export function subjectFromKey(key: string): FlatSubject {
  return key.startsWith('section:') ? { kind: 'section', id: Number(key.slice(8)) } : { kind: 'image' }
}

export type CalMode = 'distance' | 'diameter'

export interface CalibrationProfile {
  name: string
  pxPerMm: PixelsPerMm
}

/** A flat element being built: picks and references accumulate, and the fit
 *  (or the reason there is none) follows every change. Picks are image
 *  pixels, like the elements' own sources. An edit is the same draft with
 *  `editId` set — it writes back over that element instead of adding one. */
export interface FlatDraft {
  kind: FlatElementKind
  method: string
  picks: Vec2[]
  /** A spline's tangent handles, one per pick: the offset (image pixels)
   *  from the pick to the end the curve leaves along, or null while the
   *  tangent there is automatic. Empty for every other kind. */
  tangents: (Vec2 | null)[]
  /** A spline that closes on itself. */
  closed: boolean
  refs: (number | null)[]
  fit: FlatFit | null
  error: string | null
  editId?: number
  /** The name as typed while editing; blank keeps the old one. */
  name?: string
}

/** A tally taken by clicking features one after another — the teeth of a
 *  gear, the holes in a flange. The picks (image pixels) are the count; they
 *  stay numbered on the sheet so the tally can be checked against the part. */
export interface FlatCount {
  id: number
  name: string
  color: string
  picks: Vec2[]
  visible: boolean
}

/** A free text label pinned to the sheet — a remark, a part number, a
 *  reading taken elsewhere. `at` is image pixels, like every other pick, so
 *  a recalibration carries the note with the feature it sits on. */
export interface FlatNote {
  id: number
  text: string
  at: Vec2
  visible: boolean
}

/** A dimension being assembled — or re-opened, with `editId` set. */
export interface FlatDimDraft {
  type: string
  refs: (number | null)[]
  editId?: number
  name?: string
}

/** The stage tool in hand — the one thing a click on the sheet goes to
 *  before the element draft gets it. Exactly one is ever out: arming any of
 *  them puts the others away, which is why they are one value and not five
 *  flags keeping each other false.
 *
 *  - `calibrate`: collecting picks (image pixels) against a reference size.
 *  - `datum`: the alignment tool, holding the origin until the +X pick lands.
 *  - `count`: a tally being clicked out; `editId` when a finished one was
 *    re-opened to count on.
 *  - `note`: the Text tool — armed to place (`editId` null), or a note's
 *    text open in the panel. */
export type FlatTool =
  | { kind: 'none' }
  | { kind: 'calibrate'; mode: CalMode; picks: Vec2[] }
  | { kind: 'datum'; picks: Vec2[] }
  | { kind: 'count'; picks: Vec2[]; editId?: number }
  | { kind: 'note'; editId: number | null }

export const NO_TOOL: FlatTool = { kind: 'none' }

type ToolOf<K extends FlatTool['kind']> = Extract<FlatTool, { kind: K }>

/** The tool if it is the one asked for, else null — `toolOf(s, 'count')`
 *  reads like the old `s.counting` and narrows the same way. */
export function toolOf<K extends FlatTool['kind']>(
  s: { tool: FlatTool },
  kind: K,
): ToolOf<K> | null {
  return s.tool.kind === kind ? (s.tool as ToolOf<K>) : null
}

/** Whether the box holds work a second editor would throw away: an edit,
 *  picks, a reference filled. A kind merely in hand — the empty draft
 *  Create leaves behind for the next one — holds nothing, so neither the
 *  row keys nor undo stand down for it. */
export function flatDraftHolds(d: FlatDraft | null): boolean {
  return d !== null && (d.editId !== undefined || d.picks.length > 0 || d.refs.some((r) => r !== null))
}

/** Whether anything is being assembled — a stage tool, an element or a
 *  dimension draft — so the row keys that would re-open a second thing
 *  stand down. The datum and calibration tools do not count: their editors
 *  live in their own groups and do not fight the element list. Nor does a
 *  kind merely in hand, with nothing in its box yet. */
export function flatEditorOpen(s: {
  tool: FlatTool
  draft: FlatDraft | null
  dimDraft: FlatDimDraft | null
}): boolean {
  return (
    flatDraftHolds(s.draft) || s.dimDraft !== null || s.tool.kind === 'count' || s.tool.kind === 'note'
  )
}

/** Elements an edited draft must not reference: itself and everything
 *  constructed on it, which would close a loop. */
export function flatBlockedRefs(editId: number | undefined, elements: readonly FlatElement[]): Set<number> {
  return editId === undefined ? new Set() : flatDependentsOf(editId, elements)
}

/** The colour the open draft draws in: the edited element's own, or the one
 *  the next element will get. */
export function flatDraftColorOf(s: {
  draft: FlatDraft | null
  elements: readonly FlatElement[]
  nextId: number
}): string {
  const el = s.draft?.editId === undefined ? undefined : s.elements.find((e) => e.id === s.draft!.editId)
  return el?.color ?? PALETTE[(s.nextId - 1) % PALETTE.length]
}

/** The colour a tally wears — offset into the palette so the first count
 *  does not match the first element. */
export function flatCountColor(id: number): string {
  return PALETTE[(id + 3) % PALETTE.length]
}

export function freshDraft(kind: FlatElementKind, method: string, edit?: Pick<FlatDraft, 'editId' | 'name'>): FlatDraft {
  return {
    kind,
    method,
    picks: [],
    tangents: [],
    closed: false,
    refs: new Array<number | null>(flatMethod(method).slots?.length ?? 0).fill(null),
    fit: null,
    error: null,
    ...edit,
  }
}

/** The handles kept one per pick: those that exist stay, the rest are
 *  automatic. */
export function tangentsFor(count: number, tangents: readonly (Vec2 | null)[]): (Vec2 | null)[] {
  return Array.from({ length: count }, (_, i) => tangents[i] ?? null)
}

/** A pick-mode draft as the source it is recorded with: a spline's handles
 *  and closure ride along, nothing else carries them. */
export function pickSource(draft: Pick<FlatDraft, 'kind' | 'method' | 'picks' | 'tangents' | 'closed'>): FlatSource {
  return draft.kind === 'spline'
    ? { type: 'picks', method: draft.method, picks: draft.picks, tangents: draft.tangents, closed: draft.closed }
    : { type: 'picks', method: draft.method, picks: draft.picks }
}

/** Put a tool away — only if it is the one in hand, so a stale cancel from
 *  a tool that was already replaced does not knock out its successor. */
export function putAway(s: { tool: FlatTool }, kind: FlatTool['kind']): { tool: FlatTool } | Record<string, never> {
  return s.tool.kind === kind ? { tool: NO_TOOL } : {}
}

/** A spot on the sheet (document units) as image pixels — the frame every
 *  pick is stored in, so a recalibration moves the measurements and not
 *  the picks. Bare pixels draw at 1 px per unit. */
export function docToPx(s: { pxPerMm: PixelsPerMm | null }, spot: Vec2): Vec2 {
  return s.pxPerMm ? [spot[0] * s.pxPerMm.x, spot[1] * s.pxPerMm.y] : [spot[0], spot[1]]
}

/** The draft's fit, following every change: null-and-no-error while picks or
 *  slots are still missing, null-with-reason when the geometry refuses. */
export function evaluateDraft(
  draft: Pick<FlatDraft, 'kind' | 'method' | 'picks' | 'tangents' | 'closed' | 'refs'>,
  elements: readonly FlatElement[],
  pxPerMm: PixelsPerMm | null,
): { fit: FlatFit | null; error: string | null } {
  const m = flatMethod(draft.method)
  try {
    if (m.mode !== 'construct') {
      if (!flatPicksReady(draft.method, draft.picks, draft.closed)) return { fit: null, error: null }
      return { fit: evaluateFlatSource(pickSource(draft), pxPerMm, () => null), error: null }
    }
    const slots = m.slots?.length ?? 0
    if (draft.refs.length < slots || draft.refs.some((r) => r === null)) {
      return { fit: null, error: null }
    }
    return {
      fit: evaluateFlatSource(
        { type: 'construct', method: draft.method, refs: draft.refs as number[] },
        pxPerMm,
        (id) => elements.find((e) => e.id === id)?.fit ?? null,
      ),
      error: null,
    }
  } catch (e) {
    if (e instanceof FitError) return { fit: null, error: e.message }
    throw e
  }
}

/** Per-kind name counters: "Circle 3" is the third circle ever made this
 *  session, and deletions never make a name come back to mean something new. */
type NameCounts = Partial<Record<FlatElementKind, number>>

/**
 * The measuring state that belongs to one subject: everything picked,
 * fitted, dimensioned, counted or written on its sheet, and the scale it is
 * read at. The image and every section each have one; the one on the stage
 * lives in the store's own fields, the others wait in `sheets` under their
 * key and come back exactly as they were left.
 */
export interface SheetState {
  pxPerMm: PixelsPerMm | null
  calSource: CalSource
  elements: FlatElement[]
  nextId: number
  nameCounts: NameCounts
  dimensions: FlatDimension[]
  nextDimId: number
  dimCounts: Partial<Record<FlatDimensionGroup, number>>
  datum: FlatDatum | null
  counts: FlatCount[]
  nextCountId: number
  notes: FlatNote[]
  nextNoteId: number
  /** Quarter turns the sheet is shown at, counter-clockwise on screen —
   *  0 to 3. A way of looking that belongs to the sheet: a scan lies on the
   *  glass one way, a section is laid flat another, and each wants turning
   *  by its own amount. Nothing measured moves with it. */
  turns: number
  /** Whether the sheet is shown mirrored — flipped across the alignment's X
   *  axis (the document's own, unaligned) before the quarter turns; see
   *  core/flat/datum's SheetPose. A scan is the part seen through the
   *  glass, and this is how it is looked at from above. Nothing measured
   *  moves with it either; the alignment reads right-handed as shown. */
  mirror: boolean
}

/** The sheet on the stage, lifted out of the store. */
export function sheetOf(s: SheetState): SheetState {
  return {
    pxPerMm: s.pxPerMm,
    calSource: s.calSource,
    elements: s.elements,
    nextId: s.nextId,
    nameCounts: s.nameCounts,
    dimensions: s.dimensions,
    nextDimId: s.nextDimId,
    dimCounts: s.dimCounts,
    datum: s.datum,
    counts: s.counts,
    nextCountId: s.nextCountId,
    notes: s.notes,
    nextNoteId: s.nextNoteId,
    turns: s.turns,
    mirror: s.mirror,
  }
}

/** An empty sheet at the given scale. A section's is millimetres by
 *  construction; an image's is whatever the file or the scanner says. */
export function freshSheet(pxPerMm: PixelsPerMm | null, calSource: CalSource): SheetState {
  return {
    pxPerMm,
    calSource,
    elements: [],
    nextId: 1,
    nameCounts: {},
    dimensions: [],
    nextDimId: 1,
    dimCounts: {},
    datum: null,
    counts: [],
    nextCountId: 1,
    notes: [],
    nextNoteId: 1,
    turns: 0,
    mirror: false,
  }
}

export const freshSectionSheet = () => freshSheet({ x: 1, y: 1 }, 'section')

/** What putting a sheet on the stage clears besides the sheet itself: the
 *  editors and the tool, which belonged to the sheet that was there. */
export const STAGE_CLEARED = {
  selectedElementIds: [] as number[],
  draft: null,
  dimDraft: null,
  tool: NO_TOOL,
  edgeStatus: 'idle' as const,
  edgeCount: 0,
}

/** The image sheet's px/mm along X, wherever that sheet is — on the stage or
 *  stashed behind a section. What the edge detector sizes its minimum
 *  feature by, since it only ever runs on the image. */
export function imageScaleX(s: { subject: FlatSubject; pxPerMm: PixelsPerMm | null; sheets: Record<string, SheetState> }): number | null {
  const sheet = s.subject.kind === 'image' ? s : s.sheets.image
  return sheet?.pxPerMm?.x ?? null
}

const NO_ELEMENTS: readonly FlatElement[] = []

/** The elements measured on a section's sheet, wherever that sheet is — on
 *  the stage or stashed behind another subject — and none for a section
 *  nothing has been measured on. What the 3D viewport draws beside a
 *  section's cut and the STEP export writes under its name read from here;
 *  the sheet stays the truth, in sheet millimetres. */
export function sectionElementsOf(
  s: { subject: FlatSubject; elements: FlatElement[]; sheets: Record<string, SheetState> },
  id: number,
): readonly FlatElement[] {
  if (s.subject.kind === 'section' && s.subject.id === id) return s.elements
  return s.sheets[sheetKeyOf({ kind: 'section', id })]?.elements ?? NO_ELEMENTS
}

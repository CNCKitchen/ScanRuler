// SPDX-License-Identifier: AGPL-3.0-only
// The 2D Measure workspace's state: the loaded scan image, the scale in force
// and where it came from, and the named scanner profiles that scale can be
// kept under. The decoded bitmap itself lives in a ref owned by App — the
// same rule that keeps meshes and fields out of the other stores — and
// `imageVersion` is how everyone else learns a new one has landed.
//
// Profiles are the one thing this app persists: a calibration that had to be
// redone every reload would not be a profile. A tiny versioned JSON blob in
// localStorage, read once at startup, written through on every change.

import { create } from 'zustand'
import { distanceCalibration, diameterCalibration } from '../core/flat/calibration'
import { collectsEdgePoints, flatConstructRefs, flatMethod, flatSlotRole } from '../core/flat/construct'
import { FLAT_ROLE_PROVIDERS } from '../core/flat/refs'
import {
  evaluateFlatElements,
  flatPicksNeeded,
  FLAT_KIND_LABELS,
  type FlatElement,
  type FlatSource,
} from '../core/flat/elements'
import {
  FLAT_DIMENSION_TYPES,
  evaluateFlatDimension,
  flatDimensionTypeInfo,
  type FlatDimension,
} from '../core/flat/dimensions'
import { FitError } from '../core/fit/errors'
import { growFromSeed } from '../core/flat/grow'
import type { PixelsPerMm } from '../core/flat/image'
import { elementNear, nearestCenter, snapPick, snapRadiusPx, thinEdgePoints, type EdgeIndex, type PickMeta } from '../core/flat/snap'
import { nearestSplineSegment, type HandleEnd } from '../core/flat/spline'
import type { FlatElementKind, FlatFit, Vec2 } from '../core/flat/types'
import { PALETTE } from './palette'
import { type CalibrationProfile, type CalMode, type CalSource, docToPx, evaluateDraft, flatBlockedRefs, type FlatCount, flatCountColor, type FlatDimDraft, type FlatDraft, flatDraftHolds, type FlatSubject, type FlatTool, freshDraft, freshSectionSheet, freshSheet, NO_TOOL, pickSource, putAway, sheetKeyOf, sheetOf, type SheetState, STAGE_CLEARED, tangentsFor, toolOf } from './flatModel'
export { type CalibrationProfile, type CalMode, type CalSource, flatBlockedRefs, type FlatCount, flatCountColor, type FlatDimDraft, type FlatDraft, flatDraftColorOf, flatDraftHolds, flatEditorOpen, type FlatNote, type FlatSubject, type FlatTool, imageScaleX, sectionElementsOf, sheetKeyOf, sheetOf, type SheetState, subjectFromKey, toolOf } from './flatModel'

export type { HandleEnd }

const PROFILE_KEY = 'scanruler.flat.profiles.v1'

function loadProfiles(): CalibrationProfile[] {
  try {
    const raw = localStorage.getItem(PROFILE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (p): p is CalibrationProfile =>
        typeof p === 'object' &&
        p !== null &&
        typeof (p as CalibrationProfile).name === 'string' &&
        typeof (p as CalibrationProfile).pxPerMm?.x === 'number' &&
        typeof (p as CalibrationProfile).pxPerMm?.y === 'number',
    )
  } catch {
    return []
  }
}

function storeProfiles(profiles: CalibrationProfile[]): void {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profiles))
  } catch {
    // Storage full or blocked — the profiles still work for this session.
  }
}

/** The centre a pick at `spot` (document units) snaps to, in image pixels
 *  like every pick — of a shown circle, arc or point within the snap
 *  radius — or null. The element being edited is left out: its picks would
 *  otherwise be drawn onto its own centre. */
function centerNear(
  s: Pick<FlatState, 'elements' | 'draft' | 'pxPerMm'>,
  spot: Vec2,
  meta: Pick<PickMeta, 'unitsPerScreenPx'>,
): Vec2 | null {
  const editId = s.draft?.editId
  const fits = s.elements.flatMap((e) => (e.visible && e.fit && e.id !== editId ? [e.fit] : []))
  const at = nearestCenter(spot, fits, 10 * meta.unitsPerScreenPx)
  return at && docToPx(s, at)
}

interface FlatState extends SheetState {
  imageName: string | null
  /** Pixel dimensions of the loaded image. */
  imageWidth: number
  imageHeight: number
  imageBusy: boolean
  /** Bumped when a fresh bitmap has landed in App's ref. */
  imageVersion: number
  /** Pixels per mm as declared by the file's metadata, or null when the file
   *  carried none. Kept apart from the scale in force, so the panel can say
   *  what the file claims even after a measurement overrides it. */
  metaPxPerMm: PixelsPerMm | null

  /** Edge detection over the loaded image: computed once per image in a
   *  worker, re-run when the sensitivity moves. The chains themselves live in
   *  a ref beside the bitmap; this is the status, the count for the panel,
   *  and a version to redraw off. */
  edgeStatus: 'idle' | 'running' | 'ready'
  edgeCount: number
  edgeVersion: number
  /** 0…1 — how faint an edge may be and still count. */
  edgeSensitivity: number
  showEdges: boolean
  /** Hand picks — placed or dragged — land on the nearest detected edge
   *  rather than where the cursor was. Off, the cursor is the measurement;
   *  Alt inverts either way for one pick. */
  snapToEdge: boolean

  /** What is on the sheet — see FlatSubject. The image is the default; a
   *  section made in the 3D workspace can be put on instead. */
  subject: FlatSubject
  /** Bumped whenever the subject changes, so the viewport lays a new sheet. */
  subjectVersion: number
  /** The other subjects' sheets, as they were left — keyed by sheetKeyOf. */
  sheets: Record<string, SheetState>
  /** Put a subject on the stage: the one there is stashed with everything
   *  measured on it, and the new one's sheet comes back as it was, or fresh. */
  setSubject: (subject: FlatSubject) => void
  /** The sections that still exist: the sheets of any others are dropped,
   *  and a subject among them gives way to the image. */
  dropSections: (liveIds: readonly number[]) => void

  /** Calibrate X and Y separately — scanner transports err per axis. */
  splitAxes: boolean

  /** The stage tool in hand, if any — see FlatTool. */
  tool: FlatTool

  /** A click on the sheet, in document units, routed to whichever tool is
   *  collecting — the stage tool first, then the element draft. Snapping to
   *  a detected edge is decided here: calibration and datum picks always
   *  snap, count and element picks follow `snapToEdge`, a note never does;
   *  Alt inverts the setting for the one pick. `edges` is the index over the
   *  detected chains, or null before any were found. */
  stageClick: (spot: Vec2, meta: PickMeta, edges: EdgeIndex | null) => void
  /** A draft pin dragged to a new spot — snapping the same way a pick does. */
  stageDrag: (index: number, spot: Vec2, meta: PickMeta, edges: EdgeIndex | null) => void
  /** A click on the sheet while a construction or a dimension is being
   *  assembled: the element under it fills the next open slot that takes
   *  it, or comes out of the slot it already holds. */
  clickSlotElement: (spot: Vec2, meta: PickMeta) => void
  /** One end of a spline draft's tangent handle dragged to a spot on the
   *  sheet (document units): the tangent at that pick is fixed along it.
   *  Never snapped — a tangent is a direction, not a place on an edge. */
  stageHandleDrag: (index: number, end: HandleEnd, spot: Vec2, meta: PickMeta) => void
  /** A dragged region over the edge overlay: every detected edge point inside
   *  it joins the draft, thinned to a sane count. */
  stageRegion: (min: Vec2, max: Vec2, edges: EdgeIndex | null) => void
  /** A note dragged across the sheet — where it landed, in document units. */
  stageNoteDrag: (id: number, spot: Vec2) => void
  /** The action a confirm (Enter, middle click) lands on right now, or null
   *  when nothing pending is ready: the element draft, the tally, the open
   *  note, then the dimension draft. Mirrors the buttons — a confirm lands
   *  only where the button would be enabled. */
  confirmable: () => (() => void) | null
  /** Back out of whatever is pending, outermost first: the stage tool, then
   *  the element draft, then the dimension draft. Returns whether anything
   *  was there to retreat from. */
  retreat: () => boolean

  profiles: CalibrationProfile[]

  /** The one being built. The measured results themselves — elements,
   *  dimensions, datum, counts, notes and the scale — are the SheetState this
   *  store extends: sources are image pixels (millimetres, on a section),
   *  fits are document units, re-derived whenever the scale moves. */
  draft: FlatDraft | null

  startDraft: (kind: FlatElementKind, method: string) => void
  /** Re-open an element: the same box it was created in, its picks or its
   *  references back on the sheet, writing back over it on save. */
  editElement: (id: number) => void
  cancelDraft: () => void
  /** The box emptied and the kind kept in hand, on the same method: what
   *  Create leaves behind for the next element, and Escape's first step on
   *  a new draft with picks in it. Nothing for an edit. */
  restartDraft: () => void
  addDraftPick: (px: Vec2) => void
  /** A pick put into the sequence before the one at `index` — a click on a
   *  spline's curve, between the points it runs between. */
  insertDraftPick: (index: number, px: Vec2) => void
  /** A pick dragged to a new place on the sheet. */
  moveDraftPick: (index: number, px: Vec2) => void
  /** Take one pick back by index. */
  removeDraftPick: (index: number) => void
  /** A plain click on a draft pin. On an open spline with points enough to
   *  close, a click on its first pin closes the curve — the way a sketch's
   *  pen closes a path on the point it started from; any other pin click
   *  takes the pick back. */
  clickDraftPin: (index: number) => void
  /** Fix the tangent at a spline pick along a handle offset (image pixels),
   *  or let it go automatic again with null. */
  setDraftTangent: (index: number, handle: Vec2 | null) => void
  /** Every tangent automatic again. */
  freeDraftTangents: () => void
  /** Whether the spline closes on itself. */
  setDraftClosed: (closed: boolean) => void
  /** A dragged region's worth of edge points, or a click's grown stretch
   *  of them, all at once. */
  addDraftPoints: (px: Vec2[]) => void
  /** A click that collected nothing — no edge under it, or an edge of the
   *  wrong shape — leaves its reason in the draft for the box to show,
   *  until the next change to the draft. */
  noteDraftError: (message: string) => void
  undoDraftPick: () => void
  setDraftRef: (slot: number, id: number | null) => void
  setDraftMethod: (method: string) => void
  setDraftName: (name: string) => void
  /** Turn the draft into an element — or write it back over the one being
   *  edited. Returns the element's id, or null if not ready. */
  commitDraft: () => number | null
  deleteElement: (id: number) => void
  toggleElementVisible: (id: number) => void
  /** Show or hide every element and count at once. */
  setAllElementsVisible: (visible: boolean) => void

  beginImageLoad: (name: string) => void
  finishImageLoad: (name: string, width: number, height: number, meta: PixelsPerMm | null) => void
  imageFailed: () => void

  beginEdges: () => void
  /** A fresh set of chains has landed in App's ref. */
  resolveEdges: (count: number) => void
  failEdges: () => void
  setEdgeSensitivity: (v: number) => void
  setShowEdges: (v: boolean) => void
  setSnapToEdge: (v: boolean) => void

  /** The dimension being built. */
  dimDraft: FlatDimDraft | null

  startDimDraft: () => void
  editDimension: (id: number) => void
  cancelDimDraft: () => void
  setDimType: (type: string) => void
  setDimRef: (slot: number, id: number | null) => void
  setDimName: (name: string) => void
  commitDim: () => void
  deleteDimension: (id: number) => void
  toggleDimensionVisible: (id: number) => void
  /** Show or hide every dimension at once. */
  setAllDimensionsVisible: (visible: boolean) => void

  /** The grid along the alignment's axes over the sheet — a way of looking,
   *  kept across subjects. (The alignment itself is the sheet's.) */
  showGrid: boolean

  /** The alignment — "datum" in the code, the part's own frame on the sheet.
   *  Once it lands the stage rolls the sheet so its +X runs to the right. */
  startDatum: () => void
  cancelDatum: () => void
  /** Origin first, then +X — the second pick commits the alignment. */
  addDatumPick: (px: Vec2) => void
  clearDatum: () => void
  setShowGrid: (v: boolean) => void
  /** Turn the sheet on the stage by whole quarter turns — positive is
   *  counter-clockwise, on top of the alignment. The view rolls; the picks,
   *  the alignment and every measurement stay where they are on the part. */
  turnSheet: (quarters: number) => void
  /** Mirror the sheet on the stage as it is shown — left-to-right or
   *  top-to-bottom of the screen, whichever way round it is turned. As with
   *  a turn, nothing measured moves; the alignment reads right-handed as
   *  shown from then on. */
  mirrorSheet: (way: 'left-right' | 'top-bottom') => void

  /** The tally being clicked out is the `count` tool; the finished ones are
   *  the sheet's. */
  startCount: () => void
  /** Re-open a tally with its picks back on the sheet, the next click adding
   *  to it; finishing writes back over it. */
  editCount: (id: number) => void
  cancelCount: () => void
  addCountPick: (px: Vec2) => void
  undoCountPick: () => void
  /** Keep the tally — it needs at least one pick to be worth keeping. */
  finishCount: () => void
  deleteCount: (id: number) => void
  toggleCountVisible: (id: number) => void
  /** A tally's name, as given; blank keeps the old one. */
  renameCount: (id: number, name: string) => void

  /** Placing or editing a text note is the `note` tool. */
  startNote: () => void
  cancelNote: () => void
  /** Place a new note where the click landed (image pixels) and open it for
   *  typing. */
  addNote: (px: Vec2) => void
  editNote: (id: number) => void
  setNoteText: (id: number, text: string) => void
  moveNote: (id: number, px: Vec2) => void
  /** Close the text editor; a note left blank is not worth keeping. */
  finishNote: () => void
  deleteNote: (id: number) => void
  toggleNoteVisible: (id: number) => void

  startCalibration: (mode: CalMode) => void
  cancelCalibration: () => void
  addCalPick: (px: Vec2) => void
  undoCalPick: () => void
  /** Apply the collected picks against the reference's true size. Returns an
   *  error to show, or null on success. */
  applyCalibration: (trueMm: number) => string | null
  setSplitAxes: (v: boolean) => void

  saveProfile: (name: string) => void
  applyProfile: (name: string) => void
  deleteProfile: (name: string) => void
}

export const useFlat = create<FlatState>()((set, get) => ({
  imageName: null,
  imageWidth: 0,
  imageHeight: 0,
  imageBusy: false,
  imageVersion: 0,
  metaPxPerMm: null,

  edgeStatus: 'idle',
  edgeCount: 0,
  edgeVersion: 0,
  edgeSensitivity: 0.5,
  // On by default so the first detection is visible feedback for the slider;
  // a chip on the stage puts them away while measuring.
  showEdges: true,
  snapToEdge: true,

  pxPerMm: null,
  calSource: 'none',
  subject: { kind: 'image' },
  subjectVersion: 0,
  sheets: {},
  splitAxes: false,
  tool: NO_TOOL,

  setSubject: (subject) =>
    set((s) => {
      const from = sheetKeyOf(s.subject)
      const to = sheetKeyOf(subject)
      if (from === to) return {}
      const sheets = { ...s.sheets, [from]: sheetOf(s) }
      const restored =
        sheets[to] ??
        (subject.kind === 'section'
          ? freshSectionSheet()
          : freshSheet(s.metaPxPerMm, s.metaPxPerMm ? 'metadata' : 'none'))
      delete sheets[to]
      return {
        subject,
        subjectVersion: s.subjectVersion + 1,
        sheets,
        ...restored,
        ...STAGE_CLEARED,
      }
    }),

  dropSections: (liveIds) =>
    set((s) => {
      const live = new Set(liveIds)
      const sheets: Record<string, SheetState> = {}
      for (const [key, sheet] of Object.entries(s.sheets)) {
        if (!key.startsWith('section:') || live.has(Number(key.slice(8)))) sheets[key] = sheet
      }
      if (s.subject.kind === 'image' || live.has(s.subject.id)) {
        return Object.keys(sheets).length === Object.keys(s.sheets).length ? {} : { sheets }
      }
      // The section on the stage is gone: the image comes back as it was.
      const restored = sheets.image ?? freshSheet(s.metaPxPerMm, s.metaPxPerMm ? 'metadata' : 'none')
      delete sheets.image
      return {
        subject: { kind: 'image' },
        subjectVersion: s.subjectVersion + 1,
        sheets,
        ...restored,
        ...STAGE_CLEARED,
      }
    }),

  stageClick: (spot, meta, edges) => {
    const s = get()
    const px = docToPx(s, spot)
    const radius = snapRadiusPx(meta, s.pxPerMm?.x ?? 1)
    // A centre within reach comes before the edge — whenever the pick snaps
    // at all, by the setting or by Alt.
    const center = centerNear(s, spot, meta)
    const onEdge = (!meta.alt && center) || snapPick(px, edges, radius, true, meta.alt)
    const asSet = (s.snapToEdge !== meta.alt && center) || snapPick(px, edges, radius, s.snapToEdge, meta.alt)
    switch (s.tool.kind) {
      case 'calibrate':
        s.addCalPick(onEdge)
        return
      case 'datum':
        s.addDatumPick(onEdge)
        return
      case 'note':
        // A note goes exactly where the click landed — never onto an edge;
        // with a note's text open the click falls through to the draft.
        if (s.tool.editId === null) {
          s.addNote(px)
          return
        }
        break
      case 'count':
        // A tally snaps like a point pick: the checkbox says whether, Alt
        // inverts it for the one click.
        s.addCountPick(asSet)
        return
      case 'none':
        break
    }
    // A construction or a dimension being assembled takes the element
    // clicked — a hole by its rim or its centre — into its next open slot,
    // as the 3D viewport's do; a click on one already taken lets it go.
    if (s.draft ? flatMethod(s.draft.method).mode === 'construct' : s.dimDraft !== null) {
      s.clickSlotElement(spot, meta)
      return
    }
    if (!s.draft) return
    const mode = flatMethod(s.draft.method).mode
    if (mode === 'seed') {
      // A fit-to-edge tool grows the line or circle along the detected edge
      // from the point clicked, and stops where the edge bends away — the
      // 2D twin of the fit from a click on the scan. A click that lands on
      // no edge, or on an edge of the wrong shape, says so in the box and
      // leaves what was collected before alone.
      const hit = edges?.chainHit(px[0], px[1], radius)
      if (!hit) {
        s.noteDraftError('No detected edge under the click — click on one of the detected edge lines.')
        return
      }
      try {
        const kind = s.draft.kind === 'circle' ? 'circle' : 'line'
        s.addDraftPoints(thinEdgePoints(growFromSeed(kind, hit.chain, hit.index)))
      } catch (e) {
        if (!(e instanceof FitError)) throw e
        s.noteDraftError(e.message)
      }
      return
    }
    if (mode === 'edge') {
      // An edge tool reads a click as the whole detected edge under it.
      const chain = edges?.chainNear(px[0], px[1], radius)
      if (chain) s.addDraftPoints(thinEdgePoints(chain))
      return
    }
    // A click on a spline's curve puts the point into the curve there,
    // between the two fit points it runs between, rather than on the end.
    if (s.draft.fit?.kind === 'spline') {
      const near = nearestSplineSegment(s.draft.fit, spot)
      if (near.dist <= 10 * meta.unitsPerScreenPx) {
        s.insertDraftPick(near.segment + 1, asSet)
        return
      }
    }
    s.addDraftPick(asSet)
  },

  clickSlotElement: (spot, meta) => {
    const s = get()
    const reach = 10 * meta.unitsPerScreenPx
    const shown = s.elements.filter((e) => e.visible)
    if (s.draft) {
      const m = flatMethod(s.draft.method)
      const refs = s.draft.refs
      const blocked = flatBlockedRefs(s.draft.editId, s.elements)
      // The open slots, in order — for a repeating construction, one past
      // its last as well.
      const open = [...refs.keys(), ...(m.repeat ? [refs.length] : [])].filter((i) => refs[i] == null)
      const fits = (el: FlatElement, i: number) => {
        const role = flatSlotRole(m, i)
        return role !== null && FLAT_ROLE_PROVIDERS[role].includes(el.kind)
      }
      const el = elementNear(spot, shown, reach, (e) => !blocked.has(e.id) && (refs.includes(e.id) || open.some((i) => fits(e, i))))
      if (!el) return
      const used = refs.indexOf(el.id)
      if (used >= 0) s.setDraftRef(used, null)
      else s.setDraftRef(open.find((i) => fits(el, i))!, el.id)
      return
    }
    const dd = s.dimDraft
    if (!dd) return
    const slots = flatDimensionTypeInfo(dd.type).slots
    const fits = (el: FlatElement, i: number) => dd.refs[i] === null && FLAT_ROLE_PROVIDERS[slots[i].role].includes(el.kind)
    const el = elementNear(spot, shown, reach, (e) => dd.refs.includes(e.id) || slots.some((_, i) => fits(e, i)))
    if (!el) return
    const used = dd.refs.indexOf(el.id)
    if (used >= 0) s.setDimRef(used, null)
    else s.setDimRef(slots.findIndex((_, i) => fits(el, i)), el.id)
  },

  stageDrag: (index, spot, meta, edges) => {
    const s = get()
    const radius = snapRadiusPx(meta, s.pxPerMm?.x ?? 1)
    const center = s.snapToEdge !== meta.alt ? centerNear(s, spot, meta) : null
    s.moveDraftPick(index, center ?? snapPick(docToPx(s, spot), edges, radius, s.snapToEdge, meta.alt))
  },

  stageHandleDrag: (index, end, spot, meta) => {
    const s = get()
    if (!s.draft || index < 0 || index >= s.draft.picks.length) return
    const px = docToPx(s, spot)
    const at = s.draft.picks[index]
    const off: Vec2 = [px[0] - at[0], px[1] - at[1]]
    // A handle dragged onto its own point would leave the tangent nothing
    // to say and nothing to take hold of again: the drag stops short of it.
    if (Math.hypot(off[0], off[1]) < 3 * meta.unitsPerScreenPx * (s.pxPerMm?.x ?? 1)) return
    s.setDraftTangent(index, end === 'a' ? off : [-off[0], -off[1]])
  },

  stageRegion: (min, max, edges) => {
    const s = get()
    if (!s.draft || !edges) return
    const lo = docToPx(s, min)
    const hi = docToPx(s, max)
    s.addDraftPoints(thinEdgePoints(edges.inBox(lo[0], lo[1], hi[0], hi[1])))
  },

  stageNoteDrag: (id, spot) => {
    const s = get()
    s.moveNote(id, docToPx(s, spot))
  },

  confirmable: () => {
    const s = get()
    if (s.tool.kind === 'calibrate' || s.tool.kind === 'datum') return null
    if (s.draft) return s.draft.fit ? () => get().commitDraft() : null
    if (s.tool.kind === 'count') return s.tool.picks.length > 0 ? () => get().finishCount() : null
    if (s.tool.kind === 'note' && s.tool.editId !== null) return () => get().finishNote()
    const dd = s.dimDraft
    if (!dd || dd.refs.some((r) => r === null)) return null
    const fits = dd.refs.map((id) => s.elements.find((e) => e.id === id)?.fit)
    if (!fits.every((x): x is FlatFit => x !== undefined && x !== null)) return null
    return evaluateFlatDimension(dd.type, fits).invalid ? null : () => get().commitDim()
  },

  retreat: () => {
    const s = get()
    // A new draft with picks in it is emptied first and the kind kept in
    // hand, as a sketch tool's half-placed points go before the tool; an
    // empty one, or an edit, is closed.
    const backOutOfDraft = () =>
      s.draft!.editId === undefined && flatDraftHolds(s.draft) ? s.restartDraft() : s.cancelDraft()
    switch (s.tool.kind) {
      case 'calibrate':
        s.cancelCalibration()
        return true
      case 'datum':
        s.cancelDatum()
        return true
      case 'note':
        if (s.tool.editId === null) s.cancelNote()
        else s.finishNote()
        return true
      case 'count':
        // The element draft outranks an open tally, as it does for a click.
        if (s.draft) backOutOfDraft()
        else s.cancelCount()
        return true
      case 'none':
        break
    }
    if (s.draft) {
      backOutOfDraft()
      return true
    }
    if (s.dimDraft) {
      s.cancelDimDraft()
      return true
    }
    return false
  },

  dimensions: [],
  dimDraft: null,
  nextDimId: 1,
  dimCounts: {},

  // One thing in hand at a time: a dimension closes the element draft, so a
  // click on the sheet has one taker.
  startDimDraft: () =>
    set({
      draft: null,
      dimDraft: {
        type: FLAT_DIMENSION_TYPES[0].id,
        refs: FLAT_DIMENSION_TYPES[0].slots.map(() => null),
      },
    }),

  editDimension: (id) =>
    set((s) => {
      const d = s.dimensions.find((x) => x.id === id)
      if (!d) return {}
      return { dimDraft: { type: d.type, refs: [...d.refs], editId: d.id, name: d.name } }
    }),

  cancelDimDraft: () => set({ dimDraft: null }),

  // Slots re-shape with the type; whatever was chosen stays only if a slot of
  // the new type could still hold it — simplest is to start the slots over.
  setDimType: (type) =>
    set((s) => ({
      dimDraft: { ...s.dimDraft, type, refs: flatDimensionTypeInfo(type).slots.map(() => null) },
    })),

  setDimName: (name) => set((s) => (s.dimDraft ? { dimDraft: { ...s.dimDraft, name } } : {})),

  setDimRef: (slot, id) =>
    set((s) => {
      if (!s.dimDraft) return {}
      const refs = [...s.dimDraft.refs]
      refs[slot] = id
      return { dimDraft: { ...s.dimDraft, refs } }
    }),

  commitDim: () =>
    set((s) => {
      const dd = s.dimDraft
      if (!dd || dd.refs.some((r) => r === null)) return {}
      const group = flatDimensionTypeInfo(dd.type).group
      const n = (s.dimCounts[group] ?? 0) + 1
      const groupName = `${group === 'distance' ? 'Distance' : 'Angle'} ${n}`
      if (dd.editId !== undefined) {
        const old = s.dimensions.find((d) => d.id === dd.editId)
        if (!old) return { dimDraft: null }
        const typed = dd.name?.trim()
        // A distance turned into an angle is no longer "Distance 2": unless it
        // was renamed by hand it takes the next name of the group it joined.
        const renamed = Boolean(typed) && typed !== old.name
        const regroup = !renamed && flatDimensionTypeInfo(old.type).group !== group
        return {
          dimensions: s.dimensions.map((d) =>
            d.id === dd.editId
              ? { ...d, type: dd.type, refs: dd.refs as number[], name: regroup ? groupName : typed || old.name }
              : d,
          ),
          dimCounts: regroup ? { ...s.dimCounts, [group]: n } : s.dimCounts,
          dimDraft: null,
        }
      }
      const dim: FlatDimension = {
        id: s.nextDimId,
        type: dd.type,
        name: groupName,
        refs: dd.refs as number[],
        visible: true,
      }
      return {
        dimensions: [...s.dimensions, dim],
        // The box stays open for the next one of the same type, its slots
        // empty — as the sketch's Dimension tool stays in hand — until
        // Cancel or Escape closes it.
        dimDraft: { type: dd.type, refs: flatDimensionTypeInfo(dd.type).slots.map(() => null) },
        nextDimId: s.nextDimId + 1,
        dimCounts: { ...s.dimCounts, [group]: n },
      }
    }),

  deleteDimension: (id) =>
    set((s) => ({
      dimensions: s.dimensions.filter((d) => d.id !== id),
      dimDraft: s.dimDraft?.editId === id ? null : s.dimDraft,
    })),

  toggleDimensionVisible: (id) =>
    set((s) => ({
      dimensions: s.dimensions.map((d) => (d.id === id ? { ...d, visible: !d.visible } : d)),
    })),
  setAllDimensionsVisible: (visible) =>
    set((s) => ({ dimensions: s.dimensions.map((d) => ({ ...d, visible })) })),

  counts: [],
  nextCountId: 1,

  startCount: () => set({ tool: { kind: 'count', picks: [] } }),
  editCount: (id) =>
    set((s) => {
      const c = s.counts.find((x) => x.id === id)
      return c ? { tool: { kind: 'count', picks: [...c.picks], editId: id } } : {}
    }),
  cancelCount: () => set((s) => putAway(s, 'count')),

  addCountPick: (px) =>
    set((s) => {
      const t = toolOf(s, 'count')
      return t ? { tool: { ...t, picks: [...t.picks, px] } } : {}
    }),

  undoCountPick: () =>
    set((s) => {
      const t = toolOf(s, 'count')
      return t ? { tool: { ...t, picks: t.picks.slice(0, -1) } } : {}
    }),

  finishCount: () =>
    set((s) => {
      const t = toolOf(s, 'count')
      if (!t) return {}
      if (t.picks.length === 0) return { tool: NO_TOOL }
      if (t.editId !== undefined) {
        return {
          counts: s.counts.map((c) => (c.id === t.editId ? { ...c, picks: t.picks } : c)),
          tool: NO_TOOL,
        }
      }
      const id = s.nextCountId
      const count: FlatCount = {
        id,
        name: `Count ${id}`,
        color: flatCountColor(id),
        picks: t.picks,
        visible: true,
      }
      return { counts: [...s.counts, count], tool: NO_TOOL, nextCountId: id + 1 }
    }),

  deleteCount: (id) =>
    set((s) => ({
      counts: s.counts.filter((c) => c.id !== id),
      tool: toolOf(s, 'count')?.editId === id ? NO_TOOL : s.tool,
    })),

  toggleCountVisible: (id) =>
    set((s) => ({
      counts: s.counts.map((c) => (c.id === id ? { ...c, visible: !c.visible } : c)),
    })),
  renameCount: (id, name) =>
    set((s) =>
      name.trim() === '' ? {} : { counts: s.counts.map((c) => (c.id === id ? { ...c, name: name.trim() } : c)) },
    ),

  notes: [],
  nextNoteId: 1,

  startNote: () => set({ tool: { kind: 'note', editId: null } }),
  cancelNote: () => set((s) => putAway(s, 'note')),
  addNote: (px) =>
    set((s) => {
      const id = s.nextNoteId
      return {
        notes: [...s.notes, { id, text: '', at: px, visible: true }],
        tool: { kind: 'note', editId: id },
        nextNoteId: id + 1,
      }
    }),
  editNote: (id) =>
    set((s) => (s.notes.some((n) => n.id === id) ? { tool: { kind: 'note', editId: id } } : {})),
  setNoteText: (id, text) =>
    set((s) => ({ notes: s.notes.map((n) => (n.id === id ? { ...n, text } : n)) })),
  moveNote: (id, px) =>
    set((s) => ({ notes: s.notes.map((n) => (n.id === id ? { ...n, at: px } : n)) })),
  finishNote: () =>
    set((s) => {
      const editId = toolOf(s, 'note')?.editId ?? null
      return {
        notes: s.notes.filter((n) => n.id !== editId || n.text.trim() !== ''),
        ...putAway(s, 'note'),
      }
    }),
  deleteNote: (id) =>
    set((s) => ({
      notes: s.notes.filter((n) => n.id !== id),
      tool: toolOf(s, 'note')?.editId === id ? NO_TOOL : s.tool,
    })),
  toggleNoteVisible: (id) =>
    set((s) => ({ notes: s.notes.map((n) => (n.id === id ? { ...n, visible: !n.visible } : n)) })),

  datum: null,
  // On while the alignment is being placed and after — the sheet rolls square
  // to the frame, and the grid is the ruling that shows where zero runs; a
  // checkbox puts it away.
  showGrid: true,
  turns: 0,
  mirror: false,

  profiles: loadProfiles(),

  elements: [],
  draft: null,
  nextId: 1,
  nameCounts: {},

  startDraft: (kind, method) => set({ draft: freshDraft(kind, method) }),

  // The element comes back exactly as it was made: its picks on the sheet for
  // a picked or region-fitted one, its slots filled for a construction.
  editElement: (id) =>
    set((s) => {
      const el = s.elements.find((e) => e.id === id)
      if (!el) return {}
      const src = el.source
      const base = freshDraft(el.kind, src.method, { editId: el.id, name: el.name })
      const draft =
        src.type === 'picks'
          ? {
              ...base,
              picks: [...src.picks],
              tangents: tangentsFor(src.picks.length, src.tangents ?? []),
              closed: src.closed ?? false,
            }
          : { ...base, refs: [...src.refs] }
      return { draft: { ...draft, ...evaluateDraft(draft, s.elements, s.pxPerMm) } }
    }),

  cancelDraft: () => set({ draft: null }),
  restartDraft: () =>
    set((s) => (s.draft && s.draft.editId === undefined ? { draft: freshDraft(s.draft.kind, s.draft.method) } : {})),

  addDraftPick: (px) =>
    set((s) => {
      if (!s.draft || flatMethod(s.draft.method).mode !== 'pick') return {}
      // A single-point method moves its point; everything else accumulates.
      const picks =
        flatMethod(s.draft.method).minPicks === 1 && s.draft.kind === 'point'
          ? [px]
          : [...s.draft.picks, px]
      const draft = { ...s.draft, picks, tangents: tangentsFor(picks.length, s.draft.tangents) }
      return { draft: { ...draft, ...evaluateDraft(draft, s.elements, s.pxPerMm) } }
    }),

  insertDraftPick: (index, px) =>
    set((s) => {
      if (!s.draft || flatMethod(s.draft.method).mode !== 'pick') return {}
      const at = Math.max(0, Math.min(index, s.draft.picks.length))
      const picks = [...s.draft.picks.slice(0, at), px, ...s.draft.picks.slice(at)]
      const kept = tangentsFor(s.draft.picks.length, s.draft.tangents)
      const tangents = [...kept.slice(0, at), null, ...kept.slice(at)]
      const draft = { ...s.draft, picks, tangents }
      return { draft: { ...draft, ...evaluateDraft(draft, s.elements, s.pxPerMm) } }
    }),

  moveDraftPick: (index, px) =>
    set((s) => {
      if (!s.draft || index < 0 || index >= s.draft.picks.length) return {}
      const picks = s.draft.picks.map((p, i) => (i === index ? px : p))
      const draft = { ...s.draft, picks }
      return { draft: { ...draft, ...evaluateDraft(draft, s.elements, s.pxPerMm) } }
    }),

  removeDraftPick: (index) =>
    set((s) => {
      if (!s.draft || index < 0 || index >= s.draft.picks.length) return {}
      const picks = s.draft.picks.filter((_, i) => i !== index)
      const tangents = tangentsFor(s.draft.picks.length, s.draft.tangents).filter((_, i) => i !== index)
      const draft = { ...s.draft, picks, tangents }
      return { draft: { ...draft, ...evaluateDraft(draft, s.elements, s.pxPerMm) } }
    }),

  clickDraftPin: (index) => {
    const s = get()
    if (!s.draft) return
    const d = s.draft
    if (d.kind === 'spline' && index === 0 && !d.closed && d.picks.length >= flatPicksNeeded(d.method, true)) {
      s.setDraftClosed(true)
      return
    }
    s.removeDraftPick(index)
  },

  setDraftTangent: (index, handle) =>
    set((s) => {
      if (!s.draft || index < 0 || index >= s.draft.picks.length) return {}
      const tangents = tangentsFor(s.draft.picks.length, s.draft.tangents)
      tangents[index] = handle ? [handle[0], handle[1]] : null
      const draft = { ...s.draft, tangents }
      return { draft: { ...draft, ...evaluateDraft(draft, s.elements, s.pxPerMm) } }
    }),

  freeDraftTangents: () =>
    set((s) => {
      if (!s.draft) return {}
      const draft = { ...s.draft, tangents: tangentsFor(s.draft.picks.length, []) }
      return { draft: { ...draft, ...evaluateDraft(draft, s.elements, s.pxPerMm) } }
    }),

  setDraftClosed: (closed) =>
    set((s) => {
      if (!s.draft || s.draft.closed === closed) return {}
      const draft = { ...s.draft, closed }
      return { draft: { ...draft, ...evaluateDraft(draft, s.elements, s.pxPerMm) } }
    }),

  addDraftPoints: (px) =>
    set((s) => {
      if (!s.draft || !collectsEdgePoints(flatMethod(s.draft.method)) || px.length === 0) return {}
      const draft = { ...s.draft, picks: [...s.draft.picks, ...px] }
      return { draft: { ...draft, ...evaluateDraft(draft, s.elements, s.pxPerMm) } }
    }),

  noteDraftError: (message) =>
    set((s) => (s.draft ? { draft: { ...s.draft, error: message } } : {})),

  // For an edge draft this clears the lot: the unit of input was the dragged
  // region or the clicked stretch, and un-clicking one of its thousand
  // points would mean nothing.
  undoDraftPick: () =>
    set((s) => {
      if (!s.draft) return {}
      const picks =
        collectsEdgePoints(flatMethod(s.draft.method)) ? [] : s.draft.picks.slice(0, -1)
      const draft = { ...s.draft, picks, tangents: tangentsFor(picks.length, s.draft.tangents) }
      return { draft: { ...draft, ...evaluateDraft(draft, s.elements, s.pxPerMm) } }
    }),

  setDraftRef: (slot, id) =>
    set((s) => {
      if (!s.draft) return {}
      if (id !== null && flatBlockedRefs(s.draft.editId, s.elements).has(id)) return {}
      const refs = [...s.draft.refs]
      // A repeating construction takes a reference past its last slot as
      // one more; the list closes up again behind a reference taken out.
      while (refs.length < slot) refs.push(null)
      refs[slot] = id
      const draft = { ...s.draft, refs: flatConstructRefs(flatMethod(s.draft.method), refs) }
      return { draft: { ...draft, ...evaluateDraft(draft, s.elements, s.pxPerMm) } }
    }),

  setDraftMethod: (method) =>
    set((s) => {
      if (!s.draft) return {}
      const { editId, name } = s.draft
      return { draft: freshDraft(s.draft.kind, method, { editId, name }) }
    }),

  setDraftName: (name) => set((s) => (s.draft ? { draft: { ...s.draft, name } } : {})),

  commitDraft: () => {
    const s = get()
    if (!s.draft?.fit) return null
    const m = flatMethod(s.draft.method)
    const source: FlatSource =
      m.mode !== 'construct'
        ? pickSource(s.draft)
        : { type: 'construct', method: s.draft.method, refs: s.draft.refs as number[] }
    // An edited element is written back where it stands: same id, same
    // colour, same place in the list — and everything constructed on it
    // re-reads the new geometry.
    if (s.draft.editId !== undefined) {
      const editId = s.draft.editId
      const name = s.draft.name?.trim()
      set({
        draft: null,
        elements: evaluateFlatElements(
          s.elements.map((e) => (e.id === editId ? { ...e, name: name || e.name, source } : e)),
          s.pxPerMm,
        ),
      })
      return editId
    }
    const id = s.nextId
    const count = (s.nameCounts[s.draft.kind] ?? 0) + 1
    const element: FlatElement = {
      id,
      kind: s.draft.kind,
      name: `${FLAT_KIND_LABELS[s.draft.kind]} ${count}`,
      color: PALETTE[(id - 1) % PALETTE.length],
      source,
      fit: s.draft.fit,
      error: null,
      visible: true,
    }
    // The kind stays in hand for the next one, as a sketch tool does, until
    // Cancel or Escape puts it down — one circle is seldom the last.
    set({
      elements: [...s.elements, element],
      draft: freshDraft(s.draft.kind, s.draft.method),
      nextId: id + 1,
      nameCounts: { ...s.nameCounts, [s.draft.kind]: count },
    })
    return id
  },

  // Constructions referencing the deleted element keep their row and say why
  // they cannot be evaluated any more, exactly like the 3D side. Open editors
  // drop the reference; an editor open on the element itself closes.
  deleteElement: (id) =>
    set((s) => {
      const dropRef = (r: number | null) => (r === id ? null : r)
      const elements = evaluateFlatElements(
        s.elements.filter((e) => e.id !== id),
        s.pxPerMm,
      )
      let draft = s.draft
      if (draft?.editId === id) draft = null
      else if (draft && draft.refs.includes(id)) {
        const next = { ...draft, refs: flatConstructRefs(flatMethod(draft.method), draft.refs.map(dropRef)) }
        draft = { ...next, ...evaluateDraft(next, elements, s.pxPerMm) }
      }
      return {
        elements,
        draft,
        dimDraft: s.dimDraft ? { ...s.dimDraft, refs: s.dimDraft.refs.map(dropRef) } : null,
      }
    }),

  toggleElementVisible: (id) =>
    set((s) => ({
      elements: s.elements.map((e) => (e.id === id ? { ...e, visible: !e.visible } : e)),
    })),
  setAllElementsVisible: (visible) =>
    set((s) => ({
      elements: s.elements.map((e) => ({ ...e, visible })),
      counts: s.counts.map((c) => ({ ...c, visible })),
      notes: s.notes.map((n) => ({ ...n, visible })),
    })),

  beginImageLoad: (imageName) => set({ imageBusy: true, imageName }),

  // A new image adopts its own metadata scale — unless a measured calibration
  // is in force, which describes the scanner rather than the file and is
  // exactly the thing that should survive an image swap. The image goes on
  // the stage: a section that was there is stashed with what was measured
  // on it.
  finishImageLoad: (imageName, imageWidth, imageHeight, metaPxPerMm) =>
    set((s) => {
      const onImage = s.subject.kind === 'image'
      const image = onImage ? sheetOf(s) : s.sheets.image
      const scale =
        image?.calSource === 'measured' && image.pxPerMm
          ? { pxPerMm: image.pxPerMm, calSource: 'measured' as CalSource }
          : { pxPerMm: metaPxPerMm, calSource: metaPxPerMm ? ('metadata' as CalSource) : ('none' as CalSource) }
      const sheets = { ...s.sheets }
      if (!onImage) sheets[sheetKeyOf(s.subject)] = sheetOf(s)
      delete sheets.image
      // Elements are measurements of one image and go; the id counters run
      // on, so nothing measured later can be mistaken for something gone.
      const kept = onImage ? s : image ?? freshSheet(null, 'none')
      return {
        imageBusy: false,
        imageName,
        imageWidth,
        imageHeight,
        metaPxPerMm,
        imageVersion: s.imageVersion + 1,
        subject: { kind: 'image' },
        subjectVersion: onImage ? s.subjectVersion : s.subjectVersion + 1,
        sheets,
        ...freshSheet(scale.pxPerMm, scale.calSource),
        nextId: kept.nextId,
        nextDimId: kept.nextDimId,
        nextCountId: kept.nextCountId,
        nextNoteId: kept.nextNoteId,
        ...STAGE_CLEARED,
      }
    }),

  imageFailed: () =>
    set({ imageBusy: false, imageName: null, imageWidth: 0, imageHeight: 0, metaPxPerMm: null }),

  beginEdges: () => set({ edgeStatus: 'running' }),
  resolveEdges: (edgeCount) =>
    set((s) => ({ edgeStatus: 'ready', edgeCount, edgeVersion: s.edgeVersion + 1 })),
  failEdges: () => set((s) => ({ edgeStatus: 'idle', edgeCount: 0, edgeVersion: s.edgeVersion + 1 })),
  setEdgeSensitivity: (edgeSensitivity) => set({ edgeSensitivity }),
  setShowEdges: (showEdges) => set({ showEdges }),
  setSnapToEdge: (snapToEdge) => set({ snapToEdge }),

  startDatum: () => set({ tool: { kind: 'datum', picks: [] } }),
  cancelDatum: () => set((s) => putAway(s, 'datum')),

  addDatumPick: (px) =>
    set((s) => {
      const t = toolOf(s, 'datum')
      if (!t) return {}
      const picks = [...t.picks, px]
      if (picks.length < 2) return { tool: { kind: 'datum', picks } }
      return { datum: { originPx: picks[0], xRefPx: picks[1] }, tool: NO_TOOL }
    }),

  clearDatum: () => set((s) => ({ datum: null, ...putAway(s, 'datum') })),
  setShowGrid: (showGrid) => set({ showGrid }),
  turnSheet: (quarters) =>
    set((s) => ({ turns: (((s.turns + Math.round(quarters)) % 4) + 4) % 4 })),
  // The sheet is shown mirrored across its X axis and then turned; a mirror
  // across the screen's vertical is that with the turns run the other way,
  // and one across its horizontal is the same plus a half turn — so the
  // button flips what is on the screen whichever way round it is shown, and
  // Rotate 90° keeps turning the way it says afterwards.
  mirrorSheet: (way) =>
    set((s) => ({
      mirror: !s.mirror,
      turns: (((way === 'left-right' ? 2 - s.turns : -s.turns) % 4) + 4) % 4,
    })),

  startCalibration: (mode) =>
    set((s) => (s.subject.kind === 'image' ? { tool: { kind: 'calibrate', mode, picks: [] } } : {})),
  cancelCalibration: () => set((s) => putAway(s, 'calibrate')),

  addCalPick: (px) =>
    set((s) => {
      const t = toolOf(s, 'calibrate')
      if (!t) return {}
      // The distance tool takes exactly two: a third pick moves the second.
      const limit = t.mode === 'distance' ? 2 : Infinity
      const picks = t.picks.length < limit ? [...t.picks, px] : [...t.picks.slice(0, limit - 1), px]
      return { tool: { ...t, picks } }
    }),

  undoCalPick: () =>
    set((s) => {
      const t = toolOf(s, 'calibrate')
      return t ? { tool: { ...t, picks: t.picks.slice(0, -1) } } : {}
    }),

  applyCalibration: (trueMm) => {
    const s = get()
    const t = toolOf(s, 'calibrate')
    if (!t) return 'The calibration tool is not collecting.'
    if (s.subject.kind !== 'image') return 'A section is at true size already — there is nothing to calibrate.'
    try {
      const pxPerMm =
        t.mode === 'distance'
          ? distanceCalibration(t.picks[0], t.picks[1], trueMm, {
              current: s.calSource === 'measured' ? s.pxPerMm : null,
              splitAxes: s.splitAxes,
            })
          : diameterCalibration(t.picks, trueMm)
      // Every fit re-derives from its recorded pixels under the new scale —
      // the measurements move with the calibration, never lag it.
      set({
        pxPerMm,
        calSource: 'measured',
        tool: NO_TOOL,
        elements: evaluateFlatElements(s.elements, pxPerMm),
      })
      return null
    } catch (e) {
      if (e instanceof FitError) return e.message
      throw e
    }
  },

  setSplitAxes: (splitAxes) => set({ splitAxes }),

  saveProfile: (name) =>
    set((s) => {
      const trimmed = name.trim()
      if (!trimmed || !s.pxPerMm) return {}
      const profiles = [
        ...s.profiles.filter((p) => p.name !== trimmed),
        { name: trimmed, pxPerMm: { ...s.pxPerMm } },
      ]
      storeProfiles(profiles)
      return { profiles }
    }),

  // A profile is a measured calibration by construction — applying one puts
  // the workspace in the calibrated state it was saved from.
  applyProfile: (name) =>
    set((s) => {
      const p = s.profiles.find((x) => x.name === name)
      // A profile describes a scanner; a section's sheet is not the scanner's.
      if (!p || s.subject.kind !== 'image') return {}
      return {
        pxPerMm: { ...p.pxPerMm },
        calSource: 'measured',
        elements: evaluateFlatElements(s.elements, p.pxPerMm),
      }
    }),

  deleteProfile: (name) =>
    set((s) => {
      const profiles = s.profiles.filter((p) => p.name !== name)
      storeProfiles(profiles)
      return { profiles }
    }),
}))

/** Settles once the edge detection running from `from` is over: its edges
 *  found or failed, or its image replaced, which leaves its answer to no one.
 *  A detection can also never finish, so the wait is given up on, and the
 *  store let go of, when `signal` aborts. */
export function edgesSettled(from: Pick<FlatState, 'edgeVersion' | 'imageVersion'>, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const done = () => {
      stop()
      signal?.removeEventListener('abort', abort)
    }
    const abort = () => {
      done()
      reject(signal!.reason)
    }
    const stop = useFlat.subscribe((s) => {
      if (s.edgeVersion === from.edgeVersion && s.imageVersion === from.imageVersion) return
      done()
      resolve()
    })
    signal?.addEventListener('abort', abort)
  })
}

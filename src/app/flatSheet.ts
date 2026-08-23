// SPDX-License-Identifier: AGPL-3.0-only
// What the 2D viewport draws, derived from the flat store: the plain data
// half of the store→FlatScene sync, kept apart from the hook that pushes it
// (useFlatSceneSync) the same way app/project is kept apart from useProject.
// Everything here is in document units — millimetres under a scale, bare
// pixels without one — because that is the frame the sheet is built in; the
// store keeps image pixels so a recalibration moves the measurements and not
// the picks. This module is the one place that conversion happens on the
// way out.

import { flatMethod } from '../core/flat/construct'
import { datumFrame, fitInFrame } from '../core/flat/datum'
import { evaluateFlatDimensions, type FlatDimension } from '../core/flat/dimensions'
import type { FlatElement } from '../core/flat/elements'
import type { FlatDatum } from '../core/flat/datum'
import type { PixelsPerMm } from '../core/flat/image'
import { formatFlatPrimary } from '../core/flat/summary'
import type { FlatFit, Vec2 } from '../core/flat/types'
import {
  flatCountColor,
  flatDraftColorOf,
  toolOf,
  type FlatCount,
  type FlatDraft,
  type FlatNote,
  type FlatTool,
} from '../state/flatStore'

/** The slice of the flat store the sheet is drawn from. */
export interface SheetSource {
  pxPerMm: PixelsPerMm | null
  tool: FlatTool
  elements: FlatElement[]
  draft: FlatDraft | null
  nextId: number
  dimensions: FlatDimension[]
  datum: FlatDatum | null
  showGrid: boolean
  counts: FlatCount[]
  nextCountId: number
  notes: FlatNote[]
}

export interface SheetNote {
  id: number
  text: string
  at: Vec2
  editing: boolean
}

export interface SheetCount {
  picks: Vec2[]
  color: string
  name?: string
}

export interface SheetDimension {
  title: string
  value: string
  segment?: [Vec2, Vec2]
  arc?: { vertex: Vec2; dirA: Vec2; dirB: Vec2 }
}

export interface SheetElement {
  fit: FlatFit
  color: string
  name: string
  value: string
}

export interface SheetDraft {
  /** Numbered, draggable pins — empty for a region-collected draft. */
  pins: Vec2[]
  fit: FlatFit | null
  /** A region-collected draft's points: a dot cloud, not pins. */
  cloud: Vec2[] | undefined
  color: string
  /** The stage takes drags as regions rather than pans. */
  regionMode: boolean
}

export type SheetGrid = { origin: Vec2; xDir: Vec2 } | null

/** Document units per image pixel — the sheet's own scale. */
export function sheetScale(s: Pick<SheetSource, 'pxPerMm'>): PixelsPerMm {
  return s.pxPerMm ? { x: 1 / s.pxPerMm.x, y: 1 / s.pxPerMm.y } : { x: 1, y: 1 }
}

/** An image pixel as a spot on the sheet. */
export function pxToDoc(s: Pick<SheetSource, 'pxPerMm'>, px: Vec2): Vec2 {
  const mm = sheetScale(s)
  return [px[0] * mm.x, px[1] * mm.y]
}

/** The calibration tool's picks — stored in image pixels because they must
 *  survive the very scale change they cause. */
export function sheetCalibrationPicks(s: Pick<SheetSource, 'pxPerMm' | 'tool'>): Vec2[] {
  return (toolOf(s, 'calibrate')?.picks ?? []).map((p) => pxToDoc(s, p))
}

/** Notes on the sheet: the hidden ones stay off it unless open for typing. */
export function sheetNotes(s: Pick<SheetSource, 'pxPerMm' | 'tool' | 'notes'>): SheetNote[] {
  const editingId = toolOf(s, 'note')?.editId ?? null
  return s.notes
    .filter((n) => n.visible || n.id === editingId)
    .map((n) => ({ id: n.id, text: n.text, at: pxToDoc(s, n.at), editing: n.id === editingId }))
}

/** The tallies: finished ones under their names, the live one in the colour
 *  it will get. A re-opened tally is drawn by the live one only. */
export function sheetCounts(
  s: Pick<SheetSource, 'pxPerMm' | 'tool' | 'counts' | 'nextCountId'>,
): SheetCount[] {
  const counting = toolOf(s, 'count')
  const toDoc = (picks: readonly Vec2[]) => picks.map((p) => pxToDoc(s, p))
  return [
    ...s.counts
      .filter((c) => c.visible && c.id !== counting?.editId)
      .map((c) => ({ picks: toDoc(c.picks), color: c.color, name: c.name })),
    ...(counting
      ? [{ picks: toDoc(counting.picks), color: flatCountColor(counting.editId ?? s.nextCountId) }]
      : []),
  ]
}

/** The measured dimensions, drawn where they were taken — values are
 *  rigid-invariant, so the datum never moves them. */
export function sheetDimensions(s: Pick<SheetSource, 'dimensions' | 'elements'>): SheetDimension[] {
  return evaluateFlatDimensions(s.dimensions, s.elements)
    .filter((d) => d.dim.visible && d.value.value !== undefined)
    .map((d) => ({ title: d.dim.name, value: d.value.value!, segment: d.value.segment, arc: d.value.arc }))
}

/** The committed grid: datum-aligned when one is set and wanted. `undefined`
 *  while the datum tool is collecting — its live preview owns the stage
 *  then, and the committed grid must not overwrite it. */
export function sheetGrid(
  s: Pick<SheetSource, 'pxPerMm' | 'tool' | 'datum' | 'showGrid'>,
): SheetGrid | undefined {
  if (s.tool.kind === 'datum') return undefined
  const frame = s.datum && s.showGrid ? datumFrame(s.datum, s.pxPerMm) : null
  return frame && { origin: frame.origin, xDir: frame.xDir }
}

/** The grid the datum tool previews while it holds its first pick: pivoting
 *  around the origin toward the cursor, so the second pick is aimable. Null
 *  when there is nothing to preview. */
export function sheetDatumPreview(
  s: Pick<SheetSource, 'pxPerMm' | 'tool'>,
  cursor: Vec2 | null,
): SheetGrid {
  const datum = toolOf(s, 'datum')
  if (!datum || datum.picks.length !== 1 || !cursor) return null
  const origin = pxToDoc(s, datum.picks[0])
  const dx = cursor[0] - origin[0]
  const dy = cursor[1] - origin[1]
  const len = Math.hypot(dx, dy)
  if (len < 1e-6) return null
  return { origin, xDir: [dx / len, dy / len] }
}

/** The measured elements with their headline values — read in the datum
 *  frame when one is set, drawn where they were measured. An element open
 *  for editing is drawn by its draft instead. */
export function sheetElements(
  s: Pick<SheetSource, 'pxPerMm' | 'elements' | 'draft' | 'datum'>,
): SheetElement[] {
  const unit = s.pxPerMm ? 'mm' : 'px'
  const frame = s.datum ? datumFrame(s.datum, s.pxPerMm) : null
  return s.elements
    .filter((e) => e.visible && e.fit && e.id !== s.draft?.editId)
    .map((e) => ({
      fit: e.fit!,
      color: e.color,
      name: e.name,
      value: formatFlatPrimary(fitInFrame(e.fit!, frame), unit),
    }))
}

/** The draft's pins (or dot cloud) and ghost, in its own colour. */
export function sheetDraft(
  s: Pick<SheetSource, 'pxPerMm' | 'draft' | 'elements' | 'nextId'>,
): SheetDraft {
  const picks = (s.draft?.picks ?? []).map((p) => pxToDoc(s, p))
  // A region-collected draft carries thousands of points — a dot cloud, not
  // numbered pins.
  const isEdgeDraft = s.draft ? flatMethod(s.draft.method).mode === 'edge' : false
  return {
    pins: isEdgeDraft ? [] : picks,
    fit: s.draft?.fit ?? null,
    cloud: isEdgeDraft ? picks : undefined,
    color: flatDraftColorOf(s),
    regionMode: isEdgeDraft,
  }
}

/** Whether the loupe follows the cursor: while picks are being placed by
 *  hand — an element's, a calibration's, a tally's. */
export function sheetLoupeActive(s: Pick<SheetSource, 'tool' | 'draft'>): boolean {
  return (
    (s.draft !== null && flatMethod(s.draft.method).mode === 'pick') ||
    s.tool.kind === 'calibrate' ||
    s.tool.kind === 'count'
  )
}

// SPDX-License-Identifier: AGPL-3.0-only
// The flat element itself: how one is recorded, named and re-evaluated. The
// recorded source is always image pixels or references to other elements —
// never millimetres — so a recalibration re-derives every fit from what was
// actually picked, and nothing measured is ever baked to a stale scale.

import { FitError } from '../fit/errors'
import { evaluateFlatConstruction, evaluateFlatPicks, flatMethod } from './construct'
import type { PixelsPerMm } from './image'
import type { FlatElementKind, FlatFit, Vec2 } from './types'

export type FlatSource =
  /** Picked points (by hand, snapped or not) or collected off edge chains —
   *  either way, image-pixel coordinates through a pick-mode method. */
  | { type: 'picks'; method: string; picks: Vec2[] }
  | { type: 'construct'; method: string; refs: number[] }

export interface FlatElement {
  id: number
  kind: FlatElementKind
  name: string
  color: string
  source: FlatSource
  /** The fit in document units (mm — or px while nothing sets a scale),
   *  null when the source has gone degenerate. */
  fit: FlatFit | null
  /** Why the fit is null, user-facing. */
  error: string | null
  visible: boolean
}

export const FLAT_KIND_LABELS: Record<FlatElementKind, string> = {
  point: 'Point',
  line: 'Line',
  circle: 'Circle',
  arc: 'Arc',
}

/** px → document units. With no scale in force the document IS pixels. */
export function picksToDocument(picks: readonly Vec2[], pxPerMm: PixelsPerMm | null): Vec2[] {
  if (!pxPerMm) return picks.map((p) => [p[0], p[1]])
  return picks.map((p) => [p[0] / pxPerMm.x, p[1] / pxPerMm.y])
}

/**
 * Evaluate one source against the scale in force. Constructions resolve their
 * references through `fitOf` — already-evaluated fits, so callers evaluate in
 * id order and references only ever point backwards.
 */
export function evaluateFlatSource(
  source: FlatSource,
  pxPerMm: PixelsPerMm | null,
  fitOf: (id: number) => FlatFit | null,
): FlatFit {
  if (source.type === 'picks') {
    return evaluateFlatPicks(source.method, picksToDocument(source.picks, pxPerMm))
  }
  const refs = source.refs.map((id) => {
    const fit = fitOf(id)
    if (!fit) throw new FitError('A referenced element is unavailable.')
    return fit
  })
  return evaluateFlatConstruction(source.method, refs)
}

/** Re-evaluate a whole element list (in id order, so constructions see their
 *  sources fresh). Elements whose evaluation refuses keep their identity and
 *  carry the reason instead of a fit. */
export function evaluateFlatElements(
  elements: readonly FlatElement[],
  pxPerMm: PixelsPerMm | null,
): FlatElement[] {
  const fits = new Map<number, FlatFit | null>()
  return [...elements]
    .sort((a, b) => a.id - b.id)
    .map((el) => {
      try {
        const fit = evaluateFlatSource(el.source, pxPerMm, (id) => fits.get(id) ?? null)
        fits.set(el.id, fit)
        return { ...el, fit, error: null }
      } catch (e) {
        fits.set(el.id, null)
        if (e instanceof FitError) return { ...el, fit: null, error: e.message }
        throw e
      }
    })
}

/** Whether a pick-mode draft has enough points to fit. */
export function flatPicksReady(method: string, picks: readonly Vec2[]): boolean {
  return picks.length >= (flatMethod(method).minPicks ?? 1)
}

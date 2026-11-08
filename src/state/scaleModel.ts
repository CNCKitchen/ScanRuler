// SPDX-License-Identifier: AGPL-3.0-only
// The Scale part box of the Alignment group, as the store holds it: the
// references in hand — a dimension already measured, an element's diameter,
// two points clicked on the scan — each with the true length typed beside
// it, or a factor typed outright. Nothing moves until the box is applied
// (app/partScale); see core/scanScale for what a scale does.

import { dimensionTypeInfo, evaluateDimensions, type Dimension } from '../core/dimensions'
import { combineReferences, type CombinedScale, type ScaleReference } from '../core/scanScale'
import type { Vec3 } from '../core/types'
import type { Element } from './elementModel'
import { dimensionRefsOf, type Section } from './sectionModel'

/** One reference row of the box. `true` is the true length as typed, in the
 *  units on screen; NaN while the field is empty. */
export type ScaleRefDraft =
  | { kind: 'dimension'; id: number | null; true: number }
  | { kind: 'element'; id: number | null; true: number }
  | { kind: 'points'; points: Vec3[]; true: number }

export type ScaleRefKind = ScaleRefDraft['kind']

export interface ScaleDraft {
  /** From lengths measured on the part, or a factor typed outright. */
  mode: 'reference' | 'factor'
  refs: ScaleRefDraft[]
  /** The factor as typed; NaN while the field is empty. */
  factor: number
  /** The row collecting clicks on the scan, if one is. */
  pickRow: number | null
}

export const freshScaleDraft = (): ScaleDraft => ({
  mode: 'reference',
  refs: [{ kind: 'dimension', id: null, true: NaN }],
  factor: NaN,
  pickRow: null,
})

export const freshScaleRef = (kind: ScaleRefKind): ScaleRefDraft =>
  kind === 'points' ? { kind, points: [], true: NaN } : { kind, id: null, true: NaN }

/** The dimensions a scale can be read off: lengths, not angles or form. */
export const lengthDimensions = (dimensions: readonly Dimension[]): Dimension[] =>
  dimensions.filter((d) => {
    const info = dimensionTypeInfo(d.type)
    return info.family === 'dimension' && info.unit !== '°'
  })

/** The elements with a diameter to scale from. */
export const diameterElements = (elements: readonly Element[]): Element[] =>
  elements.filter((e) => e.fit && (e.fit.kind === 'sphere' || e.fit.kind === 'cylinder' || e.fit.kind === 'circle'))

const diameterOf = (e: Element | undefined): number =>
  e?.fit && (e.fit.kind === 'sphere' || e.fit.kind === 'cylinder' || e.fit.kind === 'circle') ? 2 * e.fit.radius : NaN

const distance = (a: Vec3, b: Vec3): number => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])

/** What a row measures on the scan now, mm, and what it is called — NaN when
 *  it measures nothing yet. */
export function measuredOf(
  ref: ScaleRefDraft,
  s: { elements: readonly Element[]; sections: readonly Section[]; dimensions: readonly Dimension[] },
): { label: string; measured: number } {
  if (ref.kind === 'points') {
    return { label: 'Two points', measured: ref.points.length === 2 ? distance(ref.points[0], ref.points[1]) : NaN }
  }
  if (ref.kind === 'element') {
    const el = s.elements.find((e) => e.id === ref.id)
    return { label: el ? `${el.name} Ø` : 'Diameter', measured: diameterOf(el) }
  }
  const dim = s.dimensions.find((d) => d.id === ref.id)
  if (!dim) return { label: 'Dimension', measured: NaN }
  const [row] = evaluateDimensions([dim], dimensionRefsOf(s.elements, s.sections))
  return { label: dim.name, measured: row.value.raw ?? NaN }
}

/**
 * The references of the box as the scale reads them, mm — the rows filled in
 * — and the factor they come to, or why there is none yet. `fromDisplay`
 * turns a length typed in the units on screen into mm.
 */
export function scaleFromDraft(
  draft: ScaleDraft,
  s: { elements: readonly Element[]; sections: readonly Section[]; dimensions: readonly Dimension[] },
  fromDisplay: (v: number) => number,
): { combined: CombinedScale | null; references: ScaleReference[]; problem: string | null } {
  const references: ScaleReference[] = []
  for (const ref of draft.refs) {
    const { label, measured } = measuredOf(ref, s)
    if (!Number.isFinite(measured) && !Number.isFinite(ref.true)) continue
    if (!Number.isFinite(measured) || measured <= 0) return { combined: null, references, problem: `${label}: nothing measured on the scan yet.` }
    if (!Number.isFinite(ref.true) || ref.true <= 0) return { combined: null, references, problem: `${label}: type its true length.` }
    references.push({ label, measured, true: fromDisplay(ref.true) })
  }
  if (references.length === 0) return { combined: null, references, problem: null }
  return { combined: combineReferences(references), references, problem: null }
}

// SPDX-License-Identifier: AGPL-3.0-only
// How far past the surface it was measured on an element is drawn and
// exported.
//
// A fit is a measurement: its length and its extents say how much of the
// feature the scan actually covered, and the sigma, the patch size in the
// summary and the "left the measured surface" warning on a dimension all rest
// on that. So an extension is never folded into the fit — it is carried beside
// it and applied at the two places where geometry stops being a measurement
// and becomes something to look at or hand to CAD: the viewport and the STEP
// export. Everything that reports numbers keeps reading the raw fit.
//
// The values are millimetres per side, positive outward. Negative shrinks, and
// each side is clamped so the element can never be given away entirely.

import type { CylinderFit, FitData, PlaneFit } from '../types'
import { addScaled } from '../vec'

/** A cylinder grows along its axis: `start` runs against it, `end` with it.
 *  A plane grows along its own in-plane axes, one value per edge. */
export type Extension =
  | { kind: 'cylinder'; start: number; end: number }
  | { kind: 'plane'; uMin: number; uMax: number; vMin: number; vMax: number }

export type CylinderSide = 'start' | 'end'
export type PlaneSide = 'uMin' | 'uMax' | 'vMin' | 'vMax'
export type ExtendSide = CylinderSide | PlaneSide

export const CYLINDER_SIDES: readonly CylinderSide[] = ['start', 'end']
export const PLANE_SIDES: readonly PlaneSide[] = ['uMin', 'uMax', 'vMin', 'vMax']

/** What is left of an element that has been shrunk as far as it may go. Small
 *  enough to be no size at all, large enough to stay a valid B-rep face. */
const MIN_SIZE = 1e-3

/** The kinds that can be extended: the two with a size of their own that is a
 *  drawing decision rather than a measured value. A sphere's radius and a
 *  point's position are the measurement itself. */
export type ExtendableFit = CylinderFit | PlaneFit

export function isExtendable(fit: FitData | undefined): fit is ExtendableFit {
  return fit !== undefined && (fit.kind === 'cylinder' || fit.kind === 'plane')
}

/** An untouched extension for the given geometry — every side at zero, so the
 *  element is drawn exactly as it was measured. */
export function zeroExtension(fit: ExtendableFit): Extension {
  return fit.kind === 'cylinder'
    ? { kind: 'cylinder', start: 0, end: 0 }
    : { kind: 'plane', uMin: 0, uMax: 0, vMin: 0, vMax: 0 }
}

/** The extension to work with for one element: its own, if it still matches
 *  the geometry (a re-opened plane draft can be switched to another kind, and
 *  a construction can change what it produces), otherwise a fresh zeroed one. */
export function extensionOf(fit: ExtendableFit, ext: Extension | undefined): Extension {
  return ext && ext.kind === fit.kind ? ext : zeroExtension(fit)
}

/** Whether anything has been extended at all — the panel and the summary only
 *  mention it when it has. */
export function isExtended(ext: Extension | undefined): boolean {
  if (!ext) return false
  return sides(ext).some((s) => sideValue(ext, s) !== 0)
}

export function sides(ext: Extension): readonly ExtendSide[] {
  return ext.kind === 'cylinder' ? CYLINDER_SIDES : PLANE_SIDES
}

export function sideValue(ext: Extension, side: ExtendSide): number {
  return (ext as Record<string, unknown>)[side] as number
}

/** The two sides that share an axis: they trade off against each other, which
 *  is what makes the clamp below a matter between a pair rather than one
 *  value on its own. */
function opposite(side: ExtendSide): ExtendSide {
  if (side === 'start') return 'end'
  if (side === 'end') return 'start'
  if (side === 'uMin') return 'uMax'
  if (side === 'uMax') return 'uMin'
  return side === 'vMin' ? 'vMax' : 'vMin'
}

/** The measured size along the axis a side grows on — a cylinder's length,
 *  the full width or height of a plane's patch. */
function fittedSpan(fit: ExtendableFit, side: ExtendSide): number {
  if (fit.kind === 'cylinder') return fit.length
  return 2 * (side === 'uMin' || side === 'uMax' ? fit.extentU : fit.extentV)
}

/**
 * How far one side may be pulled in before there would be nothing left along
 * that axis. Shrinking is allowed — it is the only way to trim a fit that ran
 * a little past the feature — but the far side has already had its say, so
 * what is left to give is whatever the two of them still span.
 */
export function minSide(fit: ExtendableFit, ext: Extension, side: ExtendSide): number {
  const far = sideValue(ext, opposite(side))
  return MIN_SIZE - fittedSpan(fit, side) - far
}

/** One side changed, clamped so the element keeps a size. */
export function withSide(
  fit: ExtendableFit,
  ext: Extension,
  side: ExtendSide,
  value: number,
): Extension {
  const v = Number.isFinite(value) ? Math.max(value, minSide(fit, ext, side)) : 0
  return { ...ext, [side]: v } as Extension
}

/**
 * The geometry as it should be drawn and exported: the same surface, carrying
 * however much of it the user asked for.
 *
 * Only the size and the middle move. The axis, the normal, the radius and the
 * in-plane basis are the fit's own and are handed straight on, so an extended
 * element is still exactly the measured surface — there is just more of it.
 */
export function applyExtension(fit: FitData, ext: Extension | undefined): FitData {
  if (!ext || !isExtendable(fit) || ext.kind !== fit.kind) return fit

  if (fit.kind === 'cylinder' && ext.kind === 'cylinder') {
    const length = Math.max(fit.length + ext.start + ext.end, MIN_SIZE)
    if (length === fit.length && ext.start === ext.end) return fit
    return {
      ...fit,
      length,
      center: addScaled(fit.center, fit.axis, (ext.end - ext.start) / 2),
    }
  }

  if (fit.kind === 'plane' && ext.kind === 'plane') {
    const extentU = Math.max(fit.extentU + (ext.uMin + ext.uMax) / 2, MIN_SIZE / 2)
    const extentV = Math.max(fit.extentV + (ext.vMin + ext.vMax) / 2, MIN_SIZE / 2)
    let center = addScaled(fit.center, fit.basisU, (ext.uMax - ext.uMin) / 2)
    center = addScaled(center, fit.basisV, (ext.vMax - ext.vMin) / 2)
    return { ...fit, extentU, extentV, center }
  }

  return fit
}

/** The full width and height (or length) the element is drawn at, for the
 *  readout beside the fields. */
export function extendedSpans(fit: ExtendableFit, ext: Extension | undefined): number[] {
  const applied = applyExtension(fit, ext)
  if (applied.kind === 'cylinder') return [applied.length]
  if (applied.kind === 'plane') return [2 * applied.extentU, 2 * applied.extentV]
  return []
}

/**
 * The extension that makes a plane patch square, by growing the shorter axis
 * out to the longer one — half of the difference onto each of its two edges,
 * so the patch keeps its middle. It never cuts: a square that trimmed the
 * measured surface away would hide the very thing that was measured.
 */
export function squareExtension(fit: PlaneFit, ext: Extension | undefined): Extension {
  const e = extensionOf(fit, ext)
  if (e.kind !== 'plane') return e
  const u = 2 * fit.extentU + e.uMin + e.uMax
  const v = 2 * fit.extentV + e.vMin + e.vMax
  const side = Math.max(u, v)
  const du = (side - u) / 2
  const dv = (side - v) / 2
  return {
    kind: 'plane',
    uMin: e.uMin + du,
    uMax: e.uMax + du,
    vMin: e.vMin + dv,
    vMax: e.vMax + dv,
  }
}

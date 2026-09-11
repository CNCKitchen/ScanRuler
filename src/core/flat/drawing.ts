// SPDX-License-Identifier: AGPL-3.0-only
// What the drawing exports share. The sheet gathered for drawing — its
// bounds, the edge chains, the elements as shown, how it is rolled — is one
// thing whether it goes out as SVG or as DXF, and so are the small choices
// both must make the same way: where a label sits, how a coordinate is
// trimmed, how the roll is described. Kept here so the two files of one
// sheet are the same drawing in two dialects.

import type { EdgeChains } from './edges'
import { splineMidpoint } from './spline'
import type { FlatFit, Vec2 } from './types'

/** An element as the sheet shows it — the shape app/flatSheet's
 *  sheetElements() produces, so what is on screen is what is exported. */
export interface FlatDrawingElement {
  fit: FlatFit
  color: string
  name: string
  /** The headline reading, already in the frame the sheet reads in. */
  value: string
}

export interface FlatDrawingInput {
  /** The sheet's extent in document units: the image at its scale, or the
   *  padded bounds a section is laid on. */
  bounds: { min: Vec2; max: Vec2 }
  /** The edge chains in their own coordinates — image pixels, or a
   *  section's millimetres — or null while they are not shown. */
  chains: EdgeChains | null
  /** Document units per chain unit: mm per pixel on an image, 1 on a
   *  section. */
  chainUnit: { x: number; y: number }
  elements: readonly FlatDrawingElement[]
  /** The alignment's +X in document units — shown to the right of the
   *  screen, so drawn along the page's x — or null for a sheet as scanned. */
  alignDir: Vec2 | null
  /** Quarter turns the sheet is shown at, counter-clockwise. */
  turns: number
  unit: 'mm' | 'px'
  /** What the sheet is, for the file's title. */
  title: string
  /** The traceability line — what the scale is and where it came from. */
  scaleNote: string
}

/** The teal the stage draws detected edges in. */
export const DRAWING_EDGE_COLOR = '#11b5a5'

/** A coordinate, trimmed: three decimals of a millimetre is a micron, finer
 *  than any scanner resolves, and trailing zeros only cost bytes — of which
 *  a sheet of edges has a million. */
export function num(v: number, decimals: number): string {
  const s = v.toFixed(decimals)
  const trimmed = s.includes('.') ? s.replace(/\.?0+$/, '') : s
  return trimmed === '-0' ? '0' : trimmed
}

/** How the sheet is shown, for a file's description: aligned to the part,
 *  turned by quarter turns, either, or neither. */
export function describeRoll(alignDir: Vec2 | null, turns: number): string {
  const t = ((Math.round(turns) % 4) + 4) % 4
  const aligned = alignDir ? ', aligned to the part with its +X along the page' : ''
  if (t === 0) return aligned
  return (
    aligned +
    (t === 2
      ? ', turned upside down'
      : t === 1
        ? ', turned a quarter turn counter-clockwise'
        : ', turned a quarter turn clockwise')
  )
}

/** Where a fit's label sits, in document units: beside the feature, as on
 *  the stage, lifted by a share of the sheet's diagonal. */
export function labelSpot(fit: FlatFit, diag: number): Vec2 {
  const lift = diag * 0.01
  if (fit.kind === 'point') return [fit.at[0], fit.at[1] + lift]
  if (fit.kind === 'line') return [fit.center[0], fit.center[1] + lift]
  if (fit.kind === 'circle') {
    const d = fit.radius * 0.7071
    return [fit.center[0] + d, fit.center[1] + d]
  }
  if (fit.kind === 'spline') {
    const [x, y] = splineMidpoint(fit)
    return [x, y + lift]
  }
  const mid = fit.start + fit.sweep / 2
  return [fit.center[0] + fit.radius * Math.cos(mid), fit.center[1] + fit.radius * Math.sin(mid)]
}

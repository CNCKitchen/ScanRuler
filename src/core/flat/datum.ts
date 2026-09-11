// SPDX-License-Identifier: AGPL-3.0-only
// The part's own coordinate frame on the sheet: an origin and an X direction,
// picked as two points — the way measuring microscopes align to a part
// instead of to wherever it happened to lie on the glass. Recorded in image
// pixels like every other measurement source, so a recalibration moves the
// frame with the image; the frame itself lives in millimetres, because an
// anisotropic calibration would bend angles measured in pixels.
//
// Distances and angles between elements never change under a datum — only
// reported coordinates (and the angle a line reads as) do. On the stage the
// sheet is shown rolled so the frame's +X runs to the right of the screen —
// the part square under the eye, not the scanner glass — and the roll math
// that does it lives here beside the frame it follows.

import type { PixelsPerMm } from './image'
import type { FlatFit, Vec2 } from './types'

/** The two picks, in image pixels. */
export interface FlatDatum {
  originPx: Vec2
  xRefPx: Vec2
}

/** The frame those picks span at the scale in force: an origin and a unit X
 *  direction in document units. Null when the picks coincide. */
export interface FlatFrame {
  origin: Vec2
  xDir: Vec2
}

export function datumFrame(datum: FlatDatum, pxPerMm: PixelsPerMm | null): FlatFrame | null {
  const toDoc = (p: Vec2): Vec2 =>
    pxPerMm ? [p[0] / pxPerMm.x, p[1] / pxPerMm.y] : [p[0], p[1]]
  const origin = toDoc(datum.originPx)
  const xRef = toDoc(datum.xRefPx)
  const dx = xRef[0] - origin[0]
  const dy = xRef[1] - origin[1]
  const len = Math.hypot(dx, dy)
  if (!(len > 1e-9)) return null
  return { origin, xDir: [dx / len, dy / len] }
}

/** A document point in the frame's coordinates. */
export function toFrame(frame: FlatFrame, p: Vec2): Vec2 {
  const rx = p[0] - frame.origin[0]
  const ry = p[1] - frame.origin[1]
  return [
    rx * frame.xDir[0] + ry * frame.xDir[1],
    -rx * frame.xDir[1] + ry * frame.xDir[0],
  ]
}

/**
 * The fit as the frame reads it: positions in frame coordinates, directions
 * rotated. Radii, lengths, sweeps and residuals are rigid-invariant and ride
 * along untouched. With no frame the fit IS the reading.
 */
export function fitInFrame(fit: FlatFit, frame: FlatFrame | null): FlatFit {
  if (!frame) return fit
  if (fit.kind === 'point') return { ...fit, at: toFrame(frame, fit.at) }
  if (fit.kind === 'line') {
    const [c, s] = frame.xDir
    return {
      ...fit,
      center: toFrame(frame, fit.center),
      dir: [fit.dir[0] * c + fit.dir[1] * s, -fit.dir[0] * s + fit.dir[1] * c],
    }
  }
  if (fit.kind === 'circle') return { ...fit, center: toFrame(frame, fit.center) }
  if (fit.kind === 'spline') {
    const [c, s] = frame.xDir
    return {
      ...fit,
      points: fit.points.map((p) => toFrame(frame, p)),
      tangents: fit.tangents.map((t) => [t[0] * c + t[1] * s, -t[0] * s + t[1] * c]),
    }
  }
  // An arc's start angle is measured from +X, which the frame rotates.
  const angle = Math.atan2(frame.xDir[1], frame.xDir[0])
  return { ...fit, center: toFrame(frame, fit.center), start: fit.start - angle }
}

/**
 * How far round the sheet is shown on the stage, in radians counter-clockwise
 * on screen: the alignment's +X brought to the screen's right, then the
 * quarter turns on top of that. Zero shows the sheet as it lies — +X right,
 * +Y up. `xDir` is the frame's unit X in document units, or null while the
 * sheet is unaligned.
 */
export function sheetRoll(xDir: Vec2 | null, turns: number): number {
  const t = ((Math.round(turns) % 4) + 4) % 4
  const align = xDir ? Math.atan2(xDir[1], xDir[0]) : 0
  return (t * Math.PI) / 2 - align
}

/** Cosine and sine of a roll, snapped exact at the quarter turns so a sheet
 *  shown square stays square to the last digit — in the SVG and on screen. */
function rollTrig(roll: number): [number, number] {
  const snap = (v: number): number =>
    Math.abs(v) < 1e-12 ? 0 : Math.abs(v - 1) < 1e-12 ? 1 : Math.abs(v + 1) < 1e-12 ? -1 : v
  return [snap(Math.cos(roll)), snap(Math.sin(roll))]
}

/** A document point as it appears on the rolled sheet: turned about the
 *  document origin by `roll`, counter-clockwise. */
export function rollMap(roll: number): (p: Vec2) => Vec2 {
  const [c, s] = rollTrig(roll)
  return ([x, y]) => [x * c - y * s, x * s + y * c]
}

/** The document directions that run to the screen's right and up on a sheet
 *  shown rolled by `roll` — what the camera is told is up. */
export function rollAxes(roll: number): { right: Vec2; up: Vec2 } {
  const [c, s] = rollTrig(roll)
  // 0 - s rather than -s: a negated zero is a zero that fails an equality.
  return { right: [c, 0 - s], up: [s, c] }
}

/** Grid spacings on a 1-2-5 ladder; the finest that still leaves the lines a
 *  hand apart on screen. */
export function gridSpacing(unitsPerScreenPx: number, minScreenPx = 28): number {
  const ladder = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100]
  for (const s of ladder) {
    if (s / unitsPerScreenPx >= minScreenPx) return s
  }
  return ladder[ladder.length - 1]
}

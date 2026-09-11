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
// that does it lives here beside the frame it follows. A sheet can also be
// shown mirrored: a flatbed scan is the part seen through the glass, and the
// mirror is how it is looked at from above. The frame follows that too: its
// +Y is a quarter turn counter-clockwise from +X *as shown*, so an aligned
// reading is right-handed on the screen whichever way the sheet is looked at.

import type { PixelsPerMm } from './image'
import type { FlatFit, Vec2 } from './types'

/** The two picks, in image pixels. */
export interface FlatDatum {
  originPx: Vec2
  xRefPx: Vec2
}

/** The frame those picks span at the scale in force: an origin and unit X
 *  and Y directions in document units. Y is a quarter turn from X — counter-
 *  clockwise on a sheet shown as scanned, clockwise on one shown mirrored,
 *  which is counter-clockwise as shown. Null when the picks coincide. */
export interface FlatFrame {
  origin: Vec2
  xDir: Vec2
  yDir: Vec2
}

export function datumFrame(
  datum: FlatDatum,
  pxPerMm: PixelsPerMm | null,
  mirror = false,
): FlatFrame | null {
  const toDoc = (p: Vec2): Vec2 =>
    pxPerMm ? [p[0] / pxPerMm.x, p[1] / pxPerMm.y] : [p[0], p[1]]
  const origin = toDoc(datum.originPx)
  const xRef = toDoc(datum.xRefPx)
  const dx = xRef[0] - origin[0]
  const dy = xRef[1] - origin[1]
  const len = Math.hypot(dx, dy)
  if (!(len > 1e-9)) return null
  const xDir: Vec2 = [dx / len, dy / len]
  return { origin, xDir, yDir: mirror ? [xDir[1], -xDir[0]] : [-xDir[1], xDir[0]] }
}

/** Whether the frame is left-handed in document units — the frame of a sheet
 *  shown mirrored, right-handed as shown. */
export function frameMirrored(frame: FlatFrame): boolean {
  return frame.xDir[0] * frame.yDir[1] - frame.xDir[1] * frame.yDir[0] < 0
}

/** A document point in the frame's coordinates. */
export function toFrame(frame: FlatFrame, p: Vec2): Vec2 {
  const rx = p[0] - frame.origin[0]
  const ry = p[1] - frame.origin[1]
  return [rx * frame.xDir[0] + ry * frame.xDir[1], rx * frame.yDir[0] + ry * frame.yDir[1]]
}

/** A document direction in the frame's: turned with it, and flipped across
 *  its X axis in a mirrored one. */
function dirInFrame(frame: FlatFrame, d: Vec2): Vec2 {
  return [d[0] * frame.xDir[0] + d[1] * frame.xDir[1], d[0] * frame.yDir[0] + d[1] * frame.yDir[1]]
}

/**
 * The fit as the frame reads it: positions in frame coordinates, directions
 * turned with it. Radii, lengths, sweeps and residuals are rigid-invariant
 * and ride along untouched — a mirror is rigid too. With no frame the fit IS
 * the reading.
 */
export function fitInFrame(fit: FlatFit, frame: FlatFrame | null): FlatFit {
  if (!frame) return fit
  if (fit.kind === 'point') return { ...fit, at: toFrame(frame, fit.at) }
  if (fit.kind === 'line') {
    return { ...fit, center: toFrame(frame, fit.center), dir: dirInFrame(frame, fit.dir) }
  }
  if (fit.kind === 'circle') return { ...fit, center: toFrame(frame, fit.center) }
  if (fit.kind === 'spline') {
    return {
      ...fit,
      points: fit.points.map((p) => toFrame(frame, p)),
      tangents: fit.tangents.map((t) => dirInFrame(frame, t)),
    }
  }
  // An arc's start angle is measured from +X, which the frame rotates. A
  // mirrored frame also turns the arc's sense round: what ran counter-
  // clockwise from `start` runs clockwise from there as read, so the arc
  // read counter-clockwise begins where the sheet's ended.
  const angle = Math.atan2(frame.xDir[1], frame.xDir[0])
  const start = frameMirrored(frame) ? angle - fit.start - fit.sweep : fit.start - angle
  return { ...fit, center: toFrame(frame, fit.center), start }
}

/**
 * How the sheet is shown on the stage: mirrored first — flipped across the
 * X axis of the alignment, or the document's own — and then rolled by
 * `roll` radians counter-clockwise on screen. The roll brings the
 * alignment's +X to the screen's right, then adds the quarter turns on top
 * of that; the mirror, sitting between the two, keeps +X to the right and
 * sends the frame's +Y down the screen instead of up. Zero and unmirrored
 * shows the sheet as it lies — +X right, +Y up.
 */
export interface SheetPose {
  roll: number
  mirror: boolean
}

/** The pose for an alignment (`xDir`, the frame's unit X in document units,
 *  or null while the sheet is unaligned), whole quarter turns counter-
 *  clockwise, and whether the sheet is shown mirrored. */
export function sheetPose(xDir: Vec2 | null, turns: number, mirror = false): SheetPose {
  const t = ((Math.round(turns) % 4) + 4) % 4
  const align = xDir ? Math.atan2(xDir[1], xDir[0]) : 0
  // Flipping across the alignment's X axis and then rolling it square is the
  // same as flipping across the document's and rolling the other way.
  return { roll: (t * Math.PI) / 2 + (mirror ? align : -align), mirror }
}

/** Cosine and sine of a roll, snapped exact at the quarter turns so a sheet
 *  shown square stays square to the last digit — in the SVG and on screen. */
function rollTrig(roll: number): [number, number] {
  const snap = (v: number): number =>
    Math.abs(v) < 1e-12 ? 0 : Math.abs(v - 1) < 1e-12 ? 1 : Math.abs(v + 1) < 1e-12 ? -1 : v
  return [snap(Math.cos(roll)), snap(Math.sin(roll))]
}

/** A document point as it appears on the sheet as shown: flipped across the
 *  document's X axis if mirrored, then turned about the document origin by
 *  the roll, counter-clockwise. */
export function poseMap(pose: SheetPose): (p: Vec2) => Vec2 {
  const [c, s] = rollTrig(pose.roll)
  // 0 - y rather than -y: a negated zero is a zero that fails an equality.
  const flip = pose.mirror ? (y: number) => 0 - y : (y: number) => y
  return ([x, y]) => {
    const fy = flip(y)
    return [x * c - fy * s, x * s + fy * c]
  }
}

/** The document directions that run to the screen's right and up on a sheet
 *  shown in `pose` — what the camera is told is up. */
export function poseAxes(pose: SheetPose): { right: Vec2; up: Vec2 } {
  const [c, s] = rollTrig(pose.roll)
  // 0 - s rather than -s: a negated zero is a zero that fails an equality.
  return pose.mirror
    ? { right: [c, s], up: [s, 0 - c] }
    : { right: [c, 0 - s], up: [s, c] }
}

/** How the sheet is shown, in words — the quarter turns and the mirror, not
 *  the alignment: 'turned upside down', 'mirrored left-to-right and turned
 *  a quarter turn clockwise' — or '' for a sheet shown as it lies. */
export function describeShown(turns: number, mirror: boolean): string {
  const t = ((Math.round(turns) % 4) + 4) % 4
  if (!mirror) {
    if (t === 0) return ''
    return t === 2
      ? 'turned upside down'
      : t === 1
        ? 'turned a quarter turn counter-clockwise'
        : 'turned a quarter turn clockwise'
  }
  // A mirror across X and a half turn is a mirror across Y: the sheet flipped
  // left-to-right, which is the mirror a scan is shown in to be looked at
  // from above. The quarter turns are told from there.
  const k = (t + 2) % 4
  if (k === 0) return 'mirrored left-to-right'
  if (k === 2) return 'mirrored top-to-bottom'
  return k === 1
    ? 'mirrored left-to-right and turned a quarter turn counter-clockwise'
    : 'mirrored left-to-right and turned a quarter turn clockwise'
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

// SPDX-License-Identifier: AGPL-3.0-only
// The colours a sketch is drawn in, over the part cut open at its plane.
// Three things lie on top of each other there — the stage, the cut face and
// the lines — and the eye belongs on the lines: what is drawn is the work,
// the part and its slice are what it is drawn against. So the part under
// the sheet is veiled towards the stage (the `.viewslot.sketch` scrim in the
// stylesheet), the cut face is a quiet tone one step off the stage, flat and
// unlit (a lit cap seen face on comes out near white), the slice is a thin
// muted line drawn part-way see-through, and the pieces are saturated, at
// full strength and heavier than the slice they were fitted to — a piece
// covers its slice, and the slice shows where the piece leaves it. The
// dimensions are drawn in the sheet's strongest ink. One set for the dark
// instrument, one for the light.

export interface SketchPalette {
  /** The cut face of the part. */
  cap: number
  /** The slice chains — what the pieces are fitted to. */
  slice: string
  sliceOpacity: number
  /** Pieces by where they came from: fitted to the slice, drawn free,
   *  brought in from a body's edge or another sketch, construction only.
   *  A free piece is drawn `free` while a relation or dimension still
   *  leaves it loose, and `constrained` once nothing can move it — the
   *  sketcher's blue-to-black, so a profile reads as finished. */
  fitted: string
  free: string
  constrained: string
  projected: string
  construction: string
  selected: string
  /** What a click would take, under the cursor — and what a relation's
   *  glyph or a dimension's number pointed at holds: brighter than the
   *  selection and drawn heavier, so the two read apart. */
  hover: string
  /** The part's coordinate planes, where they cut the sheet. */
  datum: string
  /** The fill of a closed region. */
  region: string
  /** The dots where pieces end. */
  dot: string
  /** The callout lines of the dimensions. */
  dimension: number
  /** The dashed tracking lines a drawn point is placed level or upright
   *  along. */
  track: string
  /** The stretch a trim would take away, under the cursor. */
  trim: string
}

const DARK: SketchPalette = {
  cap: 0x47535f,
  slice: '#aeb8c4',
  sliceOpacity: 0.5,
  fitted: '#4db8ff',
  free: '#c48bff',
  constrained: '#f2f5f8',
  projected: '#ff7ac8',
  construction: '#9aa5b1',
  selected: '#ffb020',
  hover: '#ffe27a',
  datum: '#e8a33d',
  region: '#3cb371',
  dot: '#ffffff',
  dimension: 0xe8edf2,
  track: '#5ad1e6',
  trim: '#ff5c5c',
}

const LIGHT: SketchPalette = {
  cap: 0xb9bfc6,
  slice: '#4a5560',
  sliceOpacity: 0.5,
  fitted: '#0a63c9',
  free: '#7a3cc9',
  constrained: '#14181d',
  projected: '#c2268a',
  construction: '#5d6875',
  selected: '#e07a00',
  hover: '#ff9d14',
  datum: '#a8660a',
  region: '#1f8a4c',
  dot: '#14181d',
  dimension: 0x14181d,
  track: '#0b8aa0',
  trim: '#d32f2f',
}

export function sketchPalette(dark: boolean): SketchPalette {
  return dark ? DARK : LIGHT
}

/** Line weights of the sketch in pixels at the default Settings → Lines
 *  width: lighter than a measured element's, as a drawing is read for its
 *  shape and not found over an image. */
export const SKETCH_LINE = { piece: 2.5, selected: 3.5, hover: 5, construction: 1.5, datum: 1.2 }

/** The dots on the ends of the pieces, pixels across: enough to say where
 *  one piece stops and the next begins, no more — and the end the Dimension
 *  tool has picked. */
export const SKETCH_DOT = { end: 4, picked: 8, hover: 10, origin: 6 }

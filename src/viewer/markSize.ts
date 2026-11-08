// SPDX-License-Identifier: AGPL-3.0-only
// How large the marks held at a size on the screen are drawn — a point, an
// element's centre, a picked spot, a line's rod, the arrows and bars on an
// element being made, the section gizmo — as a factor on their sizes in
// pixels. The one place the default and the range live, so the settings
// dialog, the preference store and the scene agree.
//
// The sizes are CSS pixels, which the browser already scales by the
// display's pixel ratio: a 6 px point is 12 device pixels on a 2× screen, so
// it stays the same size to the eye. What differs is the eye and the screen:
// on a large monitor at 100 % a 6 px point is small to aim at (issue 47),
// and that is the operator's to choose.

export const MARK_SIZE_DEFAULT = 1
export const MARK_SIZE_MIN = 0.75
export const MARK_SIZE_MAX = 2.5
export const MARK_SIZE_STEP = 0.25

/** Clamp a stored or chosen factor to the range, falling back to the
 *  default for anything that is not a number. */
export function clampMarkSize(value: unknown): number {
  if (value === null || value === undefined || value === '') return MARK_SIZE_DEFAULT
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return MARK_SIZE_DEFAULT
  return Math.min(MARK_SIZE_MAX, Math.max(MARK_SIZE_MIN, Math.round(n / MARK_SIZE_STEP) * MARK_SIZE_STEP))
}

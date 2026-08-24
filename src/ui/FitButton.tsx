// SPDX-License-Identifier: AGPL-3.0-only
// The way back to the part, in every viewport that can be orbited away from it.
//
// Orbiting happens about the point under the cursor and zooming happens towards
// it, which is what makes both feel direct — and is also how a part ends up off
// the frame entirely, with nothing on screen to aim the next gesture at. This
// puts it back without turning it: the viewpoint is the operator's, only the
// centre and the zoom are taken back.
//
// It sits in the bottom-right corner with the axis gizmo, because that corner
// is already where the questions about "where am I looking from" are answered.
// In the main viewport it parks directly above the gizmo, whose size follows
// the viewport's — see SceneManager.drawGizmo, which publishes it as
// --gizmo-size for the stylesheet to offset by.

/** Four corner brackets closing on the middle: the fit-to-view mark every CAD
 *  tool draws, and legible at 14 px where a glyph from the text font is not. */
function FitIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M1.2 5.2V1.2h4M10.8 1.2h4v4M14.8 10.8v4h-4M5.2 14.8h-4v-4" />
      <rect x="5.6" y="5.6" width="4.8" height="4.8" rx="0.6" />
    </svg>
  )
}

export function FitButton({ onFit }: { onFit: () => void }) {
  return (
    <button
      type="button"
      className="viewfit"
      data-test="fit-view"
      title="Fit to view — bring the whole model back on screen, without turning it"
      aria-label="Fit to view"
      onClick={onFit}
    >
      <FitIcon />
    </button>
  )
}

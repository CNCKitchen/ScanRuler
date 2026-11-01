// SPDX-License-Identifier: AGPL-3.0-only
// Parallel or perspective, beside Fit to view. The 3D view is drawn in
// parallel by default — no foreshortening, so edges that run parallel look
// parallel and equal features read the same size anywhere in the frame,
// which is what measuring wants. Perspective is there for seeing a part
// the way the eye does; picks and marking follow whichever is on screen.

import { useStore } from '../state/store'

/** A box drawn the way the view is: square-on in parallel, narrowing to
 *  the back in perspective — the icon shows the mode the view is in. */
function ProjectionIcon({ perspective }: { perspective: boolean }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {perspective ? (
        <path d="M1.5 3.5h13l-3 3h-7zM4.5 6.5v6h7v-6M1.5 3.5v11l3-2M14.5 3.5v11l-3-2M1.5 14.5h13" />
      ) : (
        <path d="M2 4.5h9v9H2zM2 4.5l3-3h9l-3 3M11 13.5l3-3v-9" />
      )}
    </svg>
  )
}

export function ProjectionButton() {
  const projection = useStore((s) => s.projection)
  const setProjection = useStore((s) => s.setProjection)
  const perspective = projection === 'perspective'
  return (
    <button
      type="button"
      className="viewfit viewprojection"
      data-test="view-projection"
      title={perspective
        ? 'Perspective view — click to draw the view in parallel (orthographic), as measuring wants it'
        : 'Parallel (orthographic) view — click to draw the view in perspective'}
      aria-label={perspective ? 'Perspective view' : 'Orthographic view'}
      aria-pressed={perspective}
      onClick={() => setProjection(perspective ? 'orthographic' : 'perspective')}
    >
      <ProjectionIcon perspective={perspective} />
    </button>
  )
}

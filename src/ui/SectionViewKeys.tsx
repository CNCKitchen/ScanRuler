// SPDX-License-Identifier: AGPL-3.0-only
// The section view's own row in the view bar while it is on: what the plane
// is laid across, where along it, which half goes, and — once the gizmo's
// rings have tilted it — how far off square it stands. See
// state/sectionViewStore.

import { isWorldAxis, SECTION_REF_KINDS, tiltOf } from '../core/section/frame'
import type { Vec3 } from '../core/types'
import { sectionViewFrames, useSectionView } from '../state/sectionViewStore'
import { useStore } from '../state/store'
import { Icon } from './icons'
import { providersFor } from './RefSelect'
import { PlaneRefOptions } from './SectionEditor'
import { typedFigure, useFieldUnits } from './NumberField'

export function SectionViewKeys({ viewDirection }: { viewDirection: () => Vec3 }) {
  const ref = useSectionView((s) => s.ref)
  // The offset is held in millimetres and typed in the units shown.
  const u = useFieldUnits('length', undefined)
  const axis = useSectionView((s) => s.axis)
  const refDir = useSectionView((s) => s.refDir)
  const offset = useSectionView((s) => s.offset)
  const flipped = useSectionView((s) => s.flipped)
  const setRef = useSectionView((s) => s.setRef)
  const setOffset = useSectionView((s) => s.setOffset)
  const flip = useSectionView((s) => s.flip)
  const elements = useStore((s) => s.elements)

  const options = providersFor(['plane', 'axis'], elements, undefined, SECTION_REF_KINDS)
  const frames = sectionViewFrames({ on: true, axis, offset, flipped })
  const tilt = frames ? tiltOf(refDir, frames.gizmo.normal) : 0
  // Laid across an element since deleted: the plane stays where it was.
  const orphan = !isWorldAxis(ref) && !options.some((e) => e.id === ref)

  return (
    <div className="keys sectionkeys" data-test="section-view-keys">
      <label title="What the plane is laid across: a coordinate plane through the part’s middle, or an element with a direction — a plane’s normal, the axis of a cylinder, cone or line, a circle’s normal. The half toward you is taken away.">
        <span>Across</span>
        <select
          data-test="section-view-ref"
          value={orphan ? '' : String(ref)}
          onChange={(e) => {
            const v = e.target.value
            if (v) setRef(isWorldAxis(v) ? v : Number(v), viewDirection())
          }}
        >
          {orphan && <option value="">(deleted element)</option>}
          <PlaneRefOptions options={options} />
        </select>
      </label>
      {/* A plane still square to a coordinate axis has a coordinate, not an
          offset: its Z is what the field holds. */}
      <label title="Where along its direction the plane lies — drag the arrow on the part, or type it here">
        <span>{isWorldAxis(ref) && tilt === 0 ? ref.toUpperCase() : 'Offset'}</span>
        <input
          type="number"
          step="any"
          data-test="section-view-offset"
          // Re-keyed on the value, so the arrow dragged on the part types
          // itself into the field.
          key={u.text(round(offset))}
          defaultValue={u.text(round(offset))}
          onBlur={(e) => {
            // Text left as it was shown commits nothing: in inches it is
            // rounded, and committing it back would move the plane.
            const typed = typedFigure(e.target)
            if (e.target.value !== u.text(round(offset)) && typed !== null) setOffset(u.read(typed))
            e.target.value = u.text(round(useSectionView.getState().offset))
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
        <span className="unit">{u.word}</span>
      </label>
      {tilt > 0 && !orphan && (
        <button
          data-test="section-view-square"
          onClick={() => setRef(ref)}
          title="The rings have tilted the plane off what it was laid across — turn it square again"
        >
          Square
          <span className="tilt">{tilt.toFixed(1)}°</span>
        </button>
      )}
      <button data-test="section-view-flip" onClick={flip} title="Take away the other half instead">
        <Icon name="flip" size={16} />
        Flip
      </button>
    </div>
  )
}

/** Three decimals is a micrometre — past what an arrow dragged across the
 *  screen means, and enough for anything typed. */
function round(v: number): number {
  return Math.round(v * 1000) / 1000
}

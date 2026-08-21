// SPDX-License-Identifier: AGPL-3.0-only
// Aligning the element being made to a reference plane: which plane, how it
// relates to it, and how far the measurement was from that relation — with a
// warning once it is further off than an aligned feature ought to be.

import { InfoDot } from './InfoDot'
import { RefSelect } from './RefSelect'
import { blockedRefs, orientedDraft, useStore } from '../state/store'
import {
  ORIENT_TOLERANCE_DEG,
  relationLabel,
  type OrientRelation,
  type OrientableFit,
} from '../core/elements/orient'

export function OrientFields({ fit }: { fit: OrientableFit }) {
  const draft = useStore((s) => s.draft)
  const elements = useStore((s) => s.elements)
  const setDraftOrientRef = useStore((s) => s.setDraftOrientRef)
  const setDraftOrientRelation = useStore((s) => s.setDraftOrientRelation)
  if (!draft) return null

  // Any plane that does not build on the element being edited.
  const blocked = blockedRefs(draft.editId, elements)
  const planes = elements.filter((e) => e.kind === 'plane' && e.fit && !blocked.has(e.id))
  if (planes.length === 0) return null

  const orient = draft.orient
  const { deviationDeg, warning } = orientedDraft({ fit, orient }, elements)
  const planar = fit.kind === 'plane' || fit.kind === 'circle'

  return (
    <div className="extend">
      <div className="g-label">
        <span>
          Align
          <InfoDot title="Aligning to a reference plane">
            <p>
              Turn the element onto its <b>designed</b> relation with a reference plane instead of
              keeping the direction the fit found: a face parallel to the base, a bore perpendicular
              to it, an axis running along it. The element keeps its measured position and size and
              pivots about its own centre by the smallest rotation that gets it there.
            </p>
            <p>
              Unlike an extension, this does change the element: its normal or axis, every dimension
              taken from it and what CAD receives. Sigma and form error stay the measurement's, and
              the unaligned fit is kept so the alignment follows the reference plane if that is ever
              edited or re-fitted. Deleting the reference drops the alignment and the element falls
              back to its measurement.
            </p>
            <p>
              The panel reports how far the measurement was from the aligned direction, and warns
              past {ORIENT_TOLERANCE_DEG}°: a scanned feature that was made square comes out well
              under a degree off, so more than that usually means the wrong reference, the wrong
              relation — or a feature that was never designed square.
            </p>
          </InfoDot>
        </span>
        {orient && (
          <span data-test="orient-deviation">measured {deviationDeg.toFixed(2)}° off</span>
        )}
      </div>
      <RefSelect
        label="Reference"
        options={planes}
        value={orient?.ref ?? null}
        testId="orient-ref"
        placeholder="None — as measured"
        onChange={(id) => setDraftOrientRef(id)}
      />
      {orient && (
        <label className="field">
          <span>{planar ? 'Plane is' : 'Axis is'}</span>
          <select
            data-test="orient-relation"
            value={orient.relation}
            onChange={(e) => setDraftOrientRelation(e.target.value as OrientRelation)}
          >
            {(['normal', 'inPlane'] as OrientRelation[]).map((r) => (
              <option key={r} value={r}>
                {relationLabel(fit.kind, r)}
              </option>
            ))}
          </select>
        </label>
      )}
      {orient && warning !== null && (
        <p className="warnnote" data-test="orient-warning">
          ⚠ {warning}
        </p>
      )}
    </div>
  )
}

// SPDX-License-Identifier: AGPL-3.0-only
// The box a section is made or edited in: what to cut across — an element,
// or one of the scan's coordinate planes — the offset along its direction,
// typed here or dragged on the part, the tilt the gizmo's rings have given
// it, and what the cut produces. Renders nothing without a section draft.

import { cutSummary } from '../core/section/slice'
import {
  isWorldAxis,
  SECTION_REF_KINDS,
  sectionRefName,
  tiltOf,
  WORLD_AXES,
  worldPlaneName,
  type SectionRef,
} from '../core/section/frame'
import { sectionDraftColorOf, sectionDraftReady, useStore } from '../state/store'
import { InfoDot } from './InfoDot'
import { NameField, providersFor } from './RefSelect'

export function SectionEditor({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void
  onConfirm: () => void
}) {
  const draft = useStore((s) => s.sectionDraft)
  const elements = useStore((s) => s.elements)
  const sections = useStore((s) => s.sections)
  const color = useStore(sectionDraftColorOf)
  const setRef = useStore((s) => s.setSectionDraftRef)
  const setOffset = useStore((s) => s.setSectionDraftOffset)
  const setName = useStore((s) => s.setSectionDraftName)

  if (draft === null) return null

  const edited = draft.editId !== undefined ? sections.find((x) => x.id === draft.editId) : undefined
  const options = providersFor(['plane', 'axis'], elements, undefined, SECTION_REF_KINDS)
  const summary = draft.cut ? cutSummary(draft.cut) : null
  const ready = sectionDraftReady(draft)
  const orphan = draft.axis !== null && draft.ref === null
  const tilt = draft.frame ? tiltOf(draft.refDir, draft.frame.normal) : 0
  const refName = sectionRefName(draft.ref, elements)

  const hint = !draft.axis
    ? 'Choose what to cut across — click an element or one of the XY, YZ, XZ planes in the viewport, or pick it above. The plane runs across an element’s direction: a plane’s normal, the axis of a cylinder, cone or line, a circle’s normal.'
    : orphan
      ? 'The element this was cut along has gone; the plane stays where it was. Slide or tilt it with the gizmo, or choose another element to move it.'
      : 'Slide the plane along its direction — drag the arrow, or type the offset — and tilt it by dragging one of the rings, then create.'

  return (
    <div className="draftbox" style={{ borderLeftColor: color }} data-test="section-editor">
      <div className="sec-head">
        <span className="dot" style={{ background: color }} />
        {edited ? `Edit ${edited.name}` : 'New section'}
        <InfoDot title="Sections">
          <p>
            A section is the scan cut with a plane. It becomes a <b>source in the 2D Measure
            workspace</b>, listed there beside the flatbed image: the cut’s edges lie on the
            sheet in millimetres, ready to be snapped to, fitted and measured exactly like a
            scan image’s edges.
          </p>
          <p>
            The plane is taken <b>across an element’s direction</b> — a plane’s normal, the
            axis of a cylinder, cone or line, a circle’s normal — or across one of the scan’s
            <b> coordinate axes</b>: while nothing is chosen, the XY, YZ and XZ planes are
            offered through the part’s centre, and clicking one takes it. The plane is moved
            along its direction by the offset. Zero cuts through the element’s own centre — for
            a face that is the face itself, so offset into the part to cut through its walls —
            and for a coordinate plane the offset is the plane’s coordinate on that axis.
          </p>
          <p>
            The gizmo on the plane <b>slides</b> it by the arrow and <b>tilts</b> it by the two
            rings, each about one of the sheet’s own axes through the point the gizmo sits on. A
            tilted plane is recorded with its tilt off what it was taken across; <b>Square</b>{' '}
            turns it back.
          </p>
          <p>
            The plane is fixed when the section is created. Re-fitting or deleting the element
            it was cut along leaves the section where it is; a datum alignment moves it with
            the part.
          </p>
        </InfoDot>
      </div>

      {draft.editId !== undefined && (
        <NameField value={draft.name ?? ''} testId="section-name" onChange={setName} />
      )}

      <label className="field">
        <span>Cut along</span>
        <select
          data-test="section-ref"
          value={draft.ref ?? ''}
          onChange={(e) => setRef(parseRef(e.target.value))}
        >
          <option value="">{orphan ? '(deleted element)' : 'Select…'}</option>
          <optgroup label="Coordinate planes">
            {WORLD_AXES.map((a) => (
              <option key={a} value={a}>
                {worldPlaneName(a)}
              </option>
            ))}
          </optgroup>
          {options.length > 0 && (
            <optgroup label="Elements">
              {options.map((el) => (
                <option key={el.id} value={el.id}>
                  {el.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>

      <label className="field">
        {/* A plane still square to a coordinate axis has a coordinate, not an
            offset: its Z is what the field holds. */}
        <span>{isWorldAxis(draft.ref) && tilt === 0 ? `${draft.ref.toUpperCase()} (mm)` : 'Offset (mm)'}</span>
        <input
          type="number"
          step="any"
          data-test="section-offset"
          disabled={!draft.axis}
          // Re-keyed on the value, so a grip dragged in the viewport types
          // itself into the field.
          key={round(draft.offset)}
          defaultValue={round(draft.offset)}
          onBlur={(e) => {
            const v = Number(e.target.value)
            if (Number.isFinite(v)) setOffset(v)
            e.target.value = String(round(draft.offset))
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
      </label>

      {tilt > 0 && (
        <div className="field">
          <span>Tilt</span>
          <span className="tilt" data-test="section-tilt">
            {tilt.toFixed(1)}°{refName ? ` off ${refName}` : ''}
            {draft.ref !== null && (
              <button
                type="button"
                data-test="section-square"
                title="Turn the plane square to what it was taken across again"
                onClick={() => setRef(draft.ref)}
              >
                Square
              </button>
            )}
          </span>
        </div>
      )}

      <p className="hint" data-test="section-hint">
        {hint}
      </p>

      <div className="dro">
        <div className="dro-label">
          <span>Cut</span>
          {summary && <span data-test="section-points">{summary.points.toLocaleString('en-US')} points</span>}
        </div>
        <div
          className={
            'dro-window ' +
            draft.status +
            (draft.status === 'slicing' ? ' working' : draft.status === 'failed' ? ' alarm' : '')
          }
          data-test="section-status"
        >
          {draft.status === 'empty' && (
            <b style={{ fontSize: 12, fontWeight: 400, color: 'var(--dim)' }}>No element chosen</b>
          )}
          {draft.status === 'slicing' && (
            <b>
              <span className="spinner" />
              Cutting…
            </b>
          )}
          {draft.status === 'failed' && <b>{draft.message ?? 'Failed'}</b>}
          {draft.status === 'ready' &&
            (summary && summary.chains > 0 ? (
              <b style={{ fontSize: 13, color }}>
                {summary.chains} edge chain{summary.chains === 1 ? '' : 's'}
              </b>
            ) : (
              <b style={{ fontSize: 12, fontWeight: 400, color: 'var(--dim)' }}>
                The plane misses the scan
              </b>
            ))}
        </div>
      </div>

      <button
        className="primary block"
        data-test="create-section"
        disabled={!ready}
        onClick={onConfirm}
      >
        {edited ? 'Save changes' : 'Create section'}
      </button>
      <div className="toolrow">
        <button data-test="cancel-section" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

/** The select's value back into a reference: an axis letter, an element id,
 *  or nothing. */
function parseRef(value: string): SectionRef | null {
  if (value === '') return null
  if (isWorldAxis(value)) return value
  return Number(value)
}

/** Three decimals is a micrometre — past what a grip dragged across the
 *  screen means, and enough for anything typed. */
function round(v: number): number {
  return Math.round(v * 1000) / 1000
}

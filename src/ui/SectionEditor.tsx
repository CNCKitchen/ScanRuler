// SPDX-License-Identifier: AGPL-3.0-only
// The box a section is made or edited in: the element to cut along, the
// offset along its direction — typed here or dragged on the part — and what
// the cut produces. Renders nothing without a section draft.

import { cutSummary } from '../core/section/slice'
import { SECTION_REF_KINDS } from '../core/section/frame'
import { sectionDraftColorOf, sectionDraftReady, useStore } from '../state/store'
import { InfoDot } from './InfoDot'
import { NameField, providersFor, RefSelect } from './RefSelect'

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

  const hint = !draft.axis
    ? 'Choose the element to cut along — click it in the viewport, or pick it above. The plane runs across its direction: a plane’s normal, the axis of a cylinder, cone or line, a circle’s normal.'
    : orphan
      ? 'The element this was cut along has gone; the plane stays where it was. Slide the offset along it, or choose another element to move it.'
      : 'Slide the plane along the element’s direction — drag the arrow on the part, or type the offset — then create.'

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
            axis of a cylinder, cone or line, a circle’s normal — and moved along it by the
            offset. Zero cuts through the element’s own centre: for a face that is the face
            itself, so offset into the part to cut through its walls.
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

      <RefSelect
        label="Cut along"
        options={options}
        value={draft.ref}
        testId="section-ref"
        placeholder={orphan ? '(deleted element)' : 'Select…'}
        onChange={setRef}
      />

      <label className="field">
        <span>Offset (mm)</span>
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

/** Three decimals is a micrometre — past what a grip dragged across the
 *  screen means, and enough for anything typed. */
function round(v: number): number {
  return Math.round(v * 1000) / 1000
}

// SPDX-License-Identifier: AGPL-3.0-only
// The box a flat element is created or edited in — the 2D twin of
// DraftEditor, in the same shape so an operator who knows one knows the
// other: name when editing, the creation method, the hint, a DRO preview of
// the pending fit, then create / save, undo, cancel. Renders nothing
// without a draft.

import { flatMethod, flatMethodsForKind } from '../core/flat/construct'
import { datumFrame, fitInFrame } from '../core/flat/datum'
import { FLAT_KIND_LABELS } from '../core/flat/elements'
import { FLAT_ROLE_PROVIDERS } from '../core/flat/refs'
import { formatFlatDetail, formatFlatPrimary } from '../core/flat/summary'
import { flatBlockedRefs, flatDraftColorOf, useFlat } from '../state/flatStore'
import { DroValue } from './DroValue'
import { NameField, RefSelect } from './RefSelect'

export function FlatDraftEditor() {
  const elements = useFlat((s) => s.elements)
  const draft = useFlat((s) => s.draft)
  const draftColor = useFlat(flatDraftColorOf)
  const pxPerMm = useFlat((s) => s.pxPerMm)
  const datum = useFlat((s) => s.datum)
  const setDraftMethod = useFlat((s) => s.setDraftMethod)
  const setDraftName = useFlat((s) => s.setDraftName)
  const setDraftRef = useFlat((s) => s.setDraftRef)
  const undoDraftPick = useFlat((s) => s.undoDraftPick)
  const cancelDraft = useFlat((s) => s.cancelDraft)
  const commitDraft = useFlat((s) => s.commitDraft)

  if (draft === null) return null

  const method = flatMethod(draft.method)
  const kindMethods = flatMethodsForKind(draft.kind)
  const noun = FLAT_KIND_LABELS[draft.kind].toLowerCase()
  const edited = draft.editId !== undefined ? elements.find((e) => e.id === draft.editId) : undefined
  const blocked = flatBlockedRefs(draft.editId, elements)
  const unit = pxPerMm ? 'mm' : 'px'
  const frame = datum ? datumFrame(datum, pxPerMm) : null
  const minPicks = method.minPicks ?? 1
  const picks = draft.picks.length
  const saveWord = edited ? 'save it' : 'create it'

  // What to do next, in one line — the method's own hint until the first
  // pick lands, then where the fit stands.
  const pickHint =
    method.mode === 'construct'
      ? method.hint
      : picks === 0
        ? method.hint
        : method.mode === 'edge'
          ? draft.fit
            ? `Drag another box to add more edge points, or ${saveWord}.`
            : `${picks.toLocaleString('en-US')} edge points — not enough for a fit yet; drag a longer box.`
          : draft.kind === 'point'
            ? `Drag the pin to move it, click to place it again, or ${saveWord}.`
            : picks < minPicks
              ? `${minPicks - picks} more point${minPicks - picks === 1 ? '' : 's'} to go — spread them along the ${noun}. Pins can be dragged.`
              : `More points refine the fit, drag a pin to move it, or ${saveWord}.`

  const status = draft.fit ? 'ready' : draft.error ? 'failed' : 'empty'
  const primary = draft.fit ? formatFlatPrimary(fitInFrame(draft.fit, frame), unit) : ''

  return (
    <div className="draftbox" style={{ borderLeftColor: draftColor }}>
      <div className="sec-head">
        <span className="dot" style={{ background: draftColor }} />
        {edited ? `Edit ${edited.name}` : `New ${noun}`}
      </div>

      {draft.editId !== undefined && (
        <NameField value={draft.name ?? ''} testId="flat-draft-name" onChange={setDraftName} />
      )}

      {kindMethods.length > 1 && (
        <label className="field">
          <span>Created</span>
          <select
            data-test="flat-draft-method"
            value={draft.method}
            onChange={(e) => setDraftMethod(e.target.value)}
          >
            {kindMethods.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      )}

      <p className="hint" data-test="flat-draft-hint">
        {pickHint}
      </p>

      {method.slots?.map((slot, i) => (
        <RefSelect
          key={slot.label + i}
          label={slot.label}
          options={elements.filter(
            (el) =>
              el.fit &&
              !blocked.has(el.id) &&
              FLAT_ROLE_PROVIDERS[slot.role].includes(el.kind) &&
              !draft.refs.some((r, j) => j !== i && r === el.id),
          )}
          value={draft.refs[i] ?? null}
          testId={`flat-draft-slot-${i}`}
          onChange={(id) => setDraftRef(i, id)}
        />
      ))}

      <div className="dro">
        <div className="dro-label">
          <span>Preview</span>
          {method.mode !== 'construct' && (
            <span data-test="flat-draft-picks">
              {method.mode === 'edge'
                ? `${picks.toLocaleString('en-US')} edge points`
                : `${picks} pick${picks === 1 ? '' : 's'}`}
            </span>
          )}
        </div>
        <div
          className={'dro-window ' + status + (status === 'failed' ? ' alarm' : '')}
          data-test="flat-draft-status"
        >
          {status === 'empty' && (
            <b style={{ fontSize: 12, fontWeight: 400, color: 'var(--dim)' }}>
              {method.mode === 'construct'
                ? 'Incomplete'
                : picks > 0
                  ? `${picks.toLocaleString('en-US')} of ${minPicks} points`
                  : 'No points picked'}
            </b>
          )}
          {status === 'failed' && <b>{draft.error}</b>}
          {status === 'ready' &&
            (draft.fit!.kind === 'circle' || draft.fit!.kind === 'arc' ? (
              <DroValue value={primary} color={draftColor} />
            ) : (
              <b style={{ fontSize: 13, color: draftColor }}>{primary}</b>
            ))}
        </div>
        {status === 'ready' && formatFlatDetail(draft.fit!, unit) && (
          <div className="dro-note">{formatFlatDetail(draft.fit!, unit)}</div>
        )}
      </div>

      <button
        className="primary block"
        data-test="flat-create-element"
        disabled={!draft.fit}
        onClick={() => commitDraft()}
      >
        {edited ? 'Save changes' : `Create ${noun}`}
      </button>
      <div className="toolrow">
        {method.mode !== 'construct' && (
          <button data-test="flat-draft-undo" disabled={picks === 0} onClick={undoDraftPick}>
            {method.mode === 'edge' ? 'Clear points' : 'Undo point'}
          </button>
        )}
        <button data-test="flat-draft-cancel" onClick={cancelDraft}>
          Cancel
        </button>
      </div>
    </div>
  )
}

// SPDX-License-Identifier: AGPL-3.0-only
// The box an element is created or edited in, plus the Fitting group that
// rides along while a surface fit is open. Renders nothing without a draft.

import { hasDiameter } from '../core/elements/assumed'
import { creationMethod, methodsForKind } from '../core/elements/construct'
import { isExtendable } from '../core/elements/extend'
import { elementKindInfo } from '../core/elements/kinds'
import { formatDetail, formatPrimary, SIGMA_LABELS } from '../core/summary'
import type { SigmaPreset } from '../core/types'
import { useMark } from '../state/markStore'
import { blockedRefs, draftColorOf, useStore, type SelectMode } from '../state/store'
import { usePulse } from '../app/useHints'
import { AssumedField } from './AssumedField'
import { DroValue } from './DroValue'
import { ExtendFields } from './ExtendFields'
import { InfoDot } from './InfoDot'
import { MarkTools } from './MarkTools'
import { NameField, RefSelect } from './RefSelect'

export function DraftEditor({
  onSelectMode,
  onClearPaint,
  onUndoPick,
  onCancelDraft,
  onConfirmDraft,
}: {
  /** Switch between clicking a point and marking the surface by hand. */
  onSelectMode: (mode: SelectMode) => void
  /** Rub out the whole hand-marked surface. */
  onClearPaint: () => void
  onUndoPick: () => void
  onCancelDraft: () => void
  onConfirmDraft: () => void
}) {
  const busy = useStore((s) => s.busy)
  const elements = useStore((s) => s.elements)
  const draft = useStore((s) => s.draft)
  const draftColor = useStore(draftColorOf)
  const settings = useStore((s) => s.settings)
  const setSigma = useStore((s) => s.setSigma)
  const setDraftMethod = useStore((s) => s.setDraftMethod)
  const setDraftName = useStore((s) => s.setDraftName)
  const setDraftRef = useStore((s) => s.setDraftRef)
  const setDraftParam = useStore((s) => s.setDraftParam)
  const selectMode = useStore((s) => s.selectMode)
  // The marking itself is the shared tool set (markStore / MarkTools); the
  // panel only needs to know how much surface it has taken.
  const markGesture = useMark((s) => s.gesture)
  const paintCount = useMark((s) => s.count)
  // Named as the step from the moment the draft opens; the ring itself waits
  // for the fit, because a disabled control never wears one.
  const pulse = usePulse('create-element')

  const draftKind = draft && elementKindInfo(draft.kind)
  const method = draft && creationMethod(draft.kind, draft.method)
  const kindMethods = draft ? methodsForKind(draft.kind) : []
  // The element the open draft writes back to, if it is an edit rather than a
  // new element, and what such a draft must not be built on.
  const edited = draft?.editId !== undefined ? elements.find((e) => e.id === draft.editId) : undefined
  const blocked = blockedRefs(draft?.editId, elements)

  // Marking the surface by hand replaces the click-and-grow flow, so it only
  // exists for the kinds that are fitted to the scan at all.
  const paintingSurface = draft !== null && method?.mode === 'fit' && selectMode === 'paint'
  const pickHint =
    !draft || !draftKind || !method
      ? ''
      : paintingSurface
        ? markGesture === null
          ? `Pick a marking tool above, then drag over the ${draftKind.noun}.`
          : paintCount === 0
            ? `Drag over the ${draftKind.noun} to mark it.`
            : 'Keep marking to add more; right-drag rubs out.'
        : draft.picks.length === 0 && draft.status !== 'ready'
          ? method.hint
          : method.mode === 'pick'
            ? draft.kind === 'point'
              ? `Click again to move the point, or ${edited ? 'save it' : 'create it'}.`
              : draft.picks.length < (method.minPicks ?? 1)
                ? `${(method.minPicks ?? 1) - draft.picks.length} more point${
                    (method.minPicks ?? 1) - draft.picks.length === 1 ? '' : 's'
                  } to go — spread them around the ${draftKind.noun}.`
                : `More points refine the fit, or ${edited ? 'save it' : 'create it'}.`
            : `Add more points if the ${draftKind.noun} is split across unconnected patches.`

  if (draft === null) return null

  return (
    <>
      {draftKind !== null && method !== null && (
        <div className="draftbox" style={{ borderLeftColor: draftColor }}>
          <div className="sec-head">
            <span className="dot" style={{ background: draftColor }} />
            {edited ? `Edit ${edited.name}` : `New ${draftKind.noun}`}
          </div>

          {draft.editId !== undefined && (
            <NameField
              value={draft.name ?? ''}
              testId="draft-name"
              onChange={(name) => setDraftName(name)}
            />
          )}

          {kindMethods.length > 1 && (
            <label className="field">
              <span>Created</span>
              <select
                data-test="draft-method"
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

          {method.mode === 'fit' && (
            <label className="field">
              <span>
                Surface
                <InfoDot title="Which surface is fitted">
                  <p>
                    <b>Found from a click:</b> click once on the feature and the patch grows outward
                    across the scan on its own, stopping where the surface stops being flat or round
                    enough to belong. Fast, and right most of the time.
                  </p>
                  <p>
                    <b>Marked by hand:</b> take exactly the triangles you want — with a window, a
                    round brush or a lasso, the same three tools the deviation workspace marks a
                    local fine fit with. Use it when a click runs off across a fillet, when noise
                    breaks the feature into unconnected patches, or when only part of a face is
                    worth trusting.
                  </p>
                  <p>
                    Nothing is armed until you pick one of them: while a tool is live it takes both
                    plain drags — left marks, right rubs out — and <b>Navigate</b> or Esc hands them
                    back to the camera. Shift-drag orbits either way.
                  </p>
                </InfoDot>
              </span>
              <select
                data-test="draft-select-mode"
                value={selectMode}
                onChange={(e) => onSelectMode(e.target.value as SelectMode)}
              >
                <option value="auto">Found from a click</option>
                <option value="paint">Marked by hand</option>
              </select>
            </label>
          )}

          {paintingSurface && (
            <MarkTools
              showCount={false}
              escapeNote="Esc a second time discards the element."
              onClear={onClearPaint}
            />
          )}

          {method.mode === 'construct' ? (
            <>
              <p className="hint">{method.hint}</p>
              {method.slots.map((slot, i) => (
                <RefSelect
                  key={i}
                  label={slot.label}
                  roles={[slot.role]}
                  kinds={slot.kinds}
                  value={draft.refs[i]}
                  elements={elements}
                  blocked={blocked}
                  testId={`draft-ref-${i}`}
                  onChange={(id) => setDraftRef(i, id)}
                />
              ))}
              {method.params.map((p, i) => (
                <label className="field" key={p.key}>
                  <span>
                    {p.label}
                    {p.unit ? ` (${p.unit})` : ''}
                  </span>
                  <input
                    type="number"
                    step="any"
                    data-test={`draft-param-${p.key}`}
                    value={Number.isFinite(draft.params[i]) ? draft.params[i] : ''}
                    onChange={(e) =>
                      setDraftParam(i, e.target.value === '' ? NaN : Number(e.target.value))
                    }
                  />
                </label>
              ))}
            </>
          ) : (
            <p className="hint">{pickHint}</p>
          )}

          <div className="dro">
            <div className="dro-label">
              <span>Preview</span>
              {paintingSurface ? (
                <span data-test="paint-count">
                  {paintCount.toLocaleString('en-US')} point
                  {paintCount === 1 ? '' : 's'} marked
                </span>
              ) : (
                method.mode !== 'construct' && (
                  <span>
                    {draft.picks.length} pick
                    {draft.picks.length === 1 ? '' : 's'}
                  </span>
                )
              )}
            </div>
            <div
              className={
                'dro-window ' +
                draft.status +
                (draft.status === 'fitting'
                  ? ' working'
                  : draft.status === 'failed'
                    ? ' alarm'
                    : '')
              }
              data-test="draft-status"
            >
              {draft.status === 'empty' && (
                <b style={{ fontSize: 12, fontWeight: 400, color: 'var(--dim)' }}>
                  {method.mode === 'construct'
                    ? 'Incomplete'
                    : paintingSurface
                      ? 'Nothing marked'
                      : draft.picks.length > 0
                        ? `${draft.picks.length} of ${method.minPicks ?? 1} points`
                        : 'No points picked'}
                </b>
              )}
              {draft.status === 'fitting' && (
                <b>
                  <span className="spinner" />
                  Fitting…
                </b>
              )}
              {draft.status === 'failed' && <b>{draft.message ?? 'Failed'}</b>}
              {draft.status === 'ready' &&
                (() => {
                  const primary = formatPrimary(draft.fit!)
                  if (draft.fit!.kind === 'point' || draft.fit!.kind === 'line' || primary === '') {
                    return <b style={{ color: draftColor }}>✓ {draftKind.label}</b>
                  }
                  return <DroValue value={primary} color={draftColor} />
                })()}
            </div>
            {draft.status === 'ready' && <div className="dro-note">{formatDetail(draft.fit!)}</div>}
          </div>

          {/* The design value behind the measurement, for the kinds defined by
              a diameter — what an assumed-dimension STEP export writes. */}
          {draft.status === 'ready' && hasDiameter(draft.fit) && <AssumedField fit={draft.fit} />}

          {/* How much of the measured surface to draw, once there is one. A
              cylinder and a plane are the two elements whose size on screen is
              a drawing decision rather than the measurement itself. */}
          {draft.status === 'ready' && isExtendable(draft.fit) && <ExtendFields fit={draft.fit} />}

          <button
            className={pulse ? 'primary block pulse' : 'primary block'}
            data-test="create-element"
            disabled={draft.status !== 'ready'}
            onClick={onConfirmDraft}
          >
            {edited ? 'Save changes' : `Create ${draftKind.noun}`}
          </button>
          <div className="toolrow">
            {method.mode !== 'construct' && !paintingSurface && (
              <button disabled={draft.picks.length === 0} onClick={onUndoPick}>
                Undo point
              </button>
            )}
            <button data-test="cancel-draft" onClick={onCancelDraft}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {method?.mode === 'fit' && (
        <div className="group">
          <div className="g-label">
            <span>Fitting</span>
          </div>
          <label className="field">
            <span>Method</span>
            <select value={settings.method} disabled>
              <option value="gaussian">Gaussian best-fit</option>
            </select>
          </label>
          <label className="field">
            <span>
              Used points
              <InfoDot title="Used points">
                <p>
                  Every element is a Gaussian best fit — the plane, cylinder or sphere that
                  minimises the squared distance to the points taken from the scan.
                </p>
                <p>
                  This is the outlier cut-off. Points further from that first fit than the chosen
                  multiple of the standard deviation are dropped and the fit is repeated, so scan
                  noise, a stray edge triangle or a speck of spray cannot drag the result. Tighter
                  cut-offs give a cleaner element from fewer points; <i>all points</i> keeps
                  everything.
                </p>
                <p>
                  The setting is global: changing it re-fits every element from the points it was
                  built on.
                </p>
              </InfoDot>
            </span>
            <select
              value={settings.sigma}
              disabled={busy}
              onChange={(e) => setSigma(Number(e.target.value) as SigmaPreset)}
            >
              {([3, 2, 1, 0] as SigmaPreset[]).map((k) => (
                <option key={k} value={k}>
                  {SIGMA_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </>
  )
}

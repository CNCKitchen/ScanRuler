// SPDX-License-Identifier: AGPL-3.0-only
// The left faceplate: everything the operator sets, and every number the tool
// reports. Controls at the top, readouts below, in the order the work happens.

import { useState } from 'react'
import { alignSlotPicks, elementColor, useStore, type Element } from '../state/store'
import { ELEMENT_KINDS, elementKindInfo } from '../core/elements/kinds'
import { creationMethod, methodsForKind } from '../core/elements/construct'
import { providesRole, type RefRole } from '../core/elements/refs'
import {
  ALIGN_PICK_COUNT,
  AlignmentError,
  AXIS_DIRS,
  axisDirLabel,
  axisIndex,
  computeDatumAlignment,
  describeRigid,
  fitFromAlignPicks,
  manualRigid,
  type AlignSlot,
  type AxisDir,
} from '../core/alignment'
import type { Rigid } from '../core/deviation/rigid'
import {
  DIMENSION_TYPES,
  dimensionTypeInfo,
  evaluateDimension,
  evaluateDimensions,
  type DimensionValue,
  type SphereAnchor,
} from '../core/dimensions'
import { formatDetail, formatPrimary, SIGMA_LABELS } from '../core/summary'
import type { ElementKind, FitData, SigmaPreset } from '../core/types'
import { ModelSlot } from './ModelSlot'

/** The six inputs of the manual move / rotate box, in the order the values
 *  are stored. */
const MANUAL_FIELDS = [
  { key: 'mx', label: 'Move X', unit: 'mm' },
  { key: 'my', label: 'Move Y', unit: 'mm' },
  { key: 'mz', label: 'Move Z', unit: 'mm' },
  { key: 'rx', label: 'Rotate about X', unit: '°' },
  { key: 'ry', label: 'Rotate about Y', unit: '°' },
  { key: 'rz', label: 'Rotate about Z', unit: '°' },
] as const

/** Split a formatted measurement into digits and unit so the DRO window can
 *  set them apart the way an instrument does — big number, small legend. */
function splitValue(value: string): [string, string] {
  if (value.endsWith('°')) return [value.slice(0, -1), 'DEG']
  const cut = value.lastIndexOf(' ')
  return cut < 0 ? [value, ''] : [value.slice(0, cut), value.slice(cut + 1).toUpperCase()]
}

/** Elements that can fill a reference slot of one of the given roles. */
function providersFor(roles: readonly RefRole[], elements: Element[]): Element[] {
  return elements.filter((e) => e.fit && roles.some((role) => providesRole(e.kind, role)))
}

/** One reference-slot dropdown, shared by constructions, dimensions and the
 *  alignment datums. */
function RefSelect({
  label,
  roles,
  value,
  elements,
  testId,
  picking,
  onChange,
  onPickNew,
}: {
  label: string
  roles: readonly RefRole[]
  value: number | null
  elements: Element[]
  testId?: string
  /** True while a pick on the scan is filling this slot. */
  picking?: boolean
  onChange: (id: number | null) => void
  /** Offered on point slots: create the point by clicking the scan. */
  onPickNew?: () => void
}) {
  const options = providersFor(roles, elements)
  return (
    <label className="field">
      <span>{label}</span>
      <select
        data-test={testId}
        value={picking ? '__pick__' : value ?? ''}
        onChange={(e) => {
          if (e.target.value === '__pick__') onPickNew?.()
          else onChange(e.target.value === '' ? null : Number(e.target.value))
        }}
      >
        <option value="">{picking ? 'Picking — click the scan…' : 'Select…'}</option>
        {options.map((el) => (
          <option key={el.id} value={el.id}>
            {el.name}
          </option>
        ))}
        {onPickNew && <option value="__pick__">+ Pick point on scan…</option>}
      </select>
    </label>
  )
}

function WarningNote({ text }: { text: string }) {
  return <p className="warnnote">⚠ {text}</p>
}

/** One alignment slot: an existing element, or the option to fill the slot by
 *  clicking points straight on the scan. */
function AlignSelect({
  label,
  roles,
  value,
  picks,
  need,
  picking,
  elements,
  testId,
  onChange,
  onPick,
}: {
  label: string
  roles: readonly RefRole[]
  value: number | null
  /** Points already picked for this slot. */
  picks: number
  /** Points a pick-fill needs. */
  need: number
  picking: boolean
  elements: Element[]
  testId: string
  onChange: (id: number | null) => void
  onPick: () => void
}) {
  const options = providersFor(roles, elements)
  const selectValue = picking
    ? '__pick__'
    : value !== null
      ? String(value)
      : picks >= need
        ? '__picked__'
        : ''
  return (
    <label className="field">
      <span>{label}</span>
      <select
        data-test={testId}
        value={selectValue}
        onChange={(e) => {
          if (e.target.value === '__pick__') onPick()
          else if (e.target.value !== '__picked__')
            onChange(e.target.value === '' ? null : Number(e.target.value))
        }}
      >
        <option value="">Select…</option>
        {picks >= need && !picking && (
          <option value="__picked__">
            {need === 1 ? 'Picked point ✓' : `${need} picked points ✓`}
          </option>
        )}
        {options.map((el) => (
          <option key={el.id} value={el.id}>
            {el.name}
          </option>
        ))}
        <option value="__pick__">
          {picking
            ? `Picking — ${picks} / ${need} on the scan…`
            : `+ Pick ${need === 1 ? 'a point' : `${need} points`} on the scan…`}
        </option>
      </select>
    </label>
  )
}

export function Panel({
  onOpenScan,
  onStartDraft,
  onUndoPick,
  onCancelDraft,
  onConfirmDraft,
  onPickPoint,
  onDelete,
  onClearAll,
  onCopy,
  onStartAlignment,
  onApplyAlignment,
  onApplyManual,
  onResetAlignment,
  onExportStep,
}: {
  onOpenScan: (file: File) => void
  onStartDraft: (kind: ElementKind) => void
  onUndoPick: () => void
  onCancelDraft: () => void
  onConfirmDraft: () => void
  /** Fill dimension slot n by picking a new point on the scan. */
  onPickPoint: (slot: number) => void
  onDelete: (id: number) => void
  onClearAll: () => void
  onCopy: () => void
  onStartAlignment: () => void
  /** Bake the computed datum alignment into the part. */
  onApplyAlignment: (m: Rigid) => void
  /** Bake a typed-in move / rotate into the part. */
  onApplyManual: (m: Rigid) => void
  onResetAlignment: () => void
  onExportStep: () => void
}) {
  const fileName = useStore((s) => s.fileName)
  const busy = useStore((s) => s.busy)
  const triangleCount = useStore((s) => s.triangleCount)
  const elements = useStore((s) => s.elements)
  const draft = useStore((s) => s.draft)
  const draftColor = elementColor(useStore((s) => s.nextNumber))
  const dimensions = useStore((s) => s.dimensions)
  const dimDraft = useStore((s) => s.dimDraft)
  const settings = useStore((s) => s.settings)
  const setSigma = useStore((s) => s.setSigma)
  const setDraftMethod = useStore((s) => s.setDraftMethod)
  const setDraftRef = useStore((s) => s.setDraftRef)
  const setDraftParam = useStore((s) => s.setDraftParam)
  const startDimension = useStore((s) => s.startDimension)
  const setDimensionType = useStore((s) => s.setDimensionType)
  const setDimensionRef = useStore((s) => s.setDimensionRef)
  const setDimensionAnchor = useStore((s) => s.setDimensionAnchor)
  const cancelDimension = useStore((s) => s.cancelDimension)
  const commitDimension = useStore((s) => s.commitDimension)
  const removeDimension = useStore((s) => s.removeDimension)
  const toggleElementVisible = useStore((s) => s.toggleElementVisible)
  const toggleDimensionVisible = useStore((s) => s.toggleDimensionVisible)
  const modelSize = useStore((s) => s.modelSize)
  const alignDraft = useStore((s) => s.alignDraft)
  const appliedAlignment = useStore((s) => s.appliedAlignment)
  const cancelAlignment = useStore((s) => s.cancelAlignment)
  const setAlignmentRef = useStore((s) => s.setAlignmentRef)
  const setAlignmentAxis = useStore((s) => s.setAlignmentAxis)
  const beginAlignmentPick = useStore((s) => s.beginAlignmentPick)
  const undoAlignmentPick = useStore((s) => s.undoAlignmentPick)

  const [copied, setCopied] = useState(false)
  // The manual move / rotate box: six typed-in numbers, NaN while a field is
  // empty. Purely local — it needs no viewport interaction.
  const [manual, setManual] = useState<number[] | null>(null)
  const manualNums = manual?.map((v) => (Number.isFinite(v) ? v : 0)) ?? null
  const manualIdentity = manualNums === null || manualNums.every((v) => v === 0)

  const evaluated = evaluateDimensions(dimensions, elements)
  const draftKind = draft && elementKindInfo(draft.kind)
  const method = draft && creationMethod(draft.kind, draft.method)
  const kindMethods = draft ? methodsForKind(draft.kind) : []

  const pickHint =
    !draft || !draftKind || !method
      ? ''
      : draft.picks.length === 0
        ? method.hint
        : method.mode === 'pick'
          ? 'Click again to move the point, or create it.'
          : `Add more points if the ${draftKind.noun} is split across unconnected patches, then create it.`

  // Live preview of the dimension being built.
  const dimInfo = dimDraft ? dimensionTypeInfo(dimDraft.type) : null
  let dimPreview: DimensionValue | null = null
  if (dimDraft && dimInfo && dimDraft.refs.every((r) => r !== null)) {
    const fits = dimDraft.refs.map((id) => elements.find((e) => e.id === id)?.fit)
    dimPreview = fits.every((f): f is FitData => f !== undefined)
      ? evaluateDimension(dimDraft.type, fits, dimDraft.anchor)
      : { label: dimInfo.label, invalid: 'A referenced element is unavailable.' }
  }
  const dimRefsAreSpheres =
    dimDraft?.type === 'dist-point-point' &&
    dimDraft.refs.every((id) => elements.find((e) => e.id === id)?.kind === 'sphere')

  // Elements currently referenced by the dimension, construction or alignment
  // being built — marked in the list to mirror their glow in the viewport.
  const selectedIds = new Set(
    [
      ...(dimDraft?.refs ?? []),
      ...(draft?.refs ?? []),
      ...(alignDraft ? [alignDraft.primary, alignDraft.secondary, alignDraft.origin] : []),
    ].filter((r): r is number => r !== null),
  )

  // Live preview of the alignment being set up: the transform it would apply,
  // or why it cannot be computed yet. Each slot is an element or, in its
  // place, points picked on the scan.
  const fitOf = (id: number | null) =>
    id === null ? undefined : elements.find((e) => e.id === id)?.fit
  let alignReady: { rigid: Rigid; rotationDeg: number; translation: number } | null = null
  let alignError: string | null = null
  if (alignDraft) {
    try {
      const slotFit = (slot: AlignSlot, ref: number | null): FitData | null => {
        if (ref !== null) return fitOf(ref) ?? null
        return fitFromAlignPicks(slot, alignSlotPicks(alignDraft, slot), modelSize)
      }
      const primaryFit = slotFit('primary', alignDraft.primary)
      const secondaryFit = slotFit('secondary', alignDraft.secondary)
      const originFit = slotFit('origin', alignDraft.origin)
      if (primaryFit) {
        const rigid = computeDatumAlignment(
          { fit: primaryFit, axis: alignDraft.primaryAxis },
          secondaryFit ? { fit: secondaryFit, axis: alignDraft.secondaryAxis } : null,
          originFit ?? null,
        )
        alignReady = { rigid, ...describeRigid(rigid) }
      }
    } catch (e) {
      alignError = e instanceof AlignmentError ? e.message : 'Alignment failed.'
    }
  }

  return (
    <aside className="panel">
      <div className="group">
        <div className="sec-head">Model</div>
        <ModelSlotBlock
          fileName={fileName}
          triangleCount={triangleCount}
          busy={busy}
          onOpenScan={onOpenScan}
        />
      </div>

      {draft === null && (
        <div className="group">
          <div className="sec-head">Create element</div>
          <div className="kindrow">
            {ELEMENT_KINDS.map((k) => (
              <button
                key={k.id}
                data-test={`fit-${k.id}`}
                disabled={!fileName || busy}
                onClick={() => onStartDraft(k.id)}
              >
                {k.label}
              </button>
            ))}
          </div>
          {fileName && (
            <p className="hint">
              Fit an element to the scan, pick a point, or construct one from existing elements.
            </p>
          )}
        </div>
      )}

      {draft !== null && draftKind !== null && method !== null && (
        <div className="draftbox" style={{ borderLeftColor: draftColor }}>
          <div className="sec-head">
            <span className="dot" style={{ background: draftColor }} />
            New {draftKind.noun}
          </div>

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

          {method.mode === 'construct' ? (
            <>
              <p className="hint">{method.hint}</p>
              {method.slots.map((slot, i) => (
                <RefSelect
                  key={i}
                  label={slot.label}
                  roles={[slot.role]}
                  value={draft.refs[i]}
                  elements={elements}
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
              {method.mode !== 'construct' && (
                <span>
                  {draft.picks.length} pick{draft.picks.length === 1 ? '' : 's'}
                </span>
              )}
            </div>
            <div
              className={
                'dro-window ' +
                draft.status +
                (draft.status === 'fitting' ? ' working' : draft.status === 'failed' ? ' alarm' : '')
              }
              data-test="draft-status"
            >
              {draft.status === 'empty' && (
                <b style={{ fontSize: 12, fontWeight: 400, color: 'var(--dim)' }}>
                  {method.mode === 'construct' ? 'Incomplete' : 'No points picked'}
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
                  const [num, unit] = splitValue(primary)
                  return (
                    <>
                      <b style={{ color: draftColor }}>{num}</b>
                      <span>{unit}</span>
                    </>
                  )
                })()}
            </div>
            {draft.status === 'ready' && <div className="dro-note">{formatDetail(draft.fit!)}</div>}
          </div>

          <button
            className="primary block"
            data-test="create-element"
            disabled={draft.status !== 'ready'}
            onClick={onConfirmDraft}
          >
            Create {draftKind.noun}
          </button>
          <div className="toolrow">
            {method.mode !== 'construct' && (
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

      {draft !== null && method?.mode === 'fit' && (
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
            <span>Used points</span>
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
          <p className="hint">
            Outlier cut-off for every fit. Changing it re-fits all elements from their picked
            points.
          </p>
        </div>
      )}

      {elements.length > 0 && (
        <div className="group">
          <div className="g-label">
            <span>Elements</span>
            <b>{elements.length}</b>
          </div>
          {elements.map((el) => (
            <div
              className={'kv' + (el.visible ? '' : ' ghost') + (selectedIds.has(el.id) ? ' sel' : '')}
              data-test="element-row"
              key={el.id}
            >
              <span className="dot" style={{ background: el.color }} />
              <span className="name">{el.name}</span>
              {el.status === 'fitting' ? (
                <b className="working">
                  <span className="spinner" />
                  fitting
                </b>
              ) : el.fit ? (
                <b>{formatPrimary(el.fit)}</b>
              ) : (
                <b className="warn" title={el.message}>
                  ⚠
                </b>
              )}
              <button
                className="x eye"
                title={el.visible ? `Hide ${el.name} in the viewport` : `Show ${el.name}`}
                onClick={() => toggleElementVisible(el.id)}
              >
                {el.visible ? '◉' : '○'}
              </button>
              <button className="x" title={`Delete ${el.name}`} onClick={() => onDelete(el.id)}>
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="group">
        <div className="g-label">
          <span>Alignment</span>
        </div>
        {alignDraft === null && manual !== null ? (
          <div className="draftbox">
            <div className="sec-head">Move / rotate part</div>
            <p className="hint">
              Type how far to move (mm) and turn (°) the part along the global axes. It turns
              about the zero point — about X, then Y, then Z — and moves after that.
            </p>
            {MANUAL_FIELDS.map((f, i) => (
              <label className="field" key={f.key}>
                <span>
                  {f.label} ({f.unit})
                </span>
                <input
                  type="number"
                  step="any"
                  data-test={`manual-${f.key}`}
                  value={Number.isFinite(manual[i]) ? manual[i] : ''}
                  onChange={(e) =>
                    setManual(
                      manual.map((v, j) =>
                        j === i ? (e.target.value === '' ? NaN : Number(e.target.value)) : v,
                      ),
                    )
                  }
                />
              </label>
            ))}
            <button
              className="primary block"
              data-test="apply-manual"
              disabled={manualIdentity || busy}
              onClick={() => {
                if (!manualNums) return
                onApplyManual(
                  manualRigid(
                    [manualNums[0], manualNums[1], manualNums[2]],
                    [manualNums[3], manualNums[4], manualNums[5]],
                  ),
                )
                setManual(null)
              }}
            >
              Move part
            </button>
            <div className="toolrow">
              <button data-test="cancel-manual" onClick={() => setManual(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : alignDraft === null ? (
          <>
            <button
              className="block"
              data-test="start-alignment"
              disabled={!fileName || busy}
              onClick={onStartAlignment}
            >
              Align part (3-2-1)
            </button>
            <button
              className="block"
              data-test="start-manual"
              disabled={!fileName || busy}
              onClick={() => setManual([NaN, NaN, NaN, NaN, NaN, NaN])}
            >
              Move / rotate by numbers
            </button>
            {appliedAlignment !== null && (
              <button
                className="block"
                data-test="reset-alignment"
                disabled={busy}
                onClick={onResetAlignment}
              >
                Reset alignment
              </button>
            )}
            <p className="hint">
              Set where X, Y, Z and the zero point sit on the part — using measured elements,
              points picked on the scan, a mix of both, or typed-in numbers.
            </p>
          </>
        ) : (
          <div className="draftbox">
            <div className="sec-head">Align part</div>
            <p className="hint">
              Level the part with a flat face, a cylinder, or 3 picked points. Optionally add a
              second direction so it cannot spin, and a point that becomes the zero. Whatever
              levels or rotates also sets its own zero — a levelling face ends up at height 0.
            </p>
            <AlignSelect
              label="Level with"
              roles={['plane', 'axis']}
              value={alignDraft.primary}
              picks={alignDraft.primaryPicks.length}
              need={ALIGN_PICK_COUNT.primary}
              picking={alignDraft.pickSlot === 'primary'}
              elements={elements}
              testId="align-primary"
              onChange={(id) => setAlignmentRef('primary', id)}
              onPick={() => beginAlignmentPick('primary')}
            />
            <label className="field">
              <span>Points along</span>
              <select
                data-test="align-primary-axis"
                value={alignDraft.primaryAxis}
                onChange={(e) => setAlignmentAxis('primary', e.target.value as AxisDir)}
              >
                {AXIS_DIRS.map((a) => (
                  <option key={a} value={a}>
                    {axisDirLabel(a)}
                  </option>
                ))}
              </select>
            </label>
            <AlignSelect
              label="Rotate with"
              roles={['plane', 'axis']}
              value={alignDraft.secondary}
              picks={alignDraft.secondaryPicks.length}
              need={ALIGN_PICK_COUNT.secondary}
              picking={alignDraft.pickSlot === 'secondary'}
              elements={elements.filter((e) => e.id !== alignDraft.primary)}
              testId="align-secondary"
              onChange={(id) => setAlignmentRef('secondary', id)}
              onPick={() => beginAlignmentPick('secondary')}
            />
            {(alignDraft.secondary !== null || alignDraft.secondaryPicks.length > 0) && (
              <label className="field">
                <span>Points along</span>
                <select
                  data-test="align-secondary-axis"
                  value={alignDraft.secondaryAxis}
                  onChange={(e) => setAlignmentAxis('secondary', e.target.value as AxisDir)}
                >
                  {AXIS_DIRS.filter((a) => axisIndex(a) !== axisIndex(alignDraft.primaryAxis)).map(
                    (a) => (
                      <option key={a} value={a}>
                        {axisDirLabel(a)}
                      </option>
                    ),
                  )}
                </select>
              </label>
            )}
            <AlignSelect
              label="Zero point"
              roles={['point']}
              value={alignDraft.origin}
              picks={alignDraft.originPicks.length}
              need={ALIGN_PICK_COUNT.origin}
              picking={alignDraft.pickSlot === 'origin'}
              elements={elements}
              testId="align-origin"
              onChange={(id) => setAlignmentRef('origin', id)}
              onPick={() => beginAlignmentPick('origin')}
            />

            <div className="dro">
              <div className="dro-label">
                <span>Preview</span>
              </div>
              <div
                className={'dro-window' + (alignError ? ' alarm' : '')}
                data-test="align-preview"
              >
                {alignError ? (
                  <b>{alignError}</b>
                ) : alignReady ? (
                  <>
                    <b>{alignReady.rotationDeg.toFixed(2)}</b>
                    <span>DEG</span>
                  </>
                ) : (
                  <b style={{ fontSize: 12, fontWeight: 400, color: 'var(--dim)' }}>
                    Choose what levels the part
                  </b>
                )}
              </div>
              {alignReady && (
                <div className="dro-note">
                  rotates {alignReady.rotationDeg.toFixed(2)}° · moves{' '}
                  {alignReady.translation.toFixed(3)} mm
                </div>
              )}
            </div>

            <button
              className="primary block"
              data-test="apply-alignment"
              disabled={!alignReady || busy}
              onClick={() => alignReady && onApplyAlignment(alignReady.rigid)}
            >
              Align part
            </button>
            <div className="toolrow">
              {alignDraft.pickSlot !== null && (
                <button
                  data-test="align-undo-pick"
                  disabled={alignSlotPicks(alignDraft, alignDraft.pickSlot).length === 0}
                  onClick={undoAlignmentPick}
                >
                  Undo point
                </button>
              )}
              <button data-test="cancel-alignment" onClick={cancelAlignment}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="group">
        <div className="g-label">
          <span>Dimensions</span>
          {dimensions.length > 0 && <b>{dimensions.length}</b>}
        </div>

        {dimDraft === null ? (
          <>
            <button
              className="block"
              data-test="new-dimension"
              disabled={elements.every((e) => !e.fit)}
              onClick={() => startDimension('dist-point-point')}
            >
              New dimension
            </button>
            {elements.every((e) => !e.fit) && fileName && (
              <p className="hint">Create at least one element first, then measure between them.</p>
            )}
          </>
        ) : (
          dimInfo && (
            <div className="draftbox dimbox">
              <div className="sec-head">New dimension</div>
              <label className="field">
                <span>Type</span>
                <select
                  data-test="dim-type"
                  value={dimDraft.type}
                  onChange={(e) => setDimensionType(e.target.value)}
                >
                  <optgroup label="Distance">
                    {DIMENSION_TYPES.filter((t) => t.group === 'distance').map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Angle">
                    {DIMENSION_TYPES.filter((t) => t.group === 'angle').map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </label>
              <p className="hint">
                {dimInfo.hint} Click elements in the viewport to fill the slots — the type
                switches to match what you pick.
              </p>
              {dimInfo.slots.map((slot, i) => (
                <RefSelect
                  key={i}
                  label={slot.label}
                  roles={[slot.role]}
                  value={dimDraft.refs[i]}
                  elements={elements}
                  testId={`dim-ref-${i}`}
                  picking={dimDraft.pickSlot === i}
                  onChange={(id) => setDimensionRef(i, id)}
                  onPickNew={slot.role === 'point' ? () => onPickPoint(i) : undefined}
                />
              ))}
              {dimRefsAreSpheres && (
                <label className="field">
                  <span>Measure</span>
                  <select
                    data-test="dim-anchor"
                    value={dimDraft.anchor}
                    onChange={(e) => setDimensionAnchor(e.target.value as SphereAnchor)}
                  >
                    <option value="center">Center to center</option>
                    <option value="gap">Surface gap (− radii)</option>
                    <option value="span">Outer span (+ radii)</option>
                  </select>
                </label>
              )}

              {dimPreview && (
                <div className="dro">
                  <div className="dro-label">
                    <span>{dimPreview.label}</span>
                  </div>
                  {dimPreview.invalid ? (
                    <div className="dro-window alarm" data-test="dim-preview">
                      <b>no value</b>
                    </div>
                  ) : (
                    (() => {
                      const [num, unit] = splitValue(dimPreview!.value!)
                      return (
                        <div className="dro-window" data-test="dim-preview">
                          <b>{num}</b>
                          <span>{unit}</span>
                        </div>
                      )
                    })()
                  )}
                  {(dimPreview.warning ?? dimPreview.invalid) && (
                    <WarningNote text={(dimPreview.warning ?? dimPreview.invalid)!} />
                  )}
                </div>
              )}

              <button
                className="primary block"
                data-test="add-dimension"
                disabled={!dimPreview || Boolean(dimPreview.invalid)}
                onClick={commitDimension}
              >
                Add dimension
              </button>
              <div className="toolrow">
                <button data-test="cancel-dimension" onClick={cancelDimension}>
                  Cancel
                </button>
              </div>
            </div>
          )
        )}

        {evaluated.map(({ dim, title, value }) => (
          <div className="dro hero dim" key={dim.id} data-test="dimension-row">
            <div className="dro-label">
              <span>
                {dim.name} · {value.label}
              </span>
              <span className="dro-tools">
                <span className="dro-title">{title}</span>
                <button
                  className="x eye"
                  title={
                    dim.visible !== false ? `Hide ${dim.name} in the viewport` : `Show ${dim.name}`
                  }
                  onClick={() => toggleDimensionVisible(dim.id)}
                >
                  {dim.visible !== false ? '◉' : '○'}
                </button>
                <button
                  className="x"
                  title={`Delete ${dim.name}`}
                  onClick={() => removeDimension(dim.id)}
                >
                  ✕
                </button>
              </span>
            </div>
            {value.invalid ? (
              <div className="dro-window alarm" data-test="dimension-value">
                <b>no value</b>
              </div>
            ) : (
              (() => {
                const [num, unit] = splitValue(value.value!)
                return (
                  <div className="dro-window" data-test="dimension-value">
                    <b>{num}</b>
                    <span>{unit}</span>
                  </div>
                )
              })()
            )}
            {value.detail && !value.invalid && <div className="dro-note">{value.detail}</div>}
            {(value.warning ?? value.invalid) && <WarningNote text={(value.warning ?? value.invalid)!} />}
          </div>
        ))}
      </div>

      {(elements.length > 0 || draft !== null) && (
        <>
          <div className="divider" />
          <div className="toolrow">
            <button
              disabled={elements.every((e) => !e.fit)}
              onClick={() => {
                onCopy()
                setCopied(true)
                setTimeout(() => setCopied(false), 2000)
              }}
            >
              {copied ? 'Copied ✓' : 'Copy summary'}
            </button>
            <button
              data-test="export-step"
              disabled={elements.every((e) => !e.fit)}
              onClick={onExportStep}
              title="Export the created elements as analytic geometry in a STEP file"
            >
              Export STEP
            </button>
            <button onClick={onClearAll}>Clear all</button>
          </div>
        </>
      )}
    </aside>
  )
}

// Kept out of the main component so the file-slot block reads as one unit.
function ModelSlotBlock({
  fileName,
  triangleCount,
  busy,
  onOpenScan,
}: {
  fileName: string | null
  triangleCount: number
  busy: boolean
  onOpenScan: (file: File) => void
}) {
  return (
    <>
      <ModelSlot
        role="Scan"
        name={fileName}
        detail={`${triangleCount.toLocaleString('en-US')} triangles`}
        dotColor="#8b9099"
        busy={busy}
        onOpen={onOpenScan}
      />
      {!fileName && (
        <p className="hint">
          The part as measured. Drop it anywhere in the window. Units are assumed to be
          millimetres, and nothing is uploaded: the whole measurement runs in this browser.
        </p>
      )}
    </>
  )
}

// SPDX-License-Identifier: AGPL-3.0-only
// The alignment group: the 3-2-1 datum editor, the manual move / rotate box,
// and the buttons that open them.

import { useMemo, useState } from 'react'
import {
  ALIGN_PICK_COUNT,
  AXIS_DIRS,
  axisDirLabel,
  axisIndex,
  manualRigid,
  type AxisDir,
} from '../core/alignment'
import type { Rigid } from '../core/deviation/rigid'
import type { RefRole } from '../core/elements/refs'
import { alignmentPreview, alignSlotPicks, useStore, type Element } from '../state/store'
import { InfoDot } from './InfoDot'
import { providersFor } from './RefSelect'

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

export function AlignmentSection({
  onStartAlignment,
  onApplyAlignment,
  onApplyManual,
  onResetAlignment,
}: {
  onStartAlignment: () => void
  /** Bake the computed datum alignment into the part. */
  onApplyAlignment: (m: Rigid) => void
  /** Bake a typed-in move / rotate into the part. */
  onApplyManual: (m: Rigid) => void
  onResetAlignment: () => void
}) {
  const fileName = useStore((s) => s.fileName)
  const busy = useStore((s) => s.busy)
  const elements = useStore((s) => s.elements)
  const modelSize = useStore((s) => s.modelSize)
  const alignDraft = useStore((s) => s.alignDraft)
  const appliedAlignment = useStore((s) => s.appliedAlignment)
  const cancelAlignment = useStore((s) => s.cancelAlignment)
  const setAlignmentRef = useStore((s) => s.setAlignmentRef)
  const setAlignmentAxis = useStore((s) => s.setAlignmentAxis)
  const beginAlignmentPick = useStore((s) => s.beginAlignmentPick)
  const undoAlignmentPick = useStore((s) => s.undoAlignmentPick)

  // The manual move / rotate box: six typed-in numbers, NaN while a field is
  // empty. Purely local — it needs no viewport interaction.
  const [manual, setManual] = useState<number[] | null>(null)
  const manualNums = manual?.map((v) => (Number.isFinite(v) ? v : 0)) ?? null
  const manualIdentity = manualNums === null || manualNums.every((v) => v === 0)

  // The transform the alignment being set up would apply, or why it cannot be
  // computed yet — the same reading the viewport is previewing the part with.
  // Memoised for the same reason as the dimensions: it is a whole datum
  // alignment, recomputed only when one of its inputs actually moves.
  const { preview: alignReady, error: alignError } = useMemo(
    () =>
      alignDraft
        ? alignmentPreview(alignDraft, elements, modelSize)
        : { preview: null, error: null },
    [alignDraft, elements, modelSize],
  )

  return (
    <div className="group">
      <div className="sec-head">
        Alignment
        <InfoDot title="Alignment">
          <p>
            Where X, Y, Z and the zero point sit on the part. Until it is set the scan lies in
            whatever pose the scanner left it in, so heights, offsets and anything measured
            against an axis mean nothing.
          </p>
          <p>
            <b>Align part (3-2-1)</b> builds the frame the way a drawing does: one datum levels
            the part, a second stops it spinning, a third sets the origin. Each can be a measured
            element or points clicked straight on the scan.
          </p>
          <p>
            <b>Move / rotate by numbers</b> applies a transform you already know instead. Both are
            baked into the part, and <b>Reset alignment</b> puts it back.
          </p>
        </InfoDot>
      </div>
      {alignDraft === null && manual !== null ? (
        <div className="draftbox">
          <div className="sec-head">
            Move / rotate part
            <InfoDot title="Move / rotate part">
              <p>
                How far to move the part (mm) and how far to turn it (°) along the global axes.
              </p>
              <p>
                It turns about the zero point first — about X, then Y, then Z — and moves after
                that, so a rotation and an offset entered together behave the same way every time.
              </p>
            </InfoDot>
          </div>
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
        </>
      ) : (
        <div className="draftbox">
          <div className="sec-head">
            Align part
            <InfoDot title="3-2-1 alignment">
              <p>
                <b>Level with</b> sets the first direction: a flat face, a cylinder axis, or 3
                points picked on the scan. <i>Points along</i> says which axis that direction
                becomes.
              </p>
              <p>
                <b>Rotate with</b> is optional and adds a second direction, so the part cannot
                spin about the first. <b>Zero point</b> is optional too and becomes 0, 0, 0.
              </p>
              <p>
                Whatever levels or rotates also sets its own zero along that axis — a levelling
                face ends up at height 0 — so the origin slot only has to supply what is left.
              </p>
            </InfoDot>
          </div>
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
                <b
                  style={{
                    fontSize: 12,
                    fontWeight: 400,
                    color: 'var(--dim)',
                  }}
                >
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
  )
}

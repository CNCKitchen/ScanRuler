// SPDX-License-Identifier: AGPL-3.0-only
// The alignment group: the 3-2-1 datum editor, the manual move / rotate box,
// and the buttons that open them.

import { useMemo, useState } from 'react'
import {
  ALIGN_PICK_COUNT,
  axisIndex,
  manualRigid,
  type AxisDir,
} from '../core/alignment'
import type { Rigid } from '../core/deviation/rigid'
import type { RefRole } from '../core/elements/refs'
import {
  alignCenterOf,
  alignmentPreview,
  alignSlotPicks,
  useStore,
  type Element,
} from '../state/store'
import { InfoDot } from './InfoDot'
import { providersFor } from './RefSelect'

/** What the levelled direction becomes, said the way a person holds a part:
 *  which side of it the picked face is. The face's outward direction maps onto
 *  the signed axis — a bottom face faces down, so it lands on the floor plane.
 *  Ordered by how often each is what the user means. */
const FACE_CHOICES: { axis: AxisDir; label: string }[] = [
  { axis: 'z-', label: 'Bottom — points down (−Z)' },
  { axis: 'z+', label: 'Top — points up (+Z)' },
  { axis: 'y-', label: 'Front — points at you (−Y)' },
  { axis: 'y+', label: 'Back — points away (+Y)' },
  { axis: 'x+', label: 'Right — points right (+X)' },
  { axis: 'x-', label: 'Left — points left (−X)' },
]

/** Which way the step-2 edge runs, in the same on-screen words. The stage's
 *  origin arrows show the same directions in the viewport. */
const EDGE_CHOICES: { axis: AxisDir; label: string }[] = [
  { axis: 'x+', label: '+X — to the right' },
  { axis: 'x-', label: '−X — to the left' },
  { axis: 'y+', label: '+Y — away from you' },
  { axis: 'y-', label: '−Y — toward you' },
  { axis: 'z+', label: '+Z — up' },
  { axis: 'z-', label: '−Z — down' },
]

/** Numbered heading of one alignment step. */
function StepHead({ n, text, optional }: { n: number; text: string; optional?: boolean }) {
  return (
    <div className="stephead">
      <span className="stepno">{n}</span>
      {text}
      {optional && <span className="step-opt">optional</span>}
    </div>
  )
}

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
  const centerOf = useStore(alignCenterOf)
  const { preview: alignReady, error: alignError } = useMemo(
    () =>
      alignDraft
        ? alignmentPreview(alignDraft, elements, modelSize, centerOf)
        : { preview: null, error: null },
    [alignDraft, elements, modelSize, centerOf],
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
            <b>Align part</b> places it in up to three steps — set a face on a coordinate plane,
            run an edge along an axis, put the zero point on a corner. Each step takes a measured
            element or points clicked straight on the scan, and the viewport previews every choice
            against the coordinate planes before anything is applied.
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
            Align part
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
            <InfoDot title="Align part">
              <p>
                Three steps, and only the first is required. The coordinate planes in the viewport
                are where the part is going; it moves live with every choice, and nothing is
                applied until <b>Align part</b> is pressed.
              </p>
              <p>
                <b>1 · Set on a plane</b> — pick 3 points on one face of the part (or use a
                measured plane or cylinder). Then say which side of the part that face is: the
                bottom lands on the floor plane, a front lands on the front plane, and so on.
              </p>
              <p>
                <b>2 · Align with an axis</b> — pick 2 points along an edge (or use an element)
                and say which way that edge should run, so the part cannot spin on the plane. The
                edge runs from your 1st point to your 2nd.
              </p>
              <p>
                <b>3 · Move to zero point</b> — pick the corner or feature that becomes X0 Y0 Z0.
                A zero point on its own works too, if all you want is to move the origin.
              </p>
              <p>
                Whatever a step already fixes it also zeroes — a face set on the floor sits at
                height 0 — and the first alignment centres the part on whatever is still free.
              </p>
            </InfoDot>
          </div>
          <StepHead n={1} text="Set on a plane" />
          <AlignSelect
            label="Face"
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
            <span>It is the part’s</span>
            <select
              data-test="align-primary-axis"
              value={alignDraft.primaryAxis}
              onChange={(e) => setAlignmentAxis('primary', e.target.value as AxisDir)}
            >
              {FACE_CHOICES.map((c) => (
                <option key={c.axis} value={c.axis}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <StepHead n={2} text="Align with an axis" optional />
          <AlignSelect
            label="Edge"
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
              <span>It runs</span>
              <select
                data-test="align-secondary-axis"
                value={alignDraft.secondaryAxis}
                onChange={(e) => setAlignmentAxis('secondary', e.target.value as AxisDir)}
              >
                {EDGE_CHOICES.filter(
                  (c) => axisIndex(c.axis) !== axisIndex(alignDraft.primaryAxis),
                ).map((c) => (
                  <option key={c.axis} value={c.axis}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <StepHead n={3} text="Move to zero point" optional />
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

          {/* The pose itself is previewed on the part, against the coordinate
              planes — the panel only has to speak up when the chosen datums
              cannot make an alignment at all. */}
          {alignError && (
            <p className="alarmtext" data-test="align-error">
              {alignError}
            </p>
          )}

          <button
            className="primary block"
            data-test="apply-alignment"
            data-confirm={1}
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

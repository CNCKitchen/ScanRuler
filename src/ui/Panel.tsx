// SPDX-License-Identifier: AGPL-3.0-only
// The left faceplate: everything the operator sets, and every number the tool
// reports. Controls at the top, readouts below, in the order the work happens.

import { useState } from 'react'
import {
  alignmentPreview,
  alignSlotPicks,
  blockedRefs,
  draftColorOf,
  useStore,
  type Element,
  type SelectMode,
} from '../state/store'
import { ELEMENT_KINDS, elementKindInfo } from '../core/elements/kinds'
import { creationMethod, methodsForKind } from '../core/elements/construct'
import { isExtendable } from '../core/elements/extend'
import { providesRole, type RefRole } from '../core/elements/refs'
import {
  ALIGN_PICK_COUNT,
  AXIS_DIRS,
  axisDirLabel,
  axisIndex,
  manualRigid,
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
import type { StepStyle } from '../core/exportStep'
import { formatDetail, formatPrimary, SIGMA_LABELS } from '../core/summary'
import type { ElementKind, FitData, SigmaPreset } from '../core/types'
import { useMark } from '../state/markStore'
import { ExtendFields } from './ExtendFields'
import { InfoDot } from './InfoDot'
import { MarkTools } from './MarkTools'
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

/** Elements that can fill a reference slot of one of the given roles, minus
 *  any that would close a loop (an edited element and its dependents). */
function providersFor(
  roles: readonly RefRole[],
  elements: Element[],
  blocked?: ReadonlySet<number>,
): Element[] {
  return elements.filter(
    (e) => e.fit && !blocked?.has(e.id) && roles.some((role) => providesRole(e.kind, role)),
  )
}

/** The name of the element or dimension being edited, changeable along with
 *  the rest of it. */
function NameField({
  value,
  testId,
  onChange,
}: {
  value: string
  testId: string
  onChange: (name: string) => void
}) {
  return (
    <label className="field">
      <span>Name</span>
      <input type="text" data-test={testId} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  )
}

/** One reference-slot dropdown, shared by constructions, dimensions and the
 *  alignment datums. */
function RefSelect({
  label,
  roles,
  value,
  elements,
  blocked,
  testId,
  picking,
  onChange,
  onPickNew,
}: {
  label: string
  roles: readonly RefRole[]
  value: number | null
  elements: Element[]
  /** Elements this slot must not offer — see providersFor. */
  blocked?: ReadonlySet<number>
  testId?: string
  /** True while a pick on the scan is filling this slot. */
  picking?: boolean
  onChange: (id: number | null) => void
  /** Offered on point slots: create the point by clicking the scan. */
  onPickNew?: () => void
}) {
  const options = providersFor(roles, elements, blocked)
  return (
    <label className="field">
      <span>{label}</span>
      <select
        data-test={testId}
        value={picking ? '__pick__' : (value ?? '')}
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
  onSelectMode,
  onClearPaint,
  onUndoPick,
  onCancelDraft,
  onConfirmDraft,
  onPickPoint,
  onDelete,
  onEditElement,
  onCopy,
  onStartAlignment,
  onApplyAlignment,
  onApplyManual,
  onResetAlignment,
  onExportStep,
  onExportStl,
}: {
  onOpenScan: (file: File) => void
  onStartDraft: (kind: ElementKind) => void
  /** Switch between clicking a point and marking the surface by hand. */
  onSelectMode: (mode: SelectMode) => void
  /** Rub out the whole hand-marked surface. */
  onClearPaint: () => void
  onUndoPick: () => void
  onCancelDraft: () => void
  onConfirmDraft: () => void
  /** Fill dimension slot n by picking a new point on the scan. */
  onPickPoint: (slot: number) => void
  onDelete: (id: number) => void
  /** Re-open an element: the same box it was created in, with its seeds or its
   *  marked surface back on the scan. */
  onEditElement: (id: number) => void
  onCopy: () => void
  onStartAlignment: () => void
  /** Bake the computed datum alignment into the part. */
  onApplyAlignment: (m: Rigid) => void
  /** Bake a typed-in move / rotate into the part. */
  onApplyManual: (m: Rigid) => void
  onResetAlignment: () => void
  onExportStep: () => void
  /** Save the scan as an STL in the pose it is currently shown in. */
  onExportStl: () => void
}) {
  const fileName = useStore((s) => s.fileName)
  const busy = useStore((s) => s.busy)
  const triangleCount = useStore((s) => s.triangleCount)
  const elements = useStore((s) => s.elements)
  const draft = useStore((s) => s.draft)
  const draftColor = useStore(draftColorOf)
  const dimensions = useStore((s) => s.dimensions)
  const dimDraft = useStore((s) => s.dimDraft)
  const settings = useStore((s) => s.settings)
  const setSigma = useStore((s) => s.setSigma)
  const setDraftMethod = useStore((s) => s.setDraftMethod)
  const setDraftName = useStore((s) => s.setDraftName)
  const setDraftRef = useStore((s) => s.setDraftRef)
  const setDraftParam = useStore((s) => s.setDraftParam)
  const startDimension = useStore((s) => s.startDimension)
  const editDimension = useStore((s) => s.editDimension)
  const setDimensionName = useStore((s) => s.setDimensionName)
  const setDimensionType = useStore((s) => s.setDimensionType)
  const setDimensionRef = useStore((s) => s.setDimensionRef)
  const setDimensionAnchor = useStore((s) => s.setDimensionAnchor)
  const cancelDimension = useStore((s) => s.cancelDimension)
  const commitDimension = useStore((s) => s.commitDimension)
  const removeDimension = useStore((s) => s.removeDimension)
  const toggleElementVisible = useStore((s) => s.toggleElementVisible)
  const toggleDimensionVisible = useStore((s) => s.toggleDimensionVisible)
  const modelSize = useStore((s) => s.modelSize)
  const selectMode = useStore((s) => s.selectMode)
  const setSelectMode = onSelectMode
  const stepStyle = useStore((s) => s.stepStyle)
  const setStepStyle = useStore((s) => s.setStepStyle)
  // The marking itself is the shared tool set (markStore / MarkTools); the
  // panel only needs to know how much surface it has taken.
  const markGesture = useMark((s) => s.gesture)
  const paintCount = useMark((s) => s.count)
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
  // The element the open draft writes back to, if it is an edit rather than a
  // new element, and what such a draft must not be built on.
  const edited = draft?.editId !== undefined ? elements.find((e) => e.id === draft.editId) : undefined
  const blocked = blockedRefs(draft?.editId, elements)
  // While anything is being assembled the row keys stand down: re-opening a
  // second element or dimension would throw away what is already in the box.
  const editorOpen = draft !== null || dimDraft !== null || alignDraft !== null

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
            ? `Click again to move the point, or ${edited ? 'save it' : 'create it'}.`
            : `Add more points if the ${draftKind.noun} is split across unconnected patches.`

  // Live preview of the dimension being built.
  const dimInfo = dimDraft ? dimensionTypeInfo(dimDraft.type) : null
  let dimPreview: DimensionValue | null = null
  if (dimDraft && dimInfo && dimDraft.refs.every((r) => r !== null)) {
    const fits = dimDraft.refs.map((id) => elements.find((e) => e.id === id)?.fit)
    dimPreview = fits.every((f): f is FitData => f !== undefined)
      ? evaluateDimension(dimDraft.type, fits, dimDraft.anchor)
      : {
          label: dimInfo.label,
          invalid: 'A referenced element is unavailable.',
        }
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

  // The transform the alignment being set up would apply, or why it cannot be
  // computed yet — the same reading the viewport is previewing the part with.
  const { preview: alignReady, error: alignError } = alignDraft
    ? alignmentPreview(alignDraft, elements, modelSize)
    : { preview: null, error: null }

  return (
    <aside className="panel">
      <div className="group">
        <div className="sec-head">
          Model
          <InfoDot title="The scan">
            <p>
              The part as measured — an <b>STL</b>, <b>PLY</b> or <b>OBJ</b> from your scanner. Drop
              it anywhere in the window, or use the button.
            </p>
            <p>
              Units are assumed to be millimetres. Nothing is uploaded: the file is read and the
              whole measurement runs in this browser.
            </p>
          </InfoDot>
        </div>
        <ModelSlotBlock
          fileName={fileName}
          triangleCount={triangleCount}
          busy={busy}
          onOpenScan={onOpenScan}
        />
      </div>

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

      {draft === null && (
        <div className="group">
          <div className="sec-head">
            Create element
            <InfoDot title="Elements">
              <p>
                Every measurement here starts with an element — a plane, a cylinder, a sphere, a
                circle, a point or a line. Dimensions are then measured between them, never between
                raw triangles.
              </p>
              <p>
                An element is either <b>fitted</b> to the scan, by clicking the feature and letting
                the tool find the surface; <b>picked</b> straight off the mesh, for a single point;
                or <b>constructed</b> from elements you already have — an axis through two circles,
                a midpoint between two points, a plane offset from another.
              </p>
              <p>
                Which of those a kind offers appears as <i>Created</i> once you choose it.
              </p>
            </InfoDot>
          </div>
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
        </div>
      )}

      {draft !== null && draftKind !== null && method !== null && (
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
                onChange={(e) => setSelectMode(e.target.value as SelectMode)}
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

          {/* How much of the measured surface to draw, once there is one. A
              cylinder and a plane are the two elements whose size on screen is
              a drawing decision rather than the measurement itself. */}
          {draft.status === 'ready' && isExtendable(draft.fit) && <ExtendFields fit={draft.fit} />}

          <button
            className="primary block"
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

      {elements.length > 0 && (
        <div className="group">
          <div className="g-label">
            <span>Elements</span>
            <b>{elements.length}</b>
          </div>
          {elements.map((el) => (
            <div
              className={
                'kv' +
                (el.visible ? '' : ' ghost') +
                (selectedIds.has(el.id) || draft?.editId === el.id ? ' sel' : '')
              }
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
                className="x edit"
                data-test="edit-element"
                disabled={editorOpen || el.status === 'fitting'}
                title={
                  editorOpen
                    ? 'Finish what is open first'
                    : `Edit ${el.name} — change what it is measured on or built from`
                }
                onClick={() => onEditElement(el.id)}
              >
                ✎
              </button>
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
        <div className="sec-head">
          Create dimensions
          <InfoDot title="Dimensions">
            <p>
              What you actually read off the part: distances, diameters and angles measured between
              the elements you have created.
            </p>
            <p>
              Fill a slot from the dropdown, or click the element straight in the viewport — the
              dimension type switches to match what you pick, so a click on two circles becomes a
              centre distance without you choosing it.
            </p>
            <p>
              Between two spheres you can also measure the surface gap or the outer span instead of
              centre to centre — a ball-bar length is centre to centre.
            </p>
          </InfoDot>
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
              <div className="sec-head">
                {dimDraft.editId !== undefined
                  ? `Edit ${dimensions.find((d) => d.id === dimDraft.editId)?.name ?? 'dimension'}`
                  : 'New dimension'}
              </div>
              {dimDraft.editId !== undefined && (
                <NameField
                  value={dimDraft.name ?? ''}
                  testId="dim-name"
                  onChange={(name) => setDimensionName(name)}
                />
              )}
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
              <p className="hint">{dimInfo.hint}</p>
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
                {dimDraft.editId !== undefined ? 'Save changes' : 'Add dimension'}
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
                  className="x edit"
                  data-test="edit-dimension"
                  disabled={editorOpen}
                  title={
                    editorOpen
                      ? 'Finish what is open first'
                      : `Edit ${dim.name} — change its type or what it measures between`
                  }
                  onClick={() => editDimension(dim.id)}
                >
                  ✎
                </button>
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
            {(value.warning ?? value.invalid) && (
              <WarningNote text={(value.warning ?? value.invalid)!} />
            )}
          </div>
        ))}
      </div>

      {fileName && (
        <>
          <div className="divider" />
          <label className="field">
            <span>
              STEP as
              <InfoDot title="What the STEP file contains">
                <p>
                  <b>Solids &amp; faces:</b> each element as geometry CAD can build on — a plane as a
                  bounded planar face with real edges, a cylinder and a sphere as closed solid
                  bodies, each its own named body in the tree. Sketch on them, offset them, cut with
                  them.
                </p>
                <p>
                  <b>Construction surfaces:</b> the same geometry as trimmed analytic surfaces and
                  curves in one set, with no topology — the form metrology packages hand measured
                  datums over in. Unmistakably reference geometry rather than a part, and the safer
                  choice for an importer that chokes on bodies.
                </p>
                <p>
                  Points and lines are points and lines either way. Whatever an element has been
                  extended to is what gets written.
                </p>
              </InfoDot>
            </span>
            <select
              data-test="step-style"
              value={stepStyle}
              onChange={(e) => setStepStyle(e.target.value as StepStyle)}
            >
              <option value="solids">Solids &amp; faces</option>
              <option value="surfaces">Construction surfaces</option>
            </select>
          </label>
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
            <button
              data-test="export-stl"
              disabled={busy}
              onClick={onExportStl}
              title="Save the scan as an STL where it now stands — any alignment or move you applied comes with it"
            >
              Export STL
            </button>
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
      {!fileName && <p className="hint">Drop it anywhere in the window.</p>}
    </>
  )
}

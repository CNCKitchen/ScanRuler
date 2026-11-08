// SPDX-License-Identifier: AGPL-3.0-only
// The dimension group: the editor a dimension is assembled in, and the DRO
// rows the finished dimensions are read from.

import { useMemo } from 'react'
import {
  DIMENSION_TYPES,
  dimensionTypeInfo,
  evaluateDimension,
  evaluateDimensions,
  judgeLimit,
  type DimensionValue,
  type SphereAnchor,
} from '../core/dimensions'
import type { FitData } from '../core/types'
import { useStore } from '../state/store'
import { dimHolds } from '../state/historyStore'
import { dimensionRefsOf } from '../state/sectionModel'
import { usePulse } from '../app/useHints'
import { surfaceSource, useSurfaces } from '../app/surfaces'
import { useUnits } from '../app/useUnits'
import { ValueWindow } from './DroValue'
import { InfoDot } from './InfoDot'
import { NameField, providersFor, RefSelect } from './RefSelect'
import { DimensionRow, VerdictNote, WarningNote } from './DimensionRow'
import { LimitFields } from './LimitFields'
import { ShowAllButton } from './ShowAllButton'

/** The head of a dimension's draft box: what the box is making or
 *  editing, and while it edits one, the name to change. */
export function DimDraftHead({
  editId,
  name,
  dimensions,
  nameTestId,
  onName,
}: {
  editId: number | undefined
  name: string | undefined
  dimensions: readonly { id: number; name: string }[]
  nameTestId: string
  onName: (name: string) => void
}) {
  return (
    <>
      <div className="sec-head">
        {editId !== undefined ? `Edit ${dimensions.find((d) => d.id === editId)?.name ?? 'dimension'}` : 'New dimension'}
      </div>
      {editId !== undefined && <NameField value={name ?? ''} testId={nameTestId} onChange={onName} />}
    </>
  )
}

export function DimensionSection({
  editorOpen,
  onPickPoint,
}: {
  /** True while any editor is open — element, dimension or alignment. */
  editorOpen: boolean
  /** Fill dimension slot n by picking a new point on the scan. */
  onPickPoint: (slot: number) => void
}) {
  const fileName = useStore((s) => s.fileName)
  const elements = useStore((s) => s.elements)
  const sections = useStore((s) => s.sections)
  // What a dimension can be taken from: the elements, and the sections as
  // the planes they were cut on.
  const refs = useMemo(() => dimensionRefsOf(elements, sections), [elements, sections])
  const dimensions = useStore((s) => s.dimensions)
  const dimDraft = useStore((s) => s.dimDraft)
  // An element box open — even an empty one, the kind merely in hand —
  // stands the key and the rows' edits down: one box at a time, put down
  // with Cancel or Esc before a dimension is opened.
  const draftOpen = useStore((s) => s.draft !== null)
  const startDimension = useStore((s) => s.startDimension)
  const editDimension = useStore((s) => s.editDimension)
  const setDimensionName = useStore((s) => s.setDimensionName)
  const setDimensionType = useStore((s) => s.setDimensionType)
  const setDimensionRef = useStore((s) => s.setDimensionRef)
  const setDimensionAnchor = useStore((s) => s.setDimensionAnchor)
  const setDimensionLimit = useStore((s) => s.setDimensionLimit)
  const cancelDimension = useStore((s) => s.cancelDimension)
  const commitDimension = useStore((s) => s.commitDimension)
  const removeDimension = useStore((s) => s.removeDimension)
  const toggleDimensionVisible = useStore((s) => s.toggleDimensionVisible)
  const setAllDimensionsVisible = useStore((s) => s.setAllDimensionsVisible)
  const pulseNew = usePulse('new-dimension')
  const pulseAdd = usePulse('add-dimension')

  // This group's own: the tolerances share the list in the store but are
  // read in their own group below.
  const own = useMemo(
    () => dimensions.filter((d) => dimensionTypeInfo(d.type).family === 'dimension'),
    [dimensions],
  )
  // Every dimension re-reads its elements, so this is real work — memoised so
  // an unrelated render (a checkbox, a hover) does not repeat it. A surface
  // arriving or moving is a change of what is read too.
  const surfaceVersion = useSurfaces((s) => s.version)
  // Values and verdicts are written in the units shown.
  const units = useUnits()
  const evaluated = useMemo(
    () => evaluateDimensions(own, refs, surfaceSource, units),
    // Runs on the listed dependencies only, not on everything it reads.
    [own, refs, surfaceVersion, units],
  )

  // Live preview of the dimension being built.
  const dimInfo = dimDraft ? dimensionTypeInfo(dimDraft.type) : null
  // A tolerance being assembled is this group's draft too as far as the store
  // knows, but it is read in the GD&T group; here it only holds the key down.
  const ownDraft = dimDraft !== null && dimInfo?.family === 'dimension'
  let dimPreview: DimensionValue | null = null
  if (dimDraft && dimInfo && dimDraft.refs.every((r) => r !== null)) {
    const fits = dimDraft.refs.map((id) => refs.find((e) => e.id === id)?.fit)
    dimPreview = fits.every((f): f is FitData => f !== undefined)
      ? evaluateDimension(dimDraft.type, fits, { anchor: dimDraft.anchor, units })
      : {
          label: dimInfo.label,
          invalid: 'A referenced element is unavailable.',
        }
  }
  const dimRefsAreSpheres =
    dimDraft?.type === 'dist-point-point' &&
    dimDraft.refs.every((id) => elements.find((e) => e.id === id)?.kind === 'sphere')
  const previewVerdict =
    dimPreview?.raw !== undefined && !dimPreview.invalid && dimDraft?.limit && dimInfo
      ? judgeLimit(dimPreview.raw, dimDraft.limit, dimInfo.unit, units)
      : undefined

  return (
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
          <p>
            <b>Add dimension</b> leaves the box open for the next one of the same type, its
            slots empty; <b>Cancel</b> or <b>Esc</b> closes it.
          </p>
          <p>
            One box is open at a time: while an element kind is in hand, put it down first with
            <b> Cancel</b> or <b>Esc</b>.
          </p>
        </InfoDot>
        {own.length > 0 && <b>{own.length}</b>}
      </div>

      {!ownDraft ? (
        <>
          <button
            className={pulseNew ? 'block pulse' : 'block'}
            data-test="new-dimension"
            // An empty tolerance box, as Add tolerance leaves for the next,
            // is no work to keep: a dimension starts over it.
            disabled={refs.every((e) => !e.fit) || dimHolds(dimDraft) || draftOpen}
            onClick={() => startDimension('dist-point-point')}
          >
            New dimension
          </button>
          {refs.every((e) => !e.fit) && fileName && (
            <p className="hint">Create at least one element first, then measure between them.</p>
          )}
        </>
      ) : (
        dimDraft &&
        dimInfo && (
          <div className="draftbox dimbox">
            <DimDraftHead editId={dimDraft.editId} name={dimDraft.name} dimensions={dimensions} nameTestId="dim-name" onName={(name) => setDimensionName(name)} />
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
                <optgroup label="Size">
                  {DIMENSION_TYPES.filter((t) => t.group === 'size').map((t) => (
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
                options={providersFor(slot.roles, refs, undefined, slot.kinds)}
                value={dimDraft.refs[i]}
                testId={`dim-ref-${i}`}
                picking={dimDraft.pickSlot === i}
                onChange={(id) => setDimensionRef(i, id)}
                onPickNew={
                  slot.roles.includes('point') && !slot.kinds ? () => onPickPoint(i) : undefined
                }
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
            <LimitFields
              family="dimension"
              unit={dimInfo.unit}
              limit={dimDraft.limit}
              onChange={setDimensionLimit}
            />

            {dimPreview && (
              <div className="dro">
                <div className="dro-label">
                  <span>{dimPreview.label}</span>
                </div>
                <ValueWindow
                  value={dimPreview}
                  testId="dim-preview"
                  over={previewVerdict ? !previewVerdict.pass : false}
                />
                {previewVerdict && <VerdictNote verdict={previewVerdict} />}
                {dimPreview.detail && !dimPreview.invalid && (
                  <div className="dro-note">{dimPreview.detail}</div>
                )}
                {(dimPreview.warning ?? dimPreview.invalid) && (
                  <WarningNote text={(dimPreview.warning ?? dimPreview.invalid)!} />
                )}
              </div>
            )}

            <button
              className={pulseAdd ? 'primary block pulse' : 'primary block'}
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

      {own.length > 0 && (
        <div className="g-label">
          <span>Dimensions</span>
          <ShowAllButton
            anyVisible={own.some((d) => d.visible !== false)}
            what="dimensions"
            testId="dimensions-show-all"
            onSet={(visible) => setAllDimensionsVisible(visible, 'dimension')}
          />
        </div>
      )}
      {evaluated.map(({ dim, title, value, verdict }) => (
        <DimensionRow
          key={dim.id}
          name={dim.name}
          visible={dim.visible !== false}
          title={title}
          value={value}
          verdict={verdict}
          editorOpen={editorOpen || draftOpen}
          onEdit={() => editDimension(dim.id)}
          onToggleVisible={() => toggleDimensionVisible(dim.id)}
          onDelete={() => removeDimension(dim.id)}
        />
      ))}
    </div>
  )
}

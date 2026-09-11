// SPDX-License-Identifier: AGPL-3.0-only
// The GD&T group: a tolerance is assembled the way a dimension is — a type,
// the elements it is about, a limit to hold it to — and read the same way,
// in a DRO row with the verdict under it. It shares the dimension draft in
// the store, so a viewport click fills its slots and only one editor is
// ever open across the two groups.

import { useMemo } from 'react'
import {
  dimensionTypeInfo,
  evaluateDimension,
  evaluateDimensions,
  judgeLimit,
  type DimensionGroup,
  type DimensionValue,
} from '../core/dimensions'
import { TOLERANCE_TYPES } from '../core/tolerances'
import type { FitData } from '../core/types'
import { useStore } from '../state/store'
import { surfaceSource, useSurfaces } from '../app/surfaces'
import { ValueWindow } from './DroValue'
import { InfoDot } from './InfoDot'
import { NameField, providersFor, RefSelect } from './RefSelect'
import { DimensionRow, VerdictNote, WarningNote } from './DimensionRow'
import { LimitFields, OptionalNumber } from './LimitFields'
import { ShowAllButton } from './ShowAllButton'

const GROUPS: { id: DimensionGroup; label: string }[] = [
  { id: 'form', label: 'Form' },
  { id: 'orientation', label: 'Orientation' },
  { id: 'location', label: 'Location' },
]

export function ToleranceSection({
  editorOpen,
}: {
  /** True while any editor is open — element, dimension or alignment. */
  editorOpen: boolean
}) {
  const elements = useStore((s) => s.elements)
  const dimensions = useStore((s) => s.dimensions)
  const dimDraft = useStore((s) => s.dimDraft)
  const startDimension = useStore((s) => s.startDimension)
  const editDimension = useStore((s) => s.editDimension)
  const setDimensionName = useStore((s) => s.setDimensionName)
  const setDimensionType = useStore((s) => s.setDimensionType)
  const setDimensionRef = useStore((s) => s.setDimensionRef)
  const setDimensionLimit = useStore((s) => s.setDimensionLimit)
  const setDimensionBasic = useStore((s) => s.setDimensionBasic)
  const cancelDimension = useStore((s) => s.cancelDimension)
  const commitDimension = useStore((s) => s.commitDimension)
  const removeDimension = useStore((s) => s.removeDimension)
  const toggleDimensionVisible = useStore((s) => s.toggleDimensionVisible)
  const setAllDimensionsVisible = useStore((s) => s.setAllDimensionsVisible)

  const own = useMemo(
    () => dimensions.filter((d) => dimensionTypeInfo(d.type).family === 'tolerance'),
    [dimensions],
  )
  // A plane's tolerance reads the plane's surface, which can arrive or move
  // without the store changing — hence the version in the dependencies.
  const surfaceVersion = useSurfaces((s) => s.version)
  const evaluated = useMemo(
    () => evaluateDimensions(own, elements, surfaceSource),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [own, elements, surfaceVersion],
  )

  const info = dimDraft ? dimensionTypeInfo(dimDraft.type) : null
  const ownDraft = dimDraft !== null && info?.family === 'tolerance'

  // Live preview of the tolerance being built.
  let preview: DimensionValue | null = null
  if (ownDraft && dimDraft && info && dimDraft.refs.every((r) => r !== null)) {
    const fits = dimDraft.refs.map((id) => elements.find((e) => e.id === id)?.fit)
    preview = fits.every((f): f is FitData => f !== undefined)
      ? evaluateDimension(dimDraft.type, fits, {
          basic: dimDraft.basic,
          surfaces: dimDraft.refs.map((id) => (id !== null ? surfaceSource(id) : null)),
        })
      : { label: info.label, invalid: 'A referenced element is unavailable.' }
  }
  const verdict =
    preview?.raw !== undefined && !preview.invalid && dimDraft?.limit && info
      ? judgeLimit(preview.raw, dimDraft.limit, info.unit)
      : undefined
  const anyFitted = elements.some((e) => e.fit)

  return (
    <div className="group">
      <div className="sec-head">
        GD&amp;T
        <InfoDot title="Geometric tolerances">
          <p>
            What a drawing&apos;s feature control frames ask for: how flat, round, cylindrical or
            spherical a feature is on its own, how parallel, square or angled it lies to a datum,
            and how well it shares the datum&apos;s axis.
          </p>
          <p>
            Each reads the elements you have fitted — a face by its measured surface, a bore or a
            pin by its axis, a ball by its centre — and is the width of the narrowest zone that still
            holds the feature, the number to compare against the frame. Datums are elements too:
            pick the one the drawing names.
          </p>
          <p>
            Type a limit and the reading is judged against it, here, on the pin and in the copied
            summary.
          </p>
        </InfoDot>
        {own.length > 0 && <b>{own.length}</b>}
      </div>

      {!ownDraft ? (
        <button
          className="block"
          data-test="new-tolerance"
          disabled={!anyFitted || dimDraft !== null}
          onClick={() => startDimension('form-flatness')}
        >
          New tolerance
        </button>
      ) : (
        dimDraft &&
        info && (
          <div className="draftbox dimbox">
            <div className="sec-head">
              {dimDraft.editId !== undefined
                ? `Edit ${dimensions.find((d) => d.id === dimDraft.editId)?.name ?? 'tolerance'}`
                : 'New tolerance'}
            </div>
            {dimDraft.editId !== undefined && (
              <NameField
                value={dimDraft.name ?? ''}
                testId="tol-name"
                onChange={(name) => setDimensionName(name)}
              />
            )}
            <label className="field">
              <span>Type</span>
              <select
                data-test="tol-type"
                value={dimDraft.type}
                onChange={(e) => setDimensionType(e.target.value)}
              >
                {GROUPS.map((g) => (
                  <optgroup key={g.id} label={g.label}>
                    {TOLERANCE_TYPES.filter((t) => t.group === g.id).map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <p className="hint">{info.hint}</p>
            {info.slots.map((slot, i) => (
              <RefSelect
                key={i}
                label={slot.label}
                options={providersFor(slot.roles, elements, undefined, slot.kinds)}
                value={dimDraft.refs[i]}
                testId={`tol-ref-${i}`}
                picking={false}
                onChange={(id) => setDimensionRef(i, id)}
              />
            ))}
            {dimDraft.type === 'orient-angularity' && (
              <label className="field">
                <span>
                  Basic angle
                  <InfoDot title="Basic angle">
                    <p>
                      The angle the drawing draws the feature at, in a box: the zone is laid at
                      exactly this angle to the datum, and the value is how far the feature spreads
                      across it.
                    </p>
                  </InfoDot>
                </span>
                <OptionalNumber
                  value={dimDraft.basic}
                  placeholder="type"
                  step={0.01}
                  min={0}
                  unit="°"
                  testId="tol-basic"
                  onCommit={setDimensionBasic}
                />
              </label>
            )}
            <LimitFields
              family="tolerance"
              unit={info.unit}
              limit={dimDraft.limit}
              onChange={setDimensionLimit}
            />

            {preview && (
              <div className="dro">
                <div className="dro-label">
                  <span>{preview.label}</span>
                </div>
                <ValueWindow value={preview} testId="tol-preview" over={verdict ? !verdict.pass : false} />
                {verdict && <VerdictNote verdict={verdict} />}
                {(preview.warning ?? preview.invalid) && (
                  <WarningNote text={(preview.warning ?? preview.invalid)!} />
                )}
              </div>
            )}

            <button
              className="primary block"
              data-test="add-tolerance"
              disabled={!preview || Boolean(preview.invalid)}
              onClick={commitDimension}
            >
              {dimDraft.editId !== undefined ? 'Save changes' : 'Add tolerance'}
            </button>
            <div className="toolrow">
              <button data-test="cancel-tolerance" onClick={cancelDimension}>
                Cancel
              </button>
            </div>
          </div>
        )
      )}

      {own.length > 0 && (
        <div className="g-label">
          <span>Tolerances</span>
          <ShowAllButton
            anyVisible={own.some((d) => d.visible !== false)}
            what="tolerances"
            testId="tolerances-show-all"
            onSet={(visible) => setAllDimensionsVisible(visible, 'tolerance')}
          />
        </div>
      )}
      {evaluated.map(({ dim, title, value, verdict: v }) => (
        <DimensionRow
          key={dim.id}
          name={dim.name}
          visible={dim.visible !== false}
          title={title}
          value={value}
          verdict={v}
          testPrefix="tolerance"
          editorOpen={editorOpen}
          onEdit={() => editDimension(dim.id)}
          onToggleVisible={() => toggleDimensionVisible(dim.id)}
          onDelete={() => removeDimension(dim.id)}
        />
      ))}
    </div>
  )
}

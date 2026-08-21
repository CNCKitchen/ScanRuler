// SPDX-License-Identifier: AGPL-3.0-only
// The 2D dimension group — the twin of DimensionSection: the editor a
// dimension is assembled or re-opened in, and the DRO rows the finished
// dimensions are read from.

import { useMemo } from 'react'
import {
  FLAT_DIMENSION_TYPES,
  evaluateFlatDimension,
  evaluateFlatDimensions,
  flatDimensionTypeInfo,
  type FlatDimensionValue,
} from '../core/flat/dimensions'
import { FLAT_ROLE_PROVIDERS } from '../core/flat/refs'
import type { FlatFit } from '../core/flat/types'
import { useFlat } from '../state/flatStore'
import { DimensionRow, WarningNote } from './DimensionRow'
import { ShowAllButton } from './ShowAllButton'
import { ValueWindow } from './DroValue'
import { InfoDot } from './InfoDot'
import { NameField, RefSelect } from './RefSelect'

export function FlatDimensionSection({
  editorOpen,
}: {
  /** True while any editor is open — element or dimension. */
  editorOpen: boolean
}) {
  const elements = useFlat((s) => s.elements)
  const dimensions = useFlat((s) => s.dimensions)
  const dimDraft = useFlat((s) => s.dimDraft)
  const startDimDraft = useFlat((s) => s.startDimDraft)
  const editDimension = useFlat((s) => s.editDimension)
  const setDimName = useFlat((s) => s.setDimName)
  const setDimType = useFlat((s) => s.setDimType)
  const setDimRef = useFlat((s) => s.setDimRef)
  const cancelDimDraft = useFlat((s) => s.cancelDimDraft)
  const commitDim = useFlat((s) => s.commitDim)
  const deleteDimension = useFlat((s) => s.deleteDimension)
  const toggleDimensionVisible = useFlat((s) => s.toggleDimensionVisible)
  const setAllDimensionsVisible = useFlat((s) => s.setAllDimensionsVisible)

  const evaluated = useMemo(() => evaluateFlatDimensions(dimensions, elements), [dimensions, elements])

  // Live preview of the dimension being built, once both slots hold something.
  const dimInfo = dimDraft ? flatDimensionTypeInfo(dimDraft.type) : null
  let dimPreview: FlatDimensionValue | null = null
  if (dimDraft && dimInfo && dimDraft.refs.every((r) => r !== null)) {
    const fits = dimDraft.refs.map((id) => elements.find((e) => e.id === id)?.fit)
    dimPreview = fits.every((f): f is FlatFit => f !== undefined && f !== null)
      ? evaluateFlatDimension(dimDraft.type, fits)
      : { label: dimInfo.label, invalid: 'A referenced element is unavailable.' }
  }
  const measurable = elements.filter((e) => e.fit).length

  return (
    <div className="group">
      <div className="sec-head">
        Create dimensions
        <InfoDot title="Dimensions">
          <p>
            Measurements between elements: point–point and point–line distances, the width between
            two near-parallel lines, the angle between two lines. Values follow the elements — re-fit
            or recalibrate and every dimension updates.
          </p>
          <p>Distances and angles between elements never change under a datum.</p>
        </InfoDot>
        {dimensions.length > 0 && <b>{dimensions.length}</b>}
      </div>

      {dimDraft === null ? (
        <>
          <button
            className="block"
            data-test="flat-new-dimension"
            disabled={measurable < 2}
            onClick={startDimDraft}
          >
            New dimension
          </button>
          {measurable < 2 && (
            <p className="hint">Create at least two elements first, then measure between them.</p>
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
              <NameField value={dimDraft.name ?? ''} testId="flat-dim-name" onChange={setDimName} />
            )}
            <label className="field">
              <span>Type</span>
              <select
                data-test="flat-dim-type"
                value={dimDraft.type}
                onChange={(e) => setDimType(e.target.value)}
              >
                <optgroup label="Distance">
                  {FLAT_DIMENSION_TYPES.filter((t) => t.group === 'distance').map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Angle">
                  {FLAT_DIMENSION_TYPES.filter((t) => t.group === 'angle').map((t) => (
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
                key={slot.label + i}
                label={slot.label}
                options={elements.filter(
                  (el) =>
                    el.fit &&
                    FLAT_ROLE_PROVIDERS[slot.role].includes(el.kind) &&
                    !dimDraft.refs.some((r, j) => j !== i && r === el.id),
                )}
                value={dimDraft.refs[i] ?? null}
                testId={`flat-dim-slot-${i}`}
                onChange={(id) => setDimRef(i, id)}
              />
            ))}

            {dimPreview && (
              <div className="dro">
                <div className="dro-label">
                  <span>{dimPreview.label}</span>
                </div>
                <ValueWindow value={dimPreview} testId="flat-dim-preview" />
                {(dimPreview.warning ?? dimPreview.invalid) && (
                  <WarningNote text={(dimPreview.warning ?? dimPreview.invalid)!} />
                )}
              </div>
            )}

            <button
              className="primary block"
              data-test="flat-add-dimension"
              disabled={!dimPreview || Boolean(dimPreview.invalid)}
              onClick={commitDim}
            >
              {dimDraft.editId !== undefined ? 'Save changes' : 'Add dimension'}
            </button>
            <div className="toolrow">
              <button data-test="flat-dim-cancel" onClick={cancelDimDraft}>
                Cancel
              </button>
            </div>
          </div>
        )
      )}

      {dimensions.length > 0 && (
        <div className="g-label">
          <span>Dimensions</span>
          <ShowAllButton
            anyVisible={dimensions.some((d) => d.visible)}
            what="dimensions"
            testId="flat-dimensions-show-all"
            onSet={setAllDimensionsVisible}
          />
        </div>
      )}
      {evaluated.map(({ dim, title, value }) => (
        <DimensionRow
          key={dim.id}
          name={dim.name}
          visible={dim.visible}
          title={title}
          value={value}
          editorOpen={editorOpen}
          onEdit={() => editDimension(dim.id)}
          onToggleVisible={() => toggleDimensionVisible(dim.id)}
          onDelete={() => deleteDimension(dim.id)}
        />
      ))}
    </div>
  )
}

// SPDX-License-Identifier: AGPL-3.0-only
// The dimension group: the editor a dimension is assembled in, and the DRO
// rows the finished dimensions are read from.

import { useMemo } from 'react'
import {
  DIMENSION_TYPES,
  dimensionTypeInfo,
  evaluateDimension,
  evaluateDimensions,
  type Dimension,
  type DimensionValue,
  type SphereAnchor,
} from '../core/dimensions'
import type { FitData } from '../core/types'
import { useStore } from '../state/store'
import { ValueWindow } from './DroValue'
import { InfoDot } from './InfoDot'
import { NameField, RefSelect } from './RefSelect'
import { RowTools } from './RowTools'

function WarningNote({ text }: { text: string }) {
  return <p className="warnnote">⚠ {text}</p>
}

/** One finished dimension, read the way the preview above it is. */
function DimensionRow({
  dim,
  title,
  value,
  editorOpen,
  onEdit,
  onToggleVisible,
  onDelete,
}: {
  dim: Dimension
  /** The referenced element names, joined — what the dimension runs between. */
  title: string
  value: DimensionValue
  /** True while anything is being assembled — the edit key stands down, since
   *  re-opening would throw away what is already in the box. */
  editorOpen: boolean
  onEdit: () => void
  onToggleVisible: () => void
  onDelete: () => void
}) {
  return (
    <div className="dro hero dim" data-test="dimension-row">
      <div className="dro-label">
        <span>
          {dim.name} · {value.label}
        </span>
        <span className="dro-tools">
          <span className="dro-title">{title}</span>
          <RowTools
            name={dim.name}
            visible={dim.visible !== false}
            editTestId="edit-dimension"
            editDisabled={editorOpen}
            editTitle={
              editorOpen
                ? 'Finish what is open first'
                : `Edit ${dim.name} — change its type or what it measures between`
            }
            onEdit={onEdit}
            onToggleVisible={onToggleVisible}
            onDelete={onDelete}
          />
        </span>
      </div>
      <ValueWindow value={value} testId="dimension-value" />
      {value.detail && !value.invalid && <div className="dro-note">{value.detail}</div>}
      {(value.warning ?? value.invalid) && (
        <WarningNote text={(value.warning ?? value.invalid)!} />
      )}
    </div>
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
  const dimensions = useStore((s) => s.dimensions)
  const dimDraft = useStore((s) => s.dimDraft)
  const startDimension = useStore((s) => s.startDimension)
  const editDimension = useStore((s) => s.editDimension)
  const setDimensionName = useStore((s) => s.setDimensionName)
  const setDimensionType = useStore((s) => s.setDimensionType)
  const setDimensionRef = useStore((s) => s.setDimensionRef)
  const setDimensionAnchor = useStore((s) => s.setDimensionAnchor)
  const cancelDimension = useStore((s) => s.cancelDimension)
  const commitDimension = useStore((s) => s.commitDimension)
  const removeDimension = useStore((s) => s.removeDimension)
  const toggleDimensionVisible = useStore((s) => s.toggleDimensionVisible)

  // Every dimension re-reads its elements, so this is real work — memoised so
  // an unrelated render (a checkbox, a hover) does not repeat it.
  const evaluated = useMemo(() => evaluateDimensions(dimensions, elements), [dimensions, elements])

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
                <ValueWindow value={dimPreview} testId="dim-preview" />
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
        <DimensionRow
          key={dim.id}
          dim={dim}
          title={title}
          value={value}
          editorOpen={editorOpen}
          onEdit={() => editDimension(dim.id)}
          onToggleVisible={() => toggleDimensionVisible(dim.id)}
          onDelete={() => removeDimension(dim.id)}
        />
      ))}
    </div>
  )
}

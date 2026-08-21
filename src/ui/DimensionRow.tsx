// SPDX-License-Identifier: AGPL-3.0-only
// One finished dimension, read the way the preview above it is: a DRO window
// with the name and kind over it, the elements it runs between beside the
// row keys, and a note or a warning under it. Shared by the 3D and 2D
// dimension lists.

import { ValueWindow, type ReadValue } from './DroValue'
import { RowTools } from './RowTools'

export function WarningNote({ text }: { text: string }) {
  return <p className="warnnote">⚠ {text}</p>
}

export function DimensionRow({
  name,
  visible,
  title,
  value,
  editorOpen,
  onEdit,
  onToggleVisible,
  onDelete,
}: {
  name: string
  visible: boolean
  /** The referenced element names, joined — what the dimension runs between. */
  title: string
  value: ReadValue
  /** True while anything is being assembled — the edit key stands down, since
   *  re-opening would throw away what is already in the box. */
  editorOpen: boolean
  onEdit: () => void
  onToggleVisible: () => void
  onDelete: () => void
}) {
  return (
    <div className={'dro hero dim' + (visible ? '' : ' ghost')} data-test="dimension-row">
      <div className="dro-label">
        <span>
          {name} · {value.label}
        </span>
        <span className="dro-tools">
          <span className="dro-title">{title}</span>
          <RowTools
            name={name}
            visible={visible}
            editTestId="edit-dimension"
            editDisabled={editorOpen}
            editTitle={
              editorOpen
                ? 'Finish what is open first'
                : `Edit ${name} — change its type or what it measures between`
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

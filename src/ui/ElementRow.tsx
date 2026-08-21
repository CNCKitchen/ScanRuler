// SPDX-License-Identifier: AGPL-3.0-only
// One row of the element list: colour dot, name, primary reading, tools.
// Shared by the 3D and 2D workspaces — the row knows nothing about how its
// element was measured, only what to read and which keys to offer.

import type { ReactNode } from 'react'
import { RowTools } from './RowTools'

export function ElementRow({
  name,
  color,
  visible,
  reading,
  selected,
  editorOpen,
  editDisabled,
  onEdit,
  onToggleVisible,
  onDelete,
}: {
  name: string
  color: string
  visible: boolean
  /** The reading at the end of the row: a primary value, a spinner, a ⚠. */
  reading: ReactNode
  /** Referenced by whatever is being built — marked to mirror its glow in
   *  the viewport. */
  selected: boolean
  /** True while anything is being assembled — the row keys stand down, since
   *  re-opening would throw away what is already in the box. */
  editorOpen: boolean
  /** The edit key standing down for a reason of the row's own (a fit still
   *  running). */
  editDisabled?: boolean
  onEdit: () => void
  onToggleVisible: () => void
  onDelete: () => void
}) {
  return (
    <div
      className={'kv' + (visible ? '' : ' ghost') + (selected ? ' sel' : '')}
      data-test="element-row"
    >
      <span className="dot" style={{ background: color }} />
      <span className="name">{name}</span>
      {reading}
      <RowTools
        name={name}
        visible={visible}
        editTestId="edit-element"
        editDisabled={editorOpen || Boolean(editDisabled)}
        editTitle={
          editorOpen
            ? 'Finish what is open first'
            : `Edit ${name} — change what it is measured on or built from`
        }
        onEdit={onEdit}
        onToggleVisible={onToggleVisible}
        onDelete={onDelete}
      />
    </div>
  )
}

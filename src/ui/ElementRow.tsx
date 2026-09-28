// SPDX-License-Identifier: AGPL-3.0-only
// One row of the element list: colour dot, name, primary reading, tools.
// Shared by the 3D and 2D workspaces — the row knows nothing about how its
// element was measured, only what to read and which keys to offer.

import type { ReactNode } from 'react'
import { Icon, type IconName } from './icons'
import { RowTools } from './RowTools'

export function ElementRow({
  name,
  color,
  icon,
  title,
  visible,
  reading,
  selected,
  muted = false,
  editorOpen,
  editDisabled,
  testId = 'element-row',
  onEdit,
  onToggleVisible,
  onDelete,
}: {
  name: string
  color: string
  /** An icon in place of the colour dot, drawn in the colour — a feature
   *  row's kind, as a CAD tree shows it. */
  icon?: IconName
  /** What the row says on hover: the reading in words. */
  title?: string
  visible: boolean
  /** The reading at the end of the row: a primary value, a spinner, a ⚠. */
  reading: ReactNode
  /** Referenced by whatever is being built — marked to mirror its glow in
   *  the viewport. */
  selected: boolean
  /** Set aside for the moment — a feature after the one being edited,
   *  which the part is built without while the box is open. */
  muted?: boolean
  /** True while anything is being assembled — the row keys stand down, since
   *  re-opening would throw away what is already in the box. */
  editorOpen: boolean
  /** The edit key standing down for a reason of the row's own (a fit still
   *  running). */
  editDisabled?: boolean
  /** What the row is, for the tests — an element unless said otherwise. */
  testId?: string
  onEdit: () => void
  onToggleVisible: () => void
  onDelete: () => void
}) {
  // A double click on the row opens it too, as a feature row in a CAD
  // tree does — with the same standing down as the ✎ key.
  const canEdit = !editorOpen && !editDisabled
  return (
    <div
      className={'kv' + (visible ? '' : ' ghost') + (selected ? ' sel' : '') + (muted ? ' rolled' : '')}
      data-test={testId}
      data-rolled={muted ? 'true' : undefined}
      title={title}
      onDoubleClick={canEdit ? onEdit : undefined}
    >
      {icon ? (
        <span className="kind" style={{ color }}>
          <Icon name={icon} size={15} />
        </span>
      ) : (
        <span className="dot" style={{ background: color }} />
      )}
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

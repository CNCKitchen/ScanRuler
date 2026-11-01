// SPDX-License-Identifier: AGPL-3.0-only
// The edit / eye / bin trio at the end of an element or dimension row: re-open it,
// hide it in the viewport, delete it.

import type { ReactNode } from 'react'
import { Icon } from './icons'

export function RowTools({
  name,
  visible,
  editTestId,
  editDisabled,
  editTitle,
  onEdit,
  onToggleVisible,
  onDelete,
  eyeKey,
}: {
  /** The row's element or dimension name, worked into the button titles. */
  name: string
  visible: boolean
  editTestId: string
  editDisabled: boolean
  /** What the edit button does, or why it is standing down. */
  editTitle: string
  onEdit: () => void
  onToggleVisible: () => void
  onDelete: () => void
  /** A key of the caller's own in the eye's place — for a row whose thing
   *  is not shown or hidden but switched some other way. */
  eyeKey?: ReactNode
}) {
  return (
    <>
      <button
        className="x edit"
        data-test={editTestId}
        disabled={editDisabled}
        title={editTitle}
        aria-label={`Edit ${name}`}
        onClick={onEdit}
      >
        <Icon name="edit" size={14} />
      </button>
      {eyeKey ?? (
        <button
          className="x eye"
          title={visible ? `Hide ${name} in the viewport` : `Show ${name}`}
          aria-label={visible ? `Hide ${name} in the viewport` : `Show ${name}`}
          aria-pressed={visible}
          onClick={onToggleVisible}
        >
          <Icon name={visible ? 'eye' : 'eyeOff'} size={14} />
        </button>
      )}
      <button className="x" aria-label={`Delete ${name}`} title={`Delete ${name}`} onClick={onDelete}>
        <Icon name="bin" size={14} />
      </button>
    </>
  )
}

// SPDX-License-Identifier: AGPL-3.0-only
// The ✎ / ◉ / ✕ trio at the end of an element or dimension row: re-open it,
// hide it in the viewport, delete it.

export function RowTools({
  name,
  visible,
  editTestId,
  editDisabled,
  editTitle,
  onEdit,
  onToggleVisible,
  onDelete,
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
}) {
  return (
    <>
      <button
        className="x edit"
        data-test={editTestId}
        disabled={editDisabled}
        title={editTitle}
        onClick={onEdit}
      >
        ✎
      </button>
      <button
        className="x eye"
        title={visible ? `Hide ${name} in the viewport` : `Show ${name}`}
        onClick={onToggleVisible}
      >
        {visible ? '◉' : '○'}
      </button>
      <button className="x" title={`Delete ${name}`} onClick={onDelete}>
        ✕
      </button>
    </>
  )
}

// SPDX-License-Identifier: AGPL-3.0-only
// One row of the element list: colour dot, name, primary reading, tools.
// Shared by the 3D and 2D workspaces — the row knows nothing about how its
// element was measured, only what to read and which keys to offer.

import { useRef, useState, type ReactNode } from 'react'
import { Icon, type IconName } from './icons'
import { RowTools } from './RowTools'

export function ElementRow({
  name,
  color,
  icon,
  picture,
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
  eyeKey,
  onSelect,
  onRename,
}: {
  name: string
  color: string
  /** An icon in place of the colour dot, drawn in the colour — a feature
   *  row's kind, as a CAD tree shows it. */
  icon?: IconName
  /** A picture of the caller's own in the icon's place, drawn the same way. */
  picture?: ReactNode
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
  /** A key of the caller's own in the eye's place — see RowTools. */
  eyeKey?: ReactNode
  onSelect?: (additive: boolean) => void
  onRename?: (name: string) => void
}) {
  const row = useRef<HTMLDivElement>(null)
  const focusRow = () => queueMicrotask(() => row.current?.focus())
  const [renaming, setRenaming] = useState<string | null>(null)
  // A double click on the row opens it too, as a feature row in a CAD
  // tree does — with the same standing down as the ✎ key.
  const canEdit = !editorOpen && !editDisabled
  return (
    <div
      ref={row}
      className={'kv' + (visible ? '' : ' ghost') + (selected ? ' sel' : '') + (muted ? ' rolled' : '')}
      data-test={testId}
      data-rolled={muted ? 'true' : undefined}
      title={title}
      role={onSelect ? 'treeitem' : undefined}
      aria-selected={onSelect ? selected : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onClick={onSelect ? (e) => {
        if ((e.target as HTMLElement).closest('button,input')) return
        onSelect(e.shiftKey || e.metaKey || e.ctrlKey)
      } : undefined}
      onKeyDown={onSelect ? (e) => {
        if ((e.target as HTMLElement).closest('input,button')) return
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onSelect(e.shiftKey || e.metaKey || e.ctrlKey) }
        if (e.key === 'F2' && onRename && canEdit) { e.preventDefault(); setRenaming(name) }
      } : undefined}
      onDoubleClick={canEdit ? onEdit : undefined}
    >
      {icon || picture ? (
        <span className="kind" style={{ color }}>
          {picture ?? <Icon name={icon!} size={15} />}
        </span>
      ) : (
        <span className="dot" style={{ background: color }} />
      )}
      {renaming !== null ? <input autoFocus aria-label={`Rename ${name}`} value={renaming}
        onChange={(e) => setRenaming(e.target.value)}
        onBlur={() => { if (renaming.trim()) onRename?.(renaming); setRenaming(null) }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') { e.preventDefault(); setRenaming(null); focusRow() }
          if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); focusRow() }
        }} /> : <span className="name" onDoubleClick={onRename && canEdit ? (e) => {
          e.stopPropagation(); setRenaming(name)
        } : undefined}>{name}</span>}
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
        eyeKey={eyeKey}
      />
    </div>
  )
}

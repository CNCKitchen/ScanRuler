// SPDX-License-Identifier: AGPL-3.0-only
// One row of the element list: colour dot, name, primary reading, tools.

import { formatPrimary } from '../core/summary'
import { useStore, type Element } from '../state/store'
import { RowTools } from './RowTools'

export function ElementRow({
  el,
  selected,
  editorOpen,
  onEdit,
  onDelete,
}: {
  el: Element
  /** Referenced by whatever is being built — marked to mirror its glow in
   *  the viewport. */
  selected: boolean
  /** True while anything is being assembled — the row keys stand down, since
   *  re-opening would throw away what is already in the box. */
  editorOpen: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  const toggleElementVisible = useStore((s) => s.toggleElementVisible)
  return (
    <div
      className={'kv' + (el.visible ? '' : ' ghost') + (selected ? ' sel' : '')}
      data-test="element-row"
    >
      <span className="dot" style={{ background: el.color }} />
      <span className="name">{el.name}</span>
      {el.status === 'fitting' ? (
        <b className="working">
          <span className="spinner" />
          fitting
        </b>
      ) : el.fit ? (
        <b>{formatPrimary(el.fit)}</b>
      ) : (
        <b className="warn" title={el.message}>
          ⚠
        </b>
      )}
      <RowTools
        name={el.name}
        visible={el.visible}
        editTestId="edit-element"
        editDisabled={editorOpen || el.status === 'fitting'}
        editTitle={
          editorOpen
            ? 'Finish what is open first'
            : `Edit ${el.name} — change what it is measured on or built from`
        }
        onEdit={onEdit}
        onToggleVisible={() => toggleElementVisible(el.id)}
        onDelete={onDelete}
      />
    </div>
  )
}

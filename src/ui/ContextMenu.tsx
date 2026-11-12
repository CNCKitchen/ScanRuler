// SPDX-License-Identifier: AGPL-3.0-only
// A right-click menu for a row of a list: the row's own keys and the one or
// two things only the menu offers, at the pointer. Closed by a pick, a press
// outside, Escape, a scroll or the window losing focus.

import { useState, type MouseEvent, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { useDismiss } from './useDismiss'

export interface MenuItem {
  label: string
  onSelect: () => void
  /** Standing down — drawn greyed, a click does nothing. */
  disabled?: boolean
  /** A destructive item, drawn in red. */
  danger?: boolean
  /** A rule above the item, setting it apart from the ones before. */
  rule?: boolean
}

const ITEM_H = 28
const MENU_W = 200

/** The handler for a row's `onContextMenu` and the menu to draw beside the
 *  row. `items` is read when the menu opens. */
export function useContextMenu(heading: string, items: () => MenuItem[]): { onContextMenu: (e: MouseEvent) => void; menu: ReactElement | null } {
  const [at, setAt] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  useDismiss(at !== null, () => setAt(null), { escape: 'pass', outside: '.ctx-menu' })
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setAt({ x: e.clientX, y: e.clientY, items: items() })
  }
  if (!at) return { onContextMenu, menu: null }
  // Kept on the screen: opened near the right or bottom edge, it opens
  // leftward or upward.
  const left = Math.max(4, Math.min(at.x, window.innerWidth - MENU_W - 8))
  const top = Math.max(4, Math.min(at.y, window.innerHeight - 40 - at.items.length * ITEM_H))
  const menu = createPortal(
    <div className="ctx-menu" role="menu" data-test="context-menu" style={{ left, top }} onContextMenu={(e) => e.preventDefault()}>
      <div className="ctx-head">{heading}</div>
      {at.items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          className={(item.danger ? 'danger' : '') + (item.rule ? ' rule' : '')}
          disabled={item.disabled}
          onClick={() => {
            setAt(null)
            item.onSelect()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  )
  return { onContextMenu, menu }
}

/** Copy `text` to the clipboard, where the browser allows it. */
export function copyText(text: string): void {
  void navigator.clipboard?.writeText(text)
}

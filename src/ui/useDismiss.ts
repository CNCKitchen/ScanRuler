// SPDX-License-Identifier: AGPL-3.0-only
// How a dialog or a menu goes away while it is open: Escape, and for a menu
// a press anywhere outside it, a scroll or the window losing focus.

import { useEffect, useRef } from 'react'

export interface DismissOptions {
  /** `take` (the default): Escape closes and goes no further — caught on its
   *  way down, so the workspace's own Escape, which would discard the draft
   *  behind, never sees it. `pass`: Escape closes and goes on to the page. */
  escape?: 'take' | 'pass'
  /** A menu's: also close on a press outside any element this selector
   *  matches, on a scroll anywhere, and when the window loses focus. */
  outside?: string
}

/** Close on the ways out while `open`; `onClose` may change between renders. */
export function useDismiss(open: boolean, onClose: () => void, options: DismissOptions = {}): void {
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const { escape = 'take', outside } = options
  useEffect(() => {
    if (!open) return
    const close = () => closeRef.current()
    const take = escape === 'take'
    const onKey = (e: KeyboardEvent) => {
      // A native modal owns Escape even when this background menu installed
      // its capture listener first.
      if (e.key !== 'Escape' || document.querySelector('dialog:modal')) return
      if (take) e.stopPropagation()
      close()
    }
    const onDown = (e: PointerEvent) => {
      if (outside && !(e.target as Element | null)?.closest?.(outside)) close()
    }
    window.addEventListener('keydown', onKey, take)
    if (outside) {
      window.addEventListener('pointerdown', onDown, true)
      window.addEventListener('scroll', close, true)
      window.addEventListener('blur', close)
    }
    return () => {
      window.removeEventListener('keydown', onKey, take)
      if (outside) {
        window.removeEventListener('pointerdown', onDown, true)
        window.removeEventListener('scroll', close, true)
        window.removeEventListener('blur', close)
      }
    }
  }, [open, escape, outside])
}

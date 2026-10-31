// SPDX-License-Identifier: AGPL-3.0-only
// The browser owns the modal stack, background inertness and return focus.
// Workspace shortcuts must not also act on keys pressed inside a dialog.
import { useLayoutEffect, useRef, type ReactNode } from 'react'

export function Modal({ children, labelledBy, onClose, className = '', initialFocus, onEnter }: {
  children: ReactNode
  labelledBy: string
  onClose: () => void
  className?: string
  initialFocus?: string
  onEnter?: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const dialog = ref.current!
    dialog.showModal()
    if (initialFocus) dialog.querySelector<HTMLElement>(initialFocus)?.focus()
    return () => dialog.close()
  }, [initialFocus])

  return (
    <dialog
      ref={ref}
      className={`modalback ${className}`.trim()}
      aria-labelledby={labelledBy}
      onCancel={(e) => { e.preventDefault(); onClose() }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      // A middle press must not confirm the editor behind the window. Let
      // releases through, so a gesture already in progress can still end.
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        // Native dialogs exclude background controls, but forward Tab at the
        // last control can visit browser chrome. Keep the dialog's cycle
        // explicit in both directions, including dynamically disabled fields.
        if (e.key === 'Tab') {
          const controls = [...e.currentTarget.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]')]
            .filter((el) => el.tabIndex >= 0 && !el.matches(':disabled') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden')
          const first = controls[0], last = controls.at(-1)
          if (!first || document.activeElement === (e.shiftKey ? first : last)) {
            e.preventDefault()
            const next = e.shiftKey ? last : first
            next?.focus()
          }
        }
        if (e.key === 'Enter' && onEnter && !(e.target as Element).closest('button, input, select, textarea, a, [contenteditable]')) {
          e.preventDefault()
          onEnter()
        }
      }}
      onKeyUp={(e) => e.stopPropagation()}
    >
      {children}
    </dialog>
  )
}

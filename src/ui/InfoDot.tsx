// SPDX-License-Identifier: AGPL-3.0-only
// The ⓘ key. A faceplate has room for a label, not a paragraph: the control
// says what it is, this says what it means, and only when asked. One click
// opens a card beside the dot with the whole explanation; anywhere else, Esc,
// or the dot again puts it away.
//
// The card is rendered into the body rather than in place — the panel it sits
// in is a narrow scrolling column with its overflow clipped, and an
// explanation that has to fit inside 306 px is no better than the paragraph it
// replaced.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** Gap between the dot and the card, and the margin the card keeps to the
 *  window edge. */
const GAP = 10
const EDGE = 8

export function InfoDot({
  title,
  children,
  testId,
}: {
  /** Heading of the card — the thing being explained, not a restatement of it. */
  title: string
  children: ReactNode
  testId?: string
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const dotRef = useRef<HTMLButtonElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  // Placed after the card has a size, so a tall card can be pushed up rather
  // than run off the bottom of the window.
  //
  // Horizontally it clears the whole panel rather than just the dot: a card
  // that opened at the dot would cover the controls it is there to explain,
  // and every dot in a column would put it somewhere different. Vertically it
  // stays level with its own dot, so it is obvious which one is speaking.
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const dot = dotRef.current
      const card = cardRef.current
      if (!dot || !card) return
      const r = dot.getBoundingClientRect()
      const host = (dot.closest('.panel') ?? dot).getBoundingClientRect()
      const { offsetWidth: w, offsetHeight: h } = card
      let left = host.right + GAP
      if (left + w > window.innerWidth - EDGE) {
        const flipped = host.left - GAP - w
        left = flipped >= EDGE ? flipped : Math.max(EDGE, window.innerWidth - EDGE - w)
      }
      const top = Math.max(EDGE, Math.min(r.top - EDGE, window.innerHeight - EDGE - h))
      setPos({ left, top })
    }
    place()
    // Capture, so the panel's own scrolling moves the card with its dot.
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!dotRef.current?.contains(t) && !cardRef.current?.contains(t)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      // Swallowed, or Esc would close the card and cancel the draft behind it
      // in the same keystroke.
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
        dotRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  return (
    <>
      <button
        ref={dotRef}
        type="button"
        className={'infodot' + (open ? ' on' : '')}
        data-test={testId}
        aria-expanded={open}
        aria-label={`More about ${title}`}
        onClick={(e) => {
          // The dot lives inside <label> rows, where an unswallowed click
          // would toggle the checkbox or focus the input it labels.
          e.preventDefault()
          e.stopPropagation()
          setOpen((v) => !v)
        }}
      >
        i
      </button>
      {open &&
        createPortal(
          <div
            ref={cardRef}
            className="infocard"
            role="dialog"
            aria-label={title}
            data-test={testId ? `${testId}-card` : undefined}
            style={{
              left: pos?.left ?? 0,
              top: pos?.top ?? 0,
              visibility: pos ? 'visible' : 'hidden',
            }}
          >
            <b>{title}</b>
            <div className="infocard-body">{children}</div>
          </div>,
          document.body,
        )}
    </>
  )
}

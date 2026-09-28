// SPDX-License-Identifier: AGPL-3.0-only
// A dropdown whose options can be pointed at: hovering one tells the owner,
// who shows the thing on the part — a plane in a list is a name, a plane on
// the scan is a place. A native <select> cannot say which option the cursor
// is over, so this is a button and a list of its own, styled like the
// selects around it and keyed like them: arrows to move, Enter to take,
// Escape to close.

import { useEffect, useRef, useState } from 'react'

export interface PickerOption {
  key: string
  label: string
  group?: string
}

export function RefPicker({
  value,
  options,
  placeholder,
  testId,
  disabled,
  onChange,
  onHover,
}: {
  /** The key of the chosen option, or null for none. */
  value: string | null
  options: readonly PickerOption[]
  placeholder: string
  testId: string
  disabled?: boolean
  onChange: (key: string) => void
  /** The option under the cursor, or null when the cursor left the list or
   *  the list closed. */
  onHover?: (key: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const root = useRef<HTMLDivElement>(null)
  const hoverRef = useRef(onHover)
  hoverRef.current = onHover

  // A click anywhere else closes the list, as a select's would.
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])
  // Closing takes the hint with it.
  useEffect(() => {
    if (!open) hoverRef.current?.(null)
  }, [open])

  const chosen = options.find((o) => o.key === value)
  const groups = Array.from(new Set(options.map((o) => o.group ?? '')))
  const choose = (key: string) => {
    onChange(key)
    setOpen(false)
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && open) {
      e.stopPropagation()
      setOpen(false)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) setOpen(true)
      const next = Math.max(0, Math.min(options.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1)))
      setActive(next)
      hoverRef.current?.(options[next]?.key ?? null)
    } else if (e.key === 'Enter' && open) {
      e.preventDefault()
      e.stopPropagation()
      if (options[active]) choose(options[active].key)
    }
  }

  return (
    <div className={'picker' + (open ? ' open' : '')} ref={root} onKeyDown={onKey}>
      <button
        type="button"
        className="picker-face"
        data-test={testId}
        data-value={value ?? ''}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className={chosen ? undefined : 'placeholder'}>{chosen?.label ?? placeholder}</span>
        <i>▾</i>
      </button>
      {open && (
        <div
          className="picklist"
          role="listbox"
          data-test={`${testId}-list`}
          onPointerLeave={() => hoverRef.current?.(null)}
          // The picker usually stands inside a <label>, and a click on an
          // option — which is no control of its own — would be passed on by
          // the label to its first control, the face button: the list the
          // option just closed would open again. The default is the label's.
          onClick={(e) => e.preventDefault()}
        >
          {groups.map((g) => (
            <div key={g} className="pickgroup">
              {g && <div className="pickgroup-label">{g}</div>}
              {options
                .filter((o) => (o.group ?? '') === g)
                .map((o) => {
                  const i = options.indexOf(o)
                  return (
                    <div
                      key={o.key}
                      role="option"
                      aria-selected={o.key === value}
                      className={'pickoption' + (o.key === value ? ' chosen' : '') + (i === active ? ' active' : '')}
                      data-test="pick-option"
                      onPointerEnter={() => {
                        setActive(i)
                        hoverRef.current?.(o.key)
                      }}
                      onClick={() => choose(o.key)}
                    >
                      {o.label}
                    </div>
                  )
                })}
            </div>
          ))}
          {options.length === 0 && <div className="pickoption empty">Nothing to choose from</div>}
        </div>
      )}
    </div>
  )
}

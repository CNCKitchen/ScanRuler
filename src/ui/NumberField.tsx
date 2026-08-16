// SPDX-License-Identifier: AGPL-3.0-only
// A number with its unit, committed on blur or Enter so a half-typed "0."
// never re-scales a map mid-keystroke. Shared by every workspace that puts a
// figure in front of the user to change.

import { useRef, type ReactNode } from 'react'
import { InfoDot } from './InfoDot'

export function NumberField({
  label,
  value,
  step,
  min,
  unit,
  disabled,
  onCommit,
  hint,
  testId,
}: {
  label: string
  value: number
  step: number
  min: number
  unit: string
  disabled?: boolean
  onCommit: (v: number) => void
  /** What the number does, on the ⓘ key beside its label. */
  hint?: ReactNode
  testId?: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <label className="field">
      <span>
        {label}
        {hint !== undefined && <InfoDot title={label}>{hint}</InfoDot>}
      </span>
      <span className="unitfield">
        <input
          ref={ref}
          type="number"
          data-test={testId}
          step={step}
          min={min}
          disabled={disabled}
          defaultValue={value}
          key={value}
          onBlur={(e) => {
            const v = Number(e.target.value)
            if (Number.isFinite(v) && v >= min) onCommit(v)
            else e.target.value = String(value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') ref.current?.blur()
          }}
        />
        <i>{unit}</i>
      </span>
    </label>
  )
}

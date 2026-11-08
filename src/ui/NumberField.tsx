// SPDX-License-Identifier: AGPL-3.0-only
// A number with its unit, committed on blur or Enter so a half-typed "0."
// never re-scales a map mid-keystroke. Shared by every workspace that puts a
// figure in front of the user to change.
//
// A length (kind="length") is held in millimetres and shown and typed in the
// display units: the field converts both ways, writes the unit itself, and
// takes step and min in millimetres like the value.

import { useRef, type InputHTMLAttributes, type ReactNode } from 'react'
import { useUnits } from '../app/useUnits'
import { fromDisplay, lengthInputText, lengthStep, toDisplay, unitWord, type DisplayUnits } from '../core/units'
import { InfoDot } from './InfoDot'

/** What a field shows and accepts, given what it holds: the conversion a
 *  length field makes, or none. */
export interface FieldUnits {
  text: (held: number) => string
  read: (typed: number) => number
  step: (step: number | 'any') => number | 'any'
  min: (min: number) => number
  word: string
}

const plain = (unit: string): FieldUnits => ({
  text: String,
  read: (v) => v,
  step: (s) => s,
  min: (m) => m,
  word: unit,
})

export function lengthField(units: DisplayUnits): FieldUnits {
  return {
    text: (mm) => lengthInputText(mm, units),
    read: (v) => fromDisplay(v, units),
    step: (s) => (s === 'any' ? s : lengthStep(s, units)),
    min: (m) => (Number.isFinite(m) ? toDisplay(m, units) : m),
    word: unitWord(units),
  }
}

/** The conversion for a field of `kind`, with the units read from the
 *  preference. Called on every render, in the same order, either way. */
export function useFieldUnits(kind: 'length' | undefined, unit: string | undefined): FieldUnits {
  const units = useUnits()
  return kind === 'length' ? lengthField(units) : plain(unit ?? '')
}

/**
 * The bare input of a number committed on blur or Enter, for a field laid
 * out by its caller. A field that takes each keystroke and clamps or drops
 * what it cannot hold yet throws away a half-typed figure: "0.0" on the way
 * to 0.05 is not above 0, "1" on the way to 12 sides is under 3, and the
 * text snapped back under the hand (issue 81). This holds whatever is typed
 * and hands it over once: `onCommit` gets the figure as typed, in the units
 * shown, or null where the field was emptied. Text left as `value` showed it
 * commits nothing. `value` null shows the field empty.
 */
export function NumberInput({
  value,
  text = String,
  onCommit,
  ...input
}: {
  value: number | null
  /** How the value is written in the field; plain by default. */
  text?: (value: number) => string
  onCommit: (typed: number | null) => void
  'data-test'?: string
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'defaultValue' | 'onChange' | 'onBlur' | 'type'>) {
  const shown = value === null ? '' : text(value)
  return (
    <input
      {...input}
      type="number"
      defaultValue={shown}
      key={shown}
      onBlur={(e) => {
        const typed = e.target.value.trim()
        if (typed !== shown) {
          const v = Number(typed)
          if (typed === '') onCommit(null)
          else if (Number.isFinite(v)) onCommit(v)
        }
        // As NumberField: the text the store did not take goes back to
        // what it holds; a commit it took re-keys the input over this.
        e.target.value = shown
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        input.onKeyDown?.(e)
      }}
    />
  )
}

export function NumberField({
  label,
  value,
  step,
  min,
  unit,
  kind,
  disabled,
  onCommit,
  hint,
  testId,
}: {
  label: string
  value: number
  step: number | 'any'
  min: number
  /** The unit word for a figure that is not a length — a length's field
   *  writes its own. */
  unit?: string
  /** 'length': value, step and min are millimetres, shown in the display
   *  units. */
  kind?: 'length'
  disabled?: boolean
  onCommit: (v: number) => void
  /** What the number does, on the ⓘ key beside its label. */
  hint?: ReactNode
  testId?: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  const u = useFieldUnits(kind, unit)
  const shown = u.text(value)
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
          step={u.step(step)}
          min={u.min(min)}
          disabled={disabled}
          defaultValue={shown}
          key={shown}
          onBlur={(e) => {
            // Text left as it was shown commits nothing: in inches the shown
            // figure is rounded, and committing it back would move the value.
            if (e.target.value !== shown) {
              const v = u.read(Number(e.target.value))
              if (Number.isFinite(v) && v >= min) onCommit(v)
            }
            // Rewrite the text either way: when the store clamps the commit
            // back to the value already held, nothing re-renders, and the
            // rejected text would otherwise stay on screen. A commit that
            // does change the value re-keys the input over this.
            e.target.value = shown
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') ref.current?.blur()
          }}
        />
        <i>{u.word}</i>
      </span>
    </label>
  )
}

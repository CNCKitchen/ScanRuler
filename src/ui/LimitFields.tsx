// SPDX-License-Identifier: AGPL-3.0-only
// The limit a measurement is held to, typed in beside it — optional, so the
// fields are empty until something is asked of the value. A tolerance takes
// one ceiling; a dimension a nominal with an allowance either side, the
// minus side left blank for a symmetric one. A limit on a length is held in
// millimetres and typed in the display units.

import { useRef } from 'react'
import { bandFollows, editBand, type DimensionFamily, type DimensionUnit, type Limit } from '../core/dimensions'
import { InfoDot } from './InfoDot'
import { useFieldUnits } from './NumberField'

/** A number that may be left out: empty commits undefined. Committed on
 *  blur or Enter like NumberField, so a half-typed "0." never judges a
 *  reading mid-keystroke. */
export function OptionalNumber({
  value,
  placeholder,
  step,
  min,
  unit,
  kind,
  testId,
  onCommit,
}: {
  value: number | undefined
  placeholder: string
  step: number
  min: number
  /** The unit word for a figure that is not a length — see NumberField. */
  unit?: string
  /** 'length': value, step and min are millimetres, shown in the display
   *  units. */
  kind?: 'length'
  testId: string
  onCommit: (v: number | undefined) => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const u = useFieldUnits(kind, unit)
  const shown = value === undefined ? '' : u.text(value)
  return (
    <span className="unitfield">
      <input
        ref={ref}
        type="number"
        data-test={testId}
        step={u.step(step)}
        min={u.min(min)}
        placeholder={placeholder}
        defaultValue={shown}
        key={shown}
        onBlur={(e) => {
          const text = e.target.value.trim()
          // A typo ("0.1.2", "1e") reads as empty to a number input: it goes
          // back to what is held instead of taking the limit off.
          if (e.target.validity.badInput) {
            e.target.value = shown
            return
          }
          if (text === '') {
            onCommit(undefined)
            return
          }
          // Unchanged text commits nothing — see NumberField.
          const v = u.read(Number(text))
          if (text !== shown && Number.isFinite(v) && v >= min) onCommit(v)
          // Rejected text goes back to what is held — see NumberField.
          e.target.value = shown
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') ref.current?.blur()
        }}
      />
      <i>{u.word}</i>
    </span>
  )
}

export function LimitFields({
  family,
  unit,
  limit,
  onChange,
}: {
  family: DimensionFamily
  unit: DimensionUnit
  limit: Limit | undefined
  onChange: (limit: Limit | undefined) => void
}) {
  const step = unit === '°' ? 0.01 : 0.001
  // A limit in millimetres is a length; one in degrees keeps its unit.
  const kind = unit === 'mm' ? ('length' as const) : undefined
  const fieldText = useFieldUnits(kind, unit).text
  if (family === 'tolerance') {
    return (
      <label className="field">
        <span>
          Limit
          <InfoDot title="Limit">
            <p>
              The tolerance value off the drawing&apos;s feature control frame: the zone may be this
              wide and no wider. Leave it empty to read the value without judging it.
            </p>
            <p>
              With a limit the row and the pin say how far inside or over it the reading stands, and
              turn red when it is over. The copied summary says PASS or FAIL.
            </p>
          </InfoDot>
        </span>
        <OptionalNumber
          value={limit?.kind === 'max' ? limit.max : undefined}
          placeholder="none"
          step={step}
          min={0}
          kind={kind}
          unit={unit}
          testId="tol-limit"
          onCommit={(max) => onChange(max === undefined ? undefined : { kind: 'max', max })}
        />
      </label>
    )
  }
  const band = limit?.kind === 'band' ? limit : undefined
  const set = (patch: Parameters<typeof editBand>[1]) => onChange(editBand(band, patch))
  return (
    <>
      <label className="field">
        <span>
          Nominal
          <InfoDot title="Nominal and tolerance">
            <p>
              What the drawing says the value should be, and how far either side of it is still
              good. Leave the nominal empty to read the value without judging it; leave − empty for
              a symmetric tolerance.
            </p>
            <p>
              With a nominal the row and the pin show the deviation from it, and turn red when it is
              outside the tolerance. The copied summary says PASS or FAIL.
            </p>
          </InfoDot>
        </span>
        <OptionalNumber
          value={band?.nominal}
          placeholder="none"
          step={step}
          min={-Infinity}
          kind={kind}
          unit={unit}
          testId="dim-nominal"
          onCommit={(nominal) => set({ nominal })}
        />
      </label>
      {band && (
        <label className="field">
          <span>Tolerance</span>
          <span className="tolpair">
            <b>+</b>
            <OptionalNumber
              value={band.plus}
              placeholder="0"
              step={step}
              min={0}
              kind={kind}
              unit={unit}
              testId="dim-plus"
              onCommit={(plus) => set({ plus: plus ?? 0 })}
            />
            <b>−</b>
            <OptionalNumber
              value={bandFollows(band) ? undefined : band.minus}
              placeholder={fieldText(band.plus)}
              step={step}
              min={0}
              kind={kind}
              unit={unit}
              testId="dim-minus"
              onCommit={(minus) => set({ minus })}
            />
          </span>
        </label>
      )}
    </>
  )
}

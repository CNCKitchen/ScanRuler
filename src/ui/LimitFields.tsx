// SPDX-License-Identifier: AGPL-3.0-only
// The limit a measurement is held to, typed in beside it — optional, so the
// fields are empty until something is asked of the value. A tolerance takes
// one ceiling; a dimension a nominal with an allowance either side, the
// minus side left blank for a symmetric one.

import { useRef } from 'react'
import type { DimensionFamily, DimensionUnit, Limit } from '../core/dimensions'
import { InfoDot } from './InfoDot'

/** A number that may be left out: empty commits undefined. Committed on
 *  blur or Enter like NumberField, so a half-typed "0." never judges a
 *  reading mid-keystroke. */
export function OptionalNumber({
  value,
  placeholder,
  step,
  min,
  unit,
  testId,
  onCommit,
}: {
  value: number | undefined
  placeholder: string
  step: number
  min: number
  unit: string
  testId: string
  onCommit: (v: number | undefined) => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const shown = value === undefined ? '' : String(value)
  return (
    <span className="unitfield">
      <input
        ref={ref}
        type="number"
        data-test={testId}
        step={step}
        min={min}
        placeholder={placeholder}
        defaultValue={shown}
        key={shown}
        onBlur={(e) => {
          const text = e.target.value.trim()
          if (text === '') {
            onCommit(undefined)
            return
          }
          const v = Number(text)
          if (Number.isFinite(v) && v >= min) onCommit(v)
          // Rejected text goes back to what is held — see NumberField.
          e.target.value = shown
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') ref.current?.blur()
        }}
      />
      <i>{unit}</i>
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
          unit={unit}
          testId="tol-limit"
          onCommit={(max) => onChange(max === undefined ? undefined : { kind: 'max', max })}
        />
      </label>
    )
  }
  const band = limit?.kind === 'band' ? limit : undefined
  const set = (patch: Partial<{ nominal: number | undefined; plus: number; minus: number | undefined }>) => {
    const nominal = 'nominal' in patch ? patch.nominal : band?.nominal
    if (nominal === undefined) {
      onChange(undefined)
      return
    }
    const plus = patch.plus ?? band?.plus ?? 0
    // A minus left blank follows the plus: the usual symmetric tolerance. A
    // band that was symmetric stays so when the plus changes; one typed
    // asymmetric keeps its own minus.
    const minus =
      'minus' in patch
        ? (patch.minus ?? plus)
        : band && band.minus !== band.plus
          ? band.minus
          : plus
    onChange({ kind: 'band', nominal, plus, minus })
  }
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
              unit={unit}
              testId="dim-plus"
              onCommit={(plus) => set({ plus: plus ?? 0 })}
            />
            <b>−</b>
            <OptionalNumber
              value={band.minus === band.plus ? undefined : band.minus}
              placeholder={String(band.plus)}
              step={step}
              min={0}
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

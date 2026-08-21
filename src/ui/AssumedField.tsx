// SPDX-License-Identifier: AGPL-3.0-only
// The diameter the feature being made is assumed to have been designed at.
// Empty until the user types one — nothing is suggested, because a guess
// would reach CAD as if it had been decided. A typed value is sanity-checked:
// one far from the measurement is flagged as a likely typo rather than
// silently accepted. Clearing the field takes the assumption back.

import { useRef } from 'react'
import { InfoDot } from './InfoDot'
import { useStore } from '../state/store'
import { assumedWarning, measuredDiameter, type SizedFit } from '../core/elements/assumed'

export function AssumedField({ fit }: { fit: SizedFit }) {
  const assumed = useStore((s) => s.draft?.assumed)
  const setDraftAssumed = useStore((s) => s.setDraftAssumed)
  const ref = useRef<HTMLInputElement>(null)

  const measured = measuredDiameter(fit)
  const warning = assumed === undefined ? null : assumedWarning(measured, assumed)
  const shown = assumed === undefined ? '' : String(assumed)

  const commit = (text: string) => {
    if (text.trim() === '') {
      setDraftAssumed(undefined)
      return
    }
    const v = Number(text)
    if (Number.isFinite(v) && v > 0) setDraftAssumed(v)
  }

  return (
    <>
      <label className="field">
        <span>
          Assumed Ø
          <InfoDot title="Assumed Ø">
            <p>
              The diameter the feature was <b>designed</b> at, if you know it: what measures Ø
              5.98 mm was probably drawn at Ø 6. Leave it empty if you don't — nothing is guessed
              for you.
            </p>
            <p>
              Nothing measured changes: the element, its readouts and every dimension keep the
              fitted diameter. Only the STEP export writes this value instead of the measured one,
              so CAD receives the feature as designed. Elements without one are exported as
              measured.
            </p>
          </InfoDot>
        </span>
        <span className="unitfield">
          <input
            ref={ref}
            type="number"
            data-test="assumed-diameter"
            step={0.01}
            min={0.001}
            placeholder={`measured ${measured.toFixed(3)}`}
            defaultValue={shown}
            key={shown}
            onBlur={(e) => {
              commit(e.target.value)
              // A rejected entry is put back to what the draft holds: when the
              // store does not change, nothing re-keys the input over it.
              e.target.value = shown
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') ref.current?.blur()
            }}
          />
          <i>mm</i>
        </span>
      </label>
      {warning !== null && (
        <p className="warnnote" data-test="assumed-warning">
          ⚠ {warning}
        </p>
      )}
    </>
  )
}

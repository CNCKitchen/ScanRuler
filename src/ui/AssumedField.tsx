// SPDX-License-Identifier: AGPL-3.0-only
// The diameter the feature being made is assumed to have been designed at.
// Prefilled with the round value the measurement most plausibly came from
// (Ø 5.98 measured suggests Ø 6), free to overtype, and sanity-checked: a
// value far from the measurement is flagged as a likely typo rather than
// silently accepted.

import { NumberField } from './NumberField'
import { useStore } from '../state/store'
import {
  assumedWarning,
  measuredDiameter,
  suggestedAssumed,
  type SizedFit,
} from '../core/elements/assumed'

export function AssumedField({ fit }: { fit: SizedFit }) {
  const assumed = useStore((s) => s.draft?.assumed)
  const setDraftAssumed = useStore((s) => s.setDraftAssumed)

  const measured = measuredDiameter(fit)
  const value = assumed ?? suggestedAssumed(measured)
  const warning = assumedWarning(measured, value)

  return (
    <>
      <NumberField
        label="Assumed Ø"
        value={value}
        step={0.01}
        min={0.001}
        unit="mm"
        testId="assumed-diameter"
        onCommit={setDraftAssumed}
        hint={
          <>
            <p>
              The diameter the feature was <b>designed</b> at: what measures Ø 5.98 mm was almost
              certainly drawn at Ø 6. The field is prefilled with the nearest round value the
              measurement plausibly came from — overtype it if the drawing says otherwise.
            </p>
            <p>
              Nothing measured changes: the element, its readouts and every dimension keep the
              fitted diameter. Only a STEP export with <i>Dimensions</i> set to <b>as assumed</b>
              writes this value instead, so CAD receives the part as designed.
            </p>
          </>
        }
      />
      {warning !== null && (
        <p className="warnnote" data-test="assumed-warning">
          ⚠ {warning}
        </p>
      )}
    </>
  )
}

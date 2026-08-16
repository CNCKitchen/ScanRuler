// SPDX-License-Identifier: AGPL-3.0-only
// The two controls every colour scale carries whatever it measures: discrete
// bands instead of the continuous ramp, and the histogram beside the scale.
// The deviation and thickness panels both show them, wired to their own
// stores.

import { BAND_CHOICES } from '../state/deviationStore'

export function ScaleControls({
  bands,
  onBands,
  showHistogram,
  onShowHistogram,
  histogramTestId,
}: {
  /** Discrete colour bands, or null for a continuous ramp. */
  bands: number | null
  onBands: (bands: number | null) => void
  showHistogram: boolean
  onShowHistogram: (v: boolean) => void
  histogramTestId: string
}) {
  return (
    <>
      <label className="field">
        <span>Bands</span>
        <select value={bands ?? 0} onChange={(e) => onBands(Number(e.target.value) || null)}>
          <option value={0}>Continuous</option>
          {BAND_CHOICES.map((b) => (
            <option key={b} value={b}>
              {b} bands
            </option>
          ))}
        </select>
      </label>
      <label className="checkrow">
        <input
          type="checkbox"
          data-test={histogramTestId}
          checked={showHistogram}
          onChange={(e) => onShowHistogram(e.target.checked)}
        />
        <span>Histogram beside the scale</span>
      </label>
    </>
  )
}

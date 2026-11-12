// SPDX-License-Identifier: AGPL-3.0-only
// The curvature comb's switch and its two settings — the same row in the 2D
// Measure panel, under the sheet's edges, and in the 3D Measure panel, under
// the sections: one comb, drawn on both. Off when the app opens.

import { COMB_WINDOW_MAX, COMB_WINDOW_MIN } from '../core/flat/curvature'
import { COMB_SCALE_MAX, COMB_SCALE_MIN, useComb } from '../state/combStore'
import { useLength } from '../app/useUnits'
import { InfoDot } from './InfoDot'
import { NumberField } from './NumberField'

export function CombControls({ where }: { where: 'sheet' | 'part' }) {
  const on = useComb((s) => s.on)
  const smoothing = useComb((s) => s.window)
  const scale = useComb((s) => s.scale)
  const { setOn, setWindow, setScale } = useComb.getState()
  const len = useLength()
  return (
    <>
      <label className="checkrow">
        <input type="checkbox" data-test="comb-show" checked={on} onChange={(e) => setOn(e.target.checked)} />
        <span>Curvature comb</span>
        <InfoDot title="Curvature comb">
          <p>
            Shows how sharply every edge bends, along it: a tooth square to the edge, as long as
            the edge is curved there, and a line through the tips, the area between filled faintly.{' '}
            {where === 'sheet'
              ? 'It runs along the edges on the sheet — a section’s cut, an image’s detected edges, a shadow’s outline — and along every arc, circle and spline fitted there, each in its colour.'
              : 'It runs along every section on the part and the curves fitted on its sheet, in the section’s colour; the 2D Measure workspace shows the same comb with a reading under the cursor.'}
          </p>
          <p>
            A straight run has no teeth. An arc has teeth all of one length — a fillet that is
            truly round shows a flat line through the tips — and a blend that is no arc has teeth
            that grow and shrink. Where a flat turns into a round is where the teeth start; the
            teeth stand on the side away from the centre of the bend, so where they cross over
            the edge turns the other way.
          </p>
          <p>
            A scanned or detected edge is noisy point to point, so it is read smoothed over the{' '}
            <b>Smoothing</b> length: wider is calmer, narrower follows smaller rounds. Smoothing
            turns a sharp change — a flat meeting a tangent arc — into a ramp about that long, with
            the true change in its middle; a ramp much longer than that is the blend itself. The
            radius of a round is read true whatever the smoothing, as long as the round is longer
            than it. Fitted curves and a shadow’s outline are exact and not smoothed.
          </p>
          <p>
            <b>Length</b> scales the teeth. Teeth too long to draw — a sharp corner — are cut
            short and drawn fainter.
          </p>
        </InfoDot>
      </label>
      {on && (
        <>
          <input
            className="slider"
            type="range"
            data-test="comb-window-slider"
            aria-label="Smoothing"
            min={Math.log10(COMB_WINDOW_MIN)}
            max={Math.log10(COMB_WINDOW_MAX)}
            step={0.01}
            // Logarithmic: a fine scan's 0.3 mm and a rough one's 10 mm both
            // want room on it.
            value={Math.log10(smoothing)}
            onChange={(e) => setWindow(len.fromDisplay(Number(len.toDisplay(10 ** Number(e.target.value)).toPrecision(2))))}
          />
          <NumberField
            label="Smoothing"
            testId="comb-window"
            value={smoothing}
            step={0.1}
            min={COMB_WINDOW_MIN}
            kind="length"
            onCommit={setWindow}
            hint="How long a stretch of a scanned or detected edge each reading is smoothed over. Fitted curves are exact and not smoothed."
          />
          <label className="field">
            <span>Length</span>
            <input
              type="range"
              data-test="comb-scale"
              min={Math.log2(COMB_SCALE_MIN)}
              max={Math.log2(COMB_SCALE_MAX)}
              step={0.05}
              value={Math.log2(scale)}
              onChange={(e) => setScale(Number((2 ** Number(e.target.value)).toPrecision(2)))}
              title={`The teeth ${scale.toPrecision(2)}× as long as they are drawn by themselves`}
            />
          </label>
        </>
      )}
    </>
  )
}

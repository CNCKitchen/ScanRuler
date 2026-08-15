// SPDX-License-Identifier: AGPL-3.0-only
// The deviation faceplate: both models are loaded from here — the workspace
// needs a scan and a reference and neither belongs in a top bar shared with
// the other workspace — then the best fit, then everything that governs how
// the resulting map is read.

import { BAND_CHOICES, useDeviation } from '../state/deviationStore'
import { useStore } from '../state/store'
import { ModelSlot } from './ModelSlot'
import { NumberField } from './NumberField'

export function DeviationPanel({
  onOpenScan,
  onOpenNominal,
  onAlign,
  onPickPoints,
  onMeasure,
  onCopy,
}: {
  onOpenScan: (file: File) => void
  onOpenNominal: (file: File) => void
  onAlign: () => void
  onPickPoints: () => void
  onMeasure: () => void
  onCopy: () => void
}) {
  const scanName = useStore((s) => s.fileName)
  const scanTriangles = useStore((s) => s.triangleCount)
  const scanBusy = useStore((s) => s.busy)
  const d = useDeviation()

  const busy = scanBusy || d.nominalBusy || d.alignStatus === 'running' || d.mapStatus === 'running'
  const ready = Boolean(scanName && d.nominalName)
  const aligned = d.alignStatus === 'done' && d.align !== null

  // A fit that lands far from the surface, or that had a near-tie for the best
  // starting pose, is worth saying out loud — it is the one case where the
  // automatic match quietly produces a wrong-looking map.
  const suspect = aligned && (d.align!.ambiguous || d.align!.rms > 1)

  return (
    <aside className="panel">
      <div className="group">
        <div className="sec-head">Models</div>
        <ModelSlot
          role="Scan"
          name={scanName}
          detail={`${scanTriangles.toLocaleString('en-US')} triangles`}
          dotColor="#8b9099"
          busy={busy}
          onOpen={onOpenScan}
        />
        <ModelSlot
          role="Reference"
          name={d.nominalName}
          detail={`${d.nominalTriangles.toLocaleString('en-US')} triangles`}
          dotColor="#7f8ba0"
          busy={busy}
          onOpen={onOpenNominal}
        />
        <p className="hint">
          The part as scanned, and the nominal CAD part it should match. Drop either one anywhere
          in the window. Nothing is uploaded.
        </p>
      </div>

      <div className="group">
        <div className="sec-head">Best fit</div>
        <p className="hint">
          Rotation and translation only — no scale, so a scanner scale error stays visible in the
          map instead of being absorbed by the alignment.
        </p>
        <button
          className="primary block"
          data-test="align-auto"
          disabled={!ready || busy}
          onClick={onAlign}
        >
          {d.alignStatus === 'running' ? (
            <>
              <span className="spinner" />
              Aligning…
            </>
          ) : (
            'Align automatically'
          )}
        </button>
        <button
          className="block"
          data-test="align-points"
          disabled={!ready || busy}
          onClick={onPickPoints}
        >
          Align by picking points…
        </button>

        {d.alignStatus === 'failed' && <p className="alarmtext">{d.alignMessage}</p>}

        {aligned && (
          <>
            <div className="dro">
              <div className="dro-label">
                <span>Fit deviation</span>
                <span>{d.align!.source === 'auto' ? 'automatic' : 'from points'}</span>
              </div>
              <div className="dro-window" data-test="align-rms">
                <b>{d.align!.rms.toFixed(4)}</b>
                <span>MM RMS</span>
              </div>
              <div className="dro-note">
                {d.align!.matched.toLocaleString('en-US')} of{' '}
                {d.align!.sampled.toLocaleString('en-US')} sampled points used ·{' '}
                {d.align!.iterations} passes
                {d.align!.pairRms !== undefined
                  ? ` · picked points ${d.align!.pairRms.toFixed(2)} mm`
                  : ''}
              </div>
            </div>
            {suspect && (
              <p className="alarmtext">
                {d.align!.ambiguous
                  ? 'Another starting pose fitted almost as well — this part may be symmetric enough to match the wrong way round. Check it against the reference, and pick points if it is wrong.'
                  : 'The scan is still far from the reference after fitting. Try aligning by picking points.'}
              </p>
            )}
            {d.mapStatus !== 'ready' && (
              <button
                className="primary block"
                data-test="measure-deviation"
                disabled={busy}
                onClick={onMeasure}
              >
                {d.mapStatus === 'running' ? (
                  <>
                    <span className="spinner" />
                    Measuring…
                  </>
                ) : (
                  'Measure deviation'
                )}
              </button>
            )}
          </>
        )}
      </div>

      {d.mapStatus === 'ready' && (
        <>
          <div className="group">
            <div className="sec-head">Colour scale</div>
            <input
              className="slider"
              type="range"
              data-test="range-slider"
              min={-3}
              max={1.4}
              step={0.01}
              // Logarithmic: a scale that has to serve both a 0.02 mm print and
              // a 5 mm warp cannot be linear without one end being unusable.
              value={Math.log10(d.range)}
              onChange={(e) => d.setRange(Number((10 ** Number(e.target.value)).toPrecision(2)))}
            />
            <NumberField
              label="Range ±"
              testId="range-value"
              value={d.range}
              step={0.01}
              min={0.0001}
              unit="mm"
              onCommit={d.setRange}
              hint="Half-width of the colour scale. Zero always sits at the centre, on green; anything past either end is drawn in a dark cap."
            />
            <label className="field">
              <span>Bands</span>
              <select
                value={d.bands ?? 0}
                onChange={(e) => d.setBands(Number(e.target.value) || null)}
              >
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
                data-test="toggle-histogram"
                checked={d.showHistogram}
                onChange={(e) => d.setShowHistogram(e.target.checked)}
              />
              <span>Histogram beside the scale</span>
            </label>
            <label className="checkrow">
              <input
                type="checkbox"
                data-test="toggle-ghost"
                checked={d.showNominal}
                onChange={(e) => d.setShowNominal(e.target.checked)}
              />
              <span>Show reference</span>
            </label>
            <label className="checkrow">
              <input
                type="checkbox"
                data-test="toggle-scan"
                checked={d.showScan}
                onChange={(e) => d.setShowScan(e.target.checked)}
              />
              <span>Show scan</span>
            </label>
          </div>

          <div className="group">
            <div className="sec-head">What counts as measured</div>
            <NumberField
              label="Max search distance"
              testId="max-distance"
              value={d.maxDistance}
              step={0.1}
              min={0.0001}
              unit="mm"
              onCommit={d.setMaxDistance}
              hint="How far a scan point may look for reference surface. Beyond it there is nothing to deviate from, so the surface is left in plain grey and kept out of the statistics."
            />
            <p className="hint">
              How far a scan point may look for reference surface. Beyond it the surface is left
              plain grey and kept out of the statistics — there is nothing there to deviate from.
              Display only: it never affects the alignment.
            </p>
            <NumberField
              label="Tolerance ±"
              value={d.tolerance}
              step={0.01}
              min={0.0001}
              unit="mm"
              onCommit={d.setTolerance}
              hint="The band the 'within tolerance' figure counts."
            />
            <p className="hint">
              The band the <b>within ±{d.tolerance} mm</b> figure under the scale counts. It does
              not change the colours.
            </p>
          </div>

          <div className="group">
            <div className="g-label">
              <span>Pinned readings</span>
              <b>{d.probes.length}</b>
            </div>
            {d.probes.length === 0 ? (
              <p className="hint">
                Hover the part for a live reading; click to pin one where you need a number.
              </p>
            ) : (
              <>
                {d.probes.map((p, i) => (
                  <div className="kv" data-test="probe-row" key={p.id}>
                    <span className="probeno">{i + 1}</span>
                    <span className="name">
                      {p.point.map((v) => v.toFixed(1)).join(', ')}
                    </span>
                    <b>
                      {(p.value >= 0 ? '+' : '−') + Math.abs(p.value).toFixed(3)}
                    </b>
                    <button className="x" title="Remove" onClick={() => d.removeProbe(p.id)}>
                      ✕
                    </button>
                  </div>
                ))}
                <button className="block" onClick={d.clearProbes}>
                  Clear pins
                </button>
              </>
            )}
          </div>

          <div className="divider" />
          <button className="block" onClick={onCopy}>
            Copy report
          </button>
        </>
      )}
    </aside>
  )
}

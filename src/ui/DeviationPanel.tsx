// SPDX-License-Identifier: AGPL-3.0-only
// The deviation faceplate: both models are loaded from here — the workspace
// needs a scan and a reference and neither belongs in a top bar shared with
// the other workspace — then the best fit, then everything that governs how
// the resulting map is read.

import { MIN_LOCAL_POINTS } from '../core/deviation/align'
import { REFERENCE_ACCEPT, REFERENCE_FORMATS } from '../core/formats'
import { BAND_CHOICES, useDeviation } from '../state/deviationStore'
import { useMark } from '../state/markStore'
import { useStore } from '../state/store'
import { InfoDot } from './InfoDot'
import { MarkTools } from './MarkTools'
import { ModelSlot } from './ModelSlot'
import { NumberField } from './NumberField'

/** How the fit in hand was arrived at, for the readout. */
const SOURCE_LABEL = {
  auto: 'automatic',
  points: 'from points',
  local: 'local fine fit',
} as const

export function DeviationPanel({
  onOpenScan,
  onOpenNominal,
  onAlign,
  onPickPoints,
  onMeasure,
  onStartMarking,
  onStopMarking,
  onClearMarking,
  onLocalFit,
  onRevertLocal,
  onCopy,
  onExportStl,
}: {
  onOpenScan: (file: File) => void
  onOpenNominal: (file: File) => void
  onAlign: () => void
  onPickPoints: () => void
  onMeasure: () => void
  /** Bring the marking tools out, and put them away again. */
  onStartMarking: () => void
  onStopMarking: () => void
  onClearMarking: () => void
  /** Refine the fit on the marked surface only. */
  onLocalFit: () => void
  onRevertLocal: () => void
  onCopy: () => void
  /** Save the scan as an STL in the pose it is currently shown in — here, that
   *  means with the best fit onto the reference baked in. */
  onExportStl: () => void
}) {
  const scanName = useStore((s) => s.fileName)
  const scanTriangles = useStore((s) => s.triangleCount)
  const scanBusy = useStore((s) => s.busy)
  const d = useDeviation()
  const markCount = useMark((s) => s.count)

  const busy = scanBusy || d.nominalBusy || d.alignStatus === 'running' || d.mapStatus === 'running'
  const ready = Boolean(scanName && d.nominalName)
  const aligned = d.alignStatus === 'done' && d.align !== null

  // A fit that lands far from the surface, or that had a near-tie for the best
  // starting pose, is worth saying out loud — it is the one case where the
  // automatic match quietly produces a wrong-looking map.
  const suspect = aligned && d.align!.source !== 'local' && (d.align!.ambiguous || d.align!.rms > 1)
  const enough = markCount >= MIN_LOCAL_POINTS
  // While the marking tools are out they own the workflow, so everything that
  // belongs to another step fades back — loading models, the global fit, and
  // reading the map are all things to do before or after, not during. Faded
  // rather than disabled, and back to full strength under the pointer: none of
  // it stops working, it just stops competing for attention.
  const aside = d.marking ? 'group muted' : 'group'

  return (
    <aside className="panel">
      <div className={aside}>
        <div className="sec-head">
          Models
          <InfoDot title="Scan and reference">
            <p>
              The part as scanned, and the nominal CAD part it should match. Drop either one
              anywhere in the window. Nothing is uploaded.
            </p>
            <p>
              The scan is an <b>STL</b>, <b>PLY</b> or <b>OBJ</b> in millimetres. The reference
              takes those too, and also a <b>STEP</b> file straight from CAD — its exact surfaces
              are tessellated here, finely enough that the conversion sits well below anything the
              scan can resolve.
            </p>
          </InfoDot>
        </div>
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
          detail={
            d.nominalStep
              ? `${d.nominalTriangles.toLocaleString('en-US')} triangles · STEP at ${d.nominalStep.surfaceDeviation} mm`
              : `${d.nominalTriangles.toLocaleString('en-US')} triangles`
          }
          dotColor="#7f8ba0"
          busy={busy}
          accept={REFERENCE_ACCEPT}
          formats={REFERENCE_FORMATS}
          onOpen={onOpenNominal}
        />
      </div>

      <div className={aside}>
        <div className="sec-head">
          Best fit
          <InfoDot title="Best fit">
            <p>
              Brings the scan onto the reference before anything is measured. Rotation and
              translation only — no scale, so a scanner scale error stays visible in the map instead
              of being quietly absorbed by the alignment.
            </p>
            <p>
              <b>Align automatically</b> searches for the pose on its own and is what you want
              almost always. <b>Align by picking points</b> is the fallback for a part it gets wrong
              — usually one symmetric enough to match the wrong way round.
            </p>
            <p>
              The <i>fit deviation</i> it reports is how well the two surfaces agree overall. A
              large one either means a genuinely off part, or a fit that has landed wrong.
            </p>
          </InfoDot>
        </div>
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

        {d.alignMessage && <p className="alarmtext">{d.alignMessage}</p>}

        {aligned && (
          <>
            <div className="dro">
              <div className="dro-label">
                <span>Fit deviation</span>
                <span>{SOURCE_LABEL[d.align!.source]}</span>
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
                {d.align!.selected !== undefined
                  ? ` · ${d.align!.selected.toLocaleString('en-US')} points marked`
                  : ''}
              </div>
            </div>
            {d.align!.underconstrained && (
              <p className="warnnote">
                ⚠ The marked surface faces one way only, so the fit could correct the distance
                across it and nothing else — the part is still free to slide along it. Mark a second
                surface facing another way to pin it down.
              </p>
            )}
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

      {aligned && (
        <div className="group">
          <div className="sec-head">
            Local fine fit
            <InfoDot title="Local fine fit">
              <p>An optional second step, once the global fit is in — most parts do not need it.</p>
              <p>
                Scan spray, print supports, risers, fixturing and any geometry the reference does
                not have all pull on the whole-scan fit, and no number of passes will shake them
                loose. Mark the surfaces that really are the part and the fit is computed on those
                alone.
              </p>
              <p>
                Only the alignment narrows: the map that follows is still measured everywhere on the
                scan.
              </p>
            </InfoDot>
          </div>

          {!d.marking ? (
            <button
              className="block"
              data-test="local-start"
              disabled={busy}
              onClick={onStartMarking}
            >
              Mark surface to fit on…
            </button>
          ) : (
            <>
              {!d.showScan && (
                <p className="warnnote">
                  ⚠ The scan is hidden, so there is nothing to mark on — switch <b>Show scan</b>{' '}
                  back on under the colour scale. What is already marked is still there.
                </p>
              )}
              <MarkTools
                escapeNote="Esc a second time closes this step and clears the marking."
                onClear={onClearMarking}
              />

              <NumberField
                label="Max search distance"
                testId="local-max-distance"
                value={d.localMaxDistance}
                step={0.1}
                min={0.0001}
                unit="mm"
                onCommit={d.setLocalMaxDistance}
                hint={
                  <>
                    <p>
                      How far a marked point may reach for reference surface while the fine fit
                      runs.
                    </p>
                    <p>
                      Keep it tight: the global fit already has the part within a few tenths, so a
                      millimetre is generous. Raising it lets the marked surface reach a
                      neighbouring feature and settle onto that instead.
                    </p>
                  </>
                }
              />

              <button
                className="primary block"
                data-test="local-fit"
                disabled={busy || !enough}
                onClick={onLocalFit}
              >
                {d.alignStatus === 'running' ? (
                  <>
                    <span className="spinner" />
                    Fine fitting…
                  </>
                ) : (
                  'Fit on marked surface'
                )}
              </button>
              {!enough && (
                <p className="hint">
                  Drag on the scan to mark the surface to fit on — at least {MIN_LOCAL_POINTS}{' '}
                  points. Right-drag rubs out, Shift-drag still orbits.
                </p>
              )}
              <button
                className="block"
                data-test="mark-done"
                title="Closes this step and clears the marking — Esc does the same, once the camera has its buttons back"
                onClick={onStopMarking}
              >
                Put the marking tools away
              </button>
            </>
          )}

          {d.globalAlign && d.align!.source === 'local' && (
            <button
              className="block"
              data-test="local-revert"
              disabled={busy}
              onClick={onRevertLocal}
            >
              Back to the global fit
            </button>
          )}
        </div>
      )}

      {d.mapStatus === 'ready' && (
        <>
          <div className={aside}>
            <div className="sec-head">
              Colour scale
              <InfoDot title="Colour scale">
                <p>
                  How the measured deviation is painted onto the scan. Zero always sits at the
                  centre of the scale, on green; too much material runs warm, too little runs cool,
                  and anything past either end is drawn in a dark cap so it cannot be mistaken for
                  the limit itself.
                </p>
                <p>
                  The slider is logarithmic, so the same control serves a 0.02 mm print and a 5 mm
                  warp. <b>Bands</b> replaces the continuous ramp with discrete steps, which is
                  easier to read off a screenshot or a printed report.
                </p>
                <p>
                  Showing and hiding the two models changes nothing that was measured — it only
                  changes what you are looking at.
                </p>
              </InfoDot>
            </div>
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

          <div className={aside}>
            <div className="sec-head">What counts as measured</div>
            <NumberField
              label="Max search distance"
              testId="max-distance"
              value={d.maxDistance}
              step={0.1}
              min={0.0001}
              unit="mm"
              onCommit={d.setMaxDistance}
              hint={
                <>
                  <p>How far a scan point may look for reference surface.</p>
                  <p>
                    Beyond it there is nothing to deviate from, so that surface is left in plain
                    grey and kept out of the statistics — which is what stops scan spray and a stray
                    fixture from being reported as enormous error.
                  </p>
                  <p>Display only: it never affects the alignment.</p>
                </>
              }
            />
            <NumberField
              label="Tolerance ±"
              value={d.tolerance}
              step={0.01}
              min={0.0001}
              unit="mm"
              onCommit={d.setTolerance}
              hint={
                <>
                  <p>
                    The band the <b>within ±{d.tolerance} mm</b> figure under the scale counts.
                  </p>
                  <p>
                    It is a tally, not a filter: it does not change the colours or what was
                    measured. Set the range to the same number if you want the map itself to draw
                    the line.
                  </p>
                </>
              }
            />
          </div>

          <div className={aside}>
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
                    <span className="name">{p.point.map((v) => v.toFixed(1)).join(', ')}</span>
                    <b>{(p.value >= 0 ? '+' : '−') + Math.abs(p.value).toFixed(3)}</b>
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
        </>
      )}

      {scanName && (
        <div className={'tailrow' + (d.marking ? ' muted' : '')}>
          <div className="divider" />
          {d.mapStatus === 'ready' && (
            <button className="block" onClick={onCopy}>
              Copy report
            </button>
          )}
          <button
            className="block"
            data-test="export-stl"
            disabled={scanBusy}
            onClick={onExportStl}
            title="Save the scan as an STL where it now stands — the best fit onto the reference is baked in"
          >
            Export scan as STL
          </button>
        </div>
      )}
    </aside>
  )
}

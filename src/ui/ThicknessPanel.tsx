// SPDX-License-Identifier: AGPL-3.0-only
// The wall thickness faceplate. One model, then the two halves of the job kept
// apart: what the search is allowed to look for, which only takes effect when
// the part is measured again, and how the result is read, which takes effect
// as you turn it. Laid out like the deviation panel next door, because it is
// the same instrument pointed at a different question.

import { BAND_CHOICES } from '../state/deviationStore'
import { CONE_CHOICES, useThickness } from '../state/thicknessStore'
import { useStore } from '../state/store'
import { ModelSlot } from './ModelSlot'
import { NumberField } from './NumberField'

export function ThicknessPanel({
  onOpenScan,
  onMeasure,
  onCopy,
}: {
  onOpenScan: (file: File) => void
  onMeasure: () => void
  onCopy: () => void
}) {
  const scanName = useStore((s) => s.fileName)
  const scanTriangles = useStore((s) => s.triangleCount)
  const scanBusy = useStore((s) => s.busy)
  const t = useThickness()

  const busy = scanBusy || t.status === 'running'
  const ready = Boolean(scanName)

  return (
    <aside className="panel">
      <div className="group">
        <div className="sec-head">Model</div>
        <ModelSlot
          role="Scan"
          name={scanName}
          detail={`${scanTriangles.toLocaleString('en-US')} triangles`}
          dotColor="#8b9099"
          busy={busy}
          onOpen={onOpenScan}
        />
        <p className="hint">
          The part as scanned — nothing else is needed here. Drop it anywhere in the window.
          Nothing is uploaded.
        </p>
      </div>

      <div className="group">
        <div className="sec-head">Measurement</div>
        <label className="field" title="How the thickness at a point is defined.">
          <span>Method</span>
          <select
            data-test="thickness-method"
            value={t.method}
            disabled={busy}
            onChange={(e) => t.setMethod(e.target.value as 'ray' | 'sphere')}
          >
            <option value="ray">Ray along the normal</option>
            <option value="sphere">Sphere across the wall</option>
          </select>
        </label>
        <p className="hint">
          {t.method === 'ray'
            ? 'A ray is fired straight into the material along the inward normal; how far it travels before it comes out the far side is the wall there.'
            : 'A sphere is placed halfway along that ray and grown until it touches. It cannot read longer than the ray and usually reads shorter, because it is not tied to the ray’s direction: it finds a wedge square across, and the width of a block rather than the diagonal its corner points down.'}
        </p>

        <NumberField
          label="Max. thickness"
          testId="thickness-max"
          value={t.maxThickness}
          step={1}
          min={0.001}
          unit="mm"
          disabled={busy}
          onCommit={t.setMaxThickness}
          hint="Nothing thicker than this is measured, and no ray looks any further."
        />
        <p className="hint">
          The search stops here. A point with nothing behind it inside this distance is left
          unmeasured rather than reported — which is what keeps a ray that escapes through an
          open rim from coming back as a wall the length of the part.
        </p>

        {t.method === 'ray' && (
          <>
            <label className="field" title="Extra rays spread through the cone; the shortest wins.">
              <span>Rays</span>
              <select
                data-test="thickness-rays"
                value={t.coneRays}
                disabled={busy}
                onChange={(e) => t.setConeRays(Number(e.target.value))}
              >
                {CONE_CHOICES.map((c) => (
                  <option key={c.rays} value={c.rays}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            {t.coneRays > 0 && (
              <NumberField
                label="Max. opening angle"
                testId="thickness-cone-angle"
                value={t.coneAngleDeg}
                step={5}
                min={0}
                unit="°"
                disabled={busy}
                onCommit={t.setConeAngle}
                hint="How far off the normal the cone of rays may look for a shorter way across the wall."
              />
            )}
          </>
        )}

        <label className="checkrow" title="A surface nearly edge-on to the ray is not the other side of a wall.">
          <input
            type="checkbox"
            data-test="thickness-facing"
            disabled={busy}
            checked={t.normalDeviationDeg !== null}
            onChange={(e) => t.setNormalDeviation(e.target.checked ? 60 : null)}
          />
          <span>Far surface must face back</span>
        </label>
        {t.normalDeviationDeg !== null && (
          <NumberField
            label="Max. deviation of normals"
            testId="thickness-normal-deviation"
            value={t.normalDeviationDeg}
            step={5}
            min={0}
            unit="°"
            disabled={busy}
            onCommit={(v) => t.setNormalDeviation(v)}
            hint="How far the surface a ray lands on may be from squarely facing it and still count as the other side of the wall."
          />
        )}
        <p className="hint">
          A surface nearly edge-on to the ray is a rib it is running alongside, or the rim of an
          open scan — not the far side of a wall. Those are stepped over and the search goes on
          behind them.
        </p>

        <button
          className="primary block"
          data-test="measure-thickness"
          disabled={!ready || busy}
          onClick={onMeasure}
        >
          {t.status === 'running' ? (
            <>
              <span className="spinner" />
              Measuring…
            </>
          ) : t.status === 'ready' ? (
            'Measure again'
          ) : (
            'Measure wall thickness'
          )}
        </button>
        <p className="hint">Everything above shapes the search, so changing it means measuring again.</p>
        {t.message && <p className="alarmtext">{t.message}</p>}
      </div>

      {t.status === 'ready' && (
        <>
          <div className="group">
            <div className="sec-head">Colour scale</div>
            <p className="hint">
              Red is thin, blue is thick. Both ends default to the spread of this part; anything
              past either one is drawn in a dark cap.
            </p>
            <NumberField
              label="Thin end"
              testId="thickness-low"
              value={t.low}
              step={0.1}
              min={0}
              unit="mm"
              onCommit={t.setLow}
              hint="Wall thickness at the bottom of the scale — the red end. Anything thinner is drawn in a dark red cap."
            />
            <NumberField
              label="Thick end"
              testId="thickness-high"
              value={t.high}
              step={0.1}
              min={0.001}
              unit="mm"
              onCommit={t.setHigh}
              hint="Wall thickness at the top of the scale — the blue end. Anything thicker is drawn in a dark blue cap."
            />
            <label className="field">
              <span>Bands</span>
              <select
                value={t.bands ?? 0}
                onChange={(e) => t.setBands(Number(e.target.value) || null)}
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
                data-test="toggle-thickness-histogram"
                checked={t.showHistogram}
                onChange={(e) => t.setShowHistogram(e.target.checked)}
              />
              <span>Histogram beside the scale</span>
            </label>
          </div>

          <div className="group">
            <div className="sec-head">Minimum wall</div>
            <NumberField
              label="Thinner than"
              testId="thickness-limit"
              value={t.limit}
              step={0.1}
              min={0.0001}
              unit="mm"
              onCommit={t.setLimit}
              hint="The wall the 'under' figure counts below."
            />
            <p className="hint">
              The wall the <b>under {t.limit} mm</b> figure below the scale counts. It does not
              change the colours — set the thin end of the scale to it if you want the map itself
              to call it out.
            </p>
          </div>

          <div className="group">
            <div className="g-label">
              <span>Pinned readings</span>
              <b>{t.probes.length}</b>
            </div>
            {t.probes.length === 0 ? (
              <p className="hint">
                Hover the part for a live reading; click to pin one where you need a number.
              </p>
            ) : (
              <>
                {t.probes.map((p, i) => (
                  <div className="kv" data-test="thickness-probe-row" key={p.id}>
                    <span className="probeno">{i + 1}</span>
                    <span className="name">{p.point.map((v) => v.toFixed(1)).join(', ')}</span>
                    <b>{p.value.toFixed(3)}</b>
                    <button className="x" title="Remove" onClick={() => t.removeProbe(p.id)}>
                      ✕
                    </button>
                  </div>
                ))}
                <button className="block" onClick={t.clearProbes}>
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

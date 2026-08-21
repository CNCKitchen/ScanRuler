// SPDX-License-Identifier: AGPL-3.0-only
// The wall thickness faceplate. One model, then the two halves of the job kept
// apart: what the search is allowed to look for, which only takes effect when
// the part is measured again, and how the result is read, which takes effect
// as you turn it. Laid out like the deviation panel next door, because it is
// the same instrument pointed at a different question.

import { CONE_CHOICES, useThickness } from '../state/thicknessStore'
import { useStore } from '../state/store'
import { usePulse } from '../app/useHints'
import { CopyButton } from './CopyButton'
import { InfoDot } from './InfoDot'
import { ModelSlot } from './ModelSlot'
import { NumberField } from './NumberField'
import { ProbeList } from './ProbeList'
import { ScaleControls } from './ScaleControls'

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
  const pulse = usePulse('measure-thickness')

  const busy = scanBusy || t.status === 'running'
  const ready = Boolean(scanName)

  return (
    <aside className="panel">
      <div className="group">
        <div className="sec-head">
          Model
          <InfoDot title="The scan">
            <p>
              The part as scanned — an <b>STL</b>, <b>PLY</b> or <b>OBJ</b> in millimetres.
              Nothing else is needed here: wall thickness is a property of the part itself, so
              there is no reference model and no alignment step.
            </p>
            <p>Drop it anywhere in the window. Nothing is uploaded.</p>
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
        {!scanName && <p className="hint">Drop it anywhere in the window.</p>}
      </div>

      <div className="group">
        <div className="sec-head">Measurement</div>
        <label className="field">
          <span>
            Method
            <InfoDot title="How thickness is measured">
              <p>
                <b>Ray along the normal</b> fires a ray straight into the material at each point
                and takes how far it travels before it comes out the far side. Simple, and it is
                what most tools mean by wall thickness.
              </p>
              <p>
                <b>Sphere across the wall</b> places a sphere halfway along that ray and grows it
                until it touches. It can never read longer than the ray and usually reads shorter,
                because it is not tied to the ray's direction: it finds a wedge square across, and
                the width of a block rather than the diagonal its corner points down.
              </p>
              <p>
                Neither is wrong — the ray answers “how far through here”, the sphere answers “how
                much material is actually there”.
              </p>
            </InfoDot>
          </span>
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

        <NumberField
          label="Max. thickness"
          testId="thickness-max"
          value={t.maxThickness}
          step={1}
          min={0.001}
          unit="mm"
          disabled={busy}
          onCommit={t.setMaxThickness}
          hint={
            <>
              <p>Where the search stops. Nothing thicker than this is measured.</p>
              <p>
                A point with nothing behind it inside this distance is left unmeasured rather than
                reported, which is what keeps a ray escaping through an open rim from coming back
                as a wall the length of the part.
              </p>
            </>
          }
        />

        {t.method === 'ray' && (
          <>
            <label className="field">
              <span>
                Rays
                <InfoDot title="Rays">
                  <p>
                    A single ray along the normal reads the wall square-on, which over-reads
                    wherever the surface is not parallel to the one behind it — a chamfer, a
                    tapered rib, the inside of a corner.
                  </p>
                  <p>
                    Spreading extra rays through a cone around the normal and keeping the shortest
                    finds the true way across instead. More rays cost measurement time.
                  </p>
                </InfoDot>
              </span>
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

        <label className="checkrow">
          <input
            type="checkbox"
            data-test="thickness-facing"
            disabled={busy}
            checked={t.normalDeviationDeg !== null}
            onChange={(e) => t.setNormalDeviation(e.target.checked ? 60 : null)}
          />
          <span>Far surface must face back</span>
          <InfoDot title="Far surface must face back">
            <p>
              A surface nearly edge-on to the ray is a rib the ray is running alongside, or the rim
              of an open scan — not the far side of a wall.
            </p>
            <p>
              With this on, such a hit is stepped over and the search carries on behind it, so the
              wall reported is the one a caliper would find.
            </p>
          </InfoDot>
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
            hint="How far the surface a ray lands on may be from squarely facing it and still count as the other side of the wall. Anything beyond this is stepped over."
          />
        )}

        <button
          className={pulse ? 'primary block pulse' : 'primary block'}
          data-test="measure-thickness"
          data-confirm={t.status === 'ready' ? undefined : 1}
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
            <div className="sec-head">
              Colour scale
              <InfoDot title="Colour scale">
                <p>
                  Red is thin, blue is thick. Both ends default to the spread of this part, so the
                  first map you see uses the full range of colour on the walls it actually found.
                </p>
                <p>
                  Anything past either end is drawn in a dark cap, so a wall beyond the scale
                  cannot be mistaken for one sitting exactly on it.
                </p>
                <p>
                  Moving the ends only re-paints — nothing here is re-measured, and nothing above
                  changes.
                </p>
              </InfoDot>
            </div>
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
            <ScaleControls
              bands={t.bands}
              onBands={t.setBands}
              showHistogram={t.showHistogram}
              onShowHistogram={t.setShowHistogram}
              histogramTestId="toggle-thickness-histogram"
            />
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
              hint={
                <>
                  <p>
                    The wall the <b>under {t.limit} mm</b> figure below the scale counts.
                  </p>
                  <p>
                    It is a tally only and does not change the colours. Set the thin end of the
                    scale to the same number if you want the map itself to call it out.
                  </p>
                </>
              }
            />
          </div>

          <ProbeList
            probes={t.probes}
            rowTestId="thickness-probe-row"
            format={(v) => v.toFixed(3)}
            onRemove={t.removeProbe}
            onClear={t.clearProbes}
          />

          <div className="divider" />
          <CopyButton className="block" label="Copy report" onCopy={onCopy} />
        </>
      )}
    </aside>
  )
}

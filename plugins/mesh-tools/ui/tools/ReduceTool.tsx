// SPDX-License-Identifier: AGPL-3.0-only
// Reduce mesh: a light copy of the scan to model over in CAD, held within a
// tolerance, its sharp edges kept.

import { useShallow } from 'zustand/react/shallow'
import { usePulse } from '../../../../src/app/useHints'
import { InfoDot } from '../../../../src/ui/InfoDot'
import { NumberField } from '../../../../src/ui/NumberField'
import { useLength } from '../../../../src/app/useUnits'
import { ExportMeshButton } from '../../../../src/ui/ExportMeshButton'
import type { MeshFormat } from '../../../../src/core/exportMesh'
import { reductionStale, useMeshTools } from '../../state/meshStore'
import { count, SHARE, typedLen } from '../meshFormat'

export function ReduceTool({
  ready,
  busy,
  onReduce,
  onExport,
}: {
  ready: boolean
  busy: boolean
  onReduce: () => void
  onExport: (format: MeshFormat) => void
}) {
  // Only what the panel reads: the whole store would render it again on
  // every write to it, the cut preview's while its offset is dragged.
  const m = useMeshTools(
    useShallow((s) => ({
      maxTriangles: s.maxTriangles,
      message: s.message,
      report: s.report,
      setMaxTriangles: s.setMaxTriangles,
      setTolerance: s.setTolerance,
      status: s.status,
      tolerance: s.tolerance,
    })),
  )
  const stale = useMeshTools(reductionStale)
  const pulse = usePulse('reduce-mesh')
  const r = m.report
  const len = useLength()
  const mm = (v: number) => len.fmt(v, 3)
  const tol = r ? typedLen(r.settings.tolerance, len.units) : ''

  return (
    <>
      <div className="group">
        <div className="sec-head">
          Reduce mesh
          <InfoDot title="Reducing a scan for CAD">
            <p>
              A scan is millions of triangles, and CAD chokes on it. This makes a light mesh to model
              over instead: edges collapsed wherever the surface lets them go, so a flat face ends as
              a few large triangles and a fillet keeps the ones it needs. The scan itself stays as it
              is.
            </p>
            <p>
              The <b>tolerance</b> decides how far it may stray. The result is not trusted but
              measured, both ways — every scan point to the reduced mesh, and the reduced mesh back
              to the scan — and wherever it strays past the tolerance the scan is pinned there and
              reduced again, until {SHARE} of each side lies within it.
            </p>
          </InfoDot>
        </div>

        <NumberField
          label="Tolerance"
          testId="reduce-tolerance"
          value={m.tolerance}
          step={0.01}
          min={0.0001}
          kind="length"
          disabled={busy}
          onCommit={m.setTolerance}
          hint={
            <>
              <p>How far the reduced mesh may stray from the scan, either side of it.</p>
              <p>
                It starts sized to the part. Below the scan's own scatter a tighter tolerance buys
                little: the reduction has to keep the noise, and keeps nearly every triangle to do
                it.
              </p>
            </>
          }
        />

        <NumberField
          label="Triangle limit"
          testId="reduce-max-triangles"
          value={m.maxTriangles}
          step={1000}
          min={4}
          unit="△"
          disabled={busy}
          onCommit={m.setMaxTriangles}
          hint={
            <>
              <p>
                What the CAD system on the other end takes. Fusion warns above about{' '}
                <b>10,000</b> facets when a mesh is converted to BRep; SOLIDWORKS imports up to{' '}
                <b>500,000</b> as a solid or surface body, one face per facet — and slows down long
                before that. As a reference to model over, most take far more.
              </p>
              <p>
                The tolerance comes first. Only when holding it needs more triangles than the limit
                is the mesh reduced further, to the limit — and the result then says how far it
                strays instead.
              </p>
            </>
          }
        />

        <button
          className={pulse ? 'primary block pulse' : 'primary block'}
          data-test="reduce-mesh"
          data-confirm={r && !stale ? undefined : 1}
          disabled={!ready || busy}
          onClick={onReduce}
        >
          {m.status === 'running' ? (
            <>
              <span className="spinner" />
              Reducing…
            </>
          ) : r ? (
            'Reduce again'
          ) : (
            'Reduce'
          )}
        </button>
        <p className="hint">Both figures shape the reduction, so changing them means reducing again.</p>
        {m.message && <p className="alarmtext">{m.message}</p>}
      </div>

      {r && (
        <div className="group" data-test="reduce-result">
          <div className="dro hero">
            <div className="dro-label">
              <span>Reduced mesh</span>
              <span>{r.held ? `within ±${tol}` : 'past the tolerance'}</span>
            </div>
            <div className="dro-window" data-test="reduce-triangles">
              <b>{count(r.triangles)}</b>
              <span>TRIANGLES</span>
            </div>
            <div className="dro-note">
              from {count(r.inputTriangles)} ·{' '}
              {((r.triangles / r.inputTriangles) * 100).toFixed(r.triangles / r.inputTriangles < 0.01 ? 2 : 1)} %
              of the scan · {count(r.vertices)} vertices
            </div>
          </div>

          <div className="kv" data-test="reduce-within">
            <span className="name">Scan within ±{tol}</span>
            <b>{((r.within / r.measured) * 100).toFixed(2)} %</b>
          </div>
          <div className="kv" data-test="reduce-p999">
            <span className="name">{SHARE} of the scan within</span>
            <b>{mm(r.p999)}</b>
          </div>
          <div className="kv">
            <span className="name">Furthest scan point</span>
            <b>{mm(r.max)}</b>
          </div>
          <div className="kv">
            <span className="name">
              Mesh off the scan, {SHARE}
              <InfoDot title="Measured both ways">
                <p>
                  The figures above measure every scan point to the reduced mesh: detail it lost.
                  This one measures the reduced mesh back to the scan — its vertices and the middle
                  of each of its triangles — which catches a patch of it standing proud of a surface
                  that is not there.
                </p>
                <p>Furthest: {mm(r.backMax)}.</p>
              </InfoDot>
            </span>
            <b>{mm(r.backP999)}</b>
          </div>
          <div className="kv">
            <span className="name">RMS</span>
            <b>{mm(r.rms)}</b>
          </div>

          {r.capped && !r.held && (
            <p className="warnnote" data-test="reduce-capped">
              ⚠ Held to {count(r.settings.maxTriangles)} triangles, fewer than ±
              {tol} needs — {SHARE} of the scan is within {mm(r.p999)} of it
              instead. Raise the limit or the tolerance to have both.
            </p>
          )}
          {r.capped && r.held && (
            <p className="hint" data-test="reduce-capped">
              Reduced to the {count(r.settings.maxTriangles)}-triangle limit, and still within ±
              {tol}.
            </p>
          )}
          {!r.capped && !r.held && (
            <p className="warnnote" data-test="reduce-not-held">
              ⚠ ±{tol} could not be held everywhere — {SHARE} of the scan is
              within {mm(r.p999)} of it. A tolerance under the scan's own scatter leaves little to
              reduce.
            </p>
          )}
          {stale && (
            <p className="hint" data-test="reduce-stale">
              The settings have changed since this was reduced — reduce again to apply them. The
              export writes the mesh on screen.
            </p>
          )}

          <div className="divider" />
          <ExportMeshButton
            block
            testId="export-reduced-mesh"
            disabled={busy}
            onExport={onExport}
            title="Save the reduced mesh as an STL or a 3MF where the part now stands — any alignment or move you applied comes with it"
          />
        </div>
      )}
    </>
  )
}

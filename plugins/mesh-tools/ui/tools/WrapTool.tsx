// SPDX-License-Identifier: AGPL-3.0-only
// Wrap: one closed skin round the part, everything inside it dropped and
// every opening narrower than the gap bridged — a preview until it is
// applied.

import { useShallow } from 'zustand/react/shallow'
import { InfoDot } from '../../../../src/ui/InfoDot'
import { NumberField } from '../../../../src/ui/NumberField'
import { useLength } from '../../../../src/app/useUnits'
import type { WrapEdges } from '../../core/wrap'
import { useMeshTools, wrapStale } from '../../state/meshStore'
import { count, typedLen } from '../meshFormat'

const EDGES: { id: WrapEdges; label: string; title: string }[] = [
  { id: 'sharp', label: 'Sharp', title: 'Rebuild the part’s sharp edges and corners on the wrap — for a machined or moulded part. A wrap grown keeps its rounds' },
  { id: 'smooth', label: 'Smooth', title: 'Leave the edges as the wrap’s grid rounds them, by a fraction of the gap — for an organic shape, or a scan' },
]

export function WrapTool({
  ready,
  busy,
  onWrap,
  onCancel,
  onApply,
  onDiscard,
}: {
  ready: boolean
  busy: boolean
  onWrap: () => void
  onCancel: () => void
  onApply: () => void
  onDiscard: () => void
}) {
  // Only what the panel reads: the whole store would render it again on
  // every write to it.
  const m = useMeshTools(
    useShallow((s) => ({
      setWrapEdges: s.setWrapEdges,
      setWrapGap: s.setWrapGap,
      setWrapGrow: s.setWrapGrow,
      wrapEdges: s.wrapEdges,
      wrapGap: s.wrapGap,
      wrapGrow: s.wrapGrow,
      wrapMade: s.wrapMade,
      wrapMessage: s.wrapMessage,
      wrapOpen: s.wrapOpen,
      wrapStage: s.wrapStage,
      wrapStatus: s.wrapStatus,
    })),
  )
  const stale = useMeshTools(wrapStale)
  const len = useLength()
  const made = m.wrapMade
  const r = made?.report
  const running = m.wrapStatus === 'running'
  const n = (k: number, one: string, many: string) => `${count(k)} ${k === 1 ? one : many}`
  const seconds = r ? r.stages.reduce((t, s) => t + s.ms, 0) / 1000 : 0

  return (
    <>
      <div className="group" data-test="wrap-tool">
        <div className="sec-head">
          Wrap
          <InfoDot title="Wrapping a part in one closed skin">
            <p>
              One closed skin round the part, for a mesh that is a mess inside: an assembly exported
              as one file, channels and bosses inside a casting, shells that overlap or face the wrong
              way, a scan with cracks. Everything inside goes, and the skin is easy to print or slice.
            </p>
            <p>
              Think of a ball rolled all over the part from outside: the wrap is where it stopped. It
              lies on the part wherever the ball touched it, and bridges every opening the ball could
              not get through — every slot, hole or crack narrower than <b>Close gaps under</b>. Keep
              that small: a groove narrower than it is closed over too.
            </p>
            <p>
              An open sheet has no inside, so it wraps to nothing: <b>Grow by</b> half the thickness
              it should have, and it comes out a solid that thick. Grown, the whole wrap stands that
              far off the part.
            </p>
            <p>
              The result is a preview, the bridges in amber. <b>Apply</b> makes it the edited copy, one
              step of the undo history.
            </p>
          </InfoDot>
        </div>

        <NumberField
          label="Close gaps under"
          testId="wrap-gap"
          value={m.wrapGap}
          step={0.1}
          min={0.001}
          kind="length"
          disabled={busy}
          onCommit={m.setWrapGap}
          hint={
            <>
              <p>Openings narrower than this are bridged; wider ones the wrap follows down.</p>
              <p>
                It starts at a two-hundredth of the part's size. The work grows as the gap shrinks: on a
                large part a fine gap is closed on a coarser grid, and the result says so.
              </p>
            </>
          }
        />

        <NumberField
          label="Grow by"
          testId="wrap-grow"
          value={m.wrapGrow}
          step={0.1}
          min={0}
          kind="length"
          disabled={busy}
          onCommit={m.setWrapGrow}
          hint="How far the wrap stands off the part all round. 0 lays it on the part; an open sheet needs half the thickness it should have — at most the gap."
        />
        {m.wrapOpen !== null && m.wrapOpen > 0 && m.wrapGrow === 0 && (
          <p className="hint" data-test="wrap-open">
            The mesh has {n(m.wrapOpen, 'open edge', 'open edges')}. Where it is a sheet rather than the
            skin of a solid it has no inside, and wraps to nothing unless grown.
          </p>
        )}

        <div className="moderow" role="radiogroup" aria-label="Edges">
          {EDGES.map((x) => (
            <button
              key={x.id}
              role="radio"
              aria-checked={m.wrapEdges === x.id}
              className={m.wrapEdges === x.id ? 'on' : undefined}
              data-test={`wrap-edges-${x.id}`}
              disabled={busy}
              onClick={() => m.setWrapEdges(x.id)}
              title={x.title}
            >
              {x.label}
            </button>
          ))}
        </div>

        {running ? (
          <div className="toolrow">
            <button className="primary" disabled data-test="wrap-run">
              <span className="spinner" />
              Wrapping…
            </button>
            <button data-test="wrap-cancel" onClick={onCancel} title="Stop the wrap — the mesh stays as it is">
              Cancel
            </button>
          </div>
        ) : (
          <button className="primary block" data-test="wrap-run" data-confirm={made && !stale ? undefined : 1} disabled={!ready || busy} onClick={onWrap}>
            {made ? 'Wrap again' : 'Wrap'}
          </button>
        )}
        {running && m.wrapStage && (
          <p className="hint" data-test="wrap-stage">
            {m.wrapStage}
          </p>
        )}
        {m.wrapMessage && <p className="alarmtext">{m.wrapMessage}</p>}
      </div>

      {r && made && (
        <div className="group" data-test="wrap-result">
          <div className="dro hero">
            <div className="dro-label">
              <span>Wrap</span>
              <span>{n(r.shells, 'shell', 'shells')}</span>
            </div>
            <div className="dro-window" data-test="wrap-triangles">
              <b>{count(r.triangles)}</b>
              <span>TRIANGLES</span>
            </div>
            <div className="dro-note">
              from {count(r.inputTriangles)} · gaps under {typedLen(r.settings.gap, len.units)} closed
              {r.settings.grow > 0 ? ` · grown ${typedLen(r.settings.grow, len.units)}` : ''}
            </div>
          </div>

          <div className="kv" data-test="wrap-dropped">
            <span className="name">Triangles inside, dropped</span>
            <b>{count(r.dropped)}</b>
          </div>
          {r.settings.edges === 'sharp' && r.settings.grow === 0 && (
            <div className="kv" data-test="wrap-sharp">
              <span className="name">Edges put back</span>
              <b>
                {count(r.sharpEdges)} points{r.sharpCorners > 0 ? ` · ${count(r.sharpCorners)} corner${r.sharpCorners === 1 ? '' : 's'}` : ''}
              </b>
            </div>
          )}
          <div className="kv" data-test="wrap-bridged">
            <span className="name">Bridging openings</span>
            <b>{len.area(r.bridgedArea, 1)}</b>
          </div>
          <div className="kv">
            <span className="name">Volume</span>
            <b>
              {made.volumeBefore !== null ? `${len.vol(made.volumeBefore, 1)} → ` : ''}
              {len.vol(r.volume, 1)}
            </b>
          </div>
          <div className="kv">
            <span className="name">
              Grid
              <InfoDot title="How it was worked out">
                <p>
                  The wrap is found on a grid a sixth of the gap across, and every vertex where it touches
                  the part is then moved onto the part's own triangles — so it lies on the part as exactly
                  as the part is meshed, whatever the grid.
                </p>
                <p>
                  {r.stages.map((s) => `${s.name} ${(s.ms / 1000).toFixed(2)} s`).join(' · ')}
                </p>
              </InfoDot>
            </span>
            <b>
              {len.fmt(r.cell, 3)} · {seconds.toFixed(1)} s
            </b>
          </div>
          {r.warning && (
            <p className="warnnote" data-test="wrap-warning">
              ⚠ {r.warning}
            </p>
          )}
          {r.coarsened && r.fullGap !== null && (
            <p className="warnnote" data-test="wrap-coarsened">
              ⚠ The part is too large for a grid this fine: it was worked out on a coarser one, so gaps
              near {typedLen(r.settings.gap, len.units)} are judged less exactly. At this size{' '}
              {typedLen(r.fullGap, len.units)} is the smallest gap closed as exactly.
            </p>
          )}
          {stale && (
            <p className="hint" data-test="wrap-stale">
              The settings have changed since this was wrapped — wrap again to use them. Apply takes the
              wrap on screen.
            </p>
          )}

          <div className="divider" />
          <p className="hint" data-test="wrap-preview">
            A preview: nothing has changed yet. The amber is where it bridges an opening.
          </p>
          <div className="toolrow">
            <button data-test="wrap-discard" disabled={busy} onClick={onDiscard} title="Put the wrap away — the mesh is as it was">
              Discard
            </button>
            <button
              className="primary"
              data-test="wrap-apply"
              disabled={busy}
              onClick={onApply}
              title="Make the wrap the edited copy, ready for Use for analysis — Ctrl+Z puts the mesh back"
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </>
  )
}

// SPDX-License-Identifier: AGPL-3.0-only
// Smooth: the scan's noise taken out, over the whole part or a marked
// region, its edges kept or let soften.

import { useShallow } from 'zustand/react/shallow'
import { useMark } from '../../../../src/state/markStore'
import { InfoDot } from '../../../../src/ui/InfoDot'
import { MarkTools } from '../../../../src/ui/MarkTools'
import { NumberField } from '../../../../src/ui/NumberField'
import { useMeshTools } from '../../state/meshStore'

export function SmoothTool({
  ready,
  busy,
  onSmooth,
  onClear,
}: {
  ready: boolean
  busy: boolean
  onSmooth: () => void
  onClear: () => void
}) {
  // Only what the panel reads: the whole store would render it again on
  // every write to it, the cut preview's while its offset is dragged.
  const m = useMeshTools(
    useShallow((s) => ({
      editing: s.editing,
      setSmoothEdges: s.setSmoothEdges,
      setSmoothLimit: s.setSmoothLimit,
      setSmoothScope: s.setSmoothScope,
      setSmoothSize: s.setSmoothSize,
      smoothEdges: s.smoothEdges,
      smoothLimit: s.smoothLimit,
      smoothScope: s.smoothScope,
      smoothSize: s.smoothSize,
    })),
  )
  const marked = useMark((s) => s.count)
  const regional = m.smoothScope === 'marked'

  return (
    <div className="group" data-test="smooth-tool">
      <div className="sec-head">
        Smooth
        <InfoDot title="Smoothing the scan">
          <p>
            A scanner's scatter is bumps across the surface: it makes a flat face read as orange
            peel, a reduction keep triangles for it, a thickness map speckle. Smoothing moves every
            point onto a surface fitted to the scan around it — a gently curved patch{' '}
            <b>Smooth bumps up to</b> across. A bump smaller than the patch is averaged away; a face,
            a bore or a fillet larger than it is what the patch fits, and stays where it was, so the
            part is not shrunk. Points move along the surface's normal only.
          </p>
          <p>
            No point ever moves further than <b>Move at most</b> from where the scanner put it. It
            starts well past the scatter of a good scan, to hold back only a fit that has run off;
            set it lower to be sure of what the part's shape can lose.
          </p>
          <p>
            <b>Keep sharp edges</b> fits each side of an edge where the surface turns by more than
            30° on its own, so the faces are smoothed right up to the edge and the edge itself is
            left as scanned: a machined edge is detail, not noise. Smoothing changes the edited
            copy; <b>Ctrl+Z</b> puts it back.
          </p>
          <p>
            <b>Marked region</b> smooths only the surface you mark with a window, the brush or a
            lasso — a face that came out rough, leaving a textured one as it is. Each point moves
            by less the nearer it is to the edge of the region, nothing at the edge itself, so the
            smoothed patch runs into the scan around it without a step.
          </p>
        </InfoDot>
      </div>

      <div className="field">
        <span>Smooth</span>
        <div className="moderow" role="radiogroup" aria-label="What to smooth">
          {(['all', 'marked'] as const).map((scope) => (
            <button
              key={scope}
              role="radio"
              aria-checked={m.smoothScope === scope}
              className={m.smoothScope === scope ? 'on' : undefined}
              data-test={`smooth-scope-${scope}`}
              disabled={busy}
              onClick={() => m.setSmoothScope(scope)}
              title={scope === 'all' ? 'Smooth the whole part' : 'Smooth only a region you mark on the part'}
            >
              {scope === 'all' ? 'Whole part' : 'Marked region'}
            </button>
          ))}
        </div>
      </div>
      {regional && (
        <MarkTools escapeNote="The marking stays until it is smoothed or cleared." onClear={onClear} />
      )}

      <NumberField
        label="Smooth bumps up to"
        testId="smooth-size"
        value={m.smoothSize}
        step={0.1}
        min={0.001}
        kind="length"
        disabled={busy}
        onCommit={m.setSmoothSize}
        hint="Bumps smaller than this across are smoothed out; the part's shape larger than it stays. It starts at the orange peel a scanner leaves on a part this size."
      />
      <NumberField
        label="Move at most"
        testId="smooth-limit"
        value={m.smoothLimit}
        step={0.01}
        min={0.0001}
        kind="length"
        disabled={busy}
        onCommit={m.setSmoothLimit}
        hint="No point moves further than this from where the scanner put it. It starts well past the scatter of a good scan of a part this size."
      />
      <label className="checkrow">
        <input
          type="checkbox"
          data-test="smooth-edges"
          disabled={busy}
          checked={m.smoothEdges}
          onChange={(e) => m.setSmoothEdges(e.target.checked)}
        />
        <span>Keep sharp edges</span>
      </label>

      <button
        className="primary block"
        data-test="smooth-scan"
        data-confirm={1}
        disabled={!ready || busy || (regional && marked === 0)}
        onClick={onSmooth}
      >
        {m.editing ? (
          <>
            <span className="spinner" />
            Smoothing…
          </>
        ) : regional ? (
          'Smooth the marked region'
        ) : (
          'Smooth'
        )}
      </button>
      {regional && marked === 0 && (
        <p className="hint">Mark the surface to smooth — pick Window, Brush or Lasso above.</p>
      )}
    </div>
  )
}

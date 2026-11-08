// SPDX-License-Identifier: AGPL-3.0-only
// Offset: the surface moved along its normals, the whole part or a marked
// region, by a distance either way.

import { useShallow } from 'zustand/react/shallow'
import { useLength } from '../../../../src/app/useUnits'
import { useMark } from '../../../../src/state/markStore'
import { InfoDot } from '../../../../src/ui/InfoDot'
import { MarkTools } from '../../../../src/ui/MarkTools'
import { NumberField } from '../../../../src/ui/NumberField'
import { useMeshTools } from '../../state/meshStore'
import { typedLen } from '../meshFormat'

export function OffsetTool({
  ready,
  busy,
  onOffset,
  onClear,
}: {
  ready: boolean
  busy: boolean
  onOffset: () => void
  onClear: () => void
}) {
  // Only what the panel reads: the whole store would render it again on
  // every write to it, the cut preview's while its offset is dragged.
  const m = useMeshTools(
    useShallow((s) => ({
      editing: s.editing,
      offsetDirection: s.offsetDirection,
      offsetDistance: s.offsetDistance,
      offsetScope: s.offsetScope,
      setOffsetDirection: s.setOffsetDirection,
      setOffsetDistance: s.setOffsetDistance,
      setOffsetScope: s.setOffsetScope,
    })),
  )
  const marked = useMark((s) => s.count)
  const regional = m.offsetScope === 'marked'
  const expand = m.offsetDirection === 'expand'
  const len = useLength()
  const w = len.word()
  // The example in the info, in round figures of the unit shown.
  const ex = len.units === 'in' ? { ball: 1, by: 0.02, across: 1.04, bore: 0.04 } : { ball: 20, by: 0.5, across: 21, bore: 1 }

  return (
    <div className="group" data-test="offset-tool">
      <div className="sec-head">
        Shrink / expand
        <InfoDot title="Shrinking or expanding the surface">
          <p>
            Every point of the surface moved along its normal by the same distance: out to{' '}
            <b>expand</b>, in to <b>shrink</b>. Not a scale — a {ex.ball} {w} ball expanded by{' '}
            {ex.by} {w} is {ex.across} {w} across, and a bore in the part comes out {ex.bore} {w}{' '}
            narrower, where scaling would widen it. For the thickness a scanning spray added, a
            clearance on a mating part, a print that came out a little fat.
          </p>
          <p>
            Each point moves so that every face around it ends the distance from where it was —
            even thickness, as a CAD offset has it. On a sharp edge the point moves further, square
            to neither face, so both faces end the distance out and the edge stays sharp. Where
            the surface would fold over itself — a dent shrunk past its depth, a spike of scatter
            — the points are eased until it does not.
          </p>
          <p>
            <b>Marked region</b> moves only the surface you mark with a window, the brush or a
            lasso, as a step — like a face pushed. Where the face beside it runs along the move —
            marked up to a machined edge — that face is stretched or shortened with it and the
            edge stays sharp; elsewhere a wall joins the step to the surface around it. The edit
            is made on the edited copy; <b>Ctrl+Z</b> puts it back.
          </p>
        </InfoDot>
      </div>

      <div className="field">
        <span>Move</span>
        <div className="moderow" role="radiogroup" aria-label="What to move">
          {(['all', 'marked'] as const).map((scope) => (
            <button
              key={scope}
              role="radio"
              aria-checked={m.offsetScope === scope}
              className={m.offsetScope === scope ? 'on' : undefined}
              data-test={`offset-scope-${scope}`}
              disabled={busy}
              onClick={() => m.setOffsetScope(scope)}
              title={scope === 'all' ? 'Move the whole surface' : 'Move only a region you mark on the part, as a step'}
            >
              {scope === 'all' ? 'Whole part' : 'Marked region'}
            </button>
          ))}
        </div>
      </div>
      {regional && <MarkTools escapeNote="The marking stays until it is moved or cleared." onClear={onClear} />}

      <div className="field">
        <span>Direction</span>
        <div className="moderow" role="radiogroup" aria-label="Which way to move">
          {(['expand', 'shrink'] as const).map((direction) => (
            <button
              key={direction}
              role="radio"
              aria-checked={m.offsetDirection === direction}
              className={m.offsetDirection === direction ? 'on' : undefined}
              data-test={`offset-${direction}`}
              disabled={busy}
              onClick={() => m.setOffsetDirection(direction)}
              title={direction === 'expand' ? 'Out along the normal — the part grows, its bores narrow' : 'In along the normal — the part shrinks, its bores widen'}
            >
              {direction === 'expand' ? 'Expand' : 'Shrink'}
            </button>
          ))}
        </div>
      </div>

      <NumberField
        label="Distance"
        testId="offset-distance"
        value={m.offsetDistance}
        step={0.01}
        min={0.0001}
        kind="length"
        disabled={busy}
        onCommit={m.setOffsetDistance}
        hint="How far the surface moves along its normal. Meant for corrections small against the part's features: a slot narrower than twice the distance closes over itself when the part is expanded, as a rib thinner than it does when it is shrunk."
      />

      <button
        className="primary block"
        data-test="offset-run"
        data-confirm={1}
        disabled={!ready || busy || (regional && marked === 0)}
        onClick={onOffset}
      >
        {m.editing ? (
          <>
            <span className="spinner" />
            {expand ? 'Expanding…' : 'Shrinking…'}
          </>
        ) : (
          `${expand ? 'Expand' : 'Shrink'} ${regional ? 'the marked region ' : ''}by ${typedLen(m.offsetDistance, len.units)}`
        )}
      </button>
      {regional && marked === 0 && (
        <p className="hint">Mark the surface to move — pick Window, Brush or Lasso above.</p>
      )}
    </div>
  )
}

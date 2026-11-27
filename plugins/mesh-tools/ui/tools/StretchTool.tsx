// SPDX-License-Identifier: AGPL-3.0-only
// Stretch: the part cut across a direction at one place, the side past the
// cut moved out and the cut's cross-section put in across the gap — or,
// negative, a slab taken out — the whole part, or the piece clicked.

import { useShallow } from 'zustand/react/shallow'
import { isWorldAxis, SECTION_REF_KINDS, WORLD_AXES, type SectionRef } from '../../../../src/core/section/frame'
import { useStore } from '../../../../src/state/store'
import { useLength } from '../../../../src/app/useUnits'
import { InfoDot } from '../../../../src/ui/InfoDot'
import { NumberField } from '../../../../src/ui/NumberField'
import { providersFor } from '../../../../src/ui/RefSelect'
import { featuresCut, pickingPiece, stretchSetupOf } from '../../app/stretchSetup'
import { useMeshTools } from '../../state/meshStore'

export function StretchTool({ ready, busy, onStretch }: { ready: boolean; busy: boolean; onStretch: () => void }) {
  // Only what the panel reads: the whole store would render it again on
  // every write to it.
  const m = useMeshTools(
    useShallow((s) => ({
      editing: s.editing,
      stretchRef: s.stretchRef,
      stretchAt: s.stretchAt,
      stretchAtAuto: s.stretchAtAuto,
      stretchAmount: s.stretchAmount,
      stretchScope: s.stretchScope,
      stretchPiece: s.stretchPiece,
      stretchPreview: s.stretchPreview,
      stretchError: s.stretchError,
      setStretchRef: s.setStretchRef,
      setStretchAt: s.setStretchAt,
      setStretchAmount: s.setStretchAmount,
      setStretchScope: s.setStretchScope,
    })),
  )
  const elements = useStore((s) => s.elements)
  const len = useLength()
  const options = providersFor(['plane', 'axis'], elements, undefined, SECTION_REF_KINDS)
  const setup = stretchSetupOf(m, elements)
  const axisName = setup?.axisName ?? null
  const parseRef = (v: string): SectionRef => (isWorldAxis(v) ? v : Number(v))
  const report = m.stretchPreview
  // The cut as it stands — following an arrow as it is dragged — or, while
  // it is left to go through the middle of the part, the preview's, which
  // has the middle worked out.
  const at = m.stretchAtAuto ? (report?.at ?? m.stretchAt) : m.stretchAt
  // Offered only where the part past the cut falls into more than one
  // piece — the legs of a U cut across — where picking one makes a
  // difference.
  const pieces = (report?.pieces ?? 0) > 1
  const piece = pieces && pickingPiece(m)
  const waiting = piece && !m.stretchPiece
  const outOfRound = setup && report ? featuresCut(elements, setup.settings.origin, setup.settings.dir, at, m.stretchAmount < 0 ? at - m.stretchAmount : at) : []
  const reachBefore = report ? report.extent.max - report.extent.min : null
  const reachAfter = report ? report.newExtent.max - report.newExtent.min : null
  const one = outOfRound.length === 1

  return (
    <div className="group" data-test="stretch-tool">
      <div className="sec-head">
        Stretch
        <InfoDot title="Stretching the scan">
          <p>
            The part cut across a direction at one place, everything past the cut moved out, and the
            cut’s own cross-section extruded across the gap: a spacer lengthened without widening its
            ends, two holes moved apart without changing their size. A negative amount takes a slab
            that thick out past the cut instead, and closes the part up again.
          </p>
          <p>
            Pick what to stretch <b>along</b> — a coordinate axis, after a datum alignment the
            datum’s, or an element with a direction, such as a cylinder’s axis — and where to cut:
            it starts through the middle of the part, outlined on it; click the part, or drag one
            of the arrows on the cut, to move it. Type how much to put in under <b>Extend by</b>.
            Cut where the cross-section does not change, clear of the features that must keep their
            size: a hole the cut goes through becomes a slot, and the panel names those it knows of.
          </p>
          <p>
            Where the part past the cut falls into more than one piece — the legs of a U cut across
            — <b>Only the piece clicked</b> moves only the one you click, and leaves the others. The part is shown as
            the stretch will leave it, the section put in tinted. A closed part stays closed. The
            stretch is made on the edited copy; <b>Ctrl+Z</b> puts it back.
          </p>
        </InfoDot>
      </div>

      <label className="field">
        <span>Along</span>
        <select data-test="stretch-ref" value={String(m.stretchRef)} disabled={busy} onChange={(e) => m.setStretchRef(parseRef(e.target.value))}>
          <optgroup label="Coordinate axes">
            {WORLD_AXES.map((a) => (
              <option key={a} value={a}>
                {a.toUpperCase()}
              </option>
            ))}
          </optgroup>
          {options.length > 0 && (
            <optgroup label="Elements">
              {options.map((el) => (
                <option key={el.id} value={el.id}>
                  {el.name}
                </option>
              ))}
            </optgroup>
          )}
          {!isWorldAxis(m.stretchRef) && !options.some((el) => el.id === m.stretchRef) && (
            <option value={String(m.stretchRef)}>(deleted element)</option>
          )}
        </select>
      </label>

      <NumberField
        label="Extend by"
        testId="stretch-amount"
        value={m.stretchAmount}
        step={0.1}
        min={-1e6}
        kind="length"
        disabled={busy}
        onCommit={m.setStretchAmount}
        hint="How far everything past the cut moves out — the length of the section put in. Negative takes a slab that thick out past the cut."
      />

      {pieces && (
        <label className="checkrow" data-test="stretch-piece">
          <input type="checkbox" checked={piece} disabled={busy} onChange={(e) => m.setStretchScope(e.target.checked ? 'piece' : 'all')} />
          <span>Only the piece clicked</span>
        </label>
      )}
      {waiting && (
        <p className="hint" data-test="stretch-pick-hint">
          Click the piece to stretch on the part, where it is to be cut.
        </p>
      )}

      {report && axisName && (
        <div className="kv" data-test="stretch-cut">
          <span className="name">Cut at {axisName}</span>
          <b>{len.fmt(at, 2)}</b>
        </div>
      )}
      {report && axisName && reachBefore !== null && reachAfter !== null && (
        <div className="kv" data-test="stretch-reach">
          <span className="name">Part along {axisName}</span>
          <b>
            {len.fmt(reachBefore, 2)} → {len.fmt(reachAfter, 2)}
          </b>
        </div>
      )}
      {outOfRound.length > 0 && (
        <p className="warnnote" data-test="stretch-features">
          The {m.stretchAmount < 0 ? 'slab taken out reaches into' : 'cut goes through'} {outOfRound.join(', ')}: {one ? 'it turns' : 'they turn'} out
          of round. Cut clear of {one ? 'it' : 'them'} to keep {one ? 'its' : 'their'} size.
        </p>
      )}
      {m.stretchError && (
        <p className="warnnote" data-test="stretch-error">
          {m.stretchError}
        </p>
      )}

      <button
        className="primary block"
        data-test="stretch-scan"
        data-confirm={1}
        disabled={!ready || busy || !report || m.stretchAmount === 0 || waiting}
        onClick={onStretch}
      >
        {m.editing ? (
          <>
            <span className="spinner" />
            Stretching…
          </>
        ) : (
          'Stretch'
        )}
      </button>
      {ready && report && m.stretchAmount === 0 && !waiting && (
        <p className="hint" data-test="stretch-hint">
          The cut is outlined on the part. Click the part, or drag an arrow on the cut, to move it — then type how much to put in.
        </p>
      )}
    </div>
  )
}

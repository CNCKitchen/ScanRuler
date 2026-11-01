// SPDX-License-Identifier: AGPL-3.0-only
// Cut: the scan cut by a plane, one side taken off and the cut capped flat
// where the part was closed.

import { useShallow } from 'zustand/react/shallow'
import { isWorldAxis, SECTION_REF_KINDS, type SectionRef } from '../../../../src/core/section/frame'
import { useStore } from '../../../../src/state/store'
import { InfoDot } from '../../../../src/ui/InfoDot'
import { NumberField } from '../../../../src/ui/NumberField'
import { providersFor } from '../../../../src/ui/RefSelect'
import { PlaneRefOptions } from '../../../../src/ui/SectionEditor'
import { cutPlaneOf } from '../../core/cutPlane'
import { type CutOutcome, useMeshTools } from '../../state/meshStore'
import { count } from '../meshFormat'

export function CutTool({ ready, busy, onCut }: { ready: boolean; busy: boolean; onCut: () => void }) {
  // Only what the panel reads: the whole store would render it again on
  // every write to it, the cut preview's while its offset is dragged.
  const m = useMeshTools(
    useShallow((s) => ({
      cutCap: s.cutCap,
      cutKeep: s.cutKeep,
      cutOffset: s.cutOffset,
      cutOffsetAuto: s.cutOffsetAuto,
      cutPreview: s.cutPreview,
      cutRef: s.cutRef,
      editing: s.editing,
      setCutCap: s.setCutCap,
      setCutKeep: s.setCutKeep,
      setCutOffset: s.setCutOffset,
      setCutRef: s.setCutRef,
    })),
  )
  const elements = useStore((s) => s.elements)
  const modelCenter = useStore((s) => s.modelCenter)
  const options = providersFor(['plane', 'axis'], elements, undefined, SECTION_REF_KINDS)
  const plane = cutPlaneOf(m.cutRef, m.cutOffset, m.cutOffsetAuto, m.cutKeep, elements, modelCenter)
  const axisName = isWorldAxis(m.cutRef) ? m.cutRef.toUpperCase() : null
  const parseRef = (v: string): SectionRef => (isWorldAxis(v) ? v : Number(v))

  return (
    <div className="group" data-test="cut-tool">
      <div className="sec-head">
        Cut
        <InfoDot title="Cutting the scan">
          <p>
            The scan cut with a plane and one side of it taken off: the turntable or the table the
            part stood on, a flat bottom for a part that is to be printed, one half of a part to
            model on its own. While the tool is in hand the part is shown cut where the plane is,
            the side that goes already taken away and the cut closed as it will be closed.
          </p>
          <p>
            The plane is taken across one of the scan's <b>coordinate planes</b> — after a datum
            alignment, the datum's, so <b>Z</b> 0 is the face the part was set on and <b>Z</b> 0.5
            half a unit above it — or across an <b>element</b> with a direction: a plane's normal, the axis
            of a cylinder, cone or line. It starts through the middle of the part; type where it
            should be.
          </p>
          <p>
            <b>Close flat</b> fills the cut face wherever the plane goes all the way round the
            part, so a closed part stays closed. Where the scan is open across the plane the rim
            stays open, and the result says so. The cut is made on the edited copy;{' '}
            <b>Ctrl+Z</b> puts it back.
          </p>
        </InfoDot>
      </div>

      <label className="field">
        <span>Cut across</span>
        <select
          data-test="cut-ref"
          value={String(m.cutRef)}
          disabled={busy}
          onChange={(e) => m.setCutRef(parseRef(e.target.value))}
        >
          <PlaneRefOptions options={options} />
          {!axisName && !options.some((el) => el.id === m.cutRef) && (
            <option value={String(m.cutRef)}>(deleted element)</option>
          )}
        </select>
      </label>

      <NumberField
        label={axisName ?? 'Offset'}
        testId="cut-offset"
        value={plane?.offset ?? m.cutOffset}
        step={0.1}
        min={-1e6}
        kind="length"
        disabled={busy || !plane}
        onCommit={m.setCutOffset}
        hint={
          axisName
            ? `Where the plane is: its ${axisName} coordinate. It starts through the middle of the part.`
            : 'How far the plane is moved along the element’s direction from its centre. It starts through the middle of the part.'
        }
      />

      <div className="field">
        <span>Keep</span>
        <div className="moderow" role="radiogroup" aria-label="Side to keep">
          {(['plus', 'minus'] as const).map((k) => (
            <button
              key={k}
              role="radio"
              aria-checked={m.cutKeep === k}
              className={m.cutKeep === k ? 'on' : undefined}
              data-test={`cut-keep-${k}`}
              disabled={busy}
              onClick={() => m.setCutKeep(k)}
              title={
                k === 'plus'
                  ? 'Keep the side the direction points to — above the XY plane, outside a fitted face'
                  : 'Keep the other side'
              }
            >
              {`${k === 'plus' ? '+' : '−'}${axisName ?? ''} side`}
            </button>
          ))}
        </div>
      </div>

      <label className="checkrow">
        <input
          type="checkbox"
          data-test="cut-cap"
          disabled={busy}
          checked={m.cutCap}
          onChange={(e) => m.setCutCap(e.target.checked)}
        />
        <span>Close flat</span>
        <InfoDot title="Close flat">
          <p>
            Close the part with a flat face where the plane goes all the way round it — a ring where
            it crosses a bore, a disc where it crosses a solid. Off, the cut is left open, as a scan
            of a surface would be.
          </p>
        </InfoDot>
      </label>

      <button
        className="primary block"
        data-test="cut-scan"
        data-confirm={1}
        disabled={!ready || busy || !plane || m.cutPreview?.cuts === false}
        onClick={onCut}
      >
        {m.editing ? (
          <>
            <span className="spinner" />
            Cutting…
          </>
        ) : (
          'Cut'
        )}
      </button>
      {!plane && <p className="hint">Choose what to cut across.</p>}
      {plane && ready && <CutOutcomeLine outcome={m.cutPreview} cap={m.cutCap} />}
    </div>
  )
}

/** What the cut shown on the part will do, said under the button. */
function CutOutcomeLine({ outcome, cap }: { outcome: CutOutcome | null; cap: boolean }) {
  if (!outcome) {
    return (
      <p className="hint">
        <span className="spinner" /> Working out the cut…
      </p>
    )
  }
  if (!outcome.cuts) {
    return (
      <p className="hint" data-test="cut-misses">
        The plane misses the part, or takes all of it — move it to where the part is to be cut.
      </p>
    )
  }
  if (!cap) return <p className="hint">The part is shown as the cut would leave it, open.</p>
  const n = (k: number, one: string, many: string) => `${count(k)} ${k === 1 ? one : many}`
  const bridged =
    outcome.bridged > 0 ? `, bridging ${n(outcome.bridged, 'hole', 'holes')} in the scan at the cut` : ''
  if (outcome.open === 0) {
    return (
      <p className="hint" data-test="cut-closes">
        The part is shown as the cut would leave it: closed flat{bridged}.
      </p>
    )
  }
  return (
    <p className="hint" data-test="cut-open">
      The scan is open across the plane, so {n(outcome.open, 'stretch', 'stretches')} of the cut will
      stay open — drawn grey on the part
      {outcome.capped > 0 ? `; the rest closes flat${bridged}` : ''}.
    </p>
  )
}

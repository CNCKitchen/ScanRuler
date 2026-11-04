// SPDX-License-Identifier: AGPL-3.0-only
import { NumberField } from '../../../../src/ui/NumberField'
import { InfoDot } from '../../../../src/ui/InfoDot'
import { useLength } from '../../../../src/app/useUnits'
import type { BridgeToolState } from '../../app/useBridgeTool'

export function BridgeTool({ bridge, ready, busy }: { bridge: BridgeToolState; ready: boolean; busy: boolean }) {
  const len = useLength()
  const locked = busy || bridge.dragging
  const adjusting = locked || bridge.drawing
  const count = bridge.points.length
  const instruction = count === bridge.total
    ? 'Preview the bridge and inspect it before applying.'
    : count === bridge.firstSideCount - 1
      ? 'First side: pick close to the open rim.'
      : count === bridge.firstSideCount
        ? 'Other side: pick close to the opposite rim.'
        : count < bridge.firstSideCount
          ? 'First side: pick in order toward the gap, starting farther away.'
          : 'Other side: pick in order away from the gap.'
  return (
    <div className="group" data-test="bridge-tool">
      <div className="sec-head">
        Bridge gap
        <InfoDot title="Bridging a gap" testId="bridge-help">
          <p>
            Make a narrow stitched strip across a gap, then use <b>Fill holes</b> on the enclosed
            opening. The bridge is inferred geometry, not a measurement; original scan points stay fixed.
          </p>
          <p>
            Pick points in one row along the crossing: toward the gap on the first side, then
            away from it on the other. The two inner points attach to the open rim; the others
            guide curvature. Use at least two per side, up to ten total. Changing a count clears temporary picks.
          </p>
          <p>
            Or use <b>Draw crossing</b>: left-drag from existing surface, across one visible gap,
            and onto surface on the other side. The selected counts determine the generated points.
            Shift-drag navigates; Esc cancels drawing.
          </p>
          <p>
            Drag numbered points along the scan to adjust them; off-surface moves are ignored.
            Release to refresh the preview, or Esc to cancel the drag. Width changes also refresh a
            checked preview. Two points on a side give a straight local slope; more guide curvature.
            Angled crossings are allowed; folds, overlaps or near-tangent attachments may need
            different points or a narrower bridge.
          </p>
          <p>
            Inspect the preview before <b>Apply bridge</b>. <b>Ctrl+Z</b> removes an applied bridge.
            Unapplied picks and previews are temporary and are not saved.
          </p>
        </InfoDot>
      </div>
      <button className="block" data-test="bridge-draw" disabled={!ready || locked} aria-pressed={bridge.drawing} onClick={bridge.toggleDraw}>
        {bridge.drawing ? 'Cancel drawing' : 'Draw crossing'}
      </button>
      {(['first', 'second'] as const).map((side) => {
        const other = side === 'first' ? bridge.secondSideCount : bridge.firstSideCount
        return <label className="field" key={side}>
          <span>{side === 'first' ? 'First side points' : 'Other side points'}</span>
          <select
            data-test={`bridge-${side}-count`}
            value={side === 'first' ? bridge.firstSideCount : bridge.secondSideCount}
            disabled={adjusting}
            onChange={(e) => bridge.setCount(side, Number(e.target.value))}
          >
            {Array.from({ length: 9 - other }, (_, i) => i + 2).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      })}
      <p className="hint" data-test="bridge-instruction">
        {count}/{bridge.total} points.{' '}
        {bridge.drawing
          ? 'Drag across one gap, starting and ending on the scan. Esc cancels; Shift-drag navigates.'
          : instruction}
      </p>
      {bridge.guidance && <div className="bridge-error" role="alert" data-test="bridge-guidance">
        <b>{bridge.guidance.points.length ? `Check highlighted points ${bridge.guidance.points.map((i) => i + 1).join(', ')}` : 'Bridge could not be checked'}</b>
        <p>{bridge.guidance.message}</p>
        {bridge.guidance.points.length > 0 && <p className="hint">Yellow rings mark affected guides; arrows show known rim targets.</p>}
        {bridge.guidance.canReduceBend && <>
          <button className="block" data-test="bridge-reduce-bend" disabled={adjusting || !ready} onClick={bridge.reduceBend}>Reduce bend to valid preview</button>
          <p className="hint">
            Keeps points and width; changes inferred curvature.
            <InfoDot title="Reducing bridge bend" testId="bridge-reduce-help">
              <p>Keep points, attachments and width fixed while searching for a validated preview with reduced sampled bow. This can change the inferred profile and attachment slope; inspect both before Apply.</p>
              <p>The search retains as much sampled bow as it finds valid, not a proven maximum. Moving a point restores its sampled bow.</p>
            </InfoDot>
          </p>
        </>}
      </div>}
      {bridge.canAdjustPoints && <>
        <button className="block" data-test="bridge-adjust-points" disabled={adjusting || !ready} onClick={bridge.adjustPoints}>Adjust guide points to valid preview</button>
        <p className="hint">
          Moves guides; keeps rim points and width.
          <InfoDot title="Adjusting bridge guides" testId="bridge-adjust-help">
            <p>Move surface guides toward a straighter crossing on nearby connected scan surface. The two inner rim points and width stay fixed, with full sampled bend rather than reduced tangents. Nothing moves if no valid preview is found.</p>
            <p>Green rings mark moved guides. Restore previous points returns the pre-adjustment picks and bend, then rechecks using the current width. Manual point changes clear that restore option.</p>
          </InfoDot>
        </p>
      </>}
      {bridge.movedPoints.length > 0 && <div className="bridge-adjustment" data-test="bridge-points-result">
        <p>Moved guides {bridge.movedPoints.map((i) => i + 1).join(', ')} (green). Inspect the profile before Apply.</p>
        <button className="block" data-test="bridge-restore-points" disabled={adjusting || !ready} onClick={bridge.restorePoints}>Restore previous points</button>
      </div>}
      {bridge.report && bridge.bend < 1 && <p className="hint" data-test="bridge-bend-result">
        Reduced bend: {(bridge.bend * 100).toFixed(1)}% of sampled bow retained. Inspect the changed profile and attachment slope before Apply.
      </p>}
      <NumberField
        label="Bridge width"
        testId="bridge-width"
        value={bridge.width}
        min={0.001}
        step={0.5}
        kind="length"
        disabled={adjusting}
        onCommit={bridge.setWidth}
        hint="Approximate width along each rim. At least one full mesh edge on either side of the attachment is included; the actual width follows the existing edge spacing."
      />
      <div className="moderow">
        <button data-test="bridge-undo-point" disabled={adjusting || !bridge.points.length} onClick={bridge.undoPoint}>Undo point</button>
        <button data-test="bridge-clear" disabled={adjusting || !bridge.points.length} onClick={bridge.clear}>Clear points</button>
      </div>
      <button className="block" data-test="bridge-preview" disabled={!ready || adjusting || count !== bridge.total} onClick={bridge.check}>
        Preview bridge
      </button>
      {bridge.report && <p className="hint" data-test="bridge-report">
        Span {len.fmt(bridge.report.span)}, {bridge.report.triangles} new triangles.
        Rim snap up to {len.fmt(bridge.report.snap)}.
      </p>}
      <button className="primary block" data-test="bridge-apply" disabled={!ready || adjusting || !bridge.report} onClick={bridge.apply}>
        Apply bridge
      </button>
    </div>
  )
}

// SPDX-License-Identifier: AGPL-3.0-only
// Whenever the tool is reading a file or grinding on the mesh, it says so in
// the middle of the viewport — where the user is already looking, rather than
// in the corner of the status strip.
//
// It subscribes to the stores itself instead of taking props, so a progress
// line arriving every few hundred milliseconds re-renders this card and
// nothing else.

import { useStore } from '../state/store'
import { useDeviation } from '../state/deviationStore'
import { useThickness } from '../state/thicknessStore'

export function BusyOverlay() {
  const loading = useStore((s) => s.busy)
  const fitting = useStore(
    (s) => s.draft?.status === 'fitting' || s.elements.some((e) => e.status === 'fitting'),
  )
  const statusText = useStore((s) => s.statusText)
  const nominalBusy = useDeviation((s) => s.nominalBusy)
  const aligning = useDeviation((s) => s.alignStatus === 'running')
  const mapping = useDeviation((s) => s.mapStatus === 'running')
  const measuring = useThickness((s) => s.status === 'running')
  // The split picker owns the whole stage while it is up, and runs the
  // alignment it was opened for from its own buttons.
  const picking = useDeviation((s) => s.picking)

  const busy = loading || nominalBusy || fitting || aligning || mapping || measuring
  if (!busy || picking) return null

  const label =
    loading || nominalBusy
      ? 'LOADING…'
      : fitting
        ? 'FITTING…'
        : aligning
          ? 'ALIGNING…'
          : 'MEASURING…'

  // A fit is short and reports nothing, so the strip still holds the
  // instruction that started it — repeating that under the spinner would read
  // as if the tool were still waiting to be told what to do.
  const note = fitting && !loading && !nominalBusy ? null : statusText

  return (
    <div className="busyoverlay" data-test="fitting-chip">
      <div className="busycard">
        <span className="spinner big" />
        <b>{label}</b>
        {note && <span className="busynote">{note}</span>}
      </div>
    </div>
  )
}

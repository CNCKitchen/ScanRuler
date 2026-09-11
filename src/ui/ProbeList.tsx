// SPDX-License-Identifier: AGPL-3.0-only
// The pinned readings of a map, panel-side: the count, one row per pin and
// the way to take them off again. The deviation and thickness panels share
// it — only how a value is written differs, and the caller says that. The
// switch that puts away the pins on the far side of the part sits here too,
// with the list it thins.

import { usePrefs } from '../state/prefsStore'
import type { Probe } from '../state/probes'
import { InfoDot } from './InfoDot'

export function ProbeList({
  probes,
  format,
  onRemove,
  onClear,
  className = 'group',
  rowTestId,
  hint = 'Hover the part for a live reading; click to pin one where you need a number.',
}: {
  probes: Probe[]
  /** How a pinned value is written — signed for a deviation, plain for a
   *  wall thickness. */
  format: (value: number) => string
  onRemove: (id: number) => void
  onClear: () => void
  /** The group's class, so a panel that fades its sections can fade this one
   *  with them. */
  className?: string
  rowTestId: string
  hint?: string
}) {
  const hidePinsBehind = usePrefs((s) => s.hidePinsBehind)
  const setHidePinsBehind = usePrefs((s) => s.setHidePinsBehind)
  return (
    <div className={className}>
      <div className="g-label">
        <span>Pinned readings</span>
        <b>{probes.length}</b>
      </div>
      {probes.length === 0 ? (
        <p className="hint">{hint}</p>
      ) : (
        <>
          <label className="checkrow">
            <input
              type="checkbox"
              data-test="toggle-pins-behind"
              checked={hidePinsBehind}
              onChange={(e) => setHidePinsBehind(e.target.checked)}
            />
            <span>Hide pins behind the part</span>
            <InfoDot title="Hide pins behind the part">
              <p>
                With this on, a pin whose spot is on the far side of the part, or behind a feature
                of it, is put away until the part turns to show it — so a part carrying many pins
                shows only the numbers of the face you are looking at.
              </p>
              <p>Off, every pin shows through the part, wherever its spot is.</p>
            </InfoDot>
          </label>
          {probes.map((p, i) => (
            <div className="kv" data-test={rowTestId} key={p.id}>
              <span className="probeno">{i + 1}</span>
              <span className="name">{p.point.map((v) => v.toFixed(1)).join(', ')}</span>
              <b>{format(p.value)}</b>
              <button className="x" title="Remove" onClick={() => onRemove(p.id)}>
                ✕
              </button>
            </div>
          ))}
          <button className="block" onClick={onClear}>
            Clear pins
          </button>
        </>
      )}
    </div>
  )
}

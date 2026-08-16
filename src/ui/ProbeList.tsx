// SPDX-License-Identifier: AGPL-3.0-only
// The pinned readings of a map, panel-side: the count, one row per pin and
// the way to take them off again. The deviation and thickness panels share
// it — only how a value is written differs, and the caller says that.

import type { Probe } from '../state/probes'

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

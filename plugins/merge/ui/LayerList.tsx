// SPDX-License-Identifier: AGPL-3.0-only
// The layers as a list: each pass opened beside the scan, in the colour it
// is drawn in, with its size, the units it is read in, its eye, its lock and
// its remove key — and under it what its last alignment came to: a low
// overlap or a result from no one's guess as a warning, never a tick.

import { useLength } from '../../../src/app/useUnits'
import { unitsLabel } from '../../../src/core/meshUnits'
import { Icon } from '../../../src/ui/icons'
import { useMerge, type LayerRow, type LayerUnits } from '../state/mergeStore'

import { count } from './mergeFormat'

const UNITS: LayerUnits[] = ['mm', 'in'] // units-ok: MeshUnits ids, shown through unitsLabel

export function LayerList({
  busy,
  onSet,
  onRemove,
}: {
  busy: boolean
  onSet: (id: string, patch: Partial<Pick<LayerRow, 'color' | 'visible' | 'units' | 'locked'>>) => void
  onRemove: (id: string) => void
}) {
  const layers = useMerge((s) => s.layers)
  const selected = useMerge((s) => s.selected)
  const select = useMerge((s) => s.select)
  if (layers.length === 0) return null
  return (
    <div className="group" data-test="merge-layers">
      <div className="g-label">
        <span>Layers</span>
        <b>{layers.length}</b>
      </div>
      {layers.map((l) => (
        <LayerItem key={l.id} layer={l} selected={l.id === selected} busy={busy} onSelect={() => select(l.id)} onSet={(p) => onSet(l.id, p)} onRemove={() => onRemove(l.id)} />
      ))}
      <p className="hint">Click a layer to work on it. Hidden layers stay out of the merge.</p>
    </div>
  )
}

function LayerItem({
  layer: l,
  selected,
  busy,
  onSelect,
  onSet,
  onRemove,
}: {
  layer: LayerRow
  selected: boolean
  busy: boolean
  onSelect: () => void
  onSet: (patch: Partial<Pick<LayerRow, 'color' | 'visible' | 'units' | 'locked'>>) => void
  onRemove: () => void
}) {
  const len = useLength()
  const r = l.last
  return (
    <>
      <div
        className={'kv merge-layer' + (selected ? ' sel' : '') + (l.visible ? '' : ' ghost')}
        data-test={`merge-layer-${l.id}`}
        title={`${l.name} — ${count(l.vertexCount)} ${l.isCloud ? 'points' : 'vertices'}`}
        onClick={onSelect}
      >
        <label className="merge-swatch" title="The layer's colour" onClick={(e) => e.stopPropagation()}>
          <span className="dot" style={{ background: l.color }} />
          <input type="color" value={l.color} data-test={`merge-layer-color-${l.id}`} onChange={(e) => onSet({ color: e.target.value })} />
        </label>
        <span className="name">{l.name}</span>
        <select
          className="merge-units"
          value={l.units}
          disabled={busy}
          data-test={`merge-layer-units-${l.id}`}
          title="The units the file is in — read again and scaled about its centre when changed"
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onSet({ units: e.target.value as LayerUnits })}
        >
          {UNITS.map((u) => (
            <option key={u} value={u}>
              {unitsLabel(u)}
            </option>
          ))}
        </select>
        <button
          className={'x eye' + (l.visible ? '' : ' off')}
          data-test={`merge-layer-visible-${l.id}`}
          disabled={busy}
          title={l.visible ? `Hide ${l.name} — and leave it out of the merge` : `Show ${l.name}`}
          onClick={(e) => {
            e.stopPropagation()
            onSet({ visible: !l.visible })
          }}
        >
          <Icon name={l.visible ? 'eye' : 'eyeOff'} size={14} />
        </button>
        <button
          className={'x merge-lock' + (l.locked ? ' on' : '')}
          data-test={`merge-layer-lock-${l.id}`}
          aria-pressed={l.locked}
          title={l.locked ? `Unlock ${l.name}` : `Lock ${l.name} where it is — moves and alignments pass it by`}
          onClick={(e) => {
            e.stopPropagation()
            onSet({ locked: !l.locked })
          }}
        >
          <Icon name="fix" size={14} />
        </button>
        <button
          className="x"
          data-test={`merge-layer-remove-${l.id}`}
          disabled={busy}
          title={`Remove ${l.name}`}
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
        >
          <Icon name="bin" size={14} />
        </button>
      </div>
      {r &&
        (r.lowOverlap ? (
          <p className="warnnote" data-test={`merge-layer-warn-${l.id}`}>
            ⚠ Low overlap — only {(r.matched * 100).toFixed(1)} % found its target, RMS {len.fmt(r.rms, 3)}. Check the result.
          </p>
        ) : !r.confident ? (
          <p className="warnnote" data-test={`merge-layer-warn-${l.id}`}>
            ⚠ Not confident — RMS {len.fmt(r.rms, 3)}, {(r.matched * 100).toFixed(1)} % on its target. It may sit in a wrong pose: place it and refine again.
          </p>
        ) : (
          <p className="hint merge-ok" data-test={`merge-layer-ok-${l.id}`}>
            ✓ Aligned — RMS {len.fmt(r.rms, 3)}, {(r.matched * 100).toFixed(1)} % on its target.
          </p>
        ))}
    </>
  )
}

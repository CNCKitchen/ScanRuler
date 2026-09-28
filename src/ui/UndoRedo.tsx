// SPDX-License-Identifier: AGPL-3.0-only
import { useRef } from 'react'
import { activeLocalHistory, historyBlocked, historyWatchers, redo, undo, useHistory } from '../state/historyStore'
import { useStore } from '../state/store'
import { useFlat } from '../state/flatStore'
import { useDeviation } from '../state/deviationStore'
import { useThickness } from '../state/thicknessStore'
import { Icon } from './icons'

export function UndoRedo() {
  const history = useHistory()
  // Re-evaluate availability as computations and editors start or finish.
  useStore((s) => !!(s.busy || s.draft || s.dimDraft || s.alignDraft || s.sectionDraft))
  useFlat((s) => !!(s.imageBusy || s.draft || s.dimDraft || s.tool.kind !== 'none'))
  useDeviation((s) => s.alignStatus === 'running' || s.mapStatus === 'running' || s.nominalBusy)
  useThickness((s) => s.status === 'running')
  // What the plugins' histories hang on — the same hooks on every render,
  // those registered before the keys were first drawn.
  const watchers = useRef(historyWatchers()).current
  for (const watch of watchers) watch()
  const local = activeLocalHistory()
  const blocked = historyBlocked()
  const canUndo = !blocked && (local ? local.canUndo() : history.past.length > 0)
  const canRedo = !blocked && (local ? local.canRedo() : history.future.length > 0)
  const hint = blocked ? 'Finish the active operation or close its editor first' : null
  return <div className="undokeys" data-test="undo-keys">
    <button className="ghost" data-test="sketch-undo" aria-label="Undo" disabled={!canUndo}
      title={hint ?? `Undo${local ? ` ${local.label}` : history.past.at(-1) ? `: ${history.past.at(-1)!.label}` : ''} — Ctrl+Z`}
      onClick={() => void undo()}><Icon name="undo" size={16} /></button>
    <button className="ghost" data-test="redo" aria-label="Redo" disabled={!canRedo}
      title={hint ?? `Redo${local ? ` ${local.label}` : history.future.at(-1) ? `: ${history.future.at(-1)!.label}` : ''} — Ctrl+Y / Ctrl+Shift+Z`}
      onClick={() => void redo()}><Icon name="redo" size={16} /></button>
  </div>
}

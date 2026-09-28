// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react'
import type { RecoveryStatus } from '../app/useRecovery'
import { useStore } from '../state/store'

export function RecoveryBar({ recovery }: { recovery: RecoveryStatus }) {
  const [selected, setSelected] = useState('')
  const busy = useStore((s) => s.busy)
  if (!recovery.available.length) return null
  const id = recovery.available.some((item) => item.id === selected) ? selected : recovery.available[0].id
  return <aside className="recovery-bar" data-test="recovery-bar" aria-label="Local project recovery">
    <span>A local checkpoint is available.</span>
    <select aria-label="Checkpoint" value={id} onChange={(event) => setSelected(event.target.value)}>
      {recovery.available.map((item) => <option key={item.id} value={item.id}>
        {item.name} — {new Date(item.savedAt).toLocaleString()}
      </option>)}
    </select>
    <button data-test="restore-checkpoint" disabled={busy || recovery.working} onClick={() => void recovery.restore(id)}>Restore</button>
    <button data-test="discard-checkpoint" disabled={busy || recovery.working} onClick={() => void recovery.discard(id)}>Discard checkpoint</button>
  </aside>
}

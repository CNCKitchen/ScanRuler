// SPDX-License-Identifier: AGPL-3.0-only
// Which workspaces cannot be used right now, and why. A point cloud has no
// triangles, so the workspaces whose tools need them are off: the top bar
// greys their tabs with the reason, one that is open when a cloud loads gives
// way to 3D Measure, and the split view — which draws the scan as a mesh —
// is closed.

import { refusesOpsOnCloud } from '../core/capabilities'
import { plugins } from '../plugins/registry'
import { useDeviation } from '../state/deviationStore'
import { useShell } from '../state/shellStore'
import { useStore } from '../state/store'

/** Why the workspace cannot be used now, or null. The app's own are judged
 *  by the worker ops they reach; a plugin's says for itself
 *  (WorkspaceTab.unavailable). */
export function workspaceUnavailable(id: string): string | null {
  if (id === 'thickness') return refusesOpsOnCloud(['thickness'], useStore.getState().scanIsCloud)
  return plugins().find((p) => p.workspace?.id === id)?.workspace?.unavailable?.() ?? null
}

/** Keep the open workspace one that is available, and the split view off a
 *  cloud, as the scan and the workspace change. Returns the stop. */
export function watchWorkspaceAvailability(): () => void {
  const settle = () => {
    const open = useShell.getState().workspace
    if (open !== 'elements' && workspaceUnavailable(open) !== null) useShell.getState().setWorkspace('elements')
    if (useStore.getState().scanIsCloud) {
      const d = useDeviation.getState()
      if (d.split || d.picking) useDeviation.setState({ split: false, picking: false, pendingScan: null })
    }
  }
  settle()
  const stops = [useStore.subscribe(settle), useShell.subscribe(settle)]
  return () => stops.forEach((stop) => stop())
}

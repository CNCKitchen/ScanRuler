// SPDX-License-Identifier: AGPL-3.0-only
// What turns a point-cloud scan into a mesh, offered by a plugin (Mesh Tools)
// to the whole app: the scan's card and any workspace can show "Mesh this
// cloud" without knowing who does it. One at a time; the last registered
// stands.
import { useSyncExternalStore } from 'react'

export interface CloudMesher {
  /** The action's name as a button shows it. */
  label: string
  /** The command that does the same, for an agent (e.g. mesh.mesh_cloud). */
  command: string
  /** Mesh the scan in place, as one undo step. True when it was. */
  mesh(): Promise<boolean>
}

let current: CloudMesher | null = null
const listeners = new Set<() => void>()

export function registerCloudMesher(m: CloudMesher): void {
  current = m
  for (const l of listeners) l()
}

export function cloudMesher(): CloudMesher | null {
  return current
}

/** The mesher of the moment, for a component. */
export function useCloudMesher(): CloudMesher | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => current,
  )
}

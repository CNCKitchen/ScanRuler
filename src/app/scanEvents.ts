// SPDX-License-Identifier: AGPL-3.0-only
// What happens to the scan, told to whoever keeps something read off it:
// the plugins, which hold regions of vertices, results measured on it and
// copies made of it that the app itself knows nothing of. The app does its
// own part of each first, then tells the listeners, in the order they came.

/** The scan a session has just loaded, for sizing what goes with it. */
export interface LoadedScan {
  positions: Float32Array
  indices: Uint32Array
  /** The part's size, as the scene measures it. */
  modelSize: number
}

export interface ScanListener {
  /** A scan was loaded — or taken away, with null: a different part, so
   *  everything read off the last one goes. */
  loaded?(scan: LoadedScan | null): void
  /** Another version of the same scan was put in place under the session —
   *  an edit of it, or the one before an edit. What was read off the old
   *  vertices goes; everything measured on the part stays. */
  swapped?(): void
  /** The version put in place numbers its vertices differently: `remap`
   *  carries a list of the old numbers onto the new, leaving out those that
   *  went. */
  remapped?(remap: (ids: Uint32Array) => Uint32Array): void
  /** Measure again what was measured on the version that went, now the
   *  elements stand on the new one. */
  remeasure?(): Promise<void>
}

const listeners: ScanListener[] = []

/** Listen for what happens to the scan; the returned function stops it. */
export function onScan(listener: ScanListener): () => void {
  listeners.push(listener)
  return () => {
    const i = listeners.indexOf(listener)
    if (i >= 0) listeners.splice(i, 1)
  }
}

export const scanLoaded = (scan: LoadedScan | null): void => {
  for (const l of [...listeners]) l.loaded?.(scan)
}

export const scanSwapped = (): void => {
  for (const l of [...listeners]) l.swapped?.()
}

export const scanRemapped = (remap: (ids: Uint32Array) => Uint32Array): void => {
  for (const l of [...listeners]) l.remapped?.(remap)
}

/** One after the other: a remeasure may start work in a worker another
 *  listener's is queued behind anyway. */
export async function scanRemeasure(): Promise<void> {
  for (const l of [...listeners]) await l.remeasure?.()
}

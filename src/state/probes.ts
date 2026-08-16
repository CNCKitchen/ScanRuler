// SPDX-License-Identifier: AGPL-3.0-only
// A pinned reading and the actions that manage it, shared by the deviation
// and thickness stores: a probe means the same thing whichever map it was
// read off, so both carry the identical slice rather than two copies of it.

import type { Vec3 } from '../core/types'

/** A reading pinned to a spot on the part. */
export interface Probe {
  id: number
  point: Vec3
  value: number
}

export interface ProbeSlice {
  /** Readings pinned to the part by clicking it. */
  probes: Probe[]
  nextProbeId: number
  addProbe: (point: Vec3, value: number) => void
  removeProbe: (id: number) => void
  clearProbes: () => void
}

/** The slice itself, given the store's `set`. The signature asks only for
 *  what the slice touches, so either store's `set` fits — their states both
 *  extend ProbeSlice. */
export function probeSlice(
  set: (fn: (s: ProbeSlice) => Partial<ProbeSlice>) => void,
): ProbeSlice {
  return {
    probes: [],
    nextProbeId: 1,

    addProbe: (point, value) =>
      set((s) => ({
        probes: [...s.probes, { id: s.nextProbeId, point, value }],
        nextProbeId: s.nextProbeId + 1,
      })),

    removeProbe: (id) => set((s) => ({ probes: s.probes.filter((p) => p.id !== id) })),

    clearProbes: () => set(() => ({ probes: [] })),
  }
}

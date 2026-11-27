// SPDX-License-Identifier: AGPL-3.0-only
// The pre-deformed model shown beside the scan (see core/deviation/preDeform.ts
// and CompareView). Kept apart from the deviation store, which a project saves
// whole: this holds a mesh, which is worked out again on asking and is no
// part of anyone's work.
import type { BufferGeometry } from 'three'
import { create } from 'zustand'

/** What the preview was worked out from, to tell when it no longer matches the
 *  panel: the alignment (by identity, a new fit being a new object) and the
 *  settings the motion is made of. */
export interface PreviewBasis {
  align: unknown
  scale: number
  maxEdge: number
  range: number
  maxDistance: number
  /** The smoothing length the field was made with, mm. */
  smoothing: number
}

export interface PreviewInfo {
  triangles: number
  /** The cut stopped at the triangle limit, leaving edges up to `longest`. */
  capped: boolean
  longest: number
  /** Vertices with no scan near them, left where they were. */
  unmoved: number
  /** The most any vertex moved, mm. */
  maxMove: number
}

interface PreviewState {
  /** The second viewport is up. */
  open: boolean
  status: 'idle' | 'running' | 'ready'
  /** The mesh in the second viewport; owned here, disposed when replaced. */
  geometry: BufferGeometry | null
  info: PreviewInfo | null
  basis: PreviewBasis | null
  /** Show the viewport; whoever calls works the mesh out. */
  show: () => void
  hide: () => void
  begin: () => void
  /** The mesh has landed; the one before goes. */
  resolve: (geometry: BufferGeometry, info: PreviewInfo, basis: PreviewBasis) => void
  /** The work refused or was overtaken: the mesh in hand, if any, stays. */
  fail: () => void
  /** Closed and let go of: a new reference or scan has made it about
   *  something else. */
  clear: () => void
}

export const usePreDeformPreview = create<PreviewState>((set, get) => ({
  open: false,
  status: 'idle',
  geometry: null,
  info: null,
  basis: null,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
  begin: () => set({ status: 'running' }),
  resolve: (geometry, info, basis) => {
    // The viewport swaps to the new mesh on its next render; the old one is
    // let go of after, not under it.
    const old = get().geometry
    set({ geometry, info, basis, status: 'ready' })
    if (old) setTimeout(() => old.dispose(), 0)
  },
  fail: () => set((s) => ({ status: s.geometry ? 'ready' : 'idle' })),
  clear: () => {
    const old = get().geometry
    set({ open: false, status: 'idle', geometry: null, info: null, basis: null })
    if (old) setTimeout(() => old.dispose(), 0)
  },
}))

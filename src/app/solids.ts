// SPDX-License-Identifier: AGPL-3.0-only
// Solids one part of the app lends the others: closed bodies, in the frame
// the scan is shown in, handed over as triangles when asked for. A workspace
// that models bodies offers them here under a source id of its own, and
// offers them again whenever they change; a workspace that works on meshes
// lists them and asks for one — to take it out of the scan, say — without
// either knowing the other. The app itself offers none.

import { create } from 'zustand'

/** A solid as a closed triangle mesh. Its vertices may come once per face of
 *  the body, as a CAD mesh's do — weld them before relying on it being
 *  closed by index. */
export interface SolidMesh {
  positions: Float32Array
  indices: Uint32Array
}

export interface OfferedSolid {
  /** Unique among every source's solids, and the same for one solid while
   *  it is offered. */
  key: string
  /** The solid's name, as the workspace that made it shows it. */
  name: string
  /** Who offers it, as a person reads it: the workspace's name. */
  source: string
  /** Changes whenever the solid's shape does: a mesh asked for before is
   *  of an older shape. */
  version: number
  /** The solid as triangles, to a chord tolerance in millimetres, in the
   *  scan's frame — every alignment applied to the scan applied to it. */
  mesh(chord: number): Promise<SolidMesh>
}

interface SolidsState {
  bySource: Readonly<Record<string, readonly OfferedSolid[]>>
}

export const useSolids = create<SolidsState>(() => ({ bySource: {} }))

/** Offer `solids` under `source`, in place of what it offered before; an
 *  empty list takes its offer away. */
export function offerSolids(source: string, solids: readonly OfferedSolid[]): void {
  useSolids.setState((s) => {
    const bySource = { ...s.bySource }
    if (solids.length === 0) delete bySource[source]
    else bySource[source] = solids
    return { bySource }
  })
}

/** Every solid on offer, source by source. */
export function offeredSolids(bySource: SolidsState['bySource'] = useSolids.getState().bySource): OfferedSolid[] {
  return Object.values(bySource).flat()
}

// SPDX-License-Identifier: AGPL-3.0-only
import type { FittedElementKind, FitOutput, FitSettings, MeshGraph } from '../types'
import { fitCylinderFromSeed, fitCylinderOnSelection } from '../fit/fitCylinderFromSeed'
import { fitPlaneFromSeed, fitPlaneOnSelection } from '../fit/fitPlaneFromSeed'
import { fitSphereFromSeed, fitSphereOnSelection } from '../fit/fitSphereFromSeed'

/** The extension seam for measurement primitives: each fitted element type
 *  provides a click-seeded auto-fit and inherits the whole pick → fit →
 *  display pipeline. Cones, slots and circles slot in here the same way.
 *  Points and lines never reach the worker — they are picked or constructed
 *  on the main thread. */
export type FitFromSeed = (graph: MeshGraph, seeds: number[], settings: FitSettings) => FitOutput

/** The same fit on a surface the user marked by hand, which skips the search
 *  for the right region entirely. */
export type FitOnSelection = (
  graph: MeshGraph,
  selection: Uint32Array,
  settings: FitSettings,
) => FitOutput

const FITTERS: Record<FittedElementKind, FitFromSeed> = {
  sphere: fitSphereFromSeed,
  cylinder: fitCylinderFromSeed,
  plane: fitPlaneFromSeed,
}

const SELECTION_FITTERS: Record<FittedElementKind, FitOnSelection> = {
  sphere: fitSphereOnSelection,
  cylinder: fitCylinderOnSelection,
  plane: fitPlaneOnSelection,
}

export function getFitter(id: string): FitFromSeed {
  const fit = Object.prototype.hasOwnProperty.call(FITTERS, id)
    ? FITTERS[id as FittedElementKind]
    : undefined
  if (!fit) throw new Error(`Unknown element type "${id}".`)
  return fit
}

export function getSelectionFitter(id: string): FitOnSelection {
  const fit = Object.prototype.hasOwnProperty.call(SELECTION_FITTERS, id)
    ? SELECTION_FITTERS[id as FittedElementKind]
    : undefined
  if (!fit) throw new Error(`Element type "${id}" cannot be fitted to a marked surface.`)
  return fit
}

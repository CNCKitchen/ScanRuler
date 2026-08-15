// SPDX-License-Identifier: AGPL-3.0-only
import type { FittedElementKind, FitOutput, FitSettings, MeshGraph } from '../types'
import { fitCylinderFromSeed } from '../fit/fitCylinderFromSeed'
import { fitPlaneFromSeed } from '../fit/fitPlaneFromSeed'
import { fitSphereFromSeed } from '../fit/fitSphereFromSeed'

/** The extension seam for measurement primitives: each fitted element type
 *  provides a click-seeded auto-fit and inherits the whole pick → fit →
 *  display pipeline. Cones, slots and circles slot in here the same way.
 *  Points and lines never reach the worker — they are picked or constructed
 *  on the main thread. */
export type FitFromSeed = (graph: MeshGraph, seeds: number[], settings: FitSettings) => FitOutput

const FITTERS: Record<FittedElementKind, FitFromSeed> = {
  sphere: fitSphereFromSeed,
  cylinder: fitCylinderFromSeed,
  plane: fitPlaneFromSeed,
}

export function getFitter(id: string): FitFromSeed {
  const fit = Object.prototype.hasOwnProperty.call(FITTERS, id)
    ? FITTERS[id as FittedElementKind]
    : undefined
  if (!fit) throw new Error(`Unknown element type "${id}".`)
  return fit
}

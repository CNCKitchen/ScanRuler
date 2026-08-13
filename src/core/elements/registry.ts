import type { FitSettings, MeshGraph, SphereFitOutput } from '../types'
import { fitSphereFromSeed } from '../fit/fitSphereFromSeed'

/** The extension seam for future measurement primitives: each element type
 *  provides a click-seeded auto-fit. Cylinders, planes, cones etc. register
 *  here and inherit the whole pick → fit → display pipeline. */
export interface ElementTypeDef {
  id: string
  label: string
  fitFromSeed: (graph: MeshGraph, seeds: number[], settings: FitSettings) => SphereFitOutput
}

export const ELEMENT_TYPES: readonly ElementTypeDef[] = [
  { id: 'sphere', label: 'Sphere', fitFromSeed: fitSphereFromSeed },
]

export function getElementType(id: string): ElementTypeDef {
  const def = ELEMENT_TYPES.find((t) => t.id === id)
  if (!def) throw new Error(`Unknown element type "${id}".`)
  return def
}

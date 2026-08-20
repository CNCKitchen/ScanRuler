// SPDX-License-Identifier: AGPL-3.0-only
import type { ElementKind } from '../types'

/** Everything the UI needs to know about an element type. Kept apart from the
 *  registry so the panel and the store don't drag the whole fitting
 *  pipeline — worker-side code — into the main bundle. */
export interface ElementKindInfo {
  id: ElementKind
  /** Title case, for buttons and element names. */
  label: string
  /** Lower case, for mid-sentence hints. */
  noun: string
}

export const ELEMENT_KINDS: readonly ElementKindInfo[] = [
  { id: 'point', label: 'Point', noun: 'point' },
  { id: 'line', label: 'Line', noun: 'line' },
  { id: 'plane', label: 'Plane', noun: 'plane' },
  { id: 'sphere', label: 'Sphere', noun: 'sphere' },
  { id: 'cylinder', label: 'Cylinder', noun: 'cylinder' },
  { id: 'cone', label: 'Cone', noun: 'cone' },
  { id: 'circle', label: 'Circle', noun: 'circle' },
]

export function elementKindInfo(id: ElementKind): ElementKindInfo {
  const info = ELEMENT_KINDS.find((k) => k.id === id)
  if (!info) throw new Error(`Unknown element type "${id}".`)
  return info
}

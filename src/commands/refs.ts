// SPDX-License-Identifier: AGPL-3.0-only
// How a command names things without a mouse: an element by its id or its
// name, a coordinate plane by its name, and a place on the scan by the `at`
// union — the click the panel would have taken.
//
// `at` is one of
//   { vertex: n }         a scan vertex, what a project file stores
//   { point: [x, y, z] }  the scan vertex nearest a point, in the frame the
//                         part is measured in now
//   { screen: [x, y] }    a pixel of the viewport, as on a screenshot
//   { candidate: n }      a feature from scan.candidates
// The last two are named here so the contract does not change when they
// arrive; until then they are refused as not implemented.

import { BASE_PLANES } from '../core/basePlanes'
import type { ScanSpot } from '../core/geometry/nearest'
import type { ElementKind } from '../core/types'
import { useStore, type Element } from '../state/store'
import { commandHost } from './host'
import { arr, int, num, obj, oneOf, str, vec3, type JsonSchema } from './schema'
import { CommandError } from './types'

// ---- Elements -----------------------------------------------------------------

export type ElementRef = number | string

export const elementRefSchema = (description: string): JsonSchema =>
  oneOf([int('The element’s id.', { minimum: 1 }), str('The element’s name, as the list shows it — "Sphere 1".', { minLength: 1 })], description)

/** The coordinate planes by name, for wherever a plane is asked for as a
 *  reference: "XY", "YZ", "ZX" (also "XZ"), with or without " plane". */
export function basePlaneId(name: string): number | null {
  const key = name.trim().toUpperCase().replace(/\s*PLANE$/, '')
  const canonical = key === 'XZ' ? 'ZX' : key
  return BASE_PLANES.find((p) => p.name.toUpperCase() === `${canonical} PLANE`)?.id ?? null
}

/** The element an id or a name stands for. Names are matched whole, case
 *  aside; a name two elements share is refused rather than guessed. */
export function findElement(ref: ElementRef): Element {
  const { elements } = useStore.getState()
  if (typeof ref === 'number') {
    const el = elements.find((e) => e.id === ref)
    if (!el) throw new CommandError('not_found', `There is no element ${ref}.`)
    return el
  }
  const want = ref.trim().toLowerCase()
  const hits = elements.filter((e) => e.name.trim().toLowerCase() === want)
  if (hits.length === 0) throw new CommandError('not_found', `There is no element named "${ref}".`)
  if (hits.length > 1) throw new CommandError('invalid_input', `${hits.length} elements are named "${ref}" — name it by its id.`)
  return hits[0]
}

/** The element, which must have geometry — a measurement needs one. */
export function measuredElement(ref: ElementRef, kinds?: readonly ElementKind[]): Element {
  const el = findElement(ref)
  if (!el.fit) throw new CommandError('invalid_state', `${el.name} has no geometry${el.message ? ` — ${el.message}` : ''}.`)
  if (kinds && !kinds.includes(el.kind)) {
    throw new CommandError('invalid_input', `${el.name} is a ${el.kind}; this takes a ${kinds.join(' or ')}.`)
  }
  return el
}

/** A plane reference: a plane element, or a coordinate plane by name — the
 *  id the store takes, negative for a coordinate plane. */
export function planeRef(ref: ElementRef): number {
  if (typeof ref === 'string') {
    const base = basePlaneId(ref)
    if (base !== null) return base
  }
  return measuredElement(ref, ['plane']).id
}

// ---- Places on the scan -----------------------------------------------------

export type Location =
  | { vertex: number }
  | { point: [number, number, number] }
  | { screen: [number, number] }
  | { candidate: number }

export const locationSchema = (description: string): JsonSchema =>
  oneOf(
    [
      obj({ vertex: int('A scan vertex, as a project file and session.state name it.', { minimum: 0 }) }, ['vertex']),
      obj({ point: vec3('A point in millimetres, in the frame the part is measured in now; the scan vertex nearest it is taken.') }, ['point']),
      obj({ screen: arr(num(), 'A pixel of the viewport, x right and y down from its top left, as on a view.render picture.', { minItems: 2, maxItems: 2 }) }, ['screen']),
      obj({ candidate: int('A feature from scan.candidates.', { minimum: 0 }) }, ['candidate']),
    ],
    description,
  )

/** Where on the scan a location lands: the vertex, its point and normal, and
 *  the triangle a click there would have handed a fit. */
export async function resolveLocation(at: Location): Promise<ScanSpot> {
  requireScan()
  if ('screen' in at) throw new CommandError('not_implemented', 'A location on the screen is not available yet — name a vertex or a point.')
  if ('candidate' in at) throw new CommandError('not_implemented', 'Feature candidates are not available yet — name a vertex or a point.')
  const client = commandHost().session.clientRef.current
  if (!client) throw new CommandError('unavailable', 'The mesh worker is not running.')
  try {
    return await client.nearest('vertex' in at ? { vertex: at.vertex } : { point: at.point })
  } catch (e) {
    throw new CommandError('invalid_input', e instanceof Error ? e.message : String(e))
  }
}

/** A refusal unless a scan is open. */
export function requireScan(): void {
  const s = useStore.getState()
  if (!s.fileName || s.vertexCount === 0) throw new CommandError('no_scan', 'No scan is open — open one with scan.open first.')
}

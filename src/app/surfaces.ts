// SPDX-License-Identifier: AGPL-3.0-only
// The scan surface each fitted element rests on, kept for whoever needs the
// points and not just the fit — a tolerance on a plane's surface (see
// core/tolerances). A fit result carries its region, the vertex indices it
// was measured on; the scene takes them to tint the part, and this keeps
// them so the coordinates can be read back off the viewport's own scan
// buffer — the buffer the elements were fitted in, and the one a datum
// alignment is baked into, so the frame comes for free.
//
// A version counter is bumped whenever a surface comes, goes or moves. The
// evaluations that read surfaces hang on it, so a fit that lands after its
// element was listed, or an alignment baked into the buffer after the
// elements moved, is read again rather than shown from the old frame.

import { create } from 'zustand'
import type { SurfaceSource } from '../core/dimensions'
import { dot, sub } from '../core/vec'
import { useStore } from '../state/store'
import type { SceneManager } from '../viewer/SceneManager'

const regions = new Map<number, Uint32Array>()
let sceneOf: () => SceneManager | null = () => null

interface SurfaceState {
  version: number
}

/** Bumped whenever a surface comes, goes or moves — subscribe to re-read. */
export const useSurfaces = create<SurfaceState>(() => ({ version: 0 }))

const bump = () => useSurfaces.setState((s) => ({ version: s.version + 1 }))

/** Where the coordinates are read from — the viewport's scene, reached
 *  through a getter so the viewport's own lifetime governs it. */
export function attachSurfaceScene(getScene: () => SceneManager | null): void {
  sceneOf = getScene
  bump()
}

/** A fit landed: this is the surface it rests on. */
export function rememberSurface(elementId: number, region: Uint32Array): void {
  regions.set(elementId, region)
  bump()
}

/** The element went, or stopped being fitted. */
export function forgetSurface(elementId: number): void {
  if (regions.delete(elementId)) bump()
}

/** The scan was replaced: every region indexed into it is void. */
export function forgetAllSurfaces(): void {
  regions.clear()
  bump()
}

/** The scan moved under the elements — the same vertices, new coordinates. */
export function surfacesMoved(): void {
  bump()
}

/** For tests and diagnostics: whether a surface is on record. */
export function hasSurface(elementId: number): boolean {
  return regions.has(elementId)
}

/** The points an element's fit rests on, packed x y z: its region, less the
 *  outliers the fit's cut-off left out — the same points its sigma and its
 *  form error were taken over, so a tolerance read off them agrees with the
 *  form error the element reports. Only a plane is ever asked; any other
 *  kind gets its whole region. Null for an element without a surface, or
 *  before the viewport is up. */
export const surfaceSource: SurfaceSource = (elementId) => {
  const region = regions.get(elementId)
  const positions = sceneOf()?.scanGeometry()?.getAttribute('position')?.array as
    | Float32Array
    | undefined
  if (!region || !positions) return null
  const { elements, settings } = useStore.getState()
  const el = elements.find((e) => e.id === elementId)
  // The cut-off was applied to the fit as measured; an element turned to a
  // reference direction afterwards still rests on the same points.
  const fit = el?.measured ?? el?.fit
  const cutoff =
    fit?.kind === 'plane' && settings.sigma > 0 && fit.sigma > 0 ? settings.sigma * fit.sigma : null
  const out = new Float32Array(region.length * 3)
  let n = 0
  for (const v of region) {
    const x = positions[v * 3]
    const y = positions[v * 3 + 1]
    const z = positions[v * 3 + 2]
    if (cutoff !== null && fit?.kind === 'plane') {
      const r = dot(sub([x, y, z], fit.center), fit.normal)
      if (Math.abs(r) > cutoff) continue
    }
    out[n++] = x
    out[n++] = y
    out[n++] = z
  }
  return n === out.length ? out : out.subarray(0, n)
}

// SPDX-License-Identifier: AGPL-3.0-only
// Clipping a whole subtree of the scene by the section view's plane — what
// the overlays drawn on the part and a layer's own content go through. See
// SceneManager.dressClipped and SceneLayer.clippingChanged.

import type * as THREE from 'three'

/** Clip every mesh and line under `root` by `planes`, or take the clip off
 *  with null. The list is held, not copied: a plane moved in place moves the
 *  clip. Cheap to repeat — a material already holding the list is passed by
 *  — so content rebuilt at will can simply be walked again. `visit` sees
 *  every object on the way, for what no plane clips. */
export function clipTree(root: THREE.Object3D, planes: THREE.Plane[] | null, visit?: (o: THREE.Object3D) => void): void {
  visit?.(root)
  const material = (root as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
  if (material) {
    for (const m of Array.isArray(material) ? material : [material]) {
      if (m.clippingPlanes === planes) continue
      m.clippingPlanes = planes
      m.needsUpdate = true
    }
  }
  for (const child of root.children) clipTree(child, planes, visit)
}

/** A material kept across rebuilds, taken back into the scene as it was first
 *  made: unclipped. The section view dresses only what is in the scene when it
 *  is looked at, and one closed while a material was put away leaves it
 *  holding a plane that no longer cuts. A rebuild that finds the view open
 *  dresses it again before the frame, and the material keeps the programs it
 *  has already compiled for either state. */
export function unclip<T extends THREE.Material>(material: T): T {
  if (material.clippingPlanes !== null) {
    material.clippingPlanes = null
    material.needsUpdate = true
  }
  return material
}

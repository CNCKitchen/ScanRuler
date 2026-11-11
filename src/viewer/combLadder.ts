// SPDX-License-Identifier: AGPL-3.0-only
// How a curvature comb is drawn, shared by the 2D sheet and the 3D view so a
// comb looks the same in both: how far apart its teeth are at a zoom, and
// the faint fill between the curve and the line through the tips.

import * as THREE from 'three'

const TOOTH_PX = 14

/** How far apart the teeth are drawn, mm, at a zoom: about fourteen screen
 *  pixels, on a ladder of powers of two — so the comb is drawn again only
 *  when the zoom steps onto another rung, and zooming in brings more teeth
 *  rather than spreading them apart. */
export function combSpacing(worldPerPixel: number): number {
  const want = TOOTH_PX * worldPerPixel
  if (!(want > 0) || !Number.isFinite(want)) return 1
  return 2 ** Math.round(Math.log2(want))
}

/** The fill's material, in the comb's colour: see-through, ahead of
 *  everything like the teeth, from either side of the section's plane. */
export function combFillMaterial(color: number | string): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: new THREE.Color(color),
    transparent: true,
    opacity: 0.16,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
}

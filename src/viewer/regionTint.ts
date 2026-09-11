// SPDX-License-Identifier: AGPL-3.0-only
// The sharp border of the element tints: the shader's half of a trick the
// compositor (regionColors) plays with a mask beside the vertex colours.
//
// Vertex colours are interpolated across every triangle, so a region painted
// into them fades out over the ring of triangles around its border instead of
// stopping at it. The compositor therefore keeps a second byte per vertex: one
// where the vertex wears a colour of its own — an element's tint, the preview,
// a measured map — and zero on bare scan. That mask is interpolated too, and
// thresholded just under one the way the marking's is: only a triangle tinted
// at all three corners keeps its vertex colours, everything else is painted
// the bare surface colour, and the border falls on triangle edges. A measured
// map sets the mask everywhere, which is what keeps a map smooth.
//
// Only the main viewport draws the scan with vertex colours, so unlike the
// marking's tint and the back-face flag this has one material to patch; the
// pieces live here beside their siblings all the same.

import * as THREE from 'three'
import { setSurfaceColor, type ViewTheme } from './viewThemes'

/** The bare surface colour, as the shader paints it where a triangle is not
 *  tinted through. In the working colour space, like the vertex colours it
 *  stands in for — see the note on setSurfaceColor in viewThemes. */
export interface SurfaceUniform {
  value: THREE.Color
}

export function surfaceUniform(theme: ViewTheme): SurfaceUniform {
  const uniform = { value: new THREE.Color() }
  setSurfaceColor(uniform.value, theme)
  return uniform
}

/** Vertex-shader declarations, and the line that carries the mask across. */
export const TINT_GLSL_VERTEX = 'attribute float tint;\nvarying float vTint;\n'
export const TINT_GLSL_VERTEX_BODY = 'vTint = tint;'

/** Fragment-shader declarations, and the line that cuts the border. Spliced
 *  in right after the vertex colour lands, ahead of the marking and the
 *  back-face flag, both of which paint over it. */
export const TINT_GLSL_PREAMBLE = 'uniform vec3 uSurfaceColor;\nvarying float vTint;\n'
export const TINT_GLSL_FRAGMENT = 'if ( vTint < 0.998 ) diffuseColor.rgb = uSurfaceColor;'

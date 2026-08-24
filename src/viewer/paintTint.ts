// SPDX-License-Identifier: AGPL-3.0-only
// The hand-marking's tint, as one piece of shader shared by every view that
// draws the scan.
//
// The marking rides in a per-vertex mask rather than in the vertex colours,
// because vertex colours are interpolated across every triangle and an
// interpolated marking has a blurred border. The mask is interpolated too, but
// thresholded just under one: only where all three corners are marked does the
// whole face clear the bar, so exactly the triangles the gesture took light up,
// edge to edge. (In a partly marked triangle the region above the threshold is
// a sliver along the marked edge, thinner than a pixel.)
//
// Two views draw that mask — the main viewport, and the scan half of the
// split-screen picker, where the surface a picked-point fit is measured on is
// chosen. They are two renderers, so each owns its own colour uniform; what is
// shared here is the GLSL and the wiring.

import * as THREE from 'three'

/** The colour marked surface wears. A uniform, so a recolour costs nothing per
 *  vertex. Written in the working colour space, like the vertex colours it is
 *  composited with — see the note on setSurfaceColor in viewThemes. */
export interface PaintUniform {
  value: THREE.Color
}

export function paintUniform(): PaintUniform {
  return { value: new THREE.Color(1, 1, 1) }
}

/** Bytes straight into the working space, the same path the vertex colours
 *  take — through setHex the two would land a gamma apart. */
export function setPaintUniform(uniform: PaintUniform, rgb: [number, number, number]): void {
  uniform.value.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.LinearSRGBColorSpace)
}

/** Vertex-shader declarations, and the line that carries the mask across. */
export const PAINT_GLSL_VERTEX = 'attribute float paint;\nvarying float vPaint;\n'
export const PAINT_GLSL_VERTEX_BODY = 'vPaint = paint;'

/** Fragment-shader declarations, and the line that lays the tint down. */
export const PAINT_GLSL_PREAMBLE = 'uniform vec3 uPaintColor;\nvarying float vPaint;\n'
export const PAINT_GLSL_FRAGMENT = 'if ( vPaint > 0.998 ) diffuseColor.rgb = uPaintColor;'

/** Patch a material that wants the marking and nothing else. The main
 *  viewport's scan material folds the same GLSL into a larger patch of its
 *  own — see SceneManager.patchScanShader. */
export function patchPaintTint(material: THREE.Material, uniform: PaintUniform): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uPaintColor = uniform
    shader.vertexShader =
      PAINT_GLSL_VERTEX +
      shader.vertexShader.replace(
        '#include <color_vertex>',
        `#include <color_vertex>\n\t${PAINT_GLSL_VERTEX_BODY}`,
      )
    shader.fragmentShader =
      PAINT_GLSL_PREAMBLE +
      shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>\n\t${PAINT_GLSL_FRAGMENT}`,
      )
  }
}

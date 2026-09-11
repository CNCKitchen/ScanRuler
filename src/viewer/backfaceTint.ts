// SPDX-License-Identifier: AGPL-3.0-only
// Back-face flagging, as one piece of shader shared by every view that draws a
// part.
//
// The switch on the view bar is a statement about the *models*, not about
// a viewport: "show me which way the surface faces". So it has to reach every
// half that shows a model — the scan in the main viewport and the reference
// standing beside it in the split view — or the same part answers the question
// differently on the two sides of the screen, which is worse than not asking.
//
// A flag and a colour rather than two materials, so switching it is a uniform
// write instead of a shader recompile mid-session. Each view owns its own pair
// of uniform objects because three.js keeps GPU state per renderer and the two
// halves are two renderers; what is shared here is the GLSL and the wiring.

import * as THREE from 'three'

export interface BackfaceUniforms {
  uBackfaceTint: { value: number }
  uBackfaceColor: { value: THREE.Color }
}

export function backfaceUniforms(color: number): BackfaceUniforms {
  return {
    uBackfaceTint: { value: 0 },
    uBackfaceColor: { value: new THREE.Color(color) },
  }
}

/** Declarations for a fragment shader that wants the flag. */
export const BACKFACE_GLSL_PREAMBLE = 'uniform float uBackfaceTint;\nuniform vec3 uBackfaceColor;\n'

/** The line that does it, to be spliced in after `<color_fragment>`. Last word
 *  over anything else written into diffuseColor: a tinted back face is a
 *  warning, not a surface. */
export const BACKFACE_GLSL_FRAGMENT =
  'if ( uBackfaceTint > 0.5 && ! gl_FrontFacing ) diffuseColor.rgb = uBackfaceColor;'

/**
 * Patch a material that needs the flag and nothing else.
 *
 * Flagged in the shader rather than by drawing the mesh a second time with the
 * faces flipped, because the second pass would have to be the same million
 * triangles again — and because a front-face-only pass would take the inside
 * of the part out of reach of the raycaster, which is what picking, hovering
 * and the brush all run on.
 */
export function patchBackfaceTint(material: THREE.Material, uniforms: BackfaceUniforms): void {
  material.onBeforeCompile = (shader) => spliceBackfaceTint(shader, uniforms)
}

/** The same amendment, for a material whose onBeforeCompile has other
 *  splices to make as well. The include line it hangs off stays in place, so
 *  the order of the splices does not matter. */
export function spliceBackfaceTint(
  shader: { uniforms: { [name: string]: THREE.IUniform }; fragmentShader: string },
  uniforms: BackfaceUniforms,
): void {
  shader.uniforms.uBackfaceTint = uniforms.uBackfaceTint
  shader.uniforms.uBackfaceColor = uniforms.uBackfaceColor
  shader.fragmentShader =
    BACKFACE_GLSL_PREAMBLE +
    shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>\n\t${BACKFACE_GLSL_FRAGMENT}`,
    )
}

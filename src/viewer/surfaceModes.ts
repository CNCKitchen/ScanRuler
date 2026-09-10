// SPDX-License-Identifier: AGPL-3.0-only
// The two ways of seeing a part other than plain shaded — see-through, and
// with its mesh drawn on — as the pieces every viewport that shows a part
// shares. Like the back-face flag, both are statements about the *models*:
// the scan and the reference in the main viewport and the reference standing
// beside it in the split view all take them, or the same part would answer
// differently on the two sides of the screen.
//
// See-through is a material setting. The mesh is a piece of shader, and that
// is the whole point of it: the triangle edges of a million-triangle scan
// drawn as lines would be a second index buffer three times the size of the
// first and a second pass over the whole part every frame, and at any
// distance where the triangles are smaller than a pixel, a solid block of
// line colour. Here each fragment works out how far it is from the nearest
// edge of its own triangle and darkens itself there, in the same pass that
// shades it: no second draw call, no line buffers, one byte per vertex of
// extra geometry (see core/geometry/wireSlots.ts), and lines that fade out
// on their own where the triangles get too small to show them.

import * as THREE from 'three'

/** How see-through a part is in the see-through mode. Light enough that two
 *  layers of scan still leave what is behind them readable, dense enough
 *  that the surface is still a surface. */
export const SEE_THROUGH_OPACITY = 0.4

/**
 * Dress a material solid or see-through. A see-through surface writes no
 * depth: it would otherwise punch holes in everything behind it, which reads
 * as missing scan data rather than as a translucent part. Flipping
 * `transparent` changes the program, so the material is marked for a rebuild
 * — a one-time cost per state, cached by three.js after that.
 */
export function setSurfaceOpacity(material: THREE.MeshStandardMaterial, opacity: number): void {
  const seeThrough = opacity < 1
  material.transparent = seeThrough
  material.opacity = opacity
  material.depthWrite = !seeThrough
  material.needsUpdate = true
}

export interface WireUniforms {
  uWire: { value: number }
}

/** A flag rather than two materials: switching the mesh on is a uniform
 *  write, not a shader recompile mid-session. */
export function wireUniforms(): WireUniforms {
  return { uWire: { value: 0 } }
}

/** Vertex side: the corner slot comes in as one byte and goes out as its
 *  one-hot form in two vec4s, which the rasteriser then interpolates into the
 *  fragment's barycentric weights. */
const WIRE_GLSL_VERTEX = 'attribute float wireSlot;\nvarying vec4 vWireA;\nvarying vec4 vWireB;\n'
const WIRE_GLSL_VERTEX_BODY = `vWireA = step( abs( vec4( wireSlot ) - vec4( 0.0, 1.0, 2.0, 3.0 ) ), vec4( 0.5 ) );
	vWireB = step( abs( vec4( wireSlot ) - vec4( 4.0, 5.0, 6.0, 7.0 ) ), vec4( 0.5 ) );`

/**
 * Fragment side. A corner's weight falls to zero along the edge opposite it,
 * and the screen-space derivative of that weight says how many pixels one
 * unit of it spans — so weight over derivative is the distance to that edge
 * in pixels, and the least of them over the three corners is the distance to
 * the nearest edge. The slots this triangle does not use are zero everywhere
 * with no derivative at all, and are pushed out of the running.
 *
 * The same derivative gives the triangle's size on screen. Where it is down
 * to a couple of pixels the lines would cover the face, so they fade out
 * instead: from a distance a dense scan stays a shaded part, and the mesh
 * comes up as you zoom in.
 */
const WIRE_GLSL_PREAMBLE = `uniform float uWire;
varying vec4 vWireA;
varying vec4 vWireB;
vec4 wirePixels( vec4 w, vec4 d ) {
	return mix( vec4( 1.0e4 ), w / max( d, 1.0e-7 ), step( 1.0e-7, d ) );
}
float wireEdge() {
	vec4 dA = fwidth( vWireA );
	vec4 dB = fwidth( vWireB );
	vec4 pA = wirePixels( vWireA, dA );
	vec4 pB = wirePixels( vWireB, dB );
	float px = min( min( min( pA.x, pA.y ), min( pA.z, pA.w ) ), min( min( pB.x, pB.y ), min( pB.z, pB.w ) ) );
	float line = 1.0 - smoothstep( 0.0, 0.7, px );
	float density = max( max( max( dA.x, dA.y ), max( dA.z, dA.w ) ), max( max( dB.x, dB.y ), max( dB.z, dB.w ) ) );
	return line * ( 1.0 - smoothstep( 0.3, 0.7, density ) );
}
`

/** Spliced in after the lit colour is written: the edge darkens whatever the
 *  surface came out as — bare part, element tint, deviation map — so it reads
 *  in both colour schemes and over every map. In the see-through mode the
 *  edges stay denser than the faces, which is what keeps a translucent part
 *  looking like a mesh rather than fog. */
const WIRE_GLSL_FRAGMENT = `if ( uWire > 0.5 ) {
		float wireEdge = wireEdge();
		gl_FragColor.rgb *= mix( 1.0, 0.12, wireEdge );
		gl_FragColor.a = max( gl_FragColor.a, wireEdge * 0.85 );
	}`

/** The shader object three.js hands to onBeforeCompile, as much of it as the
 *  splices need. */
export interface ShaderPatch {
  uniforms: { [name: string]: THREE.IUniform }
  vertexShader: string
  fragmentShader: string
}

/** Fold the mesh mode into a shader that other splices may already have
 *  amended. The include lines it hangs off are left in place, so the order
 *  of the splices does not matter. */
export function spliceWireframe(shader: ShaderPatch, uniforms: WireUniforms): void {
  shader.uniforms.uWire = uniforms.uWire
  shader.vertexShader =
    WIRE_GLSL_VERTEX +
    shader.vertexShader.replace(
      '#include <color_vertex>',
      `#include <color_vertex>\n\t${WIRE_GLSL_VERTEX_BODY}`,
    )
  shader.fragmentShader =
    WIRE_GLSL_PREAMBLE +
    shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      `#include <opaque_fragment>\n\t${WIRE_GLSL_FRAGMENT}`,
    )
}

/** Patch a material that wants the mesh mode and nothing else. */
export function patchWireframe(material: THREE.Material, uniforms: WireUniforms): void {
  material.onBeforeCompile = (shader) => spliceWireframe(shader, uniforms)
}

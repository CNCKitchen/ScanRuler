// SPDX-License-Identifier: AGPL-3.0-only
// A point cloud on screen: every point a small round splat facing the
// camera, shaded from its normal, sized from the cloud's spacing so the
// splats close up into a surface at any zoom.
//
// The geometry carries the attributes the scan's mesh carries under the same
// names — the colour the compositor writes, the region tint mask, the
// marking, the part's own colours, the deflection — so the deviation map,
// the tints and the marking land on a cloud by the same writes that put them
// on a mesh. The shader reads them with the same GLSL the mesh's patch
// splices in (see scanShader.ts).

import * as THREE from 'three'
import { DEFLECT_GLSL_VERTEX, DEFLECT_GLSL_VERTEX_BODY, type DeflectionUniform } from './deflection'
import { PAINT_GLSL_FRAGMENT, PAINT_GLSL_PREAMBLE, PAINT_GLSL_VERTEX, PAINT_GLSL_VERTEX_BODY, type PaintUniform } from './paintTint'
import { TINT_GLSL_FRAGMENT, TINT_GLSL_PREAMBLE, TINT_GLSL_VERTEX, TINT_GLSL_VERTEX_BODY, type SurfaceOwnUniform, type SurfaceUniform } from './regionTint'

/** A splat's diameter in spacings. Neighbours sit about one spacing apart;
 *  a disc just that wide leaves the gap between diagonal neighbours open
 *  and the surface reads as a screen door. */
export const SPLAT_SCALE = 1.6

/** Pixel bounds on a splat: never under one pixel, so a far-off cloud
 *  still shows, and never a blob that hides its neighbours up close. */
const MIN_PX = 1
const MAX_PX = 48

/** The scene's uniform objects the cloud reads alongside the mesh — shared,
 *  so a recolour or a deflection step reaches both with one write. */
export interface CloudUniforms {
  paintColor: PaintUniform
  surfaceColor: SurfaceUniform
  surfaceOwn: SurfaceOwnUniform
  deflect: DeflectionUniform
}

// The size works with either projection: projectionMatrix[1][1] is pixels
// per unit over half the height once multiplied by it, and w is the depth
// for a perspective camera and 1 for an orthographic one.
const VERTEX = `
${TINT_GLSL_VERTEX}${PAINT_GLSL_VERTEX}${DEFLECT_GLSL_VERTEX}
uniform float uSplat;
uniform float uHalfHeight;
varying vec3 vNormal;
varying vec3 vColor;
#include <common>
#include <clipping_planes_pars_vertex>
void main() {
  vec3 transformed = position;
  ${DEFLECT_GLSL_VERTEX_BODY}
  vColor = vec3( 1.0 );
#ifdef USE_COLOR
  vColor = color;
#endif
  ${TINT_GLSL_VERTEX_BODY}
  ${PAINT_GLSL_VERTEX_BODY}
  vNormal = normalize( normalMatrix * normal );
  vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = clamp( uSplat * projectionMatrix[1][1] * uHalfHeight / gl_Position.w, ${MIN_PX.toFixed(1)}, ${MAX_PX.toFixed(1)} );
  #include <clipping_planes_vertex>
}
`

// Lit from the eye, both sides alike — a scan's normals are not to be
// trusted to face out, and the mesh is drawn double-sided for the same
// reason.
const FRAGMENT = `
${TINT_GLSL_PREAMBLE}${PAINT_GLSL_PREAMBLE}
uniform float uOpacity;
varying vec3 vNormal;
varying vec3 vColor;
#include <common>
#include <clipping_planes_pars_fragment>
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  if ( dot( c, c ) > 1.0 ) discard;
  #include <clipping_planes_fragment>
  vec4 diffuseColor = vec4( vColor, uOpacity );
  ${TINT_GLSL_FRAGMENT}
  ${PAINT_GLSL_FRAGMENT}
  float facing = abs( normalize( vNormal ).z );
  gl_FragColor = vec4( diffuseColor.rgb * ( 0.35 + 0.65 * facing ), diffuseColor.a );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

export class CloudLayer {
  readonly object: THREE.Points

  constructor(positions: Float32Array, normals: Float32Array, spacing: number, shared?: CloudUniforms) {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      vertexColors: true,
      clipping: true,
      uniforms: {
        uSplat: { value: spacing * SPLAT_SCALE },
        uHalfHeight: { value: 1 },
        uOpacity: { value: 1 },
        uPaintColor: shared?.paintColor ?? { value: new THREE.Color(1, 1, 1) },
        uSurfaceColor: shared?.surfaceColor ?? { value: new THREE.Color(0.7, 0.7, 0.7) },
        uSurfaceOwn: shared?.surfaceOwn ?? { value: 0 },
        uDeflect: shared?.deflect ?? { value: 0 },
      },
    })
    const points = new THREE.Points(geometry, material)
    // THREE.Points tests every point against the ray — a million of them
    // under the cursor each frame. Picking a cloud goes through its own
    // index instead (Task 10 hooks it here); until then it is not hit.
    points.raycast = () => {}
    const size = new THREE.Vector2()
    points.onBeforeRender = (renderer) => {
      material.uniforms.uHalfHeight.value = renderer.getDrawingBufferSize(size).y / 2
    }
    this.object = points
  }

  setAttribute(name: string, attr: THREE.BufferAttribute): void {
    this.object.geometry.setAttribute(name, attr)
  }

  /** Another version of the same cloud, read with a spacing of its own. */
  setSpacing(spacing: number): void {
    ;(this.object.material as THREE.ShaderMaterial).uniforms.uSplat.value = spacing * SPLAT_SCALE
  }

  setClipPlanes(planes: THREE.Plane[]): void {
    const material = this.object.material as THREE.ShaderMaterial
    const next = planes.length > 0 ? planes : null
    if (material.clippingPlanes === next) return
    material.clippingPlanes = next
    material.needsUpdate = true
  }

  setOpacity(o: number): void {
    const material = this.object.material as THREE.ShaderMaterial
    const seeThrough = o < 1
    material.uniforms.uOpacity.value = o
    if (material.transparent === seeThrough) return
    material.transparent = seeThrough
    material.depthWrite = !seeThrough
    material.needsUpdate = true
  }

  dispose(): void {
    this.object.geometry.dispose()
    ;(this.object.material as THREE.Material).dispose()
  }
}

// SPDX-License-Identifier: AGPL-3.0-only
// The deviation map played as motion — the shader's half of it. The part is
// moved on the GPU: each vertex carries its offset off the ideal surface (see
// core/deviation/deflection.ts) as an attribute, written once per map, and a
// single uniform says how much of it to add this frame. A frame of the loop
// costs one uniform write however large the scan, where moving the position
// buffer itself would mean re-uploading it sixty times a second.
//
// Only the drawn surface moves. The position buffer, and so the raycaster and
// everything that runs on it — picking, hovering, the pins and their occlusion
// — stays on the scan as measured. The shading normals stay too: they carry
// the scan's own finish, and taking them off an exaggerated surface would
// exaggerate the scanner's noise along with the part's deformation.

/** One trip from the ideal shape to the exaggerated one and back, in ms. */
export const DEFLECTION_PERIOD_MS = 2000

/** How much of each vertex's offset is added to where it is drawn: the factor
 *  the loop is at, less the one the scan is already at as measured. */
export interface DeflectionUniform {
  value: number
}

/** Vertex-shader declarations, and the line that moves the vertex. Spliced in
 *  after `<begin_vertex>`, ahead of everything that reads the position. A
 *  geometry without the attribute must be drawn with the uniform at zero:
 *  a missing attribute reads whatever constant WebGL holds for its slot,
 *  which is not always zero. */
export const DEFLECT_GLSL_VERTEX = 'attribute vec3 deflect;\nuniform float uDeflect;\n'
export const DEFLECT_GLSL_VERTEX_BODY = 'transformed += deflect * uDeflect;'

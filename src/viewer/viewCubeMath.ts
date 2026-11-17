// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The geometry behind the view cube (viewCube.ts, ui/ViewCube.tsx): which of
 * its 26 clickable regions a point on it falls in, the pose each region turns
 * the camera to, the quarter turns of its arrows, and the roll of the view —
 * how far the part is turned on screen from standing upright.
 *
 * Kept apart from the drawing so it runs without a canvas. Poses are written
 * as animateLook takes them: `dir` from the target to the camera, `up` up
 * the screen. The cube sits in world axes, Z up, faces named as the standard
 * views name them: front is −Y, right is +X, top is +Z.
 */
import * as THREE from 'three'

/** A region of the cube by the direction it faces, each component −1, 0 or
 *  1: one non-zero for a face, two for an edge, three for a corner. */
export type CubeRegion = readonly [number, number, number]

/** How deep the edge and corner bands reach in from a face's rim, as a share
 *  of half its side: wide enough to hit at the cube's size on screen, narrow
 *  enough that the face's own middle stays the bigger target. */
export const CUBE_BAND = 0.3

/** A key for a region, to compare two of them or light every patch of one. */
export function regionKey(r: CubeRegion): string {
  return `${r[0]},${r[1]},${r[2]}`
}

/** The region under a point on the surface of the cube of half-side 1
 *  centred on the origin: each coordinate that reaches into the band along
 *  the rim counts its side, so a point near one rim of a face is on that
 *  edge and a point near two is on the corner. */
export function regionAt(p: THREE.Vector3): CubeRegion {
  const side = (v: number) => (Math.abs(v) >= 1 - CUBE_BAND ? Math.sign(v) : 0)
  return [side(p.x), side(p.y), side(p.z)]
}

/** The screen-up that counts as upright looking from `dir`: world Z laid on
 *  the screen, as the standard views stand the part — or, looking straight
 *  down or up Z, the way the top and bottom views take it. */
export function uprightUp(dir: THREE.Vector3): THREE.Vector3 {
  const d = dir.clone().normalize()
  const z = new THREE.Vector3(0, 0, 1)
  const up = z.addScaledVector(d, -d.z)
  if (up.lengthSq() > 1e-8) return up.normalize()
  // As STANDARD_VIEWS has them: +Y up from the top, the part turned over
  // about X from the bottom.
  return new THREE.Vector3(0, d.z > 0 ? 1 : -1, 0)
}

/** The pose a click on a region turns to: looking at the cube square onto a
 *  face, along an edge's diagonal or down a corner's, standing upright. */
export function regionView(r: CubeRegion): { dir: THREE.Vector3; up: THREE.Vector3 } {
  const dir = new THREE.Vector3(r[0], r[1], r[2]).normalize()
  return { dir, up: uprightUp(dir) }
}

/** The face looked at square-on from `dir`, or null when the view is off
 *  every face — the orbit arrows step from a face to the next, so they are
 *  offered only on one. */
export function faceOn(dir: THREE.Vector3): CubeRegion | null {
  const d = dir.clone().normalize()
  const comps = [d.x, d.y, d.z]
  for (let i = 0; i < 3; i++) {
    if (Math.abs(comps[i]) > 0.9995) {
      const r: [number, number, number] = [0, 0, 0]
      r[i] = Math.sign(comps[i])
      return r
    }
  }
  return null
}

/** How far the part is turned on screen from standing upright, in radians,
 *  counter-clockwise positive, (−π, π]. */
export function screenRoll(dir: THREE.Vector3, up: THREE.Vector3): number {
  const d = dir.clone().normalize()
  const upright = uprightUp(d)
  // Only the part of `up` across the line of sight is seen.
  const u = up.clone().addScaledVector(d, -up.dot(d)).normalize()
  // The camera's up turned counter-clockwise (about `dir`, toward the
  // viewer) turns the part clockwise on screen: hence the minus.
  return -Math.atan2(new THREE.Vector3().crossVectors(upright, u).dot(d), upright.dot(u))
}

/** The screen-up that shows the part turned `roll` radians counter-clockwise
 *  from upright, looking from `dir`. */
export function upForRoll(dir: THREE.Vector3, roll: number): THREE.Vector3 {
  const d = dir.clone().normalize()
  return uprightUp(d).applyAxisAngle(d, -roll)
}

/** `up` turned so the part turns `by` radians counter-clockwise on screen. */
export function rollUp(dir: THREE.Vector3, up: THREE.Vector3, by: number): THREE.Vector3 {
  return up.clone().applyAxisAngle(dir.clone().normalize(), -by).normalize()
}

/** An angle wrapped into (−π, π]. */
export function wrapAngle(a: number): number {
  const t = Math.PI * 2
  const w = a - t * Math.floor((a + Math.PI) / t)
  return w === -Math.PI ? Math.PI : w
}

export type OrbitStep = 'left' | 'right' | 'up' | 'down'

/** A quarter turn by an orbit arrow: the view swings to look at the side the
 *  arrow sits by — the left arrow brings the face on the left round to the
 *  front — whatever way the view is rolled, so the turn is always the one
 *  the arrow shows. */
export function orbitStep(dir: THREE.Vector3, up: THREE.Vector3, step: OrbitStep): { dir: THREE.Vector3; up: THREE.Vector3 } {
  const d = dir.clone().normalize()
  const u = up.clone().normalize()
  const right = new THREE.Vector3().crossVectors(u, d).normalize()
  switch (step) {
    case 'left':
      return { dir: right.negate(), up: u }
    case 'right':
      return { dir: right, up: u }
    case 'up':
      return { dir: u, up: d.negate() }
    case 'down':
      return { dir: u.negate(), up: d }
  }
}

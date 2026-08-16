// SPDX-License-Identifier: AGPL-3.0-only
// Measured elements as topology rather than as loose surfaces: a plane becomes
// a bounded planar face, a cylinder and a sphere become closed solids.
//
// Why it matters. A RECTANGULAR_TRIMMED_SURFACE in a geometric set is legal
// STEP and every kernel can read it, but it arrives in CAD as construction
// geometry — something to look at. A face with real edges is a face: it can be
// sketched on, offset, extruded and referenced. A closed shell is a body: it
// can be cut with, measured against and put in an assembly. That is what a
// measured cylinder is for once it leaves the metrology tool, so that is what
// this writes.
//
// Orientation is the whole game in a B-rep, and the rule behind every .T./.F.
// below is the same one: walking a face's boundary with the face normal up,
// the face lies to the left. For a solid the face normals point out of the
// material, which fixes each loop's direction in turn — and every edge ends up
// used exactly twice, once each way, which is what makes the shell manifold.

import type { CylinderFit, PlaneFit, SphereFit, Vec3 } from './types'
import { addScaled, cross, normalize, sub } from './vec'
import { orthoBasis } from './fit/linalg'
import { direction, esc, num, placement, point, StepWriter } from './stepWriter'

/** No dimension of an exported body may be zero: a degenerate face is not a
 *  face, and an importer is entitled to reject one. */
const MIN = 1e-6

/** One oriented use of an edge in a loop. */
interface EdgeUse {
  edge: number
  forward: boolean
}

function edgeLoop(w: StepWriter, uses: EdgeUse[]): number {
  const oriented = uses.map((u) =>
    w.add(`ORIENTED_EDGE('',*,*,#${u.edge},${u.forward ? '.T.' : '.F.'})`),
  )
  return w.add(`EDGE_LOOP('',(${oriented.map((o) => `#${o}`).join(',')}))`)
}

function vertex(w: StepWriter, p: Vec3): number {
  return w.add(`VERTEX_POINT('',#${point(w, p)})`)
}

/** A straight edge between two vertices that have already been written. */
function lineEdge(w: StepWriter, a: Vec3, va: number, b: Vec3, vb: number): number {
  const dir = normalize(sub(b, a)) ?? [1, 0, 0]
  const p = point(w, a)
  const d = direction(w, dir)
  const v = w.add(`VECTOR('',#${d},1.)`)
  const line = w.add(`LINE('',#${p},#${v})`)
  return w.add(`EDGE_CURVE('',#${va},#${vb},#${line},.T.)`)
}

/**
 * A whole circle as one closed edge: start and end are the same vertex, on the
 * seam where the reference direction crosses it.
 *
 * This is what a full circular rim is in every B-rep a CAD kernel writes — the
 * alternative, splitting it in half to give the loop two distinct vertices,
 * invents an edge that is not on the part.
 */
function circleEdge(w: StepWriter, centre: Vec3, axis: Vec3, ref: Vec3, r: number): number {
  const pl = placement(w, centre, axis, ref)
  const circle = w.add(`CIRCLE('',#${pl},${num(Math.max(r, MIN))})`)
  const v = vertex(w, addScaled(centre, ref, r))
  return w.add(`EDGE_CURVE('',#${v},#${v},#${circle},.T.)`)
}

function face(w: StepWriter, name: string, surface: number, bounds: number[]): number {
  return w.add(
    `ADVANCED_FACE('${esc(name)}',(${bounds.map((b) => `#${b}`).join(',')}),#${surface},.T.)`,
  )
}

/**
 * A measured plane as a bounded planar face, in an open shell of its own.
 *
 * The rectangle is the measured patch — its own centre, its own two in-plane
 * axes, its own extents — carried over exactly. Only the second axis is
 * re-derived, as normal × u, so that the four corners always run
 * counter-clockwise about the normal however the fit happened to orient its
 * basis: the loop direction is what tells CAD which way the face faces.
 */
export function writePlaneShell(w: StepWriter, name: string, fit: PlaneFit): number {
  const n = normalize(fit.normal) ?? [0, 0, 1]
  const u = normalize(fit.basisU) ?? orthoBasis(n)[0]
  const v = normalize(cross(n, u)) ?? orthoBasis(n)[1]
  const eu = Math.max(fit.extentU, MIN)
  const ev = Math.max(fit.extentV, MIN)

  const corners: Vec3[] = [
    addScaled(addScaled(fit.center, u, -eu), v, -ev),
    addScaled(addScaled(fit.center, u, eu), v, -ev),
    addScaled(addScaled(fit.center, u, eu), v, ev),
    addScaled(addScaled(fit.center, u, -eu), v, ev),
  ]
  const vertices = corners.map((c) => vertex(w, c))
  const edges = corners.map((c, i) =>
    lineEdge(w, c, vertices[i], corners[(i + 1) % 4], vertices[(i + 1) % 4]),
  )

  const surf = w.add(`PLANE('',#${placement(w, fit.center, n, u)})`)
  const loop = edgeLoop(
    w,
    edges.map((edge) => ({ edge, forward: true })),
  )
  const bound = w.add(`FACE_OUTER_BOUND('',#${loop},.T.)`)
  const f = face(w, name, surf, [bound])
  const shell = w.add(`OPEN_SHELL('',(#${f}))`)
  return w.add(`SHELL_BASED_SURFACE_MODEL('${esc(name)}',(#${shell}))`)
}

/**
 * A measured cylinder as a solid: the wall it was fitted to, closed off at
 * both ends by flat lids.
 *
 * Three faces meet at two rims. The wall's normal points away from the axis,
 * so its lower rim is walked with the parametrisation and its upper one
 * against it; each lid then takes the same rim back the other way, which is
 * exactly the twice-and-oppositely rule a closed shell is checked against.
 */
export function writeCylinderSolid(w: StepWriter, name: string, fit: CylinderFit): number {
  const axis = normalize(fit.axis) ?? [0, 0, 1]
  const ref = orthoBasis(axis)[0]
  const r = Math.max(fit.radius, MIN)
  const half = Math.max(fit.length, MIN) / 2
  const bottom = addScaled(fit.center, axis, -half)
  const top = addScaled(fit.center, axis, half)
  const down: Vec3 = [-axis[0], -axis[1], -axis[2]]

  const bottomRim = circleEdge(w, bottom, axis, ref, r)
  const topRim = circleEdge(w, top, axis, ref, r)

  const wall = w.add(`CYLINDRICAL_SURFACE('',#${placement(w, bottom, axis, ref)},${num(r)})`)
  const wallFace = face(w, name, wall, [
    w.add(`FACE_OUTER_BOUND('',#${edgeLoop(w, [{ edge: bottomRim, forward: true }])},.T.)`),
    w.add(`FACE_BOUND('',#${edgeLoop(w, [{ edge: topRim, forward: false }])},.T.)`),
  ])

  // Each lid faces out of the solid, so the bottom one is built on a plane
  // whose normal already points away from the body.
  const bottomPlane = w.add(`PLANE('',#${placement(w, bottom, down, ref)})`)
  const bottomFace = face(w, name, bottomPlane, [
    w.add(`FACE_OUTER_BOUND('',#${edgeLoop(w, [{ edge: bottomRim, forward: false }])},.T.)`),
  ])
  const topPlane = w.add(`PLANE('',#${placement(w, top, axis, ref)})`)
  const topFace = face(w, name, topPlane, [
    w.add(`FACE_OUTER_BOUND('',#${edgeLoop(w, [{ edge: topRim, forward: true }])},.T.)`),
  ])

  const shell = w.add(`CLOSED_SHELL('',(#${wallFace},#${bottomFace},#${topFace}))`)
  return w.add(`MANIFOLD_SOLID_BREP('${esc(name)}',#${shell})`)
}

/**
 * A measured sphere as a solid ball: two hemispheres meeting at an equator.
 *
 * Splitting it at the equator rather than along a meridian is what keeps this
 * simple. A meridian seam would put both poles on the boundary, where a
 * spherical surface's parametrisation collapses, and those degenerate edges
 * are the classic way a sphere fails to import. Bounded by the equator alone,
 * each face keeps its pole in its own interior, where the collapse is ordinary
 * and every kernel handles it — and which half of the surface is meant is
 * settled, as always, by which way the rim is walked.
 */
export function writeSphereSolid(w: StepWriter, name: string, fit: SphereFit): number {
  const axis: Vec3 = [0, 0, 1]
  const ref: Vec3 = [1, 0, 0]
  const r = Math.max(fit.radius, MIN)

  const equator = circleEdge(w, fit.center, axis, ref, r)
  const surf = w.add(`SPHERICAL_SURFACE('',#${placement(w, fit.center, axis, ref)},${num(r)})`)

  const upper = face(w, name, surf, [
    w.add(`FACE_OUTER_BOUND('',#${edgeLoop(w, [{ edge: equator, forward: true }])},.T.)`),
  ])
  const lower = face(w, name, surf, [
    w.add(`FACE_OUTER_BOUND('',#${edgeLoop(w, [{ edge: equator, forward: false }])},.T.)`),
  ])

  const shell = w.add(`CLOSED_SHELL('',(#${upper},#${lower}))`)
  return w.add(`MANIFOLD_SOLID_BREP('${esc(name)}',#${shell})`)
}

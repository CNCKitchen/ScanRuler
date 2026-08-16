// SPDX-License-Identifier: AGPL-3.0-only
// Wall thickness, measured on the part alone — no reference model, nothing to
// align. Two ways of asking the question, which is the way inspection software
// asks it too:
//
//   Ray    — fire a ray straight into the material along the inward normal and
//            see how far it travels before it comes out the far side. Exact
//            wherever the two faces of a wall are parallel, a little long where
//            they are not. An opening angle spreads a cone of rays around the
//            normal and takes the shortest, which finds the narrow way across a
//            chamfer or a tapered rib.
//   Sphere — put a sphere halfway across what the ray crossed and grow it until
//            it touches, then take its diameter. It cannot read longer than the
//            ray and usually reads shorter, because it is not tied to the
//            ray's direction: on a wedge it finds the wall square across, and
//            at the edge of a block it finds the block rather than the long
//            diagonal the normal points down. One extra query per point.
//
// Either way a hit only counts as the other side of a wall if the surface
// there faces back at the ray. Without that test a ray leaving through a rim
// or grazing along a rib reports the length of the part as its thickness.

import * as THREE from 'three'
import { MeshBVH, SAH } from 'three-mesh-bvh'
import { fieldPercentiles, fieldStats, niceCeil, niceFloor, type FieldStats } from '../field/stats'
import { BLUE_CAP_RGB, RED_CAP_RGB, type FieldScale } from '../field/colormap'

/** Ray down the normal, or the sphere inscribed across what it crossed. */
export type ThicknessMethod = 'ray' | 'sphere'

/** Cone half-angle offered in the UI, and GOM's default for the same
 *  parameter. Wide enough to find the short way across a chamfer or a draft
 *  angle, narrow enough that the ray still has to cross the same wall. */
export const DEFAULT_CONE_ANGLE_DEG = 30

/** How far a far surface may be from facing the ray and still count as the
 *  other side of the wall. GOM's default for the same parameter. */
export const DEFAULT_NORMAL_DEVIATION_DEG = 60

export interface ThicknessOptions {
  method: ThicknessMethod
  /** Extra rays spread through the cone. 0 measures along the normal alone,
   *  which is fast and right wherever the two faces of a wall are parallel. */
  coneRays: number
  /** Half-angle of that cone, in radians. */
  coneAngle: number
  /** How far the surface a ray lands on may be from facing that ray, in
   *  radians, or null to accept whatever it hits first. */
  maxNormalDeviation: number | null
  /** Nothing thicker than this is measured: past it the point is left
   *  unmeasured rather than reported, and the search stops there instead of
   *  running the length of the part. */
  maxThickness: number
  /** Rays ignore anything nearer than this, so one never scores a hit on the
   *  triangle it started from, or on a coincident duplicate of it. It is also
   *  the thinnest wall the measurement can report. */
  epsilon: number
}

/**
 * A BVH over the scan itself, for the ray casts and closest-point queries
 * above.
 *
 * `indices` is reordered in place and taken over by the returned tree — the
 * scan's index buffer has no other reader in the worker, and copying it would
 * cost another 12 MB on a million-triangle part.
 */
export function buildSolidIndex(positions: Float32Array, indices: Uint32Array): MeshBVH {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setIndex(new THREE.BufferAttribute(indices, 1))
  return new MeshBVH(geometry, { strategy: SAH, maxLeafTris: 8 })
}

/**
 * Wall thickness at every scan vertex, in model units.
 *
 * Vertices with nothing behind them within `maxThickness` — the rim of an open
 * scan, a surface with no back to it, a wall thicker than the search allows —
 * come back NaN, and are left as bare material on the map rather than being
 * drawn as a measurement.
 *
 * Both sides of every triangle are tested. A scan is not reliably wound, and a
 * far wall whose winding disagrees with the near one would otherwise be
 * invisible to the ray that is trying to find it.
 */
export function computeThickness(
  bvh: MeshBVH,
  positions: Float32Array,
  normals: Float32Array,
  options: ThicknessOptions,
  onProgress?: (fraction: number) => void,
): Float32Array {
  const { method, coneRays, coneAngle, maxThickness, epsilon } = options
  // Compared as |cos|: the winding of the far surface is not to be trusted, so
  // only how squarely it faces the ray counts, not which way round it is.
  const facing =
    options.maxNormalDeviation === null ? -1 : Math.cos(Math.min(Math.PI / 2, options.maxNormalDeviation))
  const count = positions.length / 3
  const out = new Float32Array(count)
  const ray = new THREE.Ray()
  const centre = new THREE.Vector3()
  const target = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 }
  const chunk = Math.max(1, Math.floor(count / 50))

  // The cone is the same shape at every vertex; only its axis moves, so its
  // trigonometry is worth computing once. The rays spiral out from the centre
  // rather than sitting on the rim — a wedge is crossed most narrowly at some
  // angle part of the way out, and a single ring would step over it.
  const GOLDEN = Math.PI * (3 - Math.sqrt(5))
  const cosTheta = new Float64Array(coneRays)
  const sinTheta = new Float64Array(coneRays)
  const cosPhi = new Float64Array(coneRays)
  const sinPhi = new Float64Array(coneRays)
  for (let k = 0; k < coneRays; k++) {
    const theta = coneAngle * Math.sqrt((k + 0.5) / coneRays)
    const phi = (k + 1) * GOLDEN
    cosTheta[k] = Math.cos(theta)
    sinTheta[k] = Math.sin(theta)
    cosPhi[k] = Math.cos(phi)
    sinPhi[k] = Math.sin(phi)
  }

  for (let v = 0; v < count; v++) {
    const px = positions[v * 3]
    const py = positions[v * 3 + 1]
    const pz = positions[v * 3 + 2]
    // Into the material: the surface normal points out of it.
    const dx = -normals[v * 3]
    const dy = -normals[v * 3 + 1]
    const dz = -normals[v * 3 + 2]

    ray.origin.set(px, py, pz)
    ray.direction.set(dx, dy, dz)
    let best = shoot(bvh, ray, epsilon, maxThickness, facing)

    if (method === 'sphere') {
      // The ray gives the sphere somewhere to start: the largest sphere
      // touching here can be no bigger than the wall the normal crosses.
      out[v] = best === Infinity ? NaN : inscribedDiameter(bvh, px, py, pz, dx, dy, dz, best, centre, target)
    } else {
      if (coneRays > 0 && best > epsilon) {
        // Any two directions perpendicular to the axis will do; building the
        // first from the axis's own smallest component keeps the cross product
        // well away from degenerate. This is fit/linalg's orthoBasis unrolled
        // onto scalars — deliberately, this loop runs per vertex.
        const ax = Math.abs(dx)
        const ay = Math.abs(dy)
        const az = Math.abs(dz)
        const hx = ax <= ay && ax <= az ? 1 : 0
        const hy = ay < ax && ay <= az ? 1 : 0
        const hz = hx || hy ? 0 : 1
        let ux = dy * hz - dz * hy
        let uy = dz * hx - dx * hz
        let uz = dx * hy - dy * hx
        const ul = Math.hypot(ux, uy, uz)
        if (ul > 1e-12) {
          ux /= ul; uy /= ul; uz /= ul
          const wx = dy * uz - dz * uy
          const wy = dz * ux - dx * uz
          const wz = dx * uy - dy * ux
          for (let k = 0; k < coneRays; k++) {
            const su = sinTheta[k] * cosPhi[k]
            const sw = sinTheta[k] * sinPhi[k]
            ray.direction.set(
              dx * cosTheta[k] + ux * su + wx * sw,
              dy * cosTheta[k] + uy * su + wy * sw,
              dz * cosTheta[k] + uz * su + wz * sw,
            )
            // Nothing longer than the best so far can win, so the search
            // shrinks as it goes.
            const d = shoot(bvh, ray, epsilon, Math.min(maxThickness, best), facing)
            if (d < best) best = d
          }
        }
      }
      out[v] = best === Infinity ? NaN : best
    }

    if (onProgress && v % chunk === 0) onProgress(v / count)
  }
  onProgress?.(1)
  return out
}

/** How many surfaces a ray may pass through before giving up on finding one
 *  that faces it. A couple is plenty: past that the ray is travelling through
 *  the part rather than across a wall. */
const FACING_ATTEMPTS = 4

/**
 * Distance to the first surface ahead that faces the ray.
 *
 * A surface nearly edge-on to the ray is not the other side of a wall — it is
 * a rib the ray is running alongside, or the rim of an open scan — so it is
 * stepped over and the search goes on behind it.
 */
function shoot(
  bvh: MeshBVH,
  ray: THREE.Ray,
  near: number,
  far: number,
  facing: number,
): number {
  let start = near
  for (let attempt = 0; attempt < FACING_ATTEMPTS; attempt++) {
    const hit = bvh.raycastFirst(ray, THREE.DoubleSide, start, far)
    if (!hit) return Infinity
    if (facing < 0) return hit.distance
    const n = hit.face!.normal
    const square = Math.abs(n.x * ray.direction.x + n.y * ray.direction.y + n.z * ray.direction.z)
    if (square >= facing) return hit.distance
    start = hit.distance + near
  }
  return Infinity
}

/**
 * Diameter of the sphere that sits halfway across the ray's crossing and grows
 * until it touches the surface.
 *
 * The centre goes to the middle of what the ray crossed, and the radius is
 * simply the distance from there to the nearest surface. The point the ray
 * started from is one candidate, at exactly half the crossing, so the answer
 * can never exceed the ray — it can only find something nearer and report a
 * tighter wall.
 *
 * Deliberately *not* the largest sphere tangent to the surface at p: on a
 * mesh from CAD nearly every vertex sits on a sharp edge, and no sphere of any
 * size touches an edge from inside without poking out of it, so that reading
 * collapses to nothing over most of the part. Centring on the crossing has no
 * such degeneracy — at the edge of a block the sphere is the one inscribed in
 * the block, and reports the block.
 */
function inscribedDiameter(
  bvh: MeshBVH,
  px: number, py: number, pz: number,
  dx: number, dy: number, dz: number,
  rayDistance: number,
  centre: THREE.Vector3,
  target: { point: THREE.Vector3; distance: number; faceIndex: number },
): number {
  const half = rayDistance / 2
  centre.set(px + dx * half, py + dy * half, pz + dz * half)
  const hit = bvh.closestPointToPoint(centre, target, 0, half)
  return hit ? 2 * target.distance : rayDistance
}

/** A thickness map's numbers: the shared ones, plus how much of the part falls
 *  under the minimum wall the user is watching for. */
export interface ThicknessStats extends FieldStats {
  /** Points thinner than `limit`. */
  belowLimit: number
  limit: number
}

export function thicknessStats(values: Float32Array, limit: number): ThicknessStats {
  let below = 0
  for (let i = 0; i < values.length; i++) {
    // NaN fails this, so an unmeasured vertex is never counted as thin.
    if (values[i] < limit) below++
  }
  return { ...fieldStats(values, 0, Infinity), belowLimit: below, limit }
}

/**
 * How a thickness field is read as colour.
 *
 * Reversed against the deviation ramp on purpose: thickness has no signed zero
 * to sit in the middle, and the end that needs to shout is the thin one. Red
 * is thin, blue is thick, and a wall thinner than the bottom of the scale gets
 * the dark red cap rather than quietly bottoming out.
 */
export function thicknessScale(low: number, high: number, bands: number | null): FieldScale {
  return {
    low,
    high,
    bands,
    validMin: 0,
    validMax: Infinity,
    reversed: true,
    capLow: RED_CAP_RGB,
    capHigh: BLUE_CAP_RGB,
  }
}

/**
 * A colour scale that shows the walls rather than the extremes.
 *
 * Both ends are percentiles: a scan of a printed part has a scattering of
 * near-zero readings on ragged boundary triangles and a few enormous ones
 * where a ray ran the length of the part instead of across a wall, and either
 * would swallow the whole ramp if the scale were fitted to the range. The top
 * end is the tighter of the two — a thickness distribution has a long tail to
 * the right, and letting it set the scale flattens every wall onto one colour.
 */
export function suggestThicknessScale(values: Float32Array): { low: number; high: number } {
  const [p2, p95] = fieldPercentiles(values, 0, Infinity, [0.02, 0.95])
  if (!Number.isFinite(p2) || !Number.isFinite(p95)) return { low: 0, high: 1 }
  const low = niceFloor(p2)
  const high = niceCeil(p95)
  // A part of one uniform wall thickness collapses both ends onto the same
  // number; open the scale around it so the map is a reading and not a
  // single flat colour.
  if (high > low) return { low, high }
  return { low: niceFloor(p95 * 0.5), high: niceCeil(p95 * 1.5) }
}

/**
 * How thick a wall the search should allow for, before anything is known about
 * the part beyond its size.
 *
 * Deliberately generous — a fifth of the part. A first measurement that leaves
 * most of the surface grey teaches nothing, so the default errs towards showing
 * the part and letting the reading be tightened to the wall that actually
 * matters. It still refuses a ray that runs the length of the body.
 */
export function defaultMaxThickness(bboxDiagonal: number): number {
  return niceCeil(bboxDiagonal * 0.2)
}

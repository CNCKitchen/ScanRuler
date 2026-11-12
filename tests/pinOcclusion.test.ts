// SPDX-License-Identifier: AGPL-3.0-only
// A pin's line of sight on a point cloud: a ray to a pin on a surface seen at
// a grazing angle is met by the cloud well in front of the pin, on the same
// surface, and the pin is on view all the same; a pin behind a wall is not.

import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { PointGrid } from '../src/core/geometry/pointGrid'
import { pickCloud } from '../src/viewer/cloudPick'
import { MIN_FACING, occlusionSlack, pinSeen } from '../src/viewer/pinOcclusion'

const SPACING = 0.5
/** The mesh's slack for a part of this size (overlays.ts OCCLUSION_SLACK). */
const BASE = 30 * 0.004

/** A 40 x 40 plane at z = 0 and, with `wall`, a wall at y = 5 standing on it
 *  from x = -20 to 20, 10 tall, facing -y. */
function cloud(wall: boolean): { positions: Float32Array; normals: Float32Array } {
  const p: number[] = []
  const n: number[] = []
  for (let x = -20; x <= 20; x += SPACING)
    for (let y = -20; y <= 20; y += SPACING) {
      p.push(x, y, 0)
      n.push(0, 0, 1)
    }
  if (wall)
    for (let x = -20; x <= 20; x += SPACING)
      for (let z = SPACING; z <= 10; z += SPACING) {
        p.push(x, 5, z)
        n.push(0, -1, 0)
      }
  return { positions: new Float32Array(p), normals: new Float32Array(n) }
}

/** Ask, as overlays.ts does, whether the pin at `pin` is seen along a ray
 *  coming from `from` (a direction away from the pin, toward the camera). */
function seen(c: { positions: Float32Array; normals: Float32Array }, pin: THREE.Vector3, from: THREE.Vector3, radius: number, cloudAware = true) {
  const dir = from.clone().normalize()
  const origin = pin.clone().addScaledVector(dir, 100)
  const ray = new THREE.Ray(origin, dir.clone().negate())
  const hit = pickCloud(new PointGrid(c.positions, 2 * SPACING), c.normals, ray, radius, [])
  if (!hit) return { seen: true, short: 0 }
  const at = new THREE.Vector3(...hit.point)
  const distance = at.distanceTo(origin)
  const facing = new THREE.Vector3(...hit.normal).dot(ray.direction)
  const slack = occlusionSlack(BASE, cloudAware ? { radius, facing } : null)
  return { seen: pinSeen(distance, origin.distanceTo(pin), slack), short: origin.distanceTo(pin) - distance }
}

describe('pin occlusion on a point cloud', () => {
  const radius = 1.5 * SPACING
  const grazing = new THREE.Vector3(0, -1, 0.12) // about 83 degrees off the plane's normal

  it('a pin on a surface seen at a grazing angle is met well in front of itself', () => {
    const r = seen(cloud(false), new THREE.Vector3(-8, 0, 0), grazing, radius, false)
    // The mesh's slack alone would hide it: the cloud is met radius * tan
    // in front of the pin.
    expect(r.short).toBeGreaterThan(5 * BASE)
    expect(r.seen).toBe(false)
  })

  it('is on view with the slack scaled by the pick radius and the angle', () => {
    for (const x of [-15, -8, 0, 8, 15]) {
      for (const tilt of [0.12, 0.2, 0.4, 1]) {
        const r = seen(cloud(false), new THREE.Vector3(x, 0, 0), new THREE.Vector3(0, -1, tilt), radius)
        expect(r.seen, `x ${x}, tilt ${tilt}, met ${r.short.toFixed(2)} short`).toBe(true)
      }
    }
  })

  // Over a grazing floor the wall is met through the floor in front of it,
  // so a pin closer behind it than radius * tan of the angle could pass: the
  // cloud cannot tell those apart at that radius. Further behind, it is hidden.
  it('a pin well behind a wall stays hidden, at a grazing angle or face on', () => {
    for (const tilt of [0.12, 0.3, 1]) {
      const r = seen(cloud(true), new THREE.Vector3(0, 15, 0), new THREE.Vector3(0, -1, tilt), radius)
      expect(r.seen, `tilt ${tilt}`).toBe(false)
    }
  })

  it('the slack is the mesh one without a cloud, and stops growing edge-on', () => {
    expect(occlusionSlack(BASE, null)).toBe(BASE)
    expect(occlusionSlack(BASE, { radius: 1, facing: 1 })).toBeCloseTo(BASE + 1)
    expect(occlusionSlack(BASE, { radius: 1, facing: -1 })).toBeCloseTo(BASE + 1)
    const capped = BASE + 1 + Math.sqrt(1 - MIN_FACING ** 2) / MIN_FACING
    expect(occlusionSlack(BASE, { radius: 1, facing: 0 })).toBeCloseTo(capped)
    expect(occlusionSlack(BASE, { radius: 1, facing: 0.01 })).toBeCloseTo(capped)
  })

  it('nothing met is seen; met short of the slack is hidden', () => {
    expect(pinSeen(undefined, 10, 0.1)).toBe(true)
    expect(pinSeen(9.95, 10, 0.1)).toBe(true)
    expect(pinSeen(9.5, 10, 0.1)).toBe(false)
  })
})

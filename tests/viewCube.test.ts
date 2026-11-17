// SPDX-License-Identifier: AGPL-3.0-only
// The view cube's geometry: the region a click lands in, the pose it turns
// to, the arrows' quarter turns and the roll the view is read and set by.
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  faceOn,
  orbitStep,
  regionAt,
  regionKey,
  regionView,
  rollUp,
  screenRoll,
  upForRoll,
  uprightUp,
  wrapAngle,
} from '../src/viewer/viewCubeMath'

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const deg = (d: number) => (d * Math.PI) / 180

function expectVec(a: THREE.Vector3, b: THREE.Vector3) {
  expect(a.distanceTo(b)).toBeLessThan(1e-9)
}

describe('view cube regions', () => {
  it('names a face, an edge or a corner by where on the face the point is', () => {
    expect(regionKey(regionAt(v(0.1, -1, 0.2)))).toBe('0,-1,0')
    expect(regionKey(regionAt(v(0.1, -1, 0.9)))).toBe('0,-1,1')
    expect(regionKey(regionAt(v(0.95, -1, 0.9)))).toBe('1,-1,1')
    expect(regionKey(regionAt(v(-0.8, 0.2, 1)))).toBe('-1,0,1')
  })

  it('turns a face square-on, upright as the standard views stand', () => {
    const front = regionView([0, -1, 0])
    expectVec(front.dir, v(0, -1, 0))
    expectVec(front.up, v(0, 0, 1))
    const top = regionView([0, 0, 1])
    expectVec(top.up, v(0, 1, 0))
    const bottom = regionView([0, 0, -1])
    expectVec(bottom.up, v(0, -1, 0))
  })

  it('turns an edge or a corner along its diagonal with Z up the screen', () => {
    const corner = regionView([1, -1, 1])
    expectVec(corner.dir, v(1, -1, 1).normalize())
    expect(corner.up.dot(corner.dir)).toBeCloseTo(0, 12)
    expect(corner.up.z).toBeGreaterThan(0)
    expect(corner.up.x).toBeCloseTo(-corner.up.z / 2, 12)
  })

  it('knows a square-on face view, and nothing else', () => {
    expect(faceOn(v(0, -1, 0))).toEqual([0, -1, 0])
    expect(faceOn(v(0, 0, 3))).toEqual([0, 0, 1])
    expect(faceOn(v(0.2, -1, 0))).toBeNull()
  })
})

describe('view cube orbit arrows', () => {
  it('brings the face the arrow sits by round to the front', () => {
    const front = { dir: v(0, -1, 0), up: v(0, 0, 1) }
    expectVec(orbitStep(front.dir, front.up, 'left').dir, v(-1, 0, 0))
    expectVec(orbitStep(front.dir, front.up, 'right').dir, v(1, 0, 0))
    const up = orbitStep(front.dir, front.up, 'up')
    expectVec(up.dir, v(0, 0, 1))
    // The top view as the 1 key shows it: the front at the bottom.
    expectVec(up.up, v(0, 1, 0))
    const down = orbitStep(front.dir, front.up, 'down')
    expectVec(down.dir, v(0, 0, -1))
    expectVec(down.up, v(0, -1, 0))
  })

  it('follows the screen when the view is rolled', () => {
    // Front, rolled a quarter turn: world X is now up the screen.
    const dir = v(0, -1, 0)
    const up = v(-1, 0, 0)
    expectVec(orbitStep(dir, up, 'up').dir, v(-1, 0, 0))
  })
})

describe('view cube roll', () => {
  it('reads a standard view as upright', () => {
    expect(screenRoll(v(0, -1, 0), v(0, 0, 1))).toBeCloseTo(0, 12)
    expect(screenRoll(v(1, -1, 1), uprightUp(v(1, -1, 1)))).toBeCloseTo(0, 12)
    expect(screenRoll(v(0, 0, 1), v(0, 1, 0))).toBeCloseTo(0, 12)
  })

  it('turns the part counter-clockwise for a positive roll', () => {
    const dir = v(0, -1, 0)
    // The part turned a quarter counter-clockwise from the front: its top
    // (+Z) now points left on screen, and its right side (+X) is what shows
    // at the top.
    const up = upForRoll(dir, deg(90))
    expectVec(up, v(1, 0, 0))
    expect(screenRoll(dir, up)).toBeCloseTo(deg(90), 12)
    // A world point up the part (+Z) lands left of the centre.
    const right = new THREE.Vector3().crossVectors(up, dir)
    expect(v(0, 0, 1).dot(right)).toBeCloseTo(-1, 12)
  })

  it('adds a step to the roll there is, and round-trips any angle', () => {
    const dir = v(0.3, -1, 0.4).normalize()
    for (const a of [-170, -25, 0, 15, 90, 179]) {
      const up = upForRoll(dir, deg(a))
      expect(screenRoll(dir, up)).toBeCloseTo(deg(a), 9)
      const stepped = rollUp(dir, up, deg(-90))
      expect(screenRoll(dir, stepped)).toBeCloseTo(wrapAngle(deg(a - 90)), 9)
    }
  })

  it('wraps angles into a half turn either way', () => {
    expect(wrapAngle(deg(270))).toBeCloseTo(deg(-90), 12)
    expect(wrapAngle(deg(-180))).toBeCloseTo(deg(180), 12)
    expect(wrapAngle(deg(45))).toBeCloseTo(deg(45), 12)
  })
})

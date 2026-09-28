// SPDX-License-Identifier: AGPL-3.0-only
// A pose settled on the part's symmetry plane: the nearest axis turned onto
// the plane's normal, the rest squared up with the least change, the zero
// point dropped onto the plane — and the pose read back out of a rigid.

import { describe, expect, it } from 'vitest'
import { poseOfRigid, poseOnSymmetry } from '../src/core/alignSymmetry'
import { autoAlignPicks } from '../src/core/autoAlign'
import type { Vec3 } from '../src/core/types'
import { cross, dot } from '../src/core/vec'

const X: Vec3 = [1, 0, 0]
const Y: Vec3 = [0, 1, 0]
const Z: Vec3 = [0, 0, 1]
const rad = (deg: number) => (deg * Math.PI) / 180

function expectRightHanded(axes: [Vec3, Vec3, Vec3]) {
  for (const a of axes) expect(Math.hypot(...a)).toBeCloseTo(1, 9)
  expect(dot(axes[0], axes[1])).toBeCloseTo(0, 9)
  expect(dot(axes[0], axes[2])).toBeCloseTo(0, 9)
  const z = cross(axes[0], axes[1])
  for (let i = 0; i < 3; i++) expect(z[i]).toBeCloseTo(axes[2][i], 9)
}

describe('poseOnSymmetry', () => {
  it('turns the nearest axis onto the normal and drops the zero onto the plane', () => {
    // A mirror plane two degrees off YZ, three millimetres from the zero.
    const n: Vec3 = [Math.cos(rad(2)), Math.sin(rad(2)), 0]
    const pose = poseOnSymmetry([X, Y, Z], [0, 0, 0], { normal: n, point: [3 * n[0], 3 * n[1], 7] })!
    expect(pose.axis).toBe(0)
    expect(pose.tiltDeg).toBeCloseTo(2, 6)
    expect(pose.shiftMm).toBeCloseTo(3, 9)
    expectRightHanded(pose.axes)
    for (let i = 0; i < 3; i++) expect(pose.axes[0][i]).toBeCloseTo(n[i], 9)
    // Up stays up: the plane's normal has no Z in it.
    expect(pose.axes[2][2]).toBeCloseTo(1, 9)
    // The zero point lies on the plane, moved along the normal alone.
    expect(dot([pose.origin[0] - 3 * n[0], pose.origin[1] - 3 * n[1], pose.origin[2] - 7], n)).toBeCloseTo(0, 9)
    expect(pose.origin[2]).toBeCloseTo(0, 9)
  })

  it('keeps the way an axis ran when the normal is given the other way round', () => {
    const pose = poseOnSymmetry([X, Y, Z], [1, 2, 3], { normal: [0, -1, 0.02], point: [0, 5, 0] })!
    expect(pose.axis).toBe(1)
    expect(pose.axes[1][1]).toBeGreaterThan(0.99)
    expectRightHanded(pose.axes)
  })

  it('takes Z when the plane lies flat, and keeps X as near as it was', () => {
    const pose = poseOnSymmetry([X, Y, Z], [0, 0, 4], { normal: [0.01, 0, 1], point: [0, 0, 1] })!
    expect(pose.axis).toBe(2)
    expectRightHanded(pose.axes)
    expect(pose.axes[0][0]).toBeGreaterThan(0.999)
    expect(pose.shiftMm).toBeCloseTo(3, 1)
  })

  it('has nothing to say to a plane with no normal', () => {
    expect(poseOnSymmetry([X, Y, Z], [0, 0, 0], { normal: [0, 0, 0], point: [0, 0, 0] })).toBeNull()
  })
})

describe('poseOfRigid', () => {
  it('reads the axes and the zero point a rigid motion gives the part', () => {
    // Turn a quarter about Z, then move: p' = R p + t.
    const r = Float64Array.from([0, 1, 0, -1, 0, 0, 0, 0, 1])
    const t = Float64Array.from([-2, 5, -1])
    const pose = poseOfRigid({ r, t })
    expect(pose.axes[0]).toEqual([0, 1, 0])
    expect(pose.axes[1]).toEqual([-1, 0, 0])
    // The origin is the point that lands on zero.
    const o = pose.origin
    for (let row = 0; row < 3; row++) expect(r[row * 3] * o[0] + r[row * 3 + 1] * o[1] + r[row * 3 + 2] * o[2] + t[row]).toBeCloseTo(0, 9)
  })

  it('goes round through the picks a proposal is made of', () => {
    const pose = poseOnSymmetry([X, Y, Z], [0, 0, 0], { normal: [1, 0.05, 0], point: [2, 0, 0] })!
    const picks = autoAlignPicks(pose, 10)
    // Three points on the floor plane through the zero, two along X.
    for (const p of picks.primary) expect(dot([p[0] - pose.origin[0], p[1] - pose.origin[1], p[2] - pose.origin[2]], pose.axes[2])).toBeCloseTo(0, 9)
    const along: Vec3 = [picks.secondary[1][0] - picks.secondary[0][0], picks.secondary[1][1] - picks.secondary[0][1], picks.secondary[1][2] - picks.secondary[0][2]]
    expect(dot(along, pose.axes[0])).toBeCloseTo(20, 9)
    expect(picks.origin).toEqual(pose.origin)
  })
})

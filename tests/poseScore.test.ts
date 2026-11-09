// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { CloudSurface } from '../src/core/deviation/cloudSurface'
import { CONFIDENT_RMS_SPACINGS, LOW_OVERLAP, oraclePose, poseConfidence, scorePose } from '../src/core/deviation/poseScore'
import { rigidFromAxisAngle, rigidInvert, type Rigid } from '../src/core/deviation/rigid'
import { blockWithBoreCloud, planeCloud } from './cloudFixtures'

const STEP = 2
const plane = planeCloud({ size: 100, step: STEP })
const target = new CloudSurface(plane.positions, plane.normals, STEP)
const identity: Rigid = oraclePose([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

describe('scorePose', () => {
  it('a perfect pose has no residual and matches everything', () => {
    const s = scorePose(target, plane, identity, 3 * STEP)
    expect(s.rms).toBeLessThan(1e-6)
    expect(s.matched).toBeCloseTo(1, 6)
  })

  it('5 mm off the plane reads as 5 mm, and a 5 mm slide drops matches at the edge', () => {
    const lift = { r: identity.r, t: Float64Array.from([0, 0, 5]) }
    const up = scorePose(target, plane, lift, 10)
    expect(up.rms).toBeCloseTo(5, 6)
    expect(up.matched).toBeCloseTo(1, 6)
    // Reach shorter than the offset: nothing pairs.
    expect(scorePose(target, plane, lift, 3).matched).toBe(0)
    const slide = { r: identity.r, t: Float64Array.from([5, 0, 0]) }
    const s = scorePose(target, plane, slide, 3)
    expect(s.matched).toBeLessThan(0.99)
    expect(s.matched).toBeGreaterThan(0.9)
  })

  it('a surface facing the other way is not a match', () => {
    const flipped = { positions: plane.positions, normals: plane.normals.map((v) => -v) }
    expect(scorePose(target, flipped, identity, 3 * STEP).matched).toBe(0)
  })

  it('the pose is applied as source -> target', () => {
    const block = blockWithBoreCloud({ size: [40, 40, 40], boreRadius: 8, step: 2 })
    const t = new CloudSurface(block.positions, block.normals, 2)
    const pose = rigidFromAxisAngle([0, 0, 1], 0.2)
    pose.t.set([3, 0, 0])
    // The source is the block moved by the inverse, so `pose` puts it back.
    const inv = rigidInvert(pose)
    const src = { positions: new Float32Array(block.positions.length), normals: new Float32Array(block.normals.length) }
    for (let i = 0; i < block.positions.length; i += 3) {
      const [x, y, z] = [block.positions[i], block.positions[i + 1], block.positions[i + 2]]
      for (let k = 0; k < 3; k++) src.positions[i + k] = inv.r[k * 3] * x + inv.r[k * 3 + 1] * y + inv.r[k * 3 + 2] * z + inv.t[k]
      const [a, b, c] = [block.normals[i], block.normals[i + 1], block.normals[i + 2]]
      for (let k = 0; k < 3; k++) src.normals[i + k] = inv.r[k * 3] * a + inv.r[k * 3 + 1] * b + inv.r[k * 3 + 2] * c
    }
    expect(scorePose(t, src, pose, 4).rms).toBeLessThan(1e-3)
    expect(scorePose(t, src, pose, 4).matched).toBeCloseTo(1, 3)
    expect(scorePose(t, src, rigidInvert(pose), 4).rms).toBeGreaterThan(0.1)
  })
})

describe('oraclePose', () => {
  it('reads the 4x4 row-major, translation at 3, 7, 11', () => {
    const p = oraclePose([0, -1, 0, 10, 1, 0, 0, 20, 0, 0, 1, 30, 0, 0, 0, 1])
    expect(Array.from(p.r)).toEqual([0, -1, 0, 1, 0, 0, 0, 0, 1])
    expect(Array.from(p.t)).toEqual([10, 20, 30])
  })
  it('rejects a wrong length', () => {
    expect(() => oraclePose([1, 2, 3])).toThrow()
  })
  it('LOW_OVERLAP is a share', () => {
    expect(LOW_OVERLAP).toBeGreaterThan(0)
    expect(LOW_OVERLAP).toBeLessThan(1)
  })
})

describe('poseConfidence', () => {
  it('a close fit with enough overlap is confident', () => {
    expect(poseConfidence({ rms: 0.5, matched: 0.6 }, 1)).toEqual({ lowOverlap: false, confident: true })
    expect(poseConfidence({ rms: CONFIDENT_RMS_SPACINGS, matched: LOW_OVERLAP }, 1).confident).toBe(true)
  })

  it('too little overlap is low and never confident', () => {
    expect(poseConfidence({ rms: 0.01, matched: LOW_OVERLAP - 0.01 }, 1)).toEqual({ lowOverlap: true, confident: false })
    expect(poseConfidence({ rms: Infinity, matched: 0 }, 1)).toEqual({ lowOverlap: true, confident: false })
  })

  it('a loose fit is not confident even with a lot of overlap', () => {
    expect(poseConfidence({ rms: 1.5, matched: 0.66 }, 1)).toEqual({ lowOverlap: false, confident: false })
  })

  it('the residual is read in target spacings', () => {
    expect(poseConfidence({ rms: 0.15, matched: 0.8 }, 0.1).confident).toBe(false)
    expect(poseConfidence({ rms: 0.09, matched: 0.8 }, 0.1).confident).toBe(true)
  })
})

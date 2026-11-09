// SPDX-License-Identifier: AGPL-3.0-only
// A point cloud as the target of a closest-point query: the nearest point's
// tangent plane, signed by its normal — enough for ICP to align onto a cloud.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { autoAlignSteps } from '../src/core/deviation/align'
import { CloudSurface } from '../src/core/deviation/cloudSurface'
import { icp, sampleScan, type IcpPool } from '../src/core/deviation/icp'
import { icpPoolFor } from '../src/core/deviation/icpPool'
import { rigidCompose, rigidRotationAngle, identityRigid } from '../src/core/deviation/rigid'
import { runSteps } from '../src/core/deviation/steps'
import { emptyHit, NominalSurface } from '../src/core/deviation/surface'
import { applyRigidCloud, blockWithBoreCloud, planeCloud, rigidOf, sphereCloud } from './cloudFixtures'

describe('CloudSurface', () => {
  it('a plane: 1 mm above reads +1, below reads -1, normal +z, no face', () => {
    const step = 0.5
    const c = planeCloud({ size: 20, step })
    const s = new CloudSurface(c.positions, c.normals, step)
    const hit = emptyHit()
    for (const [x, y] of [[0.13, -0.21], [3.3, 4.07], [-7.9, 2.2]]) {
      expect(s.closest(x, y, 1, hit)).toBe(true)
      expect(Math.abs(hit.distance - 1)).toBeLessThanOrEqual(step / 2)
      expect(hit.signed).toBeGreaterThan(0)
      expect(hit.nz).toBeCloseTo(1, 6)
      expect(hit.faceIndex).toBe(-1)
      expect(hit.pz).toBeCloseTo(0, 6)
      expect(s.closest(x, y, -1, hit)).toBe(true)
      expect(Math.abs(hit.distance - 1)).toBeLessThanOrEqual(step / 2)
      expect(hit.signed).toBeLessThan(0)
    }
    expect(s.bboxDiagonal).toBeCloseTo(Math.hypot(20, 20), 4)
    expect(s.positions).toBe(c.positions)
  })

  it('a sphere: outside reads positive, inside negative', () => {
    const step = 1
    const c = sphereCloud({ radius: 20, step })
    const s = new CloudSurface(c.positions, c.normals, step)
    const hit = emptyHit()
    for (const d of [[1, 0, 0], [0.6, 0.8, 0], [0.3, -0.4, Math.sqrt(0.75)]]) {
      expect(s.closest(d[0] * 21, d[1] * 21, d[2] * 21, hit)).toBe(true)
      expect(Math.abs(hit.distance - 1)).toBeLessThanOrEqual(step / 2)
      expect(hit.signed).toBeGreaterThan(0)
      expect(s.closest(d[0] * 19, d[1] * 19, d[2] * 19, hit)).toBe(true)
      expect(Math.abs(hit.distance - 1)).toBeLessThanOrEqual(step / 2)
      expect(hit.signed).toBeLessThan(0)
    }
  })

  it('maxDistance: nothing within reach is a miss', () => {
    const c = planeCloud({ size: 10, step: 1 })
    const s = new CloudSurface(c.positions, c.normals, 1)
    expect(s.closest(0, 0, 5, emptyHit(), 2)).toBe(false)
    expect(s.closest(0, 0, 5, emptyHit(), 6)).toBe(true)
  })

  it('closestFacing takes the nearest point facing the given way, among the 12 nearest', () => {
    // Two parallel skins 0.6 apart facing each other's backs: a thin wall.
    const top = planeCloud({ size: 10, step: 1 })
    const n = top.positions.length / 3
    const positions = new Float32Array(n * 2 * 3)
    const normals = new Float32Array(n * 2 * 3)
    positions.set(top.positions)
    normals.set(top.normals)
    for (let i = 0; i < n; i++) {
      positions[(n + i) * 3] = top.positions[i * 3]
      positions[(n + i) * 3 + 1] = top.positions[i * 3 + 1]
      positions[(n + i) * 3 + 2] = -0.6
      normals[(n + i) * 3 + 2] = -1
    }
    const s = new CloudSurface(positions, normals, 0.6)
    const hit = emptyHit()
    // Just above the bottom skin: nearest is the bottom, facing -z.
    expect(s.closest(0.1, 0.1, -0.5, hit)).toBe(true)
    expect(hit.nz).toBeCloseTo(-1, 6)
    expect(s.closestFacing(0.1, 0.1, -0.5, 0, 0, 1, 0.5, hit)).toBe(true)
    expect(hit.nz).toBeCloseTo(1, 6)
    expect(hit.signed).toBeCloseTo(-0.5, 5)
    expect(hit.faceIndex).toBe(-1)
    // Out of reach, or nothing facing that way: a miss.
    expect(s.closestFacing(0.1, 0.1, -0.5, 0, 0, 1, 0.5, hit, 0.2)).toBe(false)
    expect(s.closestFacing(0.1, 0.1, -0.5, 1, 0, 0, 0.5, hit)).toBe(false)
  })

  it('ICP of a perturbed cloud (5°, 5 mm) onto its own CloudSurface recovers the pose within 0.05° / 0.02 mm', () => {
    const step = 1
    const target = blockWithBoreCloud({ size: [40, 30, 20], boreRadius: 6, step })
    const surface = new CloudSurface(target.positions, target.normals, step)
    const perturb = rigidOf([5, -3, 4], [5, -3, 4].map((v) => (v * 5) / Math.hypot(5, 3, 4)) as [number, number, number])
    const moved = applyRigidCloud(target, perturb)
    const samples = sampleScan(moved.positions, moved.normals, 3000)
    const r = icp(surface, samples, identityRigid(), { maxIterations: 100, minNormalDot: 0.5 })
    const residual = rigidCompose(r.transform, perturb)
    expect((rigidRotationAngle(residual) * 180) / Math.PI).toBeLessThan(0.05)
    expect(Math.hypot(residual.t[0], residual.t[1], residual.t[2])).toBeLessThan(0.02)
  })
})

describe('helper-pool gating', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('the pooled ICP entry point with a CloudSurface runs serially and gives the same result', () => {
    const step = 1
    const target = blockWithBoreCloud({ size: [40, 30, 20], boreRadius: 6, step })
    const surface = new CloudSurface(target.positions, target.normals, step)
    const moved = applyRigidCloud(target, rigidOf([2, -1, 1.5], [1, -0.5, 0.8]))
    let sessions = 0
    const pool: IcpPool = {
      session() {
        sessions++
        return null
      },
    }
    const options = { coarseSamples: 2500, fineSamples: 3000 }
    const alone = runSteps(autoAlignSteps(surface, moved.positions, moved.normals, options))
    const pooled = runSteps(autoAlignSteps(surface, moved.positions, moved.normals, { ...options, pool }))
    expect(sessions).toBe(0)
    expect(Array.from(pooled.transform.r)).toEqual(Array.from(alone.transform.r))
    expect(Array.from(pooled.transform.t)).toEqual(Array.from(alone.transform.t))
    expect(pooled.rms).toBe(alone.rms)
  })

  it('icpPoolFor starts helpers for a mesh but none for a cloud', () => {
    let started = 0
    class FakeWorker {
      constructor() {
        started++
      }
      postMessage() {}
      terminate() {}
      onerror = null
      onmessage = null
      onmessageerror = null
    }
    class Scope {
      static [Symbol.hasInstance]() {
        return true
      }
    }
    vi.stubGlobal('crossOriginIsolated', true)
    vi.stubGlobal('WorkerGlobalScope', Scope)
    vi.stubGlobal('Worker', FakeWorker)
    vi.stubGlobal('navigator', { hardwareConcurrency: 8 })

    const cloud = sphereCloud({ radius: 20, step: 1 })
    const mesh = new NominalSurface(
      new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
      new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
    )
    const meshPool = icpPoolFor(mesh, 1_000_000)
    expect(meshPool).not.toBeNull()
    expect(started).toBeGreaterThan(0)
    meshPool?.close()
    started = 0
    expect(icpPoolFor(new CloudSurface(cloud.positions, cloud.normals, 1), 1_000_000)).toBeNull()
    expect(started).toBe(0)
  })
})

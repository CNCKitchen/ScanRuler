// SPDX-License-Identifier: AGPL-3.0-only
// The Reverse kernel's scan when the scan is a point cloud: the points as a
// surface to test against (CloudSurface), so an automatic trim keeps the
// faces lying on the cloud as it keeps those lying on a mesh.
import { describe, expect, it } from 'vitest'
import type { ResolveContext, Feature } from '../core/features'
import type { PlaneFit } from '../../../src/core/types'
import { CloudSurface } from '../../../src/core/deviation/cloudSurface'
import { findRegions } from '../core/regions'
import { resolveFeatures } from '../core/resolve'
import { ReClient } from '../core/reClient'
import { scanSurface } from '../core/reService'
import type { Sketch } from '../core/sketch'
import { localKernel } from './reLocal'
import { blockWithBoreCloud } from '../../../tests/cloudFixtures'

const NO_STATS = { sigma: 0, usedPoints: 0, regionSize: 0 }
const plane = (id: number, center: [number, number, number], normal: [number, number, number]): { id: number; fit: PlaneFit } => {
  const u: [number, number, number] = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1]
  const v: [number, number, number] = [normal[1] * u[2] - normal[2] * u[1], normal[2] * u[0] - normal[0] * u[2], normal[0] * u[1] - normal[1] * u[0]]
  return { id, fit: { kind: 'plane', center, normal, basisU: u, basisV: v, extentU: 5, extentV: 5, ...NO_STATS } }
}
const PLANES = [plane(1, [10, 0, 0], [1, 0, 0]), plane(2, [-10, 0, 0], [-1, 0, 0]), plane(3, [0, 10, 0], [0, 1, 0]), plane(4, [0, -10, 0], [0, -1, 0]), plane(5, [0, 0, 10], [0, 0, 1]), plane(6, [0, 0, -10], [0, 0, -1])]
const ctx = (elements: ResolveContext['elements']): ResolveContext => ({ sections: [], elements, modelCenter: [0, 0, 0] })
const trim: Feature = { id: 7, kind: 'trim', name: 'Trim 7', tools: PLANES.map((p) => ({ kind: 'element' as const, id: p.id })), tolerance: 0.3, overlap: 0.5, visible: true }

describe('Reverse kernel on a point cloud', () => {
  it('takes the cloud as a surface of points', () => {
    const c = blockWithBoreCloud({ size: [20, 20, 20], boreRadius: 1, step: 0.5 })
    expect(scanSurface({ positions: c.positions, indices: null, normals: c.normals, transform: null })).toBeInstanceOf(CloudSurface)
    expect(scanSurface({ positions: c.positions, indices: null, normals: null, transform: null })).toBeNull()
  })

  it('trims six planes to the box the cloud was scanned of', async () => {
    const c = blockWithBoreCloud({ size: [20, 20, 20], boreRadius: 1, step: 0.5 })
    const client = new ReClient(localKernel())
    await client.init()
    await client.setScan(c.positions.slice(), null, null, c.normals.slice())
    const steps = resolveFeatures([trim], ctx(PLANES as ResolveContext['elements']), (f) => findRegions(f.sketch))
    const out = await client.build(steps, new Map<number, Sketch>())
    expect(out?.results[0].status, out?.results[0].message).toBe('ok')
    expect(out?.results[0].trim?.kept).toBe(6)
    expect(out?.results[0].trim?.closed).toBe(true)
  }, 180_000)
})

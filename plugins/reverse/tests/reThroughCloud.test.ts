// SPDX-License-Identifier: AGPL-3.0-only
// See-through on a point cloud: the rays meet the cloud's points that face
// back at them (insideRays) where a mesh's would meet its triangles, so a
// bore through a block comes out a hole of its radius.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { run, startHeadless, type Headless } from '../../../tests/commandKit'
import { blockWithBoreCloud, writePlyCloud } from '../../../tests/cloudFixtures'
import { throughOn } from '../app/reThrough'
import plugin from '../plugin'

vi.setConfig({ testTimeout: 180_000 })

const BLOCK = new Uint8Array(writePlyCloud(blockWithBoreCloud({ size: [30, 30, 10], boreRadius: 5, step: 0.4 }), 'binary_little_endian'))

let headless: Headless
beforeAll(async () => {
  plugin.install?.()
  headless = await startHeadless()
  await run('scan.open', { bytes: BLOCK, name: 'block.ply', discard: true })
}, 120_000)
afterAll(() => headless.stop())

describe('see-through on a point cloud', () => {
  it('sees the bore through the block’s top as a hole of its radius', async () => {
    const frame = { origin: [0, 0, 5] as [number, number, number], normal: [0, 0, 1] as [number, number, number], basisU: [1, 0, 0] as [number, number, number], basisV: [0, 1, 0] as [number, number, number] }
    const seen = await throughOn(frame, [-1, 1], { tolerance: 0.4 })
    const holes = seen.chains.filter((_, i) => seen.holes[i])
    expect(holes.length).toBeGreaterThanOrEqual(1)
    const radii = holes[0].map((p) => Math.hypot(p[0], p[1]))
    const mean = radii.reduce((a, b) => a + b, 0) / radii.length
    expect(Math.abs(mean - 5)).toBeLessThan(0.5)
  })
})

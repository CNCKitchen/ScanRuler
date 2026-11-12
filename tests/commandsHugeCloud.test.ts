// SPDX-License-Identifier: AGPL-3.0-only
// scan.open on a point cloud too large for the tab: refused before it is read
// unless maxPoints says how many points to keep, and thinned as it is read
// when it does.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { planeCloud, writePlyCloud } from './cloudFixtures'
import { refused, run, startHeadless, type Headless } from './commandKit'

let headless: Headless
beforeAll(async () => {
  headless = await startHeadless()
})
afterAll(() => headless.stop())

/** A PLY cloud whose header counts `count` points, with no body behind it. */
function claimed(count: number): Uint8Array {
  return new TextEncoder().encode(`ply\nformat binary_little_endian 1.0\nelement vertex ${count}\nproperty float x\nproperty float y\nproperty float z\nproperty float nx\nproperty float ny\nproperty float nz\nend_header\n`)
}

describe('scan.open on a huge point cloud', () => {
  it('is refused before it is read, with the count, the target and how to go on', async () => {
    const e = await refused('scan.open', { bytes: claimed(84_000_000), name: 'lucy.ply', discard: true })
    expect(e.code).toBe('invalid_input')
    expect(e.message).toBe('lucy.ply holds 84,000,000 points — more than a browser tab holds well (30,000,000). Open it with maxPoints: 30000000 to thin it evenly to 30,000,000 points as it is read, or maxPoints: 0 to open all 84,000,000.')
  })

  it('opens thinned to maxPoints, and says from and to how many', async () => {
    const cloud = planeCloud({ size: 30, step: 1 }) // 961 points
    const bytes = new Uint8Array(writePlyCloud(cloud, 'binary_little_endian'))
    const opened = await run<{ scan: { vertices: number }; thinned?: { from: number; to: number } }>('scan.open', { bytes, name: 'plane.ply', discard: true, maxPoints: 200 })
    expect(opened.thinned).toEqual({ from: 961, to: 200 })
    expect(opened.scan.vertices).toBeLessThanOrEqual(200)
    expect(opened.scan.vertices).toBeGreaterThan(150)
    const whole = await run<{ scan: { vertices: number }; thinned?: unknown }>('scan.open', { bytes, name: 'plane.ply', discard: true, maxPoints: 0 })
    expect(whole.thinned).toBeUndefined()
    expect(whole.scan.vertices).toBeGreaterThan(900)
  })
})

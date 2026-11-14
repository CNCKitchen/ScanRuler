// SPDX-License-Identifier: AGPL-3.0-only
// The worker's section op on a point cloud: the cut read off the points.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkerRequest, WorkerResponse } from '../src/core/workerProtocol'
import { cylinderCloud, writePlyCloud } from './cloudFixtures'

describe('section on a cloud', () => {
  let replies: WorkerResponse[]
  let scope: { onmessage: ((e: { data: WorkerRequest }) => void) | null; postMessage: (m: WorkerResponse) => void }
  beforeEach(async () => {
    replies = []
    scope = { onmessage: null, postMessage: (msg) => replies.push(msg) }
    vi.stubGlobal('self', scope)
    vi.resetModules()
    await import('../src/core/meshWorker')
  })
  afterEach(() => vi.unstubAllGlobals())

  it('cuts a cylinder cloud into one ring on its radius', () => {
    const buffer = writePlyCloud(cylinderCloud({ radius: 10, length: 20, step: 0.3 }), 'binary_little_endian')
    scope.onmessage!({ data: { type: 'load', requestId: 1, name: 'cyl.ply', buffer, crease: { mode: 'on', angleDeg: 30 } } })
    replies.length = 0
    scope.onmessage!({ data: { type: 'section', requestId: 2, origin: [0, 0, 0.05], normal: [0, 0, 1], minLength: 1 } })
    const r = replies.at(-1)!
    expect(r.type).toBe('section-ok')
    if (r.type !== 'section-ok') return
    expect(r.offsets.length).toBe(2)
    for (let i = 0; i < r.points.length; i += 3) expect(Math.abs(Math.hypot(r.points[i], r.points[i + 1]) - 10)).toBeLessThan(0.15)
  })
})

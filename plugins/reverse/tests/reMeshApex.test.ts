// SPDX-License-Identifier: AGPL-3.0-only
// A bore with a cone at its end, as a drill leaves it, exported as an STL
// for a printer: every edge of the mesh is shared by two triangles, and no
// triangle has two corners on one point. The mesher closes the cone at its
// apex with a triangle of no area, which made one edge four triangles share
// and an edge from a point to itself.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { run, startHeadless, type Headless } from '../../../tests/commandKit'
import { createReverseSession, installReverseSession, type ReverseSession } from '../app/reSession'
import { withoutCollapsed } from '../core/kernelMesh'
import { ReClient } from '../core/reClient'
import { useReverse } from '../state/reStore'
import plugin from '../plugin'
import { localKernel } from './reLocal'
import { resetReverse } from './reReset'

vi.setConfig({ testTimeout: 180_000 })

let headless: Headless
let session: ReverseSession
const stops: (() => void)[] = []

beforeAll(async () => {
  plugin.install?.()
  headless = await startHeadless()
  session = createReverseSession({ sceneRef: { current: null }, kernel: () => new ReClient(localKernel()) })
  stops.push(installReverseSession(session), session.watch())
}, 120_000)
afterAll(() => {
  for (const stop of stops) stop()
  headless.stop()
})
beforeEach(resetReverse)

/** How a binary STL's triangles share their edges, by corner position. */
function edgeUse(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = view.getUint32(80, true)
  const uses = new Map<string, number>()
  let collapsed = 0
  for (let t = 0; t < count; t++) {
    const at = 84 + 50 * t + 12
    const corner = [0, 1, 2].map((k) => [0, 4, 8].map((c) => view.getFloat32(at + 12 * k + c, true)).join(','))
    if (corner[0] === corner[1] || corner[1] === corner[2] || corner[2] === corner[0]) collapsed++
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
      const key = [corner[a], corner[b]].sort().join('|')
      uses.set(key, (uses.get(key) ?? 0) + 1)
    }
  }
  return { triangles: count, collapsed, unpaired: [...uses.values()].filter((n) => n !== 2).length }
}

describe('a mesh for printing', () => {
  it('closes a cone at its apex with every edge shared by two triangles', async () => {
    await run('reverse.feature.add', {
      features: [
        { kind: 'sketch', name: 'Bar', plane: { kind: 'world', axis: 'y' }, sketch: { shapes: [{ kind: 'rectangle', id: 1, center: [0, 0], size: [20, 20], fixed: true }] } },
        { kind: 'extrude', sketchId: 'Bar', regions: 'all', extent: { kind: 'distance', from: 0, to: 30 }, op: 'new' },
      ],
      detail: 'none',
    })
    const body = useReverse.getState().bodies[0].name
    // A blind Ø4.134 bore 13 deep, its end a cone to a point 14.3 in.
    await run('reverse.feature.add', {
      features: [
        { kind: 'sketch', name: 'Bore profile', plane: { kind: 'world', axis: 'x' }, sketch: { shapes: [{ kind: 'polyline', closed: true, fixed: true, points: [[-1, 0], [14.3, 0], [13, 2.067], [-1, 2.067]] }] } },
        { kind: 'revolve', name: 'Bore', sketchId: 'Bore profile', regions: 'all', op: 'cut', target: body, axis: { kind: 'world', axis: 'y' }, angleDeg: 360 },
      ],
      detail: 'none',
    })
    expect(Object.values(useReverse.getState().results).every((r) => r.status === 'ok')).toBe(true)
    const out = await run<{ file: { bytes: Uint8Array } }>('reverse.export.stl', { bodies: [body] })
    expect(edgeUse(out.file.bytes)).toMatchObject({ collapsed: 0, unpaired: 0 })
  })

  it('takes out only triangles with two corners on one point', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0])
    expect([...withoutCollapsed(positions, new Uint32Array([0, 1, 2, 1, 3, 2, 0, 1, 2]))]).toEqual([0, 1, 2, 0, 1, 2])
    const whole = new Uint32Array([0, 1, 2])
    expect(withoutCollapsed(positions, whole)).toBe(whole)
  })
})

// SPDX-License-Identifier: AGPL-3.0-only
// A mirror turns a thread's hand. Copying a handle's threaded end to its
// other end by a mirror leaves a left-handed thread there that no stock
// screw fits, and nothing else shows it: the mirror's row says so, and a
// mirror of a body with no thread says nothing.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { run, startHeadless, type Headless } from '../../../tests/commandKit'
import { createReverseSession, installReverseSession, type ReverseSession } from '../app/reSession'
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

interface Added { feature: { id: number }; result?: { status: string } }

const bar = async (threaded: boolean) => {
  await run('reverse.feature.add', {
    features: [
      { kind: 'sketch', name: 'Bar section', plane: { kind: 'world', axis: 'y' }, sketch: { shapes: [{ kind: 'rectangle', id: 1, center: [0, 0], size: [10, 10], fixed: true }] } },
      { kind: 'extrude', name: 'Bar', sketchId: 'Bar section', extent: { kind: 'distance', from: 0, to: 20 }, op: 'new' },
      { kind: 'sketch', name: 'Tap', plane: { kind: 'world', axis: 'y' }, sketch: { shapes: [{ kind: 'circle', center: [0, 0], radius: 2.067, fixed: true }] } },
      { kind: 'extrude', name: 'Bore', sketchId: 'Tap', regions: 'all', op: 'cut', target: 'Bar', extent: { kind: 'distance', from: -1, to: 13 } },
    ],
    detail: 'none',
  })
  if (threaded) await run('reverse.feature.add', { feature: { kind: 'thread', name: 'M5 thread', body: 'Bar', size: 'M5', face: { where: { kind: 'cylinder' } } }, detail: 'none' })
}

describe('a mirror of a threaded body', () => {
  it('says the thread comes out left-handed', async () => {
    await bar(true)
    const m = await run<Added>('reverse.feature.add', { feature: { kind: 'mirror', name: 'Far end', body: 'Bar', plane: { kind: 'world', axis: 'y', offset: 20 }, join: true }, detail: 'brief' })
    expect(m.result?.status).toBe('ok')
    expect(useReverse.getState().results[m.feature.id]?.warning).toMatch(/This mirrors M5 thread: a right-handed thread comes out left-handed on the mirrored half\. .*180° turn/)
  })

  it('says nothing when there is no thread', async () => {
    await bar(false)
    const m = await run<Added>('reverse.feature.add', { feature: { kind: 'mirror', name: 'Far end', body: 'Bar', plane: { kind: 'world', axis: 'y', offset: 20 }, join: true }, detail: 'brief' })
    expect(m.result?.status).toBe('ok')
    expect(useReverse.getState().results[m.feature.id]?.warning).toBeUndefined()
  })
})

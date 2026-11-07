// SPDX-License-Identifier: AGPL-3.0-only
// A feature that fails to build leaves the bodies whole without it, so they
// check and export as any other: a thread whose clearance a parameter later
// raised past the tooth leaves a plain bore. The export's and the check's
// answers name what failed, so a file missing a feature is not taken for
// the part.

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

interface Told { status?: string; failed?: { name: string; message: string }[] }

describe('a feature that failed to build', () => {
  it('is named by the exports and the check of the bodies without it', async () => {
    await run('reverse.feature.add', {
      features: [
        { kind: 'sketch', name: 'Bar section', plane: { kind: 'world', axis: 'y' }, sketch: { shapes: [{ kind: 'rectangle', id: 1, center: [0, 0], size: [10, 10], fixed: true }] } },
        { kind: 'extrude', name: 'Bar', sketchId: 'Bar section', extent: { kind: 'distance', from: 0, to: 20 }, op: 'new' },
        { kind: 'sketch', name: 'Tap', plane: { kind: 'world', axis: 'y' }, sketch: { shapes: [{ kind: 'circle', center: [0, 0], radius: 2.067, fixed: true }] } },
        { kind: 'extrude', name: 'Bore', sketchId: 'Tap', regions: 'all', op: 'cut', target: 'Bar', extent: { kind: 'distance', from: -1, to: 13 } },
      ],
      detail: 'none',
    })
    await run('reverse.parameter.add', { name: 'clearance', expression: '0.1' })
    await run('reverse.feature.add', { feature: { kind: 'thread', name: 'M5 thread', body: 'Bar', size: 'M5', offset: 0.1, exprs: { offset: 'clearance' }, face: { where: { kind: 'cylinder' } } }, detail: 'none' })
    // Built, nothing is said.
    const fine = await run<Told>('reverse.export.stl', { bodies: ['Bar'] })
    expect(fine.failed).toBeUndefined()
    expect(fine.status).not.toMatch(/Not in the bodies/)

    // Past the tooth: the thread fails, the bar is a plain bore.
    await run('reverse.parameter.set', { name: 'clearance', expression: '0.2' })
    expect(Object.values(useReverse.getState().results).some((r) => r.status === 'failed')).toBe(true)
    for (const [command, input] of [['reverse.export.stl', { bodies: ['Bar'] }], ['reverse.export.step', { bodies: ['Bar'] }], ['reverse.body.check', { body: 'Bar' }]] as const) {
      const told = await run<Told>(command, input)
      expect(told.failed?.map((f) => f.name), command).toEqual(['M5 thread'])
      expect(told.failed![0].message).toMatch(/no thickness/)
      expect(told.status, command).toMatch(/Not in the bodies: M5 thread failed to build/)
    }
  })
})

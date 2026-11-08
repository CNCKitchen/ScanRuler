// SPDX-License-Identifier: AGPL-3.0-only
// Two guards on the part's features (issue 34). A build still running when
// the feature list is emptied: the empty list lands at once, with no kernel
// call to overtake the one running, whose answer landing after brought the
// deleted bodies back and left a wait for the build sitting out its limit.
// And an update refused: its visible and suppressed were set before the
// rest was checked, so they stood, and the refusal recorded a step.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCommand } from '../../../src/commands/registry'
import { refused, run, startHeadless, undoLabels, type Headless } from '../../../tests/commandKit'
import { ReClient, type ReTransport } from '../core/reClient'
import type { ReWorkerRequest } from '../core/reService'
import { createReverseSession, installReverseSession, type ReverseSession } from '../app/reSession'
import plugin from '../plugin'
import { useReverse } from '../state/reStore'
import { localKernel } from './reLocal'
import { resetReverse } from './reReset'

vi.setConfig({ testTimeout: 120_000 })

/** The kernel in this thread, its build answers held while `holding`. */
let holding = false
let held: (() => void)[] = []
function gated(): ReTransport {
  const inner = localKernel()
  const transport: ReTransport = {
    onFailure: null,
    onEvent: null,
    request<T>(msg: { requestId: number }, transfer: Transferable[], limitMs?: number): Promise<T> {
      const answer = inner.request<T>(msg, transfer, limitMs)
      if ((msg as ReWorkerRequest).type !== 'build' || !holding) return answer
      return new Promise<T>((resolve, reject) => held.push(() => void answer.then(resolve, reject)))
    },
    dispose() {
      inner.dispose()
    },
  }
  inner.onEvent = (e) => transport.onEvent?.(e)
  return transport
}

const rectangle = { kind: 'sketch', name: 'Outline', plane: { kind: 'world', axis: 'z' }, sketch: { shapes: [{ kind: 'rectangle', id: 1, center: [0, 0], size: [30, 20], fixed: true }] } }
const slab = (name: string, from: number, to: number) => ({ kind: 'extrude', name, sketchId: 'Outline', regions: 'all', extent: { kind: 'distance', from, to }, op: 'new' })

let headless: Headless
let session: ReverseSession
const stops: (() => void)[] = []

beforeAll(async () => {
  plugin.install?.()
  headless = await startHeadless()
  session = createReverseSession({ sceneRef: { current: null }, kernel: () => new ReClient(gated()) })
  stops.push(installReverseSession(session), session.watch())
  await session.startKernel()
}, 120_000)
afterAll(() => {
  for (const stop of stops) stop()
  headless.stop()
})
beforeEach(() => {
  resetReverse()
  holding = false
  held = []
})

describe('a build overtaken by the list emptied', () => {
  it('lands nothing: the deleted bodies stay gone and the session settles', async () => {
    await run('reverse.feature.add', { feature: rectangle })
    await run('reverse.feature.add', { feature: slab('Plate', 0, 5) })
    expect(useReverse.getState().bodies.length).toBe(1)

    holding = true
    const adding = runCommand('reverse.feature.add', { feature: slab('Top', 5, 8) }).catch(() => null)
    await vi.waitFor(() => expect(held.length).toBe(1), { timeout: 30_000 })
    useReverse.getState().clearFeatures()
    await vi.waitFor(() => expect(useReverse.getState().bodies.length).toBe(0))

    holding = false
    for (const release of held.splice(0)) release()
    await adding
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(useReverse.getState().bodies.length).toBe(0)
    expect(session.buildState()).toBe('built')
    const t = Date.now()
    await session.settled()
    expect(Date.now() - t).toBeLessThan(5000)
  })
})

describe('an update refused', () => {
  it('changes nothing: not suppressed, not hidden, and no step recorded', async () => {
    await run('reverse.feature.add', { feature: rectangle })
    await run('reverse.feature.add', { feature: slab('Plate', 0, 5) })
    const steps = undoLabels()
    const e = await refused('reverse.feature.update', { feature: 'Plate', set: { suppressed: true, visible: false, face: { body: 'Plate', face: 1 } } })
    expect(e.code).toBe('invalid_input')
    const plate = useReverse.getState().features.find((f) => f.name === 'Plate')!
    expect(plate.suppressed ?? false).toBe(false)
    expect(useReverse.getState().hiddenBodies).toEqual([])
    expect(undoLabels()).toEqual(steps)
    // Taken alone, they are.
    await run('reverse.feature.update', { feature: 'Plate', set: { suppressed: true } })
    expect(useReverse.getState().features.find((f) => f.name === 'Plate')!.suppressed).toBe(true)
  })
})

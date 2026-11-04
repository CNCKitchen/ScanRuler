// SPDX-License-Identifier: AGPL-3.0-only
// The map against an element is measured in the mesh worker, so after its
// inputs change it is not in step with them for a round trip. A command that
// reads it must wait for that, and not take the status for a refusal ("no
// map") or hand back the figures of the map before. On a 40 mm box, in the
// in-process worker — see commandKit.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { useDeviation } from '../src/state/deviationStore'
import { runCommand } from '../src/commands/registry'
import { boxMesh } from './helpers'
import { run, startHeadless, stlBytes, type Headless } from './commandKit'

let headless: Headless
beforeAll(async () => {
  headless = await startHeadless()
  await run('scan.open', { bytes: stlBytes(boxMesh(40, 40)), name: 'box.stl', discard: true })
})
afterAll(() => headless.stop())

const later = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Whether a promise has settled, without waiting for it. */
const settledAfter = async (p: Promise<unknown>, ms: number): Promise<boolean> => {
  let settled = false
  p.then(() => (settled = true), () => (settled = true))
  await later(ms)
  return settled
}

describe('a command that reads the map against an element', () => {
  it('waits for it while it is being measured, and reads what landed', async () => {
    useDeviation.setState({ source: 'element', elementStatus: 'running' })
    const state = runCommand('session.state', {}) as Promise<{ deviation: { map: string } }>
    // Not answered with the map as it stands.
    expect(await settledAfter(state, 150)).toBe(false)
    useDeviation.getState().failElementMap()
    const read = await state
    expect(read.deviation.map).toBe('idle')
  })

  it('does not take a map being measured for one that is not there', async () => {
    useDeviation.setState({ source: 'element', elementStatus: 'running' })
    const hotspots = runCommand('deviation.hotspots', {})
    const refusal = hotspots.then(() => null, (e: Error) => e)
    expect(await settledAfter(hotspots, 150)).toBe(false)
    // The measure failed: now it is refused for what it is.
    useDeviation.getState().failElementMap()
    expect((await refusal)?.message).toContain('no deviation map')
  })

  it('goes straight on when nothing is being measured', async () => {
    useDeviation.setState({ source: 'element', elementStatus: 'idle' })
    const started = Date.now()
    await runCommand('session.state', {})
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

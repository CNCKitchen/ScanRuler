// SPDX-License-Identifier: AGPL-3.0-only
// The map against an element is measured in the mesh worker, so after its
// inputs change it is not in step with them for a round trip. A command that
// reads it must wait for that, and not take the status for a refusal ("no
// map") or hand back the figures of the map before. On a 40 mm box, in the
// in-process worker — see commandKit.ts.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
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

  it('is not waited for by a reader of the reference map', async () => {
    // Measured again behind the reference map whenever its element changes:
    // nothing that reads the reference map waits on that.
    useDeviation.setState({ source: 'reference', elementStatus: 'running' })
    const hotspots = runCommand('deviation.hotspots', {})
    const refusal = hotspots.then(() => null, (e: Error) => e)
    expect(await settledAfter(hotspots, 1000)).toBe(true)
    // Refused at once for the map it reads, of which there is none here.
    expect((await refusal)?.message).toContain('no deviation map')
    useDeviation.getState().failElementMap()
  })

  // The mesh worker answers in order, so a map queued behind a long job — a
  // thickness map, a boolean — can be measured for longer than a command
  // waits. A read of the session says so; a command that acts on the map
  // gives up, as it waits for a map it needs.
  describe('past the wait, with the map still being measured', () => {
    afterEach(() => {
      vi.useRealTimers()
      useDeviation.getState().failElementMap()
    })
    /** Run a command with the clock run on past the 30 s wait. */
    const pastTheWait = async <T,>(name: string): Promise<T | Error> => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      useDeviation.setState({ source: 'element', elementStatus: 'running' })
      const answer = (runCommand(name, {}) as Promise<T>).then((v) => v, (e: Error) => e)
      await vi.advanceTimersByTimeAsync(31_000)
      return answer
    }

    it('session.state answers, the map said to be running', async () => {
      const read = await pastTheWait<{ deviation: { map: string; stats: unknown } }>('session.state')
      expect(read).not.toBeInstanceOf(Error)
      expect((read as { deviation: { map: string } }).deviation.map).toBe('running')
    })

    it('report.get answers too', async () => {
      const read = await pastTheWait<{ report: unknown }>('report.get')
      expect(read).not.toBeInstanceOf(Error)
      expect((read as { report: unknown }).report).toBeTruthy()
    })

    it('deviation.hotspots still gives up', async () => {
      const refusal = await pastTheWait('deviation.hotspots')
      expect(refusal).toBeInstanceOf(Error)
      expect((refusal as Error).message).toContain('Gave up waiting for the map against the element')
    })
  })

  it('goes straight on when nothing is being measured', async () => {
    useDeviation.setState({ source: 'element', elementStatus: 'idle' })
    const started = Date.now()
    await runCommand('session.state', {})
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

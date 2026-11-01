// SPDX-License-Identifier: AGPL-3.0-only
// Nothing waits for good: a worker request the worker never answers is let
// go after its time, and a command that never finishes is answered
// `timeout` — its history step ended and the next command run.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { commandRunning, useCommandActivity } from '../src/commands/activity'
import { registerCommands, runCommand } from '../src/commands/registry'
import { obj } from '../src/commands/schema'
import { sessionState } from '../src/commands/state'
import { CommandError, type Command } from '../src/commands/types'
import { WorkerRpc } from '../src/core/workerRpc'
import { clearHistory, historyBlocked, useHistory } from '../src/state/historyStore'
import { useStore } from '../src/state/store'
import { startHeadless, type Headless } from './commandKit'

class SilentWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onmessageerror: (() => void) | null = null
  messages: { requestId: number; type?: string }[] = []
  postMessage(message: { requestId: number; type?: string }): void { this.messages.push(message) }
  terminate(): void {}
  answer(requestId: number): void { this.onmessage?.({ data: { type: 'ok', requestId } }) }
}

describe('a worker request with a time limit', () => {
  afterEach(() => vi.useRealTimers())

  it('rejects, naming the request, when the worker never answers — and drops a late answer', async () => {
    vi.useFakeTimers()
    const worker = new SilentWorker()
    const rpc = new WorkerRpc(() => worker as unknown as Worker, 'Test worker')
    const stage = rpc.request({ requestId: 1, type: 'stage' } as { requestId: number }, [], 1_000)
    const failed = expect(stage).rejects.toThrow('Test worker did not answer the "stage" request in 1 s')
    await vi.advanceTimersByTimeAsync(1_001)
    await failed
    worker.answer(1)
    expect(rpc.dead).toBe(false)
  })

  it('starts the clock once the requests before it are answered, and leaves one without a limit alone', async () => {
    vi.useFakeTimers()
    const worker = new SilentWorker()
    const rpc = new WorkerRpc(() => worker as unknown as Worker, 'Test worker')
    const build = rpc.request<{ type: string }>({ requestId: 1, type: 'build' } as { requestId: number })
    const check = rpc.request<{ type: string }>({ requestId: 2, type: 'check' } as { requestId: number }, [], 1_000)
    // The build runs long; the check behind it is not late for that.
    await vi.advanceTimersByTimeAsync(5_000)
    worker.answer(1)
    expect((await build).type).toBe('ok')
    await vi.advanceTimersByTimeAsync(500)
    worker.answer(2)
    expect((await check).type).toBe('ok')
  })
})

describe('a command that never finishes', () => {
  const never: Command = {
    name: 'hang',
    title: 'Hang',
    description: 'Never finishes.',
    input: obj({}),
    timeoutMs: 40,
    run: (_input, ctx) =>
      new Promise((_resolve, reject) => {
        // Changes the session, then waits on what never answers.
        useStore.setState((s) => ({ nextNumber: s.nextNumber + 1 }))
        ctx.signal?.addEventListener('abort', () => aborted.push(ctx.signal!.reason))
        void reject
      }),
  }
  const bump: Command = {
    name: 'bump',
    title: 'Bump',
    description: 'Adds one.',
    input: obj({}),
    run: async () => {
      useStore.setState((s) => ({ nextNumber: s.nextNumber + 1 }))
      return { ok: true }
    },
  }
  const look: Command = {
    name: 'look',
    title: 'Look',
    description: 'Reads, and never answers.',
    input: obj({}),
    readOnly: true,
    timeoutMs: 20,
    run: () => new Promise(() => {}),
  }
  let aborted: unknown[] = []
  let off: () => void
  beforeEach(() => {
    aborted = []
    useStore.setState(useStore.getInitialState(), true)
    clearHistory()
    off = registerCommands('test', [never, bump, look])
  })
  afterEach(() => off())

  it('fails with timeout, tells the run to stop, and the next change runs with the history free', async () => {
    const hung = runCommand('test.hang').catch((e: unknown) => e)
    const next = runCommand('test.bump')
    const e = (await hung) as CommandError
    expect(e).toBeInstanceOf(CommandError)
    expect(e.code).toBe('timeout')
    expect(e.message).toMatch(/^test\.hang did not finish in 0\.04 s/)
    expect(aborted).toHaveLength(1)
    expect((aborted[0] as CommandError).code).toBe('timeout')
    expect(await next).toEqual({ ok: true })
    expect(commandRunning()).toBe(false)
    expect(historyBlocked()).toBe(false)
    // The hung command's change made before it was given up on is a step of
    // its own, which undo takes back.
    expect(useHistory.getState().past.map((p) => p.label)).toEqual(['Agent: hang', 'Agent: bump'])
  })

  it('lets the next change wait for one given up on that finishes late', async () => {
    const late: Command = {
      name: 'late',
      title: 'Late',
      description: 'Changes the session after its time.',
      input: obj({}),
      timeoutMs: 20,
      run: async () => {
        await new Promise((r) => setTimeout(r, 50))
        useStore.setState((s) => ({ nextDimensionId: s.nextDimensionId + 1 }))
      },
    }
    const slow: Command = {
      name: 'slow',
      title: 'Slow',
      description: 'Adds one, a little later.',
      input: obj({}),
      run: async () => {
        await new Promise((r) => setTimeout(r, 60))
        useStore.setState((s) => ({ nextNumber: s.nextNumber + 1 }))
      },
    }
    const offLate = registerCommands('later', [late, slow])
    try {
      const gaveUp = runCommand('later.late').catch((e: CommandError) => e)
      const next = runCommand('later.slow')
      expect(((await gaveUp) as CommandError).code).toBe('timeout')
      await next
      const step = useHistory.getState().past.find((p) => p.label === 'Agent: slow')!
      // The late change landed before the next began, not inside its step.
      expect(step.after.measure!.nextDimensionId).toBe(step.before.measure!.nextDimensionId)
      expect(step.after.measure!.nextNumber).toBe(step.before.measure!.nextNumber + 1)
    } finally { offLate() }
  })

  it('answers a read that never finishes with timeout too', async () => {
    const e = await runCommand('test.look').catch((x: CommandError) => x)
    expect((e as CommandError).code).toBe('timeout')
  })
})

describe('the session’s state while a command runs', () => {
  let headless: Headless
  beforeAll(async () => {
    headless = await startHeadless()
  })
  afterAll(() => headless.stop())

  it('says which command is running, since when and for how long', async () => {
    const seen: Record<string, unknown>[] = []
    const watch: Command = {
      name: 'watch',
      title: 'Watch',
      description: '',
      input: obj({}),
      history: false,
      run: async () => {
        await new Promise((r) => setTimeout(r, 15))
        seen.push(await sessionState())
        return null
      },
    }
    const stop = registerCommands('test', [watch])
    try {
      await runCommand('test.watch')
      const [state] = seen
      expect(state.running).toBe('test.watch')
      expect(Date.parse(String(state.runningSince))).toBeGreaterThan(0)
      expect(state.runningMs).toBeGreaterThanOrEqual(10)
      expect(useCommandActivity.getState().running).toBeNull()
      const idle = await sessionState()
      expect(idle.running).toBeNull()
      expect('runningMs' in idle).toBe(false)
    } finally {
      stop()
    }
  })
})

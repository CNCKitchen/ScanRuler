// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { ImportQueue } from '../src/app/importQueue'

describe('import ordering', () => {
  it('keeps a faster second import behind the complete first transaction', async () => {
    const queue = new ImportQueue()
    const events: string[] = []
    let release!: () => void
    const reading = new Promise<void>((resolve) => { release = resolve })
    const first = queue.run(async () => {
      events.push('read A')
      await reading
      events.push('commit A')
    })
    const second = queue.run(async () => { events.push('commit B') })
    await Promise.resolve()
    expect(queue.busy).toBe(true)
    expect(events).toEqual(['read A'])
    release()
    await Promise.all([first, second])
    expect(events).toEqual(['read A', 'commit A', 'commit B'])
  })

  it('continues with the next file after a failed import', async () => {
    const queue = new ImportQueue()
    const failed = queue.run(async () => { throw new Error('bad file') })
    const next = queue.run(async () => 'opened')
    await expect(failed).rejects.toThrow('bad file')
    await expect(next).resolves.toBe('opened')
  })

  it('notifies history controls when the queue becomes idle, including after failures', async () => {
    const queue = new ImportQueue()
    const states: boolean[] = []
    const unsubscribe = queue.subscribe(() => states.push(queue.busy))
    const failed = queue.run(async () => { throw new Error('bad file') })
    const next = queue.run(async () => {})
    await expect(failed).rejects.toThrow('bad file')
    await next
    expect(states).toEqual([true, true, true, false])
    unsubscribe()
    await queue.run(async () => {})
    expect(states).toHaveLength(4)
  })
})

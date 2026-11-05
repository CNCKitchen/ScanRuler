// SPDX-License-Identifier: AGPL-3.0-only
// What the commands wait on while the tab is hidden, where the browser
// draws no frames and slows timers to once a minute: a wait looks again
// whenever a store changes, not only on its timer — here with the timers
// stopped altogether — and a frame waited for is a task's turn and then
// one drawn by hand.

import { afterEach, describe, expect, it, vi } from 'vitest'
// The commands loaded first, as the app loads them: common.ts on its own
// meets the files' commands half made.
import '../src/commands/core'
import { registerBusy, watchSessionStores } from '../src/commands/activity'
import { nextFrame, waitFor } from '../src/commands/core/common'
import { useStore } from '../src/state/store'
import { create } from 'zustand'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('waits in a hidden tab', () => {
  it('looks again when one of the session’s stores changes, with no timer running', async () => {
    // As the command host names them (host.ts).
    const unwatch = watchSessionStores([useStore])
    useStore.setState({ statusText: '' })
    vi.useFakeTimers()
    let settled = false
    const waiting = waitFor(() => useStore.getState().statusText === 'ready', 'the status').then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    useStore.setState({ statusText: 'ready' })
    await waiting
    expect(settled).toBe(true)
    unwatch()
  })

  it('looks again when a store a plugin named for its busy check changes', async () => {
    const pluginStore = create(() => ({ busy: true }))
    const stop = registerBusy('waits-test', () => (pluginStore.getState().busy ? 'busy' : null), [pluginStore])
    vi.useFakeTimers()
    const waiting = waitFor(() => !pluginStore.getState().busy, 'the plugin')
    pluginStore.setState({ busy: false })
    await expect(waiting).resolves.toBe(true)
    stop()
  })

  it('times out on the timer, and stops watching once done', async () => {
    vi.useFakeTimers()
    const waiting = waitFor(() => false, 'nothing', 100)
    vi.advanceTimersByTime(200)
    await expect(waiting).rejects.toThrow('Gave up waiting for nothing')
  })

  it('takes a frame drawn by hand while the page is hidden, and the browser’s own while it is shown', async () => {
    const pumpFrame = vi.fn()
    vi.stubGlobal('document', { visibilityState: 'hidden' })
    vi.stubGlobal('requestAnimationFrame', () => {
      throw new Error('a hidden tab gets no animation frames')
    })
    await nextFrame({ pumpFrame })
    expect(pumpFrame).toHaveBeenCalledTimes(1)
    vi.stubGlobal('document', { visibilityState: 'visible' })
    vi.stubGlobal('requestAnimationFrame', (f: () => void) => setTimeout(f, 0))
    await nextFrame({ pumpFrame })
    expect(pumpFrame).toHaveBeenCalledTimes(1)
  })
})

describe('a frame waited for while the page is shown', () => {
  it('wakes the viewport first, so its frame is asked for ahead of the wait’s', async () => {
    vi.stubGlobal('document', { visibilityState: 'visible' })
    const asked: string[] = []
    vi.stubGlobal('requestAnimationFrame', (f: () => void) => {
      asked.push('wait')
      return setTimeout(f, 0)
    })
    await nextFrame({ pumpFrame: () => asked.push('pump'), wakeFrame: () => asked.push('wake') })
    expect(asked).toEqual(['wake', 'wait'])
  })
})

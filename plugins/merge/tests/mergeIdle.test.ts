// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mergeIdle } from '../app/mergeSession'
import { useMerge } from '../state/mergeStore'

afterEach(() => {
  vi.useRealTimers()
  useMerge.getState().setRunning(null)
})

describe('mergeIdle', () => {
  it('resolves at once when nothing runs', async () => {
    await expect(mergeIdle(10)).resolves.toBeUndefined()
  })

  it('resolves when the work in progress ends', async () => {
    vi.useFakeTimers()
    useMerge.getState().setRunning('Aligning the layer…')
    let done = false
    void mergeIdle(60_000).then(() => (done = true))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(done).toBe(false)
    useMerge.getState().setRunning(null)
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(true)
  })

  it('gives up after its time, the work still running', async () => {
    vi.useFakeTimers()
    useMerge.getState().setRunning('Merging the layers…')
    let done = false
    void mergeIdle(5_000).then(() => (done = true))
    await vi.advanceTimersByTimeAsync(4_999)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toBe(true)
    expect(useMerge.getState().running).toBe('Merging the layers…')
  })
})

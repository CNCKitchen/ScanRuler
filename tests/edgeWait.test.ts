// SPDX-License-Identifier: AGPL-3.0-only
// Waiting on an edge detection lets go of the store whatever becomes of the
// detection: done, failed, given up on by its caller, or its image gone.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { edgesSettled, useFlat } from '../src/state/flatStore'

function countListeners() {
  let live = 0
  const subscribe = useFlat.subscribe
  const spy = vi.spyOn(useFlat, 'subscribe').mockImplementation((listener) => {
    live++
    const stop = subscribe(listener)
    return () => {
      live--
      stop()
    }
  })
  return { live: () => live, spy }
}

describe('edgesSettled', () => {
  afterEach(() => vi.restoreAllMocks())

  it('settles and lets go when the edges are found', async () => {
    const { live } = countListeners()
    const wait = edgesSettled(useFlat.getState())
    useFlat.getState().resolveEdges(3)
    await wait
    expect(live()).toBe(0)
  })

  it('lets go when its caller gives up, though the edges never come', async () => {
    const { live } = countListeners()
    const abort = new AbortController()
    const wait = edgesSettled(useFlat.getState(), abort.signal)
    expect(live()).toBe(1)
    abort.abort()
    await expect(wait).rejects.toThrow()
    expect(live()).toBe(0)
  })

  it('settles when another image replaces the one being detected', async () => {
    const { live } = countListeners()
    const wait = edgesSettled(useFlat.getState())
    useFlat.setState((s) => ({ imageVersion: s.imageVersion + 1 }))
    await wait
    expect(live()).toBe(0)
  })
})

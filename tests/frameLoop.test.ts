// SPDX-License-Identifier: AGPL-3.0-only
// The viewport's frame loop: it runs while there is something to draw, sleeps
// after a run of idle frames, and wakes on the first sign of change.
import { describe, expect, it } from 'vitest'
import { FrameLoop, IDLE_FRAMES, type FrameScheduler } from '../src/viewer/frameLoop'

/** A stand-in for requestAnimationFrame: frames run only when `flush` says,
 *  one browser frame at a time. */
function fakeFrames() {
  let next = 1
  let queue = new Map<number, () => void>()
  const scheduler: FrameScheduler = {
    request: (cb) => {
      queue.set(next, cb)
      return next++
    },
    cancel: (id) => {
      queue.delete(id)
    },
  }
  /** Run `n` browser frames; how many callbacks ran. */
  const flush = (n = 1): number => {
    let ran = 0
    for (let i = 0; i < n; i++) {
      const due = queue
      queue = new Map()
      for (const cb of due.values()) {
        cb()
        ran++
      }
    }
    return ran
  }
  return { scheduler, flush, pending: () => queue.size }
}

describe('FrameLoop', () => {
  it('runs nothing until woken', () => {
    const f = fakeFrames()
    let steps = 0
    const loop = new FrameLoop(() => (steps++, false), f.scheduler)
    expect(loop.awake).toBe(false)
    expect(f.flush(5)).toBe(0)
    expect(steps).toBe(0)
  })

  it('sleeps after a run of idle frames, and asks for no frame while asleep', () => {
    const f = fakeFrames()
    let steps = 0
    const loop = new FrameLoop(() => (steps++, false), f.scheduler)
    loop.wake()
    expect(f.flush(IDLE_FRAMES + 10)).toBe(IDLE_FRAMES)
    expect(steps).toBe(IDLE_FRAMES)
    expect(loop.awake).toBe(false)
    expect(f.pending()).toBe(0)
  })

  it('stays awake while every frame has work, and counts the idle run from the last one', () => {
    const f = fakeFrames()
    let busy = 100
    const loop = new FrameLoop(() => busy-- > 0, f.scheduler)
    loop.wake()
    expect(f.flush(100)).toBe(100)
    expect(loop.awake).toBe(true)
    expect(f.flush(IDLE_FRAMES + 5)).toBe(IDLE_FRAMES)
    expect(loop.awake).toBe(false)
  })

  it('a wake mid-run starts the idle count over', () => {
    const f = fakeFrames()
    const loop = new FrameLoop(() => false, f.scheduler)
    loop.wake()
    f.flush(IDLE_FRAMES - 1)
    loop.wake()
    expect(f.flush(IDLE_FRAMES + 5)).toBe(IDLE_FRAMES)
  })

  it('wakes again after sleeping, one frame a frame however often it is woken', () => {
    const f = fakeFrames()
    let steps = 0
    const loop = new FrameLoop(() => (steps++, false), f.scheduler)
    loop.wake()
    f.flush(IDLE_FRAMES)
    expect(loop.awake).toBe(false)
    loop.wake()
    loop.wake()
    loop.wake()
    expect(f.pending()).toBe(1)
    expect(f.flush(1)).toBe(1)
  })

  it('a wake from inside a step does not ask for a second frame', () => {
    const f = fakeFrames()
    const loop: FrameLoop = new FrameLoop(() => (loop.wake(), false), f.scheduler)
    loop.wake()
    f.flush(1)
    expect(f.pending()).toBe(1)
  })

  it('stops for good: no frame after, and a wake does nothing', () => {
    const f = fakeFrames()
    const loop = new FrameLoop(() => true, f.scheduler)
    loop.wake()
    f.flush(3)
    loop.stop()
    expect(f.pending()).toBe(0)
    loop.wake()
    expect(f.flush(3)).toBe(0)
  })
})

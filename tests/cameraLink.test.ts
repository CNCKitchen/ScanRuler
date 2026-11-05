// SPDX-License-Identifier: AGPL-3.0-only
// Two views held in one pose, each with a frame loop that sleeps while
// nothing changes in it: whichever half is moved has to wake the other, or
// the half polling the link stands still while its partner is dragged.
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { CameraLink, type LinkedView } from '../src/viewer/cameraLink'

/** A view whose invalidate tells its watchers, as OrthoViewport's does, and
 *  which counts the times it was woken. */
function fakeView() {
  const watchers = new Set<() => void>()
  let extents = { halfW: 10, halfH: 10 }
  const view = {
    camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100),
    target: new THREE.Vector3(),
    extents: () => extents,
    setExtents: (halfW: number, halfH: number) => {
      extents = { halfW, halfH }
    },
    invalidate: () => {
      for (const fn of watchers) fn()
    },
    woken: 0,
    wake: () => {
      view.woken++
    },
    watch: (fn: () => void) => {
      watchers.add(fn)
      return () => watchers.delete(fn)
    },
    watchers,
  }
  view.camera.position.set(0, 0, 10)
  return view satisfies LinkedView
}

describe('CameraLink waking', () => {
  it('wakes each half when the other is marked for drawing', () => {
    const a = fakeView()
    const b = fakeView()
    new CameraLink(a, b)
    const [wa, wb] = [a.woken, b.woken]
    a.invalidate()
    expect(b.woken).toBe(wb + 1)
    expect(a.woken).toBe(wa)
    b.invalidate()
    expect(a.woken).toBe(wa + 1)
  })

  it('a gesture on one half carries to the other on the tick it wakes', () => {
    const a = fakeView()
    const b = fakeView()
    const link = new CameraLink(a, b)
    a.camera.position.set(5, 0, 10)
    a.invalidate()
    link.tick()
    expect(b.camera.position.x).toBeCloseTo(5)
  })

  it('wakes nothing once disposed, and lets go of both views', () => {
    const a = fakeView()
    const b = fakeView()
    const link = new CameraLink(a, b)
    link.dispose()
    const [wa, wb] = [a.woken, b.woken]
    a.invalidate()
    b.invalidate()
    expect([a.woken, b.woken]).toEqual([wa, wb])
    expect([a.watchers.size, b.watchers.size]).toEqual([0, 0])
  })
})

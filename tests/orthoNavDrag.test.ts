// SPDX-License-Identifier: AGPL-3.0-only
// Whether the navigator says a drag is moving the view — what the viewport
// holds its hover test back for. A button held is not yet a drag: it may be
// a click, and a click must not put out what is lit under the cursor.
import * as THREE from 'three'
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrthoNavigator } from '../src/viewer/orthoNav'

type Listener = (e: Partial<PointerEvent> & { preventDefault?: () => void }) => void

describe('a drag moving the view', () => {
  let on: Record<string, Listener[]>
  let nav: OrthoNavigator

  const fire = (type: string, e: Partial<PointerEvent>) => {
    for (const l of on[type] ?? []) l({ pointerType: 'mouse', shiftKey: false, ctrlKey: false, altKey: false, preventDefault: () => {}, ...e })
  }
  const listen = (type: string, l: Listener) => {
    ;(on[type] ??= []).push(l)
  }

  beforeEach(() => {
    on = {}
    // The canvas and the document both report to the same table: the
    // navigator takes presses on the one and moves on the other.
    vi.stubGlobal('document', { addEventListener: listen, removeEventListener: () => {} })
    const canvas = {
      addEventListener: listen,
      removeEventListener: () => {},
      clientHeight: 600,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    } as unknown as HTMLCanvasElement
    const camera = new THREE.OrthographicCamera(-4 / 3, 4 / 3, 1, -1, 0.01, 100)
    camera.position.set(0, 0, 10)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld()
    const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))
    cube.updateMatrixWorld()
    nav = new OrthoNavigator(camera, { target: new THREE.Vector3(), update: () => {} } as unknown as OrbitControls, canvas, () => [cube], {
      center: new THREE.Vector3(),
      radius: 1,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is an orbit past its threshold, not a button held, and ends with the release', () => {
    fire('pointerdown', { buttons: 1, clientX: 400, clientY: 300 })
    expect(nav.navigating()).toBe(false)
    fire('pointermove', { buttons: 1, clientX: 401, clientY: 300 })
    expect(nav.navigating()).toBe(false) // within a click's wobble
    fire('pointermove', { buttons: 1, clientX: 420, clientY: 300 })
    expect(nav.navigating()).toBe(true)
    fire('pointerup', { buttons: 0, clientX: 420, clientY: 300 })
    expect(nav.navigating()).toBe(false)
  })

  it('is a pan that went somewhere', () => {
    fire('pointerdown', { buttons: 2, clientX: 400, clientY: 300 })
    expect(nav.navigating()).toBe(false)
    fire('pointermove', { buttons: 2, clientX: 410, clientY: 305 })
    expect(nav.navigating()).toBe(true)
    fire('pointerup', { buttons: 0, clientX: 410, clientY: 305 })
    expect(nav.navigating()).toBe(false)
  })

  it('is not the wheel', () => {
    fire('wheel', { deltaY: -100, clientX: 400, clientY: 300 } as Partial<WheelEvent>)
    expect(nav.navigating()).toBe(false)
  })

  it('is a finger turning the part until the last one is lifted', () => {
    fire('pointerdown', { pointerType: 'touch', pointerId: 7, clientX: 400, clientY: 300 })
    fire('pointermove', { pointerType: 'touch', pointerId: 7, clientX: 430, clientY: 300 })
    expect(nav.navigating()).toBe(true)
    fire('pointerup', { pointerType: 'touch', pointerId: 7, clientX: 430, clientY: 300 })
    expect(nav.navigating()).toBe(false)
  })
})

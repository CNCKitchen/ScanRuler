// SPDX-License-Identifier: AGPL-3.0-only
import * as THREE from 'three'
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrthoNavigator } from '../src/viewer/orthoNav'
import { isSpaceMouse, spaceMouseAxis, type SpaceMouseMotion } from '../src/viewer/spaceMouse'

describe('SpaceMouse device match', () => {
  it('takes the ids Chrome and Edge give 3Dconnexion pucks', () => {
    expect(isSpaceMouse('SpaceMouse Compact (Vendor: 256f Product: c635)')).toBe(true)
    expect(isSpaceMouse('3Dconnexion SpaceMouse Pro Wireless (Vendor: 256f Product: c632)')).toBe(true)
    expect(isSpaceMouse('SpaceNavigator (Vendor: 046d Product: c626)')).toBe(true)
    // Unnamed, known by its USB ids alone.
    expect(isSpaceMouse('Unknown Gamepad (Vendor: 256f Product: c652)')).toBe(true)
  })

  it('leaves gamepads alone, Logitech ones included', () => {
    expect(isSpaceMouse('Xbox 360 Controller (XInput STANDARD GAMEPAD)')).toBe(false)
    expect(isSpaceMouse('Logitech Gamepad F310 (Vendor: 046d Product: c216)')).toBe(false)
  })
})

describe('SpaceMouse axis', () => {
  it('is still inside the deadzone and starts from zero past it', () => {
    expect(spaceMouseAxis(0.05)).toBe(0)
    expect(spaceMouseAxis(-0.079)).toBe(0)
    expect(spaceMouseAxis(0.081)).toBeGreaterThan(0)
    expect(spaceMouseAxis(0.081)).toBeLessThan(0.01)
  })

  it('reaches full deflection at the stop, both ways, and no further', () => {
    expect(spaceMouseAxis(1)).toBe(1)
    expect(spaceMouseAxis(-1)).toBe(-1)
    expect(spaceMouseAxis(1.2)).toBe(1)
  })

  it('reads a missing axis as at rest', () => {
    expect(spaceMouseAxis(undefined)).toBe(0)
  })
})

/** A browser with one puck in it, not yet shown to the page, and a clock that
 *  only moves when told to. The module is loaded fresh for each test: what
 *  device is attached and which viewport has it is module state. */
describe('SpaceMouse routing', () => {
  let now = 1000
  let listeners: Record<string, ((e: { gamepad: Gamepad }) => void)[]>
  let pads: (Gamepad | null)[]
  let puck: { id: string; index: number; connected: boolean; axes: number[] }
  let sm: typeof import('../src/viewer/spaceMouse')

  const fire = (type: string, gamepad: object) => {
    for (const l of listeners[type] ?? []) l({ gamepad: gamepad as Gamepad })
  }
  const plugIn = () => {
    pads[puck.index] = puck as unknown as Gamepad
    fire('gamepadconnected', puck)
  }
  const tick = (ms = 16) => {
    now += ms
  }

  beforeEach(async () => {
    now = 1000
    listeners = {}
    pads = [null, null]
    puck = { id: 'SpaceMouse Compact (Vendor: 256f Product: c635)', index: 1, connected: true, axes: [0, 0, 0, 0, 0, 0] }
    vi.stubGlobal('window', {
      addEventListener: (type: string, l: (e: { gamepad: Gamepad }) => void) => {
        ;(listeners[type] ??= []).push(l)
      },
    })
    vi.stubGlobal('navigator', { getGamepads: () => pads })
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.resetModules()
    sm = await import('../src/viewer/spaceMouse')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('reads nothing until the browser reports a puck', () => {
    sm.listenForSpaceMouse()
    expect(sm.spaceMouseAttached()).toBe(false)
    fire('gamepadconnected', { id: 'Xbox 360 Controller (XInput STANDARD GAMEPAD)', index: 0, connected: true })
    expect(sm.spaceMouseAttached()).toBe(false)
    plugIn()
    expect(sm.spaceMouseAttached()).toBe(true)
    puck.connected = false
    fire('gamepaddisconnected', puck)
    expect(sm.spaceMouseAttached()).toBe(false)
  })

  it('finds a puck the page was shown before it started listening', () => {
    pads[puck.index] = puck as unknown as Gamepad
    sm.listenForSpaceMouse()
    expect(sm.spaceMouseAttached()).toBe(true)
  })

  it('gives motion, scaled by the frame time, only while the puck is moved', () => {
    sm.listenForSpaceMouse()
    plugIn()
    const view = {}
    tick()
    expect(sm.readSpaceMouse(view, true)).toBeNull()
    puck.axes = [0, 1, 0, 0, -1, 0.5]
    tick()
    const m = sm.readSpaceMouse(view, true)!
    expect(m.dt).toBeCloseTo(0.016)
    expect(m.ty).toBe(1)
    expect(m.rz).toBeGreaterThan(0)
    // Roll is not read, and does not leak into the tilt.
    expect(m.rx).toBe(0)
    expect(Object.keys(m).sort()).toEqual(['dt', 'rx', 'rz', 'tx', 'ty', 'tz'])
    // A stalled tab does not fling the view.
    tick(5000)
    expect(sm.readSpaceMouse(view, true)!.dt).toBe(0.1)
  })

  it('drives one viewport at a time, the one last aimed at', () => {
    sm.listenForSpaceMouse()
    plugIn()
    puck.axes = [1, 0, 0, 0, 0, 0]
    const main = {}
    const other = {}
    sm.aimSpaceMouse(main)
    sm.aimSpaceMouse(other)
    tick()
    expect(sm.readSpaceMouse(main, true)).toBeNull()
    expect(sm.readSpaceMouse(other, true)).not.toBeNull()
    sm.aimSpaceMouse(main)
    tick()
    expect(sm.readSpaceMouse(other, true)).toBeNull()
    expect(sm.readSpaceMouse(main, true)).not.toBeNull()
  })

  it('passes from a hidden or closed viewport to the next one in view', () => {
    sm.listenForSpaceMouse()
    plugIn()
    puck.axes = [1, 0, 0, 0, 0, 0]
    const main = {}
    const sheet = {}
    sm.aimSpaceMouse(main)
    // The 3D view hidden behind another workspace lets go.
    tick()
    expect(sm.readSpaceMouse(main, false)).toBeNull()
    expect(sm.readSpaceMouse(sheet, true)).not.toBeNull()
    // And the workspace closing hands it back.
    sm.releaseSpaceMouse(sheet)
    tick()
    expect(sm.readSpaceMouse(main, true)).not.toBeNull()
    // Releasing a viewport that does not have it changes nothing.
    sm.releaseSpaceMouse(sheet)
    tick()
    expect(sm.readSpaceMouse(main, true)).not.toBeNull()
  })

  it('holds the wheel off only just after the puck has moved', () => {
    sm.listenForSpaceMouse()
    expect(sm.spaceMouseBusy()).toBe(false)
    plugIn()
    const view = {}
    tick()
    sm.readSpaceMouse(view, true)
    expect(sm.spaceMouseBusy()).toBe(false)
    puck.axes = [0, 0.5, 0, 0, 0, 0]
    tick()
    sm.readSpaceMouse(view, true)
    expect(sm.spaceMouseBusy()).toBe(true)
    tick(150)
    expect(sm.spaceMouseBusy()).toBe(false)
  })

  it('moves on to a second puck when the first is unplugged', () => {
    const first = { ...puck, id: 'SpaceNavigator (Vendor: 046d Product: c626)', index: 0, axes: [0, 0, 0, 0, 0, 0] }
    pads[0] = first as unknown as Gamepad
    pads[1] = puck as unknown as Gamepad
    sm.listenForSpaceMouse()
    const view = {}
    puck.axes = [1, 0, 0, 0, 0, 0]
    tick()
    expect(sm.readSpaceMouse(view, true)).toBeNull()
    first.connected = false
    fire('gamepaddisconnected', first)
    expect(sm.spaceMouseAttached()).toBe(true)
    tick()
    expect(sm.readSpaceMouse(view, true)?.tx).toBe(1)
  })
})

/** The navigator flying a camera from puck motion, on a stub canvas: an
 *  800 × 600 viewport looking down −Z at a unit cube, two millimetres of it
 *  tall on screen. */
describe('SpaceMouse flying the camera', () => {
  let now = 1000
  let camera: THREE.OrthographicCamera
  let controls: { target: THREE.Vector3; update: () => void }
  let nav: OrthoNavigator

  const motion = (m: Partial<SpaceMouseMotion>): SpaceMouseMotion => ({ dt: 0.1, tx: 0, ty: 0, tz: 0, rx: 0, rz: 0, ...m })

  beforeEach(() => {
    now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.stubGlobal('document', { addEventListener: () => {}, removeEventListener: () => {} })
    const canvas = {
      addEventListener: () => {},
      removeEventListener: () => {},
      clientHeight: 600,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    } as unknown as HTMLCanvasElement
    camera = new THREE.OrthographicCamera(-4 / 3, 4 / 3, 1, -1, 0.01, 100)
    camera.position.set(0, 0, 10)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld()
    controls = { target: new THREE.Vector3(), update: () => {} }
    const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))
    cube.updateMatrixWorld()
    nav = new OrthoNavigator(
      camera,
      controls as unknown as OrbitControls,
      canvas,
      () => [cube],
      { center: new THREE.Vector3(), radius: 1 },
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('pans by view heights per second, camera and target together', () => {
    nav.stepSpaceMouse(motion({ tx: 1, tz: -0.5 }))
    // 2 mm tall × 1.2 view heights a second × 0.1 s.
    expect(camera.position.x).toBeCloseTo(0.24)
    expect(camera.position.y).toBeCloseTo(-0.12)
    expect(controls.target.x).toBeCloseTo(0.24)
    expect(controls.target.y).toBeCloseTo(-0.12)
  })

  it('zooms in when pushed forward, by the same speed at any zoom', () => {
    nav.stepSpaceMouse(motion({ ty: 1 }))
    expect(camera.zoom).toBeCloseTo(Math.exp(0.25))
    nav.stepSpaceMouse(motion({ ty: -1 }))
    expect(camera.zoom).toBeCloseTo(1)
  })

  it('turns the way BumpMesh does, about the surface at the screen centre', () => {
    nav.stepSpaceMouse(motion({ rz: 1 }))
    // Twist swings the camera round the screen vertical towards +X ...
    expect(camera.position.x).toBeGreaterThan(0)
    expect(camera.position.y).toBeCloseTo(0)
    // ... about the cube's face under the centre, which stays there.
    const pivot = new THREE.Vector3(0, 0, 0.5).project(camera)
    expect(pivot.x).toBeCloseTo(0)
    expect(pivot.y).toBeCloseTo(0)
    expect(camera.getWorldDirection(new THREE.Vector3()).angleTo(new THREE.Vector3(0, 0, -1))).toBeCloseTo(0.24)
    expect(nav.pivotMarker.visible).toBe(true)

    // Tilt swings it down round the screen horizontal.
    const before = camera.position.clone()
    nav.stepSpaceMouse(motion({ rx: 1 }))
    expect(camera.position.y).toBeLessThan(before.y)
    // The up vector turns with the camera: the free orbit has no world up.
    expect(camera.up.dot(camera.getWorldDirection(new THREE.Vector3()))).toBeCloseTo(0)
  })

  it('lets the pivot go once the puck has settled', () => {
    nav.stepSpaceMouse(motion({ rz: 1 }))
    now += 100
    nav.stepSpaceMouse(null)
    expect(nav.pivotMarker.visible).toBe(true)
    now += 200
    nav.stepSpaceMouse(null)
    expect(nav.pivotMarker.visible).toBe(false)
  })

  it('does not turn a flat sheet, and still pans and zooms it', () => {
    nav.setPlanar(true)
    nav.stepSpaceMouse(motion({ rx: 1, rz: 1, tx: 1, ty: 1 }))
    expect(camera.getWorldDirection(new THREE.Vector3()).z).toBeCloseTo(-1)
    expect(camera.position.x).toBeCloseTo(0.24)
    expect(camera.zoom).toBeGreaterThan(1)
    expect(nav.pivotMarker.visible).toBe(false)
  })
})

// SPDX-License-Identifier: AGPL-3.0-only
// Marking on a point cloud: the brush takes the points within its radius, the
// window and the lasso take the visible, camera-facing points they enclose.

import { afterEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { PointGrid } from '../src/core/geometry/pointGrid'
import { brushCloud, marqueeCloud } from '../src/viewer/cloudMarking'
import { SurfaceMarking, type MarkingContext } from '../src/viewer/marking'
import { RegionColors } from '../src/viewer/regionColors'
import { blockWithBoreCloud, planeCloud } from './cloudFixtures'

describe('brushCloud', () => {
  it('takes a point just inside the radius and leaves one just outside', () => {
    const positions = Float32Array.from([0, 0, 0, 2.9, 0, 0, 3.1, 0, 0])
    expect(brushCloud(new PointGrid(positions, 1), [0, 0, 0], 3).sort()).toEqual([0, 1])
  })

  it('marks exactly the points within the radius', () => {
    const { positions } = planeCloud({ size: 4, step: 0.5 })
    const grid = new PointGrid(positions, 1)
    const centre: [number, number, number] = [0.2, -0.1, 0]
    const radius = 1.1
    const got = brushCloud(grid, centre, radius).sort((a, b) => a - b)
    const want: number[] = []
    for (let i = 0; i < positions.length / 3; i++) {
      const d = Math.hypot(positions[3 * i] - centre[0], positions[3 * i + 1] - centre[1], positions[3 * i + 2] - centre[2])
      if (d <= radius) want.push(i)
    }
    expect(want.length).toBeGreaterThan(5)
    expect(got).toEqual(want)
  })
})

/** Looking down -z from +z at the part, one world unit a pixel, 100 x 100. */
function topCamera(): THREE.OrthographicCamera {
  const cam = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 1000)
  cam.position.set(0, 0, 100)
  cam.updateMatrixWorld()
  return cam
}

const box = (positions: Float32Array, normals: Float32Array, outline: { x: number; y: number }[], backfaces = false, step = 1) =>
  marqueeCloud({
    positions,
    normals,
    spacing: step,
    camera: topCamera(),
    partMatrix: new THREE.Matrix4(),
    width: 100,
    height: 100,
    outline,
    backfaces,
    clip: [],
  })

describe('marqueeCloud', () => {
  const { positions, normals } = blockWithBoreCloud({ size: [10, 10, 10], boreRadius: 0.1, step: 1 })
  // The whole screen as a window: x,y in pixels, centre at (50, 50).
  const all = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]

  it('window takes the near face and not the far one', () => {
    const got = box(positions, normals, all)
    expect(got.length).toBeGreaterThan(50)
    for (const i of got) expect(positions[3 * i + 2]).toBeGreaterThan(0) // never the -z face
    // the whole +z face is in it
    let face = 0
    for (let i = 0; i < positions.length / 3; i++) if (positions[3 * i + 2] === 5 && normals[3 * i + 2] === 1) face++
    expect(got.filter((i) => positions[3 * i + 2] === 5 && normals[3 * i + 2] === 1).length).toBe(face)
  })

  it('takes only points facing the camera', () => {
    const got = box(positions, normals, all)
    for (const i of got) expect(normals[3 * i + 2]).toBeGreaterThan(0)
  })

  it('a plane tilted steeply to the view is taken, a parallel plane behind it is not', () => {
    for (const deg of [70, 75]) {
      const a = (deg * Math.PI) / 180
      const t = [Math.cos(a), 0, -Math.sin(a)] // tangent; normal (sin a, 0, cos a)
      const p: number[] = [], nn: number[] = []
      for (let u = -10; u <= 10; u += 0.5)
        for (let v = -10; v <= 10; v += 0.5) {
          p.push(u * t[0], v, u * t[2])
          nn.push(Math.sin(a), 0, Math.cos(a))
        }
      const nTilted = p.length / 3
      for (let x = -10; x <= 10; x += 0.5)
        for (let y = -10; y <= 10; y += 0.5) {
          p.push(x, y, -30)
          nn.push(0, 0, 1)
        }
      const pos = Float32Array.from(p), nor = Float32Array.from(nn)
      // a window across the tilted plane's footprint (x within +-3 world)
      const win = [{ x: 47, y: 0 }, { x: 53, y: 0 }, { x: 53, y: 100 }, { x: 47, y: 100 }]
      const got = new Set(box(pos, nor, win, false, 0.5))
      let inWin = 0, taken = 0
      for (let i = 0; i < nTilted; i++) {
        if (Math.abs(pos[3 * i]) > 3) continue
        inWin++
        if (got.has(i)) taken++
      }
      expect(inWin).toBeGreaterThan(100)
      expect(taken / inWin).toBeGreaterThanOrEqual(0.95)
      for (let i = nTilted; i < pos.length / 3; i++) expect(got.has(i)).toBe(false)
    }
  })

  it('under a rotated and moved alignment the window takes the same near-face points', () => {
    const m = new THREE.Matrix4().makeTranslation(12, -7, 0).multiply(new THREE.Matrix4().makeRotationZ(0.5))
    const got = marqueeCloud({
      positions, normals, spacing: 1, camera: topCamera(), partMatrix: m, width: 100, height: 100, outline: all, backfaces: false, clip: [],
    })
    const want: number[] = []
    for (let i = 0; i < positions.length / 3; i++) if (positions[3 * i + 2] === 5 && normals[3 * i + 2] === 1) want.push(i)
    expect(got.sort((a, b) => a - b)).toEqual(want)
  })

  it('a clip plane takes away what it cuts', () => {
    // keep x <= 0 (world)
    const clip = [new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0)]
    const got = marqueeCloud({
      positions, normals, spacing: 1, camera: topCamera(), partMatrix: new THREE.Matrix4(), width: 100, height: 100, outline: all, backfaces: false, clip,
    })
    const want: number[] = []
    for (let i = 0; i < positions.length / 3; i++) if (positions[3 * i + 2] === 5 && normals[3 * i + 2] === 1 && positions[3 * i] <= 0) want.push(i)
    expect(want.length).toBeGreaterThan(10)
    expect(got.sort((a, b) => a - b)).toEqual(want)
  })

  it('through takes the far face as well', () => {
    const got = box(positions, normals, all, true)
    expect(got.some((i) => positions[3 * i + 2] === -5)).toBe(true)
  })

  it('without facing, a point behind another is still hidden', () => {
    // Every normal flipped to face the camera: depth alone must hide the far face.
    const flipped = new Float32Array(normals.length)
    for (let i = 0; i < flipped.length; i += 3) flipped[i + 2] = 1
    const got = box(positions, flipped, all)
    expect(got.some((i) => positions[3 * i + 2] === -5)).toBe(false)
    expect(got.some((i) => positions[3 * i + 2] === 5)).toBe(true)
  })

  it('a facing surface close behind the near one: taken within the tolerance, left past it', () => {
    // Two planes facing the camera, spacing 0.5 (a pixel is a world unit
    // here): the front at z = 0, the other a little behind it. The window
    // takes the front whole; a plane within a spacing and a half and two
    // pixels behind is taken with it — a splat's depth on screen does not
    // tell them apart — and one past that is left.
    const sheet = (z: number) => {
      const p: number[] = []
      for (let x = -10; x <= 10; x += 0.5) for (let y = -10; y <= 10; y += 0.5) p.push(x, y, z)
      return p
    }
    const tolerance = 1.5 * 0.5 + 2 * 1
    for (const [behind, taken] of [[0.5 * tolerance, true], [1.5 * tolerance, false]] as const) {
      const front = sheet(0)
      const pos = Float32Array.from([...front, ...sheet(-behind)])
      const nor = new Float32Array(pos.length)
      for (let i = 2; i < nor.length; i += 3) nor[i] = 1
      const got = new Set(box(pos, nor, all, false, 0.5))
      const nFront = front.length / 3
      for (let i = 0; i < nFront; i++) expect(got.has(i), `front ${i}`).toBe(true)
      let back = 0
      for (let i = nFront; i < pos.length / 3; i++) if (got.has(i)) back++
      expect(back, `${behind} behind`).toBe(taken ? nFront : 0)
    }
  })

  it('lasso takes only the points inside the polygon', () => {
    // Triangle (40,60) (60,60) (60,40) px: the corner where x >= 0 and y <= 0
    // of the +z face, below the line x = -y... i.e. px + py >= 100.
    const poly = [{ x: 40, y: 60 }, { x: 60, y: 60 }, { x: 60, y: 40 }]
    const got = box(positions, normals, poly)
    expect(got.length).toBeGreaterThan(5)
    for (const i of got) {
      const px = 50 + positions[3 * i]
      const py = 50 - positions[3 * i + 1]
      expect(px).toBeLessThanOrEqual(60 + 1e-6)
      expect(py).toBeLessThanOrEqual(60 + 1e-6)
      expect(px + py).toBeGreaterThanOrEqual(100 - 1e-6)
    }
    // and every near-face point inside it is taken
    let want = 0
    for (let i = 0; i < positions.length / 3; i++) {
      if (positions[3 * i + 2] !== 5 || normals[3 * i + 2] !== 1) continue
      const px = 50 + positions[3 * i], py = 50 - positions[3 * i + 1]
      if (px <= 60 && py <= 60 && px + py >= 100) want++
    }
    expect(got.length).toBe(want)
  })
})

describe('the brush through SurfaceMarking', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('marks the points near the one under the cursor, facing the same way', () => {
    const el = () => ({ setAttribute: vi.fn(), append: vi.fn(), remove: vi.fn(), style: { display: '', setProperty: vi.fn() } })
    vi.stubGlobal('document', { createElementNS: () => el(), addEventListener: vi.fn(), removeEventListener: vi.fn() })
    const { positions, normals } = blockWithBoreCloud({ size: [10, 10, 10], boreRadius: 0.1, step: 1 })
    // Pick the +z face point at (0, 0, 5); the -z face is 10 away, other faces
    // within 1 of the edge are off the brush's reach and face another way.
    let top = -1
    for (let i = 0; i < positions.length / 3; i++) if (positions[3 * i] === 1 && positions[3 * i + 1] === 0 && positions[3 * i + 2] === 5 && normals[3 * i + 2] === 1) top = i
    expect(top).toBeGreaterThanOrEqual(0)
    const marked = new Set<number>()
    const ctx = {
      container: { appendChild: vi.fn(), clientWidth: 100, clientHeight: 100, getBoundingClientRect: () => ({ left: 0, top: 0 }) },
      camera: () => topCamera(),
      worldPerPixel: () => 1,
      partGroup: new THREE.Group(),
      raycaster: { intersectObject: () => [{ index: top }] },
      regions: { paintCount: 0, markVertex: (v: number) => marked.add(v) },
      setPickRay: vi.fn(),
      mesh: () => null,
      cloud: () => ({ object: { visible: true }, grid: new PointGrid(positions, 2), normals, spacing: 1 }),
      paintAttr: () => ({ needsUpdate: false }),
      graphVertex: (v: number) => v,
      setPaintColor: vi.fn(),
      invalidate: vi.fn(),
      claimDrag: vi.fn(),
      navigates: () => false,
      requestHover: vi.fn(),
      onPaintChange: vi.fn(),
    } as unknown as MarkingContext
    const marking = new SurfaceMarking(ctx)
    marking.setPaintBrush({ color: '#fff', diameter: 6, erase: false, gesture: 'brush' })
    expect(marking.handlePointerDown({ button: 0, buttons: 1, clientX: 50, clientY: 50, pointerType: 'mouse' } as PointerEvent)).toBe(true)
    marking.drainStroke()
    expect(marked.size).toBeGreaterThan(5)
    for (const v of marked) {
      expect(normals[3 * v + 2]).toBe(1)
      expect(Math.hypot(positions[3 * v] - 1, positions[3 * v + 1], positions[3 * v + 2] - 5)).toBeLessThanOrEqual(4 + 1e-6)
    }
    expect(marked.has(top)).toBe(true)
  })

  it('inverts the marking over every point of a cloud', () => {
    const el = () => ({ setAttribute: vi.fn(), append: vi.fn(), remove: vi.fn(), style: { display: '', setProperty: vi.fn() } })
    vi.stubGlobal('document', { createElementNS: () => el(), addEventListener: vi.fn(), removeEventListener: vi.fn() })
    const n = 10
    const positions = new Float32Array(n * 3)
    const normals = new Float32Array(n * 3)
    // The scene's own colour book over the cloud's buffers: the mask it
    // inverts is the paint attribute's array.
    const mask = new Uint8Array(n)
    const regions = new RegionColors([200, 200, 200])
    regions.attach(new Uint8Array(n * 3), mask, new Uint8Array(n))
    regions.setPaintedVertices(Uint32Array.from([2, 5]))
    expect(regions.paintCount).toBe(2)
    const attr = { needsUpdate: false }
    const onPaintChange = vi.fn()
    const ctx = {
      container: { appendChild: vi.fn(), clientWidth: 100, clientHeight: 100, getBoundingClientRect: () => ({ left: 0, top: 0 }) },
      camera: () => topCamera(),
      worldPerPixel: () => 1,
      partGroup: new THREE.Group(),
      raycaster: { intersectObject: () => [] },
      regions,
      setPickRay: vi.fn(),
      mesh: () => null,
      cloud: () => ({ object: { visible: true }, grid: new PointGrid(positions, 1), normals, spacing: 1 }),
      paintAttr: () => attr,
      graphVertex: (v: number) => v,
      setPaintColor: vi.fn(),
      invalidate: vi.fn(),
      claimDrag: vi.fn(),
      navigates: () => false,
      requestHover: vi.fn(),
      onPaintChange,
    } as unknown as MarkingContext
    const marking = new SurfaceMarking(ctx)
    marking.setPaintBrush({ color: '#fff', diameter: 6, erase: false, gesture: 'brush' })
    marking.invertPaint()
    expect([...mask]).toEqual([1, 1, 0, 1, 1, 0, 1, 1, 1, 1])
    expect(regions.paintCount).toBe(8)
    expect(attr.needsUpdate).toBe(true)
    expect(onPaintChange).toHaveBeenCalledWith(8)
  })
})

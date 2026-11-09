// SPDX-License-Identifier: AGPL-3.0-only
// Marking on a point cloud: the brush takes the points within its radius, the
// window and the lasso take the visible, camera-facing points they enclose.

import { afterEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { PointGrid } from '../src/core/geometry/pointGrid'
import { brushCloud, marqueeCloud } from '../src/viewer/cloudMarking'
import { SurfaceMarking, type MarkingContext } from '../src/viewer/marking'
import { blockWithBoreCloud, planeCloud } from './cloudFixtures'

describe('brushCloud', () => {
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

  it('side faces seen edge-on are not taken, hidden ones not either', () => {
    const got = box(positions, normals, all)
    for (const i of got) expect(normals[3 * i + 2]).toBeGreaterThan(0)
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
})

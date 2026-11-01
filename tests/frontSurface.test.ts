// SPDX-License-Identifier: AGPL-3.0-only
import * as THREE from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { frontSurface } from '../src/viewer/frontSurface'
import { SurfaceMarking, type MarkingContext } from '../src/viewer/marking'

/** A flat grid of cells on the screen at one depth, two triangles a cell,
 *  wound alike. Screen units throughout: pixels across and down, depth in mm. */
function grid(
  into: { xy: number[]; z: number[]; index: number[] },
  x0: number, y0: number, size: number, cells: number, z: number,
): { first: number; count: number } {
  const base = into.z.length
  const first = into.index.length / 3
  const step = size / cells
  for (let j = 0; j <= cells; j++) {
    for (let i = 0; i <= cells; i++) {
      into.xy.push(x0 + i * step, y0 + j * step)
      into.z.push(z)
    }
  }
  const at = (i: number, j: number) => base + j * (cells + 1) + i
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      into.index.push(at(i, j), at(i + 1, j), at(i + 1, j + 1))
      into.index.push(at(i, j), at(i + 1, j + 1), at(i, j + 1))
    }
  }
  return { first, count: cells * cells * 2 }
}

function projected(m: { xy: number[]; z: number[]; index: number[] }) {
  const n = m.z.length
  const sx = new Float32Array(n), sy = new Float32Array(n), sz = new Float32Array(n)
  for (let v = 0; v < n; v++) {
    sx[v] = m.xy[v * 2]
    sy[v] = m.xy[v * 2 + 1]
    sz[v] = m.z[v]
  }
  return { index: m.index, sx, sy, sz, dropped: null }
}

function centre(m: { xy: number[]; index: number[] }, t: number): { x: number; y: number } {
  const [a, b, c] = [m.index[t * 3], m.index[t * 3 + 1], m.index[t * 3 + 2]]
  return {
    x: (m.xy[a * 2] + m.xy[b * 2] + m.xy[c * 2]) / 3,
    y: (m.xy[a * 2 + 1] + m.xy[b * 2 + 1] + m.xy[c * 2 + 1]) / 3,
  }
}

describe('the surface in front', () => {
  it('leaves out what a nearer surface hides, and keeps what it does not', () => {
    const m = { xy: [] as number[], z: [] as number[], index: [] as number[] }
    const back = grid(m, 0, 0, 80, 8, 20)
    const front = grid(m, 20, 20, 40, 4, 10)
    const test = frontSurface(projected(m), { minX: 0, minY: 0, maxX: 80, maxY: 80 }, 1)
    for (let t = front.first; t < front.first + front.count; t++) expect(test(t)).toBe(true)
    for (let t = back.first; t < back.first + back.count; t++) {
      const c = centre(m, t)
      const hidden = c.x > 20 && c.x < 60 && c.y > 20 && c.y < 60
      expect(test(t), `back triangle at ${c.x.toFixed(1)}, ${c.y.toFixed(1)}`).toBe(!hidden)
    }
  })

  it('judges a scan seen whole, many triangles to a pixel, by depth', () => {
    // Quarter-pixel cells: almost none of these covers a pixel centre or wins
    // a pixel, so every one of them is judged by its depth alone.
    const m = { xy: [] as number[], z: [] as number[], index: [] as number[] }
    const near = grid(m, 0, 0, 10, 40, 5)
    const far = grid(m, 0, 0, 10, 40, 6)
    const test = frontSurface(projected(m), { minX: 0, minY: 0, maxX: 10, maxY: 10 }, 0.1)
    let nearKept = 0, farKept = 0
    for (let t = near.first; t < near.first + near.count; t++) if (test(t)) nearKept++
    for (let t = far.first; t < far.first + far.count; t++) if (test(t)) farKept++
    expect(nearKept).toBe(near.count)
    expect(farKept).toBe(0)
  })

  it('keeps a surface sloping away from the screen whole', () => {
    // One wall falling away at about 70°, fine enough to be noise-like.
    const m = { xy: [] as number[], z: [] as number[], index: [] as number[] }
    const wall = grid(m, 0, 0, 20, 60, 0)
    for (let v = 0; v < m.z.length; v++) m.z[v] = m.xy[v * 2] * 2.75
    const test = frontSurface(projected(m), { minX: 0, minY: 0, maxX: 20, maxY: 20 }, 1)
    for (let t = wall.first; t < wall.first + wall.count; t++) expect(test(t)).toBe(true)
  })

  it('lets nothing hide behind a triangle that is not drawn', () => {
    const m = { xy: [] as number[], z: [] as number[], index: [] as number[] }
    const back = grid(m, 0, 0, 40, 4, 20)
    const front = grid(m, 0, 0, 40, 4, 10)
    const p = { ...projected(m), dropped: (t: number) => t >= front.first }
    const test = frontSurface(p, { minX: 0, minY: 0, maxX: 40, maxY: 40 }, 1)
    for (let t = back.first; t < back.first + back.count; t++) expect(test(t)).toBe(true)
  })
})

/** A window dragged over a part seen straight down its Z axis: one world unit
 *  is one pixel at z 0, and the container's corner is at (10, 20) on the page.
 *  In perspective the camera stands back far enough for z 0 to span the same. */
function windowRig(geometry: THREE.BufferGeometry, through = false, clip: THREE.Plane[] | null = null, perspective = false) {
  const listeners: Record<string, (e: PointerEvent) => void> = {}
  const element = () => ({ setAttribute: vi.fn(), append: vi.fn(), remove: vi.fn(), style: { display: '', setProperty: vi.fn() } })
  vi.stubGlobal('document', {
    createElementNS: vi.fn(() => element()),
    addEventListener: (type: string, fn: (e: PointerEvent) => void) => {
      listeners[type] = fn
    },
    removeEventListener: vi.fn(),
  })
  const camera = perspective ? new THREE.PerspectiveCamera(30, 1, 1, 1000) : new THREE.OrthographicCamera(-50, 50, 50, -50, 1, 1000)
  camera.position.set(0, 0, perspective ? 50 / Math.tan(THREE.MathUtils.degToRad(15)) : 500)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld()
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
  material.clippingPlanes = clip
  const mesh = new THREE.Mesh(geometry, material)
  const marked = new Set<number>()
  const ctx = {
    container: {
      appendChild: vi.fn(),
      clientWidth: 100,
      clientHeight: 100,
      getBoundingClientRect: () => ({ left: 10, top: 20 }),
    },
    camera: () => camera,
    worldPerPixel: () => 1,
    partGroup: new THREE.Group(),
    raycaster: { intersectObject: () => [] },
    regions: {
      get paintCount() {
        return marked.size
      },
      clearPaint: () => false,
      markVertex: (v: number, erase: boolean) => (erase ? marked.delete(v) : marked.add(v)),
    },
    setPickRay: vi.fn(),
    mesh: () => mesh,
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
  marking.setPaintBrush({ color: '#fff', diameter: 4, erase: false, gesture: 'window', backfaces: through })
  const event = (x: number, y: number, buttons: number) =>
    ({ button: 0, buttons, clientX: x, clientY: y, altKey: false, pointerType: 'mouse' }) as PointerEvent
  marking.handlePointerDown(event(12, 22, 1))
  listeners.pointermove(event(108, 118, 1))
  listeners.pointerup(event(108, 118, 0))
  return marked
}

/** A square plate of cells facing +Z (towards the camera), at height z. */
function plate(positions: number[], index: number[], half: number, cells: number, z: number): number {
  const base = positions.length / 3
  const step = (2 * half) / cells
  for (let j = 0; j <= cells; j++) {
    for (let i = 0; i <= cells; i++) positions.push(-half + i * step, -half + j * step, z)
  }
  const at = (i: number, j: number) => base + j * (cells + 1) + i
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      index.push(at(i, j), at(i + 1, j), at(i + 1, j + 1))
      index.push(at(i, j), at(i + 1, j + 1), at(i, j + 1))
    }
  }
  return base
}

/** A big plate at z 0 with a smaller one hovering in front of its middle. */
function stacked(): { geometry: THREE.BufferGeometry; backVertices: number } {
  const positions: number[] = []
  const index: number[] = []
  plate(positions, index, 40, 8, 0)
  const backVertices = positions.length / 3
  plate(positions, index, 20, 4, 10)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(index)
  return { geometry, backVertices }
}

afterEach(() => vi.unstubAllGlobals())

describe('a window over surface that hides other surface', () => {
  it('marks the plate in front and the part of the one behind that shows', () => {
    const { geometry, backVertices } = stacked()
    const marked = windowRig(geometry)
    const pos = geometry.getAttribute('position')
    for (let v = 0; v < pos.count; v++) {
      const x = pos.getX(v), y = pos.getY(v)
      // Behind the front plate, the back plate's vertices are hidden: only
      // the ones on or outside its edge belong to a triangle that shows.
      const shows = v >= backVertices || Math.max(Math.abs(x), Math.abs(y)) >= 20
      expect(marked.has(v), `vertex ${v} at ${x}, ${y}`).toBe(shows)
    }
  })

  it('marks the plate in front and the part of the one behind that shows, in perspective', () => {
    // Nearer the camera, the front plate covers a little more of the back one
    // on the screen than in parallel; still not the back plate's triangles
    // that reach out past it.
    const { geometry, backVertices } = stacked()
    const marked = windowRig(geometry, false, null, true)
    const pos = geometry.getAttribute('position')
    for (let v = 0; v < pos.count; v++) {
      const x = pos.getX(v), y = pos.getY(v)
      const shows = v >= backVertices || Math.max(Math.abs(x), Math.abs(y)) >= 20
      expect(marked.has(v), `vertex ${v} at ${x}, ${y}`).toBe(shows)
    }
  })

  it('marks everything it encloses when it goes through the part', () => {
    const { geometry } = stacked()
    const marked = windowRig(geometry, true)
    expect(marked.size).toBe(geometry.getAttribute('position').count)
  })

  it('marks nothing a section has cut away, and what that uncovers', () => {
    const { geometry, backVertices } = stacked()
    // Kept: x ≤ 0.
    const marked = windowRig(geometry, false, [new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0)])
    const pos = geometry.getAttribute('position')
    for (let v = 0; v < pos.count; v++) {
      const x = pos.getX(v), y = pos.getY(v)
      if (x > 0) {
        expect(marked.has(v), `vertex ${v} at ${x}, ${y}`).toBe(false)
        continue
      }
      // On the kept side, the front plate's kept half still hides the back.
      const shows = v >= backVertices || Math.max(Math.abs(x), Math.abs(y)) >= 20
      expect(marked.has(v), `vertex ${v} at ${x}, ${y}`).toBe(shows)
    }
  })
})

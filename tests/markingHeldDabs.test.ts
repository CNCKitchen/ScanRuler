// SPDX-License-Identifier: AGPL-3.0-only
// A brush stroke laid on a scan whose bounds tree is still being built off
// the thread (viewer/bvh.ts treeOffThread) is held, and laid when the tree
// lands — where the stroke was, not where the cursor's spot lies on a view
// turned since — rather than dropped without a word.
import * as THREE from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SurfaceMarking } from '../src/viewer/marking'
import { RegionColors } from '../src/viewer/regionColors'

type Listener = (e: Partial<PointerEvent>) => void

describe('a stroke laid while the tree is out', () => {
  let on: Record<string, Listener[]>
  let marking: SurfaceMarking
  let regions: RegionColors
  let mesh: THREE.Mesh
  let reports: number[]
  /** Where a pixel lands on the part: 100 px to the millimetre about the
   *  middle of an 800 × 600 view looking down on the XY plane, moved by
   *  `turn` to stand for the view having been turned. */
  let turn = 0

  const fire = (type: string, e: Partial<PointerEvent>) => {
    for (const l of on[type] ?? []) l(e)
  }
  const press = (x: number, y: number) =>
    marking.handlePointerDown({ button: 0, pointerType: 'mouse', clientX: x, clientY: y, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false } as PointerEvent)
  const release = (x: number, y: number) => fire('pointerup', { button: 0, clientX: x, clientY: y })
  /** The marked vertices, as points on the part. */
  const marked = () => {
    const pos = mesh.geometry.getAttribute('position')
    return [...regions.paintedVertices()].map((v) => new THREE.Vector3().fromBufferAttribute(pos, v))
  }

  beforeEach(() => {
    on = {}
    turn = 0
    reports = []
    const element = () => ({ setAttribute: () => {}, append: () => {}, remove: () => {}, style: { display: '', setProperty: () => {} } })
    vi.stubGlobal('document', {
      createElementNS: element,
      addEventListener: (type: string, l: Listener) => {
        ;(on[type] ??= []).push(l)
      },
      removeEventListener: () => {},
    })
    // A 4 × 4 mm sheet in 0.1 mm squares, facing the view.
    const geometry = new THREE.PlaneGeometry(4, 4, 40, 40)
    const n = geometry.getAttribute('position').count
    const paint = new Uint8Array(n)
    geometry.setAttribute('paint', new THREE.BufferAttribute(paint, 1))
    mesh = new THREE.Mesh(geometry)
    mesh.updateMatrixWorld()
    regions = new RegionColors([200, 200, 200])
    regions.attach(new Uint8Array(n * 3), paint, new Uint8Array(n), n)
    const raycaster = new THREE.Raycaster()
    const partGroup = new THREE.Group()
    const camera = new THREE.OrthographicCamera()
    marking = new SurfaceMarking({
      container: { appendChild: () => {} } as unknown as HTMLDivElement,
      camera: () => camera,
      worldPerPixel: () => 0.01,
      partGroup,
      raycaster,
      regions,
      setPickRay: (x, y) => raycaster.ray.set(new THREE.Vector3((x - 400) / 100 + turn, (300 - y) / 100, 10), new THREE.Vector3(0, 0, -1)),
      mesh: () => mesh,
      paintAttr: () => geometry.getAttribute('paint') as THREE.BufferAttribute,
      graphVertex: (v) => v,
      setPaintColor: () => {},
      invalidate: () => {},
      wake: () => {},
      claimDrag: () => {},
      navigates: () => false,
      requestHover: () => {},
      onPaintChange: (count) => reports.push(count),
    })
    marking.setPaintBrush({ color: '#ff8000', diameter: 0.5, erase: false })
  })

  afterEach(() => {
    marking.dispose()
    vi.unstubAllGlobals()
  })

  it('marks nothing until the tree lands, then marks where it was laid', () => {
    press(400, 300)
    release(400, 300)
    expect(regions.paintCount).toBe(0)
    expect(reports).toEqual([0])
    // The view turned before the tree came: the dab is where it was laid.
    turn = 1.5
    mesh.geometry.boundsTree = new MeshBVH(mesh.geometry)
    marking.treeLanded()
    const points = marked()
    expect(points.length).toBeGreaterThan(0)
    expect(points.every((p) => Math.hypot(p.x, p.y) < 0.4)).toBe(true)
    // Said as a gesture's end says it.
    expect(reports).toEqual([0, regions.paintCount])
  })

  it('lays them first on the next dab if the tree came another way', () => {
    press(400, 300)
    release(400, 300)
    mesh.geometry.boundsTree = new MeshBVH(mesh.geometry)
    press(500, 300)
    release(500, 300)
    const points = marked()
    expect(points.some((p) => Math.hypot(p.x, p.y) < 0.3)).toBe(true)
    expect(points.some((p) => Math.hypot(p.x - 1, p.y) < 0.3)).toBe(true)
  })

  it('drops them with the marking rubbed out, or the brush put away', () => {
    press(400, 300)
    release(400, 300)
    marking.clearPaint()
    mesh.geometry.boundsTree = new MeshBVH(mesh.geometry)
    marking.treeLanded()
    expect(regions.paintCount).toBe(0)

    mesh.geometry.boundsTree = undefined
    press(400, 300)
    release(400, 300)
    marking.setPaintBrush(null)
    mesh.geometry.boundsTree = new MeshBVH(mesh.geometry)
    marking.treeLanded()
    expect(regions.paintCount).toBe(0)
  })

  it('waits on for the scan when another part’s tree lands', () => {
    press(400, 300)
    release(400, 300)
    marking.treeLanded()
    expect(regions.paintCount).toBe(0)
    mesh.geometry.boundsTree = new MeshBVH(mesh.geometry)
    marking.treeLanded()
    expect(regions.paintCount).toBeGreaterThan(0)
  })

  it('marks nothing the section view cut away (issue 34)', () => {
    // The cut keeps x ≥ 0.
    ;(mesh.material as THREE.Material).clippingPlanes = [new THREE.Plane(new THREE.Vector3(1, 0, 0), 0)]
    mesh.geometry.boundsTree = new MeshBVH(mesh.geometry)
    // A dab on the cut-away side marks nothing at all.
    press(300, 300)
    release(300, 300)
    expect(regions.paintCount).toBe(0)
    // One on the cut marks only triangles whose middle is kept: no vertex
    // further out on the cut side than one square.
    press(400, 300)
    release(400, 300)
    const points = marked()
    expect(points.length).toBeGreaterThan(0)
    expect(points.every((p) => p.x >= -0.1 - 1e-6)).toBe(true)
    expect(points.some((p) => p.x > 0.1)).toBe(true)
  })
})

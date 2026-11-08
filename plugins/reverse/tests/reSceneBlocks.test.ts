// SPDX-License-Identifier: AGPL-3.0-only
// The viewport keeps one block of GPU geometry per body: the bodies of a
// real build drawn in the workspace's layer on a stand-in viewport, then a
// body's eye toggled — no buffer made anew, faces, edges or silhouettes —
// and one body's mesh replaced, as a build that changed it hands it back:
// that body's buffers made again, the others' kept.

import * as THREE from 'three'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { SceneLayerHost } from '../../../src/viewer/sceneLayers'
import type { SceneManager } from '../../../src/viewer/SceneManager'
import { DEFAULT_THEME } from '../../../src/viewer/viewThemes'
import { Builder, type BuiltBody } from '../core/build'
import { ReKernel } from '../core/kernel'
import { ReScene } from '../viewer/reScene'
import { build, extrudeAll, rectangleSketch } from './reKit'

vi.mock('../../../src/viewer/overlays', () => ({
  pinLabel: () => Object.assign(new THREE.Object3D(), { element: { remove() {} } }),
}))

let builder: Builder
let bodies: BuiltBody[]

beforeAll(async () => {
  builder = new Builder(await ReKernel.load())
  const features = [0, 1, 2].flatMap((n) => {
    const sketch = rectangleSketch(n * 2 + 1, 10, 10, [n * 30, 0])
    return [sketch, extrudeAll(n * 2 + 2, sketch, 0, 6 + n)]
  })
  bodies = (await build(builder, features)).bodies
}, 120_000)
afterAll(() => builder.dispose())

/** A viewport that draws nothing: what the layer is handed and adds. */
function stage(): { scene: SceneManager; part: THREE.Group } {
  const part = new THREE.Group()
  const camera = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 1000)
  camera.position.set(100, 80, 120)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld()
  const host: SceneLayerHost = {
    scene: new THREE.Scene(),
    partGroup: part,
    raycaster: new THREE.Raycaster(),
    canvas: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) } as unknown as HTMLCanvasElement,
    canvasRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect,
    container: {} as HTMLElement,
    camera: () => camera,
    worldPerPixel: () => 0.1,
    setPickRay: () => {},
    invalidate: () => {},
    requestHover: () => {},
    setCursor: () => {},
    claimDrag: () => {},
    theme: () => DEFAULT_THEME,
    modelRadius: () => 60,
    modelCenter: () => [30, 0, 0],
    hasScan: () => true,
    pickScan: () => null,
    scanDistanceAt: () => null,
    clipPlanes: () => null,
    scanOpacity: () => 1,
    click: () => {},
    sizeStage: () => {},
    takeIn: () => {},
    framedSphere: () => new THREE.Sphere(new THREE.Vector3(), 100),
  }
  const scene = { layerHost: () => host, addLayer: () => () => {} } as unknown as SceneManager
  return { scene, part }
}

/** Every vertex buffer under the part — plain attributes and the fat
 *  lines' interleaved ones — each what the GPU is handed once it is drawn. */
function buffers(part: THREE.Group): Set<unknown> {
  const out = new Set<unknown>()
  part.traverse((o) => {
    const geometry = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined
    if (!geometry?.attributes) return
    for (const a of Object.values(geometry.attributes)) out.add((a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute ? (a as THREE.InterleavedBufferAttribute).data : a)
    if (geometry.index) out.add(geometry.index)
  })
  return out
}

const made = (before: Set<unknown>, after: Set<unknown>) => [...after].filter((b) => !before.has(b)).length

describe('the bodies in the viewport', () => {
  it('keeps a block per body: a body’s eye toggled rebuilds no buffer, a changed body rebuilds its own', () => {
    expect(bodies).toHaveLength(3)
    const { scene, part } = stage()
    const rs = new ReScene(scene)
    const items = (visible: (id: number) => boolean, list = bodies) => list.map((b) => ({ id: b.id, mesh: b.mesh, visible: visible(b.id), color: '#4a90d9', topology: b.topology }))
    rs.setBodies(items(() => true))
    rs.bodyPicks.updateView()
    const shown = buffers(part)
    expect(shown.size).toBeGreaterThan(9)
    const blocks = new Map(rs.bodyMeshes)

    // The middle body's eye off, and on again: nothing made anew.
    const middle = bodies[1].id
    rs.setBodies(items((id) => id !== middle))
    rs.bodyPicks.updateView()
    const hidden = buffers(part)
    expect(made(shown, hidden)).toBe(0)
    expect(rs.bodyMeshes.get(middle)!.visible).toBe(false)
    rs.setBodies(items(() => true))
    rs.bodyPicks.updateView()
    expect(made(shown, buffers(part))).toBe(0)
    for (const [id, mesh] of blocks) expect(rs.bodyMeshes.get(id)).toBe(mesh)

    // The middle body handed back changed — another mesh: its block made
    // again, faces and edges; the other two kept as they were.
    const changed = bodies.map((b) => (b.id === middle ? structuredClone(b) : b))
    rs.setBodies(items(() => true, changed))
    rs.bodyPicks.updateView()
    const after = buffers(part)
    expect(rs.bodyMeshes.get(middle)).not.toBe(blocks.get(middle))
    for (const b of [bodies[0], bodies[2]]) expect(rs.bodyMeshes.get(b.id)).toBe(blocks.get(b.id))
    // The middle body's own made again — position, normal and index of its
    // faces, its edges' blocks, its silhouette — as many as it had: what
    // went is what came, and the other bodies' buffers are all still there.
    const middleOwn = new Set<unknown>()
    const mesh = rs.bodyMeshes.get(middle)!.geometry
    for (const a of [mesh.getAttribute('position'), mesh.getAttribute('normal'), mesh.getIndex()]) middleOwn.add(a)
    expect(made(shown, after)).toBeGreaterThanOrEqual(3)
    expect(made(after, shown)).toBe(made(shown, after))
    for (const a of middleOwn) expect(shown.has(a)).toBe(false)
    for (const b of [bodies[0], bodies[2]]) {
      const g = rs.bodyMeshes.get(b.id)!.geometry
      for (const a of [g.getAttribute('position'), g.getAttribute('normal'), g.getIndex()]) expect(after.has(a)).toBe(true)
    }
  })
})

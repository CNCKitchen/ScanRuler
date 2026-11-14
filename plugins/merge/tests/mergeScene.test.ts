// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { MergeScene } from '../viewer/mergeScene'
import type { SceneLayerHost } from '../../../src/viewer/sceneLayers'
import type { Rigid } from '../../../src/core/deviation/rigid'

function host(planes: THREE.Plane[] | null = null): SceneLayerHost {
  const partGroup = new THREE.Group()
  partGroup.matrixAutoUpdate = false
  const camera = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 100)
  camera.position.set(0, 0, 20)
  camera.updateMatrixWorld(true)
  return {
    scene: new THREE.Scene(),
    partGroup,
    raycaster: new THREE.Raycaster(),
    camera: () => camera,
    worldPerPixel: () => 0.01,
    clipPlanes: () => planes,
    canvas: { addEventListener() {}, removeEventListener() {}, style: {} },
    invalidate: () => {},
    claimDrag: () => {},
  } as unknown as SceneLayerHost
}

/** A flat n×n patch of points at z = 0, 0.5 apart, facing +z. */
function patch(n: number) {
  const positions = new Float32Array(n * n * 3)
  const normals = new Float32Array(n * n * 3)
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const k = (i * n + j) * 3
      positions[k] = i * 0.5 - (n - 1) / 4
      positions[k + 1] = j * 0.5 - (n - 1) / 4
      normals[k + 2] = 1
    }
  return { positions, normals, spacing: 0.5 }
}

const translate = (x: number, y: number, z: number): Rigid => ({
  r: Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]),
  t: Float64Array.from([x, y, z]),
})

describe('MergeScene', () => {
  it('adds, poses and removes a layer under the part group', () => {
    const h = host()
    const s = new MergeScene(h)
    s.add('a', patch(3), '#ff0000')
    const root = h.partGroup.children[0]
    expect(root.children.length).toBe(1)
    s.setPose('a', translate(1, 2, 3))
    const holder = root.children[0]
    holder.updateMatrixWorld(true)
    expect(new THREE.Vector3().setFromMatrixPosition(holder.matrixWorld).toArray()).toEqual([1, 2, 3])
    s.setVisible('a', false)
    expect(holder.visible).toBe(false)
    s.remove('a')
    expect(root.children.length).toBe(0)
  })

  it('keeps world = partGroup ∘ pose when the base moves', () => {
    const h = host()
    const s = new MergeScene(h)
    s.add('a', patch(3), '#00ff00')
    s.setPose('a', translate(1, 0, 0))
    h.partGroup.matrix.makeTranslation(10, 0, 0)
    h.partGroup.updateMatrixWorld(true)
    const holder = h.partGroup.children[0].children[0]
    expect(new THREE.Vector3().setFromMatrixPosition(holder.matrixWorld).x).toBeCloseTo(11)
  })

  it('keeps a layer on the base when a transform is baked into the base', () => {
    const h = host()
    const s = new MergeScene(h)
    s.add('a', patch(3), '#00ff00')
    s.setPose('a', translate(1, 0, 0))
    // Base vertices turn a quarter about z; the layer's point (0,0,0) sat at (1,0,0).
    const T: Rigid = { r: Float64Array.from([0, -1, 0, 1, 0, 0, 0, 0, 1]), t: Float64Array.from([0, 0, 2]) }
    s.partMoved(T)
    const holder = h.partGroup.children[0].children[0]
    holder.updateMatrixWorld(true)
    const p = new THREE.Vector3(0, 0, 0).applyMatrix4(holder.matrixWorld)
    expect(p.toArray().map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 1, 2])
  })

  it('picks only the layers asked for, and says which', () => {
    const h = host()
    const s = new MergeScene(h)
    s.add('a', patch(5), '#ff0000')
    s.add('b', patch(5), '#0000ff')
    s.setPose('b', translate(0, 0, 1)) // nearer the eye
    expect(s.pick(0, 0)?.layerId).toBe('b')
    const only = s.pick(0, 0, ['a'])
    expect(only?.layerId).toBe('a')
    expect(only?.faceIndex).toBe(-1)
    expect(s.pick(0, 0, ['zzz'])).toBeNull()
    s.setVisible('b', false)
    expect(s.pick(0, 0)?.layerId).toBe('a')
  })

  it("reports a hit in the layer's own frame", () => {
    const h = host()
    const s = new MergeScene(h)
    s.add('a', patch(9), '#ff0000')
    s.setPose('a', translate(1, 0, 0))
    const hit = s.pick(0, 0)! // world (0,0) is the layer's (-1,0)
    expect(hit.point[0]).toBeCloseTo(-1, 0)
  })

  it('picks a mesh layer', () => {
    const h = host()
    const s = new MergeScene(h)
    s.add(
      'm',
      {
        positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 0, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        indices: Uint32Array.from([0, 1, 2]),
      },
      '#ffffff',
    )
    const hit = s.pick(0, 0)
    expect(hit?.layerId).toBe('m')
    expect(hit?.faceIndex).toBe(0)
    expect(hit!.weights.reduce((a, b) => a + b)).toBeCloseTo(1)
  })

  it('puts a handle on a layer and takes it away', () => {
    const h = host()
    const s = new MergeScene(h)
    s.add('a', patch(3), '#ff0000')
    s.gizmo('a', () => {})
    expect(h.scene.children.length).toBe(1)
    s.gizmo(null, () => {})
    s.dispose()
    expect(h.scene.children.length).toBe(0)
    expect(h.partGroup.children.length).toBe(0)
  })

  it('clips a layer added while a section is active', () => {
    const planes = [new THREE.Plane(new THREE.Vector3(1, 0, 0), 0)]
    const h = host(planes)
    const s = new MergeScene(h)
    s.add('a', patch(3), '#ff0000')
    s.add('m', { positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 0, 1, 0]), normals: new Float32Array(9), indices: Uint32Array.from([0, 1, 2]) }, '#fff')
    // Every drawn object under the part group, wherever the scene keeps it.
    const materials: THREE.Material[] = []
    h.partGroup.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Points) materials.push(o.material as THREE.Material)
    })
    expect(materials.length).toBe(2)
    for (const m of materials) expect(m.clippingPlanes).toBe(planes)
    s.clippingChanged(null)
    for (const m of materials) expect(m.clippingPlanes ?? null).toBe(null)
  })

  it('recolours a cloud and a mesh layer', () => {
    const h = host()
    const s = new MergeScene(h)
    s.add('a', patch(3), '#ff0000')
    s.add('m', { positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 0, 1, 0]), normals: new Float32Array(9), indices: Uint32Array.from([0, 1, 2]) }, '#ff0000')
    s.setColor('a', '#0000ff')
    s.setColor('m', '#0000ff')
    const root = h.partGroup.children[0]
    const pts = root.children[0].children[0] as THREE.Points
    expect(Array.from((pts.geometry.getAttribute('color') as THREE.BufferAttribute).array.slice(0, 3))).toEqual([0, 0, 1])
    // Tinted through, every point: else the splat shader paints the bare
    // surface grey over the colour.
    const tint = pts.geometry.getAttribute('tint') as THREE.BufferAttribute
    expect(tint.count).toBe(pts.geometry.getAttribute('position').count)
    expect(Array.from(tint.array).every((v) => v === 1)).toBe(true)
    expect(((root.children[1].children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial).color.getHex()).toBe(0x0000ff)
  })
})

// SPDX-License-Identifier: AGPL-3.0-only
// A point cloud drawn as lit splats: the layer's geometry and material, and
// the scene putting a cloud where a mesh would go — moved by the alignment
// and by a baked transform like the scan it stands in for.

import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { CloudLayer, SPLAT_SCALE } from '../src/viewer/cloudLayer'
import { SceneManager } from '../src/viewer/SceneManager'
import { DEFAULT_THEME } from '../src/viewer/viewThemes'
import type { Rigid } from '../src/core/deviation/rigid'

function grid(n: number): { positions: Float32Array; normals: Float32Array } {
  const positions = new Float32Array(n * n * 3)
  const normals = new Float32Array(n * n * 3)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const k = (i * n + j) * 3
      positions[k] = i * 0.5
      positions[k + 1] = j * 0.5
      normals[k + 2] = 1
    }
  }
  return { positions, normals }
}

describe('CloudLayer', () => {
  it('draws points with the position and normal it was given', () => {
    const { positions, normals } = grid(4)
    const layer = new CloudLayer(positions, normals, 0.5)
    expect(layer.object).toBeInstanceOf(THREE.Points)
    const g = layer.object.geometry
    expect(g.getAttribute('position').array).toBe(positions)
    expect(g.getAttribute('normal').array).toBe(normals)
    expect(g.getIndex()).toBeNull()
    layer.dispose()
  })

  it('reads the per-vertex attributes the scan shader reads', () => {
    const { positions, normals } = grid(3)
    const layer = new CloudLayer(positions, normals, 0.5)
    const tint = new THREE.BufferAttribute(new Uint8Array(9), 1)
    layer.setAttribute('tint', tint)
    expect(layer.object.geometry.getAttribute('tint')).toBe(tint)
    const material = layer.object.material as THREE.ShaderMaterial
    // Vertex colours come in as the `color` attribute three declares itself.
    expect(material.vertexColors).toBe(true)
    for (const name of ['tint', 'paint', 'surface', 'deflect']) {
      expect(material.vertexShader).toMatch(new RegExp(`attribute (float|vec3) ${name};`))
    }
    layer.dispose()
  })

  it('is clipped by the planes it is given', () => {
    const { positions, normals } = grid(2)
    const layer = new CloudLayer(positions, normals, 0.5)
    const material = layer.object.material as THREE.ShaderMaterial
    expect(material.clipping).toBe(true)
    expect(material.vertexShader).toContain('#include <clipping_planes_vertex>')
    expect(material.fragmentShader).toContain('#include <clipping_planes_fragment>')
    const planes = [new THREE.Plane(new THREE.Vector3(1, 0, 0), 0)]
    layer.setClipPlanes(planes)
    expect(material.clippingPlanes).toBe(planes)
    layer.setClipPlanes([])
    expect(material.clippingPlanes).toBeNull()
    layer.dispose()
  })

  it('bounds its splats in screen pixels, whatever the pixel ratio', () => {
    const { positions, normals } = grid(2)
    const layer = new CloudLayer(positions, normals, 0.5)
    const material = layer.object.material as THREE.ShaderMaterial
    expect(material.vertexShader).toMatch(/clamp\(.*1\.0 \* uPixelRatio, 48\.0 \* uPixelRatio \)/)
    const renderer = { getDrawingBufferSize: (v: THREE.Vector2) => v.set(1600, 1200), getPixelRatio: () => 2 }
    layer.object.onBeforeRender(renderer as never, null as never, null as never, null as never, null as never, null as never)
    expect(material.uniforms.uHalfHeight.value).toBe(600)
    expect(material.uniforms.uPixelRatio.value).toBe(2)
    layer.dispose()
  })

  it('sizes its splats from the spacing', () => {
    const { positions, normals } = grid(2)
    const a = new CloudLayer(positions, normals, 0.5)
    const b = new CloudLayer(positions, normals, 2)
    const size = (l: CloudLayer) => (l.object.material as THREE.ShaderMaterial).uniforms.uSplat.value as number
    expect(size(a)).toBeCloseTo(0.5 * SPLAT_SCALE)
    expect(size(b)).toBeCloseTo(2 * SPLAT_SCALE)
    a.dispose()
    b.dispose()
  })

  it('goes see-through and back', () => {
    const { positions, normals } = grid(2)
    const layer = new CloudLayer(positions, normals, 0.5)
    const material = layer.object.material as THREE.ShaderMaterial
    layer.setOpacity(0.4)
    expect(material.uniforms.uOpacity.value).toBeCloseTo(0.4)
    expect(material.transparent).toBe(true)
    expect(material.depthWrite).toBe(false)
    layer.setOpacity(1)
    expect(material.transparent).toBe(false)
    expect(material.depthWrite).toBe(true)
    layer.dispose()
  })

  it('is not hit by the raycaster — picking a cloud is its own job', () => {
    const { positions, normals } = grid(4)
    const layer = new CloudLayer(positions, normals, 0.5)
    const ray = new THREE.Raycaster(new THREE.Vector3(0.5, 0.5, 10), new THREE.Vector3(0, 0, -1))
    expect(ray.intersectObject(layer.object)).toEqual([])
    layer.dispose()
  })
})

/** A scene with no viewport: just what laying out, moving and aligning the
 *  scan reads, and nothing that draws. */
function headlessScene(): { scene: SceneManager; moved: Rigid[]; group: THREE.Group } {
  const moved: Rigid[] = []
  const group = new THREE.Group()
  group.matrixAutoUpdate = false // as the scene holds it: the alignment is its matrix
  const scene = Object.create(SceneManager.prototype) as SceneManager
  const nop = () => {}
  Object.assign(scene, {
    mesh: null,
    cloud: null,
    other: null,
    theme: DEFAULT_THEME,
    partGroup: group,
    alignMatrix: new THREE.Matrix4(),
    previewMatrix: new THREE.Matrix4(),
    layers: [{ partMoved: (m: Rigid) => moved.push(m) }],
    slice: null,
    sectionView: null,
    scanSeeThrough: false,
    scanGhost: false,
    showScanColors: true,
    uSurfaceOwn: { value: 0 },
    uPaintColor: { value: new THREE.Color() },
    uSurfaceColor: { value: new THREE.Color() },
    uDeflect: { value: 0 },
    boundsTreeFrom: null,
    regions: { attach: nop, detach: nop },
    invalidate: nop,
    frameCamera: nop,
    applySlice: nop,
    setPreview: nop,
    warmPrograms: nop,
    disposeMesh: nop,
    updateCaps: nop,
  })
  return { scene, moved, group }
}

describe('SceneManager with a cloud', () => {
  function loaded() {
    const h = headlessScene()
    const { positions, normals } = grid(5)
    h.scene.prepareMesh(positions, new Uint32Array(0), normals, new Uint8Array(25), new Uint32Array(0), null, { spacing: 0.5 }).commit()
    const points = (h.scene as unknown as { mesh: THREE.Object3D }).mesh
    return { ...h, points, positions }
  }

  it('lays the cloud out as points with the scan attributes, and no tree', () => {
    const { points } = loaded()
    expect(points).toBeInstanceOf(THREE.Points)
    const g = (points as THREE.Points).geometry
    for (const name of ['position', 'normal', 'color', 'tint', 'paint']) expect(g.getAttribute(name)).toBeTruthy()
    expect(g.getIndex()).toBeNull()
    expect(g.boundsTree).toBeUndefined()
  })

  it('moves the points with the alignment', () => {
    const { scene, points, group } = loaded()
    expect(points.parent).toBe(group)
    scene.setAlignment(new THREE.Matrix4().makeTranslation(10, 0, 0).toArray())
    points.updateMatrixWorld(true)
    const at = new THREE.Vector3().setFromMatrixPosition(points.matrixWorld)
    expect(at.x).toBeCloseTo(10)
  })

  it('bakes a transform into the points and tells the layers', () => {
    const { scene, points, moved } = loaded()
    const m: Rigid = { r: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), t: new Float64Array([0, 0, 5]) }
    scene.applyTransform(m)
    const g = (points as THREE.Points).geometry
    expect(g.getAttribute('position').getZ(0)).toBeCloseTo(5)
    expect(g.boundingBox!.min.z).toBeCloseTo(5)
    expect(g.boundsTree).toBeUndefined()
    expect(moved).toEqual([m])
    // The index over the points goes, and is built again where they now are
    // when a pick wants it, not as the move lands.
    expect((scene as unknown as { cloudGrid: unknown }).cloudGrid).toBeNull()
  })

  it('carries the part’s own colours when the file has them', () => {
    const h = headlessScene()
    const { positions, normals } = grid(5)
    const surface = new Uint8Array(25 * 3).fill(200)
    h.scene.prepareMesh(positions, new Uint32Array(0), normals, new Uint8Array(25), new Uint32Array(0), surface, { spacing: 0.5 }).commit()
    const g = ((h.scene as unknown as { mesh: THREE.Points }).mesh).geometry
    expect(g.getAttribute('surface')).toBeTruthy()
    expect(g.getAttribute('surface').count).toBe(25)
  })

  it('goes see-through and hides as the scan does', () => {
    const { scene, points } = loaded()
    const material = (points as THREE.Points).material as THREE.ShaderMaterial
    scene.setScanSeeThrough(true)
    expect(material.uniforms.uOpacity.value).toBeLessThan(1)
    expect(material.transparent).toBe(true)
    scene.setScanSeeThrough(false)
    expect(material.uniforms.uOpacity.value).toBe(1)
    scene.setScanVisible(false)
    expect(points.visible).toBe(false)
    expect(scene.scanShown()).toBe(false)
    scene.setScanVisible(true)
    expect(scene.scanShown()).toBe(true)
  })
})

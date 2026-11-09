// SPDX-License-Identifier: AGPL-3.0-only
// Picking on a point cloud: the point nearest the eye within a radius of the
// ray, on the kept side of every clip plane, handed back as a hit a mesh's
// callers can read (faceIndex -1, all weight on the one vertex).

import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { PointGrid } from '../src/core/geometry/pointGrid'
import { pickCloud } from '../src/viewer/cloudPick'
import { SceneManager } from '../src/viewer/SceneManager'
import { DEFAULT_THEME } from '../src/viewer/viewThemes'
import type { Rigid } from '../src/core/deviation/rigid'

/** An n x n plane at z = 0, spacing 0.5, normals +z. */
function plane(n: number): { positions: Float32Array; normals: Float32Array } {
  const positions = new Float32Array(n * n * 3)
  const normals = new Float32Array(n * n * 3)
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const k = (i * n + j) * 3
      positions[k] = i * 0.5
      positions[k + 1] = j * 0.5
      normals[k + 2] = 1
    }
  return { positions, normals }
}

const down = (x: number, y: number) => new THREE.Ray(new THREE.Vector3(x, y, 10), new THREE.Vector3(0, 0, -1))

describe('pickCloud', () => {
  it('returns the vertex under the ray and its normal', () => {
    const { positions, normals } = plane(5)
    const hit = pickCloud(new PointGrid(positions, 1), normals, down(1, 1.5), 0.3, [])
    expect(hit).not.toBeNull()
    const i = 2 * 5 + 3
    expect(hit!.vertices).toEqual([i, i, i])
    expect(hit!.weights).toEqual([1, 0, 0])
    expect(hit!.faceIndex).toBe(-1)
    expect(hit!.point).toEqual([1, 1.5, 0])
    expect(hit!.normal).toEqual([0, 0, 1])
  })

  it('takes the point nearest the ray among those at the front depth', () => {
    const { positions, normals } = plane(5)
    const hit = pickCloud(new PointGrid(positions, 1), normals, down(1.1, 1.6), 0.75, [])
    expect(hit!.point).toEqual([1, 1.5, 0])
  })

  it('misses when no point lies within the radius', () => {
    const { positions, normals } = plane(5)
    expect(pickCloud(new PointGrid(positions, 1), normals, down(10, 10), 0.3, [])).toBeNull()
  })

  it('takes the nearest along the ray over a farther point within the radius', () => {
    const positions = new Float32Array([0.1, 0, 5, 0, 0, 0]) // far one dead on, near one off by 0.1
    const normals = new Float32Array([0, 0, 1, 0, 0, 1])
    const hit = pickCloud(new PointGrid(positions, 1), normals, down(0, 0), 0.2, [])
    expect(hit!.vertices[0]).toBe(0)
  })

  it('does not pick a point behind a clip plane', () => {
    const positions = new Float32Array([0, 0, 5, 0, 0, 0])
    const normals = new Float32Array([0, 0, 1, 0, 0, 1])
    // keeps z <= 2: the near point (z = 5) is cut away
    const clip = [new THREE.Plane(new THREE.Vector3(0, 0, -1), 2)]
    const hit = pickCloud(new PointGrid(positions, 1), normals, down(0, 0), 0.2, clip)
    expect(hit!.vertices[0]).toBe(1)
  })

  it('misses when every point on the ray is clipped', () => {
    const positions = new Float32Array([0, 0, 5, 0, 0, 4])
    const normals = new Float32Array([0, 0, 1, 0, 0, 1])
    const clip = [new THREE.Plane(new THREE.Vector3(0, 0, -1), 2)]
    expect(pickCloud(new PointGrid(positions, 1), normals, down(0, 0), 0.2, clip)).toBeNull()
  })
})

/** A scene with no viewport: what laying out a cloud and picking it read. */
function pickScene() {
  const group = new THREE.Group()
  group.matrixAutoUpdate = false
  const raycaster = new THREE.Raycaster()
  const scene = Object.create(SceneManager.prototype) as SceneManager
  const nop = () => {}
  Object.assign(scene, {
    mesh: null, cloud: null, other: null, theme: DEFAULT_THEME, partGroup: group,
    alignMatrix: new THREE.Matrix4(), previewMatrix: new THREE.Matrix4(), layers: [],
    slice: null, sectionView: null, scanSeeThrough: false, scanGhost: false, showScanColors: true,
    uSurfaceOwn: { value: 0 }, uPaintColor: { value: new THREE.Color() }, uSurfaceColor: { value: new THREE.Color() },
    uDeflect: { value: 0 }, boundsTreeFrom: null, regions: { attach: nop, detach: nop },
    invalidate: nop, frameCamera: nop, applySlice: nop, setPreview: nop, warmPrograms: nop, disposeMesh: nop,
    viewport: {
      raycaster,
      worldPerPixel: () => 0.01,
      setPickRay: (x: number, y: number) => raycaster.set(new THREE.Vector3(x, y, 10), new THREE.Vector3(0, 0, -1)),
    },
  })
  const { positions, normals } = plane(5)
  scene.prepareMesh(positions, new Uint32Array(0), normals, new Uint8Array(25), new Uint32Array(0), null, { spacing: 0.5 }).commit()
  const pick = (x: number, y: number) => scene.scanHitAt(x, y)
  return { scene, pick, raycaster, group }
}

describe('SceneManager.pick on a cloud', () => {
  it('hits a point as a mesh hit would read, in scan coordinates', () => {
    const { pick } = pickScene()
    const hit = pick(1, 1.5)
    expect(hit).toMatchObject({ vertices: [13, 13, 13], weights: [1, 0, 0], faceIndex: -1, point: [1, 1.5, 0], normal: [0, 0, 1], clientX: 1, clientY: 1.5 })
  })

  it('finds the point through the alignment and hands back scan coordinates', () => {
    const { scene, pick } = pickScene()
    scene.setAlignment(new THREE.Matrix4().makeTranslation(10, 0, 0).toArray())
    expect(pick(1, 1.5)).toBeNull()
    expect(pick(11, 1.5)!.point).toEqual([1, 1.5, 0])
  })

  it('finds the point after a transform is baked in', () => {
    const { scene, pick } = pickScene()
    expect(pick(1, 1.5)).not.toBeNull() // grid built
    const m: Rigid = { r: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), t: new Float64Array([3, 0, 0]) }
    scene.applyTransform(m)
    expect(pick(1, 1.5)).toBeNull()
    expect(pick(4, 1.5)!.vertices[0]).toBe(13)
  })

  it('answers the raycaster too, with a world point and the vertex index', () => {
    const { scene, pick, raycaster } = pickScene()
    scene.setAlignment(new THREE.Matrix4().makeTranslation(10, 0, 0).toArray())
    pick(11, 1.5)
    const hits = raycaster.intersectObject((scene as unknown as { mesh: THREE.Object3D }).mesh, false)
    expect(hits).toHaveLength(1)
    expect(hits[0].index).toBe(13)
    expect(hits[0].distance).toBeCloseTo(10)
    expect(hits[0].point.x).toBeCloseTo(11)
  })
})

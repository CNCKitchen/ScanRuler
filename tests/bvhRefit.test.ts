// SPDX-License-Identifier: AGPL-3.0-only
// A bounds tree refitted after a rigid move must answer a ray as a tree built
// afresh over the moved positions does. The scan's alignment is baked into its
// vertices and the tree refitted rather than rebuilt (SceneManager.applyTransform),
// so a refit that missed a box would make a part unpickable where it now is.
import * as THREE from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import { describe, expect, it } from 'vitest'
import { refitAfterRigid } from '../src/viewer/bvh'

/** A seeded generator, so a failure is the same failure on every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A lumpy sphere: indexed, a few thousand triangles, no two leaves alike. */
function lumpySphere(rand: () => number): THREE.BufferGeometry {
  const geometry = new THREE.SphereGeometry(10, 64, 48)
  const p = geometry.getAttribute('position') as THREE.BufferAttribute
  for (let i = 0; i < p.count; i++) {
    const k = 1 + (rand() - 0.5) * 0.2
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k, p.getZ(i) * k)
  }
  geometry.computeVertexNormals()
  return geometry
}

/** Bake a transform into the positions the way the scan's alignment does:
 *  in place, in the same array, the index untouched. */
function bake(geometry: THREE.BufferGeometry, m: THREE.Matrix4): void {
  const p = geometry.getAttribute('position') as THREE.BufferAttribute
  const v = new THREE.Vector3()
  for (let i = 0; i < p.count; i++) p.setXYZ(i, ...v.fromBufferAttribute(p, i).applyMatrix4(m).toArray())
  p.needsUpdate = true
}

/** The first hit of 1000 rays aimed at the part from a shell around where it
 *  now is, through the geometry's tree. A miss is null. */
function firstHits(geometry: THREE.BufferGeometry, centre: THREE.Vector3, seed: number): (number | null)[] {
  const rand = mulberry32(seed)
  const bvh = geometry.boundsTree as MeshBVH
  const ray = new THREE.Ray()
  const hits: (number | null)[] = []
  for (let i = 0; i < 1000; i++) {
    // A direction uniform on the sphere, an origin well outside, an aim a
    // little off centre so grazing hits and clean misses both turn up.
    const z = rand() * 2 - 1
    const phi = rand() * Math.PI * 2
    const r = Math.sqrt(1 - z * z)
    const dir = new THREE.Vector3(r * Math.cos(phi), r * Math.sin(phi), z)
    const aim = new THREE.Vector3((rand() - 0.5) * 24, (rand() - 0.5) * 24, (rand() - 0.5) * 24).add(centre)
    ray.origin.copy(aim).addScaledVector(dir, -60)
    ray.direction.copy(dir)
    const hit = bvh.raycastFirst(ray, THREE.DoubleSide)
    hits.push(hit ? hit.distance : null)
  }
  return hits
}

function expectSameAnswers(moved: THREE.BufferGeometry, centre: THREE.Vector3): void {
  const fresh = moved.clone()
  fresh.boundsTree = new MeshBVH(fresh)
  const got = firstHits(moved, centre, 99)
  const want = firstHits(fresh, centre, 99)
  expect(got).toHaveLength(1000)
  // The ground truth must not be vacuous: most rays hit the part.
  expect(want.filter((d) => d !== null).length).toBeGreaterThan(300)
  for (let i = 0; i < 1000; i++) {
    if (want[i] === null) expect(got[i], `ray ${i}`).toBeNull()
    else expect(Math.abs((got[i] as number) - want[i]!), `ray ${i}`).toBeLessThan(1e-6)
  }
}

describe('refitAfterRigid', () => {
  const rigid = new THREE.Matrix4()
    .makeTranslation(37, -21, 14)
    .multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.7, -1.1, 2.3)))
  const centre = new THREE.Vector3().applyMatrix4(rigid)

  it('answers rays as a fresh tree does after a rotation and a translation', () => {
    const geometry = lumpySphere(mulberry32(5))
    geometry.boundsTree = new MeshBVH(geometry)
    const tree = geometry.boundsTree
    bake(geometry, rigid)
    refitAfterRigid(geometry)
    expect(geometry.boundsTree).toBe(tree)
    expectSameAnswers(geometry, centre)
  })

  it('answers rays as a fresh tree does after a mirroring', () => {
    const geometry = lumpySphere(mulberry32(6))
    geometry.boundsTree = new MeshBVH(geometry)
    const mirror = new THREE.Matrix4().makeScale(-1, 1, 1).premultiply(rigid)
    bake(geometry, mirror)
    refitAfterRigid(geometry)
    expectSameAnswers(geometry, new THREE.Vector3().applyMatrix4(mirror))
  })

  it('renews the bounding box and sphere the culling reads', () => {
    const geometry = lumpySphere(mulberry32(7))
    geometry.boundsTree = new MeshBVH(geometry)
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    bake(geometry, rigid)
    refitAfterRigid(geometry)
    const fresh = geometry.clone()
    fresh.computeBoundingBox()
    fresh.computeBoundingSphere()
    expect(geometry.boundingBox!.min.distanceTo(fresh.boundingBox!.min)).toBeLessThan(1e-9)
    expect(geometry.boundingBox!.max.distanceTo(fresh.boundingBox!.max)).toBeLessThan(1e-9)
    expect(geometry.boundingSphere!.center.distanceTo(fresh.boundingSphere!.center)).toBeLessThan(1e-9)
    expect(geometry.boundingSphere!.radius).toBeCloseTo(fresh.boundingSphere!.radius, 9)
    // The root of the tree encloses the moved part, not the old one.
    const root = geometry.boundsTree!.getBoundingBox(new THREE.Box3())
    expect(root.containsBox(geometry.boundingBox!.clone().expandByScalar(-1e-4))).toBe(true)
    expect(root.min.distanceTo(geometry.boundingBox!.min)).toBeLessThan(1e-4)
  })

  it('builds a tree when the geometry has none', () => {
    const geometry = lumpySphere(mulberry32(8))
    bake(geometry, rigid)
    expect(geometry.boundsTree).toBeUndefined()
    refitAfterRigid(geometry)
    expect(geometry.boundsTree).toBeInstanceOf(MeshBVH)
    expectSameAnswers(geometry, centre)
  })
})

// SPDX-License-Identifier: AGPL-3.0-only
// The scan's bounds tree is built in the mesh worker and laid over the render
// thread's geometry when it comes back (viewer/bvh.ts treeOffThread). What has
// to hold: a ray through that tree meets exactly what it meets through a tree
// built on the render thread, the index the tree came back for is not touched
// — it is already on the GPU, and the section caps and the picks read it by
// triangle — and a tree that lands on a geometry since moved, laid out again
// or given up is made to fit it or turned away.
import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { acceleratedRaycast, computeBoundsTree, MeshBVH } from 'three-mesh-bvh'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SerializedTree, WorkerRequest, WorkerResponse } from '../src/core/workerProtocol'
import { buildBinaryStl } from '../src/core/exportStl'
import { forgetTree, refitAfterRigid, sparingRays, treeAwaited, treeOffThread } from '../src/viewer/bvh'
import { clippedRaycast } from '../src/viewer/clipRaycast'
import { cylinderMesh } from './helpers'
import { fixture } from './fixtures'

const ballbar = fixture('ballbar.stl')

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

/** The scan's render geometry as the viewport lays it out: positions and the
 *  index as drawn, over arrays of its own. */
function renderGeometry(positions: Float32Array, indices: Uint32Array): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions.slice(), 3))
  geometry.setIndex(new THREE.BufferAttribute(indices.slice(), 1))
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

/** Every hit of 600 rays aimed at the part from a shell around it, through a
 *  mesh as the viewport picks — each hit the distance and the triangle's
 *  corners, read off the geometry's own index at the face the hit names, so
 *  the trees are compared by the triangles they find and not by the order
 *  they keep them in. Each ray aims just off one of the part's own corners:
 *  aimed into its bounding sphere instead, the rays all but miss a long thin
 *  part like the ball bar. The corners are read off the positions, which
 *  neither tree reorders, so both meshes get the same rays. */
function hitsThrough(geometry: THREE.BufferGeometry, seed: number): string[][] {
  const rand = mulberry32(seed)
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
  mesh.raycast = acceleratedRaycast
  const sphere = geometry.boundingSphere!
  const raycaster = new THREE.Raycaster()
  const index = geometry.getIndex()!
  const position = geometry.getAttribute('position')
  const out: string[][] = []
  for (let i = 0; i < 600; i++) {
    const z = rand() * 2 - 1
    const phi = rand() * Math.PI * 2
    const r = Math.sqrt(1 - z * z)
    const dir = new THREE.Vector3(r * Math.cos(phi), r * Math.sin(phi), z)
    const corner = Math.floor(rand() * position.count)
    const aim = new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(sphere.radius * 1e-3)
      .add(new THREE.Vector3(position.getX(corner), position.getY(corner), position.getZ(corner)))
    raycaster.ray.origin.copy(aim).addScaledVector(dir, -sphere.radius * 4)
    raycaster.ray.direction.copy(dir)
    const hits = raycaster.intersectObject(mesh, false)
    out.push(
      hits
        .map((h) => {
          const f = h.faceIndex! * 3
          const corners = [index.getX(f), index.getX(f + 1), index.getX(f + 2)].sort((a, b) => a - b)
          return `${h.distance.toFixed(9)}:${corners.join(',')}`
        })
        .sort(),
    )
  }
  return out
}

/** The worker's tree laid over a geometry, as the render thread lays it. */
function adopt(geometry: THREE.BufferGeometry, tree: SerializedTree): void {
  geometry.boundsTree = MeshBVH.deserialize(tree as never, geometry, { setIndex: false })
}

/** The scans: a cylinder split for sharp shading, one large enough that the
 *  tree numbers its triangles in 32 bits, and the ball bar where it is on
 *  hand. */
const scans: [string, () => ArrayBuffer][] = [
  ['a noisy cylinder, its rims split', () => buildBinaryStl(cylinderMesh(10, 30, 48, 12, 0.02).positions, null, null, '')],
  ['a cylinder past 65536 triangles', () => buildBinaryStl(cylinderMesh(10, 30, 256, 160, 0.02).positions, null, null, '')],
]
if (ballbar.exists) {
  scans.push(['the ball bar', () => {
    const b = readFileSync(ballbar.path)
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
  }])
}

describe('the scan\'s bounds tree built in the worker', () => {
  let scope: { onmessage: ((event: { data: WorkerRequest }) => void) | null; postMessage: (msg: WorkerResponse) => void }
  let replies: WorkerResponse[]
  beforeEach(async () => {
    replies = []
    scope = { onmessage: null, postMessage: (msg) => replies.push(msg) }
    vi.stubGlobal('self', scope)
    vi.resetModules()
    await import('../src/core/meshWorker')
  })
  afterEach(() => vi.unstubAllGlobals())
  const send = (msg: WorkerRequest) => {
    replies.length = 0
    scope.onmessage!({ data: msg })
    return replies.at(-1)!
  }

  it('meets on the reference what a tree built on the render thread meets, the index untouched', () => {
    const buffer = buildBinaryStl(cylinderMesh(10, 30, 96, 24, 0.02).positions, null, null, '')
    const loaded = send({ type: 'load-nominal', requestId: 1, name: 'reference.stl', buffer })
    if (loaded.type !== 'nominal-loaded') throw new Error(JSON.stringify(loaded))
    const geometry = renderGeometry(loaded.positions, loaded.indices)
    const drawn = (geometry.getIndex()!.array as Uint32Array).slice()
    const reply = send({ type: 'bounds-tree', requestId: 2, positions: loaded.positions.slice(), indices: loaded.indices.slice() })
    if (reply.type !== 'bounds-tree-ok') throw new Error(JSON.stringify(reply))
    adopt(geometry, reply.tree)
    const here = renderGeometry(loaded.positions, loaded.indices)
    here.computeBoundsTree = computeBoundsTree
    here.computeBoundsTree()
    const want = hitsThrough(here, 11)
    expect(want.filter((h) => h.length > 0).length).toBeGreaterThan(200)
    expect(hitsThrough(geometry, 11)).toEqual(want)
    expect(geometry.getIndex()!.array).toEqual(drawn)
  })

  for (const [name, file] of scans) {
    it(`meets what a tree built on the render thread meets, the index untouched: ${name}`, () => {
      const loaded = send({ type: 'load', requestId: 1, name: 'scan.stl', buffer: file(), crease: { mode: 'on', angleDeg: 30 } })
      if (loaded.type !== 'loaded') throw new Error(JSON.stringify(loaded))
      expect(loaded.copyOf.length).toBeGreaterThan(0)

      const geometry = renderGeometry(loaded.positions, loaded.indices)
      const drawn = (geometry.getIndex()!.array as Uint32Array).slice()
      const reply = send({ type: 'bounds-tree', requestId: 2, positions: loaded.positions.slice(), indices: loaded.indices.slice() })
      if (reply.type !== 'bounds-tree-ok') throw new Error(JSON.stringify(reply))
      adopt(geometry, reply.tree)
      expect((geometry.boundsTree as unknown as { indirect: boolean }).indirect).toBe(true)

      const here = renderGeometry(loaded.positions, loaded.indices)
      here.computeBoundsTree = computeBoundsTree
      here.computeBoundsTree()

      const got = hitsThrough(geometry, 7)
      const want = hitsThrough(here, 7)
      // The ground truth must not be vacuous: most rays hit the part.
      expect(want.filter((h) => h.length > 0).length).toBeGreaterThan(200)
      expect(got).toEqual(want)
      // The index drawn is the index sent, triangle for triangle.
      expect(geometry.getIndex()!.array).toEqual(drawn)
    })
  }
})

describe('a tree built off the thread, landing', () => {
  /** A part, and a build of its tree that comes back when the test says,
   *  over the arrays as they were when it was asked for. */
  function pending(seed: number) {
    const sphere = new THREE.SphereGeometry(10, 48, 32)
    const rand = mulberry32(seed)
    const p = sphere.getAttribute('position') as THREE.BufferAttribute
    for (let i = 0; i < p.count; i++) {
      const k = 1 + (rand() - 0.5) * 0.2
      p.setXYZ(i, p.getX(i) * k, p.getY(i) * k, p.getZ(i) * k)
    }
    const geometry = renderGeometry(p.array as Float32Array, Uint32Array.from(sphere.getIndex()!.array))
    let land: (fail?: boolean) => Promise<void> = async () => {}
    let asked = 0
    const landed = vi.fn()
    treeOffThread(
      geometry,
      (positions, indices) => {
        asked++
        return new Promise<SerializedTree>((resolve, reject) => {
          land = async (fail = false) => {
            if (fail) reject(new Error('The mesh worker failed.'))
            else {
              const g = new THREE.BufferGeometry()
              g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
              g.setIndex(new THREE.BufferAttribute(indices, 1))
              const tree = MeshBVH.serialize(new MeshBVH(g, { indirect: true } as never), { cloneBuffers: false }) as unknown as SerializedTree
              resolve(tree)
            }
            await new Promise((r) => setTimeout(r, 0))
          }
        })
      },
      landed,
    )
    expect(asked).toBe(1)
    return { geometry, land: (fail?: boolean) => land(fail), landed }
  }

  const rigid = new THREE.Matrix4()
    .makeTranslation(37, -21, 14)
    .multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.7, -1.1, 2.3)))

  /** Bake a transform into the positions as the scan's alignment does. */
  function bake(geometry: THREE.BufferGeometry, m: THREE.Matrix4): void {
    const p = geometry.getAttribute('position') as THREE.BufferAttribute
    const v = new THREE.Vector3()
    for (let i = 0; i < p.count; i++) p.setXYZ(i, ...v.fromBufferAttribute(p, i).applyMatrix4(m).toArray())
    p.needsUpdate = true
  }

  it('is awaited until it lands, then answers as a tree built here does', async () => {
    const { geometry, land, landed } = pending(1)
    const drawn = (geometry.getIndex()!.array as Uint32Array).slice()
    expect(treeAwaited(geometry)).toBe(true)
    await land()
    expect(treeAwaited(geometry)).toBe(false)
    expect(landed).toHaveBeenCalledTimes(1)
    expect((geometry.boundsTree as unknown as { indirect: boolean }).indirect).toBe(true)
    const here = renderGeometry(geometry.getAttribute('position').array as Float32Array, drawn)
    here.computeBoundsTree = computeBoundsTree
    here.computeBoundsTree()
    expect(hitsThrough(geometry, 3)).toEqual(hitsThrough(here, 3))
    expect(geometry.getIndex()!.array).toEqual(drawn)
  })

  it('is not built again on the main thread for a rigid move made while it is awaited, and is refitted to it when it lands', async () => {
    const { geometry, land, landed } = pending(2)
    bake(geometry, rigid)
    refitAfterRigid(geometry)
    expect(geometry.boundsTree).toBeUndefined()
    // The culling bounds follow the move all the same.
    const fresh = geometry.clone()
    fresh.computeBoundingBox()
    expect(geometry.boundingBox!.min.distanceTo(fresh.boundingBox!.min)).toBeLessThan(1e-9)
    await land()
    expect(landed).toHaveBeenCalledTimes(1)
    const here = renderGeometry(geometry.getAttribute('position').array as Float32Array, geometry.getIndex()!.array as Uint32Array)
    here.computeBoundsTree = computeBoundsTree
    here.computeBoundsTree()
    expect(hitsThrough(geometry, 4)).toEqual(hitsThrough(here, 4))
  })

  it('is turned away from a geometry whose positions were laid anew before it landed', async () => {
    const { geometry, land, landed } = pending(8)
    const p = geometry.getAttribute('position') as THREE.BufferAttribute
    geometry.setAttribute('position', new THREE.BufferAttribute((p.array as Float32Array).slice(), 3))
    await land()
    expect(geometry.boundsTree).toBeUndefined()
    expect(landed).not.toHaveBeenCalled()
  })

  it('is turned away from a geometry laid out again before it landed', async () => {
    const { geometry, land, landed } = pending(3)
    // A resplit lays a new index on the same geometry and builds its own.
    geometry.setIndex(new THREE.BufferAttribute((geometry.getIndex()!.array as Uint32Array).slice(), 1))
    await land()
    expect(geometry.boundsTree).toBeUndefined()
    expect(landed).not.toHaveBeenCalled()
  })

  it('is turned away from a geometry that has a tree of its own by then', async () => {
    const { geometry, land, landed } = pending(4)
    const own = new MeshBVH(geometry, { indirect: true } as never)
    geometry.boundsTree = own
    await land()
    expect(geometry.boundsTree).toBe(own)
    expect(landed).not.toHaveBeenCalled()
  })

  it('is turned away from a part taken off the stage before it landed', async () => {
    const { geometry, land, landed } = pending(7)
    forgetTree(geometry)
    expect(treeAwaited(geometry)).toBe(false)
    await land()
    expect(geometry.boundsTree).toBeUndefined()
    expect(landed).not.toHaveBeenCalled()
  })

  it('is built here instead, over the index as it stands, when the worker fails', async () => {
    const { geometry, land, landed } = pending(5)
    const drawn = (geometry.getIndex()!.array as Uint32Array).slice()
    await land(true)
    expect(landed).toHaveBeenCalledTimes(1)
    expect(geometry.boundsTree).toBeInstanceOf(MeshBVH)
    expect(geometry.getIndex()!.array).toEqual(drawn)
  })

  it('spares a hover the ray through every triangle while it is awaited, and not a click', async () => {
    const { geometry, land } = pending(6)
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
    mesh.raycast = clippedRaycast
    const raycaster = new THREE.Raycaster(new THREE.Vector3(0, 0, 50), new THREE.Vector3(0, 0, -1))
    // A click still finds the part, the slow way.
    expect(raycaster.intersectObject(mesh, false).length).toBeGreaterThan(0)
    // The pointer test a frame makes does not.
    expect(sparingRays(() => raycaster.intersectObject(mesh, false))).toHaveLength(0)
    await land()
    expect(sparingRays(() => raycaster.intersectObject(mesh, false)).length).toBeGreaterThan(0)
  })
})

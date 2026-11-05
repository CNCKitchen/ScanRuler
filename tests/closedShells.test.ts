// SPDX-License-Identifier: AGPL-3.0-only
// Which shells of a mesh are closed — what decides where the section view
// closes a cut with a cap and where it leaves it open.
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { buildMeshGraph } from '../src/core/geometry/buildGraph'
import { computeBoundsTree } from 'three-mesh-bvh'
import { NominalSurface } from '../src/core/deviation/surface'
import { closedShells, closedVertices } from '../src/core/geometry/closedShells'
import { scanRender, splitCreases } from '../src/core/geometry/crease'
import { wireSlots } from '../src/core/geometry/wireSlots'
import { closedPartOf, primeClosedPart } from '../src/viewer/sliceCap'

/** A unit cube at `at`, eight corners and twelve triangles wound outward. */
function cube(at: [number, number, number] = [0, 0, 0]): { positions: number[]; indices: number[] } {
  const positions: number[] = []
  for (let i = 0; i < 8; i++) positions.push(at[0] + (i & 1), at[1] + ((i >> 1) & 1), at[2] + ((i >> 2) & 1))
  const quads = [
    [0, 2, 3, 1], // z = 0
    [4, 5, 7, 6], // z = 1
    [0, 1, 5, 4], // y = 0
    [2, 6, 7, 3], // y = 1
    [0, 4, 6, 2], // x = 0
    [1, 3, 7, 5], // x = 1
  ]
  const indices = quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d])
  return { positions, indices }
}

/** Two meshes as one: the second's indices moved past the first's vertices. */
function join(a: { positions: number[]; indices: number[] }, b: { positions: number[]; indices: number[] }) {
  const n = a.positions.length / 3
  return { positions: [...a.positions, ...b.positions], indices: [...a.indices, ...b.indices.map((i) => i + n)] }
}

const run = (m: { positions: number[]; indices: number[] }) => closedShells(new Float32Array(m.positions), new Uint32Array(m.indices))

describe('closedShells', () => {
  it('finds a cube closed', () => {
    const r = run(cube())
    expect(r.count).toBe(12)
    expect([...r.closed].every((c) => c === 1)).toBe(true)
  })

  it('finds a cube with a triangle missing open', () => {
    const m = cube()
    m.indices.splice(0, 3)
    expect(run(m).count).toBe(0)
  })

  it('welds corners repeated for shading, bit for bit', () => {
    // Every face with corners of its own, as a mesh split along its sharp
    // edges is laid out.
    const m = cube()
    const positions: number[] = []
    const indices: number[] = []
    for (const i of m.indices) {
      indices.push(positions.length / 3)
      positions.push(m.positions[3 * i], m.positions[3 * i + 1], m.positions[3 * i + 2])
    }
    expect(run({ positions, indices }).count).toBe(12)
    // And as a soup, with no index at all.
    expect(closedShells(new Float32Array(positions), null).count).toBe(12)
  })

  it('tells the closed shells of a mesh from its open ones', () => {
    const open = cube([5, 0, 0])
    open.indices.splice(0, 6)
    const r = run(join(cube(), open))
    expect(r.count).toBe(12)
    expect([...r.closed.slice(0, 12)].every((c) => c === 1)).toBe(true)
    expect([...r.closed.slice(12)].every((c) => c === 0)).toBe(true)
  })

  it('finds an edge three triangles share open', () => {
    // A fin standing on the cube's top edge: the edge is used three times.
    const m = cube()
    m.positions.push(0.5, 1, 2)
    m.indices.push(6, 7, 8)
    expect(run(m).count).toBe(0)
  })

  it('counts a negative zero as zero', () => {
    const m = cube()
    const positions = new Float32Array(m.positions)
    // The same corner written as −0 in one triangle and 0 in the rest.
    const extra = positions.length / 3
    const withCopy = new Float32Array([...positions, -0, -0, -0])
    const indices = new Uint32Array(m.indices)
    indices[0] = extra
    expect(closedShells(withCopy, indices).count).toBe(12)
  })
})

/** The meshes above, each as it reaches the worker. */
const fixtures = (): [string, { positions: number[]; indices: number[] }][] => {
  const holed = (at: [number, number, number]) => {
    const c = cube(at)
    c.indices.splice(0, 6)
    return c
  }
  const fin = cube()
  fin.positions.push(0.5, 1, 2)
  fin.indices.push(6, 7, 8)
  // Closed and open cubes taken in turn but laid out in another order, so
  // a bounds tree over them puts the triangles in an order of its own and
  // a mask in the order they came in reads the wrong cubes.
  const mixed = [5, 2, 7, 0, 3, 6, 1, 4].map((slot, i) => (i % 2 ? holed : cube)([5 * slot, 3 * (slot % 3), 2 * (i % 3)])).reduce(join)
  return [
    ['a closed cube', cube()],
    ['a cube with a hole', holed([5, 0, 0])],
    ['a closed cube beside an open one', join(cube(), holed([5, 0, 0]))],
    ['a cube with a fin', fin],
    ['closed and open cubes taken in turn', mixed],
  ]
}

/** A geometry laid out as the viewport lays out a part: the render arrays
 *  the worker posts, indexed — and, with `tree`, a bounds tree built over
 *  it as the viewport builds one before the part is shown, which puts the
 *  index in an order of its own. */
function geometryOf(positions: Float32Array, indices: Uint32Array, tree = false): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  g.setIndex(new THREE.BufferAttribute(indices, 1))
  if (tree) computeBoundsTree.call(g)
  return g
}

const welded = (mesh: { positions: number[]; indices: number[] }) =>
  buildMeshGraph({ kind: 'indexed', positions: new Float32Array(mesh.positions), indices: new Uint32Array(mesh.indices) })

/** Prime a geometry built on `positions`/`indices` as the viewport builds
 *  it with the worker's `flags`, and hold what it keeps against what the
 *  viewport would have found on its own on the same arrays. */
function expectPrimedAsFound(positions: Float32Array, indices: Uint32Array, flags: Uint8Array): void {
  const primed = geometryOf(positions, indices, true)
  expect(primeClosedPart(primed, flags)).toBe(true)
  const found = closedPartOf(geometryOf(positions.slice(), (primed.getIndex()!.array as Uint32Array).slice()))
  const kept = closedPartOf(primed)
  expect([...kept.closed]).toEqual([...found.closed])
  expect(kept.count).toBe(found.count)
  expect(kept.total).toBe(found.total)
  expect(kept.index ? [...kept.index] : null).toEqual(found.index ? [...found.index] : null)
}

describe('closed shells from the worker', () => {
  // The worker finds them on its own welded copy — the scan's graph, the
  // reference's surface, whose triangles a bounds tree has reordered —
  // while the viewport's copy is split at the sharp edges for shading and
  // reordered by a bounds tree of its own. A vertex at a time, the answer
  // has to come out as the one the viewport would have found, triangle for
  // triangle.
  for (const [name, mesh] of fixtures()) {
    it(`primes the scan as the viewport would find it on ${name}`, () => {
      const graph = welded(mesh)
      for (const mode of ['on', 'off', 'auto'] as const) {
        const render = scanRender(graph, { mode, angleDeg: 30 })
        // The worker's index put in another order, as a thickness ray's
        // tree puts it.
        const reordered = graph.indices.slice()
        for (let t = 0, n = reordered.length / 3; t < n / 2; t++) {
          for (let c = 0; c < 3; c++) {
            const a = 3 * t + c
            const b = 3 * (n - 1 - t) + c
            ;[reordered[a], reordered[b]] = [reordered[b], reordered[a]]
          }
        }
        expectPrimedAsFound(render.positions, render.indices, closedVertices(graph.positions, reordered, render.copyOf))
      }
    })

    it(`primes the reference as the viewport would find it on ${name}`, () => {
      const graph = welded(mesh)
      // As the worker loads a reference: its surface first, its picture
      // split from the welded arrays after.
      const surface = new NominalSurface(graph.positions, graph.indices)
      const split = splitCreases(graph.positions, graph.indices, wireSlots(graph.adjOffsets, graph.adjList, graph.vertexCount))
      const positions = split ? split.positions : graph.positions.slice()
      const indices = split ? split.indices : graph.indices.slice()
      expectPrimedAsFound(positions, indices, closedVertices(surface.positions, surface.index, split ? split.copyOf : []))
    })
  }

  it("turns away flags that are not this geometry's", () => {
    const m = cube()
    const g = geometryOf(new Float32Array(m.positions), new Uint32Array(m.indices))
    // A vertex short: an answer about some other mesh.
    expect(primeClosedPart(g, new Uint8Array(7).fill(1))).toBe(false)
    // Found on the geometry itself instead.
    expect(closedPartOf(g).count).toBe(12)
  })

  it('reads a vertex at a time as closedShells reads a triangle at a time', () => {
    for (const [, mesh] of fixtures()) {
      const p = new Float32Array(mesh.positions)
      const i = new Uint32Array(mesh.indices)
      const flags = closedVertices(p, i)
      expect([...closedShells(p, i).closed]).toEqual(Array.from({ length: i.length / 3 }, (_, t) => flags[i[3 * t]]))
    }
  })
})

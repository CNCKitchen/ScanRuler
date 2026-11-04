// SPDX-License-Identifier: AGPL-3.0-only
// Which shells of a mesh are closed — what decides where the section view
// closes a cut with a cap and where it leaves it open.
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { buildMeshGraph } from '../src/core/geometry/buildGraph'
import { closedShells, type ClosedShells } from '../src/core/geometry/closedShells'
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
  const holed = cube([5, 0, 0])
  holed.indices.splice(0, 6)
  const fin = cube()
  fin.positions.push(0.5, 1, 2)
  fin.indices.push(6, 7, 8)
  return [
    ['a closed cube', cube()],
    ['a cube with a hole', holed],
    ['a closed cube beside an open one', join(cube(), holed)],
    ['a cube with a fin', fin],
  ]
}

/** A geometry laid out as the viewport lays out a part: the render arrays
 *  the worker posts, indexed. */
function geometryOf(positions: Float32Array, indices: Uint32Array): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  g.setIndex(new THREE.BufferAttribute(indices, 1))
  return g
}

const plain = (s: ClosedShells) => ({ closed: [...s.closed], count: s.count })

describe('closed shells from the worker', () => {
  // The worker finds them on its own welded copy — the scan's graph, the
  // reference's surface — while the viewport's copy of the same triangles
  // is split at the sharp edges for shading. The answer has to be the one
  // the viewport would have found on its own, triangle for triangle.
  for (const [name, mesh] of fixtures()) {
    it(`agrees with the viewport's own on ${name}`, () => {
      const graph = buildMeshGraph({ kind: 'indexed', positions: new Float32Array(mesh.positions), indices: new Uint32Array(mesh.indices) })
      const worker = closedShells(graph.positions, graph.indices)
      // The scan, split as the setting says, every way it can be.
      for (const mode of ['on', 'off', 'auto'] as const) {
        const render = scanRender(graph, { mode, angleDeg: 30 })
        expect(plain(worker), mode).toEqual(plain(closedShells(render.positions, render.indices)))
      }
      // The reference, always split.
      const slots = wireSlots(graph.adjOffsets, graph.adjList, graph.vertexCount)
      const split = splitCreases(graph.positions, graph.indices, slots)
      if (split) expect(plain(worker)).toEqual(plain(closedShells(split.positions, split.indices)))
    })

    it(`primes the viewport's cache with what it would have found on ${name}`, () => {
      const graph = buildMeshGraph({ kind: 'indexed', positions: new Float32Array(mesh.positions), indices: new Uint32Array(mesh.indices) })
      const render = scanRender(graph, { mode: 'on', angleDeg: 30 })
      const primed = geometryOf(render.positions, render.indices)
      expect(primeClosedPart(primed, closedShells(graph.positions, graph.indices))).toBe(true)
      const found = closedPartOf(geometryOf(render.positions.slice(), render.indices.slice()))
      const kept = closedPartOf(primed)
      expect([...kept.closed]).toEqual([...found.closed])
      expect(kept.count).toBe(found.count)
      expect(kept.total).toBe(found.total)
      expect(kept.index ? [...kept.index] : null).toEqual(found.index ? [...found.index] : null)
    })
  }

  it('turns away an answer about other triangles', () => {
    const m = cube()
    const g = geometryOf(new Float32Array(m.positions), new Uint32Array(m.indices))
    // One triangle short: a reply about some other mesh.
    const other = run({ positions: m.positions, indices: m.indices.slice(3) })
    expect(primeClosedPart(g, other)).toBe(false)
    // Found on the geometry itself instead.
    expect(closedPartOf(g).count).toBe(12)
  })
})

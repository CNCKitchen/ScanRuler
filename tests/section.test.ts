// SPDX-License-Identifier: AGPL-3.0-only
// Cutting a mesh with a plane: closed loops off a closed shape, open chains
// off an open one, points shared between neighbouring triangles so the
// chains come out whole, and the cut laid flat in its own frame.
import { describe, expect, it } from 'vitest'
import { buildMeshGraph } from '../src/core/geometry/buildGraph'
import {
  chainBounds,
  cutSummary,
  projectCut,
  sliceMesh,
  transformCut,
  type SectionCut,
} from '../src/core/section/slice'
import {
  describeCut,
  frameKey,
  sectionFrameFrom,
  transformFrame,
  type SectionFrame,
} from '../src/core/section/frame'
import { rigidFromAxisAngle } from '../src/core/deviation/rigid'
import type { CylinderFit, PlaneFit, Vec3 } from '../src/core/types'
import { boxMesh, cylinderMesh } from './helpers'

const quiet = () => {}

function welded(soup: Float32Array) {
  const g = buildMeshGraph({ kind: 'soup', positions: soup }, quiet)
  return { positions: g.positions, indices: g.indices }
}

/** Every chain of a cut as arrays of [x, y, z]. */
function chainsOf(cut: SectionCut): Vec3[][] {
  const out: Vec3[][] = []
  for (let c = 0; c + 1 < cut.offsets.length; c++) {
    const chain: Vec3[] = []
    for (let i = cut.offsets[c]; i < cut.offsets[c + 1]; i++) {
      chain.push([cut.points[i * 3], cut.points[i * 3 + 1], cut.points[i * 3 + 2]])
    }
    out.push(chain)
  }
  return out
}

const pathLength = (chain: Vec3[]) => {
  let l = 0
  for (let i = 1; i < chain.length; i++) {
    l += Math.hypot(
      chain[i][0] - chain[i - 1][0],
      chain[i][1] - chain[i - 1][1],
      chain[i][2] - chain[i - 1][2],
    )
  }
  return l
}

describe('slicing a mesh', () => {
  it('cuts a closed box into one closed loop with the box perimeter', () => {
    const { positions, indices } = welded(boxMesh(20, 8))
    const cut = sliceMesh(positions, indices, [0, 0, 3.3], [0, 0, 1])
    const chains = chainsOf(cut)
    expect(chains).toHaveLength(1)
    const loop = chains[0]
    // Closed: the walk ends where it began.
    expect(loop[0]).toEqual(loop[loop.length - 1])
    // Every point lies on the plane, and the loop runs round the 20 mm box.
    for (const p of loop) expect(p[2]).toBeCloseTo(3.3, 5)
    expect(pathLength(loop)).toBeCloseTo(80, 4)
    expect(cutSummary(cut).chains).toBe(1)
  })

  it('cuts a cylinder across its axis into a circle of its radius', () => {
    const { positions, indices } = welded(cylinderMesh(10, 30, 96, 8).positions)
    const cut = sliceMesh(positions, indices, [0, 0, 4], [0, 0, 1])
    const chains = chainsOf(cut)
    expect(chains).toHaveLength(1)
    // The plane crosses the wall's vertical edges on the circle and each
    // quad's diagonal a hair inside it — a 96-gon's chord sags 0.5 µm.
    const sag = 10 * (1 - Math.cos(Math.PI / 96))
    for (const p of chains[0]) {
      const r = Math.hypot(p[0], p[1])
      expect(r).toBeLessThanOrEqual(10 + 1e-5)
      expect(r).toBeGreaterThanOrEqual(10 - sag - 1e-5)
      expect(p[2]).toBeCloseTo(4, 5)
    }
    // A 96-gon's perimeter, not quite 2πr.
    expect(pathLength(chains[0])).toBeCloseTo(96 * 2 * 10 * Math.sin(Math.PI / 96), 2)
  })

  it('cuts a closed cylinder along its axis into one rectangular loop', () => {
    // A plane through the axis cuts wall and caps alike: on a closed shape
    // the section is still one loop — a rectangle 20 wide and 30 tall.
    const { positions, indices } = welded(cylinderMesh(10, 30, 64, 6).positions)
    const cut = sliceMesh(positions, indices, [0, 0, 0], [0, 1, 0])
    const chains = chainsOf(cut)
    expect(chains).toHaveLength(1)
    expect(pathLength(chains[0])).toBeCloseTo(100, 3)
  })

  it('leaves an open surface as an open chain', () => {
    // One quad strip, not welded to anything: a cut across it is a path
    // with two distinct ends.
    const positions = new Float32Array([
      0, 0, 0, 10, 0, 0, 0, 0, 5,
      10, 0, 0, 10, 0, 5, 0, 0, 5,
      10, 0, 0, 20, 0, 0, 10, 0, 5,
      20, 0, 0, 20, 0, 5, 10, 0, 5,
    ])
    const { positions: p, indices } = welded(positions)
    const cut = sliceMesh(p, indices, [0, 0, 2], [0, 0, 1])
    const chains = chainsOf(cut)
    expect(chains).toHaveLength(1)
    const chain = chains[0]
    expect(chain[0]).not.toEqual(chain[chain.length - 1])
    expect(pathLength(chain)).toBeCloseTo(20, 5)
    // Both ends on the strip's sides.
    const xs = [chain[0][0], chain[chain.length - 1][0]].sort((a, b) => a - b)
    expect(xs[0]).toBeCloseTo(0, 5)
    expect(xs[1]).toBeCloseTo(20, 5)
  })

  it('misses a mesh the plane never touches, and drops specks', () => {
    const { positions, indices } = welded(boxMesh(20, 4))
    expect(cutSummary(sliceMesh(positions, indices, [0, 0, 50], [0, 0, 1])).chains).toBe(0)
    // The whole loop is 80 mm; a minimum longer than that leaves nothing.
    expect(
      cutSummary(sliceMesh(positions, indices, [0, 0, 1], [0, 0, 1], { minLength: 100 })).chains,
    ).toBe(0)
  })

  it('runs a chain through a vertex lying exactly on the plane', () => {
    // A box built on a 4 × 4 grid has vertex rows at z = -5, 0, 5 — cut at 0.
    const { positions, indices } = welded(boxMesh(20, 4))
    const cut = sliceMesh(positions, indices, [0, 0, 0], [0, 0, 1])
    const chains = chainsOf(cut)
    expect(chains).toHaveLength(1)
    expect(pathLength(chains[0])).toBeCloseTo(80, 4)
  })

  it('lays the cut flat in the frame, and moves with the part', () => {
    const { positions, indices } = welded(cylinderMesh(10, 30, 64, 6).positions)
    const cut = sliceMesh(positions, indices, [0, 0, 4], [0, 0, 1])
    const frame: SectionFrame = {
      origin: [0, 0, 4],
      normal: [0, 0, 1],
      basisU: [1, 0, 0],
      basisV: [0, 1, 0],
    }
    const flat = projectCut(cut, frame)
    const bounds = chainBounds(flat)!
    expect(bounds.min[0]).toBeCloseTo(-10, 4)
    expect(bounds.max[0]).toBeCloseTo(10, 4)
    expect(bounds.min[1]).toBeCloseTo(-10, 4)
    expect(bounds.max[1]).toBeCloseTo(10, 4)

    // Turn the part a quarter turn about X and shift it: the moved cut in the
    // moved frame reads exactly the same (u, v).
    const m = rigidFromAxisAngle([1, 0, 0], Math.PI / 2)
    m.t[0] = 5
    m.t[2] = -3
    const movedFlat = projectCut(transformCut(cut, m), transformFrame(frame, m))
    for (let i = 0; i < flat.points.length; i++) {
      expect(movedFlat.points[i]).toBeCloseTo(flat.points[i], 4)
    }
    expect(chainBounds({ points: new Float32Array(0), offsets: new Uint32Array(1) })).toBeNull()
  })
})

describe('the section frame', () => {
  const plane: PlaneFit = {
    kind: 'plane',
    center: [1, 2, 3],
    normal: [0, 0, 1],
    basisU: [1, 0, 0],
    basisV: [0, 1, 0],
    extentU: 5,
    extentV: 5,
    sigma: 0,
    usedPoints: 0,
    regionSize: 0,
  }
  const cylinder: CylinderFit = {
    kind: 'cylinder',
    center: [0, 0, 0],
    axis: [0, 1, 0],
    radius: 4,
    length: 20,
    coverage: 360,
    sigma: 0,
    usedPoints: 0,
    regionSize: 0,
  }

  it('slides along the normal by the offset and keeps the plane patch axes', () => {
    const f = sectionFrameFrom(plane, 2.5)!
    expect(f.origin).toEqual([1, 2, 5.5])
    expect(f.normal).toEqual([0, 0, 1])
    expect(f.basisU).toEqual([1, 0, 0])
    expect(f.basisV).toEqual([0, 1, 0])
  })

  it('uses a cylinder axis as the normal, with a perpendicular in-plane X', () => {
    const f = sectionFrameFrom(cylinder, -7)!
    expect(f.origin).toEqual([0, -7, 0])
    expect(f.normal).toEqual([0, 1, 0])
    expect(Math.abs(f.basisU[1])).toBeLessThan(1e-9)
    // U × V = normal: the sheet is seen from the side the normal points to.
    const c: Vec3 = [
      f.basisU[1] * f.basisV[2] - f.basisU[2] * f.basisV[1],
      f.basisU[2] * f.basisV[0] - f.basisU[0] * f.basisV[2],
      f.basisU[0] * f.basisV[1] - f.basisU[1] * f.basisV[0],
    ]
    expect(c[1]).toBeCloseTo(1, 9)
  })

  it('keeps a seeded X across a small change of plane', () => {
    const tilted: PlaneFit = { ...plane, normal: [0.01, 0, 1] }
    const f = sectionFrameFrom(tilted, 0, [0, 1, 0])!
    expect(f.basisU[1]).toBeCloseTo(1, 6)
    // A seed along the normal cannot be kept; a fresh one is chosen.
    const g = sectionFrameFrom(plane, 0, [0, 0, 1])!
    expect(Math.hypot(...g.basisU)).toBeCloseTo(1, 9)
    expect(g.basisU[2]).toBeCloseTo(0, 9)
  })

  it('has no frame for a sphere or a point', () => {
    expect(
      sectionFrameFrom(
        { kind: 'sphere', center: [0, 0, 0], radius: 1, sigma: 0, usedPoints: 0, regionSize: 0 },
        0,
      ),
    ).toBeNull()
  })

  it('keys on the frame and describes the cut', () => {
    const a = frameKey(sectionFrameFrom(plane, 1)!)
    const b = frameKey(sectionFrameFrom(plane, 1.00001)!)
    const c = frameKey(sectionFrameFrom(plane, 1.1)!)
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(describeCut('Plane 1', 2)).toBe('along Plane 1, +2.000 mm')
    expect(describeCut('Plane 1', -0.5)).toBe('along Plane 1, −0.500 mm')
    expect(describeCut(null, 3)).toMatch(/deleted element/)
  })
})

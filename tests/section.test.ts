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
  sectionFrameAlong,
  sectionFrameFrom,
  sectionRefName,
  tiltOf,
  transformFrame,
  turnAxis,
  worldCutAxis,
  worldPlaneName,
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
    expect(describeCut('Plane 1', 2, 4.25)).toBe('along Plane 1, +2.000 mm, tilted 4.3°')
    expect(describeCut(null, 3, 10)).toBe('+3.000 mm from a deleted element, tilted 10.0°')
  })
})

describe('the coordinate planes', () => {
  it('are right-handed frames through the origin, named as CAD names them', () => {
    for (const axis of ['x', 'y', 'z'] as const) {
      const a = worldCutAxis(axis)
      const f = sectionFrameAlong(a, 0)!
      expect(f.origin).toEqual([0, 0, 0])
      // U × V = normal, and U is the next axis round.
      const [u, v, n] = [f.basisU, f.basisV, f.normal]
      expect(u[0] * v[1] * n[2] + u[1] * v[2] * n[0] + u[2] * v[0] * n[1]).toBeCloseTo(1, 12)
    }
    expect(worldCutAxis('z').basisU).toEqual([1, 0, 0])
    expect(worldCutAxis('x').basisU).toEqual([0, 1, 0])
    expect(worldCutAxis('y').basisU).toEqual([0, 0, 1])
    expect(worldPlaneName('z')).toBe('XY plane')
    expect(worldPlaneName('x')).toBe('YZ plane')
    expect(worldPlaneName('y')).toBe('XZ plane')
    // The offset along a coordinate axis is the plane's coordinate on it,
    // wherever the line is put through.
    expect(sectionFrameAlong(worldCutAxis('z'), 12.5)!.origin).toEqual([0, 0, 12.5])
    expect(worldCutAxis('z', [10, 20, 30]).origin).toEqual([10, 20, 0])
    expect(sectionFrameAlong(worldCutAxis('y', [10, 20, 30]), 5)!.origin).toEqual([10, 5, 30])
  })

  it('name a reference for the record: element, plane or nothing', () => {
    const elements = [{ id: 7, name: 'Plane 1' }]
    expect(sectionRefName(7, elements)).toBe('Plane 1')
    expect(sectionRefName(8, elements)).toBeNull()
    expect(sectionRefName('y', elements)).toBe('XZ plane')
    expect(sectionRefName(null, elements)).toBeNull()
  })
})

describe('turning a plane by hand', () => {
  // A plane 5 mm up the Z axis, turned about its own X.
  const axis = worldCutAxis('z')

  it('pivots about the plane’s own origin and keeps the offset', () => {
    const before = sectionFrameAlong(axis, 5)!
    const turned = turnAxis(axis, 5, before.basisU, 30)
    const after = sectionFrameAlong(turned, 5)!
    // The plane still passes through the point the gizmo sat on…
    expect(after.origin[0]).toBeCloseTo(before.origin[0], 12)
    expect(after.origin[1]).toBeCloseTo(before.origin[1], 12)
    expect(after.origin[2]).toBeCloseTo(before.origin[2], 12)
    // …its normal has swung 30° from Z toward −Y (right-handed about +X)…
    expect(after.normal[0]).toBeCloseTo(0, 12)
    expect(after.normal[1]).toBeCloseTo(-Math.sin(Math.PI / 6), 12)
    expect(after.normal[2]).toBeCloseTo(Math.cos(Math.PI / 6), 12)
    // …the axis it turned about is still the sheet's X…
    expect(after.basisU[0]).toBeCloseTo(1, 12)
    // …and the tilt off the reference reads the angle.
    expect(tiltOf(axis.dir, after.normal)).toBeCloseTo(30, 9)
    expect(tiltOf(axis.dir, before.normal)).toBe(0)
    expect(tiltOf(undefined, after.normal)).toBe(0)
  })

  it('composes: a turn about V after one about U is the pair of rotations', () => {
    const f0 = sectionFrameAlong(axis, 5)!
    const a1 = turnAxis(axis, 5, f0.basisU, 20)
    const f1 = sectionFrameAlong(a1, 5)!
    const a2 = turnAxis(a1, 5, f1.basisV, -35)
    const f2 = sectionFrameAlong(a2, 5)!
    // Still through the pivot, still a unit normal, and the tilt is the
    // angle between the two normals whatever route it took.
    for (let i = 0; i < 3; i++) expect(f2.origin[i]).toBeCloseTo(f0.origin[i], 10)
    expect(Math.hypot(...f2.normal)).toBeCloseTo(1, 12)
    const dot = f0.normal[0] * f2.normal[0] + f0.normal[1] * f2.normal[1] + f0.normal[2] * f2.normal[2]
    expect(tiltOf(axis.dir, f2.normal)).toBeCloseTo((Math.acos(dot) * 180) / Math.PI, 9)
    // Turned back the same way, the plane is square again.
    const a3 = turnAxis(a2, 5, f2.basisV, 35)
    const f3 = sectionFrameAlong(a3, 5)!
    const a4 = turnAxis(a3, 5, f3.basisU, -20)
    expect(tiltOf(axis.dir, sectionFrameAlong(a4, 5)!.normal)).toBe(0)
  })

  it('leaves a degenerate or unfinished turn alone', () => {
    expect(turnAxis(axis, 5, [1, 0, 0], NaN)).toBe(axis)
    expect(turnAxis({ origin: [0, 0, 0], dir: [0, 0, 0] }, 5, [1, 0, 0], 10).dir).toEqual([0, 0, 0])
  })
})

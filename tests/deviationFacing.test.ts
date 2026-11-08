// SPDX-License-Identifier: AGPL-3.0-only
// The facing-aware closest-point query on its own (closestFacingWay), the
// vote that settles which way a scan's normals are wound when only some of
// the scan lies on the surface (scanNormalsSign with `near`), and a
// surface's cut in a section picture, which has no inside.

import { describe, expect, it } from 'vitest'
import { Gap, sectionPictureModel } from '../src/app/sectionPicture'
import type { SectionOutline } from '../src/commands/sectionLayers'
import { closestFacingWay, scanNormalsSign } from '../src/core/deviation/deviation'
import { identityRigid } from '../src/core/deviation/rigid'
import { emptyHit, NominalSurface } from '../src/core/deviation/surface'

/** A closed box from `min` to `max`, twelve triangles wound outward. */
function box(min: [number, number, number], max: [number, number, number]): NominalSurface {
  const positions = new Float32Array(24)
  for (let i = 0; i < 8; i++) {
    positions[i * 3] = i & 1 ? max[0] : min[0]
    positions[i * 3 + 1] = i & 2 ? max[1] : min[1]
    positions[i * 3 + 2] = i & 4 ? max[2] : min[2]
  }
  const faces = [0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5]
  return new NominalSurface(positions, Uint32Array.from(faces))
}

describe('the closest point under a facing limit', () => {
  // A plate 1 mm thick: its top at z = 0, its bottom at z = −1.
  const plate = box([-10, -10, -1], [10, 10, 0])

  it('reads a point sunk past half the wall against the face it faces', () => {
    const hit = emptyHit()
    // Facing up, 0.7 under the top: the bottom is nearer, and faces away.
    expect(closestFacingWay(plate, 0, 0, -0.7, 0, 0, 1, null, hit)).toBe('nearest')
    expect(hit.signed).toBeCloseTo(-0.3, 6)
    expect(closestFacingWay(plate, 0, 0, -0.7, 0, 0, 1, 0, hit)).toBe('refaced')
    expect(hit.signed).toBeCloseTo(-0.7, 6)
    expect(hit.nz).toBeCloseTo(1, 6)
  })

  it('keeps the plain nearest when nothing facing lies within reach', () => {
    const hit = emptyHit()
    expect(closestFacingWay(plate, 0, 0, -0.7, 0, 0, 1, 0, hit, Infinity, 0.5)).toBe('unfacing')
    expect(hit.signed).toBeCloseTo(-0.3, 6)
    expect(hit.nz).toBeCloseTo(-1, 6)
  })

  it('finds nothing past the search distance', () => {
    expect(closestFacingWay(plate, 0, 0, 5, 0, 0, 1, 0, emptyHit(), 1)).toBe('none')
  })
})

describe('which way the scan is wound', () => {
  // A block whose top is one skin of a wall 2 mm thick; the other skin lies
  // inside the block, facing back at the top.
  const block = box([-15, -15, -20], [15, 15, 0])
  const n = 400
  const positions = new Float32Array(n * 2 * 3)
  const normals = new Float32Array(n * 2 * 3)
  for (let i = 0; i < n; i++) {
    const x = -9 + (18 * (i % 20)) / 19
    const y = -9 + (18 * Math.floor(i / 20)) / 19
    positions.set([x, y, 0.01 * Math.sin(i)], i * 3)
    positions.set([x, y, -2 + 0.01 * Math.cos(i)], (n + i) * 3)
    // Wound inside-out: the top skin's normals point down, the other's up.
    normals.set([0, 0, -1], i * 3)
    normals.set([0, 0, 1], (n + i) * 3)
  }

  it('is settled by the scan on the surface when the scan a wall away outvotes it', () => {
    // Weighted by nearness, the skin on the surface decides: with a scale
    // given, or with the one the scan sets itself.
    expect(scanNormalsSign(block, positions, normals, identityRigid(), { near: 0.1 })).toBe(-1)
    expect(scanNormalsSign(block, positions, normals, identityRigid())).toBe(-1)
  })

  it('is not turned by a fixture that outnumbers the part', () => {
    // A quarter of the scan on the top, wound inside-out; three quarters a
    // fixture plate 3 mm above it, its normals pointing up. Counted alike,
    // the fixture's agreement with the top's outward normal wins (issue 34).
    const part = 200
    const fixture = 600
    const pos = new Float32Array((part + fixture) * 3)
    const nor = new Float32Array((part + fixture) * 3)
    for (let i = 0; i < part + fixture; i++) {
      const x = -9 + (18 * (i % 20)) / 19
      const y = -9 + (18 * (Math.floor(i / 20) % 10)) / 9
      const onPart = i < part
      pos.set([x, y, onPart ? 0.01 * Math.sin(i) : 3 + 0.01 * Math.cos(i)], i * 3)
      nor.set([0, 0, onPart ? -1 : 1], i * 3)
    }
    expect(scanNormalsSign(block, pos, nor, identityRigid())).toBe(-1)
  })

  it('takes only the vertices it is given', () => {
    const top = Uint32Array.from({ length: n }, (_, i) => i)
    const other = Uint32Array.from({ length: n }, (_, i) => n + i)
    expect(scanNormalsSign(block, positions, normals, identityRigid(), { vertices: top })).toBe(-1)
    expect(scanNormalsSign(block, positions, normals, identityRigid(), { vertices: other })).toBe(1)
  })
})

describe('a surface’s cut in a section picture', () => {
  const loop: [number, number][] = [[-10, -10], [10, -10], [10, 10], [-10, 10]]
  // A point 0.5 inside the loop's bottom side.
  const scan = [0, -9.5]

  it('has no inside, closed or not', () => {
    const solid: SectionOutline = { label: 'Body', points: loop, closed: true }
    const surface: SectionOutline = { ...solid, surface: true }
    const asSolid = sectionPictureModel({ scan, outlines: [solid], pieces: [], tolerance: 0.1 })
    const asSurface = sectionPictureModel({ scan, outlines: [surface], pieces: [], tolerance: 0.1 })
    expect(asSolid.reading[0]).toBe(Gap.Inside)
    expect(asSurface.reading[0]).toBe(Gap.Outside)
    // Measured to all the same.
    expect(asSurface.distance[0]).toBeCloseTo(0.5, 6)
  })
})

describe('a reference with triangles of no area', () => {
  // A plate wound so its outside is below (normals −Z), its front edge along
  // y = 0 through A, M and B, and two zero-area triangles lying along that
  // edge, as a tessellator leaves on a seam. Their stand-in normal (+Z) once
  // went into M's and the edges' pseudonormals, at 180° each, and turned the
  // sign of a point read off M (issue 34).
  const A = [-1, 0, 0], M = [0, 0, 0], B = [1, 0, 0], C = [1, 2, 0], D = [-1, 2, 0]
  const positions = Float32Array.from([...A, ...M, ...B, ...C, ...D])
  const real = [0, 4, 1, 1, 4, 3, 1, 3, 2]
  const slivers = [0, 1, 2, 2, 1, 0]

  it('reads the sign off the real faces only', () => {
    const plate = new NominalSurface(positions, Uint32Array.from([...real, ...slivers]))
    const hit = emptyHit()
    // Above and in front of M: nearest M, on the inside of a plate whose
    // outside is below.
    expect(plate.closest(0, -0.2, 0.3, hit)).toBe(true)
    expect(hit.signed).toBeLessThan(0)
    // Off the middle of edge A–M, likewise.
    expect(plate.closest(-0.5, -0.2, 0.3, hit)).toBe(true)
    expect(hit.signed).toBeLessThan(0)
    // Below it reads outside.
    expect(plate.closest(0, -0.2, -0.3, hit)).toBe(true)
    expect(hit.signed).toBeGreaterThan(0)
  })
})

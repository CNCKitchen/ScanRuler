// SPDX-License-Identifier: AGPL-3.0-only
// Flat regions on a faceted solid: segmentPlanes finds each face as one
// region with its normal and its neighbours, and a plane grown across a
// shallow crease is told to be two surfaces — while noise, white or in
// smooth blobs, is not.
import { describe, expect, it } from 'vitest'
import { buildMeshGraph } from '../src/core/geometry/buildGraph'
import { scanSpot } from '../src/core/geometry/nearest'
import { fitPlaneFromSeed } from '../src/core/fit/fitPlaneFromSeed'
import { planeRegionReport, segmentPlanes, type Segmentation } from '../src/core/fit/segment'
import type { MeshGraph } from '../src/core/types'
import { chamferedBlock, face, facetedSolid, type Face } from './facetedSolid'
import { icosphere } from './helpers'

const graphOf = (m: { positions: Float32Array; indices: Uint32Array }): MeshGraph =>
  buildMeshGraph({ kind: 'indexed', positions: m.positions, indices: m.indices })

/** Each region's face: the one most of its vertices lie on, and how many. */
function facesOf(s: Segmentation, faceOf: Int32Array) {
  return s.regions.map((_, k) => {
    const counts = new Map<number, number>()
    for (let i = s.offsets[k]; i < s.offsets[k + 1]; i++) counts.set(faceOf[s.vertices[i]], (counts.get(faceOf[s.vertices[i]]) ?? 0) + 1)
    const [face, count] = [...counts].sort((a, b) => b[1] - a[1])[0]
    return { face, purity: count / (s.offsets[k + 1] - s.offsets[k]) }
  })
}

const angleDeg = (a: readonly number[], b: readonly number[]) =>
  (Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) * 180) / Math.PI

/** The block's top split along x = 0 by a crease `deg` shallow. */
function creasedBlock(deg: number): Face[] {
  const t = (deg * Math.PI) / 180
  const faces = chamferedBlock().filter((f) => f.name !== 'bevel')
  faces.push(face('roof', [Math.sin(t), 0, Math.cos(t)], [0, 0, 10]))
  return faces
}

describe('segmentPlanes', () => {
  for (const noise of [0.003, 0.02]) {
    it(`finds every face of a chamfered, bevelled block once (noise ${noise})`, () => {
      const faces = chamferedBlock()
      const m = facetedSolid(faces, { noise })
      const s = segmentPlanes(graphOf(m), { minArea: 10, maxRms: 0.05, maxDeg: 15 })
      expect(s.regions).toHaveLength(faces.length)
      const found = facesOf(s, m.faceOf)
      expect(new Set(found.map((f) => f.face)).size).toBe(faces.length)
      s.regions.forEach((r, k) => {
        const truth = faces[found[k].face]
        expect(found[k].purity).toBeGreaterThan(0.99)
        expect(angleDeg(r.normal, truth.n)).toBeLessThan(0.5)
        expect(r.sigma).toBeLessThan(1.3 * noise + 1e-3)
        expect(r.area).toBeGreaterThan(10)
      })
      // The largest first, and the bottom is the largest.
      expect(faces[found[0].face].name).toBe('bottom')
      for (let k = 1; k < s.regions.length; k++) expect(s.regions[k].area).toBeLessThanOrEqual(s.regions[k - 1].area)
      // Neighbours, with the angle between them.
      const idOf = (name: string) => found.findIndex((f) => faces[f.face].name === name) + 1
      const top = s.regions[idOf('top') - 1]
      expect(top.neighbours.find((n) => n.id === idOf('bevel'))?.deg).toBeCloseTo(25, 0)
      expect(top.neighbours.find((n) => n.id === idOf('bottom'))).toBeUndefined()
      const plusX = s.regions[idOf('+x') - 1]
      expect(plusX.neighbours.find((n) => n.id === idOf('chamfer ++'))?.deg).toBeCloseTo(45, 0)
      expect(plusX.neighbours.find((n) => n.id === idOf('bevel'))?.deg).toBeCloseTo(65, 0)
      expect(s.claimed).toBe(s.offsets[s.regions.length])
    })
  }

  it('keeps to a box, and gives back regions under the least area', () => {
    const faces = chamferedBlock()
    const m = facetedSolid(faces, { noise: 0.01 })
    const g = graphOf(m)
    const s = segmentPlanes(g, { box: { min: [-30, -30, 5], max: [30, 30, 30] }, minArea: 10, maxRms: 0.05, maxDeg: 15 })
    const names = facesOf(s, m.faceOf).map((f) => faces[f.face].name)
    expect(names.slice(0, 2)).toEqual(['top', 'bevel'])
    expect(names).not.toContain('bottom')
    for (let i = 0; i < s.vertices.length; i++) expect(g.positions[s.vertices[i] * 3 + 2]).toBeGreaterThanOrEqual(5)
    // The chamfers are 4.2 mm wide: past 100 mm² only the large faces stay.
    const big = segmentPlanes(g, { minArea: 100, maxRms: 0.05, maxDeg: 15 })
    expect(big.regions.every((r) => r.area >= 100)).toBe(true)
    expect(big.regions.length).toBe(7)
  })

  it('cuts a curved surface no larger than maxRms lets a plane lie on it', () => {
    // On a 20 mm ball a cap stays inside a 20 µm band (2 × maxRms) to about
    // 0.9 mm from its middle: a few mm².
    const ball = icosphere(6, 20, 0.002)
    const s = segmentPlanes(graphOf(ball), { minArea: 0.5, maxRms: 0.01, maxDeg: 15 })
    expect(s.regions.length).toBeGreaterThan(50)
    for (const r of s.regions) {
      expect(r.sigma).toBeLessThanOrEqual(0.01)
      expect(r.area).toBeLessThan(15)
    }
  })
})

describe('a plane grown across two surfaces', () => {
  const fitAt = (g: MeshGraph, at: [number, number, number], within?: { min: [number, number, number]; max: [number, number, number] }) => {
    const spot = scanSpot(g, { point: at })
    const fit = fitPlaneFromSeed(g, [...(spot.triangle ?? [spot.vertex])], { method: 'gaussian', sigma: 3 }, undefined, within ? { within } : undefined)
    return { fit, report: planeRegionReport(g, fit.region, { normal: fit.normal, seed: spot.vertex }) }
  }

  for (const deg of [1, 2]) {
    it(`is told to be two across a ${deg}° crease, and where the second lies`, () => {
      const m = facetedSolid(creasedBlock(deg), { noise: 0.02 })
      const g = graphOf(m)
      const { fit, report } = fitAt(g, [-8, 0, 10], { min: [-16, -10, 5], max: [12, 10, 12] })
      const second = report.second!
      expect(second).toBeDefined()
      // The seed is on the flat half; the second plane is the roof past x = 0,
      // below the flat one and turned by about the crease.
      expect(second.centroid[0]).toBeGreaterThan(1)
      expect(second.min[0]).toBeGreaterThan(-10)
      expect(second.offset).toBeLessThan(0)
      expect(second.angleDeg).toBeGreaterThan(0.6 * deg)
      expect(second.angleDeg).toBeLessThan(1.3 * deg)
      expect(second.rmsTwo).toBeLessThan(0.6 * fit.sigma)
      expect(report.area).toBeGreaterThan(400)
    })
  }

  it('is one surface on a flat face, the noise white or smoothed', () => {
    const m = facetedSolid(chamferedBlock(), { noise: 0.02 })
    let g = graphOf(m)
    for (let round = 0; round <= 8; round++) {
      if (round === 0 || round === 3 || round === 8) {
        for (const at of [[-5, 0, 10], [0, 0, -10], [0, 15, 0], [-20, 0, 0], [16, 0, 13]] as [number, number, number][]) {
          const { report } = fitAt(g, at)
          expect(report.second, `round ${round} at ${at}`).toBeUndefined()
          expect(report.normalSpreadDeg).toBeGreaterThan(0)
        }
      }
      // Noise smoothed over the neighbours, as a scanner's mesh has it.
      const p = g.positions
      const q = new Float32Array(p.length)
      for (let v = 0; v < g.vertexCount; v++) {
        let c = 1
        for (let k = 0; k < 3; k++) q[v * 3 + k] = p[v * 3 + k]
        for (let e = g.adjOffsets[v]; e < g.adjOffsets[v + 1]; e++) {
          const w = g.adjList[e]
          c++
          for (let k = 0; k < 3; k++) q[v * 3 + k] += p[w * 3 + k]
        }
        for (let k = 0; k < 3; k++) q[v * 3 + k] /= c
      }
      g = buildMeshGraph({ kind: 'indexed', positions: q, indices: g.indices })
    }
  })

  it('reports the region’s area and box on the top face', () => {
    const m = facetedSolid(chamferedBlock(), { noise: 0.005 })
    const { report } = fitAt(graphOf(m), [-5, 0, 10])
    // The top runs from x = -20 to the bevel at x = 10, y ±15, less the two
    // chamfered corners: 900 - 9 mm², less the rim the fit peels off.
    expect(report.area).toBeGreaterThan(780)
    expect(report.area).toBeLessThan(900)
    expect(report.min[2]).toBeGreaterThan(9.9)
    expect(report.max[0]).toBeLessThan(10.2)
    expect(report.normalSpreadDeg).toBeLessThan(5)
  })
})

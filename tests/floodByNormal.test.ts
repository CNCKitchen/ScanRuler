// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { buildMeshGraph } from '../src/core/geometry/buildGraph'
import { floodByNormal } from '../src/core/fit/regionGrow'
import { buildSamplePart, SAMPLE_DEPTH, SAMPLE_HEIGHT, SAMPLE_LEG, SAMPLE_WIDTH } from '../src/core/geometry/samplePart'

/** The sample L, flat in its own frame, as a graph with vertex normals. */
function sampleGraph() {
  const part = buildSamplePart(false)
  return buildMeshGraph({ kind: 'indexed', positions: part.positions, indices: part.indices })
}

function vertexAt(g: ReturnType<typeof sampleGraph>, x: number, y: number, z: number): number {
  for (let v = 0; v < g.vertexCount; v++) {
    if (g.positions[v * 3] === x && g.positions[v * 3 + 1] === y && g.positions[v * 3 + 2] === z) return v
  }
  throw new Error(`no vertex at ${x} ${y} ${z}`)
}

describe('click-and-flood by normal angle', () => {
  it('takes one flat face of a tessellated part at a small angle, with its edge rows', () => {
    const g = sampleGraph()
    // The middle of the L's end face: interior vertices share its normal
    // exactly; the vertices on its rim carry a normal averaged with the
    // side faces' and stop the flood.
    const seed = vertexAt(g, 6, 6, SAMPLE_DEPTH)
    const region = floodByNormal(g, seed, 1)
    const face = SAMPLE_WIDTH * SAMPLE_LEG + SAMPLE_LEG * (SAMPLE_HEIGHT - SAMPLE_LEG)
    // Every interior vertex of the face — the rim rows are the ones whose
    // normal leans toward a side, and they lie one step past the interior.
    expect(region.length).toBeGreaterThan(face * 0.7)
    for (const v of region) expect(g.positions[v * 3 + 2]).toBe(SAMPLE_DEPTH)
  })

  it('crosses a right angle only when the angle allows it', () => {
    const g = sampleGraph()
    const seed = vertexAt(g, 6, 6, SAMPLE_DEPTH)
    const wide = floodByNormal(g, seed, 60)
    // Rim normals lean 45° between two faces (or more at a corner), so 60°
    // lets the flood over every edge: the whole part.
    expect(wide.length).toBe(g.vertexCount)
    const capped = floodByNormal(g, seed, 60, 100)
    expect(capped.length).toBe(100)
    expect(floodByNormal(g, -1, 60).length).toBe(0)
  })
})

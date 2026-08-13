import { describe, expect, it } from 'vitest'
import { buildMeshGraph } from '../src/core/geometry/buildGraph'
import { fitSphereFromSeed } from '../src/core/fit/fitSphereFromSeed'
import { icosphere } from './helpers'

describe('seed-to-sphere pipeline on a synthetic ball mesh', () => {
  it('grows from one vertex to the whole sphere and nails the radius', () => {
    const R = 10
    const mesh = icosphere(5, R, 0.005) // 10,242 vertices
    const graph = buildMeshGraph({ kind: 'indexed', ...mesh })
    const out = fitSphereFromSeed(graph, [0], { method: 'gaussian', sigma: 3 })
    expect(Math.abs(out.radius - R)).toBeLessThan(0.01)
    expect(Math.hypot(...out.center)).toBeLessThan(0.01)
    expect(out.regionSize).toBeGreaterThan(graph.vertexCount * 0.95)
    expect(out.sigma).toBeLessThan(0.01)
  })
})

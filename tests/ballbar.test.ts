// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseSTL } from '../src/core/parsers/stl'
import { buildMeshGraph } from '../src/core/geometry/buildGraph'
import { fitSphereFromSeed } from '../src/core/fit/fitSphereFromSeed'
import type { MeshGraph, SphereFitOutput } from '../src/core/types'

/** Acceptance test against a real structured-light scan of a ball bar.
 *  GOM Inspect (Gaussian best-fit, 3-sigma used points) measures this file
 *  at 148.64 mm center distance with sphere sigma ≈ 0.021 mm. */
const FILE = fileURLToPath(new URL('../ballbar.stl', import.meta.url))

describe.skipIf(!existsSync(FILE))('ballbar.stl acceptance', () => {
  it('matches the GOM Inspect reference measurement', () => {
    const buf = readFileSync(FILE)
    const parsed = parseSTL(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
    const graph = buildMeshGraph(parsed)
    console.log(`mesh: ${graph.vertexCount} vertices, ${graph.triangleCount} triangles`)

    // The bar's long axis via PCA; the extreme vertices along it sit on the
    // outer poles of the two spheres — same as a user clicking each ball.
    const axis = principalAxis(graph)
    const proj = new Float64Array(graph.vertexCount)
    for (let v = 0; v < graph.vertexCount; v++) {
      proj[v] =
        graph.positions[v * 3] * axis[0] +
        graph.positions[v * 3 + 1] * axis[1] +
        graph.positions[v * 3 + 2] * axis[2]
    }
    const order = Array.from({ length: graph.vertexCount }, (_, i) => i).sort(
      (a, b) => proj[a] - proj[b],
    )

    const low = fitAtPercentiles(graph, order, [0.0005, 0.002, 0.01, 0.03, 0.05])
    const high = fitAtPercentiles(graph, order, [0.9995, 0.998, 0.99, 0.97, 0.95])

    const dx = high.center[0] - low.center[0]
    const dy = high.center[1] - low.center[1]
    const dz = high.center[2] - low.center[2]
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)

    console.log(
      `sphere A: Ø ${(2 * low.radius).toFixed(4)} mm, sigma ${low.sigma.toFixed(4)}, ` +
        `${low.usedPoints} used / ${low.regionSize} region`,
    )
    console.log(
      `sphere B: Ø ${(2 * high.radius).toFixed(4)} mm, sigma ${high.sigma.toFixed(4)}, ` +
        `${high.usedPoints} used / ${high.regionSize} region`,
    )
    console.log(`center distance: ${dist.toFixed(4)} mm (GOM: 148.64 mm)`)

    expect(Math.abs(dist - 148.64)).toBeLessThan(0.05)
    expect(Math.abs(low.radius - high.radius)).toBeLessThan(0.2)
    expect(low.sigma).toBeLessThan(0.1)
    expect(high.sigma).toBeLessThan(0.1)
    expect(low.usedPoints).toBeGreaterThan(5_000)
    expect(high.usedPoints).toBeGreaterThan(5_000)
  })
})

/** Try a few seeds near one end of the bar and keep the best-supported fit
 *  (largest region). Extreme vertices can land on the mounting stud past the
 *  sphere's pole — a user would click the ball itself, so the test mimics
 *  that by preferring the dominant sphere at that end. */
function fitAtPercentiles(graph: MeshGraph, order: number[], qs: number[]): SphereFitOutput {
  let best: SphereFitOutput | null = null
  let lastError: unknown = new Error('no seeds tried')
  for (const q of qs) {
    const seed = order[Math.min(order.length - 1, Math.floor(q * (order.length - 1)))]
    try {
      const fit = fitSphereFromSeed(graph, [seed], { method: 'gaussian', sigma: 3 })
      if (!best || fit.regionSize > best.regionSize) best = fit
    } catch (e) {
      lastError = e
    }
  }
  if (!best) throw lastError
  return best
}

function principalAxis(graph: MeshGraph): [number, number, number] {
  const { positions, vertexCount } = graph
  let mx = 0, my = 0, mz = 0
  const step = Math.max(1, Math.floor(vertexCount / 100_000))
  let n = 0
  for (let v = 0; v < vertexCount; v += step) {
    mx += positions[v * 3]
    my += positions[v * 3 + 1]
    mz += positions[v * 3 + 2]
    n++
  }
  mx /= n; my /= n; mz /= n
  let cxx = 0, cxy = 0, cxz = 0, cyy = 0, cyz = 0, czz = 0
  for (let v = 0; v < vertexCount; v += step) {
    const x = positions[v * 3] - mx
    const y = positions[v * 3 + 1] - my
    const z = positions[v * 3 + 2] - mz
    cxx += x * x; cxy += x * y; cxz += x * z
    cyy += y * y; cyz += y * z; czz += z * z
  }
  let ax = 1, ay = 1, az = 1
  for (let i = 0; i < 60; i++) {
    const nx = cxx * ax + cxy * ay + cxz * az
    const ny = cxy * ax + cyy * ay + cyz * az
    const nz = cxz * ax + cyz * ay + czz * az
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
    ax = nx / len; ay = ny / len; az = nz / len
  }
  return [ax, ay, az]
}

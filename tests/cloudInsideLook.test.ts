// SPDX-License-Identifier: AGPL-3.0-only
// align.auto's look at the largest face (issue 77): does the scan stand in
// front of it, as a rib's wall does? A mesh answers by casting rays at its
// triangles, a cloud by looking for points that face back at them; both must
// give the same verdict on the same shape.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { WorkerRequest, WorkerResponse } from '../src/core/workerProtocol'
import { buildPointGraph } from '../src/core/geometry/buildPointGraph'
import { insideRays } from '../src/core/geometry/insideRays'
import { type Cloud, cylinderCloud, planeCloud, writePlyCloud } from './cloudFixtures'
import { boxMesh, cylinderMesh } from './helpers'
import { run, startHeadless, stlBytes, type Headless } from './commandKit'

type V3 = [number, number, number]

/** Points on a rectangle: `at` + i*u + j*v for i, j over a grid at about `step`, every normal `n`. */
function rect(at: V3, u: V3, v: V3, n: V3, step: number): Cloud {
  const nu = Math.max(1, Math.round(Math.hypot(...u) / step))
  const nv = Math.max(1, Math.round(Math.hypot(...v) / step))
  const p: number[] = []
  const nn: number[] = []
  for (let i = 0; i <= nu; i++)
    for (let j = 0; j <= nv; j++) {
      for (let k = 0; k < 3; k++) p.push(at[k] + (u[k] * i) / nu + (v[k] * j) / nv)
      nn.push(...n)
    }
  return { positions: Float32Array.from(p), normals: Float32Array.from(nn) }
}

function join(...parts: Cloud[]): Cloud {
  return {
    positions: Float32Array.from(parts.flatMap((c) => [...c.positions])),
    normals: Float32Array.from(parts.flatMap((c) => [...c.normals])),
  }
}

/** The faces of a box lo..hi, looking out. */
function boxCloud(lo: V3, hi: V3, step: number): Cloud {
  const d: V3 = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]]
  const X: V3 = [d[0], 0, 0], Y: V3 = [0, d[1], 0], Z: V3 = [0, 0, d[2]]
  return join(
    rect([lo[0], lo[1], lo[2]], Y, Z, [-1, 0, 0], step),
    rect([hi[0], lo[1], lo[2]], Y, Z, [1, 0, 0], step),
    rect([lo[0], lo[1], lo[2]], X, Z, [0, -1, 0], step),
    rect([lo[0], hi[1], lo[2]], X, Z, [0, 1, 0], step),
    rect([lo[0], lo[1], lo[2]], X, Y, [0, 0, -1], step),
    rect([lo[0], lo[1], hi[2]], X, Y, [0, 0, 1], step),
  )
}

/** A tall round pot with a rib across its middle whose sides outdo its ends.
 *  The pot is a shell, as a scan of one is: an outer skin looking out and an
 *  inner one looking in, at the rib. */
function pot(): Float32Array {
  const outer = cylinderMesh(20, 60, 96, 24).positions
  const inner = cylinderMesh(19, 58, 96, 24).positions
  // Turned inside out: the second and third corner of every triangle swapped.
  for (let t = 0; t < inner.length; t += 9) for (let k = 0; k < 3; k++) [inner[t + 3 + k], inner[t + 6 + k]] = [inner[t + 6 + k], inner[t + 3 + k]]
  const rib = boxMesh(2, 24)
  for (let i = 0; i < rib.length; i += 3) {
    rib[i] *= 18
    rib[i + 2] = rib[i + 2] * 29 - 1
  }
  const soup = new Float32Array(outer.length + inner.length + rib.length)
  soup.set(outer)
  soup.set(inner, outer.length)
  soup.set(rib, outer.length + inner.length)
  return soup
}

/** The pot as points: the skins, and the rib's sides and ends. */
function potCloud(): Cloud {
  const outer = cylinderCloud({ radius: 20, length: 60, step: 1.2 })
  const inner = cylinderCloud({ radius: 19, length: 58, step: 1.2 })
  const skin = join(outer, { positions: inner.positions, normals: inner.normals.map((x) => -x) })
  return join(skin, boxCloud([-18, -1, -30], [18, 1, 28], 1.2))
}

let headless: Headless
beforeAll(async () => {
  headless = await startHeadless()
})
afterAll(() => headless.stop())

type Auto = { square: { largest: { axis: string; area: number } | null }; largestInside?: { clearMm: number; note: string } }

async function autoOn(kind: 'mesh' | 'cloud', part: { soup: Float32Array; cloud: Cloud }): Promise<Auto> {
  if (kind === 'mesh') await run('scan.open', { bytes: stlBytes(part.soup), name: 'part.stl', discard: true })
  else await run('scan.open', { bytes: new Uint8Array(writePlyCloud(part.cloud, 'binary_little_endian')), name: 'part.ply', discard: true })
  const out = await run<Auto>('align.auto', { level: 'largest' })
  await run('align.clear')
  return out
}

describe('align.auto looks in front of the largest face, on a mesh and on a cloud', () => {
  it('a rib wall faces into the part: the warning, with the same clearance', async () => {
    const part = { soup: pot(), cloud: potCloud() }
    const mesh = await autoOn('mesh', part)
    const cloud = await autoOn('cloud', part)
    expect(mesh.largestInside).toBeDefined()
    expect(cloud.largestInside).toBeDefined()
    expect(cloud.square.largest!.axis).toBe(mesh.square.largest!.axis)
    expect(Math.abs(cloud.largestInside!.clearMm - mesh.largestInside!.clearMm)).toBeLessThan(1.5)
    expect(cloud.largestInside!.note).toMatch(/faces into the part.*an inside wall/)
  })

  it('a plain box has nothing in front of its faces: no warning', async () => {
    const part = { soup: boxMesh(40, 12), cloud: boxCloud([-20, -20, -20], [20, 20, 20], 1.6) }
    expect((await autoOn('mesh', part)).largestInside).toBeUndefined()
    expect((await autoOn('cloud', part)).largestInside).toBeUndefined()
  })
})

describe('insideRays', () => {
  const grid = (z: number) => ({ origin: [-3, -3, z] as V3, dir: [0, 0, 1] as V3, u: [1, 0, 0] as V3, v: [0, 1, 0] as V3, cell: 2, cols: 3, rows: 3, far: 40 })
  const floor = planeCloud({ size: 20, step: 1 })

  it('meets a plane that faces back at the rays, at its height', () => {
    // A ceiling at z = 10 looking down (-z), over a floor looking up.
    const ceiling = { positions: floor.positions.map((v, i) => (i % 3 === 2 ? 10 : v)), normals: floor.normals.map((v, i) => (i % 3 === 2 ? -1 : v)) }
    const g = buildPointGraph({ kind: 'cloud', positions: ceiling.positions, normals: ceiling.normals })
    for (const t of insideRays(g, grid(0.5))) expect(t).toBeCloseTo(9.5, 1)
  })

  it('follows the points when the worker bakes an alignment into them', async () => {
    const ceiling = { positions: floor.positions.map((v, i) => (i % 3 === 2 ? 10 : v)), normals: floor.normals.map((v, i) => (i % 3 === 2 ? -1 : v)) }
    const replies: WorkerResponse[] = []
    const scope = { onmessage: null as ((e: { data: WorkerRequest }) => void) | null, postMessage: (m: WorkerResponse) => replies.push(m) }
    vi.stubGlobal('self', scope)
    vi.resetModules()
    try {
      await import('../src/core/meshWorker')
      const send = (m: Record<string, unknown>, requestId: number) => {
        scope.onmessage!({ data: { ...m, requestId } as WorkerRequest })
        return replies.filter((r) => 'requestId' in r && r.requestId === requestId).at(-1) as WorkerResponse & { values?: Float32Array }
      }
      expect(send({ type: 'load', name: 'ceiling.ply', buffer: writePlyCloud(ceiling, 'binary_little_endian'), crease: { mode: 'on', angleDeg: 30 } }, 1).type).toBe('loaded')
      for (const t of send({ type: 'inside-rays', grid: grid(0.5) }, 2).values!) expect(t).toBeCloseTo(9.5, 1)
      // Moved 25 up: the grid over the points is built again where they now are.
      expect(send({ type: 'transform', transform: { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 25] } }, 3).type).toBe('transform-ok')
      for (const t of send({ type: 'inside-rays', grid: grid(25.5) }, 4).values!) expect(t).toBeCloseTo(9.5, 1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('skips points that face the same way as the rays, and the surface the rays start on', () => {
    // A plate looking up at z = 10 is no wall facing the rays; the floor is behind them.
    const plate = { positions: floor.positions.map((v, i) => (i % 3 === 2 ? 10 : v)), normals: floor.normals }
    const both = {
      positions: Float32Array.from([...floor.positions, ...plate.positions]),
      normals: Float32Array.from([...floor.normals, ...plate.normals]),
    }
    const g = buildPointGraph({ kind: 'cloud', positions: both.positions, normals: both.normals })
    for (const t of insideRays(g, grid(0.5))) expect(Number.isNaN(t)).toBe(true)
  })
})

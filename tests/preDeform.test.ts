// SPDX-License-Identifier: AGPL-3.0-only
// The modelled part moved against the scan's deformation. What has to hold:
// the cut leaves a mesh as closed as it found it, with no edge past the length
// asked for; a vertex moves by minus the scale times the offset the scan has
// there, in the model's frame whatever pose the scan was fitted in; and a
// place the scan says nothing about does not move.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildBinaryStl } from '../src/core/exportStl'
import type { WorkerRequest, WorkerResponse } from '../src/core/workerProtocol'
import { preDeform, refineMesh } from '../src/core/deviation/preDeform'
import { writeDirection } from '../src/core/deviation/deflection'
import { rigidFromAxisAngle } from '../src/core/deviation/rigid'

/** An indexed box x × y × z, outward-wound, eight shared vertices. */
function box(x: number, y: number, z: number): { positions: Float32Array; indices: Uint32Array } {
  const [a, b, c] = [x / 2, y / 2, z / 2]
  const positions = Float32Array.from([
    -a, -b, -c, a, -b, -c, a, b, -c, -a, b, -c,
    -a, -b, c, a, -b, c, a, b, c, -a, b, c,
  ])
  const indices = Uint32Array.from([
    0, 2, 1, 0, 3, 2, // bottom
    4, 5, 6, 4, 6, 7, // top
    0, 1, 5, 0, 5, 4, // front
    1, 2, 6, 1, 6, 5, // right
    2, 3, 7, 2, 7, 6, // back
    3, 0, 4, 3, 4, 7, // left
  ])
  return { positions, indices }
}

/** A mesh is closed when every directed edge appears once and so does its reverse. */
function isClosed(indices: Uint32Array): boolean {
  const seen = new Map<string, number>()
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = indices[t + e], b = indices[t + ((e + 1) % 3)]
      seen.set(`${a},${b}`, (seen.get(`${a},${b}`) ?? 0) + 1)
    }
  }
  for (const [k, n] of seen) {
    const [a, b] = k.split(',')
    if (n !== 1 || seen.get(`${b},${a}`) !== 1) return false
  }
  return true
}

function volume(p: Float32Array, idx: Uint32Array): number {
  let v = 0
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3
    v +=
      (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
        p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
        p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6
  }
  return v
}

function longest(p: Float32Array, idx: Uint32Array): number {
  let m = 0
  for (let t = 0; t < idx.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = idx[t + e] * 3, b = idx[t + ((e + 1) % 3)] * 3
      m = Math.max(m, Math.hypot(p[a] - p[b], p[a + 1] - p[b + 1], p[a + 2] - p[b + 2]))
    }
  }
  return m
}

describe('refineMesh', () => {
  it('leaves no edge past the length, keeps a closed mesh closed and its volume', () => {
    const m = box(40, 20, 10)
    expect(isClosed(m.indices)).toBe(true)
    const cut = refineMesh(m.positions, m.indices, 3)
    expect(longest(cut.positions, cut.indices)).toBeLessThanOrEqual(3 + 1e-4)
    expect(isClosed(cut.indices)).toBe(true)
    expect(volume(cut.positions, cut.indices)).toBeCloseTo(volume(m.positions, m.indices), 2)
    expect(volume(cut.positions, cut.indices)).toBeGreaterThan(0)
    expect(cut.capped).toBe(false)
  })

  it('does not touch a mesh already as fine as asked', () => {
    const m = box(4, 4, 4)
    const cut = refineMesh(m.positions, m.indices, 100)
    expect(cut.indices.length).toBe(m.indices.length)
    expect(Array.from(cut.positions)).toEqual(Array.from(m.positions))
  })

  it('stops at the last pass that fits under the cap, and says how long an edge is left', () => {
    const m = box(40, 20, 10)
    const cut = refineMesh(m.positions, m.indices, 0.1, 5000)
    expect(cut.capped).toBe(true)
    expect(cut.indices.length / 3).toBeLessThanOrEqual(5000)
    expect(cut.indices.length / 3).toBeGreaterThan(m.indices.length / 3)
    expect(cut.longest).toBeGreaterThan(0.1)
    expect(cut.longest).toBeCloseTo(longest(cut.positions, cut.indices), 4)
    expect(isClosed(cut.indices)).toBe(true)
  })

  it('stays closed and exact on a long thin bar, where each pass cuts three for one', () => {
    const m = box(200, 2, 1)
    const cut = refineMesh(m.positions, m.indices, 1.5)
    expect(cut.capped).toBe(false)
    expect(longest(cut.positions, cut.indices)).toBeLessThanOrEqual(1.5 + 1e-4)
    expect(isClosed(cut.indices)).toBe(true)
    expect(volume(cut.positions, cut.indices)).toBeCloseTo(400, 1)
  })
})

/** A scan of a 50 × 50 plate raised by `lift(x, y)`, a vertex a millimetre,
 *  each reading taken along +z. */
function warpedScan(lift: (x: number, y: number) => number) {
  const pts: number[] = []
  for (let x = -25; x <= 25; x++) for (let y = -25; y <= 25; y++) pts.push(x, y, lift(x, y))
  const n = pts.length / 3
  const positions = Float32Array.from(pts)
  const values = new Float32Array(n)
  const directions = new Int8Array(n * 3)
  for (let v = 0; v < n; v++) {
    values[v] = positions[v * 3 + 2]
    writeDirection(directions, v, 0, 0, 1)
  }
  return { positions, values, directions }
}

describe('preDeform', () => {
  // A model plate: the two triangles of a square 40 mm across at z = 0.
  const plate = {
    positions: Float32Array.from([-20, -20, 0, 20, -20, 0, 20, 20, 0, -20, 20, 0]),
    indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
  }
  const identity = { r: Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]), t: new Float64Array(3) }
  const common = { limit: 1, maxDistance: 5, smoothing: 2 }

  it('moves the model against the scan: a scan risen by 0.4 mm pulls the model down by it', () => {
    const scan = warpedScan(() => 0.4)
    const out = preDeform(scan.values, scan.directions, { model: plate, scanPositions: scan.positions, ...common, transform: identity, scale: 1, maxEdge: 5 })
    expect(out.unmoved).toBe(0)
    for (let v = 0; v < out.positions.length / 3; v++) expect(out.positions[v * 3 + 2]).toBeCloseTo(-0.4, 2)
    expect(out.maxMove).toBeCloseTo(0.4, 2)
  })

  it('scales the correction', () => {
    const scan = warpedScan(() => 0.4)
    const out = preDeform(scan.values, scan.directions, { model: plate, scanPositions: scan.positions, ...common, transform: identity, scale: 1.5, maxEdge: 10 })
    for (let v = 0; v < out.positions.length / 3; v++) expect(out.positions[v * 3 + 2]).toBeCloseTo(-0.6, 2)
  })

  it('follows a bend: the correction is the field read at each vertex, not one number', () => {
    const scan = warpedScan((x) => 0.01 * x)
    const out = preDeform(scan.values, scan.directions, { model: plate, scanPositions: scan.positions, ...common, transform: identity, scale: 1, maxEdge: 4 })
    for (let v = 0; v < out.positions.length / 3; v++) {
      // Moved to the model's x plus the cut's: the vertex keeps its x.
      expect(out.positions[v * 3 + 2]).toBeCloseTo(-0.01 * out.positions[v * 3], 1)
    }
  })

  it('reads the field in the scan’s frame and moves the model in its own', () => {
    // transform takes scan to model: a quarter turn about x, then a shift of
    // 10 along x. A rise of 0.4 along scan +z is then 0.4 along model −y, so
    // the model, moved against it, goes +0.4 along y.
    const transform = rigidFromAxisAngle([1, 0, 0], Math.PI / 2)
    transform.t.set([10, 0, 0])
    // The scan plate (z = 0, x ∈ [-25, 25], y ∈ [-25, 25]) in the model's
    // frame lies at y = 0 and spans x ∈ [-15, 35]. Model plate inside it.
    const model = {
      positions: Float32Array.from([-10, 0, -20, 20, 0, -20, 20, 0, 20, -10, 0, 20]),
      indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
    }
    const scan = warpedScan(() => 0.4)
    const out = preDeform(scan.values, scan.directions, { model, scanPositions: scan.positions, ...common, transform, scale: 1, maxEdge: 10 })
    expect(out.unmoved).toBe(0)
    for (let v = 0; v < out.positions.length / 3; v++) expect(out.positions[v * 3 + 1]).toBeCloseTo(0.4, 2)
  })

  describe('smoothing', () => {
    // A noisy scan: every vertex 0.4 mm risen, give or take 0.15 from a fixed
    // pseudo-random sequence, so the unsmoothed field is as rough as the scan.
    const noisy = () => {
      let seed = 7
      const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5) * 0.3
      return warpedScan(() => 0.4 + rand())
    }
    const spread = (zs: number[]) => {
      const mean = zs.reduce((a, b) => a + b, 0) / zs.length
      return Math.sqrt(zs.reduce((a, b) => a + (b - mean) ** 2, 0) / zs.length)
    }
    const zsOf = (out: { positions: Float32Array }) => Array.from({ length: out.positions.length / 3 }, (_, v) => out.positions[v * 3 + 2])
    const run = (scan: ReturnType<typeof warpedScan>, smoothing: number, edge = 2) =>
      preDeform(scan.values, scan.directions, {
        model: plate, scanPositions: scan.positions, limit: 1, maxDistance: 5, transform: identity, scale: 1, maxEdge: edge, smoothing,
      })

    it('a longer smoothing takes the scan’s noise out of the model, a shorter keeps it', () => {
      const scan = noisy()
      const rough = spread(zsOf(run(scan, 0.7)))
      const smooth = spread(zsOf(run(scan, 7)))
      expect(smooth).toBeLessThan(rough * 0.4)
      expect(smooth).toBeLessThan(0.02)
    })

    it('keeps the broad warp at a long smoothing: a linear bend is followed away from the edges', () => {
      const scan = warpedScan((x) => 0.01 * x)
      const out = run(scan, 7)
      let checked = 0
      for (let v = 0; v < out.positions.length / 3; v++) {
        if (Math.abs(out.positions[v * 3]) > 8) continue
        expect(out.positions[v * 3 + 2]).toBeCloseTo(-0.01 * out.positions[v * 3], 1)
        checked++
      }
      expect(checked).toBeGreaterThan(10)
    })

    it('turns a step in the scan into a ramp as wide as the smoothing', () => {
      // 0.4 mm up for x > 0, nothing for x < 0; read a few mm either side.
      const scan = warpedScan((x) => (x > 0 ? 0.4 : 0))
      const at = (smoothing: number) => {
        const out = run(scan, smoothing, 1)
        const zs = new Map<number, number>()
        for (let v = 0; v < out.positions.length / 3; v++) zs.set(Math.round(out.positions[v * 3] * 10) / 10, out.positions[v * 3 + 2])
        return zs
      }
      const sharp = at(0.7)
      const soft = at(7)
      // Three millimetres on the low side: the sharp one has none of the step
      // there, the soft one has taken a good share of it.
      const near = (m: Map<number, number>, x: number) => [...m.entries()].reduce((best, e) => (Math.abs(e[0] - x) < Math.abs(best[0] - x) ? e : best))[1]
      expect(Math.abs(near(sharp, -3))).toBeLessThan(0.02)
      expect(Math.abs(near(soft, -3))).toBeGreaterThan(0.05)
      // And the ramp is monotone across the step, with no step left in it.
      let last = -Infinity
      for (const x of [-10, -6, -3, 0, 3, 6, 10]) {
        const z = -near(soft, x)
        expect(z).toBeGreaterThanOrEqual(last - 1e-4)
        last = z
      }
    })
  })

  it('leaves alone a vertex the scan does not reach, and says how many', () => {
    const scan = warpedScan(() => 0.4)
    const wide = {
      positions: Float32Array.from([-60, -20, 0, 60, -20, 0, 60, 20, 0, -60, 20, 0]),
      indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
    }
    const out = preDeform(scan.values, scan.directions, { model: wide, scanPositions: scan.positions, ...common, transform: identity, scale: 1, maxEdge: 20 })
    expect(out.unmoved).toBeGreaterThan(0)
    for (let v = 0; v < out.positions.length / 3; v++) {
      if (Math.abs(out.positions[v * 3]) > 28) expect(out.positions[v * 3 + 2]).toBe(0)
    }
  })

  it('refuses a map with nothing measured rather than return the model as a result', () => {
    const scan = warpedScan(() => 0.4)
    expect(() =>
      preDeform(scan.values, scan.directions, { model: plate, scanPositions: scan.positions, ...common, maxDistance: 0.1, transform: identity, scale: 1, maxEdge: 5 }),
    ).toThrow(/no measured/)
  })
})

describe('pre-deforming in the worker', () => {
  let scope: { onmessage: ((event: { data: WorkerRequest }) => void) | null; postMessage: (msg: WorkerResponse) => void }
  let replies: WorkerResponse[]
  beforeEach(async () => {
    replies = []
    scope = { onmessage: null, postMessage: (msg) => replies.push(msg) }
    vi.stubGlobal('self', scope)
    vi.resetModules()
    await import('../src/core/meshWorker')
  })
  afterEach(() => vi.unstubAllGlobals())
  const send = (msg: WorkerRequest) => {
    replies.length = 0
    scope.onmessage!({ data: msg })
    return replies.at(-1)!
  }

  /** A flat scan, 50 × 50 mm with a vertex a millimetre, as a binary STL. */
  function scanStl() {
    const idx: number[] = []
    const pos: number[] = []
    for (let x = 0; x <= 50; x++) for (let y = 0; y <= 50; y++) pos.push(x - 25, y - 25, 0)
    for (let x = 0; x < 50; x++) {
      for (let y = 0; y < 50; y++) {
        const a = x * 51 + y, b = (x + 1) * 51 + y, c = (x + 1) * 51 + y + 1, d = x * 51 + y + 1
        idx.push(a, b, c, a, c, d)
      }
    }
    return buildBinaryStl(Float32Array.from(pos), Uint32Array.from(idx), null, 'scan')
  }

  it('cuts the reference once for the count and the file, and moves it against the map', () => {
    const loaded = send({ type: 'load', requestId: 1, name: 'scan.stl', buffer: scanStl(), crease: { mode: 'on', angleDeg: 30 } })
    if (loaded.type !== 'loaded') throw new Error(JSON.stringify(loaded))
    const b = box(30, 30, 1)
    const nominalBuffer = buildBinaryStl(b.positions, b.indices, null, 'nominal')
    expect(send({ type: 'load-nominal', requestId: 2, name: 'plate.stl', buffer: nominalBuffer }).type).toBe('nominal-loaded')

    const plan = send({ type: 'pre-deform-plan', requestId: 3, maxEdge: 4 })
    if (plan.type !== 'pre-deform-plan-ok') throw new Error(JSON.stringify(plan))
    expect(plan.capped).toBe(false)
    expect(plan.longest).toBeLessThanOrEqual(4 + 1e-4)

    const n = loaded.vertexCount
    const values = new Float32Array(n).fill(0.4)
    const directions = new Int8Array(n * 3)
    for (let v = 0; v < n; v++) writeDirection(directions, v, 0, 0, 1)
    const identity = { r: Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]), t: new Float64Array(3) }
    const out = send({
      type: 'pre-deform', requestId: 4, values, directions, limit: 1, maxDistance: 5, smoothing: 2, transform: identity, scale: 1, maxEdge: 4,
    })
    if (out.type !== 'pre-deform-ok') throw new Error(JSON.stringify(out))
    expect(out.indices.length / 3).toBe(plan.triangles)
    expect(isClosed(out.indices)).toBe(true)
    expect(out.unmoved).toBe(0)
    // The plate sat in z ∈ [-0.5, 0.5]; moved against a 0.4 rise.
    const zs = Array.from({ length: out.positions.length / 3 }, (_, v) => out.positions[v * 3 + 2])
    expect(Math.min(...zs)).toBeCloseTo(-0.9, 2)
    expect(Math.max(...zs)).toBeCloseTo(0.1, 2)

    // Asked again at the same edge, the cut is the one kept — and what was sent
    // the first time is the caller's to transfer, so the second answer must not
    // be the same array (a transfer detaches it: "already detached").
    const again = send({
      type: 'pre-deform', requestId: 5, values, directions, limit: 1, maxDistance: 5, smoothing: 2, transform: identity, scale: 2, maxEdge: 4,
    })
    if (again.type !== 'pre-deform-ok') throw new Error(JSON.stringify(again))
    expect(again.indices).not.toBe(out.indices)
    expect(again.indices.length).toBe(out.indices.length)
    expect(Math.min(...Array.from({ length: again.positions.length / 3 }, (_, v) => again.positions[v * 3 + 2]))).toBeCloseTo(-1.3, 2)
  })

  it('says so when there is no reference', () => {
    const reply = send({ type: 'pre-deform-plan', requestId: 1, maxEdge: 4 })
    expect(reply.type).toBe('error')
  })
})

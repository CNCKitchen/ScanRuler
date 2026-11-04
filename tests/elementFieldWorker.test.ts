// SPDX-License-Identifier: AGPL-3.0-only
// The map against an element, measured in the mesh worker. What has to hold is
// that it is the map the main thread would have measured, bit for bit — the
// worker is only somewhere else to do the same sum — and that an answer which
// cannot be the one wanted any more (the inputs moved on, the scan moved or
// was replaced) is never painted, and never leaves the status stuck at
// "running" either.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeElementDeviation, type ElementTarget } from '../src/core/deviation/elementField'
import { suggestRange } from '../src/core/deviation/deviation'
import { rigidApply, rigidApplyToPoints, rigidFromAxisAngle, rigidRotate, rigidRotateVectors } from '../src/core/deviation/rigid'
import { buildBinaryStl } from '../src/core/exportStl'
import { latestWins, runElementMap, type ElementMapResult } from '../src/app/useElementField'
import { MeshWorkerClient, StaleScan } from '../src/core/workerClient'
import type { Vec3 } from '../src/core/types'
import type { WorkerRequest, WorkerResponse } from '../src/core/workerProtocol'
import { cylinderMesh } from './helpers'

const bits = (a: Float32Array | Int8Array) => Array.from(new Uint8Array(a.buffer, a.byteOffset, a.byteLength))

const NO_RESIDUALS = { sigma: 0, usedPoints: 0, regionSize: 0 }
/** The scan's own pose: a cylinder of radius 10 and length 30 about Z, moved
 *  by a datum alignment, as it sits in the viewport. */
const DATUM = (() => {
  const datum = rigidFromAxisAngle([0.3, -0.5, 0.8], 0.7)
  datum.t[0] = 12.5
  datum.t[1] = -3.25
  datum.t[2] = 101
  return datum
})()
const at = (p: Vec3): Vec3 => {
  const out = new Float64Array(3)
  rigidApply(DATUM, p[0], p[1], p[2], out)
  return [out[0], out[1], out[2]]
}
const along = (v: Vec3): Vec3 => {
  const out = new Float64Array(3)
  rigidRotate(DATUM, v[0], v[1], v[2], out)
  return [out[0], out[1], out[2]]
}
/** Elements laid against that scan where it is: on its cap, round its wall,
 *  a ball about its middle and a ring round its waist. */
const targets: [string, ElementTarget][] = [
  ['a plane', { kind: 'plane', ...NO_RESIDUALS, center: at([0, 0, 15]), normal: along([0, 0, 1]), basisU: along([1, 0, 0]), basisV: along([0, 1, 0]), extentU: 9, extentV: 9 }],
  ['a cylinder', { kind: 'cylinder', ...NO_RESIDUALS, center: at([0, 0, 0]), axis: along([0, 0, 1]), radius: 10, length: 20, coverage: 360 }],
  ['a sphere', { kind: 'sphere', ...NO_RESIDUALS, center: at([0, 0, 0]), radius: 12 }],
  ['a torus', { kind: 'torus', ...NO_RESIDUALS, center: at([0, 0, 0]), axis: along([0, 0, 1]), majorRadius: 8, minorRadius: 3, tubeCoverage: 360, spineCoverage: 360 }],
]

describe('the map against an element, worked out in the worker', () => {
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

  /** A scan with its sharp edges split, as the app loads one, and a datum
   *  alignment baked in on both sides — the worker's copy by its transform
   *  message, the viewport's own by the same rotation of its arrays. */
  const loadAndMove = () => {
    const buffer = buildBinaryStl(cylinderMesh(10, 30, 48, 12, 0.02).positions, null, null, '')
    const loaded = send({ type: 'load', requestId: 1, name: 'scan.stl', buffer, crease: { mode: 'on', angleDeg: 30 } })
    if (loaded.type !== 'loaded') throw new Error(JSON.stringify(loaded))
    expect(loaded.copyOf.length).toBeGreaterThan(0)
    rigidApplyToPoints(DATUM, loaded.positions)
    rigidRotateVectors(DATUM, loaded.normals)
    expect(send({ type: 'transform', requestId: 2, transform: DATUM }).type).toBe('transform-ok')
    const own = loaded.vertexCount * 3
    return { positions: loaded.positions.subarray(0, own), normals: loaded.normals.subarray(0, own), vertexCount: loaded.vertexCount }
  }

  it("is not the worker's own normals the viewport shades with, which is why they are sent", () => {
    const { normals, vertexCount } = loadAndMove()
    const held = send({ type: 'query', requestId: 3, min: [-1e9, -1e9, -1e9], max: [1e9, 1e9, 1e9], limit: vertexCount })
    if (held.type !== 'query-ok') throw new Error(JSON.stringify(held))
    expect(held.normals.length).toBe(normals.length)
    // The rims were split for shading: the viewport's normal there is the face's,
    // the worker's the average of the faces that meet.
    expect(bits(held.normals)).not.toEqual(bits(normals))
  })

  const options = [
    ['facing 60°, outward', { side: 1 as const, maxNormalDeviation: Math.PI / 3 }],
    ['any facing, inward', { side: -1 as const, maxNormalDeviation: null }],
  ] as const

  for (const [name, target] of targets) {
    for (const [what, opts] of options) {
      it(`measures what the render thread would, bit for bit: ${name}, ${what}`, () => {
        const { positions, normals, vertexCount } = loadAndMove()
        const directions = new Int8Array(vertexCount * 3)
        const here = computeElementDeviation(target, positions, normals, { ...opts, subset: null, directions })
        const there = send({
          type: 'element-deviation', requestId: 3, target, ...opts, subset: null, maxDistance: 5, normals: normals.slice(),
        })
        if (there.type !== 'element-deviation-ok') throw new Error(JSON.stringify(there))
        expect(there.values.length).toBe(vertexCount)
        expect(bits(there.values)).toEqual(bits(here))
        expect(bits(there.directions)).toEqual(bits(directions))
        expect(there.suggestedRange).toBe(suggestRange(here, 5))
        // Something was measured, and, under the facing limit, something left
        // out by which way the scan faces — so the normals sent are in play. A
        // ball about the cylinder's middle takes every face of it, whichever
        // way it faces, so it is the one left whole.
        expect(here.some((v) => Number.isFinite(v))).toBe(true)
        if (opts.maxNormalDeviation !== null && name !== 'a sphere') expect(here.some((v) => Number.isNaN(v))).toBe(true)
      })
    }
  }

  it('measures only the marked vertices when it is given them', () => {
    const { positions, normals, vertexCount } = loadAndMove()
    const subset = Uint32Array.from({ length: Math.floor(vertexCount / 3) }, (_, i) => i * 3)
    const target = targets[2][1]
    const opts = { side: 1 as const, maxNormalDeviation: null, subset }
    const here = computeElementDeviation(target, positions, normals, opts)
    const there = send({ type: 'element-deviation', requestId: 3, target, ...opts, subset: subset.slice(), maxDistance: 5, normals: normals.slice() })
    if (there.type !== 'element-deviation-ok') throw new Error(JSON.stringify(there))
    expect(bits(there.values)).toEqual(bits(here))
    expect(there.values.filter((v) => !Number.isNaN(v)).length).toBe(subset.length)
    // And an empty mark is an empty map, not the whole scan.
    const none = send({ type: 'element-deviation', requestId: 4, target, side: 1, maxNormalDeviation: null, subset: new Uint32Array(0), maxDistance: 5, normals: normals.slice() })
    if (none.type !== 'element-deviation-ok') throw new Error(JSON.stringify(none))
    expect(none.values.every((v) => Number.isNaN(v))).toBe(true)
  })

  it("measures over the positions sent with the request, where the worker's are not the viewport's", () => {
    const { positions, normals } = loadAndMove()
    const shifted = positions.map((x) => x + 0.375)
    const target = targets[1][1]
    const opts = { side: 1 as const, maxNormalDeviation: null, subset: null }
    const there = send({ type: 'element-deviation', requestId: 3, target, ...opts, maxDistance: 5, normals: normals.slice(), positions: shifted })
    if (there.type !== 'element-deviation-ok') throw new Error(JSON.stringify(there))
    expect(bits(there.values)).toEqual(bits(computeElementDeviation(target, shifted, normals, opts)))
  })

  it('says so when there is no scan, or the normals are not the scan’s', () => {
    expect(send({ type: 'element-deviation', requestId: 1, target: targets[0][1], side: 1, maxNormalDeviation: null, subset: null, maxDistance: 5, normals: new Float32Array(3) }).type).toBe('error')
    const { normals } = loadAndMove()
    const wrong = send({ type: 'element-deviation', requestId: 2, target: targets[0][1], side: 1, maxNormalDeviation: null, subset: null, maxDistance: 5, normals: normals.slice(0, 30) })
    expect(wrong.type).toBe('error')
  })
})

describe('the map asked of the worker', () => {
  /** A client without its worker: the requests it would post, kept, each
   *  answered when the test says. */
  function clientOf() {
    const sent: Record<string, unknown>[] = []
    const answers: (() => void)[] = []
    const client = Object.create(MeshWorkerClient.prototype) as MeshWorkerClient
    Object.assign(client, {
      nextId: 1,
      scanVersion: 0,
      nominalVersion: 0,
      scanToken: 0,
      renderParity: true,
      ready: () => Promise.resolve(),
      request: (msg: Record<string, unknown>) => {
        sent.push(msg)
        return new Promise((resolve) => answers.push(() => resolve({ values: new Float32Array(1), directions: new Int8Array(3), suggestedRange: 0.25 })))
      },
    })
    const settle = async () => {
      await new Promise((r) => setTimeout(r, 0))
      for (const answer of answers.splice(0)) answer()
      await new Promise((r) => setTimeout(r, 0))
    }
    return { client, sent, settle }
  }
  const target = targets[0][1]
  const opts = { side: 1 as const, maxNormalDeviation: null, subset: null, maxDistance: 2 }
  const render = () => ({ positions: Float32Array.of(1, 2, 3), normals: Float32Array.of(0, 0, 1) })

  it('turns away an answer about a scan since moved or replaced', async () => {
    const { client, settle } = clientOf()
    const moved = client.elementDeviation(target, opts, render)
    const movedSettled = expect(moved).rejects.toBeInstanceOf(StaleScan)
    await new Promise((r) => setTimeout(r, 0))
    void client.transform(rigidFromAxisAngle([0, 0, 1], 0.5))
    await settle()
    await movedSettled

    const replaced = client.elementDeviation(target, opts, render)
    const replacedSettled = expect(replaced).rejects.toBeInstanceOf(StaleScan)
    await new Promise((r) => setTimeout(r, 0))
    void client.commitImport({ scan: 7 })
    await settle()
    await replacedSettled

    const kept = client.elementDeviation(target, opts, render)
    await settle()
    await expect(kept).resolves.toMatchObject({ suggestedRange: 0.25 })
  })

  it("sends the viewport's normals always and its positions only where the worker's may not match", async () => {
    const { client, sent, settle } = clientOf()
    const a = client.elementDeviation(target, opts, render)
    await settle()
    await a
    ;(client as unknown as { renderParity: boolean }).renderParity = false
    const b = client.elementDeviation(target, opts, render)
    await settle()
    await b
    expect(sent[0].positions).toBeUndefined()
    expect([...(sent[0].normals as Float32Array)]).toEqual([0, 0, 1])
    expect([...(sent[1].positions as Float32Array)]).toEqual([1, 2, 3])
    expect([...(sent[1].normals as Float32Array)]).toEqual([0, 0, 1])
  })

  it('hands over copies, so what the viewport and the mark hold stay theirs', async () => {
    const { client, sent, settle } = clientOf()
    const held = render()
    const marked = Uint32Array.of(4, 5, 6)
    ;(client as unknown as { renderParity: boolean }).renderParity = false
    const a = client.elementDeviation(target, { ...opts, subset: marked }, () => held)
    await settle()
    await a
    expect(sent[0].normals).not.toBe(held.normals)
    expect(sent[0].positions).not.toBe(held.positions)
    expect(sent[0].subset).not.toBe(marked)
    expect([...(sent[0].subset as Uint32Array)]).toEqual([4, 5, 6])
  })
})

describe('what is done with the answer', () => {
  const result = (range = 0.5): ElementMapResult => ({ values: new Float32Array(2), directions: new Int8Array(6), suggestedRange: range })
  const flush = () => new Promise((r) => setTimeout(r, 0))

  /** One run's surroundings: whether it is still the one wanted, and what was
   *  settled or failed. */
  function run(opts: { ask?: (() => Promise<ElementMapResult>) | null; here?: () => ElementMapResult | null; current?: () => boolean }) {
    const log: string[] = []
    const done = runElementMap({
      ask: opts.ask === undefined ? null : opts.ask,
      here: opts.here ?? (() => result(0.1)),
      current: opts.current ?? (() => true),
      settle: (r) => log.push(`settled ${r.suggestedRange}`),
      fail: () => log.push('failed'),
    })
    return { log, done }
  }

  it("settles with the worker's answer", async () => {
    const { log, done } = run({ ask: async () => result(0.5) })
    await done
    expect(log).toEqual(['settled 0.5'])
  })

  it('drops an answer to a question that has moved on, and settles nothing', async () => {
    let current = true
    const { log, done } = run({ ask: async () => { current = false; return result() }, current: () => current })
    await done
    expect(log).toEqual([])
  })

  it('asks again once of a scan that moved, then measures it here', async () => {
    let asked = 0
    const { log, done } = run({ ask: async () => { asked++; throw new StaleScan() } })
    await done
    expect(asked).toBe(2)
    expect(log).toEqual(['settled 0.1'])
    // The second ask can answer.
    asked = 0
    const again = run({ ask: async () => { if (++asked === 1) throw new StaleScan(); return result(0.7) } })
    await again.done
    expect(again.log).toEqual(['settled 0.7'])
  })

  it('measures it here when the worker cannot, or there is none', async () => {
    const broken = run({ ask: async () => { throw new Error('worker gone') } })
    await broken.done
    expect(broken.log).toEqual(['settled 0.1'])
    const none = run({ ask: null })
    await none.done
    expect(none.log).toEqual(['settled 0.1'])
  })

  it('never leaves the map running: a failure all round fails it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const thrown = run({ ask: async () => { throw new Error('worker gone') }, here: () => { throw new Error('and here') } })
    await thrown.done
    expect(thrown.log).toEqual(['failed'])
    const empty = run({ ask: null, here: () => null })
    await empty.done
    expect(empty.log).toEqual(['failed'])
    warn.mockRestore()
  })

  it('does not fail a map that something newer has taken over', async () => {
    let current = true
    const { log, done } = run({ ask: async () => { current = false; throw new Error('worker gone') }, current: () => current })
    await done
    expect(log).toEqual([])
  })

  it('keeps only the newest of what arrives while one is being worked out', async () => {
    const order: string[] = []
    const releases: (() => void)[] = []
    const queue = latestWins()
    const job = (name: string) => () => {
      order.push(`start ${name}`)
      return new Promise<void>((resolve) => releases.push(() => { order.push(`end ${name}`); resolve() }))
    }
    queue(job('a'))
    queue(job('b'))
    queue(job('c'))
    expect(order).toEqual(['start a'])
    releases.shift()!()
    await flush()
    // b was never asked: c is the newest.
    expect(order).toEqual(['start a', 'end a', 'start c'])
    releases.shift()!()
    await flush()
    expect(order).toEqual(['start a', 'end a', 'start c', 'end c'])
    // Idle again, the next goes straight away.
    queue(job('d'))
    expect(order.at(-1)).toBe('start d')
  })

  it('carries on after a job that throws', async () => {
    const order: string[] = []
    const queue = latestWins()
    queue(async () => { order.push('a'); throw new Error('boom') })
    queue(async () => { order.push('b') })
    await flush()
    await flush()
    expect(order).toEqual(['a', 'b'])
    queue(async () => { order.push('c') })
    await flush()
    expect(order).toEqual(['a', 'b', 'c'])
  })
})

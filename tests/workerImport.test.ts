// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkerRequest, WorkerResponse } from '../src/core/workerProtocol'
import { identityRigid } from '../src/core/deviation/rigid'

const triangle = (x: number) => new TextEncoder().encode(
  `v ${x} 0 0\nv ${x + 1} 0 0\nv ${x} 1 0\nf 1 2 3\n`,
).buffer

describe('worker import transactions', () => {
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
  const load = (id: number, x: number, staged = false) => send({ type: 'load', requestId: id, name: 'scan.obj', buffer: triangle(x), crease: { mode: 'off', angleDeg: 30 }, staged })
  const center = () => {
    const reply = send({ type: 'centroid', requestId: 100 })
    if (reply.type !== 'centroid-ok') throw new Error(JSON.stringify(reply))
    return reply.result.area[0]
  }

  it('keeps the current scan usable until a staged scan is committed', () => {
    load(1, 0)
    load(2, 10, true)
    expect(center()).toBeCloseTo(1 / 3)
    expect(send({ type: 'commit-import', requestId: 3, scan: 2 }).type).toBe('import-ok')
    expect(center()).toBeCloseTo(10 + 1 / 3)
  })

  it('preserves the old scan after parsing a broken replacement', () => {
    load(1, 0)
    expect(send({ type: 'load', requestId: 2, name: 'broken.obj', buffer: new ArrayBuffer(0), crease: { mode: 'off', angleDeg: 30 }, staged: true }).type).toBe('error')
    expect(center()).toBeCloseTo(1 / 3)
  })

  it('discards staged resources without replacing the session', () => {
    load(1, 0)
    load(2, 10, true)
    send({ type: 'discard-import', requestId: 3, ids: [2] })
    expect(send({ type: 'commit-import', requestId: 4, scan: 2 }).type).toBe('error')
    expect(center()).toBeCloseTo(1 / 3)
  })

  it('does not commit half a project when a reference candidate is missing', () => {
    load(1, 0)
    load(2, 10, true)
    expect(send({ type: 'commit-import', requestId: 3, scan: 2, nominal: 999 }).type).toBe('error')
    expect(center()).toBeCloseTo(1 / 3)
  })

  it('clears the worker scan when a project contains no scan', () => {
    load(1, 0)
    send({ type: 'commit-import', requestId: 2, scan: null, nominal: null })
    expect(send({ type: 'centroid', requestId: 3 }).type).toBe('error')
  })

  it('prepares the saved alignment in both render and measurement geometry', () => {
    const transform = identityRigid()
    transform.t[0] = 10
    const reply = send({ type: 'load', requestId: 1, name: 'scan.obj', buffer: triangle(0), crease: { mode: 'off', angleDeg: 30 }, staged: true, transform })
    expect(reply.type).toBe('loaded')
    if (reply.type === 'loaded') expect(reply.positions[0]).toBe(10)
    send({ type: 'commit-import', requestId: 2, scan: 1 })
    expect(center()).toBeCloseTo(10 + 1 / 3)
  })

  it('reads a file in other units as millimetres, in both render and measurement geometry', () => {
    const reply = send({ type: 'load', requestId: 1, name: 'scan.obj', buffer: triangle(0), crease: { mode: 'off', angleDeg: 30 }, staged: true, scale: 25.4 })
    expect(reply.type).toBe('loaded')
    if (reply.type === 'loaded') expect(reply.positions[3]).toBeCloseTo(25.4)
    send({ type: 'commit-import', requestId: 2, scan: 1 })
    expect(center()).toBeCloseTo(25.4 / 3)
    const nominal = send({ type: 'load-nominal', requestId: 3, name: 'ref.obj', buffer: triangle(0), staged: true, scale: 10 })
    expect(nominal.type).toBe('nominal-loaded')
    if (nominal.type === 'nominal-loaded') expect(nominal.bboxDiagonal).toBeCloseTo(10 * Math.SQRT2)
  })

  it('refuses a unit scale that is not a positive number', () => {
    expect(send({ type: 'load', requestId: 1, name: 'scan.obj', buffer: triangle(0), crease: { mode: 'off', angleDeg: 30 }, scale: 0 }).type).toBe('error')
    expect(send({ type: 'load', requestId: 2, name: 'scan.obj', buffer: triangle(0), crease: { mode: 'off', angleDeg: 30 }, scale: NaN }).type).toBe('error')
  })

  it('leaves the active reference intact after a failed staged reference', () => {
    load(1, 0)
    send({ type: 'load-nominal', requestId: 2, name: 'ref.obj', buffer: triangle(0) })
    expect(send({ type: 'load-nominal', requestId: 3, name: 'bad.obj', buffer: new ArrayBuffer(0), staged: true }).type).toBe('error')
    const reply = send({ type: 'deviate', requestId: 4, transform: identityRigid(), facingDeg: 60 })
    expect(reply.type).toBe('deviation-ok')
    if (reply.type === 'deviation-ok') expect([...reply.values]).toEqual([0, 0, 0])
  })
})

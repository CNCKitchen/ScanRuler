// SPDX-License-Identifier: AGPL-3.0-only
// Acceptance: the five Revo passes merged through the real worker, held to
// Revo's own merge of them (Merge_02/model_pointcloud.ply). 0905_02 is the
// scan; the other four open as layers, each started 5 degrees and 5 mm off
// Revo's pose for it, refined onto the scan, then merged with the panel's
// default dedupe (the layers' median spacing). Skipped, loudly, where the
// project is absent (tests/revoFixtures.ts); the time and memory budgets are
// asserted on the heavy run alone (SCANRULER_HEAVY=1, run by itself).

import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkerRequest, WorkerResponse } from '../../../src/core/workerProtocol'
import { oraclePose } from '../../../src/core/deviation/poseScore'
import { identityRigid, rigidApply, rigidCompose, rigidFromAxisAngle, rigidInvert, rigidRotationAngle, type Rigid } from '../../../src/core/deviation/rigid'
import { PointKdTree } from '../../../src/core/geometry/pointKdTree'
import { parsePLY } from '../../../src/core/parsers/ply'
import { revo, type RevoPass } from '../../../tests/revoFixtures'
import { autoDedupe, type LayerRow } from '../state/mergeStore'
import type { AlignReply, MergeOps } from '../core/protocol'

const R = revo()
const HEAVY = process.env.SCANRULER_HEAVY === '1'
const DEG = Math.PI / 180
const CREASE = { mode: 'off', angleDeg: 30 } as const
const LAYERS: RevoPass[] = ['0905_01', '0905_03', '0905_04', '0905_05']

// ---- measured on this machine on 2026-11-09, never loosened -----------------
/** 95th percentile of the distance from each merged point to the nearest
 *  point of Revo's merge: 0.2817 mm measured, × 1.2. (The median is 0.050 mm;
 *  the tail is mostly 0905_01, which our refine lays 0.28 mm from Revo's pose
 *  at its centroid while fitting the scan at the same rms, 0.040 mm.) */
const P95_MEASURED_MM = 0.2817
const P95_LIMIT_MM = 1.2 * P95_MEASURED_MM
/** The worker's merge of the scan and four layers (the `merge` call alone):
 *  1855 ms measured, × 1.5. Heavy run only. */
const MERGE_MS_MEASURED = 1855
const MERGE_BUDGET_MS = 1.5 * MERGE_MS_MEASURED
/** Peak resident memory of the whole test process, five passes held, merged
 *  and Revo's merge read beside them: 674 MiB measured, × 1.5. Heavy run only. */
const RSS_MEASURED_MIB = 674
const RSS_BUDGET = 1.5 * RSS_MEASURED_MIB * 2 ** 20

let scope: { onmessage: ((event: { data: WorkerRequest }) => void) | null; postMessage: (msg: WorkerResponse) => void }
let replies: WorkerResponse[]
let nextId = 1

beforeEach(async () => {
  replies = []
  scope = { onmessage: null, postMessage: (msg) => replies.push(msg) }
  vi.stubGlobal('self', scope)
  vi.resetModules()
  await import('../../../src/core/meshWorker')
})
afterEach(() => vi.unstubAllGlobals())

const send = (msg: WorkerRequest) => scope.onmessage!({ data: msg })

async function reply(id: number, ms = 600_000): Promise<WorkerResponse> {
  const until = Date.now() + ms
  for (;;) {
    const i = replies.findIndex((m) => 'requestId' in m && m.requestId === id && m.type !== 'align-progress')
    if (i >= 0) return replies.splice(i, 1)[0]
    if (Date.now() > until) throw new Error(`No answer to request ${id}.`)
    await new Promise((res) => setTimeout(res, 5))
  }
}

async function call<K extends keyof MergeOps>(op: K, payload: MergeOps[K]['payload']): Promise<MergeOps[K]['result']> {
  const id = nextId++
  send({ type: 'plugin', requestId: id, plugin: 'merge', op, payload })
  const r = await reply(id)
  if (r.type === 'error') throw new Error(r.message)
  if (r.type !== 'plugin-ok') throw new Error(`Unexpected answer ${r.type}.`)
  // Progress messages are not kept: five passes of them would pile up.
  replies = replies.filter((m) => m.type !== 'align-progress')
  return r.result as MergeOps[K]['result']
}

const bytes = (path: string): ArrayBuffer => {
  const b = readFileSync(path)
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

/** A pass loaded as the scan (staged false) or staged for a layer; its request id. */
async function load(n: RevoPass, staged: boolean): Promise<number> {
  const id = nextId++
  send({ type: 'load', requestId: id, name: `${n}.ply`, buffer: bytes(R.pass(n)), crease: CREASE, staged })
  const r = await reply(id)
  if (r.type === 'error') throw new Error(r.message)
  return id
}

function centroid(p: Float32Array): Float64Array {
  const c = new Float64Array(3)
  for (let i = 0; i < p.length; i += 3) for (let a = 0; a < 3; a++) c[a] += p[i + a]
  return c.map((v) => v / (p.length / 3))
}

/** Turns by `deg` about the (1,1,1) diagonal through the layer's centroid,
 *  then moves `mm` along it — as revoOracle.test.ts perturbs its starts. */
function perturbation(deg: number, mm: number, c: Float64Array): Rigid {
  const k = 1 / Math.sqrt(3)
  const d = rigidFromAxisAngle([k, k, k], deg * DEG)
  const rc = new Float64Array(3)
  rigidApply({ r: d.r, t: new Float64Array(3) }, c[0], c[1], c[2], rc)
  for (let a = 0; a < 3; a++) d.t[a] = c[a] - rc[a] + mm * k
  return d
}

/** Distance from every point of `from` to the nearest of `tree`'s, sorted. */
function nearestDistances(from: Float32Array, to: Float32Array, tree: PointKdTree): Float64Array {
  const out = new Float64Array(from.length / 3)
  for (let i = 0; i < out.length; i++) {
    const x = from[3 * i], y = from[3 * i + 1], z = from[3 * i + 2]
    const j = tree.nearest(x, y, z)
    out[i] = j < 0 ? Infinity : Math.hypot(to[3 * j] - x, to[3 * j + 1] - y, to[3 * j + 2] - z)
  }
  return out.sort()
}

const pct = (sorted: Float64Array, p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]

describe.skipIf(!R.exists)('Revo merge acceptance', () => {
  it("merges the five passes onto Revo's own merge", async () => {
    let peak = 0
    const sample = () => { peak = Math.max(peak, process.memoryUsage().rss) }
    const t0 = performance.now()
    await load('0905_02', false)
    sample()

    const rows: Pick<LayerRow, 'visible' | 'isCloud' | 'spacing'>[] = []
    const poses: Record<string, Rigid> = {}
    let layerPoints = 0
    for (const n of LAYERS) {
      const added = await call('add-layer', { stagedId: await load(n, true), id: n, scale: 1 })
      expect(added.isCloud).toBe(true)
      rows.push({ visible: true, isCloud: true, spacing: added.spacing })
      layerPoints += added.vertexCount
      const c = centroid((await call('layer-geometry', { id: n })).positions)
      const oracle = oraclePose(R.oracle(n))
      const start = rigidCompose(oracle, perturbation(5, 5, c))
      const r0 = performance.now()
      const r: AlignReply = await call('refine', { id: n, target: 'base', start })
      if ('stopped' in r || 'refused' in r) throw new Error(`${n} was not refined`)
      const p = new Float64Array(3), q = new Float64Array(3)
      rigidApply(r.pose, c[0], c[1], c[2], p)
      rigidApply(oracle, c[0], c[1], c[2], q)
      console.log(
        `[revo merge] ${n}: ${added.vertexCount} points, refined in ${Math.round(performance.now() - r0)} ms, rms ${r.rms.toFixed(4)}, ` +
          `${(rigidRotationAngle(rigidCompose(rigidInvert(oracle), r.pose)) / DEG).toFixed(3)} deg ${Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]).toFixed(3)} mm off Revo's pose, confident ${r.confident}`,
      )
      expect(r.confident, `${n} refined`).toBe(true)
      poses[n] = r.pose
      sample()
    }

    const dedupe = autoDedupe(rows as LayerRow[])
    expect(dedupe).not.toBeNull()
    const m0 = performance.now()
    const merged = await call('merge', { poses, visible: LAYERS, toFile: identityRigid(), scale: 1, dedupe })
    const mergeMs = performance.now() - m0
    sample()
    const ours = merged.positions
    const count = ours.length / 3

    const theirs = parsePLY(bytes(R.mergeCloud())).positions
    const forward = nearestDistances(ours, theirs, new PointKdTree(theirs))
    sample()
    const reverse = nearestDistances(theirs, ours, new PointKdTree(ours))
    sample()
    const p95 = pct(forward, 0.95)
    console.log(
      `[revo merge] dedupe ${dedupe!.toFixed(4)} mm; ours ${count} points (base ${merged.baseMap.length}, layers ${layerPoints}, dropped ${merged.dropped}), Revo's ${theirs.length / 3}; ` +
        `ours->Revo p50 ${pct(forward, 0.5).toFixed(4)} p95 ${p95.toFixed(4)} p99 ${pct(forward, 0.99).toFixed(4)} mm; ` +
        `Revo->ours p50 ${pct(reverse, 0.5).toFixed(4)} p95 ${pct(reverse, 0.95).toFixed(4)} p99 ${pct(reverse, 0.99).toFixed(4)} mm; ` +
        `merge ${mergeMs.toFixed(0)} ms, whole test ${(performance.now() - t0).toFixed(0)} ms, peak rss ${(peak / 2 ** 20).toFixed(0)} MiB`,
    )

    expect(count).toBe(merged.baseMap.length + layerPoints - merged.dropped)
    expect(p95).toBeLessThanOrEqual(P95_LIMIT_MM)
    if (HEAVY) {
      expect(mergeMs).toBeLessThanOrEqual(MERGE_BUDGET_MS)
      expect(peak).toBeLessThanOrEqual(RSS_BUDGET)
    }
  }, 900_000)
})

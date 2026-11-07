// SPDX-License-Identifier: AGPL-3.0-only
// Wrap's work on one tile at a time, as jobs: plain arrays in, plain arrays
// out, so each can run on any of a pool of workers (wrapTileWorker.ts) — or
// in this thread, one after another. A job's answer depends on nothing but
// the job, so the wrap is the same however many workers there are and in
// whatever order they answer.
//
// There is no memory shared between the workers: the site is not
// cross-origin isolated, which SharedArrayBuffer needs. Each job is handed
// its tile's triangles and what it needs of its neighbours, and hands its
// arrays back; both ways they are transferred, not copied.

import type { MeshoptSimplifier as Simplifier } from 'meshoptimizer/simplifier'
import {
  FAR_OUT,
  TILE,
  tileMarch,
  tilePassA,
  tilePassC,
  tileScratch,
  tileSnap,
  type TileA,
  type TileMesh,
  type TileRuns,
  type TileScratch,
  type WrapPlan,
} from './wrapTile'

export type WrapJob =
  /** Pass A on a tile: its triangles, nine floats each. */
  | { kind: 'a'; plan: WrapPlan; I: number; J: number; K: number; tri: Float32Array }
  /** Pass C on a tile: where the outside begins round it, its free space
   *  and which pieces of it are outside, and pass A's band. */
  | {
      kind: 'c'
      plan: WrapPlan
      seedAt: Uint32Array
      seedFoot: Float32Array
      runs: TileRuns
      outside: Uint8Array
      bandIdx: Uint32Array
      bandDS: Float32Array
    }
  /** The march through a tile: its own field and outside, and what lies on
   *  the layer of points past its +X, +Y and +Z faces — which are outside
   *  (`plusF`, three planes of (T + 1)², X then Y then Z), and the field
   *  where it was worked out there (by number in the (T + 1)³ box). */
  | {
      kind: 'm'
      plan: WrapPlan
      I: number
      J: number
      K: number
      runs: TileRuns
      outside: Uint8Array
      psiIdx: Uint32Array
      psi: Float32Array
      plusF: Uint8Array
      plusIdx: Uint32Array
      plusPsi: Float32Array
    }
  /** Snapping the wrap's vertices in a tile onto its triangles. */
  | {
      kind: 's'
      plan: WrapPlan
      I: number
      J: number
      K: number
      tri: Float32Array
      vertices: Float32Array
      normals: Float32Array
      reach: number
      cosMin: number
      /** How far the wrap stands off the part, mm. */
      offset: number
    }
  /** Reducing a tile's piece of the wrap, the vertices in `lock` held. */
  | { kind: 'r'; indices: Uint32Array; positions: Float32Array; lock: Uint8Array; tolerance: number }

export type WrapJobResult =
  | { kind: 'a'; a: TileA }
  /** The field at the tile's points, and those of them on its −X, −Y or −Z
   *  face — the ones a neighbour's march needs. */
  | { kind: 'c'; idx: Uint32Array; psi: Float32Array; lowIdx: Uint32Array; lowPsi: Float32Array }
  | { kind: 'm'; mesh: TileMesh }
  | { kind: 's'; to: Float32Array; alt: Float32Array; found: Uint8Array; distance: Float32Array; plane: Float32Array }
  | { kind: 'r'; indices: Uint32Array }

/** The buffers a job's arrays live in, to transfer it. */
export function jobBuffers(job: WrapJob): ArrayBuffer[] {
  switch (job.kind) {
    case 'a':
      return [job.tri.buffer as ArrayBuffer]
    case 'c':
      return [job.seedAt.buffer, job.seedFoot.buffer, job.bandIdx.buffer, job.bandDS.buffer] as ArrayBuffer[]
    case 'm':
      return [job.psiIdx.buffer, job.psi.buffer, job.plusF.buffer, job.plusIdx.buffer, job.plusPsi.buffer] as ArrayBuffer[]
    case 's':
      return [job.tri.buffer, job.vertices.buffer, job.normals.buffer] as ArrayBuffer[]
    case 'r':
      return [job.indices.buffer, job.positions.buffer, job.lock.buffer] as ArrayBuffer[]
  }
}

/** The buffers an answer's arrays live in, to transfer it back. */
export function resultBuffers(result: WrapJobResult): ArrayBuffer[] {
  switch (result.kind) {
    case 'a': {
      const a = result.a
      return [a.lineStart.buffer, a.runX.buffer, a.runComp.buffer, a.crossQ.buffer, a.crossDir.buffer, a.crossFoot.buffer, a.bandIdx.buffer, a.bandDS.buffer] as ArrayBuffer[]
    }
    case 'c':
      return [result.idx.buffer, result.psi.buffer, result.lowIdx.buffer, result.lowPsi.buffer] as ArrayBuffer[]
    case 'm':
      return [result.mesh.positions.buffer, result.mesh.keys.buffer, result.mesh.indices.buffer] as ArrayBuffer[]
    case 's':
      return [result.to.buffer, result.alt.buffer, result.found.buffer, result.distance.buffer, result.plane.buffer] as ArrayBuffer[]
    case 'r':
      return [result.indices.buffer as ArrayBuffer]
  }
}

/** Scratch kept from job to job, made again when a box of another size
 *  comes. */
let scratch: TileScratch | null = null
const scratchFor = (plan: WrapPlan): TileScratch => {
  const n = TILE + 2 * Math.max(plan.hS, plan.hF)
  if (!scratch || scratch.n !== n) scratch = tileScratch(plan)
  return scratch
}

/** Which of a tile's core points are outside, from its runs and which of
 *  its pieces are. */
export function coreOutside(runs: TileRuns, outside: Uint8Array, out: Uint8Array): Uint8Array {
  const T = TILE
  out.fill(0)
  for (let L = 0; L < T * T; L++) {
    for (let run = runs.lineStart[L]; run < runs.lineStart[L + 1]; run++) {
      if (outside[runs.runComp[run]]) out.fill(1, T * L + runs.runX[2 * run], T * L + runs.runX[2 * run + 1] + 1)
    }
  }
  return out
}

let coreF: Uint8Array | null = null
let phiBox: Float32Array | null = null

/** Do a job. The simplifier is needed for 'r' only. */
export function runJob(job: WrapJob, simplifier: typeof Simplifier | null): WrapJobResult {
  const T = TILE
  switch (job.kind) {
    case 'a':
      return { kind: 'a', a: tilePassA(job.plan, job.I, job.J, job.K, job.tri, scratchFor(job.plan)) }
    case 'c': {
      coreF ??= new Uint8Array(T * T * T)
      const field = tilePassC(
        job.plan,
        { at: job.seedAt, foot: job.seedFoot },
        coreOutside(job.runs, job.outside, coreF),
        job.bandIdx,
        job.bandDS,
        scratchFor(job.plan),
      )
      // Those on the tile's lower faces, for the neighbours' marches.
      let low = 0
      for (let e = 0; e < field.idx.length; e++) {
        const p = field.idx[e]
        if (p % T === 0 || ((p / T) | 0) % T === 0 || p < T * T) low++
      }
      const lowIdx = new Uint32Array(low)
      const lowPsi = new Float32Array(low)
      low = 0
      for (let e = 0; e < field.idx.length; e++) {
        const p = field.idx[e]
        if (p % T === 0 || ((p / T) | 0) % T === 0 || p < T * T) {
          lowIdx[low] = p
          lowPsi[low++] = field.psi[e]
        }
      }
      return { kind: 'c', idx: field.idx, psi: field.psi, lowIdx, lowPsi }
    }
    case 'm': {
      const m = T + 1
      const plane = m * m
      coreF ??= new Uint8Array(T * T * T)
      phiBox ??= new Float32Array(m * m * m)
      const phi = phiBox
      const lc = job.plan.lc
      coreOutside(job.runs, job.outside, coreF)
      // Far out or far in, as each point is outside or not; then the field
      // where it was worked out.
      for (let k = 0; k < m; k++) {
        for (let j = 0; j < m; j++) {
          const row = m * (j + m * k)
          if (j < T && k < T) {
            const base = T * (j + T * k)
            for (let i = 0; i < T; i++) phi[row + i] = coreF[base + i] ? FAR_OUT : -FAR_OUT
            phi[row + T] = job.plusF[j + m * k] ? FAR_OUT : -FAR_OUT
          } else if (j === T) {
            for (let i = 0; i < m; i++) phi[row + i] = job.plusF[plane + i + m * k] ? FAR_OUT : -FAR_OUT
          } else {
            for (let i = 0; i < m; i++) phi[row + i] = job.plusF[2 * plane + i + m * j] ? FAR_OUT : -FAR_OUT
          }
        }
      }
      const near = new Uint32Array(job.psiIdx.length + job.plusIdx.length)
      for (let e = 0; e < job.psiIdx.length; e++) {
        const p = job.psiIdx[e]
        const at = (p % T) + m * ((((p / T) | 0) % T) + m * ((p / (T * T)) | 0))
        phi[at] = job.psi[e] - lc
        near[e] = at
      }
      for (let e = 0; e < job.plusIdx.length; e++) {
        phi[job.plusIdx[e]] = job.plusPsi[e] - lc
        near[job.psiIdx.length + e] = job.plusIdx[e]
      }
      return { kind: 'm', mesh: tileMarch(job.plan, job.I, job.J, job.K, phi, near) }
    }
    case 's': {
      const found = tileSnap(job.plan, job.I, job.J, job.K, job.tri, job.vertices, job.normals, job.reach, job.cosMin, job.offset)
      return { kind: 's', ...found }
    }
    case 'r': {
      if (!simplifier) throw new Error('No simplifier to reduce with.')
      return { kind: 'r', indices: simplifyFully(simplifier, job.indices, job.positions, job.lock, job.tolerance) }
    }
  }
}

/** Calls of the simplifier on one mesh, each taking up where the one before
 *  stopped, until one takes less than this share off. */
const STILL_REDUCING = 0.97

const NO_ATTRIBUTES = new Float32Array(0)

/** `indices` reduced as far as `tolerance` lets them go, `lock`ed vertices
 *  held: the simplifier called again on its own result while that still
 *  shrinks by more than a few percent. */
export function simplifyFully(simplifier: typeof Simplifier, indices: Uint32Array, positions: Float32Array, lock: Uint8Array, tolerance: number): Uint32Array {
  let current = indices
  for (let call = 0; call < 8; call++) {
    const [reduced] = simplifier.simplifyWithAttributes(current, positions, 3, NO_ATTRIBUTES, 0, [], lock, 0, tolerance, ['ErrorAbsolute'])
    if (reduced.length === 0) return current
    const shrank = reduced.length < current.length * STILL_REDUCING
    current = reduced
    if (!shrank) break
  }
  return current
}

// ---- running them -------------------------------------------------------------------------

/** Where jobs run: a pool of workers, or this thread. */
export interface WrapRunner {
  /** How many jobs it can work on at once. */
  readonly size: number
  run(job: WrapJob): Promise<WrapJobResult>
  dispose(): void
}

/** Jobs done here, one at a time, as they are asked for. */
export function inlineRunner(simplifier: typeof Simplifier | null): WrapRunner {
  return {
    size: 1,
    run: (job) => {
      try {
        return Promise.resolve(runJob(job, simplifier))
      } catch (e) {
        return Promise.reject(e)
      }
    },
    dispose: () => {},
  }
}

/** What a pool needs of a worker: the browser's Worker has it, and Node's
 *  worker_threads one can be made to. */
export interface JobWorker {
  postMessage(message: unknown, transfer: Transferable[]): void
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: ((ev: { message?: string }) => void) | null
  terminate(): void
}

/** What goes to a job worker and comes back. */
export interface JobMessage {
  id: number
  job: WrapJob
}
export type JobAnswer = { id: number; result: WrapJobResult } | { id: number; error: string }

/**
 * `size` workers made by `create`, each given a job as it finishes the one
 * before. A worker that fails fails every job waiting, and the pool with it.
 */
export function workerPool(size: number, create: () => JobWorker): WrapRunner {
  const workers: JobWorker[] = []
  const busy: boolean[] = []
  const waiting: { job: WrapJob; resolve: (r: WrapJobResult) => void; reject: (e: Error) => void }[] = []
  const pending = new Map<number, { resolve: (r: WrapJobResult) => void; reject: (e: Error) => void; worker: number }>()
  let nextId = 1
  let failed: Error | null = null
  const failAll = (error: Error) => {
    failed = error
    for (const p of pending.values()) p.reject(error)
    pending.clear()
    for (const w of waiting) w.reject(error)
    waiting.length = 0
  }
  const pump = () => {
    for (let w = 0; w < size && waiting.length > 0; w++) {
      if (busy[w]) continue
      const next = waiting.shift()!
      if (!workers[w]) {
        const worker = create()
        worker.onmessage = (ev) => {
          const answer = ev.data as JobAnswer
          const entry = pending.get(answer.id)
          if (!entry) return
          pending.delete(answer.id)
          busy[entry.worker] = false
          if ('error' in answer) entry.reject(new Error(answer.error))
          else entry.resolve(answer.result)
          pump()
        }
        worker.onerror = (ev) => failAll(new Error(`A wrap worker failed${ev.message ? `: ${ev.message}` : '.'}`))
        workers[w] = worker
      }
      const id = nextId++
      busy[w] = true
      pending.set(id, { resolve: next.resolve, reject: next.reject, worker: w })
      try {
        workers[w].postMessage({ id, job: next.job } satisfies JobMessage, jobBuffers(next.job))
      } catch (e) {
        pending.delete(id)
        busy[w] = false
        next.reject(e instanceof Error ? e : new Error(String(e)))
      }
    }
  }
  return {
    size,
    run(job) {
      if (failed) return Promise.reject(failed)
      return new Promise((resolve, reject) => {
        waiting.push({ job, resolve, reject })
        pump()
      })
    },
    dispose() {
      failAll(new Error('The wrap workers were stopped.'))
      for (const w of workers) w?.terminate()
      workers.length = 0
    },
  }
}

/**
 * Each of `items` made into a job by `make` and run on `runner`, `done`
 * called with each answer as it comes — a few more jobs handed out than the
 * runner has workers, so none waits, and no more, so the triangles handed
 * out are only those being worked on. `onStep` hears how many are done.
 * With `weight`, the heaviest go first: a tile can hold a hundred times the
 * triangles of the one beside it, and one left to the end keeps every
 * other worker waiting.
 */
export async function runAll<T>(
  runner: WrapRunner,
  list: readonly T[],
  make: (item: T) => WrapJob,
  done: (item: T, result: WrapJobResult) => void,
  onStep?: (done: number, of: number) => void,
  weight?: (item: T) => number,
): Promise<void> {
  let items = list
  if (weight && runner.size > 1) {
    const w = list.map(weight)
    items = list.map((_, i) => i).sort((a, b) => w[b] - w[a] || a - b).map((i) => list[i])
  }
  const ahead = runner.size * 2
  let next = 0
  let finished = 0
  let error: unknown = null
  await new Promise<void>((resolve, reject) => {
    const launch = () => {
      while (next < items.length && next - finished < ahead && error === null) {
        const item = items[next++]
        let job: WrapJob
        try {
          job = make(item)
        } catch (e) {
          error = e
          reject(e)
          return
        }
        runner.run(job).then(
          (result) => {
            if (error !== null) return
            try {
              done(item, result)
            } catch (e) {
              error = e
              reject(e)
              return
            }
            finished++
            onStep?.(finished, items.length)
            if (finished === items.length) resolve()
            else launch()
          },
          (e) => {
            if (error !== null) return
            error = e
            reject(e)
          },
        )
      }
    }
    if (items.length === 0) resolve()
    else launch()
  })
}

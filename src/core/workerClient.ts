// SPDX-License-Identifier: AGPL-3.0-only
import type { AlignResult, PointPair } from './deviation/align'
import type { Rigid } from './deviation/rigid'
import type { StepInfo } from './parsers/step'
import type { ElementKind, FitOutput, FitSettings } from './types'
import type { WorkerRequest, WorkerResponse } from './workerProtocol'

export interface LoadedMesh {
  positions: Float32Array
  indices: Uint32Array
  normals: Float32Array
  vertexCount: number
  triangleCount: number
}

export interface LoadedNominal extends LoadedMesh {
  bboxDiagonal: number
  /** How a STEP reference was converted; absent when the file was a mesh. */
  step?: StepInfo
}

export interface DeviationResult {
  values: Float32Array
  suggestedRange: number
  suggestedMaxDistance: number
}

export interface ThicknessResult {
  values: Float32Array
  suggestedLow: number
  suggestedHigh: number
}

/** Everything about a thickness measurement that the worker needs and the
 *  panel sets — the request minus its bookkeeping. */
export type ThicknessRequest = Omit<
  Extract<WorkerRequest, { type: 'thickness' }>,
  'type' | 'requestId'
>

/** Typed promise wrapper around the mesh worker. Requests are matched by id;
 *  the worker itself processes them sequentially. */
export class MeshWorkerClient {
  private worker: Worker
  private nextId = 1
  private pending = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>()
  onProgress: ((text: string) => void) | null = null
  /** Poses from part-way through an alignment. Not a request result — they
   *  arrive while the request is still open, so they must not settle it. */
  onAlignProgress: ((transform: Rigid, iteration: number, meanDistance: number) => void) | null =
    null

  constructor() {
    this.worker = new Worker(new URL('./meshWorker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data
      if (msg.type === 'progress') {
        this.onProgress?.(msg.text)
        return
      }
      if (msg.type === 'align-progress') {
        this.onAlignProgress?.(msg.transform, msg.iteration, msg.meanDistance)
        return
      }
      const entry = this.pending.get(msg.requestId)
      if (!entry) return
      this.pending.delete(msg.requestId)
      if (msg.type === 'error') entry.reject(new Error(msg.message))
      else (entry.resolve as (v: unknown) => void)(msg)
    }
  }

  private request<T>(msg: WorkerRequest, transfer: Transferable[] = []): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.set(msg.requestId, { resolve: resolve as (v: never) => void, reject })
      this.worker.postMessage(msg, transfer)
    })
  }

  async load(name: string, buffer: ArrayBuffer): Promise<LoadedMesh> {
    const requestId = this.nextId++
    return this.request<LoadedMesh>({ type: 'load', requestId, name, buffer }, [buffer])
  }

  async fit(elementType: ElementKind, seeds: number[], settings: FitSettings): Promise<FitOutput> {
    const requestId = this.nextId++
    const res = await this.request<Extract<WorkerResponse, { type: 'fit-ok' }>>({
      type: 'fit',
      requestId,
      elementType,
      seeds,
      settings,
    })
    return res.result
  }

  /** Fit to the surface the user painted. The vertex list is copied rather
   *  than transferred: the caller keeps it as the element's rebuild recipe. */
  async fitSelection(
    elementType: ElementKind,
    vertices: Uint32Array,
    settings: FitSettings,
  ): Promise<FitOutput> {
    const requestId = this.nextId++
    const res = await this.request<Extract<WorkerResponse, { type: 'fit-ok' }>>({
      type: 'fit-selection',
      requestId,
      elementType,
      vertices,
      settings,
    })
    return res.result
  }

  async loadNominal(name: string, buffer: ArrayBuffer): Promise<LoadedNominal> {
    const requestId = this.nextId++
    return this.request<LoadedNominal>({ type: 'load-nominal', requestId, name, buffer }, [buffer])
  }

  async align(pairs: PointPair[] | null): Promise<AlignResult> {
    const requestId = this.nextId++
    const msg: WorkerRequest = pairs
      ? { type: 'align', requestId, mode: 'points', pairs }
      : { type: 'align', requestId, mode: 'auto' }
    const res = await this.request<Extract<WorkerResponse, { type: 'align-ok' }>>(msg)
    return res.result
  }

  /** Fine-tune the alignment on the marked surface only. The vertex list is
   *  copied rather than transferred: the marking stays on the part, ready for
   *  another pass. */
  async alignLocal(
    vertices: Uint32Array,
    start: Rigid,
    maxDistance: number,
  ): Promise<AlignResult> {
    const requestId = this.nextId++
    const res = await this.request<Extract<WorkerResponse, { type: 'align-ok' }>>({
      type: 'align',
      requestId,
      mode: 'local',
      vertices,
      start,
      maxDistance,
    })
    return res.result
  }

  async deviate(transform: Rigid): Promise<DeviationResult> {
    const requestId = this.nextId++
    return this.request<DeviationResult>({ type: 'deviate', requestId, transform })
  }

  /** Wall thickness at every scan vertex. Every setting here shapes the search
   *  itself, so changing any of them means asking again. */
  async thickness(settings: ThicknessRequest): Promise<ThicknessResult> {
    const requestId = this.nextId++
    return this.request<ThicknessResult>({ type: 'thickness', requestId, ...settings })
  }

  /** Bake a datum alignment into the worker's copy of the scan. */
  async transform(transform: Rigid): Promise<void> {
    const requestId = this.nextId++
    await this.request({ type: 'transform', requestId, transform })
  }
}

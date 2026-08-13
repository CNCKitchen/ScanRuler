import type { FitSettings } from './types'
import type { WorkerRequest, WorkerResponse } from './workerProtocol'

export interface LoadedMesh {
  positions: Float32Array
  indices: Uint32Array
  normals: Float32Array
  vertexCount: number
  triangleCount: number
}

export interface FitResult {
  center: [number, number, number]
  radius: number
  sigma: number
  usedPoints: number
  regionSize: number
  region: Uint32Array
}

/** Typed promise wrapper around the mesh worker. Requests are matched by id;
 *  the worker itself processes them sequentially. */
export class MeshWorkerClient {
  private worker: Worker
  private nextId = 1
  private pending = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>()
  onProgress: ((text: string) => void) | null = null

  constructor() {
    this.worker = new Worker(new URL('./meshWorker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data
      if (msg.type === 'progress') {
        this.onProgress?.(msg.text)
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

  async fit(elementType: string, seeds: number[], settings: FitSettings): Promise<FitResult> {
    const requestId = this.nextId++
    return this.request<FitResult>({ type: 'fit', requestId, elementType, seeds, settings })
  }
}

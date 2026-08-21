// SPDX-License-Identifier: AGPL-3.0-only
import type { ArchiveMember, UnpackedProject } from './archive'
import type { ProjectManifest } from './manifest'
import type { ProjectWorkerRequest, ProjectWorkerResponse } from './projectWorker'

/** Main-thread handle on the project worker: one request in flight at a time
 *  is all the UI ever asks for, but the ids keep it honest regardless. */
export class ProjectClient {
  private worker: Worker
  private nextId = 1
  private pending = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>()

  constructor() {
    this.worker = new Worker(new URL('./projectWorker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent<ProjectWorkerResponse>) => {
      const msg = e.data
      const p = this.pending.get(msg.requestId)
      if (!p) return
      this.pending.delete(msg.requestId)
      if (msg.type === 'error') p.reject(new Error(msg.message))
      else p.resolve(msg as never)
    }
  }

  private request<T>(msg: ProjectWorkerRequest, transfer: Transferable[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.set(msg.requestId, { resolve: resolve as (v: never) => void, reject })
      this.worker.postMessage(msg, transfer)
    })
  }

  /** Members are copied in, not transferred: the session keeps its bytes. */
  async pack(manifest: ProjectManifest, members: ArchiveMember[]): Promise<Uint8Array> {
    const requestId = this.nextId++
    const res = await this.request<Extract<ProjectWorkerResponse, { type: 'pack-ok' }>>(
      { type: 'pack', requestId, manifest, members },
      [],
    )
    return res.bytes
  }

  async unpack(bytes: Uint8Array): Promise<UnpackedProject> {
    const requestId = this.nextId++
    const res = await this.request<Extract<ProjectWorkerResponse, { type: 'unpack-ok' }>>(
      { type: 'unpack', requestId, bytes },
      [bytes.buffer],
    )
    return { manifest: res.manifest, members: new Map(res.members) }
  }
}

// SPDX-License-Identifier: AGPL-3.0-only
import { WorkerRpc } from '../workerRpc'
import type { ArchiveMember, UnpackedProject } from './archive'
import type { ProjectManifest } from './manifest'
import type { ProjectWorkerRequest, ProjectWorkerResponse } from './projectWorker'

/** Main-thread handle on the project worker: one request in flight at a time
 *  is all the UI ever asks for, but the ids keep it honest regardless. */
export class ProjectClient {
  private rpc = new WorkerRpc(() => new Worker(new URL('./projectWorker.ts', import.meta.url), { type: 'module' }), 'Project worker')
  private nextId = 1
  get dead(): boolean { return this.rpc.dead }

  private request<T>(msg: ProjectWorkerRequest, transfer: Transferable[]): Promise<T> {
    if (this.rpc.dead) this.rpc.restart()
    return this.rpc.request<T>(msg, transfer)
  }

  dispose(): void { this.rpc.dispose() }

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

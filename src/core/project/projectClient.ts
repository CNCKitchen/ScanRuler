// SPDX-License-Identifier: AGPL-3.0-only
// The main thread's side of the project worker (projectWorker.ts): packing
// a project into its zip and reading one back happen off the main thread,
// so the viewport keeps answering while a large scan is deflated. The
// worker holds nothing between requests, so one that has died is simply
// started again on the next.

import { WorkerRpc } from '../workerRpc'
import { readMembers, type ArchiveMember, type UnpackedProject } from './archive'
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

  /** Members held as bytes are copied in, not transferred: the session keeps
   *  them. Members held as files are read here, and that copy goes over. */
  async pack(manifest: ProjectManifest, members: ArchiveMember[]): Promise<Uint8Array> {
    const requestId = this.nextId++
    const files = await readMembers(members)
    const read = files.filter((f, i) => f.bytes !== members[i].bytes).map((f) => f.bytes.buffer)
    const res = await this.request<Extract<ProjectWorkerResponse, { type: 'pack-ok' }>>(
      { type: 'pack', requestId, manifest, members: files },
      read,
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

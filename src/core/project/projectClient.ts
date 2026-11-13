// SPDX-License-Identifier: AGPL-3.0-only
// The main thread's side of the project worker (projectWorker.ts): packing
// a project into its zip and reading one back happen off the main thread,
// so the viewport keeps answering while a large scan is deflated. The
// worker holds nothing between requests, so one that has died is simply
// started again on the next.

import { WorkerRpc } from '../workerRpc'
import type { ArchiveMember, UnpackedProject } from './archive'
import type { ProjectManifest } from './manifest'
import type { ProjectWorkerRequest, ProjectWorkerResponse } from './projectWorker'
import { MemoryFile } from '../sourceFile'

/**
 * A project packed in this page, as the parts it was built of — what a
 * recovered checkpoint is opened from. Like a MemoryFile it is an empty file
 * to the browser: its bytes are never joined into one buffer, which a
 * project past 2 GiB would not fit, nor put in blob storage, which cannot
 * read a large Blob the page made back.
 */
export class PackedFile extends File {
  readonly #size: number

  constructor(readonly parts: Uint8Array[], name: string) {
    super([], name)
    this.#size = parts.reduce((sum, part) => sum + part.byteLength, 0)
  }

  override get size(): number {
    return this.#size
  }
}

/** A PackedFile's parts, to be transferred to the worker that opens it. They
 *  go over as they are rather than copied — a project may be gigabytes — so
 *  a PackedFile opens once: nothing opens one twice (a recovery that fails
 *  is retried from its checkpoint, packed anew), and one that were would
 *  say so here rather than fail the post. */
export function packedParts(file: PackedFile): Uint8Array[] {
  if (file.parts.some((p) => (p.buffer as ArrayBuffer & { detached?: boolean }).detached === true)) {
    throw new Error(`${file.name} was opened already; it cannot be opened again.`)
  }
  return file.parts
}

/** Members as they can go to the worker. A MemoryFile goes as its bytes: to
 *  a worker it would be the empty file the browser holds. */
export function postableMembers(members: readonly ArchiveMember[]): ArchiveMember[] {
  return members.map(({ name, bytes }) => ({ name, bytes: bytes instanceof MemoryFile ? bytes.data : bytes }))
}

/** The archive passed the most it was asked to be: `size` is how much of it
 *  was written when that was seen. */
export class ProjectTooLargeError extends Error {
  constructor(readonly size: number) {
    super(`The project is past ${size} bytes.`)
  }
}

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

  /** The archive as the parts it is made of: a Blob of them is the file.
   *  Nothing is transferred: members held as bytes are copied in (the
   *  session keeps them), members held as files go over as the files and
   *  are read there, one at a time. Past `maxBytes` of archive the packing
   *  is given up, as soon as it is past: ProjectTooLargeError. */
  async pack(manifest: ProjectManifest, members: ArchiveMember[], maxBytes?: number): Promise<Uint8Array[]> {
    const requestId = this.nextId++
    const res = await this.request<Extract<ProjectWorkerResponse, { type: 'pack-ok' | 'pack-too-large' }>>(
      { type: 'pack', requestId, manifest, members: postableMembers(members), maxBytes },
      [],
    )
    if (res.type === 'pack-too-large') throw new ProjectTooLargeError(res.size)
    return res.parts
  }

  /** A project file read back. A file on disk goes over as itself and is
   *  read there a member at a time; bytes the page holds go over as a copy,
   *  or — a PackedFile's, made only to be opened — as they are. */
  async unpack(file: File): Promise<UnpackedProject> {
    const requestId = this.nextId++
    let msg: ProjectWorkerRequest
    let transfer: Transferable[] = []
    if (file instanceof PackedFile) {
      msg = { type: 'unpack', requestId, parts: packedParts(file) }
      transfer = [...new Set(file.parts.map((p) => p.buffer as ArrayBuffer))]
    } else if (file instanceof MemoryFile) {
      msg = { type: 'unpack', requestId, parts: [file.data] }
    } else {
      msg = { type: 'unpack', requestId, file, name: file.name }
    }
    const res = await this.request<Extract<ProjectWorkerResponse, { type: 'unpack-ok' }>>(msg, transfer)
    return { manifest: res.manifest, members: new Map(res.members) }
  }
}

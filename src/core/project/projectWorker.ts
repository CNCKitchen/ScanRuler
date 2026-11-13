// SPDX-License-Identifier: AGPL-3.0-only
// Deflating a hundred-megabyte scan takes seconds; it happens off the main
// thread so the viewport keeps answering while a project is written or read.
// A project file is read here from the file itself, a member at a time, so
// one past what a browser reads in one piece opens too.

import { packProjectParts, unpackProject, type ArchiveFile } from './archive'
import type { ProjectManifest } from './manifest'
import { blobSource, partsSource } from '../parsers/byteSource'
import { reply } from '../workerRpc'

export type ProjectWorkerRequest =
  | { type: 'pack'; requestId: number; manifest: ProjectManifest; members: ArchiveFile[] }
  /** The project as a file on disk, or as bytes the page holds. */
  | { type: 'unpack'; requestId: number; file: Blob; name: string }
  | { type: 'unpack'; requestId: number; parts: Uint8Array[] }

export type ProjectWorkerResponse =
  | { type: 'pack-ok'; requestId: number; parts: Uint8Array[] }
  | { type: 'unpack-ok'; requestId: number; manifest: ProjectManifest; members: [string, Uint8Array][] }
  | { type: 'error'; requestId: number; message: string }

const post = (msg: ProjectWorkerResponse, transfer: Transferable[] = []) => reply(msg, transfer)

/** Each buffer once: several parts may be views of one, and a buffer named
 *  twice in a transfer list fails the post. */
const buffersOf = (views: readonly Uint8Array[]): Transferable[] => [...new Set(views.map((v) => v.buffer as ArrayBuffer))]

self.onmessage = (e: MessageEvent<ProjectWorkerRequest>) => {
  const msg = e.data
  try {
    if (msg.type === 'pack') {
      const parts = packProjectParts(msg.manifest, msg.members)
      post({ type: 'pack-ok', requestId: msg.requestId, parts }, buffersOf(parts))
    } else {
      const source = 'file' in msg ? blobSource(msg.file, msg.name) : partsSource(msg.parts)
      const { manifest, members } = unpackProject(source)
      const list = [...members.entries()]
      post(
        { type: 'unpack-ok', requestId: msg.requestId, manifest, members: list },
        buffersOf(list.map(([, b]) => b)),
      )
    }
  } catch (err) {
    post({ type: 'error', requestId: msg.requestId, message: err instanceof Error ? err.message : String(err) })
  }
}

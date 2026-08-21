// SPDX-License-Identifier: AGPL-3.0-only
// Deflating a hundred-megabyte scan takes seconds; it happens off the main
// thread so the viewport keeps answering while a project is written or read.

import { packProject, unpackProject, type ArchiveMember } from './archive'
import type { ProjectManifest } from './manifest'

export type ProjectWorkerRequest =
  | { type: 'pack'; requestId: number; manifest: ProjectManifest; members: ArchiveMember[] }
  | { type: 'unpack'; requestId: number; bytes: Uint8Array }

export type ProjectWorkerResponse =
  | { type: 'pack-ok'; requestId: number; bytes: Uint8Array }
  | { type: 'unpack-ok'; requestId: number; manifest: ProjectManifest; members: [string, Uint8Array][] }
  | { type: 'error'; requestId: number; message: string }

const post = (msg: ProjectWorkerResponse, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(msg, transfer)

self.onmessage = (e: MessageEvent<ProjectWorkerRequest>) => {
  const msg = e.data
  try {
    if (msg.type === 'pack') {
      const bytes = packProject(msg.manifest, msg.members)
      post({ type: 'pack-ok', requestId: msg.requestId, bytes }, [bytes.buffer])
    } else {
      const { manifest, members } = unpackProject(msg.bytes)
      const list = [...members.entries()]
      post(
        { type: 'unpack-ok', requestId: msg.requestId, manifest, members: list },
        list.map(([, b]) => b.buffer),
      )
    }
  } catch (err) {
    post({ type: 'error', requestId: msg.requestId, message: err instanceof Error ? err.message : String(err) })
  }
}

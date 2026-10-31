// SPDX-License-Identifier: AGPL-3.0-only
import { WorkerRpc } from '../core/workerRpc'
import { has3MFTextures } from '../core/parsers/threemfTextures'

/** Preserve the caller's archive for parsing and saving. Copy it to a
 *  short-lived worker; transfer expanded images back without another copy.
 *  Worker failures reject the import rather than silently dropping colour. */
export async function textureArchive(bytes: Uint8Array): Promise<Record<string, Uint8Array> | null> {
  if (!has3MFTextures(bytes)) return null
  const rpc = new WorkerRpc(() => new Worker(new URL('../core/parsers/textureWorker.ts', import.meta.url), { type: 'module' }), '3MF texture worker')
  try {
    const message = { type: 'textures', requestId: 1, bytes }
    const result = await rpc.request<{ files: Record<string, Uint8Array> | null }>(message)
    return result.files
  } finally { rpc.dispose() }
}

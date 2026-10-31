// SPDX-License-Identifier: AGPL-3.0-only
import { unpack3MFTextures } from './threemfTextures'
import { reply } from '../workerRpc'

self.onmessage = ({ data }: MessageEvent<{ requestId: number; bytes: Uint8Array }>) => {
  try {
    const files = unpack3MFTextures(data.bytes)
    reply({ requestId: data.requestId, files }, files ? Object.values(files).map((bytes) => bytes.buffer) : [])
  } catch (error) {
    reply({ type: 'error', requestId: data.requestId, message: error instanceof Error ? error.message : String(error) })
  }
}

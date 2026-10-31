// SPDX-License-Identifier: AGPL-3.0-only
import { unzipSync } from 'fflate'
import { inspect3MFArchive, is3MFTexture, ThreeMFArchiveSizeError } from './threemfArchive'

/** Inspect without expanding entries. Plain models need no texture worker;
 *  size-limit failures still reject the import before any mesh is prepared. */
export function has3MFTextures(bytes: Uint8Array): boolean {
  try { return inspect3MFArchive(bytes).hasTextures }
  catch (error) {
    if (error instanceof ThreeMFArchiveSizeError) throw error
    return false // the mesh parser reports an invalid package
  }
}

/** Run in a worker: even fflate's async unzip inflates barely compressed
 *  entries synchronously, which includes many already-compressed images. */
export function unpack3MFTextures(bytes: Uint8Array): Record<string, Uint8Array> | null {
  try {
    inspect3MFArchive(bytes)
    return unzipSync(bytes, { filter: ({ name }) => is3MFTexture(name) })
  } catch (error) {
    if (error instanceof ThreeMFArchiveSizeError) throw error
    return null // the mesh parser reports the damaged package
  }
}

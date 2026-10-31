// SPDX-License-Identifier: AGPL-3.0-only
import { unzipSync } from 'fflate'
import { EXPANDED_ARCHIVE_BYTES } from '../archiveLimits'

export const is3MFModelData = (name: string) => /\.(model|rels|config)$/i.test(name)
export const is3MFTexture = (name: string) => /\.(png|jpe?g)$/i.test(name) && !/^\/?metadata\//i.test(name)

export class ThreeMFArchiveSizeError extends Error {
  constructor() {
    super('The 3MF’s expanded model and texture data exceed the supported archive size limit. Reduce or split the model and try again.')
  }
}

/** Inspect the complete directory before fflate allocates any expanded
 *  entries. Model and texture readers share one budget, including nested
 *  project imports. Ignored thumbnails and slicer sidecars consume none:
 *  they are never expanded. No per-entry or member-count cap is introduced. */
export function inspect3MFArchive(bytes: Uint8Array, maxExpandedBytes = EXPANDED_ARCHIVE_BYTES): { hasTextures: boolean; expandedBytes: number } {
  let hasTextures = false
  let expandedBytes = 0
  unzipSync(bytes, { filter: ({ name, originalSize, size, compression }) => {
    const texture = is3MFTexture(name)
    if (texture || is3MFModelData(name)) {
      // Stored entries are copied by their stored size; deflated entries
      // allocate originalSize. A malformed header must not undercount either.
      const allocation = compression === 0 ? Math.max(size, originalSize) : originalSize
      if (!Number.isSafeInteger(allocation) || allocation < 0 || allocation > maxExpandedBytes - expandedBytes) {
        throw new ThreeMFArchiveSizeError()
      }
      expandedBytes += allocation
      hasTextures ||= texture
    }
    return false
  } })
  return { hasTextures, expandedBytes }
}

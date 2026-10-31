// SPDX-License-Identifier: AGPL-3.0-only
import type { UnzipFileFilter } from 'fflate'

export interface ArchiveLimits {
  members: number
  entryBytes: number
  totalBytes: number
}

export const THREE_MF_LIMITS: ArchiveLimits = {
  members: 512,
  entryBytes: 256 * 1024 * 1024,
  totalBytes: 512 * 1024 * 1024,
}

export class ArchiveLimitError extends Error {
  constructor() {
    super('The 3MF exceeds the supported archive size limits.')
  }
}

/** Count every member and its expanded size before fflate allocates it. */
export function limitedArchiveFilter(accept: UnzipFileFilter, limits: ArchiveLimits = THREE_MF_LIMITS): UnzipFileFilter {
  let members = 0
  let totalBytes = 0
  return (file) => {
    members++
    totalBytes += file.originalSize
    if (members > limits.members || file.originalSize > limits.entryBytes || totalBytes > limits.totalBytes) {
      throw new ArchiveLimitError()
    }
    return accept(file)
  }
}

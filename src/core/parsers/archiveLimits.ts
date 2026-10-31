// SPDX-License-Identifier: AGPL-3.0-only
// How much a 3MF may unpack to. A zip says how large each member is once
// expanded, but only says so: a member stored without compression comes out
// as large as its stored bytes whatever size it declares, and several
// members may point at the same bytes. So each member is counted at the
// larger of its two sizes, and only the members actually read count towards
// the total — a slicer project's thumbnails and settings are not unpacked.

import type { UnzipFileFilter } from 'fflate'

export interface ArchiveLimits {
  members: number
  entryBytes: number
  totalBytes: number
}

/** A model file is read into one string, and a string stops short of 512 MB
 *  anyway; a scan of several million triangles is a few hundred MB of XML. */
export const THREE_MF_LIMITS: ArchiveLimits = {
  members: 4096,
  entryBytes: 512 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024,
}

export class ArchiveLimitError extends Error {
  constructor() {
    super('The 3MF exceeds the supported archive size limits.')
  }
}

/** `accept`, with every member counted before fflate allocates for it. */
export function limitedArchiveFilter(accept: UnzipFileFilter, limits: ArchiveLimits = THREE_MF_LIMITS): UnzipFileFilter {
  let members = 0
  let totalBytes = 0
  return (file) => {
    if (++members > limits.members) throw new ArchiveLimitError()
    if (!accept(file)) return false
    const bytes = Math.max(file.size, file.originalSize)
    totalBytes += bytes
    if (bytes > limits.entryBytes || totalBytes > limits.totalBytes) throw new ArchiveLimitError()
    return true
  }
}

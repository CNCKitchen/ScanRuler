// SPDX-License-Identifier: AGPL-3.0-only
// A zip says in its own header how large each member is. Reading a 3MF or the
// textures packed in one with no ceiling lets a few kilobytes of file ask for
// gigabytes (a zip bomb), so the sizes the headers declare are summed and the
// archive is refused past one. A header can understate the size; this bounds
// what an honest archive claims, not a forged one.

import type { UnzipFileFilter } from 'fflate'

export const MAX_UNZIPPED_BYTES = 1024 * 1024 * 1024

export class ZipTooLargeError extends Error {}

/** An fflate filter that takes the members `accept` names, and throws once they would unpack to more than `limit`. */
export function limitedFilter(accept: (name: string) => boolean, limit = MAX_UNZIPPED_BYTES): UnzipFileFilter {
  let total = 0
  return ({ name, originalSize }) => {
    if (!accept(name)) return false
    total += originalSize
    if (total > limit) throw new ZipTooLargeError('This file unpacks to more than the supported size.')
    return true
  }
}

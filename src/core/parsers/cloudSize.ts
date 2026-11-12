// SPDX-License-Identifier: AGPL-3.0-only
// How many points a cloud file holds, told from its first bytes before it is
// read, so a cloud too large for the tab can be offered thinned first. A PLY
// counts its points in its header; a text cloud does not, and its count is
// estimated from the length of its first rows.

import { extensionOf } from '../formats'
import { PLY_HEADER_LIMIT, plyCloudPoints, readPlyHeader } from './ply'
import { numbersOf } from './xyz'

/** How many of a file's first bytes the count is told from. */
export const CLOUD_HEAD_BYTES = PLY_HEADER_LIMIT

export interface CloudSize {
  points: number
  /** Counted (a PLY's header, a whole small text file), not estimated. */
  exact: boolean
}

/** The points of a cloud file of `size` bytes from its first bytes, or null
 *  when it is not a point cloud or cannot be told. */
export function cloudSizeOf(name: string, head: Uint8Array, size: number): CloudSize | null {
  const ext = extensionOf(name)
  if (ext === 'ply') {
    try {
      const points = plyCloudPoints(readPlyHeader(head))
      return points === null ? null : { points, exact: true }
    } catch {
      return null // the worker says what is wrong with the file
    }
  }
  if (ext !== 'xyz' && ext !== 'asc' && ext !== 'pts') return null
  const whole = head.length >= size
  // Only whole lines: the last one may be cut short.
  const end = whole ? head.length : head.lastIndexOf(0x0a) + 1
  if (end <= 0) return null
  const lines = new TextDecoder().decode(head.subarray(0, end)).split('\n')
  let rows = 0
  let rowBytes = 0
  for (const line of lines) {
    if (!numbersOf(line)) continue
    rows++
    rowBytes += line.length + 1
  }
  if (rows === 0) return null
  if (whole) return { points: rows, exact: true }
  // Rows are ASCII, a character a byte: the rest of the file is rows of the
  // same length as these.
  return { points: rows + Math.round((size - end) / (rowBytes / rows)), exact: false }
}

/** The points of a cloud file, from its first bytes; null for anything else. */
export async function cloudSizeOfFile(file: Blob & { name: string }): Promise<CloudSize | null> {
  const ext = extensionOf(file.name)
  if (ext !== 'ply' && ext !== 'xyz' && ext !== 'asc' && ext !== 'pts') return null
  try {
    const head = new Uint8Array(await file.slice(0, CLOUD_HEAD_BYTES).arrayBuffer())
    return cloudSizeOf(file.name, head, file.size)
  } catch {
    return null // the read that follows says why the file cannot be read
  }
}

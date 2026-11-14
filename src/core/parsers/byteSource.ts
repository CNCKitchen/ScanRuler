// SPDX-License-Identifier: AGPL-3.0-only
// A file's bytes read a piece at a time. A browser hands a file over in one
// ArrayBuffer of at most 2 GiB, and a cloud held whole in one sits in memory
// beside everything parsed out of it; read in pieces, a cloud past 2 GiB
// opens, and the tab holds only the points. In the worker a File is read
// with FileReaderSync, so the parsers stay synchronous.

/** Bytes that can be read by range. */
export interface ByteSource {
  readonly size: number
  /** The bytes from `start` up to `end`, which may lie past the size. The
   *  view may be the source's own memory: read it, do not keep it. */
  read(start: number, end: number): Uint8Array
}

/** How much of a file is read at once, in bytes. */
export const READ_CHUNK = 32 * 1024 * 1024

/** Bytes in memory as a source; a read is a view, not a copy. */
export function bytesSource(data: Uint8Array | ArrayBuffer): ByteSource {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  return {
    size: bytes.byteLength,
    read: (start, end) => bytes.subarray(start, Math.min(end, bytes.byteLength)),
  }
}

/** Bytes in memory held as consecutive parts, never joined: a read inside one
 *  part is a view of it, one across parts a copy. */
export function partsSource(parts: readonly Uint8Array[]): ByteSource {
  if (parts.length === 1) return bytesSource(parts[0])
  const starts: number[] = []
  let size = 0
  for (const part of parts) {
    starts.push(size)
    size += part.byteLength
  }
  // The last part beginning at or before `at`.
  const partAt = (at: number) => {
    let lo = 0, hi = parts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= at) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  return {
    size,
    read(start, end) {
      end = Math.min(end, size)
      if (start >= end) return new Uint8Array(0)
      let i = partAt(start)
      if (end <= starts[i] + parts[i].byteLength) return parts[i].subarray(start - starts[i], end - starts[i])
      const out = new Uint8Array(end - start)
      for (let at = start; at < end; i++) {
        const piece = parts[i].subarray(at - starts[i], Math.min(parts[i].byteLength, end - starts[i]))
        out.set(piece, at - start)
        at += piece.byteLength
      }
      return out
    },
  }
}

export const isByteSource =(v: unknown): v is ByteSource =>
  typeof v === 'object' && v !== null && !(v instanceof ArrayBuffer) && typeof (v as ByteSource).read === 'function'

/** Either form a parser is handed, as a source. */
export const sourceOf = (input: ArrayBuffer | ByteSource): ByteSource => (isByteSource(input) ? input : bytesSource(input))

interface ReaderSync {
  readAsArrayBuffer(blob: Blob): ArrayBuffer
}

/** A file read from disk a range at a time — in a worker only, where
 *  FileReaderSync is. */
export function blobSource(blob: Blob, name = 'The file'): ByteSource {
  const Reader = (globalThis as { FileReaderSync?: new () => ReaderSync }).FileReaderSync
  if (!Reader) throw new Error('A file is read in pieces only in a worker.')
  const reader = new Reader()
  return {
    size: blob.size,
    read(start, end) {
      try {
        return new Uint8Array(reader.readAsArrayBuffer(blob.slice(start, Math.min(end, blob.size))))
      } catch {
        throw new Error(`${name} could not be read: the browser could not read it from disk — it may have been moved, changed or deleted, or be locked by another program.`)
      }
    },
  }
}

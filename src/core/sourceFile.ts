// SPDX-License-Identifier: AGPL-3.0-only
// A scan or reference is read again whenever its bytes are needed — for the
// worker after a restart, a project file or a checkpoint. Up to
// KEEP_COPY_BYTES the session keeps a copy of them for that, which nothing
// on disk can take away — held in the page, not as a Blob (see MemoryFile).
// A larger file is kept as the file it was opened
// from, not as a copy: the browser reads it from disk again, so a large scan
// is not held in the tab's memory for the whole session. A file changed,
// moved or deleted on disk since — photogrammetry tools re-export in place —
// cannot be read that way any more, and says so in words the person can act
// on. A large point cloud is not read here at all: the worker reads it from
// the file a piece at a time (readInPieces).

import { extensionOf } from './formats'

/** Up to this size a scan or reference is kept as a copy of its bytes; past
 *  it, only the file it was opened from is kept. */
export const KEEP_COPY_BYTES = 256 * 1024 * 1024

/** What the session keeps of a file it opened, read into `buffer` (before
 *  that goes to the worker): a copy of the bytes when the file is small
 *  enough, else the file itself — and a MemoryFile as it is. The copy is a
 *  MemoryFile too: as a Blob it would go to the browser's blob storage,
 *  which turns reads away past a few hundred megabytes a page. */
export function keptSource(file: File, buffer: ArrayBuffer, limit = KEEP_COPY_BYTES): Blob {
  if (file instanceof MemoryFile) return file
  return file.size <= limit ? new MemoryFile(new Uint8Array(buffer.slice(0)), file.name) : file
}

/** Whether a scan goes to the worker as the file itself, read there a piece
 *  at a time (parsers/byteSource): a point cloud on disk too large to keep a
 *  copy of — which may be past the 2 GiB a browser reads in one piece. One
 *  in memory already is read from there. */
export function readInPieces(file: Blob, name: string): boolean {
  const ext = extensionOf(name)
  return (ext === 'ply' || ext === 'xyz' || ext === 'asc' || ext === 'pts') && !(file instanceof MemoryFile) && file.size > KEEP_COPY_BYTES
}

/** What a source that can no longer be read is reported as. */
export const unreadableSource = (name: string): string =>
  `${name} can no longer be read — the file was changed, moved or deleted after it was opened, and a file this large is read from disk again rather than kept in memory. Open it again.`

/** The file's bytes, read now. */
export async function readSourceFile(file: Blob, name: string): Promise<ArrayBuffer> {
  try {
    return await file.arrayBuffer()
  } catch {
    throw new Error(unreadableSource(name))
  }
}

/** The largest file a browser reads in one piece, bytes: one ArrayBuffer of
 *  it. Chrome turns a larger one away with a NotReadableError that speaks of
 *  "permission problems", which sends the person looking in the wrong place
 *  (a 2.69 GB cloud did), so the size is checked before anything is read. */
export const MAX_READ_BYTES = 2 * 1024 ** 3 - 1

/** A size in bytes as people read it: "2.69 GB", "512 MB". */
export function byteSizeText(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`
}

/** Why a file is too large to open, or null when it is not. */
export function tooLargeToOpen(name: string, size: number, limit = MAX_READ_BYTES): string | null {
  if (size <= limit) return null
  return `${name} is ${byteSizeText(size)} — too large to open: a browser reads a file of at most ${limit === MAX_READ_BYTES ? '2 GiB' : byteSizeText(limit)} (${limit.toLocaleString('en-US')} bytes) in one piece. Decimate or split it in the software that wrote it, and open that.`
}

/** A file being opened, read whole: refused up front, by its size, when the
 *  browser could not read it in one piece, and a read the browser refuses
 *  said in words the person can act on rather than as its own. */
export async function readOpenedFile(file: Blob, name: string): Promise<ArrayBuffer> {
  const big = tooLargeToOpen(name, file.size)
  if (big) throw new Error(big)
  try {
    return await file.arrayBuffer()
  } catch (e) {
    const why = e instanceof Error && e.name === 'NotReadableError'
      ? 'the browser could not read it from disk — it may have been moved, changed or deleted, or be locked by another program'
      : e instanceof Error ? e.message : String(e)
    throw new Error(`${name} could not be read: ${why}.`)
  }
}

/**
 * A file made of bytes the page holds already — what an agent hands over, or
 * a cloud an edit produced. Built as `new File([bytes])`, its bytes would go
 * to Chrome's blob storage, which holds only a few hundred megabytes of what
 * a page makes: past that a new Blob cannot be read back at all (a 673 MB
 * one, 4 times out of 4 in a fresh page; a second 337 MB one after a first),
 * failing with the same NotReadableError about "permission problems". So the
 * bytes stay here and are read from here, and the browser holds an empty
 * file. Whatever is stored or posted elsewhere (a project member, a recovery
 * checkpoint) takes the bytes themselves: `storedBytes`. It holds the bytes
 * it is given, not a copy: they must not be handed over to a worker after —
 * a read (arrayBuffer) is a copy for that reason, as its buffer usually is.
 *
 * To the browser's own machinery — createImageBitmap, URL.createObjectURL,
 * fetch, FormData, IndexedDB — it is an empty file: hand those `nativeBlob`
 * of it, never the file.
 */
export class MemoryFile extends File {
  readonly #bytes: Uint8Array

  constructor(bytes: Uint8Array, name: string) {
    super([], name)
    this.#bytes = bytes
  }

  /** The bytes, not copied. */
  get data(): Uint8Array {
    return this.#bytes
  }

  override get size(): number {
    return this.#bytes.byteLength
  }

  override arrayBuffer(): Promise<ArrayBuffer> {
    return Promise.resolve(this.#bytes.slice().buffer)
  }

  override text(): Promise<string> {
    return Promise.resolve(new TextDecoder().decode(this.#bytes))
  }

  override slice(start?: number, end?: number): Blob {
    return new MemoryFile(this.#bytes.subarray(start, end), this.name)
  }

  override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    const bytes = this.#bytes
    return new ReadableStream({ start(c) { c.enqueue(bytes.slice()); c.close() } })
  }
}

/** The most a MemoryFile hands the browser as a Blob of its bytes: past a
 *  few hundred megabytes blob storage cannot read one back. */
export const NATIVE_BLOB_BYTES = 256 * 1024 * 1024

/** A Blob the browser's own machinery can read: a file on disk as it is, a
 *  MemoryFile's bytes copied into one — refused, by size, when blob storage
 *  would not read it back. */
export function nativeBlob(file: Blob, name: string, type = file.type): Blob {
  if (!(file instanceof MemoryFile)) return file
  if (file.size > NATIVE_BLOB_BYTES) {
    throw new Error(`${name} is ${byteSizeText(file.size)} — too large for the browser to read from memory (at most ${byteSizeText(NATIVE_BLOB_BYTES)}). Open it from a file instead.`)
  }
  return new Blob([file.data as BlobPart], { type })
}

/** What a kept source is stored as: the bytes of a MemoryFile (the browser
 *  would store its empty file), the Blob itself otherwise. */
export const storedBytes = (file: Blob): Blob | Uint8Array => (file instanceof MemoryFile ? file.data : file)

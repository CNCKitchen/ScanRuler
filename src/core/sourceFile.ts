// SPDX-License-Identifier: AGPL-3.0-only
// A scan or reference is read again whenever its bytes are needed — for the
// worker after a restart, a project file or a checkpoint. Up to
// KEEP_COPY_BYTES the session keeps a copy of them for that, which nothing
// on disk can take away. A larger file is kept as the file it was opened
// from, not as a copy: the browser reads it from disk again, so a large scan
// is not held in the tab's memory for the whole session. A file changed,
// moved or deleted on disk since — photogrammetry tools re-export in place —
// cannot be read that way any more, and says so in words the person can act
// on.

/** Up to this size a scan or reference is kept as a copy of its bytes; past
 *  it, only the file it was opened from is kept. */
export const KEEP_COPY_BYTES = 256 * 1024 * 1024

/** What the session keeps of a file it opened, read into `buffer` (before
 *  that goes to the worker): a copy of the bytes when the file is small
 *  enough, else the file itself — and a MemoryFile as it is. */
export function keptSource(file: File, buffer: ArrayBuffer, limit = KEEP_COPY_BYTES): Blob {
  // A MemoryFile's bytes are in memory already: a copy would only add a Blob.
  if (file instanceof MemoryFile) return file
  return file.size <= limit ? new Blob([buffer]) : file
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
  return `${name} is ${byteSizeText(size)} — too large to open: a browser reads a file of at most ${limit === MAX_READ_BYTES ? '2 GiB' : byteSizeText(limit)} (${limit.toLocaleString('en-US')} bytes) in one piece. Thin the cloud or split it in the software that wrote it, and open that.`
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
 * it is given, not a copy: they must not be handed over to a worker after.
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

/** What a kept source is stored as: the bytes of a MemoryFile (the browser
 *  would store its empty file), the Blob itself otherwise. */
export const storedBytes = (file: Blob): Blob | Uint8Array => (file instanceof MemoryFile ? file.data : file)

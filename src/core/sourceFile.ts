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
 *  enough, else the file itself. */
export function keptSource(file: File, buffer: ArrayBuffer, limit = KEEP_COPY_BYTES): Blob {
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

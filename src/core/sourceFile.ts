// SPDX-License-Identifier: AGPL-3.0-only
// A scan or reference is kept as the file it was opened from, not as a copy
// of its bytes: the browser reads it from disk again when the bytes are
// needed — for the worker, a project file or a checkpoint — so a large scan
// is not held in the tab's memory for the whole session. A file changed,
// moved or deleted on disk since cannot be read that way any more, and
// says so in words the person can act on.

/** What a source that can no longer be read is reported as. */
export const unreadableSource = (name: string): string =>
  `${name} can no longer be read — the file was changed, moved or deleted after it was opened. Open the scan again.`

/** The file's bytes, read now. */
export async function readSourceFile(file: Blob, name: string): Promise<ArrayBuffer> {
  try {
    return await file.arrayBuffer()
  } catch {
    throw new Error(unreadableSource(name))
  }
}

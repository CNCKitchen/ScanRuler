// SPDX-License-Identifier: AGPL-3.0-only
/** One queue for every import entry point. Project members are prepared inside
 * their project's job, never enqueued as separate user imports. A failed job
 * must not prevent the next file from opening. */
export class ImportQueue {
  private tail: Promise<void> = Promise.resolve()
  private pending = 0
  private listeners = new Set<() => void>()
  get busy(): boolean { return this.pending > 0 }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private changed() { for (const listener of this.listeners) listener() }

  run<T>(job: () => Promise<T>): Promise<T> {
    this.pending++
    this.changed()
    const result = this.tail.then(job).finally(() => { this.pending--; this.changed() })
    this.tail = result.then(() => {}, () => {})
    return result
  }
}

/** Prepared resources own their buffers until committed, or explicitly
 * disposed after another member of an import fails. commit is synchronous. */
export interface PreparedView {
  commit(): void
  dispose(): void
}

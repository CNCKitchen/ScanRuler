// SPDX-License-Identifier: AGPL-3.0-only
// The local checkpoints, in this browser's IndexedDB — a slot per page, so
// two tabs never overwrite each other. The source files are the bulk of a
// checkpoint, so they are written again only when they have changed, and
// listing the checkpoints never reads them: the list, the manifests and the
// files are kept in object stores of their own. A page holds a Web Lock on
// its slot while it is open, so the checkpoints offered for recovery are only
// those of pages since closed or crashed, not of another tab still working.

import type { ProjectManifest } from '../core/project/manifest'
import type { ArchiveMember } from '../core/project/archive'

export interface CheckpointInfo { id: string; name: string; savedAt: number }
interface Checkpoint extends CheckpointInfo { manifest: ProjectManifest }

const lockName = (id: string) => `scanruler-recovery:${id}`

/** How many checkpoints left by closed pages are kept, and for how long.
 *  Every page writes a slot of its own, each with a copy of its source
 *  files, so without a limit the browser's storage fills session by session. */
export const RECOVERY_KEEP = 10
export const RECOVERY_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

/** The checkpoints to let go of: those past the age limit, and all but the
 *  newest few of the rest. */
export function staleCheckpoints(rows: readonly CheckpointInfo[], now: number, keep = RECOVERY_KEEP, maxAgeMs = RECOVERY_MAX_AGE_MS): string[] {
  const newest = [...rows].sort((a, b) => b.savedAt - a.savedAt)
  return newest.filter((row, i) => i >= keep || now - row.savedAt > maxAgeMs).map((row) => row.id)
}

/** Each page owns a separate slot. A tab can never overwrite another tab's
 *  checkpoint. Metadata reads deliberately do not load the large source files. */
export class RecoveryStorage {
  private db: Promise<IDBDatabase> | null = null
  private members: ArchiveMember[] | null = null
  // getRandomValues also works on an HTTP development server on the LAN.
  constructor(readonly id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')) {}

  private open(): Promise<IDBDatabase> {
    return this.db ??= new Promise((resolve, reject) => {
      const request = indexedDB.open('scanruler-recovery', 1)
      request.onupgradeneeded = () => {
        for (const name of ['checkpoints', 'sources', 'info']) request.result.createObjectStore(name)
      }
      request.onsuccess = () => {
        const db = request.result
        db.onversionchange = () => { db.close(); this.db = null }
        resolve(db)
      }
      request.onerror = () => { this.db = null; reject(request.error) }
      request.onblocked = () => reject(new Error('Local recovery database is blocked by another page.'))
    })
  }

  private async transaction<T>(mode: IDBTransactionMode, run: (tx: IDBTransaction, result: (value: T) => void) => void): Promise<T> {
    const db = await this.open()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['checkpoints', 'sources', 'info'], mode)
      let value: T
      tx.oncomplete = () => resolve(value)
      tx.onabort = () => reject(tx.error ?? new Error('Local recovery transaction aborted.'))
      tx.onerror = () => reject(tx.error ?? new Error('Local recovery storage failed.'))
      try { run(tx, (result) => { value = result }) }
      catch (error) { tx.abort(); reject(error) }
    })
  }

  list(): Promise<CheckpointInfo[]> {
    return this.transaction('readonly', (tx, result) => {
      const request = tx.objectStore('info').getAll()
      request.onsuccess = () => result((request.result as CheckpointInfo[]).sort((a, b) => b.savedAt - a.savedAt))
    })
  }

  /** Marks this slot as an open page's until the returned function is called;
   *  the browser lets go of it by itself when the page closes or crashes.
   *  Without Web Locks (an HTTP page on the LAN) it does nothing. */
  hold(): () => void {
    if (!navigator.locks) return () => {}
    let release = () => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    navigator.locks.request(lockName(this.id), () => held).catch(() => {})
    return release
  }

  /** The checkpoints no open page holds — what closed or crashed pages left
   *  behind. Without Web Locks every one but this page's own is offered. */
  async left(): Promise<CheckpointInfo[]> {
    const [rows, locks] = await Promise.all([this.list(), navigator.locks?.query().catch(() => null)])
    const held = new Set((locks?.held ?? []).map((lock) => lock.name))
    return rows.filter((row) => row.id !== this.id && !held.has(lockName(row.id)))
  }

  read(id: string): Promise<{ manifest: ProjectManifest; members: ArchiveMember[] }> {
    return this.transaction('readonly', (tx, result) => {
      const checkpoint = tx.objectStore('checkpoints').get(id)
      const sources = tx.objectStore('sources').get(id)
      sources.onsuccess = () => {
        if (!checkpoint.result || !sources.result) { tx.abort(); return }
        result({ manifest: (checkpoint.result as Checkpoint).manifest, members: sources.result as ArchiveMember[] })
      }
    })
  }

  async write(manifest: ProjectManifest, members: ArchiveMember[]): Promise<void> {
    const changed = !this.members || members.length !== this.members.length ||
      members.some((member, i) => member.name !== this.members![i].name || member.bytes !== this.members![i].bytes)
    const info: CheckpointInfo = { id: this.id, name: manifest.name ?? manifest.scan?.fileName ?? manifest.flat.image?.fileName ?? 'CAD project', savedAt: Date.now() }
    await this.transaction<void>('readwrite', (tx) => {
      tx.objectStore('info').put(info, this.id)
      tx.objectStore('checkpoints').put({ ...info, manifest }, this.id)
      if (changed) tx.objectStore('sources').put(members, this.id)
      else {
        // Another tab may have explicitly discarded this slot since this tab last wrote it.
        const exists = tx.objectStore('sources').getKey(this.id)
        exists.onsuccess = () => { if (exists.result === undefined) tx.objectStore('sources').put(members, this.id) }
      }
    })
    // Only reuse sources once the entire transaction has committed.
    this.members = members
  }

  async remove(id: string): Promise<void> {
    await this.transaction<void>('readwrite', (tx) => {
      for (const name of ['checkpoints', 'sources', 'info']) tx.objectStore(name).delete(id)
    })
    if (id === this.id) this.members = null
  }

  close(): void {
    void this.db?.then((db) => db.close(), () => {})
    this.db = null
  }
}

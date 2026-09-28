// SPDX-License-Identifier: AGPL-3.0-only
import type { ProjectManifest } from '../core/project/manifest'
import type { ArchiveMember } from '../core/project/archive'

export interface CheckpointInfo { id: string; name: string; savedAt: number }
interface Checkpoint extends CheckpointInfo { manifest: ProjectManifest }

/** Each page owns a separate slot. A tab can never overwrite another tab's
 * checkpoint. Metadata reads deliberately do not load the large source files. */
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
    const info: CheckpointInfo = { id: this.id, name: manifest.scan?.fileName ?? manifest.flat.image?.fileName ?? 'CAD project', savedAt: Date.now() }
    await this.transaction<void>('readwrite', (tx) => {
      tx.objectStore('info').put(info, this.id)
      tx.objectStore('checkpoints').put({ ...info, manifest }, this.id)
      if (changed) tx.objectStore('sources').put(members, this.id)
      else {
        // Another tab may have explicitly discarded this slot since our last write.
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

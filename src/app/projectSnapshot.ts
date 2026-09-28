// SPDX-License-Identifier: AGPL-3.0-only
import type { collectProject } from './project'
import { keptParts, projectSections } from './projectSections'

export type ProjectSnapshot = ReturnType<typeof collectProject>

/** Original bytes matter even when a replacement has the same filename. */
export function snapshotKey() {
  const ids = new WeakMap<Uint8Array, number>()
  let nextId = 0
  return ({ manifest, members }: ProjectSnapshot) => JSON.stringify(manifest) + '\n' + members.map(({ name, bytes }) => {
    if (!ids.has(bytes)) ids.set(bytes, ++nextId)
    return `${name}:${ids.get(bytes)}`
  }).join('|')
}

/** Whether a project holds anything worth keeping: a scan, an image, a
 *  plugin's part that says it has work in it, or a part kept from the
 *  project opened last. */
function hasContent({ manifest }: ProjectSnapshot): boolean {
  if (manifest.scan || manifest.flat.image || Object.keys(keptParts().parts).length > 0) return true
  return projectSections().some((s) => manifest[s.key] !== undefined && (s.hasContent?.(manifest[s.key]) ?? false))
}

/** Stores invalidate this synchronously when persisted fields change. Dirty
 * checks and checkpoints then share one projection/serialization per revision.
 * Release the projection after writing so large selection arrays aren't kept
 * merely to answer whether the session is dirty. */
export class ProjectSnapshotCache {
  readonly key = snapshotKey()
  private snapshot: ProjectSnapshot | null = null
  private info: { signature: string; hasContent: boolean } | null = null

  constructor(private readonly capture: () => ProjectSnapshot) {}

  invalidate(): void {
    this.snapshot = null
    this.info = null
  }

  inspect(): { signature: string; hasContent: boolean } {
    if (!this.info) {
      const snapshot = this.capture()
      const signature = this.key(snapshot)
      this.snapshot = snapshot
      this.info = { signature, hasContent: hasContent(snapshot) }
    }
    return this.info
  }

  forWrite(): ProjectSnapshot {
    this.inspect()
    return this.snapshot ??= this.capture()
  }

  release(snapshot: ProjectSnapshot): void {
    // An older asynchronous write must not evict a newer pending projection.
    if (this.snapshot === snapshot) this.snapshot = null
  }
}

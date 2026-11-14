// SPDX-License-Identifier: AGPL-3.0-only
// The cloud the app holds, written as a PLY for a project or a local
// checkpoint in place of a scan file too large to pack, or thinned as it was
// read (see packsHeldCloud). Checkpoints are taken every few seconds while
// work goes on, and the PLY of a 30-million-point cloud is most of a
// gigabyte: it is written once per scan and alignment and kept, so the same
// bytes go to every checkpoint and save — and recovery storage, which tells
// files apart by the identity of their bytes, stores them once.

import type { Rigid } from '../core/deviation/rigid'
import { heldCloudWord, packsHeldCloud, withHeldCloud, type SourceFiles } from './project'
import type { ProjectSnapshot } from './projectSnapshot'

type ScanSource = NonNullable<SourceFiles['scan']>
export interface HeldCloud {
  bytes: Uint8Array
  points: number
}

/** The held cloud of one scan source under one applied alignment, written
 *  by `write` the first time it is asked for and kept until either changes. */
export class HeldCloudCache {
  private kept: { scan: ScanSource; alignment: Rigid | null; cloud: Promise<HeldCloud> } | null = null

  constructor(private readonly write: (alignment: Rigid | null) => Promise<HeldCloud>) {}

  get(scan: ScanSource, alignment: Rigid | null): Promise<HeldCloud> {
    const kept = this.kept
    if (kept && kept.scan === scan && kept.alignment === alignment) return kept.cloud
    const cloud = this.write(alignment)
    const entry = { scan, alignment, cloud }
    this.kept = entry
    // A write that failed is not kept: the next asks again.
    cloud.catch(() => { if (this.kept === entry) this.kept = null })
    return cloud
  }

  /** Let go of the bytes: the scan no longer needs them. */
  forget(): void {
    this.kept = null
  }
}

/** The project as it goes into a file or a checkpoint: `snapshot` itself,
 *  or with its scan member the held cloud when the rule says so — and the
 *  status line's word on that. Null when the scan changed while its cloud
 *  was written: the bytes would not be the scan's the manifest describes. */
export async function storedProject(
  snapshot: ProjectSnapshot,
  sources: { readonly current: SourceFiles },
  session: { scanIsCloud: boolean; appliedAlignment: Rigid | null },
  cache: HeldCloudCache,
): Promise<{ project: ProjectSnapshot; word: string } | null> {
  const scan = sources.current.scan
  if (!scan || !snapshot.manifest.scan || !packsHeldCloud(scan, session.scanIsCloud)) {
    cache.forget()
    return { project: snapshot, word: '' }
  }
  const held = await cache.get(scan, session.appliedAlignment)
  if (sources.current.scan !== scan) return null
  return { project: withHeldCloud(snapshot, held.bytes), word: heldCloudWord(scan, held.points) }
}

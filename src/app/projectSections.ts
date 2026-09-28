// SPDX-License-Identifier: AGPL-3.0-only
// The parts of a project file a plugin owns. The app writes and reads its own
// parts — the scan and what was measured on it, the reference, the image —
// and hands each plugin's section its own key of the manifest, and any files
// of its own beside the models in the archive.
//
// A project opened in a build without a plugin whose part it holds keeps
// that part: it is carried as it was read and written back when the project
// is saved, with the archive's files that part names, so a project passed
// through a build without the plugin loses nothing. It is let go once
// another scan is loaded, which it was not made on.

import type { ArchiveMember } from '../core/project/archive'
import type { ProjectManifest } from '../core/project/manifest'
import type { SourceFiles } from './project'
import { onScan } from './scanEvents'

export interface CollectContext {
  sources: SourceFiles
  /** Whether the scan goes into this file: a part about the scan is kept
   *  only with it. */
  scanSaved: boolean
  /** Put a file of the section's own into the archive. */
  addMember(name: string, bytes: Uint8Array): void
}

export interface RestoreContext {
  manifest: ProjectManifest
  members: ReadonlyMap<string, Uint8Array>
}

export interface ProjectSection<J = unknown> {
  /** The manifest key the section's part is kept under. Unique, and stable:
   *  files already saved carry it. */
  key: string
  /** The part as the file is to hold it — plain JSON — or undefined for none. */
  collect(ctx: CollectContext): J | undefined
  /** The archive's files a part as read from a file names, which the section
   *  reads itself. */
  members?(value: J): string[]
  /** Check a part as read from a file — undefined when the file has none —
   *  with the archive's files it names, and turn it into what putting it in
   *  place does. Nothing may change here: this runs while the session being
   *  replaced is still whole, and throws on anything malformed or missing so
   *  that it stays whole. */
  prepare(value: unknown, ctx: RestoreContext): () => void
  /** Once the models and every store are in place, before anything is
   *  measured: bring back what the part keeps in the archive's files. */
  restore?(value: J, ctx: RestoreContext): Promise<void>
  /** Once the app has measured what it measures on the part: measure what
   *  the section measures. */
  remeasure?(value: J, ctx: RestoreContext): Promise<void>
  /** Whether a part as collected is work to keep — a project of nothing
   *  else is still one worth saving and checkpointing. */
  hasContent?(value: J): boolean
  /** Whether the session holds work of the section's worth a warning before
   *  it is replaced. */
  holdsWork?(): boolean
  /** Unfinished work in the section's editors, which is not saved but is
   *  worth a warning before the page is left. */
  hasDraft?(): boolean
  /** Call `changed` whenever what `collect` reads changes, and `draft`
   *  whenever what `hasDraft` reads does; the returned function stops it. */
  watch?(changed: () => void, draft: () => void): () => void
}

const sections: ProjectSection[] = []

/** Own a part of the project file — see ProjectSection. */
export function registerProjectSection<J>(section: ProjectSection<J>): () => void {
  if (sections.some((s) => s.key === section.key)) throw new Error(`Two project sections share the key "${section.key}".`)
  sections.push(section as ProjectSection)
  return () => {
    const i = sections.indexOf(section as ProjectSection)
    if (i >= 0) sections.splice(i, 1)
  }
}

export const projectSections = (): readonly ProjectSection[] => sections

/** The manifest keys the app writes itself. */
const CORE_KEYS = new Set(['app', 'schemaVersion', 'appVersion', 'workspace', 'scan', 'deviation', 'thickness', 'flat'])

// ---- Parts no section here owns -------------------------------------------------

let kept: { parts: Record<string, unknown>; members: ArchiveMember[] } = { parts: {}, members: [] }

/** Keep what of a project just opened no section in this build owns: its
 *  parts, and the archive's files neither the app's parts nor a section in
 *  use names. Returns the keys kept. */
export function keepUnownedParts(manifest: ProjectManifest, members: ReadonlyMap<string, Uint8Array>): string[] {
  const owned = new Set(sections.map((s) => s.key))
  const parts: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(manifest)) {
    if (!CORE_KEYS.has(key) && !owned.has(key) && value !== undefined) parts[key] = value
  }
  const named = new Set<string>()
  for (const file of [manifest.scan, manifest.deviation.reference, manifest.flat.image]) if (file) named.add(file.member)
  for (const s of sections) {
    const value = manifest[s.key]
    if (value !== undefined) for (const m of s.members?.(value) ?? []) named.add(m)
  }
  const keys = Object.keys(parts)
  kept = {
    parts,
    // Only a project that holds a part of someone else's has files of theirs.
    members: keys.length === 0 ? [] : [...members].filter(([name]) => name !== 'project.json' && !named.has(name)).map(([name, bytes]) => ({ name, bytes })),
  }
  return keys
}

/** The parts kept for writing back, and their files. */
export const keptParts = (): Readonly<typeof kept> => kept

/** Let the kept parts go. */
export function forgetKeptParts(): void {
  kept = { parts: {}, members: [] }
}

// Another scan is another part: what was kept was made on the one before.
onScan({ loaded: () => forgetKeptParts() })

// SPDX-License-Identifier: AGPL-3.0-only
// The project file is a plain zip: project.json beside the original model
// files, deflated. A zip rather than a private container so the scan can be
// pulled back out with any archive tool should the app ever go away.

import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import { MANIFEST_NAME, validateManifest, type ProjectManifest } from './manifest'

export interface ArchiveMember {
  name: string
  bytes: Uint8Array
}

/** Past this many characters of compact JSON the manifest is written
 *  compact: indented, every index of a marked surface and every slice point
 *  of a fitted sketch piece takes a line of its own with its indentation —
 *  three times the text and more — and a large project's manifest has
 *  millions of them. */
const PRETTY_LIMIT = 2_000_000

/** The manifest as the archive holds it: indented to be read by eye while
 *  it is small, compact once it is not. */
export function manifestText(manifest: ProjectManifest, prettyLimit = PRETTY_LIMIT): string {
  const compact = JSON.stringify(manifest)
  return compact.length > prettyLimit ? compact : JSON.stringify(manifest, null, 2)
}

/** Build the archive. The manifest is pretty-printed while it is small — it
 *  is the one member a person might open — and every model file is deflated
 *  at a level that gets most of the gain without waiting on the last few
 *  percent. */
export function packProject(manifest: ProjectManifest, members: ArchiveMember[], limits = PROJECT_LIMITS): Uint8Array {
  const manifestBytes = strToU8(manifestText(manifest))
  const total = members.reduce((sum, member) => sum + member.bytes.byteLength, manifestBytes.byteLength)
  if (members.length + 1 > limits.members || manifestBytes.byteLength > limits.manifestBytes || total > limits.totalBytes) {
    throw new Error('The project exceeds the supported archive size limits.')
  }
  const entries: Zippable = {
    [MANIFEST_NAME]: [manifestBytes, { level: 6 }],
  }
  for (const m of members) entries[m.name] = [m.bytes, { level: 6 }]
  return zipSync(entries)
}

export interface UnpackedProject {
  manifest: ProjectManifest
  members: Map<string, Uint8Array>
}

export const PROJECT_LIMITS = { members: 16, manifestBytes: 64 * 1024 * 1024, totalBytes: 1024 * 1024 * 1024 }
class ArchiveLimitError extends Error {}

/** Read the archive back and check it is a project this build can open. */
export function unpackProject(bytes: Uint8Array, limits = PROJECT_LIMITS): UnpackedProject {
  let files: Record<string, Uint8Array>
  try {
    let total = 0
    const names = new Set<string>()
    files = unzipSync(bytes, { filter: ({ name, originalSize }) => {
      if (names.has(name) || name.includes('/') || name.includes('\\') || name === '__proto__') {
        throw new ArchiveLimitError('Malformed project: duplicate or invalid archive member.')
      }
      names.add(name)
      total += originalSize
      if (names.size > limits.members || total > limits.totalBytes ||
          (name === MANIFEST_NAME && originalSize > limits.manifestBytes)) {
        throw new ArchiveLimitError('The project exceeds the supported archive size limits.')
      }
      return true
    } })
  } catch (error) {
    if (error instanceof ArchiveLimitError) throw error
    throw new Error('Not a ScanRuler project file.')
  }
  const raw = files[MANIFEST_NAME]
  if (!raw) throw new Error('Not a ScanRuler project file.')
  let parsed: unknown
  try {
    parsed = JSON.parse(strFromU8(raw))
  } catch {
    throw new Error('Malformed project: project.json is not JSON.')
  }
  const manifest = validateManifest(parsed)
  for (const entry of [manifest.scan, manifest.deviation.reference, manifest.flat.image]) {
    if (entry && !Object.hasOwn(files, entry.member)) throw new Error(`Project is missing ${entry.member}.`)
  }
  const members = new Map<string, Uint8Array>()
  for (const [name, data] of Object.entries(files)) if (name !== MANIFEST_NAME) members.set(name, data)
  return { manifest, members }
}

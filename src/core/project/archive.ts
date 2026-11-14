// SPDX-License-Identifier: AGPL-3.0-only
// The project file is a plain zip: project.json beside the original model
// files, deflated. A zip rather than a private container so the scan can be
// pulled back out with any archive tool should the app ever go away.

import { strFromU8, strToU8 } from 'fflate'
import { MANIFEST_NAME, validateManifest, type ProjectManifest } from './manifest'
import { byteSizeText, MAX_READ_BYTES, readSourceFile, readSourceFileSync } from '../sourceFile'
import { bytesSource, type ByteSource } from '../parsers/byteSource'
import { isMemberName } from './validation'
import { readZipMember, zipDirectory, zipParts, ZipCountError, ZipFormatError } from './zip'

/** A member as the session hands it over: the scan and the reference are
 *  the files they were opened from (see core/sourceFile), read only when the
 *  archive is built. */
export interface ArchiveMember {
  name: string
  bytes: Uint8Array | Blob
}

/** A member with its bytes in hand, as the archive is built from. */
export interface ArchiveFile {
  name: string
  bytes: Uint8Array
}

/** The name a member's file is reported by when it can no longer be read:
 *  the one the person opened it under, not its member's. */
const sourceName = (bytes: Blob, name: string) => (bytes instanceof File ? bytes.name : name)

/** Every member's bytes, the files among them read now — a copy that lives
 *  only as long as the packing does. Read one after another, so a failure
 *  stops the reading and a slow disk is not asked for them all at once. */
export async function readMembers(members: readonly ArchiveMember[]): Promise<ArchiveFile[]> {
  const files: ArchiveFile[] = []
  for (const { name, bytes } of members) {
    files.push({ name, bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(await readSourceFile(bytes, sourceName(bytes, name))) })
  }
  return files
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

/** Build the archive, as the parts it is made of (zipParts): a Blob of them
 *  is the file, and no one buffer ever holds all of it. The manifest is
 *  pretty-printed while it is small — it is the one member a person might
 *  open — and every model file is deflated at a level that gets most of the
 *  gain without waiting on the last few percent.
 *
 *  A member held as a file is read when it is reached, synchronously — so
 *  in a worker (readSourceFileSync), where the files are read one at a time
 *  rather than all into the page before packing. An archive past `maxBytes`
 *  is given up as soon as it is (ZipTooLargeError). */
export function packProjectParts(manifest: ProjectManifest, members: readonly ArchiveMember[], limits: ProjectLimits = PROJECT_LIMITS, maxBytes = Infinity): Uint8Array[] {
  const manifestBytes = strToU8(manifestText(manifest))
  const sizeOf = (bytes: Uint8Array | Blob) => (bytes instanceof Uint8Array ? bytes.byteLength : bytes.size)
  const problem = sizeProblem([{ name: MANIFEST_NAME, size: manifestBytes.byteLength }, ...members.map((m) => ({ name: m.name, size: sizeOf(m.bytes) }))], limits)
  if (problem) throw new Error(`${LIMIT_MESSAGE} — ${problem}. Make the scan or the reference smaller, and save again.`)
  for (const m of members) {
    // Refused here rather than written into a file that will not open.
    if (!isMemberName(m.name)) throw new Error(`The project cannot hold a file named "${m.name}".`)
  }
  return zipParts([
    { name: MANIFEST_NAME, bytes: manifestBytes, level: 6 },
    ...members.map(({ name, bytes }) => ({
      name,
      bytes: bytes instanceof Uint8Array ? bytes : () => readSourceFileSync(bytes, sourceName(bytes, name)),
      level: 6 as const,
    })),
  ], 0, new Date(), maxBytes)
}

/** The archive in one piece — for one small enough to hold so. */
export function packProject(manifest: ProjectManifest, members: ArchiveFile[], limits: ProjectLimits = PROJECT_LIMITS): Uint8Array {
  return joinParts(packProjectParts(manifest, members, limits))
}

/** Parts joined into one buffer. */
export function joinParts(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.byteLength
  }
  return out
}

export interface UnpackedProject {
  manifest: ProjectManifest
  members: Map<string, Uint8Array>
}

export interface ProjectLimits {
  /** Members, the manifest among them. */
  members: number
  manifestBytes: number
  /** Any one member, expanded. */
  entryBytes: number
  /** Every member together, expanded. */
  totalBytes: number
}

/** What a project may hold. Opening one brings every file in it back into
 *  the tab's memory, whole — the session holds a scan and a reference as the
 *  bytes it opened them from — so the total is what a tab can be asked to
 *  hold beside the geometry built from them: 4 GiB, past the 1.2 GB of a
 *  28-million-point cloud and a 529 MB reference the 1 GiB this once was
 *  turned away, and still short of what a tab holds before it is out of
 *  memory. A member is at most 2 GiB: the one ArrayBuffer a browser reads a
 *  file into, and well inside the 4 GiB a zip's own size fields take. The
 *  archive itself may pass 4 GiB with its headers; its offsets then go into
 *  zip64 records. */
export const PROJECT_LIMITS: ProjectLimits = {
  members: 16,
  manifestBytes: 64 * 1024 * 1024,
  entryBytes: MAX_READ_BYTES,
  totalBytes: 4 * 1024 ** 3,
}

const LIMIT_MESSAGE = 'The project exceeds the supported archive size limits'
class ArchiveLimitError extends Error {}

/** A limit as people read it: "4 GiB", "2 GiB", else "512 MB". */
const limitText = (bytes: number) =>
  bytes === MAX_READ_BYTES ? '2 GiB' : bytes % 1024 ** 3 === 0 ? `${bytes / 1024 ** 3} GiB` : byteSizeText(bytes)

/** Which limit a project of these members is past, said so, or null. */
export function sizeProblem(members: readonly { name: string; size: number }[], limits: ProjectLimits = PROJECT_LIMITS): string | null {
  if (members.length > limits.members) return `it holds ${members.length} files, and a project holds at most ${limits.members}`
  let total = 0
  for (const { name, size } of members) {
    if (name === MANIFEST_NAME && size > limits.manifestBytes) return `its ${MANIFEST_NAME} is ${byteSizeText(size)}, past the ${limitText(limits.manifestBytes)} it may be`
    if (size > limits.entryBytes) return `${name} in it is ${byteSizeText(size)}, and one file in a project is at most ${limitText(limits.entryBytes)}`
    total += size
  }
  if (total > limits.totalBytes) return `it holds ${byteSizeText(total)} of files, and a project holds at most ${limitText(limits.totalBytes)}`
  return null
}

/** Read the archive back and check it is a project this build can open: from
 *  its bytes, or from the file a member at a time (a worker's blobSource),
 *  so a project past what one buffer holds opens too. */
export function unpackProject(input: Uint8Array | ByteSource, limits: ProjectLimits = PROJECT_LIMITS): UnpackedProject {
  const source = input instanceof Uint8Array ? bytesSource(input) : input
  const files = new Map<string, Uint8Array>()
  try {
    const listed = zipDirectory(source, limits.members)
    const names = new Set<string>()
    for (const { name, method } of listed) {
      if (names.has(name) || name.includes('/') || name.includes('\\') || name === '__proto__') {
        throw new ArchiveLimitError('Malformed project: duplicate or invalid archive member.')
      }
      // Only stored and deflated members are written.
      if (method !== 0 && method !== 8) throw new ArchiveLimitError('Malformed project: unsupported archive compression.')
      names.add(name)
    }
    // Every size checked before anything is expanded. A stored member yields
    // its compressed bytes whatever size it declares, so the larger of the
    // two sizes is what counts; and what comes out is held to what was
    // declared (readZipMember).
    const problem = sizeProblem(listed.map((m) => ({ name: m.name, size: Math.max(m.size, m.compressedSize) })), limits)
    if (problem) throw new ArchiveLimitError(`${LIMIT_MESSAGE} — ${problem}.`)
    for (const member of listed) files.set(member.name, readZipMember(source, member))
  } catch (error) {
    if (error instanceof ArchiveLimitError) throw error
    if (error instanceof ZipCountError) throw new Error(`${LIMIT_MESSAGE} — it holds ${error.count} files, and a project holds at most ${limits.members}.`)
    if (error instanceof ZipFormatError) throw new Error('Not a ScanRuler project file.')
    throw error
  }
  const raw = files.get(MANIFEST_NAME)
  if (!raw) throw new Error('Not a ScanRuler project file.')
  let parsed: unknown
  try {
    parsed = JSON.parse(strFromU8(raw))
  } catch {
    throw new Error('Malformed project: project.json is not JSON.')
  }
  const manifest = validateManifest(parsed)
  for (const entry of [manifest.scan, ...(manifest.scan?.companions ?? []), manifest.deviation.reference, manifest.flat.image]) {
    if (entry && !files.has(entry.member)) throw new Error(`Project is missing ${entry.member}.`)
  }
  files.delete(MANIFEST_NAME)
  return { manifest, members: files }
}

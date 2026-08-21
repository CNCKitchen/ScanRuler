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

/** Build the archive. The manifest is pretty-printed — it is the one member a
 *  person might open — and every model file is deflated at a level that gets
 *  most of the gain without waiting on the last few percent. */
export function packProject(manifest: ProjectManifest, members: ArchiveMember[]): Uint8Array {
  const entries: Zippable = {
    [MANIFEST_NAME]: [strToU8(JSON.stringify(manifest, null, 2)), { level: 6 }],
  }
  for (const m of members) entries[m.name] = [m.bytes, { level: 6 }]
  return zipSync(entries)
}

export interface UnpackedProject {
  manifest: ProjectManifest
  members: Map<string, Uint8Array>
}

/** Read the archive back and check it is a project this build can open. */
export function unpackProject(bytes: Uint8Array): UnpackedProject {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes)
  } catch {
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
  const members = new Map<string, Uint8Array>()
  for (const [name, data] of Object.entries(files)) if (name !== MANIFEST_NAME) members.set(name, data)
  return { manifest, members }
}

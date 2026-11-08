// SPDX-License-Identifier: AGPL-3.0-only
// The copy of the scan the Mesh Tools edits make, held in one place for the
// session, the project file, the export and the commands — outside every
// store, as a big buffer is.

import type { MeshUnits } from '../../../src/core/meshUnits'

/** The copy of the scan the Mesh Tools workspace edits: a PLY in the frame
 *  the scan was opened in, read in the pose the scan stands in, and every
 *  scan vertex's number on it — −1 for one an edit took — which carries
 *  whatever is marked on the scan across when the copy is taken into use. */
export interface EditedCopy {
  source: { name: string; bytes: Uint8Array; units?: MeshUnits }
  map: Int32Array
}

/** The memory a version of the copy holds: its file and its numbering. */
export const editedCopyBytes = (copy: EditedCopy): number => copy.source.bytes.byteLength + copy.map.byteLength

/** The copy being edited, or null with none. Kept like the app keeps the
 *  bytes of every model it opened (app/project SourceFiles): out of every
 *  store, being a big buffer, and one to a session. */
export const editedCopy: { current: EditedCopy | null } = { current: null }

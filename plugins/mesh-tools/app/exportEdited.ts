// SPDX-License-Identifier: AGPL-3.0-only
// The edited copy of the scan out of the tool as an STL or a 3MF, in the
// pose the scan is shown in. Unlike the reduced mesh and the trimmed piece, the copy
// is kept in the frame the scan was opened in, so the datum alignment goes
// on here as well as the deviation best fit — see buildEditedMesh, which the
// panel's button and the workspace's commands (meshCommands.ts) both use.

import { buildMeshFile, type MeshFormat } from '../../../src/core/exportMesh'
import { parsePLY } from '../../../src/core/parsers/ply'
import { rigidApplyToPoints } from '../../../src/core/deviation/rigid'
import { exportStem, saveBuilt, type BuiltFile } from '../../../src/app/exports'
import { projectOutputDirectory, usesLocalOutput, writeMeshExport } from '../../../src/app/projectRevisions'
import { useStore } from '../../../src/state/store'
import { useDeviation } from '../../../src/state/deviationStore'
import { editedCopy } from '../state/editedCopy'

/** The edited copy as an STL or a 3MF — the scan cleaned up, its holes filled, a
 *  bore cut out of it — in the pose the scan is shown in, the way the scan
 *  itself goes: the copy is kept in the frame the scan was opened in, so
 *  the datum alignment goes on it here, and the deviation best fit on the
 *  way out. Never under the name the scan came in under. Null with no copy;
 *  throws when the copy cannot be read. */
export function buildEditedMesh(format: MeshFormat): BuiltFile | null {
  const store = useStore.getState()
  const copy = editedCopy.current
  if (!copy || !store.fileName) return null
  const parsed = parsePLY(copy.source.bytes.slice().buffer)
  if (!parsed.indices) throw new Error('the copy has no triangles.')
  const positions = parsed.positions.slice()
  if (store.appliedAlignment) rigidApplyToPoints(store.appliedAlignment, positions)
  const align = useDeviation.getState().align
  const moved = align !== null || store.appliedAlignment !== null
  const stem = exportStem()
  const file = buildMeshFile(format, [{ name: `${stem} edited`, positions, indices: parsed.indices }], align?.transform ?? null, `ScanRuler edited mesh - ${stem}`)
  if (!file) throw new Error('the copy has no triangles.')
  const name = `${stem}-edited${moved ? '-aligned' : ''}.${file.extension}`
  return {
    name,
    mimeType: file.mimeType,
    bytes: file.bytes,
    status: `Edited copy exported to ${name} — ${file.triangles.toLocaleString('en-US')} triangles${moved ? ', in its aligned position' : ''}.`,
  }
}

/** Hand the edited copy over as an STL or a 3MF — see buildEditedMesh. */
let exporting = false

export const exportEditedMesh = async (format: MeshFormat): Promise<void> => {
  if (exporting) return
  exporting = true
  try {
    if (!editedCopy.current) throw new Error('There is no edited copy to export.')
    if (usesLocalOutput()) {
      const file = buildEditedMesh(format)
      if (!file) throw new Error('There is no edited copy to export.')
      await saveBuilt(file)
    } else {
      const directory = await projectOutputDirectory()
      const file = buildEditedMesh(format)
      if (!file) throw new Error('There is no edited copy to export.')
      const name = await writeMeshExport(directory, file.name, file.bytes, file.mimeType)
      useStore.getState().setStatus(`Edited copy exported to ${directory.name}\\${name}.`)
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      useStore.getState().setStatus('Export cancelled. No mesh file was written.')
    } else {
      useStore.getState().setError(`Export failed — ${e instanceof Error ? e.message : String(e)}`)
    }
  } finally {
    exporting = false
  }
}

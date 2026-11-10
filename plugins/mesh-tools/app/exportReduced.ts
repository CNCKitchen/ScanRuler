// SPDX-License-Identifier: AGPL-3.0-only
// Reduce mesh's result out of the tool: the light mesh as an STL or a 3MF to
// model over in CAD, landing there on the datums the scan was aligned to —
// see buildReducedMesh, which the panel's button and the workspace's
// commands (meshCommands.ts) both use.

import { meshSceneOf } from '../viewer/meshScene'
import type { RefObject } from 'react'
import { buildMeshFile, type MeshFormat } from '../../../src/core/exportMesh'
import { exportStem, runExport, saveBuilt, type BuiltFile } from '../../../src/app/exports'
import { useStore } from '../../../src/state/store'
import { useDeviation } from '../../../src/state/deviationStore'
import type { SceneManager } from '../../../src/viewer/SceneManager'
import { useMeshTools } from '../state/meshStore'
import { fmtLen, type DisplayUnits } from '../../../src/core/units'
import { typedLen } from '../ui/meshFormat'

/** The reduced mesh as an STL or a 3MF — the light one, for modelling over
 *  in CAD —
 *  in the pose the scan is shown in, the same way the scan itself goes: a
 *  datum alignment is in its vertices already (it was made from the
 *  aligned scan, and moves with it after), and the deviation best fit is
 *  applied on the way out. So the part lands in CAD sitting on the datums
 *  it was aligned to, which is most of what makes it a blueprint rather
 *  than a lump. What is written is the mesh on screen, whatever the panel
 *  has been changed to since. Null with none on the viewport. The status
 *  gives its lengths in `units` — mm unless asked, as a command answers. */
export function buildReducedMesh(scene: SceneManager | null, format: MeshFormat, units: DisplayUnits = 'mm'): BuiltFile | null {
  const store = useStore.getState()
  const report = useMeshTools.getState().report
  const geometry = meshSceneOf(scene)?.reducedGeometry()
  if (!geometry || !report || !store.fileName) return null
  const positions = geometry.getAttribute('position').array as Float32Array
  const index = geometry.getIndex()?.array as Uint32Array | undefined
  if (!index) return null
  const align = useDeviation.getState().align
  const moved = align !== null || store.appliedAlignment !== null
  const stem = exportStem()
  const tolerance = report.settings.tolerance
  const file = buildMeshFile(
    format,
    [{ name: `${stem} reduced`, positions, indices: index }],
    align?.transform ?? null,
    // units-ok: the title written into the file, in the file's own unit.
    `ScanRuler reduced mesh - ${stem} - tolerance ${tolerance} mm`,
  )
  if (!file) return null
  const name = `${stem}-reduced${moved ? '-aligned' : ''}.${file.extension}`
  return {
    name,
    mimeType: file.mimeType,
    bytes: file.bytes,
    status:
      `Reduced mesh exported to ${name} — ${file.triangles.toLocaleString('en-US')} triangles, ` +
      `99.9 % of the scan within ±${report.held ? typedLen(tolerance, units) : fmtLen(report.p999, units, 3)}${moved ? ', in its aligned position' : ''}.`,
  }
}

/** Hand the reduced mesh over as an STL or a 3MF — see buildReducedMesh. */
export const exportReducedMesh = (sceneRef: RefObject<SceneManager | null>, format: MeshFormat, units: DisplayUnits = 'mm') =>
  runExport(async () => saveBuilt(buildReducedMesh(sceneRef.current, format, units)))

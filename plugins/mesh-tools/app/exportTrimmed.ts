// SPDX-License-Identifier: AGPL-3.0-only
// The piece Trim to scan made, out of the tool as an STL or a 3MF to print
// and glue into the break — posed the way the reduced mesh is (exportReduced.ts) and
// named after the body it was cut from.

import { meshSceneOf } from '../viewer/meshScene'
import type { RefObject } from 'react'
import { buildMeshFile, type MeshFormat } from '../../../src/core/exportMesh'
import { exportStem, runExport, saveBuilt, type BuiltFile } from '../../../src/app/exports'
import { useStore } from '../../../src/state/store'
import { useDeviation } from '../../../src/state/deviationStore'
import type { SceneManager } from '../../../src/viewer/SceneManager'
import { useMeshTools } from '../state/meshStore'
import { fmtVol, type DisplayUnits } from '../../../src/core/units'

/** The piece Trim to scan made as an STL or a 3MF — to print and glue
 *  in — in the
 *  pose the scan is shown in, the way the reduced mesh goes (see
 *  exportReduced): a datum alignment is in its vertices already, and the
 *  deviation best fit is applied on the way out. What is written is the
 *  piece on screen, whatever the panel has been changed to since. Null with
 *  none on the viewport. The status gives its volume in `units` — mm unless
 *  asked, as a command answers. */
export function buildTrimmedMesh(scene: SceneManager | null, format: MeshFormat, units: DisplayUnits = 'mm'): BuiltFile | null {
  const store = useStore.getState()
  const made = useMeshTools.getState().trimMade
  const geometry = meshSceneOf(scene)?.trimmedGeometry()
  if (!geometry || !made || !store.fileName) return null
  const positions = geometry.getAttribute('position').array as Float32Array
  const index = geometry.getIndex()?.array as Uint32Array | undefined
  if (!index) return null
  const align = useDeviation.getState().align
  const moved = align !== null || store.appliedAlignment !== null
  const stem = exportStem()
  const body = made.name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'body'
  const file = buildMeshFile(
    format,
    [{ name: `${made.name} trimmed`, positions, indices: index }],
    align?.transform ?? null,
    // units-ok: the title written into the file, in the file's own unit.
    `ScanRuler trimmed piece - ${stem} - ${made.name} - ${made.report.offset} mm off the break`,
  )
  if (!file) return null
  const name = `${stem}-${body}-trimmed${moved ? '-aligned' : ''}.${file.extension}`
  return {
    name,
    mimeType: file.mimeType,
    bytes: file.bytes,
    status:
      `${made.name}, trimmed to the break, exported to ${name} — ${fmtVol(made.report.volume, units, 1)}, ` +
      `${file.triangles.toLocaleString('en-US')} triangles${moved ? ', in its aligned position' : ''}.`,
  }
}

/** Hand the piece over as an STL or a 3MF — see buildTrimmedMesh. */
export const exportTrimmedMesh = (sceneRef: RefObject<SceneManager | null>, format: MeshFormat, units: DisplayUnits = 'mm') =>
  runExport(async () => saveBuilt(buildTrimmedMesh(sceneRef.current, format, units)))

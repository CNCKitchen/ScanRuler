// SPDX-License-Identifier: AGPL-3.0-only
// Opening a scan: read the file in the worker, put it on the viewport, and
// start the session over on it — everything measured on the scan before goes
// with it. The panels' Open buttons, a dropped file and the scan.open command
// all come through here.

import type { RefObject } from 'react'
import { boundsOf } from '../core/geometry/bounds'
import { creaseSetting, type CreaseReport, type CreaseSetting } from '../core/geometry/crease'
import { unitsLabel, type MeshUnits } from '../core/meshUnits'
import type { MeshWorkerClient } from '../core/workerClient'
import { useDeviation } from '../state/deviationStore'
import { clearHistory } from '../state/historyStore'
import { useMark } from '../state/markStore'
import { useStore } from '../state/store'
import { useThickness } from '../state/thicknessStore'
import { meshUnitsFor } from '../state/unitsPromptStore'
import type { ScanMaps } from '../plugins/api'
import type { SceneManager } from '../viewer/SceneManager'
import type { ImportQueue } from './importQueue'
import { prepareScan, runImport, type PreparedScan } from './imports'
import type { SourceFiles } from './project'
import { scanLoaded } from './scanEvents'
import { forgetAllSurfaces } from './surfaces'

const LARGE_TRIANGLE_WARNING = 5_000_000

/** What became of the sharp-edge split, for the status line. Null when it
 *  went as asked and there is nothing to add. */
export function creaseNote(report: CreaseReport, crease: CreaseSetting): string | null {
  if (report.skipped === 'budget') {
    return `Sharp edges are shaded smooth: drawing every edge from ${crease.angleDeg}° on sharp would add more vertices than the scan has — try a larger angle.`
  }
  if (report.skipped === 'scan') {
    return 'This mesh reads as a scan, so its edges are shaded smooth — set Sharp edges to Always to split them regardless, from an angle the noise does not reach.'
  }
  if (report.skipped === 'off') return 'Sharp edges shaded smooth.'
  if (report.added === 0) {
    return crease.mode === 'on' ? `No edges of ${crease.angleDeg}° or more to split on this mesh.` : 'Sharp edges drawn sharp.'
  }
  return `Edges from ${crease.angleDeg}° on drawn sharp — ${report.added.toLocaleString('en-US')} vertices split.`
}

export interface ScanImportDeps {
  clientRef: RefObject<MeshWorkerClient | null>
  sceneRef: RefObject<SceneManager | null>
  sources: RefObject<SourceFiles>
  imports: ImportQueue
  maps: ScanMaps
  clearPreview: () => void
}

export type ScanImport = ReturnType<typeof scanImport>

export function scanImport({ clientRef, sceneRef, sources, imports, maps, clearPreview }: ScanImportDeps) {
  /** Put a prepared scan in place of the one there was — or none, for a
   *  project without one. */
  const commitScan = (prepared: PreparedScan | null) => {
    const store = useStore.getState()
    clearPreview()
    // A different scan invalidates the alignment and the map measured under
    // it, and its wall thickness along with them; the reference geometry
    // itself is still perfectly good. The elements go with the scan they were
    // measured on, so the map against one of them goes too.
    maps.deviation.current = null
    maps.deviationRgb.current = null
    maps.elementField.current = null
    maps.elementRgb.current = null
    // The marked region is vertex indices into the scan being replaced — and
    // so is every surface an element rested on.
    maps.elementScope.current = null
    forgetAllSurfaces()
    maps.thickness.current = null
    maps.thicknessRgb.current = null
    useDeviation.getState().clearAlign()
    useDeviation.getState().clearElementMap()
    useDeviation.getState().clearScope()
    useThickness.getState().clear()
    // Nothing is marked on a part that is being replaced, and no gesture should
    // survive the swap.
    useMark.getState().reset()
    sources.current.scan = prepared?.source ?? null
    store.beginLoad(prepared?.source.name ?? '')
    if (prepared) {
      prepared.view.commit()
      const { mesh } = prepared
      // The viewport measures the part as it lays it out; without one, the
      // same box is read off the vertices.
      const scene = sceneRef.current
      const bounds = scene ? null : boundsOf(mesh.positions, mesh.vertexCount)
      const modelSize = scene?.modelSize() ?? bounds!.radius
      store.finishLoad(mesh.vertexCount, mesh.triangleCount, modelSize, scene?.modelCenter() ?? bounds!.center)
      useMark.getState().sizeToModel(modelSize)
      useThickness.getState().suggestMaxThickness(2 * modelSize)
      scanLoaded({ positions: mesh.positions, indices: mesh.indices, modelSize })
    } else {
      sceneRef.current?.clearScan()
      useStore.setState({ fileName: null, modelSize: 1, modelCenter: [0, 0, 0] })
      scanLoaded(null)
    }
    // Project restoration still has work to do; the import owns this flag.
    useStore.setState({ busy: true })
    clearHistory()
  }

  /** An STL is asked about first — what units it is in — unless `units` is
   *  given: a file the instrument wrote itself, in millimetres like
   *  everything it holds. A question dismissed leaves the file unopened. */
  const openScan = async (file: File, units?: MeshUnits): Promise<void> => {
    const read = units ?? (await meshUnitsFor(file.name))
    if (!read) return
    await runImport(imports, 'Reading file…', async () => {
      const client = clientRef.current!
      const crease = creaseSetting(useStore.getState())
      const prepared = await prepareScan(client, sceneRef.current, file, crease, undefined, read)
      try {
        await client.commitImport({ scan: prepared.id })
        commitScan(prepared)
        const mesh = prepared.mesh
        const creaseWord = mesh.crease.skipped === 'budget' ? ` ${creaseNote(mesh.crease, crease)}` : ''
        const unitsWord = read !== 'mm' ? `Read in ${unitsLabel(read).toLowerCase()} and converted to millimetres. ` : ''
        useStore.getState().setStatus(
          unitsWord +
          (mesh.triangleCount > LARGE_TRIANGLE_WARNING
            ? `Large mesh (${mesh.triangleCount.toLocaleString('en-US')} triangles) — fits may take a moment. Pick an element type to start.`
            : 'Pick an element type in the panel to start measuring.') + creaseWord)
      } finally {
        prepared.view.dispose()
        await client.discardImport([prepared.id])
      }
    })
  }

  return { commitScan, openScan }
}

// SPDX-License-Identifier: AGPL-3.0-only
// Another version of the scan put in place under the session — an edit of
// it, or the one before an edit, which is how a step of the undo history
// crosses one — keeping everything measured on it: the elements, the
// sections, the alignments, the settings. What was read off the old vertices
// goes, because the vertices are the new file's: the maps, the surfaces the
// elements rest on, the marking. Whoever else kept something read off them
// hears of it through the scan events (scanEvents.ts). Part of the session
// (app/session.ts): the history steps across an edit, and a workspace that
// edits the scan, call it — with or without a viewport.

import type { RefObject } from 'react'
import type { Rigid } from '../core/deviation/rigid'
import { boundsOf } from '../core/geometry/bounds'
import { remapVertices } from '../core/geometry/remap'
import type { ElementKind } from '../core/types'
import type { MeshWorkerClient } from '../core/workerClient'
import type { ScanMaps } from '../plugins/api'
import { useDeviation } from '../state/deviationStore'
import { useMark } from '../state/markStore'
import { useStore } from '../state/store'
import { creaseSetting } from '../core/geometry/crease'
import { useThickness } from '../state/thicknessStore'
import type { SceneManager } from '../viewer/SceneManager'
import type { SourceFiles } from './project'
import { readSourceFile } from '../core/sourceFile'
import { scanRemapped, scanRemeasure, scanSwapped, scanSwapping } from './scanEvents'
import { forgetAllSurfaces } from './surfaces'
import { scanCompanions } from './scanFiles'
import { cloudOf } from './imports'
import type { LoadedScan } from '../core/workerClient'

/** A scan as the session holds it: its file, its units, and the files that
 *  came with it. An edited version is new bytes, kept as a file of its own
 *  with `new Blob([bytes])`. */
export type ScanSource = NonNullable<SourceFiles['scan']>

export function scanSwap({
  clientRef,
  sceneRef,
  sources,
  maps,
  clearPreview,
  runFit,
  runDeviation,
  runThickness,
}: {
  clientRef: RefObject<MeshWorkerClient | null>
  sceneRef: RefObject<SceneManager | null>
  sources: RefObject<SourceFiles>
  maps: ScanMaps
  clearPreview: () => void
  runFit: (id: number, kind: ElementKind, seeds: number[], selection?: Uint32Array, regionsOnly?: boolean) => Promise<unknown>
  runDeviation: () => Promise<void>
  runThickness: () => Promise<void>
}) {
  /**
   * Load another version of the scan in place of the one the session holds.
   * `transform` is the alignment to put on the file as it is read — the one
   * the session holds, like every scan the session loads.
   */
  const swapScan = async (source: ScanSource, transform: Rigid | null): Promise<void> => {
    const client = clientRef.current!
    const buffer = await readSourceFile(source.file, source.name)
    // An edit is a mesh of its own, colourless; the scan before it, on
    // undo, comes back with whatever came with it.
    const companions = await scanCompanions(source.name, new Uint8Array(buffer), source.companions ?? [])
    const prepared = await client.prepareScan(
      source.name,
      buffer,
      creaseSetting(useStore.getState()),
      transform ?? undefined,
      source.units ?? 'mm', // units-ok: the file's own units, an id
      companions,
      source.scale ?? 1,
    )
    await commitSwap(prepared, source, transform)
  }

  /**
   * Put a point cloud from memory in place of the scan: `buffers` are in the
   * scaled file frame, in millimetres, and are handed over to the worker —
   * the caller writes `source.file` (a PLY of them, scale 1) first, the file
   * the project and the history read back. `transform` is the alignment put
   * on them as they are read, the one the session holds: what is shown is
   * the cloud moved by it. Answers which vertex of the scan each point
   * became, -1 where one was dropped: points without a usable normal go,
   * and exact duplicates are one vertex.
   */
  const swapScanBuffers = async (
    source: ScanSource,
    buffers: { positions: Float32Array; normals: Float32Array },
    transform: Rigid | null,
  ): Promise<Int32Array> => {
    const n = buffers.positions.length / 3
    const prepared = await clientRef.current!.prepareCloud(buffers.positions, buffers.normals, creaseSetting(useStore.getState()), transform ?? undefined)
    await commitSwap(prepared, source, transform)
    return prepared.mesh.vertexMap ?? Int32Array.from({ length: n }, (_, i) => i)
  }

  /** The prepared scan made the session's: shared by both swaps. */
  const commitSwap = async (prepared: { id: number; mesh: LoadedScan }, source: ScanSource, _transform: Rigid | null): Promise<void> => {
    const client = clientRef.current!
    const { id, mesh } = prepared
    try {
      await client.commitImport({ scan: id })
    } catch (e) {
      await client.discardImport([id])
      throw e
    }
    // The old version is still in the scene: the last moment anything can
    // be read off it.
    scanSwapping()
    sources.current.scan = source
    clearPreview()
    maps.deviation.current = null
    maps.deviationRgb.current = null
    maps.referenceMap.current = null
    maps.referenceRgb.current = null
    useDeviation.getState().clearReferenceMap()
    maps.elementField.current = null
    maps.elementRgb.current = null
    maps.thickness.current = null
    maps.thicknessRgb.current = null
    forgetAllSurfaces()
    useMark.getState().reset()
    // Without a viewport the part's size is read off the mesh, as an open
    // reads it.
    const scene = sceneRef.current
    scene?.replaceScan(mesh.positions, mesh.indices, mesh.normals, mesh.wireSlots, mesh.copyOf, mesh.colors ?? null, cloudOf(mesh))
    const bounds = scene ? null : boundsOf(mesh.positions, mesh.vertexCount)
    useStore.setState((s) => ({
      scanColors: Boolean(mesh.colors),
      scanIsCloud: mesh.kind === 'cloud',
      vertexCount: mesh.vertexCount,
      triangleCount: mesh.triangleCount,
      modelSize: scene?.modelSize() ?? bounds!.radius,
      modelCenter: scene?.modelCenter() ?? bounds!.center,
      // Every cut is taken again — see sectionCuts: a plane through a piece
      // that has gone cut it too.
      sections: s.sections.map((sec) => ({ ...sec, cut: undefined, cutKey: undefined })),
    }))
    // The reference map is measured again by whoever swapped; the element
    // map follows the scope's version on its own.
    useDeviation.setState((s) => ({
      mapStatus: 'idle',
      stats: null,
      histogram: null,
      mapVersion: s.mapVersion + 1,
      scopeVersion: s.scopeVersion + 1,
    }))
    scanSwapped()
  }

  /**
   * Measure everything on the scan again, after a swap: the elements' fits
   * — as they are, onto their surfaces on the new vertices, or from their
   * recipes on the new scan when `refit` — then the maps that were on hand,
   * then whatever the listeners measured on it.
   */
  const remeasureScan = async (refit: boolean): Promise<void> => {
    await Promise.all(
      useStore
        .getState()
        .elements.map((el) =>
          el.source.type === 'fitted'
            ? runFit(el.id, el.kind, el.source.seeds, el.source.selection, !refit)
            : Promise.resolve(),
        ),
    )
    if (useDeviation.getState().align) await runDeviation()
    if (useThickness.getState().status === 'ready') await runThickness()
    await scanRemeasure()
  }

  /** Everything marked on the scan by vertex, renumbered onto the version
   *  just put in place — the vertices that went, left out. */
  const remapScan = (vertexMap: Int32Array) => {
    const remap = (ids: Uint32Array) => remapVertices(ids, vertexMap)
    useStore.setState((s) => {
      const discarded = s.discarded?.selection ? remap(s.discarded.selection) : null
      return {
        elements: s.elements.map((el) =>
          el.source.type === 'fitted' && el.source.selection
            ? { ...el, source: { ...el.source, selection: remap(el.source.selection) } }
            : el,
        ),
        // A discarded marking is kept only while it holds something.
        ...(discarded ? { discarded: discarded.length > 0 ? { ...s.discarded!, selection: discarded } : null } : {}),
      }
    })
    if (maps.elementScope.current) {
      const scope = remap(maps.elementScope.current)
      maps.elementScope.current = scope
      useDeviation.setState({ scopeCount: scope.length })
    }
    scanRemapped(remap)
  }

  return { swapScan, swapScanBuffers, remeasureScan, remapScan }
}

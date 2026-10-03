// SPDX-License-Identifier: AGPL-3.0-only
import { meshUnitsOf } from '../core/meshUnits'
// Saving the session as a project and opening one: the data half is in
// ./project, the archive in core/project. What is left here is the order
// things have to happen in on load — scan, its alignment, reference, image,
// then the stores, then everything that is measured rather than stored.

import { useRef, type RefObject } from 'react'
import type { ElementKind } from '../core/types'
import type { MeshWorkerClient } from '../core/workerClient'
import type { SceneManager } from '../viewer/SceneManager'
import { useStore } from '../state/store'
import { creaseSetting } from '../core/geometry/crease'
import { useDeviation } from '../state/deviationStore'
import { useThickness } from '../state/thicknessStore'
import { useFlat } from '../state/flatStore'
import { keepUnownedParts, projectSections } from './projectSections'
import { ProjectClient } from '../core/project/projectClient'
import { PROJECT_EXTENSION, projectStem, rigidFromJson } from '../core/project/manifest'
import { saveFile } from './exports'
import {
  prepareProjectState,
  collectProject,
  projectHasContent,
  readAs,
  sessionIsDirty,
  type SourceFiles,
} from './project'
import { APP_VERSION } from '../version'
import { useRecovery } from './useRecovery'
import type { ImportQueue } from './importQueue'
import { prepareScan, prepareNominal, prepareImage, runImport, type PreparedScan, type PreparedNominal, type PreparedImage } from './imports'

export const isProjectFile = (name: string) =>
  name.toLowerCase().endsWith(`.${PROJECT_EXTENSION}`)

export function useProject({
  sources,
  clientRef,
  sceneRef,
  elementScope,
  imports,
  commitScan,
  commitNominal,
  commitImage,
  runEdgeDetect,
  runFit,
  runDeviation,
  runThickness,
}: {
  sources: RefObject<SourceFiles>
  clientRef: RefObject<MeshWorkerClient | null>
  sceneRef: RefObject<SceneManager | null>
  elementScope: RefObject<Uint32Array | null>
  imports: ImportQueue
  commitScan: (scan: PreparedScan | null) => void
  commitNominal: (nominal: PreparedNominal | null) => void
  commitImage: (image: PreparedImage | null) => void
  runEdgeDetect: () => Promise<void>
  runFit: (id: number, kind: ElementKind, seeds: number[], selection?: Uint32Array) => Promise<void>
  runDeviation: () => Promise<void>
  runThickness: () => Promise<void>
}) {
  const projectClient = useRef<ProjectClient | null>(null)
  const client = () => (projectClient.current ??= new ProjectClient())
  const capture = () => collectProject(sources.current, elementScope.current, APP_VERSION)
  const recovery = useRecovery(capture, () => imports.busy || useStore.getState().busy, (file) => openProject(file, true))

  const saveProject = () => imports.run(async () => {
    const store = useStore.getState()
    if (!projectHasContent(sources.current)) return
    store.setError(null)
    useStore.setState({ busy: true, statusText: 'Saving project…' })
    try {
      const snapshot = capture()
      const { manifest, members } = snapshot
      const bytes = await client().pack(manifest, members)
      const stem = projectStem(store.fileName, useFlat.getState().imageName)
      saveFile(`${stem}.${PROJECT_EXTENSION}`, new Blob([bytes as BlobPart], { type: 'application/zip' }))
      recovery.markSaved(snapshot)
      useStore.setState({
        busy: false,
        statusText: `Project saved — ${(bytes.byteLength / 1e6).toFixed(1)} MB.`,
      })
    } catch (e) {
      if (projectClient.current?.dead) projectClient.current = null
      useStore.setState({ busy: false, statusText: '' })
      store.setError(`The project could not be saved — ${e instanceof Error ? e.message : String(e)}`)
    }
  })

  const openProject = (file: File, recovered = false) => runImport(imports, 'Reading project…', async () => {
    const meshClient = clientRef.current!
    let scan: PreparedScan | null = null
    let nominal: PreparedNominal | null = null
    let image: PreparedImage | null = null
    let committed = false
    try {
      const { manifest, members } = await client().unpack(new Uint8Array(await file.arrayBuffer()))
      const applyState = prepareProjectState(manifest, members)
      const memberFile = (member: string, name: string) => {
        const bytes = members.get(member)
        if (!bytes) throw new Error(`Project is missing ${member}.`)
        return new File([bytes as BlobPart], name)
      }
      // Check every referenced member before allocating candidate geometry.
      const scanFile = manifest.scan && memberFile(manifest.scan.member, readAs(manifest.scan.fileName, manifest.scan.member))
      const ref = manifest.deviation.reference
      const nominalFile = ref && memberFile(ref.member, ref.fileName)
      const img = manifest.flat.image
      const imageFile = img && memberFile(img.member, img.fileName)
      const alignment = manifest.scan?.appliedAlignment ? rigidFromJson(manifest.scan.appliedAlignment) : null
      if (alignment && (alignment.r.length !== 9 || alignment.t.length !== 3 || ![...alignment.r, ...alignment.t].every(Number.isFinite))) {
        throw new Error('Malformed project: scan alignment.')
      }
      const scope = manifest.deviation.scope ? Uint32Array.from(manifest.deviation.scope) : null
      // Preparation never changes stores, original bytes, the viewport, or
      // the worker's current scan/reference. Any member may still fail here.
      // A member saved in other units is read in millimetres from them again,
      // the way it was when it came in; the manifest checked the value.
      if (scanFile) scan = await prepareScan(meshClient, sceneRef.current!, scanFile, creaseSetting(useStore.getState()), alignment ?? undefined, meshUnitsOf(manifest.scan?.units) ?? 'mm')
      if (nominalFile) nominal = await prepareNominal(meshClient, sceneRef.current!, nominalFile, meshUnitsOf(ref?.units) ?? 'mm')
      if (imageFile) image = await prepareImage(imageFile)

      await meshClient.commitImport({ scan: scan?.id ?? null, nominal: nominal?.id ?? null })
      commitScan(scan)
      commitNominal(nominal)
      commitImage(image)
      committed = true
      // The scan keeps the name it was opened under, whatever the file it
      // is now kept as.
      useStore.setState({ appliedAlignment: alignment, ...(manifest.scan ? { fileName: manifest.scan.fileName } : {}) })
      elementScope.current = scope
      applyState()
      useDeviation.setState((s) => ({ scopeVersion: s.scopeVersion + 1 }))
      // What of the project no section here owns is kept, to be written back.
      const unowned = keepUnownedParts(manifest, members)
      void runEdgeDetect()

      // What the sections keep in the archive's own files, back in place —
      // before anything is measured, which may be measured on it.
      const present = projectSections().filter((s) => manifest[s.key] !== undefined)
      for (const section of present) await section.restore?.(manifest[section.key], { manifest, members })

      // ---- everything measured rather than stored ----
      const jobs: Promise<void>[] = []
      for (const el of useStore.getState().elements) {
        if (el.source.type !== 'fitted') continue
        jobs.push(runFit(el.id, el.kind, el.source.seeds, el.source.selection))
      }
      await Promise.all(jobs)
      if (manifest.scan && manifest.deviation.align && useDeviation.getState().nominalName) {
        await runDeviation()
      }
      if (manifest.scan && manifest.thickness.measured) await runThickness()
      for (const section of present) await section.remeasure?.(manifest[section.key], { manifest, members })
      useThickness.setState({ probes: manifest.thickness.probes })
      useDeviation.setState({ probes: manifest.deviation.probes })

      sceneRef.current?.frameAll()
      useStore.setState({
        busy: false,
        statusText: `Project opened — ${file.name}.${unowned.length > 0 ? ' It also holds work this build has no workspace for; that is kept, and saved with the project.' : ''}`,
      })
      if (recovered) recovery.restored()
      else recovery.markSaved(capture())
    } catch (e) {
      if (projectClient.current?.dead) projectClient.current = null
      throw e
    } finally {
      scan?.view.dispose()
      nominal?.view.dispose()
      if (!committed) image?.bitmap.close()
      await meshClient.discardImport([scan?.id, nominal?.id].filter((id): id is number => id !== undefined))
    }
  }, () => !sessionIsDirty() || window.confirm('Opening a project replaces the measurements in this session. Continue?'))

  return { saveProject, openProject, recovery }
}

// SPDX-License-Identifier: AGPL-3.0-only
// Saving the session as a project and opening one: the data half is in
// ./project, the archive in core/project. What is left here is the order
// things have to happen in on load — scan, its alignment, reference, image,
// then the stores, then everything that is measured rather than stored.

import { useRef, type RefObject } from 'react'
import type { ElementKind } from '../core/types'
import type { MeshWorkerClient } from '../core/workerClient'
import type { SceneManager } from '../viewer/SceneManager'
import { useStore } from '../state/store'
import { useDeviation } from '../state/deviationStore'
import { useThickness } from '../state/thicknessStore'
import { useFlat } from '../state/flatStore'
import { ProjectClient } from '../core/project/projectClient'
import { PROJECT_EXTENSION, projectStem, rigidFromJson } from '../core/project/manifest'
import { saveFile } from './exports'
import {
  applyDeviationPart,
  applyFlatPart,
  applyScanPart,
  applyThicknessPart,
  applyWorkspace,
  collectProject,
  sessionIsDirty,
  type SourceFiles,
} from './project'

export const isProjectFile = (name: string) =>
  name.toLowerCase().endsWith(`.${PROJECT_EXTENSION}`)

const APP_VERSION = '0.1.0'

export function useProject({
  sources,
  clientRef,
  sceneRef,
  elementScope,
  openFile,
  openNominal,
  openImage,
  runFit,
  runDeviation,
  runThickness,
}: {
  sources: RefObject<SourceFiles>
  clientRef: RefObject<MeshWorkerClient | null>
  sceneRef: RefObject<SceneManager | null>
  elementScope: RefObject<Uint32Array | null>
  openFile: (file: File) => Promise<void>
  openNominal: (file: File) => Promise<void>
  openImage: (file: File) => Promise<void>
  runFit: (id: number, kind: ElementKind, seeds: number[], selection?: Uint32Array) => Promise<void>
  runDeviation: () => Promise<void>
  runThickness: () => Promise<void>
}) {
  const projectClient = useRef<ProjectClient | null>(null)
  const client = () => (projectClient.current ??= new ProjectClient())

  const saveProject = async () => {
    const store = useStore.getState()
    if (!sources.current.scan && !sources.current.image) return
    store.setError(null)
    useStore.setState({ busy: true, statusText: 'Saving project…' })
    try {
      const { manifest, members } = collectProject(sources.current, elementScope.current, APP_VERSION)
      const bytes = await client().pack(manifest, members)
      const stem = projectStem(store.fileName, useFlat.getState().imageName)
      saveFile(`${stem}.${PROJECT_EXTENSION}`, new Blob([bytes as BlobPart], { type: 'application/zip' }))
      useStore.setState({
        busy: false,
        statusText: `Project saved — ${(bytes.byteLength / 1e6).toFixed(1)} MB.`,
      })
    } catch (e) {
      useStore.setState({ busy: false, statusText: '' })
      store.setError(e instanceof Error ? e.message : String(e))
    }
  }

  const openProject = async (file: File) => {
    if (
      sessionIsDirty() &&
      !window.confirm('Opening a project replaces the measurements in this session. Continue?')
    )
      return
    useStore.getState().setError(null)
    useStore.setState({ busy: true, statusText: 'Reading project…' })
    try {
      const { manifest, members } = await client().unpack(new Uint8Array(await file.arrayBuffer()))
      const memberFile = (member: string, name: string) => {
        const bytes = members.get(member)
        if (!bytes) throw new Error(`Project is missing ${member}.`)
        return new File([bytes as BlobPart], name)
      }

      // ---- the scan, then the datum alignment it was measured under ----
      if (manifest.scan) {
        await openFile(memberFile(manifest.scan.member, manifest.scan.fileName))
        if (useStore.getState().errorText) throw new Error(useStore.getState().errorText!)
        const m = manifest.scan.appliedAlignment
        if (m) {
          const rigid = rigidFromJson(m)
          await clientRef.current!.transform(rigid)
          sceneRef.current?.applyTransform(rigid)
          // With no elements yet, this only books the transform and moves the
          // model centre along.
          useStore.getState().applyAlignment(rigid)
        }
        applyScanPart(manifest.scan)
      } else {
        useStore.getState().beginLoad(useStore.getState().fileName ?? '')
        useStore.setState({ busy: true, statusText: 'Reading project…' })
      }

      // ---- the reference part ----
      if (manifest.deviation.reference && manifest.scan) {
        const ref = manifest.deviation.reference
        await openNominal(memberFile(ref.member, ref.fileName))
        if (useStore.getState().errorText) throw new Error(useStore.getState().errorText!)
      }
      applyDeviationPart(manifest.deviation)
      elementScope.current = manifest.deviation.scope
        ? Uint32Array.from(manifest.deviation.scope)
        : null
      useDeviation.setState((s) => ({ scopeVersion: s.scopeVersion + 1 }))

      applyThicknessPart(manifest.thickness)

      // ---- the flatbed image ----
      if (manifest.flat.image) {
        const img = manifest.flat.image
        await openImage(memberFile(img.member, img.fileName))
      }
      applyFlatPart(manifest.flat)
      applyWorkspace(manifest.workspace)

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
      useThickness.setState({ probes: manifest.thickness.probes })
      useDeviation.setState({ probes: manifest.deviation.probes })

      sceneRef.current?.frameAll()
      useStore.setState({ busy: false, statusText: `Project opened — ${file.name}.` })
    } catch (e) {
      useStore.setState({ busy: false, statusText: '' })
      useStore.getState().setError(e instanceof Error ? e.message : String(e))
    }
  }

  return { saveProject, openProject }
}

// SPDX-License-Identifier: AGPL-3.0-only
import type { MeshWorkerClient, LoadedScan, LoadedNominal } from '../core/workerClient'
import type { CreaseMode } from '../core/geometry/crease'
import type { Rigid } from '../core/deviation/rigid'
import type { SceneManager } from '../viewer/SceneManager'
import { grayscaleOf } from '../core/flat/edgeClient'
import { imagePixelsPerMm } from '../core/flat/image'
import { isMeshFile, isReferenceFile, isStepFile } from '../core/formats'
import type { MeshUnits } from '../core/meshUnits'
import { useStore } from '../state/store'
import { ImportQueue, type PreparedView } from './importQueue'
import type { SourceFiles } from './project'

export interface PreparedScan {
  id: number
  mesh: LoadedScan
  source: NonNullable<SourceFiles['scan']>
  view: PreparedView
}
export interface PreparedNominal {
  id: number
  mesh: LoadedNominal
  source: NonNullable<SourceFiles['reference']>
  view: PreparedView
}
export interface PreparedImage {
  source: NonNullable<SourceFiles['image']>
  bitmap: ImageBitmap
  gray: ReturnType<typeof grayscaleOf>
  meta: ReturnType<typeof imagePixelsPerMm>
}

/** Busy/error reporting belongs to the whole import, not its individual
 * members. Failures preserve the session and its previous status message. */
export function runImport(
  queue: ImportQueue,
  statusText: string,
  job: () => Promise<void>,
  shouldStart: () => boolean = () => true,
): Promise<void> {
  return queue.run(async () => {
    if (!shouldStart()) return
    const previousStatus = useStore.getState().statusText
    useStore.setState({ busy: true, errorText: null, statusText })
    try {
      await job()
    } catch (e) {
      useStore.setState({ statusText: previousStatus, errorText: e instanceof Error ? e.message : String(e) })
    } finally {
      useStore.setState({ busy: false })
    }
  })
}

/** `units` is what the file's coordinates are in; the worker reads it in
 *  millimetres, and the source remembers the units so a project or a worker
 *  restart reads the same bytes the same way. */
export async function prepareScan(client: MeshWorkerClient, scene: SceneManager, file: File, crease: CreaseMode, transform?: Rigid, units: MeshUnits = 'mm'): Promise<PreparedScan> {
  if (!isMeshFile(file.name)) throw new Error(isStepFile(file.name)
    ? 'A STEP file is CAD, not a scan — load it as the reference in the Deviation workspace.'
    : 'Unsupported file type — use STL, PLY, or OBJ.')
  const buffer = await file.arrayBuffer()
  const source = { name: file.name, bytes: new Uint8Array(buffer.slice(0)), units }
  const { id, mesh } = await client.prepareScan(file.name, buffer, crease, transform, units)
  try {
    const view = scene.prepareMesh(mesh.positions, mesh.indices, mesh.normals, mesh.wireSlots, mesh.copyOf)
    return { id, mesh, source, view }
  } catch (e) {
    await client.discardImport([id])
    throw e
  }
}

export async function prepareNominal(client: MeshWorkerClient, scene: SceneManager, file: File, units: MeshUnits = 'mm'): Promise<PreparedNominal> {
  if (!isReferenceFile(file.name)) throw new Error('Unsupported file type — use STL, PLY, OBJ, or STEP.')
  const buffer = await file.arrayBuffer()
  const source = { name: file.name, bytes: new Uint8Array(buffer.slice(0)), units }
  const { id, mesh } = await client.prepareNominal(file.name, buffer, units)
  try {
    const view = scene.prepareNominal(mesh.positions, mesh.indices, mesh.normals, mesh.wireSlots)
    return { id, mesh, source, view }
  } catch (e) {
    await client.discardImport([id])
    throw e
  }
}

export async function prepareImage(file: File): Promise<PreparedImage> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const meta = imagePixelsPerMm(bytes)
  const bitmap = await createImageBitmap(file, { imageOrientation: 'flipY' })
  try {
    return { source: { name: file.name, bytes }, bitmap, gray: grayscaleOf(bitmap), meta }
  } catch (e) {
    bitmap.close()
    throw e
  }
}

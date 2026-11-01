// SPDX-License-Identifier: AGPL-3.0-only
// Reading a file in, short of putting it in place: the scan or the reference
// handed to the worker and built for the viewport, the image decoded, each
// held as prepared until its import commits it. A project prepares all its
// members before committing any, so one that fails leaves the session as it
// was; and busy and errors are reported for the import as a whole
// (runImport), not member by member.

import type { MeshWorkerClient, LoadedScan, LoadedNominal } from '../core/workerClient'
import type { CreaseSetting } from '../core/geometry/crease'
import type { Rigid } from '../core/deviation/rigid'
import type { SceneManager } from '../viewer/SceneManager'
import { grayscaleOf } from '../core/flat/edgeClient'
import { assertImageDecodable, imagePixelsPerMm } from '../core/flat/image'
import { is3mfFile, isModelFile, isReferenceFile, isTextureFile } from '../core/formats'
import type { MeshUnits } from '../core/meshUnits'
import { useStore } from '../state/store'
import { ImportQueue, type PreparedView } from './importQueue'
import type { SourceFiles } from './project'
import { companionBytes, companionsOf, scanCompanions } from './scanFiles'

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
 *  members. Failures preserve the session and its previous status message. */
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

/** What a model prepared without a viewport puts on screen: nothing. */
const NO_VIEW: PreparedView = { commit() {}, dispose() {} }

/** `given` is what the file's coordinates are in; the worker reads it in
 *  millimetres, and the source remembers the units so a project or a worker
 *  restart reads the same bytes the same way. A 3MF says its own units, and
 *  the worker reads them there, so it is taken as it is whatever `given`
 *  says. The files that came with a textured OBJ (see scanFiles) are kept
 *  in the source beside it, and the part wears the colours they give it —
 *  or that a 3MF's packed images give it. Without a viewport — a test, a
 *  headless run — the model goes to the worker alone. */
export async function prepareScan(client: MeshWorkerClient, scene: SceneManager | null, file: File, crease: CreaseSetting, transform?: Rigid, given: MeshUnits = 'mm'): Promise<PreparedScan> {
  if (!isModelFile(file.name)) throw new Error(isTextureFile(file.name)
    ? `${file.name} is part of a textured scan — open it together with its OBJ (pick or drop the OBJ, the .mtl and the image at once, or drop their folder).`
    : 'Unsupported file type — use STL, PLY, OBJ, 3MF or STEP.')
  const units = is3mfFile(file.name) ? 'mm' : given // units-ok: a 3MF file is in millimetres, a MeshUnits id
  const buffer = await file.arrayBuffer()
  const extras = await companionBytes(companionsOf(file))
  const source = { name: file.name, bytes: new Uint8Array(buffer.slice(0)), units, ...(extras.length > 0 ? { companions: extras } : {}) }
  const { id, mesh } = await client.prepareScan(file.name, buffer, crease, transform, units, await scanCompanions(file.name, source.bytes, extras))
  try {
    const view = scene ? scene.prepareMesh(mesh.positions, mesh.indices, mesh.normals, mesh.wireSlots, mesh.copyOf, mesh.colors ?? null) : NO_VIEW
    return { id, mesh, source, view }
  } catch (e) {
    await client.discardImport([id])
    throw e
  }
}

export async function prepareNominal(client: MeshWorkerClient, scene: SceneManager | null, file: File, given: MeshUnits = 'mm'): Promise<PreparedNominal> {
  if (!isReferenceFile(file.name)) throw new Error('Unsupported file type — use STL, PLY, OBJ, 3MF or STEP.')
  const units = is3mfFile(file.name) ? 'mm' : given // units-ok: a 3MF file is in millimetres, a MeshUnits id
  const buffer = await file.arrayBuffer()
  const source = { name: file.name, bytes: new Uint8Array(buffer.slice(0)), units }
  const { id, mesh } = await client.prepareNominal(file.name, buffer, units)
  try {
    const view = scene ? scene.prepareNominal(mesh.positions, mesh.indices, mesh.normals, mesh.wireSlots) : NO_VIEW
    return { id, mesh, source, view }
  } catch (e) {
    await client.discardImport([id])
    throw e
  }
}

export async function prepareImage(file: File): Promise<PreparedImage> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  assertImageDecodable(file.name, bytes)
  const meta = imagePixelsPerMm(bytes)
  const bitmap = await createImageBitmap(file, { imageOrientation: 'flipY' })
  try {
    return { source: { name: file.name, bytes }, bitmap, gray: grayscaleOf(bitmap), meta }
  } catch (e) {
    bitmap.close()
    throw e
  }
}

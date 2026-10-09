// SPDX-License-Identifier: AGPL-3.0-only
// The ways measurements leave the tool as geometry: the created elements as
// analytic STEP, and the scan itself as an STL or a point cloud in the pose
// it is shown in.
import type { RefObject } from 'react'
import { drawnFit } from '../core/elements/assumed'
import type { StepSection } from '../core/exportStep'
import { buildBinaryStl } from '../core/exportStl'
import type { CloudFormat } from '../core/exportPointCloud'
import { computeVertexNormals } from '../core/geometry/normals'
import { liftFlatFit } from '../core/section/lift'
import { useStore } from '../state/store'
import { useDeviation } from '../state/deviationStore'
import { sectionElementsOf, useFlat } from '../state/flatStore'
import type { SceneManager } from '../viewer/SceneManager'

/** Hand a built file to the browser. The link goes into the document for the
 *  length of the click — WebKit ignores `download` on an anchor that was never
 *  in the page — and the object URL outlives it by long enough for the
 *  download to start, then goes. */
export const saveFile = (name: string, blob: Blob) => {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** The scan's name without its extension — the stem every export is built
 *  on. */
export const exportStem = () => (useStore.getState().fileName ?? 'scan').replace(/\.[^.]+$/, '')

/** Lazy export modules can fail to load (for example after a deployment).
 * Keep the session usable and report the failure through the normal UI. */
export async function runExport(job: () => Promise<void>): Promise<void> {
  try { await job() }
  catch (error) {
    useStore.getState().setError(`Export failed — ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Every section with something measured on its sheet, the elements stood
 *  up in the part under the section's name — what the STEP export writes
 *  beside the 3D elements. Hidden ones come too, as hidden 3D elements do:
 *  hiding is a way of looking, not a way of unmeasuring. */
export const sectionStepGroups = (): StepSection[] => {
  const flat = useFlat.getState()
  return useStore
    .getState()
    .sections.map((sec) => ({
      name: sec.name,
      elements: sectionElementsOf(flat, sec.id)
        .filter((el) => el.fit)
        .map((el) => ({ name: el.name, fit: liftFlatFit(sec.frame, el.fit!) })),
    }))
    .filter((group) => group.elements.length > 0)
}

/** A file an export built, before anyone saves it: what the panel's button
 *  hands the browser to download, and what a command hands back as bytes. */
export interface BuiltFile {
  name: string
  mimeType: string
  bytes: Uint8Array
  /** What the status line says once it is out. */
  status: string
}

export const textBytes = (text: string) => new TextEncoder().encode(text)

/** Save a built file the way every export button does, and say so. */
export const saveBuilt = (file: BuiltFile | null) => {
  if (!file) return
  saveFile(file.name, new Blob([file.bytes as BlobPart], { type: file.mimeType }))
  useStore.getState().setStatus(file.status)
}

/** The created elements as analytic STEP geometry — and with them, in a
 *  group per section, what was measured on the sections. Null with nothing
 *  to export. */
export async function buildElementsStep(): Promise<BuiltFile | null> {
  const store = useStore.getState()
  const els = store.elements.filter((e) => e.fit)
  const groups = sectionStepGroups()
  const onSections = groups.reduce((n, g) => n + g.elements.length, 0)
  if (els.length === 0 && onSections === 0) return null
  const assumed = els.filter((e) => e.assumed !== undefined).length
  const name = `${exportStem()}-elements.step`
  const { buildStepFile } = await import('../core/exportStep')
  const text = buildStepFile(
    // What is exported is what is on screen, extensions and all — with the
    // assumed diameter swapped in wherever the user gave one.
    els.map((e) => ({
      name: e.name,
      fit: drawnFit(e.fit!, e.assumed, e.extend),
    })),
    store.fileName ?? 'scan',
    new Date().toISOString().slice(0, 19),
    store.stepStyle,
    groups,
  )
  const what: string[] = []
  if (els.length) what.push(`${els.length} element${els.length === 1 ? '' : 's'}`)
  if (onSections) {
    const where = groups.length === 1 ? groups[0].name : `${groups.length} sections`
    what.push(`${onSections} on ${where}`)
  }
  return {
    name,
    mimeType: 'model/step',
    bytes: textBytes(text),
    status: `${what.join(' and ')} exported to ${name} as ${
      store.stepStyle === 'solids' ? 'solids and faces' : 'construction surfaces'
    }${assumed ? ` — ${assumed} at ${assumed === 1 ? 'its' : 'their'} assumed Ø` : ''}.`,
  }
}

/** Hand the created elements over as analytic STEP geometry. */
export const exportElementsStep = () => runExport(async () => saveBuilt(await buildElementsStep()))

/** The scan as an STL in the pose it is being shown in. Null with no scan
 *  on the viewport.
 *
 *  A 3-2-1 or typed-in alignment is already baked into the vertices, so it
 *  comes along for free. The deviation workspace's best fit is not: it rides
 *  on the scan's group matrix so the fit can be watched and undone, and it
 *  has to be applied on the way out. Either way what lands on disk is the
 *  part where the user can see it. */
export function buildScanStl(scene: SceneManager | null): BuiltFile | null {
  const store = useStore.getState()
  const geometry = scene?.scanGeometry()
  if (!geometry || !store.fileName) return null
  const positions = geometry.getAttribute('position')?.array as Float32Array | undefined
  if (!positions) return null
  const index = geometry.getIndex()?.array as Uint32Array | Uint16Array | undefined
  const align = useDeviation.getState().align
  const moved = align !== null || store.appliedAlignment !== null
  const stem = exportStem()
  // Never the name it came in under, however little has happened to it: the
  // export lands in the same folder the scan was picked from, and silently
  // shadowing the original there is not a thing a measuring tool should do.
  const name = `${stem}-${moved ? 'aligned' : 'export'}.stl`
  const buffer = buildBinaryStl(
    positions,
    index ?? null,
    align?.transform ?? null,
    `ScanRuler scan export - ${stem}`,
  )
  const triangles = (index ? index.length : positions.length / 3) / 3
  return {
    name,
    mimeType: 'model/stl',
    bytes: new Uint8Array(buffer),
    status: `Scan exported to ${name} — ${triangles.toLocaleString('en-US')} triangles${
      moved ? ', in its aligned position' : ''
    }.`,
  }
}

/** Hand the scan back as an STL in the pose it is being shown in. */
export const exportScanStl = (sceneRef: RefObject<SceneManager | null>) => saveBuilt(buildScanStl(sceneRef.current))

/** The scan as a point cloud — every vertex with its normal, in the pose it
 *  is being shown in, as a binary PLY or an XYZ text file — for the
 *  reverse-engineering tools that model over points rather than triangles.
 *  The pose comes along the way it does for the STL: a datum alignment is in
 *  the vertices already, the deviation best fit is applied on the way out.
 *  The normals are the scan's own, oriented out of the part when it was
 *  loaded. Null with no scan on the viewport. */
export async function buildScanPointCloud(scene: SceneManager | null, format: CloudFormat): Promise<BuiltFile | null> {
  const { buildPointCloudPly, buildPointCloudXyz } = await import('../core/exportPointCloud')
  // Geometry can be transformed in place; read it and its alignment together
  // after loading the writer, with no async gap before serialization.
  const store = useStore.getState()
  const geometry = scene?.scanGeometry()
  if (!scene || !geometry || !store.fileName) return null
  const drawn = geometry.getAttribute('position')?.array as Float32Array | undefined
  if (!drawn) return null
  const index = geometry.getIndex()?.array as Uint32Array | Uint16Array | undefined
  const onMesh = geometry.getAttribute('normal')?.array as Float32Array | undefined
  const drawnNormals =
    onMesh ??
    (index ? computeVertexNormals(drawn, index instanceof Uint32Array ? index : Uint32Array.from(index)) : null)
  // The scan's own vertices only: past them the render arrays carry the
  // copies its sharp edges were split into for shading (see
  // core/geometry/crease.ts), and a cloud wants each point once.
  const own = scene.scanVertexCount() * 3
  const positions = drawn.subarray(0, own)
  const normals = drawnNormals ? drawnNormals.subarray(0, own) : null
  const align = useDeviation.getState().align
  const moved = align !== null || store.appliedAlignment !== null
  const stem = exportStem()
  const name = `${stem}-${moved ? 'aligned' : 'export'}.${format}`
  const transform = align?.transform ?? null
  const bytes =
    format === 'ply'
      ? new Uint8Array(buildPointCloudPly(positions, normals, transform, `ScanRuler point cloud - ${stem}`))
      : textBytes(buildPointCloudXyz(positions, normals, transform))
  const points = positions.length / 3
  return {
    name,
    mimeType: format === 'ply' ? 'application/octet-stream' : 'text/plain',
    bytes,
    status: `Point cloud exported to ${name} — ${points.toLocaleString('en-US')} points${
      normals ? ' with normals' : ''
    }${moved ? ', in its aligned position' : ''}.`,
  }
}

/** Hand the scan back as a point cloud. */
export const exportScanPointCloud = (sceneRef: RefObject<SceneManager | null>, format: CloudFormat) =>
  runExport(async () => saveBuilt(await buildScanPointCloud(sceneRef.current, format)))

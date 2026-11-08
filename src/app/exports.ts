// SPDX-License-Identifier: AGPL-3.0-only
// The ways measurements leave the tool as geometry: the created elements as
// analytic STEP, and the scan itself as a mesh (STL or 3MF) or a point cloud
// in the pose it is shown in.
import type { RefObject } from 'react'
import { drawnFit } from '../core/elements/assumed'
import type { StepSection } from '../core/exportStep'
import { buildMeshFile, type MeshFormat } from '../core/exportMesh'
import type { CloudFormat } from '../core/exportPointCloud'
import { computeVertexNormals } from '../core/geometry/normals'
import { liftFlatFit } from '../core/section/lift'
import { shadowRegions } from '../core/section/shadow'
import type { PrismInput } from '../core/stepBrep'
import { fileSafe } from '../core/project/manifest'
import { isExtruded } from '../state/sectionModel'
import { useStore, type Section } from '../state/store'
import { useDeviation } from '../state/deviationStore'
import { sectionElementsOf, useFlat } from '../state/flatStore'
import { useSupportAsk } from '../state/supportAskStore'
import { useTaskActivity } from '../state/taskActivity'
import type { SceneManager } from '../viewer/SceneManager'

/** Hand a built file to the browser. The link goes into the document for the
 *  length of the click — WebKit ignores `download` on an anchor that was never
 *  in the page — and the object URL outlives it by long enough for the
 *  download to start, then goes. The support card is asked for after the
 *  click, so the file never waits on it. */
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
  useSupportAsk.getState().ask()
}

/** The stem every export is built on: the project's name, else the scan's
 *  without its extension, else `fallback`. */
export const exportStem = (fallback = 'scan'): string => {
  const s = useStore.getState()
  const named = s.projectName ? fileSafe(s.projectName) : ''
  return named !== '' ? named : s.fileName ? s.fileName.replace(/\.[^.]+$/, '') : fallback
}

/** Lazy export modules can fail to load (for example after a deployment).
 *  Keep the session usable and report the failure through the normal UI. */
export async function runExport(job: () => Promise<void>): Promise<void> {
  const id = `export-${++nextExportId}`
  useTaskActivity.getState().setTask(id, { text: 'Preparing or saving export...', percent: null })
  try { await job() }
  catch (error) {
    useStore.getState().setError(`Export failed — ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    useTaskActivity.getState().setTask(id, null)
  }
}

let nextExportId = 0

/** Every section with something measured on its sheet, the elements stood
 *  up in the part under the section's name — what the STEP export writes
 *  beside the 3D elements — and every extruded shadow's blocks. Hidden ones
 *  come too, as hidden 3D elements do: hiding is a way of looking, not a
 *  way of unmeasuring. */
const sectionStepGroups = (): StepSection[] => {
  const flat = useFlat.getState()
  return useStore
    .getState()
    .sections.map((sec) => ({
      name: sec.name,
      elements: sectionElementsOf(flat, sec.id)
        .filter((el) => el.fit)
        .map((el) => ({ name: el.name, fit: liftFlatFit(sec.frame, el.fit!) })),
      prisms: sectionPrisms(sec),
    }))
    .filter((group) => group.elements.length > 0 || group.prisms.length > 0)
}

/** An extruded shadow as blocks, one per outer loop with its holes, standing
 *  through the part's thickness along the plane's normal. None for anything
 *  else. */
export function sectionPrisms(sec: Section): PrismInput[] {
  const sh = sec.cut?.shadow
  if (!isExtruded(sec) || !sh) return []
  return shadowRegions(sh).map(({ outer, holes }) => ({
    frame: sh.frame,
    outer: outer.pieces,
    holes: holes.map((h) => h.pieces),
    from: sh.extent.min,
    to: sh.extent.max,
  }))
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
  const blocks = groups.reduce((n, g) => n + (g.prisms?.length ?? 0), 0)
  if (els.length === 0 && onSections === 0 && (blocks === 0 || store.stepStyle !== 'solids')) return null
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
    const measured = groups.filter((g) => g.elements.length > 0)
    const where = measured.length === 1 ? measured[0].name : `${measured.length} sections`
    what.push(`${onSections} on ${where}`)
  }
  if (blocks && store.stepStyle === 'solids') what.push(`${blocks} extruded shadow${blocks === 1 ? '' : 's'}`)
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

/** The scan as a mesh file — an STL or a 3MF — in the pose it is being
 *  shown in. Null with no scan on the viewport.
 *
 *  A 3-2-1 or typed-in alignment is already baked into the vertices, so it
 *  comes along for free. The deviation workspace's best fit is not: it rides
 *  on the scan's group matrix so the fit can be watched and undone, and it
 *  has to be applied on the way out. Either way what lands on disk is the
 *  part where the user can see it. A 3MF keeps the scan's own colours, a
 *  textured scan's. */
export function buildScanMesh(scene: SceneManager | null, format: MeshFormat): BuiltFile | null {
  const store = useStore.getState()
  const geometry = scene?.scanGeometry()
  if (!geometry || !store.fileName) return null
  const positions = geometry.getAttribute('position')?.array as Float32Array | undefined
  if (!positions) return null
  const index = geometry.getIndex()?.array as Uint32Array | Uint16Array | undefined
  const colors = geometry.getAttribute('surface')?.array as Uint8Array | undefined
  const align = useDeviation.getState().align
  const moved = align !== null || store.appliedAlignment !== null
  const stem = exportStem()
  const file = buildMeshFile(
    format,
    [{ name: stem, positions, indices: index ?? null, colors: colors ?? null }],
    align?.transform ?? null,
    `ScanRuler scan export - ${stem}`,
  )
  if (!file) return null
  // Never the name it came in under, however little has happened to it: the
  // export lands in the same folder the scan was picked from, and silently
  // shadowing the original there is not a thing a measuring tool should do.
  const name = `${stem}-${moved ? 'aligned' : 'export'}.${file.extension}`
  return {
    name,
    mimeType: file.mimeType,
    bytes: file.bytes,
    status: `Scan exported to ${name} — ${file.triangles.toLocaleString('en-US')} triangles${
      moved ? ', in its aligned position' : ''
    }.`,
  }
}

/** Hand the scan back as a mesh file in the pose it is being shown in. */
export const exportScanMesh = (sceneRef: RefObject<SceneManager | null>, format: MeshFormat) =>
  runExport(async () => saveBuilt(buildScanMesh(sceneRef.current, format)))

/** The scan as a point cloud — every vertex with its normal, in the pose it
 *  is being shown in, as a binary PLY or an XYZ text file — for the
 *  reverse-engineering tools that model over points rather than triangles.
 *  The pose comes along the way it does for the mesh: a datum alignment is in
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
      : buildPointCloudXyz(positions, normals, transform)
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

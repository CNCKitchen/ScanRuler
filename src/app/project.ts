// SPDX-License-Identifier: AGPL-3.0-only
import type { MeshUnits } from '../core/meshUnits'
// Reading a project manifest off the stores and writing one back onto them.
// The orchestration around it — loading the model files, re-measuring the
// maps — lives in useProject; this is the plain data half, so it can be
// tested without a worker or a scene.

import { useStore } from '../state/store'
import { useDeviation } from '../state/deviationStore'
import { useThickness } from '../state/thicknessStore'
import { sheetKeyOf, sheetOf, useFlat, type FlatSubject, type SheetState } from '../state/flatStore'
import { CORE_WORKSPACES, useShell, type Workspace } from '../state/shellStore'
import { plugins } from '../plugins/registry'
import { keptParts, projectSections } from './projectSections'
import {
  alignFromJson,
  alignToJson,
  elementFromJson,
  elementToJson,
  extensionOf,
  IMAGE_STEM,
  PROJECT_APP,
  PROJECT_SCHEMA,
  REFERENCE_STEM,
  rigidToJson,
  SCAN_STEM,
  sectionFromJson,
  sectionToJson,
  type DeviationPart,
  type FlatPart,
  type ProjectManifest,
  type ScanPart,
  type ThicknessPart,
} from '../core/project/manifest'
import type { ArchiveMember } from '../core/project/archive'

/** The original bytes of every model the session holds, kept from the moment
 *  each was opened: the worker takes its copy by transfer and the scene keeps
 *  only geometry, so nothing else could write the file back out as it came.
 *  A scan swapped for an edited version of itself (app/useScanSwap) is kept
 *  as the file it now is: a PLY in millimetres, in the frame the original was
 *  opened in, so the applied alignment goes on it the same way — see
 *  core/mesh/plyWriter. */
export interface SourceFiles {
  /** `units` is what the bytes' coordinates are in — the mesh was read in
   *  millimetres from them, and is read the same way again from a project or
   *  after a worker restart. Absent means millimetres. */
  scan: { name: string; bytes: Uint8Array; units?: MeshUnits } | null
  reference: { name: string; bytes: Uint8Array; units?: MeshUnits } | null
  image: { name: string; bytes: Uint8Array } | null
}

export const emptySources = (): SourceFiles => ({ scan: null, reference: null, image: null })

/** The name a member is read under: the one it was saved with, carrying the
 *  member's own extension — an edited scan is a PLY, kept under the name of
 *  the STL it was opened as. */
export function readAs(fileName: string, member: string): string {
  const ext = extensionOf(member)
  return extensionOf(fileName) === ext ? fileName : `${fileName.replace(/\.[^.]+$/, '')}.${ext}`
}

/** True when the session holds work worth a warning before it is replaced. */
export function sessionIsDirty(): boolean {
  const s = useStore.getState()
  const f = useFlat.getState()
  const sheetHasWork = (sheet: SheetState) =>
    sheet.elements.length > 0 ||
    sheet.dimensions.length > 0 ||
    sheet.counts.length > 0 ||
    sheet.notes.length > 0
  return (
    s.elements.length > 0 ||
    s.dimensions.length > 0 ||
    s.sections.length > 0 ||
    sheetHasWork(f) ||
    Object.values(f.sheets).some(sheetHasWork) ||
    projectSections().some((p) => p.holdsWork?.())
  )
}

/** True when there is anything to save as a project: a scan, an image, or
 *  a plugin's work — or a part kept from the project opened last. */
export function projectHasContent(sources: SourceFiles): boolean {
  return (
    !!sources.scan ||
    !!sources.image ||
    projectSections().some((p) => p.holdsWork?.()) ||
    Object.keys(keptParts().parts).length > 0
  )
}

export function collectProject(
  sources: SourceFiles,
  scope: Uint32Array | null,
  appVersion: string,
): { manifest: ProjectManifest; members: ArchiveMember[] } {
  const s = useStore.getState()
  const dev = useDeviation.getState()
  const t = useThickness.getState()
  const f = useFlat.getState()
  const members: ArchiveMember[] = []

  let scan: ScanPart | null = null
  if (sources.scan && s.fileName) {
    const member = `${SCAN_STEM}.${extensionOf(sources.scan.name)}`
    members.push({ name: member, bytes: sources.scan.bytes })
    scan = {
      fileName: s.fileName,
      member,
      ...(sources.scan.units && sources.scan.units !== 'mm' ? { units: sources.scan.units } : {}),
      appliedAlignment: s.appliedAlignment ? rigidToJson(s.appliedAlignment) : null,
      elements: s.elements.map(elementToJson),
      dimensions: s.dimensions,
      nextId: s.nextId,
      nextNumber: s.nextNumber,
      nextOfKind: s.nextOfKind,
      nextDimensionId: s.nextDimensionId,
      nextOfDimGroup: s.nextOfDimGroup,
      settings: s.settings,
      selectMode: s.selectMode,
      // The file keeps the switch's old name: it used to put away every overlay
      // and now puts away the labels alone, which is the same choice as far as
      // a saved project is concerned.
      showOverlays: s.showLabels,
      showBackfaces: s.showBackfaces,
      sections: s.sections.map(sectionToJson),
      nextSectionNumber: s.nextSectionNumber,
    }
  }

  let reference: DeviationPart['reference'] = null
  if (sources.reference && dev.nominalName) {
    const member = `${REFERENCE_STEM}.${extensionOf(sources.reference.name)}`
    members.push({ name: member, bytes: sources.reference.bytes })
    reference = {
      fileName: dev.nominalName,
      member,
      ...(sources.reference.units && sources.reference.units !== 'mm' ? { units: sources.reference.units } : {}),
    }
  }
  const deviation: DeviationPart = {
    source: dev.source,
    reference,
    align: reference && dev.align ? alignToJson(dev.align) : null,
    globalAlign: reference && dev.globalAlign ? alignToJson(dev.globalAlign) : null,
    pairs: dev.pairs,
    localMaxDistance: dev.localMaxDistance,
    targetId: dev.targetId,
    targetSide: dev.targetSide,
    targetFacingDeg: dev.targetFacingDeg,
    targetScope: dev.targetScope,
    scope: scope ? Array.from(scope) : null,
    showElement: dev.showElement,
    range: dev.range,
    rangeAuto: dev.rangeAuto,
    maxDistance: dev.maxDistance,
    maxDistanceAuto: dev.maxDistanceAuto,
    bands: dev.bands,
    tolerance: dev.tolerance,
    showHistogram: dev.showHistogram,
    showNominal: dev.showNominal,
    showScan: dev.showScan,
    showMap: dev.showMap,
    split: dev.split,
    probes: dev.probes,
    nextProbeId: dev.nextProbeId,
  }

  const thickness: ThicknessPart = {
    measured: t.status === 'ready',
    method: t.method,
    maxThickness: t.maxThickness,
    maxThicknessAuto: t.maxThicknessAuto,
    coneRays: t.coneRays,
    coneAngleDeg: t.coneAngleDeg,
    normalDeviationDeg: t.normalDeviationDeg,
    low: t.low,
    high: t.high,
    scaleAuto: t.scaleAuto,
    bands: t.bands,
    limit: t.limit,
    showHistogram: t.showHistogram,
    probes: t.probes,
    nextProbeId: t.nextProbeId,
  }

  let image: FlatPart['image'] = null
  if (sources.image && f.imageName) {
    const member = `${IMAGE_STEM}.${extensionOf(sources.image.name)}`
    members.push({ name: member, bytes: sources.image.bytes })
    image = { fileName: f.imageName, member }
  }
  const flat: FlatPart = {
    image,
    pxPerMm: f.pxPerMm,
    calSource: f.calSource,
    splitAxes: f.splitAxes,
    edgeSensitivity: f.edgeSensitivity,
    showEdges: f.showEdges,
    snapToEdge: f.snapToEdge,
    showGrid: f.showGrid,
    elements: f.elements,
    nextId: f.nextId,
    nameCounts: f.nameCounts,
    dimensions: f.dimensions,
    nextDimId: f.nextDimId,
    dimCounts: f.dimCounts,
    datum: f.datum,
    counts: f.counts,
    nextCountId: f.nextCountId,
    notes: f.notes,
    nextNoteId: f.nextNoteId,
    turns: f.turns,
    mirror: f.mirror,
    // Every subject's sheet, the one on the stage included, so switching
    // subjects after a load finds each as it was left.
    subject: f.subject,
    sheets: { ...f.sheets, [sheetKeyOf(f.subject)]: sheetOf(f) },
  }

  const manifest: ProjectManifest = {
    app: PROJECT_APP,
    schemaVersion: PROJECT_SCHEMA,
    appVersion,
    workspace: useShell.getState().workspace,
    scan,
    deviation,
    thickness,
    flat,
  }
  // What was kept of the project opened last, then every section's own part —
  // a section in use writes its part over a kept one of the same key.
  const kept = keptParts()
  Object.assign(manifest, kept.parts)
  members.push(...kept.members)
  const ctx = { sources, scanSaved: scan !== null, addMember: (name: string, bytes: Uint8Array) => members.push({ name, bytes }) }
  for (const section of projectSections()) {
    const part = section.collect(ctx)
    if (part !== undefined) manifest[section.key] = part
  }
  return { manifest, members }
}

/** The Measure state of a project, onto a freshly loaded (and aligned) scan.
 *  Fitted elements come back as `done` with their saved fits; the caller
 *  re-fits them to get their surface regions tinted. */
function scanPartState(p: ScanPart): Partial<ReturnType<typeof useStore.getState>> {
  return {
    // An element saved before the cut-off was its own was measured with the
    // project's — so it comes back measured the same way.
    elements: p.elements.map((e) => elementFromJson(e, p.settings)),
    dimensions: p.dimensions,
    draft: null,
    dimDraft: null,
    alignDraft: null,
    nextId: p.nextId,
    nextNumber: p.nextNumber,
    nextOfKind: p.nextOfKind as ReturnType<typeof useStore.getState>['nextOfKind'],
    nextDimensionId: p.nextDimensionId,
    nextOfDimGroup: p.nextOfDimGroup,
    settings: p.settings,
    selectMode: p.selectMode,
    showLabels: p.showOverlays,
    showBackfaces: p.showBackfaces ?? true,
    // Planes only: the cuts are taken again once the scan is in the worker —
    // see useSections.
    sections: (p.sections ?? []).map(sectionFromJson),
    sectionDraft: null,
    nextSectionNumber: p.nextSectionNumber ?? 1,
  }
}

export function applyScanPart(p: ScanPart): void {
  useStore.setState(scanPartState(p))
}

function deviationPartState(p: DeviationPart): Partial<ReturnType<typeof useDeviation.getState>> {
  return {
    source: p.source,
    align: p.align ? alignFromJson(p.align) : null,
    globalAlign: p.globalAlign ? alignFromJson(p.globalAlign) : null,
    alignStatus: p.align ? 'done' : 'idle',
    alignMessage: null,
    pairs: p.pairs,
    pendingScan: null,
    picking: false,
    marking: false,
    localMaxDistance: p.localMaxDistance,
    targetId: p.targetId,
    targetSide: p.targetSide,
    targetFacingDeg: p.targetFacingDeg,
    targetScope: p.targetScope,
    scopeCount: p.scope?.length ?? 0,
    showElement: p.showElement,
    range: p.range,
    rangeAuto: p.rangeAuto,
    maxDistance: p.maxDistance,
    maxDistanceAuto: p.maxDistanceAuto,
    bands: p.bands,
    tolerance: p.tolerance,
    showHistogram: p.showHistogram,
    showNominal: p.showNominal,
    showScan: p.showScan,
    showMap: p.showMap,
    split: p.split,
    probes: p.probes,
    nextProbeId: p.nextProbeId,
  }
}

export function applyDeviationPart(p: DeviationPart): void {
  useDeviation.setState(deviationPartState(p))
}

function thicknessPartState(p: ThicknessPart): Partial<ReturnType<typeof useThickness.getState>> {
  return {
    method: p.method,
    maxThickness: p.maxThickness,
    maxThicknessAuto: p.maxThicknessAuto,
    coneRays: p.coneRays,
    coneAngleDeg: p.coneAngleDeg,
    normalDeviationDeg: p.normalDeviationDeg,
    low: p.low,
    high: p.high,
    scaleAuto: p.scaleAuto,
    bands: p.bands,
    limit: p.limit,
    showHistogram: p.showHistogram,
    probes: p.probes,
    nextProbeId: p.nextProbeId,
  }
}

export function applyThicknessPart(p: ThicknessPart): void {
  useThickness.setState(thicknessPartState(p))
}

/** The 2D state, onto an image that has already been opened (or none). The
 *  sections it may put on the stage are the scan part's, applied first. */
function flatPartState(p: FlatPart, sections = useStore.getState().sections) {
  // The sheet on the stage and the ones behind it. A project from before
  // sections holds one sheet, the image's, in the flat fields themselves.
  const legacy: SheetState = {
    pxPerMm: p.pxPerMm,
    calSource: p.calSource,
    elements: p.elements,
    nextId: p.nextId,
    nameCounts: p.nameCounts,
    dimensions: p.dimensions,
    nextDimId: p.nextDimId,
    dimCounts: p.dimCounts,
    datum: p.datum,
    counts: p.counts,
    nextCountId: p.nextCountId,
    notes: p.notes ?? [],
    nextNoteId: p.nextNoteId ?? 1,
    turns: p.turns ?? 0,
    mirror: p.mirror ?? false,
  }
  // A sheet saved before it could be turned or mirrored lies the way it was
  // scanned.
  const sheetFromJson = (sheet: Partial<SheetState>): SheetState =>
    ({ ...sheet, turns: sheet.turns ?? 0, mirror: sheet.mirror ?? false }) as SheetState
  let subject: FlatSubject = p.subject ?? { kind: 'image' }
  // A section that is not in the project any more (or never was) cannot be
  // on the stage; the image is.
  if (subject.kind === 'section') {
    const id = subject.id
    if (!sections.some((sec) => sec.id === id)) subject = { kind: 'image' }
  }
  const sheets: Record<string, SheetState> = {}
  for (const [k, sheet] of Object.entries(p.sheets ?? {})) sheets[k] = sheetFromJson(sheet)
  const key = sheetKeyOf(subject)
  const active = sheets[key] ?? legacy
  delete sheets[key]
  return (s: ReturnType<typeof useFlat.getState>): Partial<typeof s> => ({
    ...active,
    subject,
    subjectVersion: s.subjectVersion + 1,
    sheets,
    splitAxes: p.splitAxes,
    tool: { kind: 'none' },
    edgeSensitivity: p.edgeSensitivity,
    showEdges: p.showEdges,
    snapToEdge: p.snapToEdge,
    showGrid: p.showGrid,
    draft: null,
    dimDraft: null,
  })
}

export function applyFlatPart(p: FlatPart): void {
  useFlat.setState(flatPartState(p))
}

/** Convert every saved recipe before replacing any live state. Malformed
 * elements, sketches or alignments must fail while the old session is intact. */
export function prepareProjectState(m: ProjectManifest, members: ReadonlyMap<string, Uint8Array> = new Map()): () => void {
  for (const [name, arrays] of [
    ['scan', m.scan ? [m.scan.elements, m.scan.dimensions] : []],
    ['deviation', [m.deviation.pairs, m.deviation.probes]],
    ['thickness', [m.thickness.probes]],
    ['flat', [m.flat.elements, m.flat.dimensions, m.flat.counts]],
  ] as const) {
    if (arrays.some((a) => !Array.isArray(a))) throw new Error(`Malformed project: ${name} entries.`)
  }
  const scan = m.scan ? scanPartState(m.scan) : null
  const deviation = deviationPartState(m.deviation)
  const thickness = thicknessPartState(m.thickness)
  const flat = flatPartState(m.flat, scan?.sections ?? [])
  // Each section checks and converts its part the same way, before anything
  // is replaced — a part the file lacks is theirs to read as they will.
  const sections = projectSections().map((section) => section.prepare(m[section.key], { manifest: m, members }))
  return () => {
    if (scan) useStore.setState(scan)
    useDeviation.setState(deviation)
    useThickness.setState(thickness)
    useFlat.setState(flat)
    for (const apply of sections) apply()
    applyWorkspace(m.workspace)
  }
}

/** Open the workspace a project was saved in — one of the app's, or one a
 *  plugin in use adds. A workspace this build does not have opens 3D
 *  Measure instead. */
export function applyWorkspace(w: string): void {
  const known: Workspace[] = [...CORE_WORKSPACES, ...plugins().flatMap((p) => (p.workspace ? [p.workspace.id] : []))]
  useShell.getState().setWorkspace(known.includes(w) ? w : 'elements')
}

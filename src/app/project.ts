// SPDX-License-Identifier: AGPL-3.0-only
// Reading a project manifest off the stores and writing one back onto them.
// The orchestration around it — loading the model files, re-measuring the
// maps — lives in useProject; this is the plain data half, so it can be
// tested without a worker or a scene.

import { useStore } from '../state/store'
import { useDeviation } from '../state/deviationStore'
import { useThickness } from '../state/thicknessStore'
import { useFlat } from '../state/flatStore'
import { useShell, type Workspace } from '../state/shellStore'
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
  type DeviationPart,
  type FlatPart,
  type ProjectManifest,
  type ScanPart,
  type ThicknessPart,
} from '../core/project/manifest'
import type { ArchiveMember } from '../core/project/archive'

/** The original bytes of every model the session holds, kept from the moment
 *  each was opened: the worker takes its copy by transfer and the scene keeps
 *  only geometry, so nothing else could write the file back out as it came. */
export interface SourceFiles {
  scan: { name: string; bytes: Uint8Array } | null
  reference: { name: string; bytes: Uint8Array } | null
  image: { name: string; bytes: Uint8Array } | null
}

export const emptySources = (): SourceFiles => ({ scan: null, reference: null, image: null })

/** True when the session holds work worth a warning before it is replaced. */
export function sessionIsDirty(): boolean {
  const s = useStore.getState()
  const f = useFlat.getState()
  return (
    s.elements.length > 0 ||
    s.dimensions.length > 0 ||
    f.elements.length > 0 ||
    f.dimensions.length > 0 ||
    f.counts.length > 0 ||
    f.notes.length > 0
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
      showOverlays: s.showOverlays,
      showBackfaces: s.showBackfaces,
    }
  }

  let reference: DeviationPart['reference'] = null
  if (sources.reference && dev.nominalName) {
    const member = `${REFERENCE_STEM}.${extensionOf(sources.reference.name)}`
    members.push({ name: member, bytes: sources.reference.bytes })
    reference = { fileName: dev.nominalName, member }
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
  }

  return {
    manifest: {
      app: PROJECT_APP,
      schemaVersion: PROJECT_SCHEMA,
      appVersion,
      workspace: useShell.getState().workspace,
      scan,
      deviation,
      thickness,
      flat,
    },
    members,
  }
}

/** The Measure state of a project, onto a freshly loaded (and aligned) scan.
 *  Fitted elements come back as `done` with their saved fits; the caller
 *  re-fits them to get their surface regions tinted. */
export function applyScanPart(p: ScanPart): void {
  useStore.setState({
    elements: p.elements.map(elementFromJson),
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
    showOverlays: p.showOverlays,
    showBackfaces: p.showBackfaces,
  })
}

export function applyDeviationPart(p: DeviationPart): void {
  useDeviation.setState({
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
  })
}

export function applyThicknessPart(p: ThicknessPart): void {
  useThickness.setState({
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
  })
}

/** The 2D state, onto an image that has already been opened (or none). */
export function applyFlatPart(p: FlatPart): void {
  useFlat.setState({
    pxPerMm: p.pxPerMm,
    calSource: p.calSource,
    splitAxes: p.splitAxes,
    calibrating: null,
    edgeSensitivity: p.edgeSensitivity,
    showEdges: p.showEdges,
    snapToEdge: p.snapToEdge,
    showGrid: p.showGrid,
    elements: p.elements,
    draft: null,
    nextId: p.nextId,
    nameCounts: p.nameCounts,
    dimensions: p.dimensions,
    dimDraft: null,
    nextDimId: p.nextDimId,
    dimCounts: p.dimCounts,
    datum: p.datum,
    datumPicking: null,
    counts: p.counts,
    counting: null,
    nextCountId: p.nextCountId,
    notes: p.notes ?? [],
    placingNote: false,
    editingNoteId: null,
    nextNoteId: p.nextNoteId ?? 1,
  })
}

export function applyWorkspace(w: string): void {
  const known: Workspace[] = ['elements', 'deviation', 'thickness', 'flat']
  useShell.getState().setWorkspace(known.includes(w as Workspace) ? (w as Workspace) : 'elements')
}

// SPDX-License-Identifier: AGPL-3.0-only
// What a saved project carries, and how the pieces of live state that are not
// JSON (typed arrays inside elements and rigid transforms) are written and
// read back. Only user intent is saved: every map, field, edge chain and
// spatial index is re-measured on load from the same inputs, so the file
// stays small and a change to an algorithm never strands an old project.
//
// The manifest is deliberately a plain data description of the stores, not
// the stores themselves — drafts, busy flags and readouts never enter it.

import type { Element, SelectMode } from '../../state/store'
import type { Dimension } from '../dimensions'
import type { AlignResult, PointPair } from '../deviation/align'
import type { Rigid } from '../deviation/rigid'
import type { MaterialSide } from '../deviation/elementField'
import type { Probe } from '../../state/probes'
import type { FitSettings } from '../types'
import type { ThicknessMethod } from '../thickness/thickness'
import type { CalSource } from '../../state/flatStore'
import type { FlatElement } from '../flat/elements'
import type { FlatDimension } from '../flat/dimensions'
import type { FlatDatum } from '../flat/datum'
import type { PixelsPerMm } from '../flat/image'
import type { Vec2 } from '../flat/types'

export const PROJECT_APP = 'ScanRuler'
export const PROJECT_SCHEMA = 1
export const PROJECT_EXTENSION = 'scanruler'

/** Names the model files take inside the archive: a fixed stem, the original
 *  extension, so the right parser picks them up again. */
export const SCAN_STEM = 'scan'
export const REFERENCE_STEM = 'reference'
export const IMAGE_STEM = 'image'
export const MANIFEST_NAME = 'project.json'

/** A rigid transform as JSON — row-major rotation, translation. */
export interface RigidJson {
  r: number[]
  t: number[]
}

export function rigidToJson(m: Rigid): RigidJson {
  return { r: Array.from(m.r), t: Array.from(m.t) }
}

export function rigidFromJson(j: RigidJson): Rigid {
  if (j.r.length !== 9 || j.t.length !== 3) throw new Error('Malformed transform in project.')
  return { r: Float64Array.from(j.r), t: Float64Array.from(j.t) }
}

/** An element with its hand-marked selection as a plain array. */
export type ElementJson = Omit<Element, 'source'> & {
  source:
    | { type: 'fitted'; seeds: number[]; selection?: number[] }
    | { type: 'picked' }
    | { type: 'constructed'; method: string; refs: number[]; params: number[] }
}

export function elementToJson(e: Element): ElementJson {
  if (e.source.type !== 'fitted') return e as ElementJson
  const { selection, ...rest } = e.source
  return {
    ...e,
    // A fitting element saves as done with whatever fit it had: the fit is
    // re-run on load anyway.
    status: 'done',
    source: selection ? { ...rest, selection: Array.from(selection) } : rest,
  }
}

export function elementFromJson(e: ElementJson): Element {
  if (e.source.type !== 'fitted') return e as Element
  const { selection, ...rest } = e.source
  return {
    ...e,
    source: selection ? { ...rest, selection: Uint32Array.from(selection) } : rest,
  } as Element
}

export type AlignResultJson = Omit<AlignResult, 'transform'> & { transform: RigidJson }

export function alignToJson(a: AlignResult): AlignResultJson {
  return { ...a, transform: rigidToJson(a.transform) }
}

export function alignFromJson(a: AlignResultJson): AlignResult {
  return { ...a, transform: rigidFromJson(a.transform) }
}

/** The Measure workspace and the scan it shares with the other 3D ones. */
export interface ScanPart {
  fileName: string
  /** Archive member holding the original file bytes. */
  member: string
  /** The datum alignment baked into the scan. Elements are saved in the
   *  aligned frame, so the same transform goes onto the raw scan first. */
  appliedAlignment: RigidJson | null
  elements: ElementJson[]
  dimensions: Dimension[]
  nextId: number
  nextNumber: number
  nextOfKind: Record<string, number>
  nextDimensionId: number
  nextOfDimGroup: Record<'distance' | 'angle', number>
  settings: FitSettings
  selectMode: SelectMode
  showOverlays: boolean
  showBackfaces: boolean
}

export interface DeviationPart {
  source: 'reference' | 'element'
  reference: { fileName: string; member: string } | null
  /** The global best fit and the one shown (a local fine fit refines it). */
  align: AlignResultJson | null
  globalAlign: AlignResultJson | null
  pairs: PointPair[]
  localMaxDistance: number
  targetId: number | null
  targetSide: MaterialSide
  targetFacingDeg: number | null
  targetScope: 'all' | 'marked'
  /** The hand-marked scan region an element map is restricted to. */
  scope: number[] | null
  showElement: boolean
  range: number
  rangeAuto: boolean
  maxDistance: number
  maxDistanceAuto: boolean
  bands: number | null
  tolerance: number
  showHistogram: boolean
  showNominal: boolean
  showScan: boolean
  showMap: boolean
  split: boolean
  probes: Probe[]
  nextProbeId: number
}

export interface ThicknessPart {
  /** Whether the map had been measured, so it is measured again on load. */
  measured: boolean
  method: ThicknessMethod
  maxThickness: number
  maxThicknessAuto: boolean
  coneRays: number
  coneAngleDeg: number
  normalDeviationDeg: number | null
  low: number
  high: number
  scaleAuto: boolean
  bands: number | null
  limit: number
  showHistogram: boolean
  probes: Probe[]
  nextProbeId: number
}

export interface FlatPart {
  image: { fileName: string; member: string } | null
  pxPerMm: PixelsPerMm | null
  calSource: CalSource
  splitAxes: boolean
  edgeSensitivity: number
  showEdges: boolean
  snapToEdge: boolean
  showGrid: boolean
  elements: FlatElement[]
  nextId: number
  nameCounts: Record<string, number>
  dimensions: FlatDimension[]
  nextDimId: number
  dimCounts: Record<string, number>
  datum: FlatDatum | null
  counts: { id: number; name: string; color: string; picks: Vec2[]; visible: boolean }[]
  nextCountId: number
  /** Free text notes; absent in projects saved before they existed. */
  notes?: { id: number; text: string; at: Vec2; visible: boolean }[]
  nextNoteId?: number
}

export interface ProjectManifest {
  app: typeof PROJECT_APP
  schemaVersion: number
  appVersion: string
  workspace: string
  scan: ScanPart | null
  deviation: DeviationPart
  thickness: ThicknessPart
  flat: FlatPart
}

/** Check a parsed manifest is one of ours and one this build can read. */
export function validateManifest(raw: unknown): ProjectManifest {
  const m = raw as Partial<ProjectManifest> | null
  if (!m || typeof m !== 'object' || m.app !== PROJECT_APP || typeof m.schemaVersion !== 'number') {
    throw new Error('Not a ScanRuler project file.')
  }
  if (m.schemaVersion > PROJECT_SCHEMA) {
    throw new Error('This project was saved by a newer version of ScanRuler — please reload the app to open it.')
  }
  if (m.scan !== null && (typeof m.scan !== 'object' || typeof m.scan.fileName !== 'string')) {
    throw new Error('Malformed project: scan entry.')
  }
  if (!m.deviation || !m.thickness || !m.flat) throw new Error('Malformed project: missing parts.')
  return m as ProjectManifest
}

/** The file stem a project is saved under: the scan's, else the image's. */
export function projectStem(scanName: string | null, imageName: string | null): string {
  const base = scanName ?? imageName ?? 'project'
  return base.replace(/\.[^.]+$/, '')
}

export function extensionOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? ''
}

// SPDX-License-Identifier: AGPL-3.0-only
// What a saved project carries, and how the pieces of live state that are not
// JSON (typed arrays inside elements and rigid transforms) are written and
// read back. Only user intent is saved: every map, field, edge chain and
// spatial index is re-measured on load from the same inputs, so the file
// stays small and a change to an algorithm never strands an old project.
//
// The manifest is deliberately a plain data description of the stores, not
// the stores themselves — drafts, busy flags and readouts never enter it.

import type { MeshUnits } from '../meshUnits'
import type { ScanScale } from '../scanScale'
import type { Element, Section, SelectMode } from '../../state/store'
import type { Dimension } from '../dimensions'
import type { AlignResult, PointPair } from '../deviation/align'
import type { Rigid } from '../deviation/rigid'
import type { MaterialSide } from '../deviation/elementField'
import type { Probe } from '../../state/probes'
import type { FitSettings } from '../types'
import type { ThicknessMethod } from '../thickness/thickness'
import type { CalSource, FlatSubject, SheetState } from '../../state/flatStore'
import type { FlatElement } from '../flat/elements'
import type { FlatDimension } from '../flat/dimensions'
import type { FlatDatum } from '../flat/datum'
import type { PixelsPerMm } from '../flat/image'
import type { Vec2 } from '../flat/types'
import { NEWER_PROJECT, validateProjectParts } from './validation'

export const PROJECT_APP = 'ScanRuler'
/** The version a project is saved as. A build refuses a higher one, so it
 *  goes up when a project starts to hold something an older build would
 *  read wrongly without noticing: a field whose meaning changes, a new one
 *  that changes what the rest means. A new element kind, way of making an
 *  element or dimension type needs no raise: an older build refuses those
 *  by name (validation.ts), and so still opens a project that does not use
 *  them.
 *
 *  2 (after 0.10.2): the first builds to refuse names they do not know. Raised so
 *  that 0.10.2 and older, which only read this number, turn away projects
 *  from the constructions added since and do not open them half-built. */
export const PROJECT_SCHEMA = 2
export const PROJECT_EXTENSION = 'scanruler'

/** Names the model files take inside the archive: a fixed stem, the original
 *  extension, so the right parser picks them up again. */
export const SCAN_STEM = 'scan'
export const REFERENCE_STEM = 'reference'
export const IMAGE_STEM = 'image'
export const MANIFEST_NAME = 'project.json'

/** PROJECT_EXTENSION, then a count: see isProjectName. */
const PROJECT_NAME = /\.scanruler(?:-\d+| ?\(\d+\))?$/i

/** Whether a file's name is a project's: `.scanruler`, or that with the
 *  count a browser adds after it when the name is taken in the folder —
 *  `MyProject.scanruler-2` (Chrome on macOS, issue 83), or ` (2)`. */
export function isProjectName(name: string): boolean {
  return PROJECT_NAME.test(name.trim())
}

/** The extensions the Open dialog offers a project by: its own, and the
 *  counted ones a browser leaves when it saves over a name (isProjectName)
 *  — a Mac's dialog will not let any other be picked. */
export const PROJECT_ACCEPT = [`.${PROJECT_EXTENSION}`, ...Array.from({ length: 9 }, (_, i) => `.${PROJECT_EXTENSION}-${i + 1}`)].join(',')

/** Whether a file begins as a project does, whatever its name: a zip whose
 *  first member is the manifest (packProject writes it first) — the local
 *  header's signature, then the name at byte 30. `head` is the file's first
 *  bytes, 30 and the name's length at least. */
export function startsAsProject(head: Uint8Array): boolean {
  if (head.length < 30 + MANIFEST_NAME.length) return false
  if (head[0] !== 0x50 || head[1] !== 0x4b || head[2] !== 0x03 || head[3] !== 0x04) return false
  const nameLength = head[26] | (head[27] << 8)
  if (nameLength !== MANIFEST_NAME.length) return false
  for (let i = 0; i < nameLength; i++) if (head[30 + i] !== MANIFEST_NAME.charCodeAt(i)) return false
  return true
}

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

/** An element with its hand-marked selection as a plain array. The fit
 *  settings are absent in projects saved while they were one setting for the
 *  whole session — the ScanPart's `settings` — which is what such an element
 *  was measured with. */
export type ElementJson = Omit<Element, 'source'> & {
  source:
    | { type: 'fitted'; seeds: number[]; selection?: number[]; settings?: FitSettings }
    | { type: 'picked' }
    | { type: 'constructed'; method: string; refs: number[]; params: number[]; selection?: number[] }
}

export function elementToJson(e: Element): ElementJson {
  if (e.source.type === 'constructed') {
    // A scan search's marked surface saves the way a fit's does.
    const { selection, ...rest } = e.source
    return (selection ? { ...e, source: { ...rest, selection: Array.from(selection) } } : e) as ElementJson
  }
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

/** `settings` stands in for a fitted element saved without its own — the
 *  session-wide setting of the project it came from. */
export function elementFromJson(e: ElementJson, settings: FitSettings): Element {
  if (e.source.type === 'constructed') {
    const { selection, ...rest } = e.source
    return (selection ? { ...e, source: { ...rest, selection: Uint32Array.from(selection) } } : e) as Element
  }
  if (e.source.type !== 'fitted') return e as Element
  const { selection, settings: own, ...rest } = e.source
  const source = { ...rest, settings: own ?? settings }
  return {
    ...e,
    source: selection ? { ...source, selection: Uint32Array.from(selection) } : source,
  } as Element
}

/** A section without its polylines: the plane is saved, the cut is taken
 *  again on load — like every other measured thing. */
export type SectionJson = Omit<Section, 'cut' | 'cutKey' | 'message'>

export function sectionToJson(s: Section): SectionJson {
  const { cut: _cut, cutKey: _key, message: _message, ...rest } = s
  return rest
}

export function sectionFromJson(s: SectionJson): Section {
  return { ...s }
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
  /** The files that came with it — a textured OBJ's material library and
   *  image — each with the name it came under, which is how the OBJ finds
   *  it. Absent for a scan that came alone. */
  companions?: { fileName: string; member: string }[]
  /** What the member's coordinates are in, when not millimetres: the scan
   *  was read in millimetres from it, and is again on load. Absent in
   *  projects saved before the STL import asked, and for a file in mm. */
  units?: MeshUnits
  /** The factor the member's coordinates are scaled by on top of `units` —
   *  the scan was scaled to its true size (core/scanScale) and is read at it
   *  again. Absent means 1, and so for an edit of a scaled scan taken into
   *  use: its file is written at the size it was edited at. */
  scale?: number
  /** How the scan got its true size, for the record: the factor all its
   *  scales came to and the references of the last one. Absent when it was
   *  never scaled. */
  scaled?: ScanScale
  /** The datum alignment baked into the scan. Elements are saved in the
   *  aligned frame, so the same transform goes onto the raw scan first. */
  appliedAlignment: RigidJson | null
  elements: ElementJson[]
  dimensions: Dimension[]
  nextId: number
  nextNumber: number
  nextOfKind: Record<string, number>
  nextDimensionId: number
  /** Keyed by name stem ("distance", "angle", "diameter", "flatness", …);
   *  a kind with no entry starts at 1. */
  nextOfDimGroup: Record<string, number>
  settings: FitSettings
  selectMode: SelectMode
  /** Whether the labels on the part are shown — the name under which the
   *  switch was saved when it hid every overlay. */
  showOverlays: boolean
  /** Absent in projects saved before the switch existed; those load with the
   *  tint on, same as a fresh session. */
  showBackfaces?: boolean
  /** The scan cut with planes, for the 2D workspace. Absent in projects
   *  saved before sections existed. */
  sections?: SectionJson[]
  nextSectionNumber?: number
}

export interface DeviationPart {
  source: 'reference' | 'element'
  /** `units` as on the scan: what the member is in, when not millimetres. */
  reference: { fileName: string; member: string; units?: MeshUnits } | null
  /** The global best fit and the one shown (a local fine fit refines it). */
  align: AlignResultJson | null
  globalAlign: AlignResultJson | null
  pairs: PointPair[]
  localMaxDistance: number
  targetId: number | null
  targetSide: MaterialSide
  targetFacingDeg: number | null
  /** The reference map's facing limit. Absent in projects saved before it
   *  existed. */
  mapFacingDeg?: number | null
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
  /** Quarter turns the sheet is shown at, counter-clockwise. Absent in
   *  projects saved before the sheet could be turned — those, and any
   *  sheet under `sheets` without one, load the way they were scanned. */
  turns?: number
  /** Whether the sheet is shown mirrored. Absent in projects saved before
   *  it could be — those lie the way they were scanned. */
  mirror?: boolean
  /** What was on the sheet, and every subject's sheet — the image's and each
   *  section's — keyed by sheetKeyOf, the one on the stage included. The
   *  flat fields above are that sheet's, kept so an older build reads the
   *  project as it always did. Absent in projects saved before sections. */
  subject?: FlatSubject
  sheets?: Record<string, SheetState>
}

export interface ProjectManifest {
  app: typeof PROJECT_APP
  schemaVersion: number
  appVersion: string
  /** What the operator named the project. Absent for one not named, and
   *  in projects saved before projects had names. */
  name?: string
  workspace: string
  scan: ScanPart | null
  deviation: DeviationPart
  thickness: ThicknessPart
  flat: FlatPart
  /** The plugins' parts, each under the key its section owns — see
   *  app/projectSections.ts. */
  [section: string]: unknown
}

/** Check a parsed manifest is one of ours and one this build can read. */
export function validateManifest(raw: unknown): ProjectManifest {
  const m = raw as Partial<ProjectManifest> | null
  if (!m || typeof m !== 'object' || m.app !== PROJECT_APP || typeof m.schemaVersion !== 'number') {
    throw new Error('Not a ScanRuler project file.')
  }
  if (!Number.isInteger(m.schemaVersion) || m.schemaVersion < 1) throw new Error('Unsupported project schema version.')
  if (m.schemaVersion > PROJECT_SCHEMA) {
    throw new Error(NEWER_PROJECT)
  }
  if (m.scan !== null && (typeof m.scan !== 'object' || typeof m.scan.fileName !== 'string')) {
    throw new Error('Malformed project: scan entry.')
  }
  if (!m.deviation || !m.thickness || !m.flat) throw new Error('Malformed project: missing parts.')
  validateProjectParts(m)
  return m as ProjectManifest
}

/** The file stem a project is saved under: its name, else the scan's,
 *  else the image's. A name is kept whole — a dot in it is no extension —
 *  but for what a file name cannot hold. */
export function projectStem(projectName: string | null, scanName: string | null, imageName: string | null): string {
  const named = projectName === null ? '' : fileSafe(projectName)
  if (named !== '') return named
  const base = scanName ?? imageName ?? 'project'
  return base.replace(/\.[^.]+$/, '')
}

/** A name as a file can carry it: what Windows, macOS or Linux refuse in a
 *  file name made a dash, and no dots or spaces at its ends. */
export function fileSafe(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/^[.\s]+|[.\s]+$/g, '')
}

export function extensionOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? ''
}

/** The member a file is saved under: `stem`, then the file's extension
 *  where it has one a member name can carry — letters and digits after a
 *  dot. A name without one (`photo`), or with one past that (`scan.st~`,
 *  `bild.jpé`), keeps the stem alone: the file is read by its own name
 *  (readAs), which still carries whatever it was. */
export function memberName(stem: string, fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  const ext = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : ''
  return /^[a-z0-9]{1,16}$/.test(ext) ? `${stem}.${ext}` : stem
}

// SPDX-License-Identifier: AGPL-3.0-only
// The Reverse engineer workspace's part of a project file, under the key
// `reverse`: the feature list by reference — the sketches with their pieces
// and relations, every pick as a fingerprint, every plane and axis by the id
// of the section or element it names — and the counters the names run on.
// The bodies are rebuilt on load once the kernel arrives; nothing of the
// kernel's is saved. Absent in projects saved before the workspace existed,
// and in those with no feature. The STEP files the Imports brought in go
// beside it in the archive, all in one member (STEP_MEMBER): an archive
// holds a handful of members, and a project of a dozen bought-in parts
// would have used them up.

import { strFromU8, strToU8 } from 'fflate'
import type { CollectContext, ProjectSection, RestoreContext } from '../../../src/app/projectSections'
import { array, entries, fields, indices, invalid, object, vector } from '../../../src/core/project/validation'
import { fullTurn, type FaceRef, type Feature, type MoveFaceFeature } from '../core/features'
import { validateFolders, type BodyFolder } from '../core/bodyFolders'
import { evaluateParameters, type Parameter } from '../core/parameters'
import { useReverse, type BodyStyles } from '../state/reStore'

/** A feature as the file holds it: a surface's region — a typed array in
 *  the store — as a plain list, the way an element's marked surface
 *  travels; everything else is plain data already. A Move face saved
 *  before several faces could be picked holds its one `face`. */
export type FeatureJson =
  | Exclude<Feature, { kind: 'surface' }>
  | (Omit<Extract<Feature, { kind: 'surface' }>, 'region'> & { region: number[] })
  | (Omit<MoveFaceFeature, 'faces'> & { face: FaceRef })

export function featureToJson(f: Feature): FeatureJson {
  return f.kind === 'surface' ? { ...f, region: Array.from(f.region) } : f
}

function featureFromJson(f: FeatureJson): Feature {
  if (f.kind === 'surface') return { ...f, region: Uint32Array.from(f.region) }
  if (f.kind === 'moveFace' && 'face' in f) {
    const { face, ...rest } = f
    return { ...rest, faces: [face] }
  }
  return f
}

/** The version of the part as this build writes it. 2: a circular
 *  pattern's step is its span, first copy to last (it was pitch × count).
 *  3: a mirror not joined makes a body of its own, under the mirror's id
 *  (its copy took its source's id, and the source was gone). */
export const PART_VERSION = 3

export interface ReversePart {
  /** PART_VERSION as the part was written; absent before version 2. */
  version?: number
  /** Every feature, those below the rollback bar included. */
  features: FeatureJson[]
  /** How many of them stand above the rollback bar; absent: all of them. */
  rolledTo?: number
  nextFeatureId: number
  nextOfKind: Record<string, number>
  /** The model's parameters (core/parameters.ts); absent in a project
   *  saved before there were any, or with none. The expressions a feature
   *  or a sketch dimension reads them by travel inside the feature, beside
   *  the numbers they last came to. */
  parameters?: Parameter[]
  nextParameterId?: number
  /** The names and colours given to bodies, by body id; absent with none. */
  bodyStyles?: BodyStyles
  /** The bodies put out of view, by id — a sheet a thicken was made from,
   *  a feature's bodies hidden — so the export and the comparison, which
   *  take the visible ones, leave them out after the project opens again;
   *  absent with none. */
  hiddenBodies?: number[]
  /** The body list's components (core/bodyFolders); absent with none. */
  bodyFolders?: BodyFolder[]
  /** How the workspace was being looked at: the scan and the bodies
   *  see-through — the scan's absent while it follows the bodies, as the
   *  workspace opens. */
  scanSeeThrough?: boolean
  bodiesSeeThrough?: boolean
  /** The single key the two were before, in a project saved then: the
   *  bodies solid under a see-through scan, or the other way round. Read,
   *  never written. */
  bodyOpaque?: boolean
  /** Where the bodies run into each other left undrawn — present, false,
   *  only then. */
  overlapsShown?: boolean
  elementsShown: boolean
  /** The archive member the imported STEP files are in, as JSON of their
   *  texts by key; absent with no Import. */
  stepFiles?: string
}

/** The member the imported STEP files travel in. */
export const STEP_MEMBER = 'reverse-steps.json'

/** Check one feature as a file holds it — what the commands hold a feature
 *  handed in to as well. Throws on what would not load. */
export function validateFeatureJson(e: Record<string, unknown>): void {
  fields(e, 'kind name', 'string', 'feature')
  if (e.kind === 'sketch') {
    const sketch = object(e.sketch, 'feature.sketch')
    entries(sketch.entities, 'sketch.entities')
    entries(sketch.constraints, 'sketch.constraints')
    object(e.plane, 'sketch.plane')
    object(e.frame, 'sketch.frame')
  }
  if (e.kind === 'surface') indices(e.region, 'surface.region')
  // The queries a feature's picks were given by, each with what it found,
  // and how an extrude's or a revolve's regions were asked for.
  for (const key of ['edgesWhere', 'facesWhere'])
    if (e[key] !== undefined)
      for (const item of array(e[key], `${e.kind as string}.${key}`)) {
        const q = object(item, `${key}`)
        object(q.where, `${key}.where`)
        array(q.found, `${key}.found`)
      }
  if (e.regionPick !== undefined) {
    const pick = object(e.regionPick, `${e.kind as string}.regionPick`)
    if (pick.given !== 'all' && pick.given !== 'largest') array(pick.given, 'regionPick.given')
    array(pick.keys, 'regionPick.keys')
  }
  if (e.kind === 'sweep' && e.route !== undefined) {
    const route = object(e.route, 'sweep.route')
    for (const p of array(route.points, 'sweep.route.points')) vector(p, 3, 'sweep.route.points')
    fields(route, 'bendRadius', 'number', 'sweep.route')
  }
  if (e.kind === 'import') {
    const file = object(e.file, 'import.file')
    fields(file, 'key name', 'string', 'import.file')
    fields(file, 'size', 'number', 'import.file')
  }
  if (e.kind === 'moveBody') {
    for (const n of array(e.bodies, 'moveBody.bodies')) if (typeof n !== 'number' || !Number.isFinite(n)) invalid('moveBody.bodies')
    for (const k of ['pivot', 'translate', 'rotate']) vector(e[k], 3, `moveBody.${k}`)
    fields(e, 'copy', 'boolean', 'moveBody')
  }
  // A patch network: its nodes and curves by id and position, its cells
  // by their seeds — positions in the scan's frame. A cell has no id of
  // its own, its place in the list being what names it.
  if (e.kind === 'network') {
    entries(e.nodes, 'network.nodes', (n) => {
      fields(n, 'id', 'number', 'network.node')
      vector(n.at, 3, 'network.node.at')
    })
    entries(e.curves, 'network.curves', (c) => {
      fields(c, 'id from to', 'number', 'network.curve')
      for (const p of array(c.via, 'network.curve.via')) vector(p, 3, 'network.curve.via')
    })
    for (const item of array(e.cells, 'network.cells')) {
      const c = object(item, 'network.cell')
      vector(c.seed, 3, 'network.cell.seed')
      if (c.centre !== undefined) vector(c.centre, 3, 'network.cell.centre')
      if (c.corners !== undefined) indices(c.corners, 'network.cell.corners')
    }
    object(e.spans, 'network.spans')
    const fit = object(e.fit, 'network.fit')
    fields(fit, 'smoothness', 'number', 'network.fit')
    if (fit.tolerance !== undefined) fields(fit, 'tolerance', 'number', 'network.fit')
  }
}

/** Check a part as read from a file. */
export function validateReversePart(raw: unknown): ReversePart {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as ReversePart).features)) {
    throw new Error('Malformed project: reverse engineer entry.')
  }
  const r = object(raw, 'reverse')
  fields(r, 'nextFeatureId', 'number', 'reverse')
  if (r.version !== undefined && (typeof r.version !== 'number' || !Number.isFinite(r.version))) invalid('reverse.version')
  for (const n of Object.values(object(r.nextOfKind, 'reverse.nextOfKind'))) if (!Number.isSafeInteger(n)) invalid('reverse.nextOfKind')
  entries(r.features, 'reverse.features', validateFeatureJson)
  if (r.rolledTo !== undefined && (!Number.isSafeInteger(r.rolledTo) || (r.rolledTo as number) < 0 || (r.rolledTo as number) > (r.features as unknown[]).length)) invalid('reverse.rolledTo')
  if (r.parameters !== undefined) {
    // The shape only: a parameter whose expression no longer evaluates is
    // loaded with its row saying so, and the numbers it drove stand.
    const names = new Set<string>()
    entries(r.parameters, 'reverse.parameters', (p) => {
      fields(p, 'id', 'number', 'parameter')
      fields(p, 'name kind expression', 'string', 'parameter')
      if (!['length', 'angle', 'integer', 'number'].includes(p.kind as string)) invalid('parameter.kind')
      if (names.has(p.name as string)) invalid('parameter.name')
      names.add(p.name as string)
    })
    if (r.nextParameterId !== undefined) fields(r, 'nextParameterId', 'number', 'reverse')
  }
  if (r.stepFiles !== undefined && typeof r.stepFiles !== 'string') invalid('reverse.stepFiles')
  if (r.hiddenBodies !== undefined) for (const n of array(r.hiddenBodies, 'reverse.hiddenBodies')) if (typeof n !== 'number' || !Number.isFinite(n)) invalid('reverse.hiddenBodies')
  for (const k of ['scanSeeThrough', 'bodiesSeeThrough', 'bodyOpaque', 'overlapsShown'] as const) {
    if (r[k] !== undefined && typeof r[k] !== 'boolean') invalid(`reverse.${k}`)
  }
  if (r.bodyStyles !== undefined) {
    const styles = object(r.bodyStyles, 'reverse.bodyStyles')
    for (const [id, style] of Object.entries(styles)) {
      if (!Number.isFinite(Number(id))) invalid('reverse.bodyStyles')
      const st = object(style, 'reverse.bodyStyles')
      if ((st.name !== undefined && typeof st.name !== 'string') || (st.color !== undefined && typeof st.color !== 'string')) invalid('reverse.bodyStyles')
    }
  }
  if (r.bodyFolders !== undefined) {
    try {
      validateFolders(r.bodyFolders)
    } catch {
      invalid('reverse.bodyFolders')
    }
  }
  return raw as ReversePart
}

/** The keys of the STEP files the features import. */
function importedKeys(features: readonly Feature[]): string[] {
  return [...new Set(features.flatMap((f) => (f.kind === 'import' ? [f.file.key] : [])))]
}

/** The STEP member's bytes as last encoded, by their text. The snapshot that
 *  tells a saved project from a changed one keys members by the identity of
 *  their bytes, so the same texts must come back the same bytes, or the
 *  project never reads as saved and every checkpoint writes them again. */
let stepBytes: { json: string; bytes: Uint8Array } | null = null

/** The workspace as the file is to hold it, or undefined with no feature —
 *  with `ctx`, the STEP files its Imports name put into the archive
 *  beside it. */
export function collectReversePart(ctx?: Pick<CollectContext, 'addMember'>): ReversePart | undefined {
  const re = useReverse.getState()
  const all = [...re.features, ...re.rolledBack]
  if (all.length === 0) return undefined
  const keys = importedKeys(all)
  const texts = Object.fromEntries(keys.flatMap((k) => (re.stepFiles[k] !== undefined ? [[k, re.stepFiles[k]]] : [])))
  const steps = ctx && Object.keys(texts).length > 0
  if (steps) {
    const json = JSON.stringify(texts)
    if (stepBytes?.json !== json) stepBytes = { json, bytes: strToU8(json) }
    ctx.addMember(STEP_MEMBER, stepBytes.bytes)
  }
  // A playback moves the bar for the camera: the file has it where it stood.
  const rolledTo = re.playback?.origin ?? re.features.length
  // The lasting set: bodies a failed build or a rollback lacks now too.
  const hidden = re.hiddenBodies
  return {
    version: PART_VERSION,
    features: all.map(featureToJson),
    ...(rolledTo < all.length ? { rolledTo } : {}),
    nextFeatureId: re.nextFeatureId,
    nextOfKind: re.nextOfKind,
    ...(re.parameters.length > 0 ? { parameters: re.parameters, nextParameterId: re.nextParameterId } : {}),
    ...(Object.keys(re.bodyStyles).length > 0 ? { bodyStyles: re.bodyStyles } : {}),
    ...(hidden.length > 0 ? { hiddenBodies: hidden } : {}),
    ...(re.bodyFolders.length > 0 ? { bodyFolders: re.bodyFolders } : {}),
    ...(re.scanSeeThrough !== null ? { scanSeeThrough: re.scanSeeThrough } : {}),
    bodiesSeeThrough: re.bodiesSeeThrough,
    ...(re.overlapsShown ? {} : { overlapsShown: false }),
    elementsShown: re.elementsShown,
    ...(steps ? { stepFiles: STEP_MEMBER } : {}),
  }
}

/** The STEP files a part's member holds, by key — none where the part
 *  names none, or the archive lacks it: an Import whose file is missing
 *  fails by itself in the build, and the rest of the project opens. */
function stepFilesOf(p: ReversePart | undefined, ctx: RestoreContext | undefined): Record<string, string> {
  const bytes = p?.stepFiles !== undefined ? ctx?.members.get(p.stepFiles) : undefined
  if (!bytes) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(strFromU8(bytes))
  } catch {
    invalid('reverse.stepFiles')
  }
  const files = object(parsed, 'reverse.stepFiles')
  for (const text of Object.values(files)) if (typeof text !== 'string') invalid('reverse.stepFiles')
  return files as Record<string, string>
}

/** How see-through the scan and the bodies were, from a project saved
 *  with the two switches or with the one key before them. */
function seeThroughOf(p: ReversePart): { scanSeeThrough: boolean | null; bodiesSeeThrough: boolean } {
  if (p.bodiesSeeThrough !== undefined || p.scanSeeThrough !== undefined) {
    return { scanSeeThrough: p.scanSeeThrough ?? null, bodiesSeeThrough: p.bodiesSeeThrough ?? false }
  }
  return p.bodyOpaque === false ? { scanSeeThrough: false, bodiesSeeThrough: true } : { scanSeeThrough: null, bodiesSeeThrough: false }
}

/** A feature from a part written before `version`, as this build reads
 *  it. Before 2 the kernel spread a circular pattern's step as pitch ×
 *  count: an open one becomes its span, step·(count−1)/count, so the
 *  copies stand where they stood — an expression driving it too. */
export function migrateFeature(f: Feature, version: number): Feature {
  if (version >= 2 || f.kind !== 'pattern' || f.mode !== 'circular' || fullTurn(f.step) || !(f.count >= 2)) return f
  const n = Math.round(f.count)
  const step = (f.step * (n - 1)) / n
  const expr = f.exprs?.step
  if (expr === undefined) return { ...f, step }
  const count = f.exprs?.count ?? String(n)
  return { ...f, step, exprs: { ...f.exprs, step: `(${expr}) * ((${count}) - 1) / (${count})` } }
}

/** The body fields a feature names bodies by, at any depth but a
 *  sketch's own drawing. */
const BODY_KEYS = new Set(['body', 'tool', 'target'])

/** `value` with every body field naming `from` naming `to` instead. */
function renameBody<T>(value: T, from: number, to: number): T {
  if (Array.isArray(value)) return value.map((v) => renameBody(v, from, to)) as T
  if (typeof value !== 'object' || value === null || ArrayBuffer.isView(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => {
      if (k === 'sketch') return [k, v]
      if (BODY_KEYS.has(k) && v === from) return [k, to]
      if (k === 'bodies' && Array.isArray(v)) return [k, v.map((b) => (b === from ? to : b))]
      return [k, renameBody(v, from, to)]
    }),
  ) as T
}

/** The feature list from a part written before `version`, as this build
 *  reads it: each feature by migrateFeature, and — before 3 — what came
 *  after a mirror not joined pointed at its copy by its source's id, the
 *  copy having taken it; it now names the copy by the mirror's id, and
 *  the source stands beside it. */
export function migrateFeatures(features: readonly Feature[], version: number): Feature[] {
  let out = features.map((f) => migrateFeature(f, version))
  if (version >= 3) return out
  for (let i = 0; i < out.length; i++) {
    const m = out[i]
    if (m.kind !== 'mirror' || m.join) continue
    out = [...out.slice(0, i + 1), ...out.slice(i + 1).map((f) => renameBody(f, m.body, m.id))]
  }
  return out
}

/** The next id to give, from the one a file holds: past every id already
 *  taken whatever the file says, so a hand-edited or hostile counter cannot
 *  hand out an id twice and make one removal take two features. */
function nextIdPast(given: number | undefined, taken: readonly number[]): number {
  const past = taken.reduce((m, id) => (Number.isFinite(id) ? Math.max(m, Math.floor(id) + 1) : m), 1)
  return given !== undefined && Number.isSafeInteger(given) && given > past ? given : past
}

/** The features as the store holds them, split at the rollback bar. */
function reversePartState(p: ReversePart | undefined, ctx?: RestoreContext) {
  if (!p) return null
  const version = p.version ?? 1
  const all = migrateFeatures(p.features.map(featureFromJson), version)
  const at = p.rolledTo === undefined ? all.length : Math.min(all.length, Math.max(0, p.rolledTo))
  const parameters = p.parameters ?? []
  return {
    features: all.slice(0, at),
    rolledBack: all.slice(at),
    nextFeatureId: nextIdPast(p.nextFeatureId, all.map((f) => f.id)),
    nextOfKind: p.nextOfKind,
    parameters,
    nextParameterId: nextIdPast(p.nextParameterId, parameters.map((q) => q.id)),
    parameterTable: evaluateParameters(parameters),
    bodyStyles: Object.fromEntries(Object.entries(p.bodyStyles ?? {}).map(([id, st]) => [Number(id), st])) as BodyStyles,
    hiddenBodies: p.hiddenBodies ?? [],
    bodyFolders: p.bodyFolders ?? [],
    ...seeThroughOf(p),
    overlapsShown: p.overlapsShown ?? true,
    elementsShown: p.elementsShown,
    stepFiles: stepFilesOf(p, ctx),
  }
}

/** The features onto a loaded scan — or none, for a project without them.
 *  The bodies follow: the build runs once the kernel is up, which the
 *  store's build version asks for. */
export function applyReversePart(p: ReversePart | undefined, ctx?: RestoreContext): void {
  const prepared = reversePartState(p, ctx)
  useReverse.getState().reset()
  if (prepared) useReverse.setState((s) => ({ ...prepared, buildVersion: s.buildVersion + 1 }))
}

const PERSISTED = ['features', 'rolledBack', 'nextFeatureId', 'nextOfKind', 'parameters', 'nextParameterId', 'bodyStyles', 'bodyFolders', 'scanSeeThrough', 'bodiesSeeThrough', 'overlapsShown', 'elementsShown', 'stepFiles'] as const
const DRAFTS = ['sketchDraft', 'extrudeDraft', 'revolveDraft', 'featureDraft'] as const

export const reverseSection: ProjectSection<ReversePart> = {
  key: 'reverse',
  collect: (ctx) => collectReversePart(ctx),
  members: (value) => (value.stepFiles !== undefined ? [value.stepFiles] : []),
  prepare(value, ctx) {
    const part = value === undefined ? undefined : validateReversePart(value)
    const prepared = reversePartState(part, ctx)
    return () => {
      useReverse.getState().reset()
      if (prepared) useReverse.setState((s) => ({ ...prepared, buildVersion: s.buildVersion + 1 }))
    }
  },
  hasContent: () => true,
  holdsWork: () => useReverse.getState().features.length > 0,
  holds: () => ({ features: useReverse.getState().features.length }),
  hasDraft: () => {
    const r = useReverse.getState()
    return DRAFTS.some((k) => !!r[k])
  },
  watch(changed, draft) {
    return useReverse.subscribe((s, prev) => {
      if (PERSISTED.some((k) => s[k] !== prev[k])) changed()
      if (DRAFTS.some((k) => s[k] !== prev[k])) draft()
    })
  },
}

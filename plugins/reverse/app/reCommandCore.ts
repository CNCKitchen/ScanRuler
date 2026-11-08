// SPDX-License-Identifier: AGPL-3.0-only
// What every Reverse engineer command stands on: the session and the guards
// that keep a command off work open in the panel, one undo step per change
// with the build awaited, features, sketches and bodies found by name, and
// faces and edges picked by index, fingerprint or query (Where) on the
// topology of the build — staged, while a command runs, ahead of the store.
// Changes made one after another may build once, after the last: those
// gathered by one command, and a batch's changes run deferred.

import { invalid } from '../../../src/commands/core/common'
import { findSection } from '../../../src/commands/core/section'
import { findElement, parsePlaneName } from '../../../src/commands/refs'
import { int, type JsonSchema, oneOf } from '../../../src/commands/schema'
import { errorMessage } from '../../../src/commands/types'
import { round3 } from '../../../src/core/round'
import type { Vec2 } from '../../../src/core/flat/types'
import { RADIAL_AXIS_KINDS, type WorldAxis, worldAxisDir } from '../../../src/core/section/frame'
import type { FitData, Vec3 } from '../../../src/core/types'
import { cross } from '../../../src/core/vec'
import { type Command, CommandError, runningChange } from '../../../src/plugins/api'
import { useShell } from '../../../src/state/shellStore'
import { useStore } from '../../../src/state/store'
import type { BuiltBody, EdgeInfo, FaceInfo } from '../core/build'
import type { EdgeJoin } from '../core/edgeLines'
import { edgeJoins } from '../core/faceGroup'
import { type AxisRef, bodyFacePlane, bodyMaker, type Feature, type MirrorPlane, type PlaneRef, type RegionPick, type SketchFeature, withPlaneOffset } from '../core/features'
import type { KernelMesh } from '../core/kernelTypes'
import { pointInPolygon, regionAt } from '../core/regions'
import { signedArea2 } from '../../../src/core/flat/vec2'
import { upU } from '../core/resolve'
import { type EdgeFingerprint, type FaceFingerprint, matchEdge, matchFace, matchTolerance, splitEdges, tangentChain } from '../core/topo'
import { isWhere, SHARP_DEG, type StoredPick, storedWhere, unwrapped, type Where, type WhereAsk, whereIndices as coreWhereIndices } from '../core/where'
import { type BodyInfo, useReverse } from '../state/reStore'
import { regionsOut } from './reReadout'
import { meshDiagonal, type ReverseSession, reverseSession } from './reSession'

/** A face pick listed shallow — an index, or an object: a fingerprint or
 *  a query, checked when the command runs — where the whole shape would
 *  nest a tool's schema too deep. */
export const facePickIn = (): JsonSchema => oneOf([int('The face’s index in reverse.body.describe.', { minimum: 0 }), { type: 'object', description: 'Its fingerprint, or a query (where) that one face answers.' }], 'A face of the body.')

export type Json = Record<string, unknown>

export const nullable = (schema: JsonSchema, description: string): JsonSchema => oneOf([schema, { type: 'null' }], description)

export type FacePickIn = number | FaceFingerprint | Where

export type EdgePickIn = number | EdgeFingerprint | Where

export type Ref = number | string

export { unwrapped, type Where }

export const re = () => useReverse.getState()

export function session(): ReverseSession {
  const s = reverseSession()
  if (!s) throw new CommandError('unavailable', 'The Reverse engineer workspace is not set up in this session.')
  return s
}

/** The bodies built for the features as they stand. */
async function built(s: ReverseSession): Promise<void> {
  try {
    await s.settled()
  } catch (e) {
    throw new CommandError('failed', errorMessage(e))
  }
}

/** The kernel up — brought up as entering the workspace brings it up, if it
 *  is not — and the bodies built for the features as they stand. While a
 *  change runs on changes whose builds are held back, the part stands as
 *  last built: the change builds once, after it is made, not first too. */
export async function ready(): Promise<ReverseSession> {
  const s = session()
  try {
    await s.startKernel()
  } catch (e) {
    throw new CommandError('unavailable', errorMessage(e))
  }
  if (s.held() && runningChange()) return s
  await built(s)
  return s
}

/** How deep changes are being gathered — see gathered. */
let gathering = 0

/** Whether a change leaves its build for later: while changes are
 *  gathered, or when it runs deferred — a batch that builds at its end. */
const buildLater = () => gathering > 0 || runningChange()?.deferred === true

/** Changes made one after another in `job`, built once, after the last —
 *  unless the command runs deferred, when the build is left for later
 *  still. Each change in it finds the part as it was last built: a pick by
 *  index names a face of the part before them all. */
export async function gathered<T>(job: () => Promise<T>): Promise<T> {
  gathering++
  let out: T
  try {
    out = await job()
  } catch (e) {
    if (gathering === 1 && !runningChange()?.deferred) session().release()
    throw e
  } finally {
    gathering--
  }
  if (gathering > 0 || runningChange()?.deferred) return out
  await builtWhole(session())
  return out
}

/** The bodies built, and a build that failed whole said. */
async function builtWhole(s: ReverseSession): Promise<void> {
  await built(s)
  // A build that failed whole — not a feature in it, the build itself —
  // leaves no bodies; said, rather than answered as if it stood.
  const failed = re().buildError
  if (failed) throw new CommandError('failed', `The part did not build after this change: ${failed}. The change stands — history.undo takes it back.`)
}

/** Before a command not run deferred: builds that changes run deferred
 *  held back let go and waited for — unless the command is one of the
 *  workspace's own changes, which builds once, after it is made. */
export function settleHeld(next: { name: string; readOnly: boolean }): Promise<void> | undefined {
  const s = reverseSession()
  if (!s?.held()) return undefined
  if (!next.readOnly && next.name.startsWith('reverse.')) return undefined
  return s.settled().catch(() => {})
}

/** How many of the workspace's changes have run: what tells a command what
 *  came just before it. */
let changesRun = 0
export const changesSoFar = () => changesRun

/** A change whose answer says when its build was left for later (build:
 *  "held": result and bodies are the part as last built) — and which,
 *  run not deferred, lets builds still held go and waits for them: an
 *  earlier change's, where this one built nothing itself. */
export function withHeldBuild(command: Command<never>): Command<never> {
  if (command.readOnly) return command
  return {
    ...command,
    run: async (input, ctx) => {
      changesRun++
      let out: unknown
      try {
        out = await command.run(input, ctx)
      } catch (e) {
        if (!ctx?.deferred) reverseSession()?.release()
        throw e
      }
      const s = reverseSession()
      if (!s?.held()) return out
      if (!ctx?.deferred) {
        await built(s)
        return out
      }
      return out && typeof out === 'object' && !Array.isArray(out) ? { ...out, build: 'held' } : out
    },
  }
}

/** Refuse while the panel has a box with work in it — a sketch with
 *  pieces, a feature being set up or edited; an empty new sketch merely in
 *  hand is closed. */
function requireFree(): void {
  const r = re()
  const d = r.sketchDraft
  if (d && d.featureId === undefined && d.sketch.entities.length === 0 && d.history.length === 0) r.discardSketch()
  else if (d) throw new CommandError('invalid_state', `The Reverse engineer panel has the sketch “${d.name}” open — finish or cancel it there first, or ask the person at the screen to.`)
  const box = r.extrudeDraft ? 'an extrude' : r.revolveDraft ? 'a revolve' : r.featureDraft ? `a ${r.featureDraft.kind}` : null
  if (box) throw new CommandError('invalid_state', `The Reverse engineer panel has ${box} being set up — create or cancel it there first, or ask the person at the screen to.`)
}

/** Shut whatever box is open: a command that could not finish leaves none. */
function closeBoxes(): void {
  const r = re()
  if (r.sketchDraft) r.discardSketch()
  if (r.extrudeDraft) r.cancelExtrude()
  if (r.revolveDraft) r.cancelRevolve()
  if (r.featureDraft) r.cancelFeature()
}

const showWorkspace = () => {
  if (useShell.getState().workspace !== 'reverse') useShell.getState().setWorkspace('reverse')
}

/** A change to the feature list or the parameters, as the panel makes it:
 *  the kernel up and the part built first, the box opened, filled and
 *  committed in one go — shut again if anything in it was refused — and
 *  the part built after: or its build held back, for changes gathered or
 *  run deferred (buildLater), unless `now` — a change whose part the next
 *  step picks on, such as the rollback bar moved for an edit. */
export async function change<T>(job: (s: ReverseSession) => T, { now = false }: { now?: boolean } = {}): Promise<T> {
  const s = await ready()
  requireFree()
  showWorkspace()
  const later = !now && buildLater()
  if (later) s.hold()
  let out: T
  try {
    out = job(s)
  } finally {
    closeBoxes()
  }
  if (later) return out
  await builtWhole(s)
  return out
}

export const allFeatures = (): Feature[] => [...re().features, ...re().rolledBack]

/** A name that is a number written out — "185", "3.0009765625" — as that
 *  number: an id a bridge sent as text. Null for any other name. */
export function idInName(name: string): number | null {
  const t = name.trim()
  return /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(t) ? Number(t) : null
}

/** The one of `items` whose id is `id` — or, where none is exactly and
 *  `id` has a fraction, the one id that rounds to it at as many decimals
 *  as it is written with: 61.001 for 61.0009765625, as answers show it.
 *  Undefined where none is, or several round to it. */
export function itemById<T extends { id?: number }>(items: readonly T[], id: number): T | undefined {
  const exact = items.find((x) => x.id !== undefined && Math.abs(x.id - id) < 1e-9)
  if (exact || Number.isInteger(id)) return exact
  const decimals = /\.(\d+)$/.exec(String(id))?.[1].length ?? 0
  if (decimals === 0) return undefined
  const half = 0.5 * 10 ** -decimals + 1e-12
  const near = items.filter((x) => x.id !== undefined && Math.abs(x.id - id) <= half)
  return near.length === 1 ? near[0] : undefined
}

/** One of `items` by its name, whole and case aside — or, where no name
 *  is that and it is a number written out, by that id. */
export function byName<T extends { name: string; id?: number }>(items: readonly T[], name: string, what: string): T {
  const want = name.trim().toLowerCase()
  const hits = items.filter((x) => x.name.toLowerCase() === want)
  if (hits.length > 1) invalid(`${hits.length} ${what}s are named “${name}” — name it by its id.`)
  if (hits.length === 0) {
    const id = idInName(name)
    const byId = id === null ? undefined : itemById(items, id)
    if (byId) return byId
    throw new CommandError('not_found', `There is no ${what} “${name}”${id !== null ? ` — by name or by id —` : ' —'} there are ${items.map((x) => (id !== null && x.id !== undefined ? `${x.id} (“${x.name}”)` : `“${x.name}”`)).join(', ') || 'none'}.`)
  }
  return hits[0]
}

export function featureNamed(ref: Ref): Feature {
  const all = allFeatures()
  if (typeof ref === 'string') return byName(all, ref, 'feature')
  const f = all.find((x) => x.id === ref)
  if (!f) throw new CommandError('not_found', `There is no feature ${ref}.`)
  return f
}

export function sketchNamed(ref: Ref): SketchFeature {
  const f = featureNamed(ref)
  if (f.kind !== 'sketch') invalid(`${f.name} is a ${f.kind}, not a sketch.`)
  if (!re().features.includes(f)) throw new CommandError('invalid_state', `${f.name} is below the rollback bar — move the bar (reverse.feature.rollback) to use it.`)
  return f as SketchFeature
}

/** A body by its name or id — or by the name of the feature that made
 *  it, refused where that feature made several. */
export function bodyNamed(ref: Ref): BodyInfo {
  return bodyByRef(ref, false)
}

/** A body as a boolean names it (body or tool): as bodyNamed, but a
 *  feature that made several bodies is taken by its first, the step's own
 *  id, and the builder takes every piece of it with that one (build.ts
 *  familyOf). */
export function bodyFamilyNamed(ref: Ref): BodyInfo {
  return bodyByRef(ref, true)
}

function bodyByRef(ref: Ref, family: boolean): BodyInfo {
  const bodies = re().bodies
  if (typeof ref === 'string') {
    const want = ref.trim().toLowerCase()
    if (!bodies.some((x) => x.name.toLowerCase() === want)) {
      // A body goes by "Solid n" until named; the feature that made it goes
      // by the name it was given, and is taken for its body.
      const made = re().features.filter((f) => f.name.toLowerCase() === want)
      if (made.length === 1) {
        const f = made[0]
        // Added in a batch whose build is held: the body it will make.
        const toCome = heldBodyOf(f)
        if (toCome) return toCome
        // A feature that works on a body — a pattern, a mirror kept apart,
        // a cut or a split — is taken for that body: its id is the one the
        // builder takes the original and every copy or piece by (build.ts
        // familyOf). The copies' own ids are the feature's, so going by
        // the maker alone took one copy.
        // A mirror kept apart is the copy it made: the original goes by
        // its own name.
        if (f.kind === 'mirror' && !f.join) {
          const copy = bodies.filter((x) => bodyMaker(x.id) === f.id)
          if (copy.length === 1) return copy[0]
        }
        if ('body' in f && typeof f.body === 'number') {
          const worked = f.body
          const pieces = bodies.filter((x) => Math.abs(x.id - worked) < 1e-9 || bodyMaker(x.id) === f.id)
          const original = pieces.find((x) => Math.abs(x.id - worked) < 1e-9)
          if (pieces.length === 1) return pieces[0]
          if (pieces.length > 1 && family && original) return original
          if (pieces.length > 1) invalid(`${f.name} is ${pieces.length} bodies — give ${worked} for all its pieces in a boolean, or one of: ${pieces.map((x) => `${x.id} (${x.name})`).join(', ')}.`)
        }
        const own = bodies.filter((x) => bodyMaker(x.id) === f.id)
        if (own.length === 1) return own[0]
        const first = own.find((x) => Math.abs(x.id - f.id) < 1e-9)
        if (own.length > 1 && family && first) return first
        if (own.length > 1) invalid(`${f.name} made ${own.length} bodies — give ${f.id} for all its pieces in a boolean, or one of: ${own.map((x) => `${x.id} (${x.name})`).join(', ')}.`)
        throw new CommandError('not_found', `${f.name} is a feature whose body no longer stands on its own (a later feature took it in or it made none) — there are ${bodies.map((x) => `${x.id} (${x.name})`).join(', ') || 'none'}.`)
      }
    }
    return byName(bodies, ref, 'body')
  }
  const b = itemById(bodies, ref)
  if (b) return b
  // By the id a feature added in a held batch will give its body.
  const maker = re().features.find((f) => f.id === bodyMaker(ref) && notBuiltYet(f))
  const toCome = maker && Math.abs(ref - maker.id) < 1e-9 ? heldBodyOf(maker) : null
  if (toCome && Math.abs(toCome.id - ref) < 1e-9) return toCome
  throw new CommandError('not_found', `There is no body ${ref} — there are ${bodies.map((x) => `${x.id} (${x.name})`).join(', ') || 'none'}.`)
}

/** The solids a body given names, where it names a feature that made
 *  several — by its name, or by its id, the first solid's id as well — as
 *  bodyByRef finds a feature's pieces: null for a body's own name or id
 *  (one with a fraction is one solid), and for a feature of one solid. */
export function solidsNamed(ref: Ref): { feature: Feature; solids: BodyInfo[] } | null {
  const bodies = re().bodies
  const id = typeof ref === 'number' ? ref : idInName(ref)
  if (typeof ref === 'string' && bodies.some((x) => x.name.trim().toLowerCase() === ref.trim().toLowerCase())) return null
  const named = typeof ref === 'string' ? re().features.filter((f) => f.name.toLowerCase() === ref.trim().toLowerCase()) : []
  const f = named.length === 1 ? named[0] : id !== null && Number.isInteger(id) ? re().features.find((x) => x.id === id) : undefined
  if (!f) return null
  const worked = 'body' in f && typeof f.body === 'number' && !(f.kind === 'mirror' && !f.join) ? f.body : null
  const solids = bodies.filter((x) => bodyMaker(x.id) === f.id || (worked !== null && Math.abs(x.id - worked) < 1e-9))
  return solids.length > 1 ? { feature: f, solids } : null
}

/** Whether a feature was added in a batch whose build is held, and has not
 *  been built: the part stands as last built, without what it will make. */
const notBuiltYet = (f: Feature): boolean => !f.suppressed && re().results[f.id] === undefined && reverseSession()?.held() === true

/** The kinds that make a body of their own, under their own id, whatever
 *  else stands. */
const OWN_BODY = ['sheet', 'surface', 'network', 'trim', 'import']

/**
 * The body a feature added in a held batch will make, for a later step of
 * the batch to name — the extrude "Cup raw" a cutPlane further down cuts:
 * a body of its own takes the feature's id (op new, a sheet, a surface),
 * a feature on a body or on a target keeps that body's. A join with no
 * target takes the id of the oldest body it meets, which only the build
 * knows, and a cut makes none: those are refused saying so. Null where the
 * feature is built, or no batch holds its build — and for a sketch.
 */
function heldBodyOf(f: Feature): BodyInfo | null {
  if (f.kind === 'sketch' || !notBuiltYet(f)) return null
  const op = (f as { op?: string }).op
  const target = (f as { target?: number }).target
  let id: number | null = null
  if (f.kind === 'offsetBody') id = f.keep === false ? f.body : f.id
  else if ('body' in f && typeof f.body === 'number') id = f.body
  else if (target !== undefined && (op === 'join' || op === 'cut')) id = target
  else if (op === 'new' || OWN_BODY.includes(f.kind)) id = f.id
  if (id === null) {
    const why = op === 'join' ? 'a join takes the id of the oldest body it meets, which only the build knows' : op === 'cut' ? 'a cut makes no body of its own — name the body it cuts' : 'what it makes only the build knows'
    throw new CommandError('invalid_state', `${f.name} was added in this batch and is not built yet: ${why}. Give it op: "new" (a boolean joins it later), or build it before this step (build: "each").`)
  }
  const standing = re().bodies.find((x) => Math.abs(x.id - id!) < 1e-9)
  if (standing) return standing
  // Named as it will be: after the feature that makes it.
  const maker = re().features.find((x) => x.id === bodyMaker(id!))
  const sheet = OWN_BODY.includes(maker?.kind ?? '') && maker?.kind !== 'trim' && maker?.kind !== 'import'
  return { id, name: re().bodyStyles[id]?.name ?? maker?.name ?? `Solid ${id}`, visible: true, volume: 0, faces: 0, closed: !sheet, triangles: 0, ...(sheet ? { surface: true } : {}) }
}

/** A body by id as it stands — or, for one a later feature took into
 *  another, a stand-in under the name it had, so the feature that worked
 *  on it can still be edited and described as it saw it. */
export function bodyAt(id: number): BodyInfo {
  const b = re().bodies.find((x) => x.id === id)
  if (b) return b
  return { id, name: re().bodyStyles[id]?.name ?? `Solid ${id}`, visible: false, volume: 0, faces: 0, closed: true, triangles: 0 }
}

export type Topology = BuiltBody['topology']

/** The bodies as they stood before a feature, by body id — set while that
 *  feature is edited or described, so picks by index name the faces and
 *  edges the feature saw, on a body a later feature may since have taken
 *  into another. */
let stagedTopologies: Map<number, Topology> | null = null

const topologyFor = (s: ReverseSession, bodyId: number): Topology | undefined => stagedTopologies?.get(bodyId) ?? s.topologies.get(bodyId)

/** Run `job` with the bodies as they stood before feature `f`, for a
 *  feature that works on a body and is given picks by index (or by a
 *  query): the body as it was then, staged by the build. An edit that
 *  picks nothing — suppressed, a number, a name — needs no stage, whether
 *  the body is still there or a later feature took it in. */
export async function withStaged<T>(s: ReverseSession, f: Feature, set: Json, job: () => Promise<T>): Promise<T> {
  const bodyId = 'body' in f && typeof f.body === 'number' ? f.body : null
  const gone = bodyId !== null && !re().bodies.some((b) => b.id === bodyId)
  let staged: Map<number, Topology> | null = null
  if (bodyId !== null && hasIndexPicks(set)) {
    const st = await s.staged(f.id, bodyId).catch(() => null)
    if (st) {
      staged = new Map([[bodyId, st.topology]])
      meshOfTopology.set(st.topology, st.mesh)
    } else if (gone) {
      // The build keeps the part before a feature only where the feature
      // ran and built: one that failed, or is suppressed, has none.
      const why = f.suppressed ? 'is suppressed' : re().results[f.id]?.status === 'failed' ? 'did not build' : 'has not been built'
      // The body gone because what makes it did not build — an edit before
      // this one in the same call that mends it builds only after the call.
      const maker = allFeatures().find((x) => x.id === bodyMaker(bodyId))
      const made = maker ? re().results[maker.id] : undefined
      if (maker && maker.id !== f.id && (maker.suppressed || made?.status === 'failed'))
        throw new CommandError(
          'invalid_state',
          `${bodyAt(bodyId).name} is not there to pick on: ${maker.name}, which makes it, ${maker.suppressed ? 'is suppressed' : `did not build in the part as last built (${made?.message ?? 'failed'})`} — so ${f.name} has no body to count its faces and edges on by index or by a where query. An edit of ${maker.name} earlier in this same call builds only after the call: edit ${f.name} in a call of its own once ${maker.name} builds — or leave its picks as they are, where they were given by where queries: those are run again at every build.`,
        )
      throw new CommandError(
        'invalid_state',
        `${f.name} ${why}, so the part as it stood before it is not kept — and ${bodyAt(bodyId).name} is gone since (a later feature took it into another body), so there is nothing to count its faces and edges on by index or by a where query. Pick them by fingerprint instead: reverse.body.describe { fingerprints: true } on the body that took it in lists them. Or suppress the feature that took it in, edit ${f.name}, and build it again.`,
      )
    }
  }
  stagedTopologies = staged
  try {
    return await job()
  } finally {
    stagedTopologies = null
  }
}

/** Whether an input names a face or an edge by its index — or by a
 *  query, which reads the same body — anywhere in it. */
function hasIndexPicks(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (k === 'face' || k === 'faces' || k === 'edges') {
      if (typeof v === 'number' || isWhere(v)) return true
      if (Array.isArray(v) && v.some((x) => typeof x === 'number' || isWhere(x))) return true
    }
    if (v && typeof v === 'object' && hasIndexPicks(v)) return true
  }
  return false
}

export function topologyOf(s: ReverseSession, body: BodyInfo) {
  const t = topologyFor(s, body.id)
  if (!t) throw new CommandError('failed', `${body.name} has no faces to pick — it did not build.`)
  return t
}

const toleranceFor = (s: ReverseSession, body: number) => {
  const mesh = s.meshes.get(body)
  return matchTolerance(mesh ? meshDiagonal(mesh) : useStore.getState().modelSize)
}

/** What a query names among a body's faces or edges, by index — refused
 *  where it names nothing, or is empty. */
function wherePicks(w: Where, t: Topology, what: 'face' | 'edge', body: BodyInfo): number[] {
  if (what === 'face' && w.loop) invalid('loop picks edges — the edges of a face’s outer boundary or round its holes ({ faces: [i], loop: "outer" }), not faces.')
  if (Object.keys(w).length === 0) invalid(`A query for ${what}s needs at least one term — box, near, through, kind, between, faces, loop, coaxial, madeBy, sides, exclude or a size.`)
  const hits = whereIndices(w, t, body, what)
  if (hits.length === 0 && w.optional) {
    logPick({ where: true, optional: true, missed: w as unknown as Json })
    return []
  }
  if (hits.length === 0) throw new CommandError('not_found', `No ${what} of ${body.name} answers ${JSON.stringify(w)} — ${makersSaid(w, t, what, body.name)}reverse.body.describe { body: ${JSON.stringify(body.name)}, where } shows what there is.`)
  logPick({ where: true, [what === 'face' ? 'faces' : 'edges']: hits.slice(0, PICKED_CAP), ...(hits.length > PICKED_CAP ? { count: hits.length } : {}), ...(what === 'edge' ? chainsOut(w, t, hits) : {}) })
  return hits
}

/** What a feature does to a body's faces, as a refusal names it. */
const REMADE_BY: Partial<Record<Feature['kind'], string>> = { split: 'the split', boolean: 'the combine', offsetBody: 'the offset', cutPlane: 'the cut', shell: 'the shell', deleteFace: 'the faces deleted', moveFace: 'the faces moved', draft: 'the draft' }

/** For a query whose madeBy names a feature that made none of the body's
 *  faces (or edges) as it stands: the makers there are, and the later
 *  feature that took the named one's over — the one of them with the
 *  most, after it in the list — ending in a space; empty where each named
 *  feature made some, and the other terms left them out. sides.madeBy
 *  is read off the faces either side, as the query runs it. */
function makersSaid(given: Where, t: Topology, what: 'face' | 'edge', body: string): string {
  const w = unwrapped(given, what)
  const asked = [...(w.madeBy !== undefined ? [w.madeBy] : []), ...(Array.isArray(w.sides?.madeBy) ? w.sides.madeBy : [])]
  if (asked.length === 0) return ''
  const of = what === 'edge' && w.madeBy !== undefined && !w.sides ? 'edge' : 'face'
  const count = new Map<number, number>()
  for (const x of of === 'face' ? t.faces : t.edges) count.set(Math.floor(x.fingerprint.origin), (count.get(Math.floor(x.fingerprint.origin)) ?? 0) + 1)
  const missing = [...new Map(asked.map((r) => featureNamed(r)).map((f) => [f.id, f])).values()].filter((f) => !count.has(f.id))
  if (missing.length === 0) return ''
  const order = allFeatures()
  const at = (id: number) => order.findIndex((f) => f.id === id)
  const nameOf = (id: number) => order.find((f) => f.id === id)?.name ?? `feature ${id}`
  const and = (xs: readonly string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : (xs[0] ?? 'none'))
  const makers = [...count].sort((a, b) => b[1] - a[1])
  const listed = `${and(makers.slice(0, 6).map(([id, n]) => `${nameOf(id)}’s (${n})`))}${makers.length > 6 ? `, and ${makers.length - 6} more makers’` : ''}`
  const since = missing.flatMap((named) => {
    const later = makers.find(([id]) => at(id) > at(named.id))
    if (!later) return []
    const kind = order.find((f) => f.id === later[0])?.kind
    return [` ${named.name}’s ${of}s are ${nameOf(later[0])}’s since ${(kind && REMADE_BY[kind]) ?? nameOf(later[0])}.`]
  })
  return `${and(missing.map((f) => f.name))} made none of ${body}’s ${of}s as it stands: they are ${listed}.${since.join('')} `
}

/** For edges a query picked: how many tangent chains they make, where
 *  that is fewer than the edges — a round takes each chain whole, so
 *  edges beyond one a chain are picked for nothing, or are not the edges
 *  meant: a round's seams, matching a radius as the edge it rounded did.
 *  And how many of them run between faces that meet tangent, which
 *  sharp: true leaves out. */
function chainsOut(w: Where, t: Topology, hits: readonly number[]): Json {
  if (hits.length < 2) return {}
  const picked = new Set(hits.map((i) => t.edges[i].hash))
  const splits = splitEdges(t)
  const seen = new Set<number>()
  let chains = 0
  for (const i of hits) {
    const h = t.edges[i].hash
    if (seen.has(h)) continue
    chains++
    for (const x of tangentChain(t.edges, [h], splits)) if (picked.has(x)) seen.add(x)
    seen.add(h)
  }
  const joins = w.sharp || w.sharpDeg !== undefined ? null : joinsOf(t, SHARP_DEG)
  const smooth = joins ? hits.filter((i) => joins.get(t.edges[i].hash) !== 'sharp').length : 0
  if (chains >= hits.length && smooth === 0) return {}
  const words = [
    ...(chains < hits.length ? [`${hits.length} edges in ${chains} tangent chain${chains === 1 ? '' : 's'} — a round takes each chain whole`] : []),
    ...(smooth > 0 ? [`${smooth} run between faces that meet tangent (a round’s seams) — sharp: true leaves them out`] : []),
  ]
  return { chains, ...(smooth > 0 ? { smooth } : {}), note: `${words.join('; ')}.` }
}

/** The meshes of bodies as they stood before a feature, by the topology
 *  staged with each — what says how their faces meet. */
const meshOfTopology = new WeakMap<Topology, KernelMesh>()

/** A staged topology's mesh made known, for a where query run on it
 *  (sharp) to read how its faces meet. */
export const knowMesh = (t: Topology, mesh: KernelMesh): void => void meshOfTopology.set(t, mesh)

/** The mesh a topology was read off — staged with it, or the body's as it
 *  stands; null where it is not at hand. */
export function meshOf(t: Topology): KernelMesh | null {
  const staged = meshOfTopology.get(t)
  if (staged) return staged
  const s = reverseSession()
  if (s) for (const [id, x] of s.topologies) if (x === t) return s.meshes.get(id) ?? null
  return null
}

/** How the faces either side of each edge meet, by the edge's hash — read
 *  off the body's mesh as the viewport draws its edges, or with faces
 *  within `tangentDeg` of each other tangent; null where the mesh for this
 *  topology is not at hand. */
const joinsRead = new WeakMap<Topology, Map<number | undefined, Map<number, EdgeJoin>>>()
function joinsOf(t: Topology, tangentDeg?: number): Map<number, EdgeJoin> | null {
  const known = joinsRead.get(t)?.get(tangentDeg)
  if (known) return known
  let mesh = meshOfTopology.get(t)
  const s = reverseSession()
  if (!mesh && s) for (const [id, x] of s.topologies) if (x === t) mesh = s.meshes.get(id)
  if (!mesh?.faceHash) return null
  const joins = edgeJoins(mesh, t, tangentDeg)
  const byDeg = joinsRead.get(t) ?? new Map<number | undefined, Map<number, EdgeJoin>>()
  byDeg.set(tangentDeg, joins)
  joinsRead.set(t, byDeg)
  return joins
}

/** What each pick by index or by query landed on while a change is read
 *  — told back in its answer (picked), so an index gone stale shows. */
let pickLog: Json[] | null = null

/** How many indices a query's row in picked lists. */
const PICKED_CAP = 40

function logPick(row: Json): void {
  if (!pickLog) return
  const key = JSON.stringify(row)
  if (!pickLog.some((r) => JSON.stringify(r) === key)) pickLog.push(row)
}

/** Picks noted from here on, for a change's answer. */
export function startPickLog(): void {
  pickLog = []
}

/** The picks noted since startPickLog, and the log closed. */
export function takePickLog(): Json[] {
  const out = pickLog ?? []
  pickLog = null
  return out
}

const faceRow = (f: FaceInfo, i: number): Json => {
  const fp = f.fingerprint
  return { face: i, kind: fp.kind, area: round3(fp.area), ...(fp.radius !== undefined ? { radius: round3(fp.radius) } : {}), centroid: fp.centroid.map(round3) }
}

const edgeRow = (e: EdgeInfo, i: number): Json => {
  const fp = e.fingerprint
  return { edge: i, kind: fp.kind, length: round3(fp.length), ...(fp.radius !== undefined ? { radius: round3(fp.radius) } : {}), mid: fp.mid.map(round3) }
}

/** The faces a list of picks names — each by index, by fingerprint, or by
 *  a query standing for every face that answers it — no face twice. */
export function facesPicked(s: ReverseSession, body: BodyInfo, picks: readonly FacePickIn[]): FaceInfo[] {
  const out: FaceInfo[] = []
  for (const given of picks) {
    const p = unwrapped(given, 'face')
    const t = topologyOf(s, body)
    const found = isWhere(p) ? wherePicks(p, t, 'face', body).map((i) => t.faces[i]) : [facePicked(s, body, p)]
    for (const f of found) if (!out.some((x) => (x.hash >= 0 ? x.hash === f.hash : x === f))) out.push(f)
  }
  return out
}

/** The edges a list of picks names. With `chain` — a round's or a
 *  chamfer's picks — the edges the kernel's tangent chain brings in that
 *  were not picked are told back too (picked: adds). */
export function edgesPicked(s: ReverseSession, body: BodyInfo, picks: readonly EdgePickIn[], chain?: 'round' | 'bevel'): EdgeInfo[] {
  const out: EdgeInfo[] = []
  for (const given of picks) {
    const p = unwrapped(given, 'edge')
    const t = topologyOf(s, body)
    const found = isWhere(p) ? wherePicks(p, t, 'edge', body).map((i) => t.edges[i]) : [edgePicked(s, body, p)]
    for (const e of found) if (!out.some((x) => (x.hash >= 0 ? x.hash === e.hash : x === e))) out.push(e)
  }
  const adds = chain && pickLog ? addsOut(topologyOf(s, body), out, chain) : null
  if (adds) logPick(adds)
  return out
}

/** The edges a round or a chamfer takes with those picked: the kernel
 *  rounds a tangent chain whole, so an edge running on tangent from one
 *  picked — a visor's edge past the bezel's — is rounded too. By index
 *  and middle, so the agent sees them before the build. */
export function chainAdds(t: Topology, picked: readonly EdgeInfo[]): EdgeInfo[] {
  const hashes = picked.filter((e) => e.hash >= 0).map((e) => e.hash)
  if (hashes.length === 0) return []
  const mine = new Set(hashes)
  const chain = new Set(tangentChain(t.edges, hashes, splitEdges(t)))
  return t.edges.filter((e) => chain.has(e.hash) && !mine.has(e.hash))
}

function addsOut(t: Topology, picked: readonly EdgeInfo[], chain: 'round' | 'bevel'): Json | null {
  const adds = chainAdds(t, picked)
  if (adds.length === 0) return null
  const shown = adds.slice(0, PICKED_CAP)
  return {
    adds: adds.length,
    edges: shown.map((e) => t.edges.indexOf(e)),
    mids: shown.map((e) => e.fingerprint.mid.map(round3)),
    note: `the kernel ${chain === 'round' ? 'rounds' : 'bevels'} each tangent chain whole: ${adds.length} edge${adds.length === 1 ? '' : 's'} not picked ${adds.length === 1 ? 'runs' : 'run'} on tangent from those picked and ${adds.length === 1 ? 'is' : 'are'} ${chain === 'round' ? 'rounded' : 'bevelled'} with them.`,
  }
}

/** A face of a body as a click on it gives it: by its index in
 *  reverse.body.describe, or by a fingerprint, found on the body as it
 *  stands if it is there and taken as it is if not — the build finds it
 *  again by it. A query names the one face that answers it. */
export function facePicked(s: ReverseSession, body: BodyInfo, given: FacePickIn): FaceInfo {
  const pick = unwrapped(given, 'face')
  const t = topologyFor(s, body.id)
  if (isWhere(pick)) {
    const t = topologyOf(s, body)
    const hits = wherePicks(pick, t, 'face', body)
    if (hits.length > 1) invalid(`${hits.length} faces of ${body.name} answer ${JSON.stringify(pick)}, and one is needed here — narrow the query, or pick by index.`)
    return t.faces[hits[0]]
  }
  if (typeof pick === 'number') {
    const face = t?.faces[pick]
    if (!face) throw new CommandError('not_found', `${body.name} has no face ${pick} — it has ${t?.faces.length ?? 0}; reverse.body.describe lists them.`)
    logPick(faceRow(face, pick))
    return face
  }
  const i = t ? matchFace(pick, t.faces.map((f) => f.fingerprint), toleranceFor(s, body.id)) : null
  return t && i !== null ? t.faces[i] : { hash: -1, fingerprint: pick }
}

export function edgePicked(s: ReverseSession, body: BodyInfo, given: EdgePickIn): EdgeInfo {
  const pick = unwrapped(given, 'edge')
  const t = topologyFor(s, body.id)
  if (isWhere(pick)) {
    const t = topologyOf(s, body)
    const hits = wherePicks(pick, t, 'edge', body)
    if (hits.length > 1) invalid(`${hits.length} edges of ${body.name} answer ${JSON.stringify(pick)}, and one is needed here — narrow the query, or pick by index.`)
    return t.edges[hits[0]]
  }
  if (typeof pick === 'number') {
    const edge = t?.edges[pick]
    if (!edge) throw new CommandError('not_found', `${body.name} has no edge ${pick} — it has ${t?.edges.length ?? 0}; reverse.body.describe lists them.`)
    logPick(edgeRow(edge, pick))
    return edge
  }
  const i = t ? matchEdge(pick, t.edges.map((e) => e.fingerprint), toleranceFor(s, body.id)) : null
  return t && i !== null ? t.edges[i] : { hash: -1, fingerprint: pick, faces: [], ends: [pick.mid, pick.mid], endTangents: [pick.dir, pick.dir], polyline: new Float32Array(0) }
}

/** A plane as given: a coordinate plane by name — "XY", "YZ", "ZX" or
 *  "XZ", any case, with or without "plane" (parsePlaneName) — taken as
 *  { kind: "world", axis } (XY → z, YZ → x, ZX and XZ → y); anything
 *  else as it came. */
export function planeInput(p: unknown): Json {
  if (typeof p !== 'string') return p as Json
  const axis = parsePlaneName(p)
  if (!axis) invalid(`“${p}” is no coordinate plane — give "XY", "YZ" or "XZ" ("ZX" too), or a plane: { kind: "world", axis }, { kind: "section", id }, …`)
  return { kind: 'world', axis }
}

/** A plane as the feature list stores it. A section, a plane element and
 *  the element a radial plane turns about are taken by id or by name; a
 *  coordinate plane by name too (planeInput). */
export function planeOf(s: ReverseSession, given: Json | string): PlaneRef {
  const p = planeInput(given)
  const offset = p.offset ? { offset: p.offset as number } : {}
  const up = p.up as WorldAxis | undefined
  // The u `up` gives on a plane of this normal — refused where up runs
  // along the normal and has no way up the plane.
  const upOn = (normal: Vec3): { up?: WorldAxis } => {
    if (!up) return {}
    if (!upU(up, normal)) invalid(`up: ${up.toUpperCase()} runs along the plane’s normal and has no way up it — give one of the other two.`)
    return { up }
  }
  const named = (what: string): number | string => {
    const given = (p.id ?? p.name) as number | string | undefined
    if (given === undefined) invalid(`Give the ${what} by id or by name.`)
    return given!
  }
  switch (p.kind) {
    case 'world': {
      const axis = p.axis as WorldAxis
      return { kind: 'world', axis, offset: (p.offset as number | undefined) ?? 0, ...upOn(worldAxisDir(axis)) }
    }
    case 'section': {
      const sec = findSection(named('section'))
      return { kind: 'section', id: sec.id, ...offset, ...upOn(sec.frame.normal) }
    }
    case 'plane': {
      const e = findElement(named('plane'))
      if (e.fit?.kind !== 'plane') invalid(`${e.name} is a ${e.kind}, not a plane.`)
      return { kind: 'plane', id: e.id, ...offset, ...upOn((e.fit as Extract<FitData, { kind: 'plane' }>).normal) }
    }
    case 'radial': {
      const a = (p.axis ?? {}) as Json
      let axis: Extract<AxisRef, { kind: 'element' | 'world' }>
      if (a.kind === 'world') axis = { kind: 'world', axis: a.axis as WorldAxis }
      else {
        const given = (a.id ?? a.name) as number | string | undefined
        if (given === undefined) invalid('axis: give the element by id or by name, or { kind: "world", axis }.')
        const e = findElement(given!)
        if (!e.fit || !RADIAL_AXIS_KINDS.includes(e.kind)) invalid(`${e.name} is a ${e.kind}, with no axis to lay a plane through — a line, cylinder, cone or circle has one.`)
        axis = { kind: 'element', id: e.id }
      }
      if (!Number.isFinite(p.angleDeg)) invalid('angleDeg: give the angle about the axis in degrees.')
      return { kind: 'radial', axis, angleDeg: p.angleDeg as number, ...offset }
    }
    case 'bodyFace': {
      const body = bodyNamed(p.body as Ref)
      const face = facePicked(s, body, p.face as FacePickIn)
      const plane = bodyFacePlane(body.id, face.fingerprint)
      if (!plane) invalid(`That face of ${body.name} is a ${face.fingerprint.kind}, not flat — a plane is a flat face.`)
      // Off the face: the plane's frame moved out with it.
      const placed = p.offset ? withPlaneOffset({ plane: plane!, frame: plane!.frame }, p.offset as number).plane : plane!
      if (!up || placed.kind !== 'bodyFace') return placed
      // Turned so that `up` runs up it: the face's frame is the sketch's,
      // and a rebuild keeps the u it was given.
      upOn(placed.frame.normal)
      const basisU = upU(up, placed.frame.normal)!
      return { ...placed, frame: { ...placed.frame, basisU, basisV: cross(placed.frame.normal, basisU) } }
    }
    default:
      return invalid(`A plane of kind “${String(p.kind)}” cannot be given.`)
  }
}

export function mirrorPlaneOf(s: ReverseSession, given: Json | string, body: BodyInfo): MirrorPlane {
  const p = planeInput(given)
  if (p.kind !== 'face') return planeOf(s, p)
  const face = facePicked(s, body, p.face as FacePickIn)
  if (face.fingerprint.kind !== 'plane') invalid(`That face of ${body.name} is not flat.`)
  return { kind: 'face', face: face.fingerprint }
}

export function axisOf(a: Json, sketch?: SketchFeature): AxisRef {
  if (a.kind === 'world') return { kind: 'world', axis: a.axis as 'x' | 'y' | 'z' }
  if (a.kind === 'sketchLine') {
    const e = sketch?.sketch.entities.find((x) => x.id === a.entity)
    if (!sketch) invalid('A sketch line is an axis only for a feature made from that sketch.')
    if (!e || e.kind !== 'line') invalid(`${sketch!.name} has no line ${a.entity as number}.`)
    return { kind: 'sketchLine', entity: a.entity as number }
  }
  const e = elementNamed(a, 'axis')
  if (!e.fit || !['line', 'cylinder', 'cone', 'circle'].includes(e.fit.kind)) invalid(`${e.name} has no axis — a line, a cylinder, a cone or a circle has.`)
  return { kind: 'element', id: e.id }
}

/** The element of 3D Measure a field names by its id or its name — in
 *  `id`, or in `name` beside it — as every command finds one (findElement). */
export function elementNamed(a: Json, what: string) {
  const given = (a.id ?? a.name) as number | string | undefined
  if (given === undefined) invalid(`${what}: give the element by id or by name.`)
  return findElement(given!)
}

/** The regions of a sketch an extrude or a revolve picks, by their keys. */
export function regionKeys(s: ReverseSession, sketch: SketchFeature, pick: unknown): string[] {
  const regions = s.regionsOf(sketch)
  const listed = () => JSON.stringify(regionsOut(regions))
  if (regions.length === 0) invalid(`${sketch.name} has no closed region — its pieces have to close a loop, their ends coincident.`)
  if (pick === undefined) {
    if (regions.length === 1) return [regions[0].key]
    invalid(`${sketch.name} has ${regions.length} closed regions — say which in regions ("all", "largest", their keys, or a point inside each): ${listed()}`)
  }
  if (pick === 'all') return regions.map((r) => r.key)
  if (pick === 'largest') return [regions.reduce((a, b) => (b.area > a.area ? b : a)).key]
  return (pick as (string | { at: Vec2 } | Vec2)[]).map((p) => {
    if (typeof p === 'string') {
      if (!regions.some((r) => r.key === p)) throw new CommandError('not_found', `${sketch.name} has no region ${p} — it has ${listed()}`)
      return p
    }
    // A bare [u, v] is the point { at } names.
    const at = Array.isArray(p) ? p : p.at
    const r = regionAt(regions, at)
    if (!r) throw new CommandError('not_found', `No region of ${sketch.name} holds the point [${at.join(', ')}] — it has ${listed()}`)
    return r.key
  })
}

/** What an extrude or a revolve given regions "largest" is told when the
 *  region that rule takes is the hole of another — a ring's inside, larger
 *  by area than a thin ring round it, so a sleeve's profile makes a solid
 *  block. The rule stands; the answer says so, with the ring's point and
 *  key to give instead. Undefined for any other pick, or a region in no
 *  other. Said by the command that took it, not by the rebuilds after. */
export function largestInside(s: ReverseSession, sketch: SketchFeature, pick: unknown): string | undefined {
  if (pick !== 'largest') return undefined
  const regions = s.regionsOf(sketch)
  if (regions.length < 2) return undefined
  const taken = regions.reduce((a, b) => (b.area > a.area ? b : a))
  // The ring it is the hole of: of those whose hole holds it, the one
  // round it nearest — the smallest such hole.
  let host: { r: (typeof regions)[number]; hole: number } | null = null
  for (const r of regions) {
    if (r === taken) continue
    for (const h of r.holes) {
      if (!pointInPolygon(taken.inside, h.polygon)) continue
      const hole = Math.abs(signedArea2(h.polygon))
      if (!host || hole < host.hole) host = { r, hole }
    }
  }
  if (!host) return undefined
  const at = (p: Vec2) => `[${p.map(round3).join(', ')}]`
  // units-ok: the answer's warning, for the agent — in millimetres always.
  return `"largest" took region ${taken.key} (${round3(taken.area)} mm²), the inside of region ${host.r.key} (${round3(host.r.area)} mm²): a ring's hole, larger by area than the ring round it, made solid. For the ring alone give regions: [{ at: ${at(host.r.inside)} }] or ["${host.r.key}"]; "all" fills the whole outline.`
}

/** A region pick as the feature keeps it, to be taken again as given when
 *  its sketch is edited (RegionPick, core/features.ts): "all", "largest",
 *  or a list with a point in it — a bare [u, v] as { at } — with the keys
 *  it came to. Undefined for keys alone, or none given: the keys are the
 *  pick, matched again by their pieces and by place. */
export function regionPickOf(pick: unknown, keys: readonly string[]): RegionPick | undefined {
  if (pick === 'all' || pick === 'largest') return { given: pick, keys: [...keys] }
  if (!Array.isArray(pick) || pick.every((p) => typeof p === 'string')) return undefined
  const given = (pick as (string | { at: Vec2 } | Vec2)[]).map((p) => (typeof p === 'string' ? p : { at: [...(Array.isArray(p) ? p : p.at)] as Vec2 }))
  return { given, keys: [...keys] }
}

/** The queries among a list of face or edge picks, each made ready for a
 *  feature to keep with what it names now (core/where.ts): run on the body
 *  as the picks were — as it stood before the feature, for an edit — and
 *  run again by the build on the body as it stands then. Undefined where
 *  no pick is a query. */
export function storedPicks<F extends FaceFingerprint | EdgeFingerprint>(s: ReverseSession, body: BodyInfo, picks: readonly unknown[], what: 'face' | 'edge'): StoredPick<F>[] | undefined {
  const out: StoredPick<F>[] = []
  for (const given of picks) {
    const p = unwrapped(given, what)
    if (typeof p === 'number' || !isWhere(p)) continue
    const t = topologyOf(s, body)
    const hits = whereIndices(p, t, body, what)
    const found = hits.map((i) => (what === 'face' ? t.faces[i] : t.edges[i]).fingerprint as F)
    out.push({ where: storedWhere(p, t, what, (ref) => featureNamed(ref).id), found })
  }
  return out.length > 0 ? out : undefined
}

/** The indices of a body's faces, or edges, a query names, on the part as
 *  the page holds it: madeBy by the feature's name or id, sharp read off
 *  the body's mesh — see core/where.ts. */
export function whereIndices(given: Where, t: Topology, body: { name: string }, what: 'face' | 'edge'): number[] {
  return coreWhereIndices(given, t, body, what, pageAsk(t))
}

/** What a query asks of the page: the feature a madeBy names, and how the
 *  faces meet along each edge, off the mesh. */
function pageAsk(t: Topology): WhereAsk {
  return {
    featureId: (ref) => featureNamed(ref).id,
    sharp: (deg) => {
      const joins = joinsOf(t, deg)
      return joins ? (i) => joins.get(t.edges[i].hash) === 'sharp' : null
    },
  }
}

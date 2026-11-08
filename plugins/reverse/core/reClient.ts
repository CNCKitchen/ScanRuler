// SPDX-License-Identifier: AGPL-3.0-only
// Main-thread handle on the kernel worker: typed promises over the message
// protocol in reService.ts, requests matched by id, the worker itself
// running them one at a time. Only the latest build counts — a rebuild
// asked for while one is running makes the earlier answer stale, and the
// caller is told so by a null. Between the answers the worker tells what
// its kernels are at (reEvents.ts), which names a build that does not
// finish (playing). Under Node the requests go to the same service in this
// thread instead (reLocal.ts).

import type { Vec3 } from '../../../src/core/types'
import { WorkerRpc } from '../../../src/core/workerRpc'
import type { Rigid } from '../../../src/core/deviation/rigid'
import type { KernelMesh, StepCheck, StepLabel, StepMend } from './kernel'
import type { BodyCheck, BuiltBody, DrawnBody, EdgeInfo, FaceInfo, FeatureResult, FilletTries, Overlap, PreviewResult, PreviewStep } from './build'
import type { CompareDetail, PatchRequest } from './compareDetail'
import type { BodyProbe, CutPiece } from './kernelProbe'
import type { BuildStep } from './features'
import type { ScanSide, SparseField } from './liveMap'
import { isKernelEvent, type ReWorkerEvent } from './reEvents'
import type { ReWorkerRequest, ReWorkerResponse } from './reService'
import type { Sketch } from './sketch'

export interface BuildAnswer {
  results: FeatureResult[]
  /** Every body standing, in order — a body the build left as it was is
   *  the very object the build before handed back, mesh and all. One
   *  without its topology yet has it read after (topologies). */
  bodies: DrawnBody[]
  /** The ids of the bodies the worker handed over this time: the ones the
   *  build made or changed. */
  changed: number[]
}

/** A preview that failed where the builder could say where: the message
 *  carries the sentence, `where` the edges or outlines to draw red. */
export class PreviewFailure extends Error {
  constructor(
    message: string,
    readonly where: Float32Array[],
  ) {
    super(message)
  }
}

/** How the requests reach the kernel: the worker, or a service in this
 *  thread. Rejects a request the kernel answered with an error. */
export interface ReTransport {
  /** `limitMs`: how long the request may wait for its answer once the
   *  ones before it are answered — see WorkerRpc.request. */
  request<T>(msg: { requestId: number }, transfer: Transferable[], limitMs?: number): Promise<T>
  dispose(): void
  /** The kernel went away for good — every request after fails. */
  onFailure: ((message: string) => void) | null
  /** Hears what the kernels are at between the answers (reEvents.ts) —
   *  set by the client. */
  onEvent?: ((event: ReWorkerEvent) => void) | null
}

/** A build the kernel has not answered, as the worker last told it: the
 *  step in play the longest, on whichever kernel — null between steps, or
 *  before the worker got to the build — and the kernel call it is in. */
export interface BuildInPlay {
  step: BuildStep | null
  /** How long the step has been in play, ms; with none, how long since
   *  the build was asked for. */
  ms: number
  /** The kernel call it is in, by the name its errors go by ("Splitting"),
   *  when one has been heard. */
  call: string | null
  /** How long since the build was asked for, ms. */
  buildMs: number
  /** How long since the worker was last heard from — an answer, a step,
   *  a call — ms. */
  quietMs: number
  /** Whether the kernel's own steps of the build had begun: with no step in
   *  play, it is past the last of them — meshing the bodies, say — rather
   *  than before the first. */
  played: boolean
}

/** How many steps' times the client keeps. */
const PLAYED_KEPT = 5000

/** How long a request other than a build may take once the kernel gets to
 *  it, so that one the worker never answers fails the command waiting on it
 *  rather than hold it for good: a read of the last build — a stage, a
 *  check, a cut — and one that walks the scan or writes the file. A build,
 *  and the bodies it asks for after, have none here: the session's
 *  settled() holds them to its own. */
const READ_MS = 60_000
const HEAVY_MS = 300_000

export class ReClient {
  private rpc: ReTransport
  onFailure: ((message: string) => void) | null = null
  private nextId = 1
  private latestBuild = 0
  private latestPreview = 0
  private latestMap = 0
  /** The STEP files the worker has been handed, by key — each goes once. */
  private sentFiles = new Set<string>()
  /** The bodies the worker has handed over, by id, as the last answer
   *  left them — what a build tells it the page holds, so it hands over
   *  only the bodies it made, changed or took away. Kept from every
   *  answer, an overtaken one's too: the worker does not know which the
   *  page threw away. */
  private held = new Map<number, DrawnBody>()
  /** What the builds this client asked for did with their steps, all told —
   *  played, or taken up from a state the kernel held — an overtaken
   *  build's too: the kernel did that work. */
  readonly steps = { recomputed: 0, restored: 0, builds: 0 }
  /** The steps those builds played, in order, with their times — the
   *  newest kept, for a change to say which of its own took how long. */
  readonly played: { id: number; ms: number }[] = []
  /** The steps the kernel crashed on, by key, with what it said — kept here
   *  too, as the worker answers them, for a client after this one: a stop
   *  lets the worker that held them go (reService.ts withoutCrashed). */
  readonly crashed = new Map<string, string>()
  /** The builds asked for and not answered, by request: their steps, which
   *  a step told in play is found among, and when each was asked (ms since
   *  the epoch). */
  private asked = new Map<number, { steps: readonly BuildStep[]; at: number }>()
  /** What each kernel is at, as the worker last told (reEvents.ts): by
   *  kernel — 0 the worker's own, n the n-th helper — the request, the
   *  step in play (null between steps) and since when, the kernel call
   *  last heard, and whether a step of the request has been told. */
  private atWork = new Map<number, { requestId: number; step: number | null; since: number; call: string | null; told: boolean }>()
  /** When the worker was last heard from, ms since the epoch. */
  private lastHeard = Date.now()

  constructor(transport?: ReTransport) {
    this.rpc = transport ?? new WorkerRpc(() => new Worker(new URL('./reWorker.ts', import.meta.url), { type: 'module' }), 'CAD kernel worker', (data) => this.heard(data))
    this.rpc.onFailure = (message) => this.onFailure?.(message)
    if (transport) transport.onEvent = (e) => void this.heard(e)
  }

  /** A message from the worker: noted as heard from, and taken in when it
   *  tells what a kernel is at — true then, so it answers no request. */
  private heard(data: unknown): boolean {
    this.lastHeard = Date.now()
    if (!isKernelEvent(data)) return false
    const e = data as ReWorkerEvent
    const kernel = e.helper ?? 0
    const was = this.atWork.get(kernel)
    const at = was?.requestId === e.requestId ? was : { requestId: e.requestId, step: null, since: this.lastHeard, call: null, told: false }
    if (e.event === 'step') this.atWork.set(kernel, { ...at, step: e.id, since: this.lastHeard, call: null, told: true })
    else this.atWork.set(kernel, { ...at, call: e.what })
    return true
  }

  private request<T>(msg: ReWorkerRequest, transfer: Transferable[] = [], limitMs?: number): Promise<T> {
    // Answered or let go, the request is done with here, on every kernel;
    // only an answer says the worker is there.
    const done = () => {
      this.asked.delete(msg.requestId)
      for (const [kernel, at] of this.atWork) if (at.requestId === msg.requestId) this.atWork.delete(kernel)
    }
    return this.rpc
      .request<T>(msg, transfer, limitMs)
      .then((answer) => {
        this.lastHeard = Date.now()
        return answer
      })
      .finally(done)
  }

  /** The build the kernel is at, or null when every build asked for has
   *  been answered — see BuildInPlay. */
  playing(): BuildInPlay | null {
    if (this.asked.size === 0) return null
    const now = Date.now()
    const quietMs = now - this.lastHeard
    let on: { requestId: number; step: number; since: number; call: string | null; told: boolean } | null = null
    for (const at of this.atWork.values()) {
      if (at.step === null || !this.asked.has(at.requestId)) continue
      if (!on || at.since < on.since) on = { ...at, step: at.step }
    }
    if (on) {
      const asked = this.asked.get(on.requestId)!
      const id = on.step
      return { step: asked.steps.find((s) => s.id === id) ?? null, ms: now - on.since, call: on.call, buildMs: now - asked.at, quietMs, played: true }
    }
    const first = Math.min(...[...this.asked.values()].map((a) => a.at))
    const own = this.atWork.get(0)
    const mine = own && this.asked.has(own.requestId) ? own : null
    return { step: null, ms: now - first, call: mine?.call ?? null, buildMs: now - first, quietMs, played: mine?.told ?? false }
  }

  /** Load the kernel; resolves with its version once it can build. */
  async init(): Promise<string> {
    const requestId = this.nextId++
    const res = await this.request<Extract<ReWorkerResponse, { type: 'init-ok' }>>({ type: 'init', requestId })
    return res.version
  }

  /** The STEP files the steps name that the worker has not been handed
   *  yet, taken from `files` — what goes with the request. */
  private filesFor(steps: readonly (BuildStep | PreviewStep)[], files: ReadonlyMap<string, string> | undefined): [string, string][] {
    const out: [string, string][] = []
    for (const s of steps) {
      if (s.kind !== 'import' || this.sentFiles.has(s.file)) continue
      const text = files?.get(s.file)
      if (text === undefined) continue
      this.sentFiles.add(s.file)
      out.push([s.file, text])
    }
    return out
  }

  /** Build the feature list. Resolves null when a newer build has been
   *  asked for since — the answer is for a list that no longer stands.
   *  `stepFiles` holds the text of every STEP file an Import names, by
   *  key; the worker is handed each one once. */
  async build(steps: BuildStep[], sketches: Map<number, Sketch>, stepFiles?: ReadonlyMap<string, string>): Promise<BuildAnswer | null> {
    const requestId = this.nextId++
    this.latestBuild = requestId
    const files = this.filesFor(steps, stepFiles)
    this.asked.set(requestId, { steps, at: Date.now() })
    const res = await this.request<Extract<ReWorkerResponse, { type: 'build-ok' | 'skipped' }>>({
      type: 'build',
      requestId,
      steps,
      sketches: [...sketches.entries()],
      ...(files.length > 0 ? { stepFiles: files } : {}),
      have: [...this.held].map(([id, b]) => [id, b.key]),
      ...(this.crashed.size > 0 ? { crashed: [...this.crashed] } : {}),
    })
    if (res.type === 'skipped') return null
    for (const [key, why] of res.crashed ?? []) this.crashed.set(key, why)
    this.steps.recomputed += res.steps.recomputed
    this.steps.restored += res.steps.restored
    this.steps.builds++
    this.played.push(...res.steps.played)
    if (this.played.length > PLAYED_KEPT) this.played.splice(0, this.played.length - PLAYED_KEPT)
    for (const b of res.bodies) this.held.set(b.id, b)
    const standing = new Set(res.all.map((b) => b.id))
    for (const id of [...this.held.keys()]) if (!standing.has(id)) this.held.delete(id)
    if (requestId !== this.latestBuild) return null
    const changed = res.bodies.map((b) => b.id)
    // A body the page holds at another key than the build says: an answer
    // came in between this build's request and its own — the page asked
    // with what it held then. Those bodies asked for again, whole.
    const missing = res.all.filter((b) => this.held.get(b.id)?.key !== b.key).map((b) => b.id)
    if (missing.length > 0) {
      const more = await this.request<Extract<ReWorkerResponse, { type: 'bodies-ok' }>>({ type: 'bodies', requestId: this.nextId++, ids: missing })
      if (requestId !== this.latestBuild) return null
      for (const b of more.bodies) this.held.set(b.id, b)
      changed.push(...more.bodies.map((b) => b.id))
      const still = res.all.find((b) => this.held.get(b.id)?.key !== b.key)
      if (still) throw new Error(`The CAD kernel no longer holds body ${still.id} as it was built.`)
    }
    return { results: res.results, bodies: res.all.map((b) => this.held.get(b.id)!), changed }
  }

  /** The topology of bodies a build handed over without it, by id, each
   *  with the key it stands for — and given to the body held at that key,
   *  so a build after that leaves it as it was hands it over with it. */
  async topologies(ids: number[]): Promise<{ id: number; key: string; topology: BuiltBody['topology'] }[]> {
    const res = await this.request<Extract<ReWorkerResponse, { type: 'topologies-ok' }>>({ type: 'topologies', requestId: this.nextId++, ids })
    for (const t of res.topologies) {
      const held = this.held.get(t.id)
      if (held?.key === t.key) held.topology = t.topology
    }
    return res.topologies
  }

  /** The ghost of a feature being set up: the solid its step would make,
   *  meshed. Null when a newer preview has been asked for since — a drag
   *  asks many times a second and only the last answer is worth drawing. */
  async preview(step: PreviewStep, sketch: Sketch | undefined, stepFiles?: ReadonlyMap<string, string>): Promise<PreviewResult | null> {
    const requestId = this.nextId++
    this.latestPreview = requestId
    const files = this.filesFor([step], stepFiles)
    const res = await this.request<Extract<ReWorkerResponse, { type: 'preview-ok' | 'preview-failed' | 'skipped' }>>({
      type: 'preview',
      requestId,
      step,
      sketch: sketch ?? null,
      ...(files.length > 0 ? { stepFiles: files } : {}),
    }, [], HEAVY_MS)
    if (res.type === 'skipped' || requestId !== this.latestPreview) return null
    if (res.type === 'preview-failed') throw new PreviewFailure(res.message, res.where)
    return res.preview
  }

  /** A body as it stood before one of the last build's features, for
   *  editing that feature on it: null when the feature did not run on
   *  that body. */
  async stage(stepId: number, bodyId: number): Promise<{ mesh: KernelMesh; topology: { faces: FaceInfo[]; edges: EdgeInfo[] } } | null> {
    const requestId = this.nextId++
    const res = await this.request<Extract<ReWorkerResponse, { type: 'stage-ok' }>>({ type: 'stage', requestId, stepId, bodyId }, [], READ_MS)
    return res.stage
  }

  /** Hand the worker the scan for the live map — the positions are
   *  transferred, so pass a copy — or only a new transform for the scan it
   *  has; null puts the scan away. The normals, when there are no
   *  triangles to work them out from. */
  async setScan(positions: Float32Array | null | undefined, transform: Rigid | null, indices?: Uint32Array | null, normals?: Float32Array | null): Promise<void> {
    const requestId = this.nextId++
    const transfer: Transferable[] = []
    if (positions) transfer.push(positions.buffer)
    if (indices) transfer.push(indices.buffer)
    if (normals) transfer.push(normals.buffer)
    await this.request<Extract<ReWorkerResponse, { type: 'scan-ok' }>>({ type: 'scan', requestId, positions, indices, ...(normals ? { normals } : {}), transform }, transfer, HEAVY_MS)
  }

  /** The live map against the last preview's solid or against bodies of
   *  the last build. Null when a newer map has been asked for since. */
  async map(source: 'preview' | 'bodies', bodyIds: number[], range: number): Promise<SparseField | null> {
    const requestId = this.nextId++
    this.latestMap = requestId
    const res = await this.request<Extract<ReWorkerResponse, { type: 'map-ok' }>>({ type: 'map', requestId, source, bodyIds, range }, [], HEAVY_MS)
    if (requestId !== this.latestMap) return null
    return res.field
  }

  /** The scan against bodies of the last build in detail: the field, each
   *  face's reading and the worst spots — see compareDetail.ts — with
   *  `side`, the scan read by the way it faces. */
  async compare(bodyIds: number[], range: number, spots: number, patches?: PatchRequest, within?: { min: Vec3; max: Vec3 }, far?: number, side?: Omit<ScanSide, 'normals'>): Promise<CompareDetail> {
    const requestId = this.nextId++
    const res = await this.request<Extract<ReWorkerResponse, { type: 'compare-ok' }>>({ type: 'compare', requestId, bodyIds, range, spots, ...(patches ? { patches } : {}), ...(within ? { within } : {}), ...(far !== undefined ? { far } : {}), ...(side ? { side } : {}) }, [], HEAVY_MS)
    return res.detail
  }

  /** A body of the last build looked over — see Builder.check; with
   *  `roundTrip`, written as STEP and read back too. Null for a body that
   *  is not there. */
  async check(bodyId: number, tinyArea: number, before?: number, roundTrip?: boolean | 'find'): Promise<BodyCheck | null> {
    const requestId = this.nextId++
    const res = await this.request<Extract<ReWorkerResponse, { type: 'check-ok' }>>({ type: 'check', requestId, bodyId, tinyArea, ...(before !== undefined ? { before } : {}), ...(roundTrip ? { roundTrip } : {}) }, [], roundTrip ? HEAVY_MS : READ_MS)
    return res.check
  }

  /** A round or a chamfer of the last build tried at other sizes, nothing
   *  kept — see Builder.filletTry. */
  async filletTry(stepId: number, sizes: number[]): Promise<FilletTries> {
    const requestId = this.nextId++
    const res = await this.request<Extract<ReWorkerResponse, { type: 'fillet-try-ok' }>>({ type: 'fillet-try', requestId, stepId, sizes }, [], HEAVY_MS)
    return res.tried
  }

  /** The given solid bodies of the last build, meshed to a chord — with
   *  `sheets`, the sheets among them too. */
  async referenceMeshes(bodyIds: number[], chord: number, sheets = false): Promise<KernelMesh[]> {
    const requestId = this.nextId++
    const res = await this.request<Extract<ReWorkerResponse, { type: 'reference-ok' }>>({ type: 'reference', requestId, bodyIds, chord, ...(sheets ? { sheets } : {}) }, [], HEAVY_MS)
    return res.meshes
  }

  /** How two bodies stand to each other: the gap between them, or the
   *  volume they share. */
  async clearance(a: number, b: number): Promise<{ gap: number; overlap: number }> {
    const requestId = this.nextId++
    const res = await this.request<Extract<ReWorkerResponse, { type: 'clearance-ok' }>>({ type: 'clearance', requestId, a, b }, [], READ_MS)
    return { gap: res.gap, overlap: res.overlap }
  }

  /** The given bodies cut by a plane, each one's section as the kernel's
   *  own edges — see Builder.sectionPieces. */
  async bodySection(bodyIds: number[], origin: Vec3, normal: Vec3, deflection: number): Promise<{ id: number; pieces: CutPiece[] }[]> {
    const requestId = this.nextId++
    const res = await this.request<Extract<ReWorkerResponse, { type: 'body-section-ok' }>>({ type: 'body-section', requestId, bodyIds, origin, normal, deflection }, [], READ_MS)
    return res.bodies
  }

  /** Points and rays read against each of the given bodies — see
   *  Builder.probe. */
  async bodyProbe(bodyIds: number[], points: Vec3[], rays: { from: Vec3; dir: Vec3 }[]): Promise<BodyProbe[]> {
    const requestId = this.nextId++
    const res = await this.request<Extract<ReWorkerResponse, { type: 'body-probe-ok' }>>({ type: 'body-probe', requestId, bodyIds, points, rays }, [], READ_MS)
    return res.bodies
  }

  /** Where the given bodies of the last build run into each other — see
   *  Builder.overlaps. Null when a build has been asked for since: the
   *  bodies it answers for may not be the ones standing when it lands. */
  async overlaps(bodyIds: number[], budget: number): Promise<{ overlaps: Overlap[]; done: boolean } | null> {
    const requestId = this.nextId++
    const build = this.latestBuild
    const res = await this.request<Extract<ReWorkerResponse, { type: 'overlaps-ok' }>>({ type: 'overlaps', requestId, bodyIds, budget }, [], READ_MS)
    if (this.latestBuild !== build) return null
    return { overlaps: res.overlaps, done: res.done }
  }

  /** The bodies as one STEP file — each a part under its label's name and
   *  colour, when labels are given (one per body). */
  async exportStep(bodyIds: number[], labels?: StepLabel[]): Promise<string> {
    return (await this.exportStepChecked(bodyIds, labels, false)).text
  }

  /** The bodies cut by a plane: each one's section as polylines in the
   *  world, sampled to `deflection` mm. */
  async sectionCut(bodyIds: number[], origin: Vec3, normal: Vec3, deflection: number): Promise<{ id: number; polylines: Float32Array[] }[]> {
    const requestId = this.nextId++
    const res = await this.request<Extract<ReWorkerResponse, { type: 'section-cut-ok' }>>({ type: 'section-cut', requestId, bodyIds, origin, normal, deflection }, [], READ_MS)
    return res.bodies
  }

  /** The same file, and with `verify` read back and held against the
   *  bodies (ReKernel.verifyStep); `mended`, the parts that read back open
   *  by hairs and were mended (ReKernel.exportStepMended). */
  async exportStepChecked(bodyIds: number[], labels: StepLabel[] | undefined, verify: boolean): Promise<{ text: string; check?: StepCheck; mended?: StepMend[] }> {
    const requestId = this.nextId++
    const res = await this.request<Extract<ReWorkerResponse, { type: 'step-ok' }>>({
      type: 'export-step',
      requestId,
      bodyIds,
      ...(labels ? { labels } : {}),
      ...(verify ? { verify } : {}),
    }, [], HEAVY_MS)
    return { text: res.text, ...(res.check ? { check: res.check } : {}), ...(res.mended ? { mended: res.mended } : {}) }
  }

  dispose(): void { this.rpc.dispose() }
}

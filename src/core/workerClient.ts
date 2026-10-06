// SPDX-License-Identifier: AGPL-3.0-only
import { WorkerRpc } from './workerRpc'
import type { MeshCentroid } from './geometry/centroid'
import type { CreaseSetting, CreaseReport } from './geometry/crease'
import type { SeedPlane, SymmetryPlane } from './symmetry'
import type { AutoAlignResult } from './autoAlign'
import type { AlignResult, PointPair } from './deviation/align'
import type { Rigid } from './deviation/rigid'
import { mmPerUnit, type MeshUnits } from './meshUnits'
import type { StepInfo } from './parsers/step'
import type { SectionCut } from './section/slice'
import type { AxialWindow, ElementKind, FitOutput, FitSettings, Vec3 } from './types'
import type { WorkerRequest, WorkerResponse } from './workerProtocol'

export interface LoadedMesh {
  positions: Float32Array
  indices: Uint32Array
  normals: Float32Array
  /** The corner slots the viewport's mesh mode draws the edges from — see
   *  geometry/wireSlots.ts. */
  wireSlots: Uint8Array
  /** The mesh's own vertices; the arrays may carry copies after them where
   *  sharp edges were split for shading — see geometry/crease.ts. */
  vertexCount: number
  triangleCount: number
}

export interface LoadedScan extends LoadedMesh {
  /** The vertex each appended copy stands in for — see geometry/crease.ts. */
  copyOf: Uint32Array
  crease: CreaseReport
}

export interface LoadedNominal extends LoadedMesh {
  bboxDiagonal: number
  /** How a STEP reference was converted; absent when the file was a mesh. */
  step?: StepInfo
}

export interface DeviationResult {
  values: Float32Array
  /** The direction each reading was taken along — see deviation/deflection.ts. */
  directions: Int8Array
  suggestedRange: number
  suggestedMaxDistance: number
}

export interface ThicknessResult {
  values: Float32Array
  suggestedLow: number
  suggestedHigh: number
}

/** What a plugin that keeps something of its own in the worker is handed
 *  to put it back after a restart — see MeshWorkerClient.onRestore. */
export interface RestoreChannel {
  /** Load a file as a staged import, as prepareScan does; its number back. */
  loadStaged(name: string, bytes: Uint8Array, crease: CreaseSetting, transform: Rigid | null, units?: MeshUnits): Promise<number>
  /** Ask a plugin's part of the worker, as pluginCall does. */
  call(plugin: string, op: string, payload: unknown): Promise<unknown>
}

/** A message that expects an answer — everything but the abort signal, which
 *  carries no id and is never replied to on its own. */
type Request = Exclude<WorkerRequest, { type: 'align-abort' }>

/** Everything about a thickness measurement that the worker needs and the
 *  panel sets — the request minus its bookkeeping. */
export type ThicknessRequest = Omit<
  Extract<WorkerRequest, { type: 'thickness' }>,
  'type' | 'requestId'
>

/** Typed promise wrapper around the mesh worker. Requests are matched by id;
 *  the worker itself processes them sequentially. */
export class MeshWorkerClient {
  private rpc: WorkerRpc
  private recovering: Promise<void> | null = null
  restoreState: (() => {
    scan: { name: string; bytes: Uint8Array; crease: CreaseSetting; transform: Rigid | null; units?: MeshUnits } | null
    nominal: { name: string; bytes: Uint8Array; units?: MeshUnits } | null
  }) | null = null
  /** What the plugins put back after a restart, once the scan and the
   *  reference are back — see onRestore. */
  private restorers: ((channel: RestoreChannel) => Promise<void>)[] = []
  private nextId = 1
  /** Async callers must not apply a result to a different imported session. */
  scanVersion = 0
  nominalVersion = 0
  onProgress: ((text: string) => void) | null = null
  /** Poses from part-way through an alignment. Not a request result — they
   *  arrive while the request is still open, so they must not settle it. */
  onAlignProgress: ((transform: Rigid, iteration: number, meanDistance: number) => void) | null =
    null

  constructor() {
    this.rpc = new WorkerRpc(() => new Worker(new URL('./meshWorker.ts', import.meta.url), { type: 'module' }), 'Mesh worker', (data) => {
      const msg = data as WorkerResponse
      if (msg.type === 'progress') { this.onProgress?.(msg.text); return true }
      if (msg.type === 'align-progress') { this.onAlignProgress?.(msg.transform, msg.iteration, msg.meanDistance); return true }
      return false
    })
  }

  private async ready(): Promise<void> {
    if (this.recovering) return this.recovering
    if (!this.rpc.dead) return
    this.recovering = (async () => {
      this.rpc.restart()
      const state = this.restoreState?.()
      if (state?.scan) {
        const { name, bytes, crease, transform, units } = state.scan
        const buffer = bytes.slice().buffer
        await this.rpc.request({ type: 'load', requestId: this.nextId++, name, buffer, crease, transform: transform ?? undefined, scale: mmPerUnit(units ?? 'mm') } as Request, [buffer])
      }
      if (state?.nominal) {
        const { name, bytes, units } = state.nominal
        const buffer = bytes.slice().buffer
        await this.rpc.request({ type: 'load-nominal', requestId: this.nextId++, name, buffer, scale: mmPerUnit(units ?? 'mm') } as Request, [buffer])
      }
      const channel: RestoreChannel = {
        loadStaged: async (name, bytes, crease, transform, units) => {
          const buffer = bytes.slice().buffer
          const id = this.nextId++
          await this.rpc.request({ type: 'load', requestId: id, name, buffer, crease, staged: true, transform: transform ?? undefined, scale: mmPerUnit(units ?? 'mm') } as Request, [buffer])
          return id
        },
        call: async (plugin, op, payload) =>
          (await this.rpc.request<{ result: unknown }>({ type: 'plugin', requestId: this.nextId++, plugin, op, payload } as Request)).result,
      }
      for (const restore of this.restorers) await restore(channel)
    })().catch((error) => {
      this.rpc.fail('The mesh worker could not restore the current models.')
      throw error
    }).finally(() => { this.recovering = null })
    return this.recovering
  }

  private async request<T>(msg: Request, transfer: Transferable[] = []): Promise<T> {
    await this.ready()
    return this.rpc.request<T>(msg, transfer)
  }

  async load(name: string, buffer: ArrayBuffer, crease: CreaseSetting): Promise<LoadedScan> {
    const requestId = this.nextId++
    return this.request<LoadedScan>({ type: 'load', requestId, name, buffer, crease }, [buffer])
  }

  async prepareScan(name: string, buffer: ArrayBuffer, crease: CreaseSetting, transform?: Rigid, units: MeshUnits = 'mm'): Promise<{ id: number; mesh: LoadedScan }> {
    const id = this.nextId++
    const mesh = await this.request<LoadedScan>({ type: 'load', requestId: id, name, buffer, crease, staged: true, transform, scale: mmPerUnit(units) }, [buffer])
    return { id, mesh }
  }

  async prepareNominal(name: string, buffer: ArrayBuffer, units: MeshUnits = 'mm'): Promise<{ id: number; mesh: LoadedNominal }> {
    const id = this.nextId++
    const mesh = await this.request<LoadedNominal>({ type: 'load-nominal', requestId: id, name, buffer, staged: true, scale: mmPerUnit(units) }, [buffer])
    return { id, mesh }
  }

  async commitImport(slots: { scan?: number | null; nominal?: number | null }): Promise<void> {
    await this.request({ type: 'commit-import', requestId: this.nextId++, ...slots })
    if (slots.scan !== undefined) this.scanVersion++
    if (slots.nominal !== undefined) this.nominalVersion++
  }

  /** Ask a plugin's part of the worker — see workerPluginApi.ts. The buffers
   *  in `transfer` are handed over rather than copied. */
  async pluginCall<T>(plugin: string, op: string, payload: unknown, transfer: Transferable[] = []): Promise<T> {
    const requestId = this.nextId++
    const res = await this.request<{ result: T }>({ type: 'plugin', requestId, plugin, op, payload }, transfer)
    return res.result
  }

  /** Put something of a plugin's back in the worker after it restarts, once
   *  the scan and the reference are back; the returned function stops it. */
  onRestore(restore: (channel: RestoreChannel) => Promise<void>): () => void {
    this.restorers.push(restore)
    return () => {
      const i = this.restorers.indexOf(restore)
      if (i >= 0) this.restorers.splice(i, 1)
    }
  }

  async discardImport(ids: number[]): Promise<void> {
    if (ids.length && !this.rpc.dead) await this.request({ type: 'discard-import', requestId: this.nextId++, ids })
  }

  /** The loaded scan's render geometry again, with its sharp edges split as
   *  `crease` now says. */
  async recrease(crease: CreaseSetting): Promise<LoadedScan> {
    const requestId = this.nextId++
    return this.request<LoadedScan>({ type: 'recrease', requestId, crease })
  }

  /** Fit from clicked seeds. `window` confines the fit to a span of the
   *  surface it finds, for the kinds that can be — see AxialWindow. */
  async fit(
    elementType: ElementKind,
    seeds: number[],
    settings: FitSettings,
    window?: AxialWindow,
  ): Promise<FitOutput> {
    const requestId = this.nextId++
    const res = await this.request<Extract<WorkerResponse, { type: 'fit-ok' }>>({
      type: 'fit',
      requestId,
      elementType,
      seeds,
      settings,
      window,
    })
    return res.result
  }

  /** Fit to the surface the user painted. The vertex list is copied rather
   *  than transferred: the caller keeps it as the element's rebuild recipe. */
  async fitSelection(
    elementType: ElementKind,
    vertices: Uint32Array,
    settings: FitSettings,
    window?: AxialWindow,
  ): Promise<FitOutput> {
    const requestId = this.nextId++
    const res = await this.request<Extract<WorkerResponse, { type: 'fit-ok' }>>({
      type: 'fit-selection',
      requestId,
      elementType,
      vertices,
      settings,
      window,
    })
    return res.result
  }

  async loadNominal(name: string, buffer: ArrayBuffer): Promise<LoadedNominal> {
    const requestId = this.nextId++
    return this.request<LoadedNominal>({ type: 'load-nominal', requestId, name, buffer }, [buffer])
  }

  /** The best fit. With no pairs this is the automatic search; with pairs it
   *  starts from them, and `vertices` narrows what the refinement is measured
   *  on. Null back means the user stopped it — see abortAlign. */
  async align(
    pairs: PointPair[] | null,
    vertices?: Uint32Array | null,
  ): Promise<AlignResult | null> {
    const requestId = this.nextId++
    const msg: Request = pairs
      ? { type: 'align', requestId, mode: 'points', pairs, vertices: vertices ?? undefined }
      : { type: 'align', requestId, mode: 'auto' }
    return this.settleAlign(msg)
  }

  /** Stop the fit that is running. It answers by settling that fit's own
   *  promise with null, so the caller finds out where it was already waiting;
   *  with nothing running this is a no-op. */
  abortAlign(): void {
    this.rpc.post({ type: 'align-abort' } satisfies WorkerRequest)
  }

  private async settleAlign(msg: Request): Promise<AlignResult | null> {
    const res = await this.request<
      Extract<WorkerResponse, { type: 'align-ok' | 'align-stopped' }>
    >(msg)
    return res.type === 'align-ok' ? res.result : null
  }

  /** Fine-tune the alignment on the marked surface only. The vertex list is
   *  copied rather than transferred: the marking stays on the part, ready for
   *  another pass. */
  async alignLocal(
    vertices: Uint32Array,
    start: Rigid,
    maxDistance: number,
  ): Promise<AlignResult | null> {
    const requestId = this.nextId++
    return this.settleAlign({
      type: 'align',
      requestId,
      mode: 'local',
      vertices,
      start,
      maxDistance,
    })
  }

  /** The deviation map under this alignment. The facing limit shapes which
   *  surface each point is measured against, so changing it means asking
   *  again. */
  async deviate(transform: Rigid, facingDeg: number | null): Promise<DeviationResult> {
    const requestId = this.nextId++
    return this.request<DeviationResult>({ type: 'deviate', requestId, transform, facingDeg })
  }

  /** Wall thickness at every scan vertex. Every setting here shapes the search
   *  itself, so changing any of them means asking again. */
  async thickness(settings: ThicknessRequest): Promise<ThicknessResult> {
    const requestId = this.nextId++
    return this.request<ThicknessResult>({ type: 'thickness', requestId, ...settings })
  }

  /** Bake a datum alignment into the worker's copy of the scan. */
  async transform(transform: Rigid): Promise<void> {
    const requestId = this.nextId++
    await this.request({ type: 'transform', requestId, transform })
  }

  /** Cut the scan with a plane: the polylines where it crosses the mesh, in
   *  scan coordinates. Chains shorter than `minLength` mm are dropped. */
  async section(origin: Vec3, normal: Vec3, minLength: number): Promise<SectionCut> {
    const requestId = this.nextId++
    const res = await this.request<Extract<WorkerResponse, { type: 'section-ok' }>>({
      type: 'section',
      requestId,
      origin,
      normal,
      minLength,
    })
    return { points: res.points, offsets: res.offsets }
  }

  /** The centroid of the volume the scan encloses, on the scan as it now
   *  stands — with whether it is closed enough to have one. Given a marked
   *  surface, the centroid of that surface. The vertex list is copied, not
   *  transferred: the marking stays on the part. */
  /** The vertices a flood from a seed reaches over edges turning by less
   *  than the angle — a region for a surface fit. */
  async flood(seed: number, maxAngleDeg: number, limit?: number): Promise<Uint32Array> {
    const requestId = this.nextId++
    const res = await this.request<Extract<WorkerResponse, { type: 'flood-ok' }>>({ type: 'flood', requestId, seed, maxAngleDeg, limit })
    return res.vertices
  }

  /** The scan's mean curvature at every vertex, 1/mm, convex positive. */
  async curvature(): Promise<Float32Array> {
    const requestId = this.nextId++
    const res = await this.request<Extract<WorkerResponse, { type: 'curvature-ok' }>>({ type: 'curvature', requestId })
    return res.values
  }

  async centroid(vertices?: Uint32Array | null): Promise<MeshCentroid> {
    const requestId = this.nextId++
    const res = await this.request<Extract<WorkerResponse, { type: 'centroid-ok' }>>({
      type: 'centroid',
      requestId,
      vertices: vertices ?? undefined,
    })
    return res.result
  }

  /** The mirror plane the scan matches itself across, refined from `seed`
   *  or, without one, from the best of the scan's principal planes — on the
   *  whole scan, or on a marked surface alone. */
  async symmetry(seed: SeedPlane | null, vertices?: Uint32Array | null): Promise<SymmetryPlane> {
    const requestId = this.nextId++
    const res = await this.request<Extract<WorkerResponse, { type: 'symmetry-ok' }>>({
      type: 'symmetry',
      requestId,
      seed,
      vertices: vertices ?? undefined,
    })
    return res.result
  }

  /** The coordinate system the scan suggests for itself, as it now stands —
   *  a proposal; nothing is moved. */
  async autoAlign(): Promise<AutoAlignResult> {
    const requestId = this.nextId++
    const res = await this.request<Extract<WorkerResponse, { type: 'auto-align-ok' }>>({ type: 'auto-align', requestId })
    return res.result
  }
}

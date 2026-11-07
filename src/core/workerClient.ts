// SPDX-License-Identifier: AGPL-3.0-only
// The main thread's handle on the mesh worker: one typed, promise-returning
// method per request in workerProtocol.ts. A worker that dies does not end
// the session — the next request starts a new one, loads the scan and the
// reference back into it from the bytes the app still holds, and lets each
// plugin put back what it kept there (onRestore). A reply can land after an
// import has replaced the models it was about; scanVersion and
// nominalVersion are there for callers to tell.

import { WorkerRpc } from './workerRpc'
import type { MeshCentroid } from './geometry/centroid'
import type { CreaseSetting, CreaseReport } from './geometry/crease'
import type { ScanSpot } from './geometry/nearest'
import type { SeedPlane, SymmetryPlane } from './symmetry'
import type { AutoAlignResult } from './autoAlign'
import type { AlignResult, PointPair } from './deviation/align'
import type { Rigid } from './deviation/rigid'
import type { VolumeDeviation } from './deviation/volume'
import { mmPerUnit, type MeshUnits } from './meshUnits'
import type { StepInfo } from './parsers/step'
import type { SectionFrame } from './section/frame'
import type { SectionCut } from './section/slice'
import type { AxialWindow, ElementKind, FitOutput, FitSettings, TextureNote, Vec3 } from './types'
import type { ObjCompanions } from './parsers/objTexture'
import type { FitGuide } from './fit/guide'
import type { PlaneRegionReport, Segmentation, SegmentOptions } from './fit/segment'
import type { RayGrid } from './geometry/scanQa'
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
  /** The part's own colour per vertex, sRGB bytes — a textured OBJ's. */
  colors?: Uint8Array
  /** What became of the texture the file names, when it names one. */
  texture?: TextureNote
  /** How a STEP file opened as the scan was converted. */
  step?: StepInfo
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

/** The reference cut finer and read against the scan — see
 *  deviation/onReference.ts. */
export interface ReferenceDeviationResult {
  positions: Float32Array
  normals: Float32Array
  indices: Uint32Array
  parent: Uint32Array
  spacing: number
  /** The spacing asked for, where `spacing` may have opened past it on a
   *  large reference. */
  wanted?: number
  values: Float32Array
}

/** A mesh of the reference's surface: the corners of each triangle in
 *  `indices`, the positions in millimetres in the reference's frame. */
export interface ReferenceMesh {
  positions: Float32Array
  indices: Uint32Array
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
    scan: { name: string; bytes: Uint8Array; crease: CreaseSetting; transform: Rigid | null; units?: MeshUnits; scale?: number } | null
    nominal: { name: string; bytes: Uint8Array; units?: MeshUnits } | null
  }) | null = null
  /** What the plugins put back after a restart, once the scan and the
   *  reference are back — see onRestore. */
  private restorers: ((channel: RestoreChannel) => Promise<void>)[] = []
  private nextId = 1
  /** Async callers must not apply a result to a different imported session. */
  scanVersion = 0
  nominalVersion = 0
  onProgress: ((text: string, fraction?: number) => void) | null = null
  /** Poses from part-way through an alignment. Not a request result — they
   *  arrive while the request is still open, so they must not settle it. */
  onAlignProgress: ((transform: Rigid, iteration: number, meanDistance: number) => void) | null =
    null

  constructor() {
    this.rpc = new WorkerRpc(() => new Worker(new URL('./meshWorker.ts', import.meta.url), { type: 'module' }), 'Mesh worker', (data) => {
      const msg = data as WorkerResponse
      if (msg.type === 'progress') { this.onProgress?.(msg.text, msg.fraction); return true }
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
        const { name, bytes, crease, transform, units, scale } = state.scan
        const buffer = bytes.slice().buffer
        await this.rpc.request({ type: 'load', requestId: this.nextId++, name, buffer, crease, transform: transform ?? undefined, scale: mmPerUnit(units ?? 'mm') * (scale ?? 1) } as Request, [buffer]) // units-ok: the file's own units, an id
      }
      if (state?.nominal) {
        const { name, bytes, units } = state.nominal
        const buffer = bytes.slice().buffer
        await this.rpc.request({ type: 'load-nominal', requestId: this.nextId++, name, buffer, scale: mmPerUnit(units ?? 'mm') } as Request, [buffer]) // units-ok: the file's own units, an id
      }
      const channel: RestoreChannel = {
        loadStaged: async (name, bytes, crease, transform, units) => {
          const buffer = bytes.slice().buffer
          const id = this.nextId++
          await this.rpc.request({ type: 'load', requestId: id, name, buffer, crease, staged: true, transform: transform ?? undefined, scale: mmPerUnit(units ?? 'mm') } as Request, [buffer]) // units-ok: the file's own units, an id
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

  /** `companions` are the files that came with a textured OBJ, its images
   *  decoded (see app/scanFiles); they are handed over, not copied. */
  async prepareScan(name: string, buffer: ArrayBuffer, crease: CreaseSetting, transform?: Rigid, units: MeshUnits = 'mm', companions?: ObjCompanions, scale = 1): Promise<{ id: number; mesh: LoadedScan }> {
    const id = this.nextId++
    const transfer: Transferable[] = [buffer, ...(companions?.images.map((img) => img.rgba.buffer as ArrayBuffer) ?? [])]
    // `scale` on top of the units: the factor the scan was scaled by to its
    // true size (core/scanScale), read into it as the units are.
    const mesh = await this.request<LoadedScan>({ type: 'load', requestId: id, name, buffer, crease, staged: true, transform, scale: mmPerUnit(units) * scale, ...(companions ? { companions } : {}) }, transfer)
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
    guide?: FitGuide,
  ): Promise<FitOutput> {
    const requestId = this.nextId++
    const res = await this.request<Extract<WorkerResponse, { type: 'fit-ok' }>>({
      type: 'fit',
      requestId,
      elementType,
      seeds,
      settings,
      window,
      ...(guide ? { guide } : {}),
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

  /** The reference read against the scan under this alignment — or `mesh`,
   *  given in the reference's frame, in its place; with none given, the
   *  reference's own mesh for its map when one was set for it
   *  (setReferenceMapMesh). */
  async deviateReference(transform: Rigid, facingDeg: number | null, spacing: number, mesh?: ReferenceMesh): Promise<ReferenceDeviationResult> {
    const requestId = this.nextId++
    const own = mesh ?? this.referenceMapMesh(spacing)
    return this.request<ReferenceDeviationResult>({ type: 'deviate-reference', requestId, transform, facingDeg, spacing, ...(own ? { mesh: own } : {}) })
  }

  /** The deviation as volumes under this alignment, with each kind's
   *  regions as a surface to draw — against the reference loaded, or
   *  `mesh` in its place; over the whole part, or `within` a box of the
   *  reference's frame. */
  async deviateVolume(transform: Rigid, tolerance: number, options: { cell?: number; within?: { min: Vec3; max: Vec3 }; mesh?: ReferenceMesh } = {}): Promise<VolumeDeviation> {
    const requestId = this.nextId++
    const { cell, within, mesh } = options
    const res = await this.request<{ volume: VolumeDeviation }>({
      type: 'deviate-volume',
      requestId,
      transform,
      tolerance,
      ...(cell !== undefined ? { cell } : {}),
      ...(within ? { within } : {}),
      ...(mesh ? { mesh } : {}),
    })
    return res.volume
  }

  /**
   * Another mesh of the reference loaded now, for its map alone: the same
   * surface, in the reference's frame, more coarsely tessellated. The map
   * cuts the reference into readings about its spacing apart whatever it is
   * given, so a tessellation far finer than that — one made fine for the
   * distances measured to it from the scan — only adds readings where its
   * triangles are small; a coarser one, its chord well within the
   * tolerance, gives the same map from fewer readings. It serves maps cut
   * `minSpacing` apart or further — a finer map reads the reference itself
   * — and goes with the reference it was set for: a reference loaded after
   * it drops it. Null drops it now.
   */
  setReferenceMapMesh(mesh: ReferenceMesh | null, minSpacing = 0): void {
    this.mapMesh = mesh ? { nominalVersion: this.nominalVersion, mesh, minSpacing } : null
  }

  private mapMesh: { nominalVersion: number; mesh: ReferenceMesh; minSpacing: number } | null = null

  /** The mesh set for the map on the reference loaded now, when it serves
   *  a map at this spacing. */
  private referenceMapMesh(spacing: number): ReferenceMesh | undefined {
    const m = this.mapMesh
    return m && m.nominalVersion === this.nominalVersion && spacing >= m.minSpacing * (1 - 1e-9) ? m.mesh : undefined
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
   *  scan coordinates, each point with the side the material is on.
   *  Chains shorter than `minLength` mm are dropped. */
  async section(origin: Vec3, normal: Vec3, minLength: number): Promise<SectionCut> {
    const requestId = this.nextId++
    const res = await this.request<Extract<WorkerResponse, { type: 'section-ok' }>>({
      type: 'section',
      requestId,
      origin,
      normal,
      minLength,
    })
    return { points: res.points, offsets: res.offsets, ...(res.normals ? { normals: res.normals } : {}) }
  }

  /** The scan's shadow on the frame's plane — its outline seen along the
   *  normal, read as lines and arcs `play` mm outside the part to
   *  `tolerance`, corners turning by less than `smoothDeg` rounded — as
   *  closed polylines in scan coordinates, with the pieces and figures as
   *  `shadow`. */
  async shadow(frame: SectionFrame, tolerance: number, play: number, smoothDeg: number): Promise<SectionCut> {
    const requestId = this.nextId++
    const res = await this.request<Extract<WorkerResponse, { type: 'section-ok' }>>({
      type: 'shadow',
      requestId,
      frame,
      tolerance,
      play,
      smoothDeg,
    })
    return { points: res.points, offsets: res.offsets, ...(res.normals ? { normals: res.normals } : {}), ...(res.shadow ? { shadow: res.shadow } : {}) }
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

  /** What a grown region holds: its area and box, and with the plane's
   *  normal the spread of its normals and whether it is two surfaces, with
   *  a cylinder whether it is two cylinders — see fit/segment. The vertex
   *  list is copied, not transferred. */
  async planeRegion(
    vertices: Uint32Array,
    plane?: { normal: Vec3; seed?: number },
    cylinder?: { center: Vec3; axis: Vec3; radius: number; seed?: number },
  ): Promise<PlaneRegionReport> {
    const requestId = this.nextId++
    const res = await this.request<Extract<WorkerResponse, { type: 'plane-region-ok' }>>({
      type: 'plane-region',
      requestId,
      vertices,
      ...(plane ? { normal: plane.normal, seed: plane.seed } : {}),
      ...(cylinder ? { cylinder: { center: cylinder.center, axis: cylinder.axis, radius: cylinder.radius }, seed: cylinder.seed } : {}),
    })
    return res.result
  }

  /** The scan's flat regions, the largest first, with every region's
   *  vertices — see fit/segment. */
  async segment(options: SegmentOptions): Promise<Segmentation> {
    const requestId = this.nextId++
    return (await this.request<Extract<WorkerResponse, { type: 'segment-ok' }>>({ type: 'segment', requestId, options })).result
  }

  /** A place on the scan named without a click: the vertex asked for, or
   *  the one nearest the point — see geometry/nearest. */
  async nearest(at: { vertex: number } | { point: Vec3 }): Promise<ScanSpot> {
    const requestId = this.nextId++
    const res = await this.request<Extract<WorkerResponse, { type: 'nearest-ok' }>>({ type: 'nearest', requestId, ...at })
    return res.result
  }

  /** The box around the scan as it now stands, mm. */
  async bounds(): Promise<{ min: Vec3; max: Vec3 }> {
    const requestId = this.nextId++
    const res = await this.request<Extract<WorkerResponse, { type: 'bounds-ok' }>>({ type: 'bounds', requestId })
    return { min: res.min, max: res.max }
  }

  /** The scan's vertices inside a box — facing a direction within an angle
   *  if asked — with their positions and normals, at most `limit` of them
   *  spread evenly through what matched. See geometry/query. */
  async query(q: { min: Vec3; max: Vec3; normal?: { dir: Vec3; cosLimit: number }; limit: number }): Promise<{ vertices: Uint32Array; positions: Float32Array; normals: Float32Array; matched: number; step: number }> {
    const requestId = this.nextId++
    const res = await this.request<Extract<WorkerResponse, { type: 'query-ok' }>>({ type: 'query', requestId, ...q })
    return { vertices: res.vertices, positions: res.positions, normals: res.normals, matched: res.matched, step: res.step }
  }

  /** The scan's mean curvature at every vertex, 1/mm, convex positive. */
  /** The first scan surface along an axis over a grid — see geometry/scanQa. */
  async heights(grid: RayGrid): Promise<Float32Array> {
    const requestId = this.nextId++
    return (await this.request<Extract<WorkerResponse, { type: 'heights-ok' }>>({ type: 'heights', requestId, grid })).values
  }

  /** The same, with the triangle each ray met: its corners (scan vertex
   *  numbers) and the hit's weight on each, three per ray. */
  async heightsAt(grid: RayGrid): Promise<{ values: Float32Array; corners: Uint32Array; weights: Float32Array }> {
    const requestId = this.nextId++
    const res = await this.request<Extract<WorkerResponse, { type: 'heights-ok' }>>({ type: 'heights', requestId, grid, corners: true })
    if (!res.corners || !res.weights) throw new Error('The mesh worker gave no corners with the heights.')
    return { values: res.values, corners: res.corners, weights: res.weights }
  }

  /** The scan's open rims (the `rims` longest) and its noise over `sample`
   *  vertices; with `sheet`, whether it is a sheet — see geometry/sheet. */
  async scanQa(sample: number, rims: number, sheet?: { sample: number; apartSample: number }): Promise<Omit<Extract<WorkerResponse, { type: 'scan-qa-ok' }>, 'type' | 'requestId'>> {
    const requestId = this.nextId++
    const { rims: r, noise, sheet: s } = await this.request<Extract<WorkerResponse, { type: 'scan-qa-ok' }>>({ type: 'scan-qa', requestId, sample, rims, ...(sheet ? { sheet } : {}) })
    return { rims: r, noise, ...(s ? { sheet: s } : {}) }
  }

  /** One open rim by its number among the scan's rims, longest first, as
   *  scanQa numbers them: its loop in order, null past the last. */
  async scanRim(index: number): Promise<Extract<WorkerResponse, { type: 'scan-rim-ok' }>['rim']> {
    const requestId = this.nextId++
    return (await this.request<Extract<WorkerResponse, { type: 'scan-rim-ok' }>>({ type: 'scan-rim', requestId, index })).rim
  }

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

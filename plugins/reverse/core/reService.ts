// SPDX-License-Identifier: AGPL-3.0-only
// What the CAD kernel's worker does with each request, apart from the worker
// itself: the kernel loaded on the first request, the shapes kept between
// requests — a build leaves its bodies in the builder, and the STEP export
// writes them from there — and every answer with the buffers it may hand
// over. The worker (reWorker.ts) posts the answers to the page; under Node,
// where there are no workers, a client talks to the same service in its own
// thread (reLocal.ts), so a test or a script builds exactly as the page does.

import type { Vec3 } from '../../../src/core/types'
import type { Rigid } from '../../../src/core/deviation/rigid'
import type { NominalSurface } from '../../../src/core/deviation/surface'
import { computeVertexNormals } from '../../../src/core/geometry/normals'
import type { KernelMesh, ReKernel, StepCheck, StepLabel, StepMend } from './kernel'
import type { ManifoldToplevel } from 'manifold-3d'
import { isTrap } from './kernelOps'
import type { BodyProbe, CutPiece } from './kernelProbe'
import { trapEdgesText } from './trapEdges'
import { Builder, stepKeys, type BodyBrief, type BodyCheck, type BuildSteps, type BuiltBody, type DrawnBody, type EdgeInfo, type FaceInfo, type FeatureResult, type FilletTries, type Overlap, type PreviewResult, type PreviewStep } from './build'
import { compareBodies, type CompareDetail, type PatchRequest } from './compareDetail'
import type { BuildStep } from './features'
import { DEFAULT_FACING_DEG, liveMap, liveMapReach, sheetTriangles, surfaceOfMeshes, type ScanSide, type SparseField } from './liveMap'
import { kernelTeller, type ReWorkerEvent } from './reEvents'
import { createParallel, type HelperPool } from './reParallel'
import type { Sketch } from './sketch'

export type ReWorkerRequest =
  /** Load the kernel. Answered once it is ready to build. */
  | { type: 'init'; requestId: number }
  /** Build the feature list — see build.ts — taking up from the steps it
   *  shares with the build standing or the one before it (stepKeys). The
   *  sketches come along by id for what the build has to know about their
   *  extent; the STEP files an Import names, by key, the first time a
   *  request needs them — the worker keeps them. `have`: the bodies the
   *  page holds, by id and key (BuiltBody.key) — the answer hands over
   *  whole only the ones it does not hold so. `crashed`: the steps the
   *  kernel crashed on, by key, as the page keeps them — a worker started
   *  after a stop has not met them (withoutCrashed). */
  | { type: 'build'; requestId: number; steps: BuildStep[]; sketches: [number, Sketch][]; stepFiles?: [string, string][]; have?: [number, string][]; crashed?: [string, string][] }
  /** Bodies of the last build, whole, by id — for a page that holds
   *  another key for one than the build says it stands at. */
  | { type: 'bodies'; requestId: number; ids: number[] }
  /** The topology of bodies a build handed over without it (buildDrawn). */
  | { type: 'topologies'; requestId: number; ids: number[] }
  /** The solid one step would make on its own, meshed — the ghost of a
   *  feature being set up. Leaves the bodies as they are. */
  | { type: 'preview'; requestId: number; step: PreviewStep; sketch: Sketch | null; stepFiles?: [string, string][] }
  /** A body as it stood before one of the last build's features: its mesh
   *  and topology, for editing that feature on the body it was made on. */
  | { type: 'stage'; requestId: number; stepId: number; bodyId: number }
  /** One STEP file of the given bodies from the last build. */
  | { type: 'export-step'; requestId: number; bodyIds: number[]; labels?: StepLabel[]; verify?: boolean }
  | { type: 'section-cut'; requestId: number; bodyIds: number[]; origin: Vec3; normal: Vec3; deflection: number }
  | { type: 'clearance'; requestId: number; a: number; b: number }
  /** The given bodies of the last build cut by a plane, as the kernel's
   *  own section edges — see Builder.sectionPieces. */
  | { type: 'body-section'; requestId: number; bodyIds: number[]; origin: Vec3; normal: Vec3; deflection: number }
  /** Points and rays read against the given bodies of the last build —
   *  see Builder.probe. */
  | { type: 'body-probe'; requestId: number; bodyIds: number[]; points: Vec3[]; rays: { from: Vec3; dir: Vec3 }[] }
  /** Where the given bodies of the last build run into each other — see
   *  Builder.overlaps — no new pair begun after `budget` milliseconds. */
  | { type: 'overlaps'; requestId: number; bodyIds: number[]; budget: number }
  /** The scan's vertices, for the live map — a copy, kept here between
   *  requests, in the frame the bodies are built in. Positions left out
   *  keep the scan already here; null puts it away. The vertex normals
   *  come along when there are no triangles to work them out from. */
  | { type: 'scan'; requestId: number; positions: Float32Array | null | undefined; indices?: Uint32Array | null; normals?: Float32Array | null; transform: Rigid | null }
  /** The live map: the scan's signed distance to the last preview's solid,
   *  or to the given bodies of the last build, for the vertices within
   *  reach of it — see liveMap.ts. */
  | { type: 'map'; requestId: number; source: 'preview' | 'bodies'; bodyIds: number[]; range: number }
  /** The scan against the given bodies in detail: the field, each face's
   *  reading, the worst spots — see compareDetail.ts — the scan read by
   *  the way it faces (liveMap's ScanSide, the normals the worker's). */
  | { type: 'compare'; requestId: number; bodyIds: number[]; range: number; spots: number; patches?: PatchRequest; within?: { min: Vec3; max: Vec3 }; far?: number; side?: Omit<ScanSide, 'normals'> }
  /** A body of the last build looked over — see Builder.check; with
   *  roundTrip, written as STEP and read back in memory too. */
  | { type: 'check'; requestId: number; bodyId: number; tinyArea: number; before?: number; roundTrip?: boolean | 'find' }
  /** A round or a chamfer of the last build tried at other sizes, nothing
   *  kept — see Builder.filletTry. */
  | { type: 'fillet-try'; requestId: number; stepId: number; sizes: number[] }
  /** The given solid bodies of the last build meshed to a chord, for the
   *  Deviation workspace to measure against — see compare.ts. With
   *  `sheets`, the sheets among them too. */
  | { type: 'reference'; requestId: number; bodyIds: number[]; chord: number; sheets?: boolean }

export type ReWorkerResponse =
  | { type: 'init-ok'; requestId: number; version: string }
  /** `bodies`: the ones the page did not hold, whole; `all`: every body
   *  standing, in brief, in order. `crashed`: every step the kernel has
   *  crashed on, by key, with what it said — for the page to keep. */
  | { type: 'build-ok'; requestId: number; results: FeatureResult[]; bodies: DrawnBody[]; all: BodyBrief[]; steps: BuildSteps; crashed?: [string, string][] }
  | { type: 'bodies-ok'; requestId: number; bodies: BuiltBody[] }
  /** Each body's topology with the key it was handed over at. */
  | { type: 'topologies-ok'; requestId: number; topologies: { id: number; key: string; topology: BuiltBody['topology'] }[] }
  | { type: 'preview-ok'; requestId: number; preview: PreviewResult }
  /** A round, a chamfer or a shell whose preview failed, with where it
   *  failed — see Builder.diagnose. Any other failure is an error. */
  | { type: 'preview-failed'; requestId: number; message: string; where: Float32Array[] }
  | { type: 'stage-ok'; requestId: number; stage: { mesh: KernelMesh; topology: { faces: FaceInfo[]; edges: EdgeInfo[] } } | null }
  | { type: 'step-ok'; requestId: number; text: string; check?: StepCheck; mended?: StepMend[] }
  | { type: 'section-cut-ok'; requestId: number; bodies: { id: number; polylines: Float32Array[] }[] }
  | { type: 'clearance-ok'; requestId: number; gap: number; overlap: number }
  | { type: 'body-section-ok'; requestId: number; bodies: { id: number; pieces: CutPiece[] }[] }
  | { type: 'body-probe-ok'; requestId: number; bodies: BodyProbe[] }
  | { type: 'overlaps-ok'; requestId: number; overlaps: Overlap[]; done: boolean }
  | { type: 'scan-ok'; requestId: number }
  | { type: 'map-ok'; requestId: number; field: SparseField }
  | { type: 'compare-ok'; requestId: number; detail: CompareDetail }
  | { type: 'check-ok'; requestId: number; check: BodyCheck | null }
  | { type: 'fillet-try-ok'; requestId: number; tried: FilletTries }
  | { type: 'reference-ok'; requestId: number; meshes: KernelMesh[] }
  /** A build or a preview overtaken by another of its kind before it was
   *  played (reQueue.ts). */
  | { type: 'skipped'; requestId: number }
  | { type: 'error'; requestId: number; message: string }

/** An answer, and the buffers it may hand over rather than copy. */
export interface ReAnswer {
  response: ReWorkerResponse
  transfer: Transferable[]
}

export interface ReService {
  handle(msg: ReWorkerRequest): Promise<ReAnswer>
}

/** The buffers of built bodies, handed over rather than copied. */
function bodyBuffers(bodies: readonly DrawnBody[]): Transferable[] {
  const transfer: Transferable[] = []
  for (const body of bodies) {
    transfer.push(body.mesh.positions.buffer, body.mesh.normals.buffer, body.mesh.indices.buffer)
    if (body.mesh.faceHash) transfer.push(body.mesh.faceHash.buffer)
    for (const e of body.topology?.edges ?? []) transfer.push(e.polyline.buffer)
  }
  return transfer
}

/** How long a crashed step's diagnosis may take on the fresh kernel, ms:
 *  the build waits on it. */
export const CRASH_DIAGNOSIS_MS = 10_000

/** The service over the kernel `loadKernel` brings up on the first request,
 *  and the mesh boolean `loadManifold` brings up on the first ask for the
 *  bodies' overlaps. With `helpers`, a build's groups of steps are shared
 *  out to them where that is worth it (reParallel.ts). `tell` hears what
 *  the kernels are at while they work (reEvents.ts) — this one's and the
 *  helpers'. */
export function createReService(loadKernel: () => Promise<ReKernel>, loadManifold: () => Promise<ManifoldToplevel>, helpers?: HelperPool, tell?: (e: ReWorkerEvent) => void): ReService {
  /** The request being worked on, which the kernels' events are told with. */
  let working = 0
  const teller = tell ? kernelTeller((e) => tell({ ...e, requestId: working })) : null
  if (helpers && tell) helpers.onEvent = (helper, e) => tell({ ...e, requestId: working, helper })
  let kernel: ReKernel | null = null
  let builder: Builder | null = null
  let parallel: ReturnType<typeof createParallel> | null = null
  let manifold: Promise<ManifoldToplevel> | null = null
  /** The scan, for the live map: the vertices as the viewport holds them —
   *  every datum alignment baked in — so a body built in that frame is
   *  compared in it too. */
  let scan: { positions: Float32Array; indices: Uint32Array | null; normals: Float32Array | null; transform: Rigid | null } | null = null
  /** The steps the kernel trapped on, by their keys (stepKeys), with what it
   *  said: built as failed — not played — until the step is changed, so a
   *  step that crashes the kernel crashes it once. */
  const crashed = new Map<string, string>()
  /** The last preview's tessellation, kept for the map: its buffers went
   *  to the viewport, so this is a copy, and the surface over it is built
   *  the first time a map asks for it. */
  let lastPreview: { mesh: KernelMesh; surface: NominalSurface | null } | null = null
  /** The last map against the bodies, a copy of what went out, with what it
   *  was read of: a shape is another object once its body is built otherwise,
   *  and the scan once it is moved or replaced. */
  let lastMap: { scan: object; shapes: unknown[]; range: number; field: SparseField } | null = null

  const load = async (): Promise<Builder> => {
    if (builder) return builder
    kernel = await loadKernel()
    builder = new Builder(kernel)
    teller?.hook(builder)
    if (helpers) parallel = createParallel(builder, helpers)
    return builder
  }

  const answer = (response: ReWorkerResponse, transfer: Transferable[] = []): ReAnswer => ({ response, transfer })

  /** Every step the kernel crashed on, for a build's answer: the page keeps
   *  them past this worker, which a stop lets go. */
  const crashedOut = () => (crashed.size > 0 ? { crashed: [...crashed] } : {})

  /** The kernel let go after a trap and a fresh one started: what the old
   *  one held is gone, the scan handed to it again; the next build plays
   *  every step. */
  const restart = async (): Promise<Builder> => {
    builder = null
    kernel = null
    parallel = null
    lastPreview = null
    const b = await load()
    b.setScan(scan && scan.indices && !scan.transform ? surfaceOfMeshes([{ positions: scan.positions, normals: new Float32Array(0), indices: scan.indices }]) : null, scan && !scan.transform ? scan.positions : null)
    return b
  }

  /** The steps with those the kernel crashed on put down as failed. */
  const withoutCrashed = (steps: BuildStep[], sketchOf: (id: number) => Sketch | undefined): BuildStep[] => {
    if (crashed.size === 0) return steps
    const keys = stepKeys(steps, sketchOf)
    return steps.map((s, i) => {
      const why = crashed.get(keys[i])
      // The body it worked on goes with it, for the build to keep as it
      // stood before the step — what the crash's diagnosis reads.
      return why === undefined ? s : { kind: 'failed', id: s.id, name: 'name' in s && typeof s.name === 'string' ? s.name : '', message: why, ...('body' in s && typeof s.body === 'number' ? { body: s.body } : {}) }
    })
  }

  const handle = async (msg: ReWorkerRequest): Promise<ReAnswer> => {
    working = msg.requestId
    try {
      if (msg.type === 'init') {
        await load()
        return answer({ type: 'init-ok', requestId: msg.requestId, version: kernel!.version })
      }
      const b = await load()
      // The kernel's calls told as this service's: under Node several
      // services share a thread.
      teller?.hook(b)
      if (msg.type === 'build' || msg.type === 'preview') b.addStepFiles(msg.stepFiles ?? [])
      if (msg.type === 'build') {
        for (const [key, why] of msg.crashed ?? []) crashed.set(key, why)
        const sketches = new Map(msg.sketches)
        const sketchOf = (id: number) => sketches.get(id)
        const toBuild = withoutCrashed(msg.steps, sketchOf)
        try {
          try {
            await parallel?.prebuild(toBuild, msg.sketches)
          } catch (e) {
            if (isTrap(e)) throw e
            // Shared out or not, the build below builds every step: what
            // the helpers did not do, it plays.
          }
          const { results, bodies, all, steps } = b.buildDrawn(toBuild, sketchOf, new Map(msg.have ?? []))
          return answer({ type: 'build-ok', requestId: msg.requestId, results, bodies, all, steps, ...crashedOut() }, bodyBuffers(bodies))
        } catch (e) {
          if (!isTrap(e) && kernel?.trapped == null) throw e
          // The kernel trapped: the step it trapped on put down as failed,
          // saying so, a fresh kernel started, and the build played again
          // on it — every step, the page's bodies all handed over anew.
          const on = b.trappedOn
          const at = on === null ? -1 : msg.steps.findIndex((s) => s.id === on)
          const said = e instanceof Error ? e.message : String(e)
          // A round or a chamfer says which edges it was given: the set to
          // change, by where they lie and the features either side.
          const nameOf = (id: number) => {
            const s = msg.steps.find((x) => x.id === id)
            return s && 'name' in s && typeof s.name === 'string' ? s.name : undefined
          }
          const where = b.trapEdges ? ` ${trapEdgesText(b.trapEdges, nameOf)}` : ''
          const key = at >= 0 ? stepKeys(msg.steps, sketchOf)[at] : null
          const crash = `The CAD kernel crashed on this step (${said}) and was started again; the part was built again without it.${where}`
          if (key !== null) crashed.set(key, `${crash} Change the step to try it again.`)
          const fresh = await restart()
          const again = fresh.build(withoutCrashed(msg.steps, sketchOf), sketchOf, true)
          // Why it may have crashed: the step's diagnosis, on the fresh
          // kernel, on the body as it stood before the step, within a time
          // limit — its words with the crash's, kept with them for the
          // builds after. A diagnosis that crashes the kernel as well is
          // let go with it, and the part built once more.
          const d = key !== null ? fresh.diagnoseCrashed(msg.steps[at], CRASH_DIAGNOSIS_MS) : null
          if (kernel?.trapped != null) {
            const last = await restart()
            const { results, bodies, all, steps } = last.build(withoutCrashed(msg.steps, sketchOf), sketchOf, true)
            return answer({ type: 'build-ok', requestId: msg.requestId, results, bodies, all, steps, ...crashedOut() }, bodyBuffers(bodies))
          }
          if (d && key !== null) {
            const message = `${crash} ${d.message.replace(/\.?$/, '.')} Change the step to try it again.`
            crashed.set(key, message)
            const r = again.results.find((x) => x.id === on)
            if (r) {
              r.message = message
              if (d.where.length > 0) r.where = d.where
            }
          }
          const { results, bodies, all, steps } = again
          return answer({ type: 'build-ok', requestId: msg.requestId, results, bodies, all, steps, ...crashedOut() }, bodyBuffers(bodies))
        }
      }
      if (msg.type === 'bodies') {
        const bodies = b.builtBodies(msg.ids)
        return answer({ type: 'bodies-ok', requestId: msg.requestId, bodies }, bodyBuffers(bodies))
      }
      if (msg.type === 'topologies') {
        const topologies = b.topologiesOf(msg.ids)
        return answer({ type: 'topologies-ok', requestId: msg.requestId, topologies }, topologies.flatMap((t) => t.topology.edges.map((e) => e.polyline.buffer)))
      }
      if (msg.type === 'preview') {
        let preview: PreviewResult
        // The step's own time bounds a shell's diagnosis.
        const began = performance.now()
        try {
          preview = b.preview(msg.step, msg.sketch ?? undefined)
        } catch (e) {
          // A preview the kernel trapped on is not diagnosed on it.
          if (isTrap(e) || kernel?.trapped != null) throw e
          const d = b.diagnose(msg.step, performance.now() - began)
          if (!d) throw e
          return answer({ type: 'preview-failed', requestId: msg.requestId, message: `${d.message} (${e instanceof Error ? e.message : String(e)})`, where: d.where })
        }
        lastPreview = { mesh: { positions: preview.mesh.positions.slice(), normals: preview.mesh.normals, indices: preview.mesh.indices.slice() }, surface: null }
        const transfer: Transferable[] = [preview.mesh.positions.buffer, preview.mesh.normals.buffer, preview.mesh.indices.buffer]
        if (preview.mesh.faceHash) transfer.push(preview.mesh.faceHash.buffer)
        return answer({ type: 'preview-ok', requestId: msg.requestId, preview }, transfer)
      }
      if (msg.type === 'stage') {
        const stage = b.stage(msg.stepId, msg.bodyId)
        const transfer: Transferable[] = []
        if (stage) {
          transfer.push(stage.mesh.positions.buffer, stage.mesh.normals.buffer, stage.mesh.indices.buffer)
          if (stage.mesh.faceHash) transfer.push(stage.mesh.faceHash.buffer)
          for (const e of stage.topology.edges) transfer.push(e.polyline.buffer)
        }
        return answer({ type: 'stage-ok', requestId: msg.requestId, stage }, transfer)
      }
      if (msg.type === 'scan') {
        if (msg.positions === null) scan = null
        else if (msg.positions) {
          // The normals the map and the comparison read the scan's side by:
          // the triangles' winding, as the scan was loaded.
          const normals = msg.normals ?? (msg.indices ? computeVertexNormals(msg.positions, msg.indices) : null)
          scan = { positions: msg.positions, indices: msg.indices ?? null, normals, transform: msg.transform }
        } else if (scan) scan = { ...scan, transform: msg.transform }
        // The scan as a surface for a split's cell test: built once per scan,
        // the moment it is here — a few hundred milliseconds on a big scan,
        // spent in the worker. The scan is not watertight, so only the
        // distance is read, never the sign.
        b.setScan(scan && scan.indices && !scan.transform ? surfaceOfMeshes([{ positions: scan.positions, normals: new Float32Array(0), indices: scan.indices }]) : null, scan && !scan.transform ? scan.positions : null)
        return answer({ type: 'scan-ok', requestId: msg.requestId })
      }
      if (msg.type === 'map') {
        // The same bodies at the same range on the same scan: the last reading
        // as it was, not the bodies meshed and every vertex read again — a
        // picture after a picture, or after one that gave up waiting for it.
        const shapes = msg.source === 'bodies' ? msg.bodyIds.map((id) => b.body(id)) : []
        const kept = msg.source === 'bodies' && lastMap && lastMap.scan === scan && lastMap.range === msg.range && lastMap.shapes.length === shapes.length && lastMap.shapes.every((s, i) => s === shapes[i]) ? lastMap.field : null
        if (kept) {
          const again: SparseField = { subset: kept.subset.slice(), values: kept.values.slice(), ...(kept.farInside ? { farInside: kept.farInside.slice() } : {}) }
          return answer({ type: 'map-ok', requestId: msg.requestId, field: again }, [again.subset.buffer, again.values.buffer, ...(again.farInside ? [again.farInside.buffer] : [])])
        }
        const empty: SparseField = { subset: new Uint32Array(0), values: new Float32Array(0) }
        let surface: NominalSurface | null = null
        let sheet: Uint8Array | null = null
        if (msg.source === 'preview') {
          if (lastPreview && !lastPreview.surface) lastPreview.surface = surfaceOfMeshes([lastPreview.mesh])
          surface = lastPreview?.surface ?? null
        } else {
          const ids = msg.bodyIds.filter((id) => b.body(id) !== undefined)
          const meshes = b.meshes(ids)
          surface = surfaceOfMeshes(meshes)
          if (surface) sheet = sheetTriangles(surface, meshes, ids.map((id) => kernel!.isSurface(b.body(id)!)))
        }
        // Against the bodies the vertices deep inside them are named too
        // — a ghost is one feature, and the scan inside it says nothing.
        const side: ScanSide | null = scan?.normals ? { normals: scan.normals, facingDeg: DEFAULT_FACING_DEG } : null
        const field = scan && surface ? liveMap(surface, scan.positions, scan.transform, msg.range, msg.source === 'bodies', side, sheet) : empty
        lastMap = msg.source === 'bodies' && scan && surface ? { scan, shapes, range: msg.range, field: { subset: field.subset.slice(), values: field.values.slice(), ...(field.farInside ? { farInside: field.farInside.slice() } : {}) } } : null
        return answer({ type: 'map-ok', requestId: msg.requestId, field }, [field.subset.buffer, field.values.buffer, ...(field.farInside ? [field.farInside.buffer] : [])])
      }
      if (msg.type === 'compare') {
        const bodies = msg.bodyIds.flatMap((id) => {
          const m = b.meshById(id)
          return m ? [{ ...m, sheet: kernel!.isSurface(b.body(id)!) }] : []
        })
        const reach = liveMapReach(msg.range)
        const side: ScanSide | null = scan?.normals && msg.side ? { ...msg.side, normals: scan.normals } : null
        const detail: CompareDetail = scan
          ? compareBodies(bodies, scan.positions, scan.transform, msg.range, reach, msg.spots, Math.max(1, reach), msg.patches, msg.within, msg.far, side)
          : { field: { subset: new Uint32Array(0), values: new Float32Array(0) }, faces: [], spots: [], patches: [], patchesFound: 0, over: 0, spacing: 0, features: { count: 0, shareOfExcess: 0 } }
        return answer({ type: 'compare-ok', requestId: msg.requestId, detail }, [detail.field.subset.buffer, detail.field.values.buffer])
      }
      if (msg.type === 'check') return answer({ type: 'check-ok', requestId: msg.requestId, check: b.check(msg.bodyId, msg.tinyArea, msg.before, msg.roundTrip) })
      if (msg.type === 'fillet-try') {
        const tried = b.filletTry(msg.stepId, msg.sizes)
        // A try that crashed the kernel is answered with those before it; the
        // next build plays the part on a new one.
        if (tried.crashed !== undefined) await restart().catch(() => {})
        return answer({ type: 'fillet-try-ok', requestId: msg.requestId, tried })
      }
      if (msg.type === 'reference') {
        // A sheet is meshed as a solid is when it is asked for: meshes()
        // leaves sheets out of a reference, which has an inside.
        const meshes = msg.sheets ? msg.bodyIds.flatMap((id) => b.meshById(id, msg.chord)?.mesh ?? []) : b.meshes(msg.bodyIds, msg.chord)
        const transfer: Transferable[] = []
        for (const m of meshes) {
          transfer.push(m.positions.buffer, m.normals.buffer, m.indices.buffer)
          if (m.faceHash) transfer.push(m.faceHash.buffer)
        }
        return answer({ type: 'reference-ok', requestId: msg.requestId, meshes }, transfer)
      }
      if (msg.type === 'body-section') return answer({ type: 'body-section-ok', requestId: msg.requestId, bodies: b.sectionPieces(msg.bodyIds, msg.origin, msg.normal, msg.deflection) })
      if (msg.type === 'body-probe') return answer({ type: 'body-probe-ok', requestId: msg.requestId, bodies: b.probe(msg.bodyIds, msg.points, msg.rays) })
      if (msg.type === 'clearance') return answer({ type: 'clearance-ok', requestId: msg.requestId, ...b.clearance(msg.a, msg.b) })
      if (msg.type === 'overlaps') {
        // A failed load is not kept: the next ask tries again.
        manifold ??= loadManifold().catch((e: unknown) => {
          manifold = null
          throw e
        })
        const { overlaps, done } = b.overlaps(msg.bodyIds, await manifold, msg.budget)
        return answer({ type: 'overlaps-ok', requestId: msg.requestId, overlaps, done }, overlaps.flatMap((o) => [o.mesh.positions.buffer, o.mesh.normals.buffer, o.mesh.indices.buffer, ...(o.mesh.faceHash ? [o.mesh.faceHash.buffer] : [])]))
      }
      if (msg.type === 'section-cut') {
        const bodies = b.sectionCut(msg.bodyIds, msg.origin, msg.normal, msg.deflection)
        return answer({ type: 'section-cut-ok', requestId: msg.requestId, bodies }, bodies.flatMap((x) => x.polylines.map((p) => p.buffer)))
      }
      // A file mended has been checked: that check stands.
      const { text, mended, check } = b.exportStepMended(msg.bodyIds, msg.labels)
      return answer({ type: 'step-ok', requestId: msg.requestId, text, ...(msg.verify ? { check: check ?? b.verifyStep(msg.bodyIds, text) } : {}), ...(mended.length > 0 ? { mended } : {}) })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if ((isTrap(e) || kernel?.trapped != null) && msg.type !== 'init') {
        // Not a build: the kernel started again all the same, and the next
        // build plays the part on the new one.
        await restart().catch(() => {})
        return answer({ type: 'error', requestId: msg.requestId, message: `The CAD kernel crashed (${message}) and was started again — build the part again for what it held.` })
      }
      return answer({ type: 'error', requestId: msg.requestId, message })
    }
  }

  return { handle }
}

// SPDX-License-Identifier: AGPL-3.0-only
// The scan and the reference, held off the main thread from the moment
// their files are parsed: every fit, alignment, deviation map, thickness
// reading, section and search runs here on the worker's copy, and only the
// answers travel back. One request is answered at a time, in the order they
// came. A best fit runs in slices so that a stop can reach it between them,
// and a plugin's request that awaits holds the rest back until it settles —
// nothing may run on a scan swapped out in the gap. An import can be staged:
// prepared beside the models in use, put in their place when committed.

import type { MeshGraph, ParsedMesh, TextureNote, Vec3 } from './types'
import type { WorkerRequest, WorkerResponse } from './workerProtocol'
import { parseSTL } from './parsers/stl'
import { parsePLY } from './parsers/ply'
import { parseOBJ } from './parsers/obj'
import { parse3MF } from './parsers/threemf'
import type { ObjCompanions } from './parsers/objTexture'
import { parseSTEP, type StepInfo } from './parsers/step'
import { extensionOf } from './formats'
import { buildMeshGraph } from './geometry/buildGraph'
import { wireSlots } from './geometry/wireSlots'
import { scanRender, splitCreases, type CreaseSetting } from './geometry/crease'
import { getFitter, getSelectionFitter } from './elements/registry'
import { NominalSurface } from './deviation/surface'
import {
  alignFromPairsSteps,
  alignLocalSteps,
  autoAlignSteps,
  type AlignResult,
} from './deviation/align'
import type { Steps } from './deviation/steps'
import { computeDeviation, defaultMaxDistance, suggestRange } from './deviation/deviation'
import { rigidApplyToPoints, rigidInvert, rigidRotateVectors, type Rigid } from './deviation/rigid'
import { meshArea, meshLongEdges, readReference, sampleSpacing, subdivideForMap } from './deviation/onReference'
import { buildSolidIndex, computeThickness, suggestThicknessScale } from './thickness/thickness'
import { sliceMesh } from './section/slice'
import { shadowMesh } from './section/shadow'
import { meshCentroid } from './geometry/centroid'
import { trianglesWithin } from './geometry/region'
import { floodByNormal } from './fit/regionGrow'
import { planeRegionReport, segmentPlanes } from './fit/segment'
import { meanCurvature } from './geometry/curvature'
import { scanSpot } from './geometry/nearest'
import { boundsOf } from './geometry/bounds'
import { gatherVertices, queryVertices } from './geometry/query'
import { findSymmetryPlane } from './symmetry'
import { autoAlign } from './autoAlign'
import { workerPlugins } from './workerPlugins'
import type { WorkerContext } from './workerPluginApi'
import type { MeshBVH } from 'three-mesh-bvh'
import { reply } from './workerRpc'
import { firstHits, firstHitsAt, localNoise, scanRim, scanRims } from './geometry/scanQa'
import { sheetReading, type SheetReading } from './geometry/sheet'
import { rimLoops, type RimLoop } from './geometry/openEdges'
import { DEFAULT_VOLUME_BETA, volumeDeviation } from './deviation/volume'
import { WindingTree } from './deviation/winding'

let graph: MeshGraph | null = null
/** How far from the reference the scan is looked for, as a fraction of the
 *  scan's diagonal: past every search distance worth a map; the display's
 *  own search distance cuts it closer. */
const REFERENCE_REACH = 0.1
/** The share of the volume error's progress bar preparing the scan for it
 *  takes, when it has to. */
const PREPARE_SHARE = 0.3
/** The reference geometry, prepared for signed closest-point queries. Held
 *  across requests so an alignment and the deviation map that follows it do
 *  not each pay for the tree. */
let nominal: NominalSurface | null = null
/** A tree over the scan itself, for the wall thickness rays. Built on first
 *  use — most sessions never ask for it — and dropped whenever the scan's
 *  vertices change under it. */
let scanSolid: MeshBVH | null = null
/** The scan prepared for closest-point queries, for the symmetry search —
 *  the same structure a reference gets. Built on first use, and remembered
 *  with the graph it describes so a new scan or moved vertices drop it. */
let scanSurfaces = new WeakMap<MeshGraph, NominalSurface>()
/** The scan's winding-number tree, for the deviation as volumes: built on
 *  first use and kept, like the surface, with the graph it describes. */
let scanTrees = new WeakMap<MeshGraph, WindingTree>()
/** The scan's open rims walked round, by the index buffer they were walked
 *  on: topology alone, so an alignment that moves the vertices keeps them. */
const rimsOf = new WeakMap<Uint32Array, RimLoop[]>()
function scanLoops(g: MeshGraph): RimLoop[] {
  let loops = rimsOf.get(g.indices)
  if (!loops) {
    loops = rimLoops(g.indices)
    rimsOf.set(g.indices, loops)
  }
  return loops
}
const stagedScans = new Map<number, MeshGraph>()
const stagedNominals = new Map<number, NominalSurface>()

function post(msg: WorkerResponse, transfer: Transferable[] = []): void {
  reply(msg, transfer)
}

/** Hand the render thread the scan's geometry: its own copies of positions,
 *  normals and indices, with the sharp edges split for shading as `crease`
 *  asks. The worker keeps its index buffer — the fitting pipeline has no use
 *  for it, but a wall thickness ray does, and re-deriving it from the file
 *  would mean parsing and welding the whole scan again. The mesh mode's
 *  corner slots ride along: they come off the adjacency the graph already
 *  holds, and the render thread has no adjacency. */
function postScan(
  requestId: number,
  g: MeshGraph,
  crease: CreaseSetting,
  progress: (t: string) => void,
  file?: ScanFileFacts,
): void {
  if (crease.mode !== 'off') progress('Finding sharp edges…')
  const { positions, indices, normals, wireSlots: slots, copyOf, crease: report } = scanRender(g, crease)
  // The file's own colours are the render thread's alone: nothing measured
  // here reads them, and a worker restart reads the geometry back without.
  const colors = file?.colors && file.colors.length === g.vertexCount * 3 ? file.colors : undefined
  post(
    {
      type: 'loaded',
      requestId,
      positions,
      indices,
      normals,
      wireSlots: slots,
      copyOf,
      crease: report,
      vertexCount: g.vertexCount,
      triangleCount: indices.length / 3,
      ...(colors ? { colors } : {}),
      ...(file?.texture ? { texture: file.texture } : {}),
      ...(file?.step ? { step: file.step } : {}),
    },
    [positions.buffer, indices.buffer, normals.buffer, slots.buffer, copyOf.buffer, ...(colors ? [colors.buffer] : [])],
  )
}

/** What the scan's file said besides its geometry, for the render thread. */
interface ScanFileFacts {
  colors?: Uint8Array
  texture?: TextureNote
  step?: StepInfo
}

/** A file in other units brought to millimetres, before anything is built on
 *  it — the welded graph, the normals, the fits all see millimetres only. */
function scaleToMm(parsed: ParsedMesh, scale: number | undefined): void {
  if (scale === undefined || scale === 1) return
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('Invalid unit scale.')
  const p = parsed.positions
  for (let i = 0; i < p.length; i++) p[i] *= scale
}

function parseByName(name: string, buffer: ArrayBuffer, onProgress: (t: string) => void, companions?: ObjCompanions): ParsedMesh {
  const ext = extensionOf(name)
  if (ext === 'stl') return parseSTL(buffer, onProgress)
  if (ext === 'ply') return parsePLY(buffer, onProgress)
  if (ext === 'obj') return parseOBJ(buffer, onProgress, companions)
  if (ext === '3mf') return parse3MF(buffer, onProgress, companions)
  throw new Error(`Unsupported file type ".${ext}" — use STL, PLY, OBJ, 3MF or STEP.`)
}

/** The scan: a mesh, or a CAD part opened in a scan's place — cut finer
 *  than a reference is (see parsers/step), since it is worked on rather
 *  than measured against. */
function parseScan(name: string, buffer: ArrayBuffer, onProgress: (t: string) => void, companions?: ObjCompanions): { parsed: ParsedMesh; step?: StepInfo } {
  const ext = extensionOf(name)
  if (ext === 'step' || ext === 'stp') {
    const imported = parseSTEP(buffer, onProgress, true)
    return { parsed: imported.mesh, step: imported.info }
  }
  return { parsed: parseByName(name, buffer, onProgress, companions) }
}

/** The reference takes CAD as well as meshes: it is the nominal part, and the
 *  nominal part is what came out of the CAD system in the first place. */
function parseNominal(
  name: string,
  buffer: ArrayBuffer,
  onProgress: (t: string) => void,
): { parsed: ParsedMesh; step?: StepInfo } {
  const ext = extensionOf(name)
  if (ext === 'step' || ext === 'stp') {
    const imported = parseSTEP(buffer, onProgress)
    return { parsed: imported.mesh, step: imported.info }
  }
  if (ext === 'stl' || ext === 'ply' || ext === 'obj' || ext === '3mf') {
    return { parsed: parseByName(name, buffer, onProgress) }
  }
  throw new Error(`Unsupported file type ".${ext}" — use STL, PLY, OBJ, 3MF or STEP.`)
}

/**
 * The best fit in flight, and whether the user has asked for it to stop.
 *
 * It is the one request that does not run to completion inside its own message:
 * a fit can take a minute, and a worker in the middle of a minute of arithmetic
 * cannot hear anything, so "stop aligning" would have no way in. Instead the
 * fit is a generator (see deviation/steps.ts) driven a slice at a time, and
 * between slices the inbox is read — which is where the abort arrives.
 */
let alignRun: { steps: Steps<AlignResult>; requestId: number } | null = null
let alignAborted = false
/** A plugin's request that awaits — a library loading, say. Nothing may run
 *  inside the wait: a scan committed in the gap would be worked on as the
 *  scan it replaced. */
let holding = false
/** Requests that arrived while a fit or a held request was in flight. The
 *  worker's contract is that it answers one thing at a time, and slicing the
 *  fit must not quietly break it: everything but the abort waits its turn. */
const queued: Exclude<WorkerRequest, { type: 'align-abort' }>[] = []
/** How long a slice of the fit may hold the worker before it goes back to the
 *  inbox. Long enough that the slicing costs nothing measurable, short enough
 *  that a stop lands within a frame or two. */
const ALIGN_SLICE_MS = 25

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data
  // The abort jumps the queue by definition — it is aimed at the very thing
  // holding the queue up.
  if (msg.type === 'align-abort') {
    alignAborted = true
    return
  }
  if (alignRun || holding) {
    queued.push(msg)
    return
  }
  answer(msg)
}

/** Whatever came in while the fit had the floor, now that it does not. Requests
 *  are taken one at a time, and a fit or a held request among them takes the
 *  floor again — the rest keep waiting, in the order they arrived. */
function drainQueue(): void {
  while (queued.length > 0 && !alignRun && !holding) answer(queued.shift()!)
}

/** A request handled, and one that throws answered with its error. Drained
 *  from the queue, a throw would otherwise land in a promise's callback —
 *  no error the page hears of — and leave this request and every one queued
 *  behind it waiting forever. */
function answer(msg: Exclude<WorkerRequest, { type: 'align-abort' }>): void {
  try {
    handle(msg)
  } catch (e) {
    post({ type: 'error', requestId: msg.requestId, message: errorText(e) })
  }
}

/** The scan prepared for closest-point queries — the same structure a
 *  reference gets — built on first use and kept until the scan or its
 *  vertices change. */
function scanSurfaceOf(g: MeshGraph, progress: (t: string) => void, why: string): NominalSurface {
  let surface = scanSurfaces.get(g)
  if (!surface) {
    progress(why)
    surface = new NominalSurface(g.positions, g.indices)
    scanSurfaces.set(g, surface)
  }
  return surface
}

/** The scan was replaced or taken away: the plugins let go of what they made
 *  of the one before. */
const scanReplaced = () => {
  for (const p of workerPlugins) p.scanReplaced?.()
}

/** What the worker lends a plugin's request. */
const contextOf = (progress: (t: string) => void): WorkerContext => ({
  scan: () => graph,
  takeStaged: (id) => {
    const g = stagedScans.get(id)
    stagedScans.delete(id)
    return g
  },
  progress,
  surfaceOf: (g, why) => scanSurfaceOf(g, progress, why),
})

function handle(msg: Exclude<WorkerRequest, { type: 'align-abort' }>): void {
  const progress = (text: string, fraction?: number) => post({ type: 'progress', text, ...(fraction !== undefined ? { fraction } : {}) })

  if (msg.type === 'discard-import') {
    for (const id of msg.ids) { stagedScans.delete(id); stagedNominals.delete(id) }
    post({ type: 'import-ok', requestId: msg.requestId })
    return
  }
  if (msg.type === 'commit-import') {
    const nextScan = typeof msg.scan === 'number' ? stagedScans.get(msg.scan) : null
    const nextNominal = typeof msg.nominal === 'number' ? stagedNominals.get(msg.nominal) : null
    if (
      (typeof msg.scan === 'number' && !nextScan) ||
      (typeof msg.nominal === 'number' && !nextNominal)
    ) {
      post({ type: 'error', requestId: msg.requestId, message: 'The prepared import is no longer available.' })
      return
    }
    if (msg.scan !== undefined) {
      graph = nextScan ?? null
      scanSolid = null
      if (typeof msg.scan === 'number') stagedScans.delete(msg.scan)
      scanReplaced()
    }
    if (msg.nominal !== undefined) {
      nominal = nextNominal ?? null
      if (typeof msg.nominal === 'number') stagedNominals.delete(msg.nominal)
    }
    post({ type: 'import-ok', requestId: msg.requestId })
    return
  }

  if (msg.type === 'load') {
    try {
      const { parsed, step } = parseScan(msg.name, msg.buffer, progress, msg.companions)
      scaleToMm(parsed, msg.scale)
      const candidate = buildMeshGraph(parsed, progress)
      if (msg.transform) {
        rigidApplyToPoints(msg.transform, candidate.positions)
        rigidRotateVectors(msg.transform, candidate.normals)
      }
      postScan(msg.requestId, candidate, msg.crease, progress, { colors: parsed.colors, texture: parsed.texture, step })
      if (msg.staged) stagedScans.set(msg.requestId, candidate)
      else { graph = candidate; scanSolid = null; scanReplaced() }
    } catch (e) {
      post({ type: 'error', requestId: msg.requestId, message: errorText(e) })
    }
    return
  }

  if (msg.type === 'recrease') {
    if (!graph) {
      post({ type: 'error', requestId: msg.requestId, message: 'No model loaded.' })
      return
    }
    try {
      postScan(msg.requestId, graph, msg.crease, progress)
    } catch (e) {
      post({ type: 'error', requestId: msg.requestId, message: errorText(e) })
    }
    return
  }

  if (msg.type === 'fit') {
    if (!graph) {
      post({ type: 'error', requestId: msg.requestId, message: 'No model loaded.' })
      return
    }
    try {
      const result = getFitter(msg.elementType)(graph, msg.seeds, msg.settings, msg.window, msg.guide)
      post({ type: 'fit-ok', requestId: msg.requestId, result }, [result.region.buffer])
    } catch (e) {
      post({ type: 'error', requestId: msg.requestId, message: errorText(e) })
    }
    return
  }

  if (msg.type === 'fit-selection') {
    if (!graph) {
      post({ type: 'error', requestId: msg.requestId, message: 'No model loaded.' })
      return
    }
    try {
      // A vertex index out of range would read past the end of the position
      // buffer and quietly produce a fit of nonsense; the selection comes from
      // the render thread's copy of the mesh, so it can only disagree if the
      // two have drifted apart.
      for (let i = 0; i < msg.vertices.length; i++) {
        if (msg.vertices[i] >= graph.vertexCount) {
          throw new Error('The marked surface does not belong to the loaded scan.')
        }
      }
      const result = getSelectionFitter(msg.elementType)(
        graph,
        msg.vertices,
        msg.settings,
        msg.window,
      )
      post({ type: 'fit-ok', requestId: msg.requestId, result }, [result.region.buffer])
    } catch (e) {
      post({ type: 'error', requestId: msg.requestId, message: errorText(e) })
    }
    return
  }

  if (msg.type === 'load-nominal') {
    try {
      const { parsed, step } = parseNominal(msg.name, msg.buffer, progress)
      scaleToMm(parsed, msg.scale)
      // The nominal goes through the same welding as a scan: the pseudonormals
      // that give a signed distance its sign are sums over the faces meeting at
      // a vertex or an edge, and an unwelded triangle soup has no such thing.
      // A STEP import is welded already, so this only pays for a pass over it.
      const g = buildMeshGraph(parsed, progress)
      progress('Indexing reference geometry…')
      const candidate = new NominalSurface(g.positions, g.indices)
      // The reference is CAD, so its sharp edges are always drawn sharp —
      // see geometry/crease.ts. Only the picture is split: the surface the
      // distances are measured to is the welded one above.
      const slotsOwn = wireSlots(g.adjOffsets, g.adjList, g.vertexCount)
      const split = splitCreases(g.positions, g.indices, slotsOwn)
      const positions = split ? split.positions : g.positions.slice()
      const indices = split ? split.indices : g.indices.slice()
      const normals = split ? split.normals : g.normals.slice()
      const slots = split ? split.wireSlots : slotsOwn
      post(
        {
          type: 'nominal-loaded',
          requestId: msg.requestId,
          positions,
          indices,
          normals,
          wireSlots: slots,
          vertexCount: g.vertexCount,
          triangleCount: g.triangleCount,
          bboxDiagonal: candidate.bboxDiagonal,
          step,
        },
        [positions.buffer, indices.buffer, normals.buffer, slots.buffer],
      )
      if (msg.staged) stagedNominals.set(msg.requestId, candidate)
      else nominal = candidate
    } catch (e) {
      post({ type: 'error', requestId: msg.requestId, message: errorText(e) })
    }
    return
  }

  if (msg.type === 'align') {
    if (!graph || !nominal) {
      post({
        type: 'error',
        requestId: msg.requestId,
        message: 'Load both a scan and a reference geometry first.',
      })
      return
    }
    try {
      const options = {
        onProgress: progress,
        // One small message per refinement pass — a pass costs tens of
        // milliseconds of closest-point queries, so the post is noise beside it
        // and the viewport gets to show the part settling into place.
        onTransform: (transform: Rigid, iteration: number, meanDistance: number) =>
          post({
            type: 'align-progress',
            requestId: msg.requestId,
            transform: { r: transform.r.slice(), t: transform.t.slice() },
            iteration,
            meanDistance,
          }),
      }
      let steps
      if (msg.mode === 'auto') {
        steps = autoAlignSteps(nominal, graph.positions, graph.normals, options)
      } else if (msg.mode === 'points') {
        checkVertices(msg.vertices, graph.vertexCount)
        steps = alignFromPairsSteps(
          nominal,
          graph.positions,
          graph.normals,
          msg.pairs,
          options,
          msg.vertices,
        )
      } else {
        checkVertices(msg.vertices, graph.vertexCount)
        steps = alignLocalSteps(nominal, graph.positions, graph.normals, msg.vertices, msg.start, {
          ...options,
          maxDistance: msg.maxDistance,
        })
      }
      alignRun = { steps, requestId: msg.requestId }
      alignAborted = false
      pumpAlign()
    } catch (e) {
      post({ type: 'error', requestId: msg.requestId, message: errorText(e) })
    }
    return
  }

  if (msg.type === 'transform') {
    if (!graph) {
      post({ type: 'error', requestId: msg.requestId, message: 'No model loaded.' })
      return
    }
    // Bake the alignment into the vertices so every later fit measures in the
    // new frame. Rigid, so the adjacency graph and bbox diagonal still hold.
    rigidApplyToPoints(msg.transform, graph.positions)
    rigidRotateVectors(msg.transform, graph.normals)
    // What the plugins keep in the scan's frame stays in it.
    for (const p of workerPlugins) p.transformed?.(msg.transform)
    // The vertices moved, so the tree built over them no longer describes
    // them. Thickness itself is unaffected — it is a property of the part, not
    // of where the part sits.
    scanSolid = null
    scanSurfaces = new WeakMap()
    scanTrees = new WeakMap()
    post({ type: 'transform-ok', requestId: msg.requestId })
    return
  }

  if (msg.type === 'flood') {
    if (!graph) {
      post({ type: 'error', requestId: msg.requestId, message: 'No model loaded.' })
      return
    }
    const vertices = floodByNormal(graph, msg.seed, msg.maxAngleDeg, msg.limit)
    post({ type: 'flood-ok', requestId: msg.requestId, vertices }, [vertices.buffer])
    return
  }

  if (msg.type === 'plane-region' || msg.type === 'segment') {
    if (!graph) {
      post({ type: 'error', requestId: msg.requestId, message: 'No model loaded.' })
      return
    }
    try {
      if (msg.type === 'plane-region') {
        checkVertices(msg.vertices, graph.vertexCount)
        const result = planeRegionReport(graph, msg.vertices, msg.normal ? { normal: msg.normal, seed: msg.seed } : undefined, msg.cylinder ? { ...msg.cylinder, seed: msg.seed } : undefined)
        post({ type: 'plane-region-ok', requestId: msg.requestId, result })
      } else {
        const result = segmentPlanes(graph, msg.options)
        post({ type: 'segment-ok', requestId: msg.requestId, result }, [result.vertices.buffer, result.offsets.buffer])
      }
    } catch (e) {
      post({ type: 'error', requestId: msg.requestId, message: errorText(e) })
    }
    return
  }

  if (msg.type === 'nearest') {
    if (!graph) {
      post({ type: 'error', requestId: msg.requestId, message: 'No model loaded.' })
      return
    }
    try {
      const at = msg.vertex !== undefined ? { vertex: msg.vertex } : msg.point ? { point: msg.point } : null
      if (!at) throw new Error('Name a vertex or a point.')
      post({ type: 'nearest-ok', requestId: msg.requestId, result: scanSpot(graph, at) })
    } catch (e) {
      post({ type: 'error', requestId: msg.requestId, message: errorText(e) })
    }
    return
  }

  if (msg.type === 'bounds') {
    if (!graph) {
      post({ type: 'error', requestId: msg.requestId, message: 'No model loaded.' })
      return
    }
    const { min, max } = boundsOf(graph.positions, graph.vertexCount)
    post({ type: 'bounds-ok', requestId: msg.requestId, min, max })
    return
  }

  if (msg.type === 'query') {
    if (!graph) {
      post({ type: 'error', requestId: msg.requestId, message: 'No model loaded.' })
      return
    }
    const found = queryVertices(graph, { min: msg.min, max: msg.max, normal: msg.normal, limit: msg.limit })
    const { positions, normals } = gatherVertices(graph, found.vertices)
    post(
      { type: 'query-ok', requestId: msg.requestId, vertices: found.vertices, positions, normals, matched: found.matched, step: found.step },
      [found.vertices.buffer, positions.buffer, normals.buffer],
    )
    return
  }

  if (msg.type === 'heights' || msg.type === 'scan-qa' || msg.type === 'scan-rim') {
    if (!graph) {
      post({ type: 'error', requestId: msg.requestId, message: 'No model loaded.' })
      return
    }
    try {
      if (msg.type === 'heights') {
        if (!scanSolid) scanSolid = buildSolidIndex(graph.positions, graph.indices)
        if (msg.corners) {
          const { values, corners, weights } = firstHitsAt(scanSolid, graph.positions, msg.grid)
          post({ type: 'heights-ok', requestId: msg.requestId, values, corners, weights }, [values.buffer, corners.buffer, weights.buffer])
        } else {
          const values = firstHits(scanSolid, msg.grid)
          post({ type: 'heights-ok', requestId: msg.requestId, values }, [values.buffer])
        }
      } else if (msg.type === 'scan-rim') {
        const rim = scanRim(graph.positions, graph.indices, scanLoops(graph), msg.index)
        post({ type: 'scan-rim-ok', requestId: msg.requestId, rim }, rim ? [rim.vertices.buffer, rim.positions.buffer, rim.corners.buffer] : [])
      } else {
        const rims = scanRims(graph.positions, scanLoops(graph), msg.rims)
        const noise = localNoise(graph, msg.sample)
        let sheet: SheetReading | undefined
        if (msg.sheet) {
          if (!scanSolid) scanSolid = buildSolidIndex(graph.positions, graph.indices)
          sheet = sheetReading(graph, scanSolid, { ...msg.sheet, noise: noise.median })
        }
        post({ type: 'scan-qa-ok', requestId: msg.requestId, rims, noise, ...(sheet ? { sheet } : {}) })
      }
    } catch (e) {
      post({ type: 'error', requestId: msg.requestId, message: errorText(e) })
    }
    return
  }

  if (msg.type === 'curvature') {
    if (!graph) {
      post({ type: 'error', requestId: msg.requestId, message: 'No model loaded.' })
      return
    }
    const values = meanCurvature(graph)
    post({ type: 'curvature-ok', requestId: msg.requestId, values }, [values.buffer])
    return
  }

  if (msg.type === 'centroid') {
    if (!graph) {
      post({ type: 'error', requestId: msg.requestId, message: 'No model loaded.' })
      return
    }
    try {
      // A marked surface is its whole triangles — the ones the tint colours.
      let indices = graph.indices
      if (msg.vertices) {
        checkVertices(msg.vertices, graph.vertexCount)
        indices = trianglesWithin(graph.indices, msg.vertices, graph.vertexCount)
        if (indices.length === 0) throw new Error('The marked surface holds no whole triangle — mark a wider patch.')
      }
      post({ type: 'centroid-ok', requestId: msg.requestId, result: meshCentroid(graph.positions, indices) })
    } catch (e) {
      post({ type: 'error', requestId: msg.requestId, message: errorText(e) })
    }
    return
  }

  if (msg.type === 'symmetry') {
    if (!graph) {
      post({ type: 'error', requestId: msg.requestId, message: 'No model loaded.' })
      return
    }
    try {
      let surface: NominalSurface
      if (msg.vertices) {
        // Only the marked triangles are surface the mirror images may land
        // on — a fixture left out of the marking is invisible to the search
        // on both sides. Built per request: a marking is smaller than the
        // scan, and the next one is a different surface.
        checkVertices(msg.vertices, graph.vertexCount)
        const marked = trianglesWithin(graph.indices, msg.vertices, graph.vertexCount)
        if (marked.length < 3 * 10)
          throw new Error('The marked surface holds too few whole triangles to search — mark a wider patch.')
        progress('Preparing the marked surface for the symmetry search…')
        surface = new NominalSurface(graph.positions, marked)
      } else {
        surface = scanSurfaceOf(graph, progress, 'Preparing the scan for the symmetry search…')
      }
      // Without a seed the part's own face directions stand beside the
      // principal planes as candidates: a lug or a patch the scanner missed
      // turns the principal axes, not the faces. A part that names none
      // simply adds none.
      let directions: Vec3[] | undefined
      if (!msg.seed) {
        progress('Reading the part’s directions…')
        try {
          directions = autoAlign(graph).axes
        } catch {
          directions = undefined
        }
      }
      const result = findSymmetryPlane(surface, graph.positions, graph.normals, msg.seed, {
        onProgress: progress,
        vertices: msg.vertices,
        directions,
      })
      post({ type: 'symmetry-ok', requestId: msg.requestId, result })
    } catch (e) {
      post({ type: 'error', requestId: msg.requestId, message: errorText(e) })
    }
    return
  }

  if (msg.type === 'plugin') {
    const plugin = workerPlugins.find((p) => p.id === msg.plugin)
    const fail = (e: unknown) => post({ type: 'error', requestId: msg.requestId, message: errorText(e) })
    if (!plugin) {
      fail(new Error(`No worker part for the plugin "${msg.plugin}".`))
      return
    }
    try {
      const reply = plugin.handle(msg.op, msg.payload, contextOf(progress))
      if (!(reply instanceof Promise)) {
        post({ type: 'plugin-ok', requestId: msg.requestId, result: reply.result }, reply.transfer ?? [])
        return
      }
      // An answer that awaits holds the queue until it settles.
      holding = true
      reply
        .then((r) => post({ type: 'plugin-ok', requestId: msg.requestId, result: r.result }, r.transfer ?? []))
        .catch(fail)
        .finally(() => {
          holding = false
          drainQueue()
        })
    } catch (e) {
      fail(e)
    }
    return
  }

  if (msg.type === 'auto-align') {
    if (!graph) {
      post({ type: 'error', requestId: msg.requestId, message: 'No model loaded.' })
      return
    }
    try {
      progress('Reading the part’s directions…')
      post({ type: 'auto-align-ok', requestId: msg.requestId, result: autoAlign(graph) })
    } catch (e) {
      post({ type: 'error', requestId: msg.requestId, message: errorText(e) })
    }
    return
  }

  if (msg.type === 'section') {
    if (!graph) {
      post({ type: 'error', requestId: msg.requestId, message: 'No model loaded.' })
      return
    }
    try {
      // The vertices here carry every alignment baked so far, so the cut
      // lands in the same frame the elements are measured in.
      const cut = sliceMesh(graph.positions, graph.indices, msg.origin, msg.normal, {
        minLength: msg.minLength,
      })
      post(
        { type: 'section-ok', requestId: msg.requestId, points: cut.points, offsets: cut.offsets, normals: cut.normals },
        cut.normals ? [cut.points.buffer, cut.offsets.buffer, cut.normals.buffer] : [cut.points.buffer, cut.offsets.buffer],
      )
    } catch (e) {
      post({ type: 'error', requestId: msg.requestId, message: errorText(e) })
    }
    return
  }

  if (msg.type === 'shadow') {
    if (!graph) {
      post({ type: 'error', requestId: msg.requestId, message: 'No model loaded.' })
      return
    }
    try {
      // On the aligned vertices, as a cut is.
      const cut = shadowMesh(graph.positions, graph.indices, msg.frame, { tolerance: msg.tolerance, play: msg.play, smoothDeg: msg.smoothDeg })
      post(
        { type: 'section-ok', requestId: msg.requestId, points: cut.points, offsets: cut.offsets, normals: cut.normals, shadow: cut.shadow },
        cut.normals ? [cut.points.buffer, cut.offsets.buffer, cut.normals.buffer] : [cut.points.buffer, cut.offsets.buffer],
      )
    } catch (e) {
      post({ type: 'error', requestId: msg.requestId, message: errorText(e) })
    }
    return
  }

  if (msg.type === 'thickness') {
    if (!graph) {
      post({ type: 'error', requestId: msg.requestId, message: 'No model loaded.' })
      return
    }
    try {
      if (!scanSolid) {
        progress('Indexing the scan for thickness…')
        scanSolid = buildSolidIndex(graph.positions, graph.indices)
      }
      let lastPercent = -1
      const values = computeThickness(
        scanSolid,
        graph.positions,
        graph.normals,
        {
          method: msg.method,
          coneRays: msg.coneRays,
          coneAngle: (msg.coneAngleDeg * Math.PI) / 180,
          maxNormalDeviation:
            msg.normalDeviationDeg === null ? null : (msg.normalDeviationDeg * Math.PI) / 180,
          maxThickness: msg.maxThickness,
          // A hair off the surface, scaled to the part: enough that a ray
          // never scores a hit on the triangle it left from, small enough
          // never to reach across a real wall.
          epsilon: Math.max(1e-6, graph.bboxDiag * 1e-5),
        },
        (f) => {
          const percent = Math.round(f * 100)
          if (percent === lastPercent) return
          lastPercent = percent
          progress(`Measuring wall thickness — ${percent}%…`)
        },
      )
      const { low, high } = suggestThicknessScale(values)
      post(
        {
          type: 'thickness-ok',
          requestId: msg.requestId,
          values,
          suggestedLow: low,
          suggestedHigh: high,
        },
        [values.buffer],
      )
    } catch (e) {
      post({ type: 'error', requestId: msg.requestId, message: errorText(e) })
    }
    return
  }

  if (msg.type === 'deviate-reference') {
    const mesh = msg.mesh ?? (nominal ? { positions: nominal.positions, indices: nominal.index } : null)
    if (!graph || !mesh) {
      post({ type: 'error', requestId: msg.requestId, message: 'Load both a scan and a reference geometry first.' })
      return
    }
    try {
      const scan = scanSurfaceOf(graph, progress, 'Preparing the scan for the map on the reference…')
      const spacing = sampleSpacing(meshArea(mesh.positions, mesh.indices), msg.spacing, meshLongEdges(mesh.positions, mesh.indices))
      progress(`Cutting the reference into readings ${spacing} mm apart…`) // units-ok: built in the worker
      const samples = subdivideForMap(mesh.positions, mesh.indices, null, spacing)
      let lastPercent = -1
      const values = readReference(scan, samples, {
        toScan: rigidInvert(msg.transform),
        reach: graph.bboxDiag * REFERENCE_REACH,
        facingDeg: msg.facingDeg,
        onProgress: (f) => {
          const percent = Math.round(f * 100)
          if (percent === lastPercent) return
          lastPercent = percent
          progress(`Measuring the reference against the scan — ${percent}%…`)
        },
      })
      post(
        { type: 'reference-deviation-ok', requestId: msg.requestId, ...samples, wanted: msg.spacing, values },
        [samples.positions.buffer, samples.normals.buffer, samples.indices.buffer, samples.parent.buffer, values.buffer],
      )
    } catch (e) {
      post({ type: 'error', requestId: msg.requestId, message: errorText(e) })
    }
    return
  }

  if (msg.type === 'deviate-volume') {
    const mesh = msg.mesh ?? (nominal ? { positions: nominal.positions, indices: nominal.index } : null)
    if (!graph || !mesh) {
      post({ type: 'error', requestId: msg.requestId, message: 'Load both a scan and a reference geometry first.' })
      return
    }
    try {
      const g = graph
      // Preparing the scan, the first time, takes about a third of the
      // whole: the bar gives it that share.
      const fresh = !scanTrees.has(g)
      const share = fresh ? PREPARE_SHARE : 0
      const scanSurface = scanSurfaceOf(g, (t) => progress(t, 0), 'Preparing the scan for the volume error…')
      let scanTree = scanTrees.get(g)
      if (!scanTree) {
        progress('Preparing the scan for the volume error…', share / 2)
        scanTree = new WindingTree(g.positions, g.indices, { beta: DEFAULT_VOLUME_BETA })
        scanTrees.set(g, scanTree)
      }
      const volume = volumeDeviation({
        reference: mesh,
        scan: { positions: g.positions, indices: g.indices },
        toReference: msg.transform,
        tolerance: msg.tolerance,
        ...(msg.cell !== undefined ? { cell: msg.cell } : {}),
        ...(msg.within ? { within: msg.within } : {}),
        scanSurface,
        scanTree,
        scanRims: scanLoops(g),
        meshes: true,
        onProgress: (text, fraction) => progress(text, share + (1 - share) * fraction),
      })
      const shells = volume.meshes ? Object.values(volume.meshes) : []
      post({ type: 'volume-deviation-ok', requestId: msg.requestId, volume }, shells.flatMap((m) => [m.positions.buffer, m.indices.buffer, m.region.buffer]))
    } catch (e) {
      post({ type: 'error', requestId: msg.requestId, message: errorText(e) })
    }
    return
  }

  if (msg.type === 'deviate') {
    if (!graph || !nominal) {
      post({
        type: 'error',
        requestId: msg.requestId,
        message: 'Load both a scan and a reference geometry first.',
      })
      return
    }
    try {
      let lastPercent = -1
      const directions = new Int8Array(graph.positions.length)
      const values = computeDeviation(nominal, graph.positions, msg.transform, {
        onProgress: (f) => {
          const percent = Math.round(f * 100)
          if (percent === lastPercent) return
          lastPercent = percent
          progress(`Measuring the scan against the reference — ${percent}%…`)
        },
        directions,
        // Rotated along with the positions whenever an alignment is baked in,
        // so they stand in the same frame the transform starts from.
        normals: graph.normals,
        maxNormalDeviation: msg.facingDeg === null ? null : (msg.facingDeg * Math.PI) / 180,
      })
      const suggestedMaxDistance = defaultMaxDistance(graph.bboxDiag)
      post(
        {
          type: 'deviation-ok',
          requestId: msg.requestId,
          values,
          directions,
          suggestedRange: suggestRange(values, suggestedMaxDistance),
          suggestedMaxDistance,
        },
        [values.buffer, directions.buffer],
      )
    } catch (e) {
      post({ type: 'error', requestId: msg.requestId, message: errorText(e) })
    }
  }
}

/** An index past the end of the scan would read whatever follows the position
 *  buffer and fit to it. The selection comes from the render thread's copy of
 *  the mesh, so it can only disagree if the two have drifted apart. */
function checkVertices(vertices: Uint32Array | undefined, vertexCount: number): void {
  if (!vertices) return
  for (let i = 0; i < vertices.length; i++) {
    if (vertices[i] >= vertexCount) {
      throw new Error('The marked surface does not belong to the loaded scan.')
    }
  }
}

/**
 * Run the fit for a slice, then either finish it or come back for another.
 *
 * The slice is what makes stopping possible at all: control has to return to
 * the event loop for the abort to be delivered, and a `setTimeout` is the only
 * yield a worker has that lets a queued message through first. Whatever pose
 * the fit had reached is thrown away with it — a half-converged alignment is
 * not a measurement, and the one that was in hand before is still good.
 */
function pumpAlign(): void {
  const run = alignRun
  if (!run) return
  try {
    const until = performance.now() + ALIGN_SLICE_MS
    for (;;) {
      if (alignAborted) {
        alignRun = null
        post({ type: 'align-stopped', requestId: run.requestId })
        break
      }
      const step = run.steps.next()
      if (step.done) {
        alignRun = null
        post({ type: 'align-ok', requestId: run.requestId, result: step.value })
        break
      }
      if (performance.now() >= until) {
        setTimeout(pumpAlign, 0)
        return
      }
    }
  } catch (e) {
    alignRun = null
    post({ type: 'error', requestId: run.requestId, message: errorText(e) })
  }
  drainQueue()
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

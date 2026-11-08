// SPDX-License-Identifier: AGPL-3.0-only
// Mesh Tools' part of the mesh worker: the operations core/protocol.ts names,
// on the mesh the workspace works on — the edited copy when there is one,
// else the scan. The copy is held here, beside the scan the worker holds, in
// the scan's frame: moved with it by every alignment, and gone with it when
// another scan takes its place.

import type { MeshGraph } from '../../src/core/types'
import type { WorkerContext, WorkerPlugin, WorkerReply } from '../../src/core/workerPluginApi'
import { emptyHit } from '../../src/core/deviation/surface'
import { rigidApplyToPoints, rigidRotateVectors } from '../../src/core/deviation/rigid'
import { buildAdjacency } from '../../src/core/geometry/adjacency'
import { wireSlots } from '../../src/core/geometry/wireSlots'
import { scanRender } from '../../src/core/geometry/crease'
import { loadSimplifier, reduceMesh } from './core/reduce'
import { maskedTriangles, surveyPieces, withoutTriangles } from './core/pieces'
import { markedTriangles, type EditedMesh } from './core/edit'
import { flipTriangles } from './core/flip'
import { cutMesh, cutPreview } from './core/cut'
import { mirrorMesh } from './core/mirror'
import { fillHoles, surveyHoles } from './core/fillHoles'
import { smoothMesh } from './core/smooth'
import { booleanMesh, closedness } from './core/boolean'
import { offsetMesh, thickenMesh } from './core/offset'
import { hollowMesh } from './core/hollow'
import { loadManifold } from './core/manifold'
import { defaultBreakSpeck, findBreak } from './core/breakSurface'
import { prepareBody, trimToScan, type PreparedBody } from './core/trimToScan'
import { selectVertices } from './core/select'
import { MESH_TOOLS, type MeshEditReport, type MeshToolsOps, type TrimBody } from './core/protocol'
import { extentOf } from '../../src/core/geometry/bounds'
import { tetraVolume6 } from '../../src/core/geometry/centroid'

/** The copy of the scan the workspace edits — null until its first edit,
 *  and again once the copy is taken into use or thrown away. */
let edited: MeshGraph | null = null

/** The body Trim to scan last cut, prepared — welded, its surface built —
 *  under its key: finding the break and making the piece ask for the same
 *  body one after the other. */
let trimBody: { key: string; body: PreparedBody } | null = null

type Payload<K extends keyof MeshToolsOps> = MeshToolsOps[K]['payload']

function subjectOf(ctx: WorkerContext): MeshGraph {
  const g = edited ?? ctx.scan()
  if (!g) throw new Error('No model loaded.')
  return g
}

async function preparedBody(tool: TrimBody, ctx: WorkerContext): Promise<PreparedBody> {
  if (trimBody?.key === tool.key) return trimBody.body
  ctx.progress('Loading the mesh boolean…')
  const wasm = await loadManifold()
  ctx.progress(`Preparing ${tool.name ?? 'the body'}…`)
  const body = prepareBody(wasm, tool, tool.name)
  trimBody = { key: tool.key, body }
  return body
}

const ops: { [K in keyof MeshToolsOps]: (payload: Payload<K>, ctx: WorkerContext) => WorkerReply | Promise<WorkerReply> } = {
  async reduce({ settings }, ctx) {
    // The mesh the request came for: a copy put in place meanwhile waits
    // behind this, as every other request does.
    const g = subjectOf(ctx)
    ctx.progress('Loading the mesh reducer…')
    const simplifier = await loadSimplifier()
    const result = reduceMesh(simplifier, g, settings, () => ctx.surfaceOf(g, 'Preparing the scan to measure the reduction against…'), ctx.progress)
    const vertexCount = result.positions.length / 3
    const adjacency = buildAdjacency(result.indices, vertexCount)
    const slots = wireSlots(adjacency.offsets, adjacency.list, vertexCount)
    return {
      result: { positions: result.positions, indices: result.indices, wireSlots: slots, vertexMap: result.vertexMap, deviation: result.deviation, report: result.report },
      transfer: [result.positions.buffer, result.indices.buffer, slots.buffer, result.vertexMap.buffer, result.deviation.buffer],
    }
  },

  islands({ minSize }, ctx) {
    const g = subjectOf(ctx)
    if (!(minSize > 0)) throw new Error('The size must be more than zero.')
    const { islandMask, islandCentres: centres, ...survey } = surveyPieces(g.positions, g.indices, g.vertexCount, minSize)
    const triangles = maskedTriangles(g.positions, g.indices, islandMask)
    return { result: { survey, triangles, centres }, transfer: [triangles.buffer, centres.buffer] }
  },

  'remove-islands'({ minSize }, ctx) {
    const g = subjectOf(ctx)
    if (!(minSize > 0)) throw new Error('The size must be more than zero.')
    const { islandMask, islandCentres: _centres, ...survey } = surveyPieces(g.positions, g.indices, g.vertexCount, minSize)
    void _centres
    if (survey.islands === 0) throw new Error('No piece of the scan is smaller than that.')
    if (survey.islands === survey.pieces) throw new Error('Every piece of the scan is smaller than that — nothing would be left.')
    const kept = withoutTriangles(g.positions, g.indices, g.vertexCount, islandMask)
    return { result: { survey, ...kept }, transfer: [kept.positions.buffer, kept.indices.buffer, kept.vertexMap.buffer] }
  },

  holes({ maxSize }, ctx) {
    const g = subjectOf(ctx)
    if (!(maxSize > 0)) throw new Error('The size must be more than zero.')
    const { survey, marks } = surveyHoles(g.positions, g.indices, g.vertexCount, maxSize)
    return {
      result: { survey, holes: marks.holes, centres: marks.centres, open: marks.open },
      transfer: [marks.holes.buffer, marks.centres.buffer, marks.open.buffer],
    }
  },

  'cut-preview'({ origin, normal }, ctx) {
    const g = subjectOf(ctx)
    const preview = cutPreview(g.positions, g.indices, g.vertexCount, origin, normal)
    return { result: preview, transfer: [preview.cap.buffer, preview.open.buffer] }
  },

  closedness(_payload, ctx) {
    const g = subjectOf(ctx)
    return { result: closedness(g.indices, g.vertexCount) }
  },

  'edited-deviation'({ fromScan }, ctx) {
    const g = ctx.scan()
    const e = edited
    if (!g || !e) throw new Error('There is no edited copy to measure.')
    // The copy's vertices that were the scan's: every other one is surface an
    // edit made — a fill, a cut's cap — with nothing of the scan under it to
    // be measured against, and is left unmeasured.
    const kept = new Uint8Array(e.vertexCount)
    for (let v = 0; v < fromScan.length; v++) {
      const to = fromScan[v]
      if (to >= 0 && to < e.vertexCount) kept[to] = 1
    }
    const surface = ctx.surfaceOf(g, 'Preparing the scan to measure the edited copy against…')
    ctx.progress('Measuring the edited copy against the scan…')
    const values = new Float32Array(e.vertexCount).fill(NaN)
    const hit = emptyHit()
    for (let v = 0; v < e.vertexCount; v++) {
      if (!kept[v]) continue
      surface.closest(e.positions[v * 3], e.positions[v * 3 + 1], e.positions[v * 3 + 2], hit)
      values[v] = hit.signed
    }
    return { result: values, transfer: [values.buffer] }
  },

  // The edits: each hands back the edited copy as it is to be, the way Remove
  // islands does, and leaves the worker's own alone — the session keeps it as
  // a file and loads it back as the copy.
  async edit({ edit }, ctx) {
    const g = subjectOf(ctx)
    let result: EditedMesh
    let report: MeshEditReport
    if (edit.type === 'delete-marked') {
      const { mask, count } = markedTriangles(g.indices, edit.vertices, g.vertexCount)
      if (count === 0) throw new Error('Nothing is marked — mark the surface to delete on the part first.')
      if (count === g.triangleCount) throw new Error('The whole scan is marked — nothing would be left.')
      result = withoutTriangles(g.positions, g.indices, g.vertexCount, mask)
      report = { kind: 'delete', triangles: count }
    } else if (edit.type === 'flip') {
      let mask: Uint8Array | undefined
      if (edit.vertices) {
        const marked = markedTriangles(g.indices, edit.vertices, g.vertexCount)
        if (marked.count === 0) throw new Error('No triangle has all three corners marked — mark the surface to flip on the part first.')
        mask = marked.mask
      }
      const flipped = flipTriangles(g.positions, g.indices, g.vertexCount, mask)
      result = flipped
      report = { kind: 'flip', triangles: flipped.flipped }
    } else if (edit.type === 'cut') {
      ctx.progress('Cutting the scan…')
      const cut = cutMesh(g.positions, g.indices, g.vertexCount, edit.origin, edit.normal, edit.cap)
      result = cut
      report = { kind: 'cut', report: cut.report }
    } else if (edit.type === 'mirror') {
      ctx.progress('Mirroring the scan…')
      const mirrored = mirrorMesh(g.positions, g.indices, g.vertexCount, edit.origin, edit.normal, edit.mode)
      result = mirrored
      report = { kind: 'mirror', report: mirrored.report }
    } else if (edit.type === 'fill-holes') {
      ctx.progress('Filling holes…')
      const filled = fillHoles(g.positions, g.indices, g.vertexCount, edit.maxSize, edit.mode, ctx.progress, edit.at)
      result = filled
      report = { kind: 'fill', report: filled.report }
    } else if (edit.type === 'smooth') {
      ctx.progress('Smoothing…')
      const smoothed = smoothMesh(g.positions, g.indices, g.vertexCount, edit.settings, ctx.progress)
      result = smoothed
      report = { kind: 'smooth', report: smoothed.report }
    } else if (edit.type === 'offset') {
      const surface = () => ctx.surfaceOf(g, 'Preparing the surface to keep the move clear of it…')
      const moved = offsetMesh(g.positions, g.indices, g.vertexCount, edit.settings, ctx.progress, surface)
      result = moved
      report = { kind: 'offset', report: moved.report }
    } else if (edit.type === 'hollow') {
      const surface = ctx.surfaceOf(g, 'Preparing the part to measure the wall against…')
      ctx.progress('Loading the mesh reducer…')
      const simplifier = await loadSimplifier()
      const hollowed = hollowMesh(g.positions, g.indices, g.vertexCount, edit.thickness, surface, simplifier, ctx.progress)
      result = hollowed
      report = { kind: 'hollow', report: hollowed.report }
    } else if (edit.type === 'thicken') {
      const surface = () => ctx.surfaceOf(g, 'Preparing the surface to keep the second skin clear of it…')
      const thick = thickenMesh(g.positions, g.indices, g.vertexCount, edit.thickness, edit.side, ctx.progress, surface)
      result = thick
      report = { kind: 'thicken', report: thick.report }
    } else {
      ctx.progress('Loading the mesh boolean…')
      const wasm = await loadManifold()
      const what = edit.tools.length === 1 ? 'the solid' : 'the solids'
      ctx.progress(edit.op === 'subtract' ? `Taking ${what} out of the mesh…` : edit.op === 'add' ? `Adding ${what} to the mesh…` : `Keeping what the mesh and ${what} share…`)
      const made = booleanMesh(wasm, g, edit.tools, edit.op)
      result = made
      report = { kind: 'boolean', report: made.report }
    }
    const { positions, indices, vertexMap } = result
    return { result: { positions, indices, vertexMap, report }, transfer: [positions.buffer, indices.buffer, vertexMap.buffer] }
  },

  describe(_payload, ctx) {
    const g = subjectOf(ctx)
    const { positions: p, indices } = g
    const { min, max } = extentOf(p, g.vertexCount)
    const shut = closedness(indices, g.vertexCount)
    // The enclosed volume by the divergence theorem: a tetrahedron from the
    // origin to each triangle, signed by its winding.
    let six = 0
    if (shut.open === 0 && shut.bad === 0) {
      for (let t = 0; t < indices.length; t += 3) six += tetraVolume6(p, indices[t] * 3, indices[t + 1] * 3, indices[t + 2] * 3)
    }
    return {
      result: {
        vertices: g.vertexCount,
        triangles: g.triangleCount,
        bounds: { min, max },
        ...shut,
        volume: shut.open === 0 && shut.bad === 0 ? six / 6 : null,
      },
    }
  },

  triangles(_payload, ctx) {
    const g = subjectOf(ctx)
    const positions = g.positions.slice(0, g.vertexCount * 3)
    const indices = g.indices.slice()
    return { result: { positions, indices }, transfer: [positions.buffer, indices.buffer] }
  },

  select({ region }, ctx) {
    const g = subjectOf(ctx)
    const vertices = selectVertices(g.positions, g.normals, g.vertexCount, region)
    return { result: { vertices, vertexCount: g.vertexCount }, transfer: [vertices.buffer] }
  },

  'set-edited'({ staged }, ctx) {
    if (staged === null) edited = null
    else {
      const g = ctx.takeStaged(staged)
      if (!g) throw new Error('The prepared import is no longer available.')
      edited = g
    }
    return { result: null }
  },

  async 'find-break'({ body, depth }, ctx) {
    const g = subjectOf(ctx)
    const prepared = await preparedBody(body, ctx)
    ctx.progress('Finding the break…')
    const found = findBreak(g.positions, g.indices, g.vertexCount, prepared.surface, {
      depth,
      minPiece: defaultBreakSpeck(prepared.surface.bboxDiagonal),
    })
    return { result: { vertices: found.vertices, report: found.report }, transfer: [found.vertices.buffer] }
  },

  async 'trim-to-scan'({ body, settings }, ctx) {
    const g = subjectOf(ctx)
    const prepared = await preparedBody(body, ctx)
    const wasm = await loadManifold()
    const piece = trimToScan(wasm, g, prepared, settings, ctx.progress, () => ctx.surfaceOf(g, 'Preparing the scan to read the piece against…'))
    const vertexCount = piece.positions.length / 3
    const adjacency = buildAdjacency(piece.indices, vertexCount)
    const slots = wireSlots(adjacency.offsets, adjacency.list, vertexCount)
    return {
      result: { positions: piece.positions, indices: piece.indices, wireSlots: slots, mating: piece.mating, gap: piece.gap, report: piece.report },
      transfer: [piece.positions.buffer, piece.indices.buffer, slots.buffer, piece.mating.buffer, piece.gap.buffer],
    }
  },

  'recrease-edited'({ crease }) {
    if (!edited) return { result: null }
    const r = scanRender(edited, crease)
    return { result: r, transfer: [r.positions.buffer, r.indices.buffer, r.normals.buffer, r.wireSlots.buffer, r.copyOf.buffer] }
  },
}

const plugin: WorkerPlugin = {
  id: MESH_TOOLS,
  handle(op, payload, ctx) {
    const run = ops[op as keyof MeshToolsOps] as ((p: unknown, c: WorkerContext) => WorkerReply | Promise<WorkerReply>) | undefined
    if (!run) throw new Error(`Mesh Tools has no operation "${op}".`)
    return run(payload, ctx)
  },
  // A copy of another scan has nothing to do with this one, nor a body
  // prepared in its frame.
  scanReplaced() {
    edited = null
    trimBody = null
  },
  // The copy is in the scan's frame, and stays in it; a body prepared before
  // the move is sent again as it now stands.
  transformed(transform) {
    trimBody = null
    if (!edited) return
    rigidApplyToPoints(transform, edited.positions)
    rigidRotateVectors(transform, edited.normals)
  },
}

export default plugin

// SPDX-License-Identifier: AGPL-3.0-only
import type { MeshGraph, ParsedMesh } from './types'
import type { WorkerRequest, WorkerResponse } from './workerProtocol'
import { parseSTL } from './parsers/stl'
import { parsePLY } from './parsers/ply'
import { parseOBJ } from './parsers/obj'
import { parseSTEP, type StepInfo } from './parsers/step'
import { buildMeshGraph } from './geometry/buildGraph'
import { getFitter, getSelectionFitter } from './elements/registry'
import { NominalSurface } from './deviation/surface'
import { alignFromPairs, alignLocal, autoAlign } from './deviation/align'
import { computeDeviation, defaultMaxDistance, suggestRange } from './deviation/deviation'
import { rigidApplyToPoints, rigidRotateVectors, type Rigid } from './deviation/rigid'
import { buildSolidIndex, computeThickness, suggestThicknessScale } from './thickness/thickness'
import type { MeshBVH } from 'three-mesh-bvh'

let graph: MeshGraph | null = null
/** The reference geometry, prepared for signed closest-point queries. Held
 *  across requests so an alignment and the deviation map that follows it do
 *  not each pay for the tree. */
let nominal: NominalSurface | null = null
/** A tree over the scan itself, for the wall thickness rays. Built on first
 *  use — most sessions never ask for it — and dropped whenever the scan's
 *  vertices change under it. */
let scanSolid: MeshBVH | null = null

function post(msg: WorkerResponse, transfer: Transferable[] = []): void {
  ;(self as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage(msg, transfer)
}

function extensionOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? ''
}

function parseByName(name: string, buffer: ArrayBuffer, onProgress: (t: string) => void): ParsedMesh {
  const ext = extensionOf(name)
  if (ext === 'stl') return parseSTL(buffer, onProgress)
  if (ext === 'ply') return parsePLY(buffer, onProgress)
  if (ext === 'obj') return parseOBJ(buffer, onProgress)
  throw new Error(`Unsupported file type ".${ext}" — use STL, PLY, or OBJ.`)
}

/** The reference takes CAD as well as meshes: it is the nominal part, and the
 *  nominal part is what came out of the CAD system in the first place. A scan
 *  never arrives as a B-rep, so this stays on the reference side. */
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
  if (ext === 'stl' || ext === 'ply' || ext === 'obj') {
    return { parsed: parseByName(name, buffer, onProgress) }
  }
  throw new Error(`Unsupported file type ".${ext}" — use STL, PLY, OBJ, or STEP.`)
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data
  const progress = (text: string) => post({ type: 'progress', text })

  if (msg.type === 'load') {
    try {
      const parsed = parseByName(msg.name, msg.buffer, progress)
      graph = buildMeshGraph(parsed, progress)
      scanSolid = null
      // The render thread gets its own copies of positions, normals and
      // indices. The worker keeps its index buffer — the fitting pipeline has
      // no use for it, but a wall thickness ray does, and re-deriving it from
      // the file would mean parsing and welding the whole scan again.
      const indices = graph.indices.slice()
      const positions = graph.positions.slice()
      const normals = graph.normals.slice()
      post(
        {
          type: 'loaded',
          requestId: msg.requestId,
          positions,
          indices,
          normals,
          vertexCount: graph.vertexCount,
          triangleCount: indices.length / 3,
        },
        [positions.buffer, indices.buffer, normals.buffer],
      )
    } catch (e) {
      graph = null
      scanSolid = null
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
      const result = getFitter(msg.elementType)(graph, msg.seeds, msg.settings)
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
      const result = getSelectionFitter(msg.elementType)(graph, msg.vertices, msg.settings)
      post({ type: 'fit-ok', requestId: msg.requestId, result }, [result.region.buffer])
    } catch (e) {
      post({ type: 'error', requestId: msg.requestId, message: errorText(e) })
    }
    return
  }

  if (msg.type === 'load-nominal') {
    try {
      const { parsed, step } = parseNominal(msg.name, msg.buffer, progress)
      // The nominal goes through the same welding as a scan: the pseudonormals
      // that give a signed distance its sign are sums over the faces meeting at
      // a vertex or an edge, and an unwelded triangle soup has no such thing.
      // A STEP import is welded already, so this only pays for a pass over it.
      const g = buildMeshGraph(parsed, progress)
      progress('Indexing reference geometry…')
      nominal = new NominalSurface(g.positions, g.indices)
      const positions = g.positions.slice()
      const indices = g.indices.slice()
      const normals = g.normals.slice()
      post(
        {
          type: 'nominal-loaded',
          requestId: msg.requestId,
          positions,
          indices,
          normals,
          vertexCount: g.vertexCount,
          triangleCount: g.triangleCount,
          bboxDiagonal: nominal.bboxDiagonal,
          step,
        },
        [positions.buffer, indices.buffer, normals.buffer],
      )
    } catch (e) {
      nominal = null
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
      let result
      if (msg.mode === 'auto') {
        result = autoAlign(nominal, graph.positions, graph.normals, options)
      } else if (msg.mode === 'points') {
        result = alignFromPairs(nominal, graph.positions, graph.normals, msg.pairs, options)
      } else {
        // Same check as a hand-marked fit: an index past the end of the scan
        // would read whatever follows the position buffer and fit to it.
        for (let i = 0; i < msg.vertices.length; i++) {
          if (msg.vertices[i] >= graph.vertexCount) {
            throw new Error('The marked surface does not belong to the loaded scan.')
          }
        }
        result = alignLocal(nominal, graph.positions, graph.normals, msg.vertices, msg.start, {
          ...options,
          maxDistance: msg.maxDistance,
        })
      }
      post({ type: 'align-ok', requestId: msg.requestId, result })
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
    // The vertices moved, so the tree built over them no longer describes
    // them. Thickness itself is unaffected — it is a property of the part, not
    // of where the part sits.
    scanSolid = null
    post({ type: 'transform-ok', requestId: msg.requestId })
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
      const values = computeDeviation(nominal, graph.positions, msg.transform, (f) => {
        const percent = Math.round(f * 100)
        if (percent === lastPercent) return
        lastPercent = percent
        progress(`Measuring deviation — ${percent}%…`)
      })
      const suggestedMaxDistance = defaultMaxDistance(graph.bboxDiag)
      post(
        {
          type: 'deviation-ok',
          requestId: msg.requestId,
          values,
          suggestedRange: suggestRange(values, suggestedMaxDistance),
          suggestedMaxDistance,
        },
        [values.buffer],
      )
    } catch (e) {
      post({ type: 'error', requestId: msg.requestId, message: errorText(e) })
    }
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

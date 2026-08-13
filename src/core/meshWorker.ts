import type { MeshGraph, ParsedMesh } from './types'
import type { WorkerRequest, WorkerResponse } from './workerProtocol'
import { parseSTL } from './parsers/stl'
import { parsePLY } from './parsers/ply'
import { parseOBJ } from './parsers/obj'
import { buildMeshGraph } from './geometry/buildGraph'
import { getElementType } from './elements/registry'

let graph: MeshGraph | null = null

function post(msg: WorkerResponse, transfer: Transferable[] = []): void {
  ;(self as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage(msg, transfer)
}

function parseByName(name: string, buffer: ArrayBuffer, onProgress: (t: string) => void): ParsedMesh {
  const ext = name.split('.').pop()?.toLowerCase()
  if (ext === 'stl') return parseSTL(buffer, onProgress)
  if (ext === 'ply') return parsePLY(buffer, onProgress)
  if (ext === 'obj') return parseOBJ(buffer, onProgress)
  throw new Error(`Unsupported file type ".${ext}" — use STL, PLY, or OBJ.`)
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data
  const progress = (text: string) => post({ type: 'progress', text })

  if (msg.type === 'load') {
    try {
      const parsed = parseByName(msg.name, msg.buffer, progress)
      graph = buildMeshGraph(parsed, progress)
      // The render thread gets its own copies of positions/normals; the
      // index buffer is only needed for rendering and picking, so it is
      // transferred outright and dropped from the worker's graph.
      const indices = graph.indices
      graph.indices = new Uint32Array(0)
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
      const def = getElementType(msg.elementType)
      const out = def.fitFromSeed(graph, msg.seeds, msg.settings)
      post(
        {
          type: 'fit-ok',
          requestId: msg.requestId,
          center: out.center,
          radius: out.radius,
          sigma: out.sigma,
          usedPoints: out.usedPoints,
          regionSize: out.regionSize,
          region: out.region,
        },
        [out.region.buffer],
      )
    } catch (e) {
      post({ type: 'error', requestId: msg.requestId, message: errorText(e) })
    }
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

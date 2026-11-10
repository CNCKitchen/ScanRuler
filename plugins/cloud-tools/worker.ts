// SPDX-License-Identifier: AGPL-3.0-only
// Cloud Tools' part of the mesh worker: the operations core/protocol.ts
// names, on the scan the worker holds — a point cloud. The pieces of the
// cloud are kept for the graph they were found on, so the panel's slider
// only sorts them again.

import type { MeshGraph } from '../../src/core/types'
import type { WorkerContext, WorkerPlugin, WorkerReply } from '../../src/core/workerPluginApi'
import { isCloud } from '../../src/core/geometry/cloud'
import { rigidApplyToPoints, rigidRotateVectors } from '../../src/core/deviation/rigid'
import { cloudPieces, floatingPieces, GAP_SPACINGS, pastPlane, withoutPoints, type CloudPieces } from './core/clean'
import { CLOUD_TOOLS, type CloudToolsOps } from './core/protocol'

/** The pieces of the scan, for the graph they were found on. */
let pieces: { graph: MeshGraph; pieces: CloudPieces } | null = null

type Payload<K extends keyof CloudToolsOps> = CloudToolsOps[K]['payload']

function cloudOf(ctx: WorkerContext): MeshGraph {
  const g = ctx.scan()
  if (!g) throw new Error('No model loaded.')
  if (!isCloud(g)) throw new Error('Needs a point cloud — this scan is a mesh.')
  return g
}

function piecesOf(g: MeshGraph): CloudPieces {
  if (pieces?.graph === g) return pieces.pieces
  const spacing = g.spacing ?? 0
  if (!(spacing > 0)) throw new Error('The cloud\'s point spacing is unknown — open it again.')
  // No progress line: under half a second on 760 k points, and it would
  // stand over a delete's report when the tool marks again after one.
  const found = cloudPieces(g.positions, g.vertexCount, GAP_SPACINGS * spacing)
  pieces = { graph: g, pieces: found }
  return found
}

const ops: { [K in keyof CloudToolsOps]: (payload: Payload<K>, ctx: WorkerContext) => WorkerReply | Promise<WorkerReply> } = {
  floating({ percent }, ctx) {
    const survey = floatingPieces(piecesOf(cloudOf(ctx)), percent)
    return { result: survey, transfer: [survey.vertices.buffer] }
  },

  'past-plane'({ origin, normal }, ctx) {
    const g = cloudOf(ctx)
    const vertices = pastPlane(g.positions, g.vertexCount, origin, normal)
    return { result: { vertices }, transfer: [vertices.buffer] }
  },

  remove({ vertices, toFile }, ctx) {
    const g = cloudOf(ctx)
    if (vertices.length === 0) throw new Error('Nothing is marked to delete.')
    const out = withoutPoints(g.positions, g.normals, g.vertexCount, vertices)
    if (out.positions.length === 0) throw new Error('Every point is marked — nothing would be left.')
    rigidApplyToPoints(toFile, out.positions)
    rigidRotateVectors(toFile, out.normals)
    return { result: out, transfer: [out.positions.buffer, out.normals.buffer, out.map.buffer] }
  },
}

const plugin: WorkerPlugin = {
  id: CLOUD_TOOLS,
  // Every tool here is for point clouds.
  acceptsClouds: true,
  handle(op, payload, ctx) {
    const run = ops[op as keyof CloudToolsOps] as ((p: unknown, c: WorkerContext) => WorkerReply | Promise<WorkerReply>) | undefined
    if (!run) throw new Error(`Cloud Tools has no operation "${op}".`)
    return run(payload, ctx)
  },
  scanReplaced() {
    pieces = null
  },
  // A move keeps every distance, so the pieces stand; the graph is the same.
  transformed() {},
}

export default plugin

// SPDX-License-Identifier: AGPL-3.0-only
// The Merge workspace's part of the mesh worker: the operations
// core/protocol.ts names. Layers — extra passes taken from staged loads — are
// held here by id, each in its own frame, with what aligning onto it or with
// it needs built on first use. Their poses are the main side's: nothing here
// depends on where a layer sits, so a baked move of the base only drops what
// was prepared over the base's vertices.
//
// The layers belong to the scan they were opened beside. Another scan in its
// place drops them, except while the workspace's own swap is under way (its
// merge, or the history putting the scan back): merge-begin / undo-begin set
// that flag, merge-end / undo-end clear it.

import type { FitData, MeshGraph } from '../../src/core/types'
import type { WorkerContext, WorkerPlugin, WorkerReply } from '../../src/core/workerPluginApi'
import type { ClosestSurface } from '../../src/core/deviation/surface'
import type { Rigid } from '../../src/core/deviation/rigid'
import type { Steps } from '../../src/core/deviation/steps'
import { CloudSurface } from '../../src/core/deviation/cloudSurface'
import { isCloud } from '../../src/core/geometry/cloud'
import { getFitter } from '../../src/core/elements/registry'
import { transformFit } from '../../src/core/alignment'
import { alignDatums, alignPairs, layerCloud, refineLayer, type LayerCloud } from './core/layerAlign'
import type { DatumSet } from './core/datums'
import { mergeLayers } from './core/merge'
import { BASE, MERGE, type AlignReply, type DatumIds, type MergeOps } from './core/protocol'

interface Layer {
  graph: MeshGraph
  /** A cloud's point spacing, a mesh's median edge, mm. */
  spacing: number
  /** Samples for aligning it, drawn on its first alignment. */
  cloud: LayerCloud | null
  /** The layer as a target for another layer — a cloud's own; a mesh's is
   *  the worker's surfaceOf, which keeps it. */
  surface: CloudSurface | null
  /** Transient fits on it, by fitId. */
  fits: Map<number, FitData>
}

const layers = new Map<string, Layer>()
/** The base's transient fits, by fitId, in the base's frame. */
const baseFits = new Map<number, FitData>()
/** The base cloud prepared as a target, for the graph it was built over. */
let baseSurface: { graph: MeshGraph; surface: CloudSurface } | null = null
/** A mesh's median edge length, the spacing an alignment onto it is judged in. */
const meshSpacing = new WeakMap<MeshGraph, number>()
/** Set while the scan is swapped by the workspace itself: its layers stay. */
let ownSwap = false
/** fitIds run on across layers and the base, so one never names two fits. */
let nextFitId = 1

type Payload<K extends keyof MergeOps> = MergeOps[K]['payload']

/** The graph's own vertices: a buffer may be longer than its count. */
const positionsOf = (g: MeshGraph) => g.positions.subarray(0, g.vertexCount * 3)
const normalsOf = (g: MeshGraph) => g.normals.subarray(0, g.vertexCount * 3)

function layerOf(id: string): Layer {
  const l = layers.get(id)
  if (!l) throw new Error(`There is no layer "${id}".`)
  return l
}

function scanOf(ctx: WorkerContext): MeshGraph {
  const g = ctx.scan()
  if (!g) throw new Error('No model loaded.')
  return g
}

/** The median edge length of a mesh, over at most ~100 k triangles. */
function medianEdge(g: MeshGraph): number {
  const known = meshSpacing.get(g)
  if (known !== undefined) return known
  const p = g.positions, ix = g.indices
  const stride = Math.max(1, Math.floor(g.triangleCount / 100_000))
  const edges: number[] = []
  const len = (a: number, b: number) => Math.hypot(p[3 * a] - p[3 * b], p[3 * a + 1] - p[3 * b + 1], p[3 * a + 2] - p[3 * b + 2])
  for (let t = 0; t < g.triangleCount; t += stride) {
    const a = ix[3 * t], b = ix[3 * t + 1], c = ix[3 * t + 2]
    edges.push(len(a, b), len(b, c), len(c, a))
  }
  const sorted = Float64Array.from(edges).sort()
  const m = sorted.length > 0 ? sorted[sorted.length >> 1] : 0
  meshSpacing.set(g, m)
  return m
}

function spacingOf(g: MeshGraph): number {
  return isCloud(g) ? g.spacing ?? 0 : medianEdge(g)
}

/** What a layer is aligned onto: the base, or another layer in its own frame. */
function targetOf(name: string, self: string, ctx: WorkerContext): { surface: ClosestSurface; spacing: number; fits: Map<number, FitData>; label: string } {
  if (name === BASE) {
    const g = scanOf(ctx)
    if (!isCloud(g)) return { surface: ctx.surfaceOf(g, 'Preparing the scan to align the layer onto…'), spacing: medianEdge(g), fits: baseFits, label: 'the base' }
    if (baseSurface?.graph !== g) {
      ctx.progress('Preparing the scan to align the layer onto…')
      baseSurface = { graph: g, surface: new CloudSurface(positionsOf(g), normalsOf(g), g.spacing ?? 0) }
    }
    return { surface: baseSurface.surface, spacing: baseSurface.surface.spacing, fits: baseFits, label: 'the base' }
  }
  if (name === self) throw new Error('A layer cannot be aligned onto itself.')
  const l = layerOf(name)
  const label = `layer "${name}"`
  if (!isCloud(l.graph)) return { surface: ctx.surfaceOf(l.graph, 'Preparing the layer to align onto…'), spacing: l.spacing, fits: l.fits, label }
  if (!l.surface) {
    ctx.progress('Preparing the layer to align onto…')
    l.surface = new CloudSurface(positionsOf(l.graph), normalsOf(l.graph), l.spacing)
  }
  return { surface: l.surface, spacing: l.spacing, fits: l.fits, label }
}

function cloudOf(l: Layer): LayerCloud {
  // Scaled when added, so its millimetres already.
  l.cloud ??= layerCloud(positionsOf(l.graph), normalsOf(l.graph))
  return l.cloud
}

/** An alignment run a slice at a time, so Stop is heard. */
async function aligning(steps: Steps<AlignReply>, ctx: WorkerContext): Promise<WorkerReply> {
  ctx.progress('Aligning the layer…')
  const r = await ctx.drive(steps)
  return { result: r ?? { stopped: true } }
}

/** Datums by fitId, from the fits of the side they belong to. The axes are
 *  datumPose's to assign; any given here are a placeholder. */
function datumsOf(ids: DatumIds, fits: Map<number, FitData>, label: string): DatumSet {
  const get = (n: number) => {
    const f = fits.get(n)
    if (!f) throw new Error(`There is no fit ${n} on ${label}.`)
    return f
  }
  return {
    primary: { fit: get(ids.primary), axis: 'z+' },
    secondary: ids.secondary === null ? null : { fit: get(ids.secondary), axis: 'x+' },
    origin: ids.origin === null ? null : get(ids.origin),
  }
}

const ops: { [K in keyof MergeOps]: (payload: Payload<K>, ctx: WorkerContext) => WorkerReply | Promise<WorkerReply> } = {
  'add-layer'({ stagedId, id, scale }, ctx) {
    if (id === BASE) throw new Error(`A layer cannot be called "${BASE}" — that names the scan.`)
    if (layers.has(id)) throw new Error(`There is already a layer "${id}".`)
    if (!(scale > 0) || !Number.isFinite(scale)) throw new Error('The layer\'s scale must be a number above zero.')
    const g = ctx.takeStaged(stagedId)
    if (!g) throw new Error('The prepared import is no longer available.')
    if (scale !== 1) {
      // A uniform scale keeps the adjacency and the normals; the lengths go with it.
      const p = positionsOf(g)
      for (let i = 0; i < p.length; i++) p[i] *= scale
      g.bboxDiag *= scale
      if (g.spacing !== undefined) g.spacing *= scale
    }
    const spacing = spacingOf(g)
    layers.set(id, { graph: g, spacing, cloud: null, surface: null, fits: new Map() })
    return { result: { vertexCount: g.vertexCount, spacing, isCloud: isCloud(g) } }
  },

  'remove-layer'({ id }) {
    layerOf(id)
    layers.delete(id)
    return { result: null }
  },

  'layer-geometry'({ id }) {
    const g = layerOf(id).graph
    const positions = positionsOf(g).slice()
    const normals = normalsOf(g).slice()
    if (isCloud(g)) return { result: { positions, normals }, transfer: [positions.buffer, normals.buffer] }
    const indices = g.indices.slice()
    return { result: { positions, normals, indices }, transfer: [positions.buffer, normals.buffer, indices.buffer] }
  },

  'align-pairs'({ id, target, pairs }, ctx) {
    const l = layerOf(id)
    const t = targetOf(target, id, ctx)
    return aligning(alignPairs(t.surface, cloudOf(l), pairs, { targetSpacing: t.spacing }), ctx)
  },

  'align-datums'({ id, target, layer, targetDatums }, ctx) {
    const l = layerOf(id)
    const t = targetOf(target, id, ctx)
    const own = datumsOf(layer, l.fits, `layer "${id}"`)
    const theirs = datumsOf(targetDatums, t.fits, t.label)
    return aligning(alignDatums(t.surface, cloudOf(l), own, theirs, { targetSpacing: t.spacing }), ctx)
  },

  refine({ id, target, start }, ctx) {
    const l = layerOf(id)
    const t = targetOf(target, id, ctx)
    return aligning(refineLayer(t.surface, cloudOf(l), start, { targetSpacing: t.spacing, fromUserGuess: true }), ctx)
  },

  fit({ id, elementType, seeds, settings }, ctx) {
    const side = id === BASE ? null : layerOf(id)
    const graph = side ? side.graph : scanOf(ctx)
    for (const s of seeds) {
      if (!(s >= 0 && s < graph.vertexCount)) throw new Error(`The seed ${s} is not a point of ${side ? `layer "${id}"` : 'the base'}.`)
    }
    const fit = getFitter(elementType)(graph, seeds, settings)
    const { region, told, ...data } = fit
    void told
    const fitId = nextFitId++
    ;(side ? side.fits : baseFits).set(fitId, data as FitData)
    return { result: { fitId, fit }, transfer: [region.buffer] }
  },

  'merge-begin'() {
    ownSwap = true
    return { result: null }
  },
  'merge-end'() {
    ownSwap = false
    return { result: null }
  },
  'undo-begin'() {
    ownSwap = true
    return { result: null }
  },
  'undo-end'() {
    ownSwap = false
    return { result: null }
  },

  merge({ poses, visible, toFile, scale, dedupe }, ctx) {
    const g = scanOf(ctx)
    const parts = visible.map((id) => {
      const l = layerOf(id)
      const pose = poses[id]
      if (!pose) throw new Error(`No pose for layer "${id}".`)
      return { positions: positionsOf(l.graph), normals: normalsOf(l.graph), pose }
    })
    ctx.progress('Merging the layers…')
    const out = mergeLayers({ base: { positions: positionsOf(g), normals: normalsOf(g) }, layers: parts, toFile, scale, dedupe })
    return { result: out, transfer: [out.positions.buffer, out.normals.buffer, out.baseMap.buffer] }
  },
}

const plugin: WorkerPlugin = {
  id: MERGE,
  // Merge is where clouds are made and laid together.
  acceptsClouds: true,
  handle(op, payload, ctx) {
    const run = ops[op as keyof MergeOps] as ((p: unknown, c: WorkerContext) => WorkerReply | Promise<WorkerReply>) | undefined
    if (!run) throw new Error(`Merge has no operation "${op}".`)
    return run(payload, ctx)
  },
  scanReplaced() {
    baseSurface = null
    baseFits.clear()
    if (!ownSwap) layers.clear()
  },
  // The layers are in their own frames and their poses are the main side's;
  // only what stands in the base's frame moves.
  transformed(transform: Rigid) {
    baseSurface = null
    for (const [n, f] of baseFits) baseFits.set(n, transformFit(f, transform))
  },
}

export default plugin

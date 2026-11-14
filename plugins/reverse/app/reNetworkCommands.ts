// SPDX-License-Identifier: AGPL-3.0-only
// reverse.network.*: a Patch network made, edited and read by an agent, and
// the scan's creases suggested for it (PN13). A network is drawn on the
// scan as the viewport holds it: each curve's points are taken onto it, an
// end or a grip that lands on a node, a grip or another curve's run joins
// the network there — the other curve split there with a node, as a click
// on it splits it (state/reNetworkDraft.ts splitCurve) — and the regions
// the curves close are read off the scan as the build reads them
// (core/network.ts), so Fill all fills what the panel's Fill all would.
// The edits go through the draft's own operations and are committed
// through the feature box, one undo step each; what the build made of the
// network is its report (core/networkBody.ts), read back as the box's
// status line and rows show it.

import { invalid } from '../../../src/commands/core/common'
import { arr, bool, enumOf, int, type JsonSchema, num, obj, oneOf, str, validate, vec3 } from '../../../src/commands/schema'
import { ScanPaths } from '../../../src/core/geometry/scanPath'
import type { Vec3 } from '../../../src/core/types'
import { type Command, CommandError } from '../../../src/plugins/api'
import { useStore } from '../../../src/state/store'
import type { NetworkCurve, NetworkFeature } from '../core/features'
import { traceNetwork } from '../core/network'
import type { NetworkReport } from '../core/networkBody'
import { readCells } from '../core/networkCells'
import { suggestCreases } from '../core/networkCreases'
import { type CurveTrace, SPANS_MAX, SPANS_MIN, traceCurve } from '../core/networkCurve'
import { addCurve, addSeeds, cloneData, emptyNetworkDraft, insertGrip, moveGrip, moveNode, networkDraftOf, networkReady, removeCurve, removeGrip, removeNode, removeSeed, setNetworkFit, setStripSpans, splitCurve, toggleCrease } from '../state/reNetworkDraft'
import type { NetworkDraft } from '../state/reTypes'
import { networkStatus } from '../ui/NetworkEditor'
import { barOut, bodiesChanged, bodyRows, failures } from './reCommandAnswers'
import { bodyNamed, change, edgePicked, type EdgePickIn, facePicked, type FacePickIn, facePickIn, featureNamed, type Json, re, ready, type Ref, session } from './reCommandCore'
import { requireFreeName } from './reFeatureCommands'
import { featureBrief, resultOut } from './reReadout'
import { bodyRef, featureRef } from './reSchemas'
import type { ReverseSession } from './reSession'

/** How near a curve's point has to come to a node, a grip or another
 *  curve's run to join it there, mm, unless told. */
const SNAP_MM = 0.5
/** A point given further off the scan than this is said back, mm. */
const OFF_SCAN_MM = 1
/** How many of a patch's worst points an answer names. */
const WORST_SHOWN = 3
/** How many open ends an answer lists. */
const OPEN_SHOWN = 12

// ---- the input --------------------------------------------------------------------

/** A curve as the commands take it. */
interface CurveIn {
  points: Vec3[]
  crease?: boolean
  spans?: number
  along?: { body: Ref; edge: EdgePickIn }
  side?: { body: Ref; face: FacePickIn; mode: 'contact' | 'tangent' }
}

type FillIn = 'all' | Vec3[]

const pointIn = vec3('mm, taken to the nearest point of the scan.')

/** An edge pick listed shallow, as facePickIn lists a face: checked when
 *  the command runs. */
const edgePickIn = (): JsonSchema => oneOf([int('The edge’s index in reverse.body.describe.', { minimum: 0 }), { type: 'object', description: 'Its fingerprint, or a query (where) that one edge answers.' }], 'An edge of the body.')

// A curve's body picks are listed loosely, their whole shape held to when
// the command runs: spelled out, with the curves and the edit's parts
// round them, they took a command past what an agent's client lists
// (SCHEMA_BUDGET, src/commands/schema.ts).
const alongWhole = obj({ body: bodyRef, edge: edgePickIn() }, ['body', 'edge'], 'The curve runs along this edge of a body: its points are the edge’s.')
const sideWhole = obj(
  { body: bodyRef, face: facePickIn(), mode: enumOf(['contact', 'tangent'], 'contact: the patch’s side lies on the face’s edge; tangent: it meets the face tangent too.') },
  ['body', 'face', 'mode'],
  'The patch beside the curve meets this face of a body.',
)
const alongListed: JsonSchema = { type: 'object', description: '{ body, edge }: a body’s edge the curve runs along; its points are the edge’s.' }
const sideListed: JsonSchema = { type: 'object', description: '{ body, face, mode: "contact" | "tangent" }: a body’s face the patch beside the curve meets.' }

const spansIn = int(`Spans of the strip along the curve, ${SPANS_MIN}–${SPANS_MAX}; Auto when left out.`, { minimum: SPANS_MIN, maximum: SPANS_MAX })

/** A curve as the commands take it: listed, or whole. */
const curveIn = (whole: boolean) =>
  obj(
    {
      points: arr(pointIn, 'The first end, the grips, the last end, each taken onto the scan; a point within snap of an earlier curve joins it there.', { minItems: 2 }),
      crease: bool('A fold: the patches either side meet at an angle (tangent when left out).'),
      spans: spansIn,
      along: whole ? alongWhole : alongListed,
      side: whole ? sideWhole : sideListed,
    },
    ['points'],
  )

const curvesIn = (what: string, whole: boolean) => arr(curveIn(whole), what, { minItems: 1 })

/** An input held to its whole shape — the one listed is looser. */
function holdTo(whole: JsonSchema, input: unknown): void {
  const errors = validate(whole, input, 'input')
  if (errors.length > 0) invalid(errors.join('; '))
}

const fillIn = oneOf(
  [enumOf(['all'], 'Every closed region of three to six sides not filled yet — the panel’s Fill all.'), arr(pointIn, 'A point inside each region to fill.', { minItems: 1 })],
  'The regions filled with patches.',
)

const fitIn = obj(
  {
    smoothness: num('Fairing weight: 0 exact, 0.001 (the default) fairs noise, 0.1 smooths well over it.', { minimum: 0 }),
    robust: bool('Fit again without the points past three sigmas of the first fit.'),
    tolerance: num('mm, 0.01 by default: how far Auto lets a patch miss the scan before adding spans.', { minimum: 0 }),
  },
  [],
  'How the patches are fitted to the scan.',
)

const snapIn = num(`mm within which a point joins a node, a grip or a curve; ${SNAP_MM} by default.`, { exclusiveMinimum: 0 })

const detailIn = enumOf(['none', 'brief'], 'none: id, status, line, the curves’ ids, the bar, failed; brief (the default): the row, result, joined, offScan, openEnds, patches, refused, unfilled, bodies.')

// ---- the scan ----------------------------------------------------------------------

/** The scan prepared for paths along it, as the viewport holds it — the
 *  frame the bodies are built in — kept while the scan is the same. */
let paths: { key: unknown[]; paths: ScanPaths } | null = null

function scanPaths(s: ReverseSession): ScanPaths {
  const st = useStore.getState()
  if (!st.fileName) throw new CommandError('no_scan', 'A patch network is drawn on the scan, and none is open.')
  const scene = s.sceneRef.current
  const positions = scene?.scanPositions() ?? null
  if (!scene || !positions) throw new CommandError('unavailable', 'A patch network is drawn on the scan as the viewport holds it — this needs the ScanRuler page with the scan shown.')
  const key = [st.fileName, st.triangleCount, st.appliedAlignment, positions.buffer, positions.byteOffset, positions.length]
  if (paths && paths.key.length === key.length && paths.key.every((k, i) => k === key[i])) return paths.paths
  const indices = scene.scanIndices()
  if (!indices) throw new CommandError('unavailable', 'The viewport holds no triangles of the scan to draw a patch network on.')
  paths = { key, paths: new ScanPaths(Float32Array.from(positions), indices) }
  return paths.paths
}

// ---- placing curves ----------------------------------------------------------------

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

/** What a point of a curve lands on. */
type Hit = { kind: 'node'; node: number } | { kind: 'grip'; curve: number; index: number } | { kind: 'curve'; curve: number; run: number; at: Vec3 }

/** What a point joined, for the answer: the curve given, by its index
 *  among those given, and the point, by its index along it. */
interface Joined {
  given: number
  point: number
  node: number
  on: 'node' | 'grip' | 'curve'
  of?: number
}

/** A network's draft being added to: its curves' traces kept while their
 *  points stay, and which curve given each curve came of. */
class Placing {
  d: NetworkDraft
  private traces = new Map<number, { key: string; trace: CurveTrace }>()
  /** The ids each curve given became, in order along it. */
  readonly made: number[][] = []
  readonly joined: Joined[] = []
  readonly offScan: { given: number; point: number; mm: number }[] = []

  constructor(
    readonly paths: ScanPaths,
    d: NetworkDraft,
    readonly snap: number,
  ) {
    this.d = d
  }

  /** A point taken onto the scan. */
  onScan(p: Vec3, given?: number, point?: number): Vec3 {
    const c = this.paths.closest(p)
    if (!c) throw new CommandError('no_scan', 'The scan has no triangles to draw on.')
    if (given !== undefined && point !== undefined && c.distance > OFF_SCAN_MM) this.offScan.push({ given, point, mm: round3(c.distance) })
    return [c.point[0], c.point[1], c.point[2]]
  }

  private nodeAt(id: number): Vec3 | null {
    return this.d.nodes.find((n) => n.id === id)?.at ?? null
  }

  traceOf(c: NetworkCurve): CurveTrace | null {
    const a = this.nodeAt(c.from)
    const b = this.nodeAt(c.to)
    if (!a || !b) return null
    const key = JSON.stringify([a, c.via, b])
    const had = this.traces.get(c.id)
    if (had?.key === key) return had.trace
    const trace = traceCurve(this.paths, [a, ...c.via, b])
    this.traces.set(c.id, { key, trace })
    return trace
  }

  /** What a point lands on: a node, else a grip, else a curve's run — of
   *  the curves not in `own` — within snap; a run within two snaps of a
   *  curve's end, along it, is that end's node. */
  hitAt(at: Vec3, own: ReadonlySet<number>): Hit | null {
    let best: Hit | null = null
    let bestD = this.snap
    for (const n of this.d.nodes) {
      const dd = dist(n.at, at)
      if (dd <= bestD) [bestD, best] = [dd, { kind: 'node', node: n.id }]
    }
    if (best) return best
    for (const c of this.d.curves) {
      if (own.has(c.id)) continue
      c.via.forEach((g, index) => {
        const dd = dist(g, at)
        if (dd <= bestD) [bestD, best] = [dd, { kind: 'grip', curve: c.id, index }]
      })
    }
    if (best) return best
    for (const c of this.d.curves) {
      if (own.has(c.id)) continue
      const t = this.traceOf(c)
      if (!t || t.points.length < 6) continue
      const near = nearestOnTrace(t, at)
      if (!near || near.d > bestD) continue
      bestD = near.d
      if (near.s < 2 * this.snap) best = { kind: 'node', node: c.from }
      else if (t.length - near.s < 2 * this.snap) best = { kind: 'node', node: c.to }
      else best = { kind: 'curve', curve: c.id, run: near.run, at: near.at }
    }
    return best
  }

  /** A new node where nothing is. */
  private newNode(at: Vec3): number {
    const id = this.d.nextId
    this.d = { ...this.d, nodes: [...this.d.nodes, { id, at: [...at] as Vec3 }], nextId: id + 1 }
    return id
  }

  /** The node a hit is: the node itself, or one made by splitting the curve
   *  there — at a grip, the grip becomes the node. The curve given that the
   *  split curve came of takes its second half too, after the first. */
  private nodeFor(hit: Hit, given: number, point: number): number {
    if (hit.kind === 'node') {
      this.joined.push({ given, point, node: hit.node, on: 'node' })
      return hit.node
    }
    const c = this.d.curves.find((x) => x.id === hit.curve)!
    const at = hit.kind === 'grip' ? c.via[hit.index] : hit.at
    const run = hit.kind === 'grip' ? hit.index : hit.run
    const split = splitCurve(this.d, hit.curve, run, at)!
    const second = split.node + 1
    this.d = hit.kind === 'grip' ? removeGrip(split.draft, second, 0) : split.draft
    for (const ids of this.made) {
      const k = ids.indexOf(hit.curve)
      if (k >= 0) ids.splice(k + 1, 0, second)
    }
    this.joined.push({ given, point, node: split.node, on: hit.kind, of: hit.curve })
    return split.node
  }

  /** A curve given, placed: its points onto the scan, each end — and each
   *  grip that lands on the network — a node, the curve cut at every grip
   *  that is one, and its own fields on every piece of it. */
  place(input: CurveIn, i: number, picks: { along?: NetworkCurve['along']; side?: NetworkCurve['side'] }): number[] {
    const pts = input.points.map((p, k) => this.onScan(p, i, k))
    const own = new Set<number>()
    const ids: number[] = []
    this.made.push(ids)
    const first = this.hitAt(pts[0], own)
    let start = first ? this.nodeFor(first, i, 0) : this.newNode(pts[0])
    let grips: Vec3[] = []
    let from = 0
    for (let k = 1; k < pts.length; k++) {
      const last = k === pts.length - 1
      const hit = this.hitAt(pts[k], own)
      if (!hit && !last) {
        grips.push(pts[k])
        continue
      }
      const end = hit ? this.nodeFor(hit, i, k) : this.newNode(pts[k])
      const had = this.d.curves.length
      const d = addCurve(this.d, { node: start }, grips, { node: end })
      if (d.curves.length === had)
        invalid(`curves[${i}]: points ${from} and ${k} land on one node (${end}) with ${grips.length === 0 ? 'nothing' : 'one point'} between — a curve back to where it starts needs two points between; leave the point out, or move it off the node.`)
      this.d = d
      const id = d.curves[d.curves.length - 1].id
      own.add(id)
      ids.push(id)
      start = end
      grips = []
      from = k
    }
    // Its own fields on each piece; a piece split later keeps them.
    for (const id of ids) {
      if (input.crease) this.d = toggleCrease(this.d, id)
      if (picks.along || picks.side) this.d = { ...this.d, curves: this.d.curves.map((c) => (c.id === id ? { ...c, ...picks } : c)) }
      if (input.spans !== undefined) this.d = { ...this.d, spans: { ...this.d.spans, [String(id)]: input.spans } }
    }
    return ids
  }
}

/** The point of a trace nearest `p`: how far, where, its arc length along
 *  the trace, and the run between grips it lies on. */
function nearestOnTrace(t: CurveTrace, p: Vec3): { d: number; at: Vec3; s: number; run: number } | null {
  const q = t.points
  const n = q.length / 3
  if (n < 2) return null
  let best: { d: number; at: Vec3; s: number; seg: number } | null = null
  for (let i = 0; i + 1 < n; i++) {
    const ax = q[i * 3], ay = q[i * 3 + 1], az = q[i * 3 + 2]
    const dx = q[i * 3 + 3] - ax, dy = q[i * 3 + 4] - ay, dz = q[i * 3 + 5] - az
    const l2 = dx * dx + dy * dy + dz * dz
    const u = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy + (p[2] - az) * dz) / l2)) : 0
    const at: Vec3 = [ax + u * dx, ay + u * dy, az + u * dz]
    const d = dist(at, p)
    if (!best || d < best.d) best = { d, at, s: t.at[i] + u * Math.sqrt(l2), seg: i }
  }
  let run = 0
  while (run + 1 < t.grips.length && t.grips[run + 1] <= best!.seg) run++
  return { d: best!.d, at: best!.at, s: best!.s, run: Math.min(run, Math.max(0, t.grips.length - 2)) }
}

/** A curve's body picks resolved: the body by name or id, its edge or face
 *  by index, fingerprint or query, stored as the feature holds them. */
function picksOf(s: ReverseSession, input: Pick<CurveIn, 'along' | 'side'>, at: string): { along?: NetworkCurve['along']; side?: NetworkCurve['side'] } {
  const out: { along?: NetworkCurve['along']; side?: NetworkCurve['side'] } = {}
  try {
    if (input.along) {
      const body = bodyNamed(input.along.body)
      out.along = { body: body.id, edge: edgePicked(s, body, input.along.edge).fingerprint }
    }
    if (input.side) {
      const body = bodyNamed(input.side.body)
      out.side = { body: body.id, face: facePicked(s, body, input.side.face).fingerprint, mode: input.side.mode }
    }
  } catch (e) {
    if (e instanceof CommandError) throw new CommandError(e.code, `${at}: ${e.message}`)
    throw e
  }
  return out
}

// ---- filling -----------------------------------------------------------------------

/** The regions the draft's curves close, read off the scan as the build
 *  reads them, with its seeds. */
function cellsOf(p: ScanPaths, d: NetworkDraft) {
  const traced = traceNetwork(p, d.nodes, d.curves)
  return { traced, cells: readCells(p, traced.nodes, traced.curves, d.cells.map((c) => c.seed)) }
}

/** The nodes a single curve end comes to: nothing closes there. */
function openEnds(d: Pick<NetworkDraft, 'nodes' | 'curves'>): { node: number; at: Vec3 }[] {
  const ends = new Map<number, number>()
  for (const c of d.curves) for (const n of [c.from, c.to]) ends.set(n, (ends.get(n) ?? 0) + 1)
  return d.nodes.filter((n) => ends.get(n.id) === 1).map((n) => ({ node: n.id, at: at4(n.at) }))
}

/** The draft with regions filled: every closed one not filled yet, or the
 *  regions the points given lie in. */
function filled(pl: Placing, fill: FillIn): NetworkDraft {
  if (fill === 'all') {
    const { cells } = cellsOf(pl.paths, pl.d)
    return addSeeds(pl.d, cells.unfilled.map((u) => u.seed))
  }
  return addSeeds(pl.d, fill.map((p) => pl.onScan(p)))
}

/** Why a draft has nothing to build: no region filled — and what the
 *  curves close, or why they close nothing. */
function nothingFilled(pl: Placing): never {
  const { traced, cells } = cellsOf(pl.paths, pl.d)
  const why: string[] = []
  const open = openEnds(pl.d)
  if (open.length > 0) why.push(`${open.length} curve end${open.length === 1 ? '' : 's'} meet${open.length === 1 ? 's' : ''} no other — at ${open.slice(0, 6).map((o) => `node ${o.node} (${o.at.join(', ')})`).join(', ')}${open.length > 6 ? ', …' : ''}: end each curve on a node or on another curve, within snap`)
  if (traced.lost.length > 0) why.push(`curve${traced.lost.length === 1 ? '' : 's'} ${traced.lost.join(', ')} found no path along the scan`)
  const refused = cells.cells.filter((c) => c.status === 'refused')
  if (refused.length > 0) why.push(`the regions asked for: ${refused.slice(0, 4).map((c) => `at (${at4(c.seed).join(', ')}) ${'message' in c ? c.message : ''}`).join('; ')}`)
  return invalid(`The curves close no region of three to six sides to fill, so there is no network to make${why.length > 0 ? ` — ${why.join('; ')}` : ' — round each region with curves that end on one another'}. Nothing was changed.`)
}

// ---- answers -----------------------------------------------------------------------

const r4 = (v: number) => Math.round(v * 1e4) / 1e4
const round3 = (v: number) => Math.round(v * 1e3) / 1e3
const at4 = (p: ArrayLike<number>): Vec3 => [r4(p[0]), r4(p[1]), r4(p[2])]
/** Three significant figures, for gaps of microns. */
const sig3 = (v: number) => (v === 0 ? 0 : Number(v.toPrecision(3)))

const networkOf = (ref: Ref): NetworkFeature => {
  const f = featureNamed(ref)
  if (f.kind !== 'network') invalid(`${f.name} is a ${f.kind}, not a patch network.`)
  return f as NetworkFeature
}

/** The build's report of a network, if it was built. */
const reportOf = (id: number): NetworkReport | undefined => re().results[id]?.network

/** The box's status line, from the report — or, with none, why: a build
 *  that failed before the network read itself, a feature left out, one not
 *  built yet. */
function lineOf(f: NetworkFeature, report: NetworkReport | undefined): string {
  if (report) return networkStatus(report, { curves: f.curves } as unknown as Parameters<typeof networkStatus>[1])
  const r = re().results[f.id]
  const curves = `${f.curves.length} curve${f.curves.length === 1 ? '' : 's'}`
  if (re().rolledBack.includes(f)) return `${curves} · below the rollback bar`
  if (f.suppressed) return `${curves} · suppressed`
  if (r?.status === 'failed') return `${curves} · failed: ${r.message ?? 'the build failed'}`
  return `${curves} · not built yet`
}

/** Each cell's patches, as the report has them — one, or one a quad of a
 *  cell split from its centre. */
const patchesOf = (c: NetworkReport['cells'][number]): number[] => ('refused' in c ? [] : 'patches' in c && Array.isArray(c.patches) ? c.patches : [c.patch])

const patchRow = (p: NetworkReport['patches'][number], i: number, full: boolean) => ({
  patch: i,
  rms: r4(p.rms),
  max: r4(p.max),
  misfit: r4(p.misfit),
  net: [p.net.u, p.net.v],
  ...(full ? { seed: at4(p.seed), points: p.points, worst: p.worst.slice(0, WORST_SHOWN).map((w) => ({ at: at4(w.at), off: r4(w.off) })), ...(p.dropped !== undefined ? { dropped: p.dropped } : {}), sides: p.sides, corners: p.corners } : {}),
})

const refusedOut = (report: NetworkReport) =>
  report.cells.flatMap((c, i) => ('refused' in c ? [{ cell: i, seed: at4(c.seed), refused: c.refused, ...(c.at ? { at: at4(c.at) } : {}) }] : []))

/** What a change to a network answers. */
function changedAnswer(s: ReverseSession, id: number, kept: Json, detail: 'none' | 'brief', before: Map<number, string>): Json {
  const f = re().features.find((x) => x.id === id) as NetworkFeature | undefined
  const report = reportOf(id)
  const failed = failures()
  const status = f ? featureBrief(f, false).status : 'removed'
  const line = f ? lineOf(f, report) : ''
  if (detail === 'none') return { id, status, line, ...('curves' in kept ? { curves: kept.curves } : {}), ...('added' in kept ? { added: kept.added } : {}), rollback: barOut(), ...(failed.length > 0 ? { failed } : {}) }
  const open = f ? openEnds(f) : []
  return {
    feature: f ? featureBrief(f, false) : null,
    result: resultOut(re().results[id]),
    line,
    ...kept,
    ...(open.length > 0 ? { openEnds: open.slice(0, OPEN_SHOWN), ...(open.length > OPEN_SHOWN ? { openEndsFound: open.length } : {}) } : {}),
    ...(report
      ? {
          patches: report.patches.map((p, i) => patchRow(p, i, false)),
          ...(refusedOut(report).length > 0 ? { refused: refusedOut(report) } : {}),
          ...(report.unfilled.length > 0 ? { unfilled: report.unfilled.map((u) => ({ seed: at4(u.seed), sides: u.sides })) } : {}),
        }
      : {}),
    bodies: bodiesChanged(s, before),
    ...(failed.length > 0 ? { failed } : {}),
  }
}

/** The network made or edited: its draft put into the feature box — a new
 *  one, or the feature's opened — and committed, one undo step, with the
 *  scan handed to the kernel first, which builds the network on it. */
async function commit(s: ReverseSession, d: NetworkDraft, opts: { edit?: number; name?: string }): Promise<number> {
  await s.syncScan()
  return change(() => {
    if (opts.edit !== undefined) re().editFeature(opts.edit)
    else re().startFeature('network')
    if (re().featureDraft?.kind !== 'network') throw new CommandError('failed', 'The patch network’s box could not be opened.')
    if (opts.name !== undefined) re().setFeatureDraft({ name: opts.name })
    re().editNetwork((x) => ({ ...x, ...cloneData(d), nextId: d.nextId, placing: null }))
    const id = re().commitFeature()
    if (id === null) throw new CommandError('failed', 'The patch network could not be made — no region of it is filled.')
    return id
  })
}

// ---- the commands ------------------------------------------------------------------

/** reverse.network.create's input: as listed, or whole (holdTo). */
const createIn = (whole: boolean) =>
  obj(
    {
      name: str('The feature’s name; “Patch network n” when left out. Unique across sketches and features.', { minLength: 1 }),
      curves: curvesIn('The curves, in order: each joins the curves before it where its points land on them.', whole),
      fill: fillIn,
      snap: snapIn,
      fit: fitIn,
      detail: detailIn,
    },
    ['curves'],
  )
const CREATE_WHOLE = createIn(true)

export const networkCreate: Command<{ name?: string; curves: CurveIn[]; fill?: FillIn; snap?: number; fit?: { smoothness?: number; robust?: boolean; tolerance?: number }; detail?: 'none' | 'brief' }> = {
  name: 'create',
  // A patch network's cells are the scan's triangles; a cloud has none.
  needsTriangles: true,
  title: 'Make a patch network',
  description:
    `Make a Patch network as the panel’s box makes one: curves drawn on the scan, the regions they close filled with B-spline patches fitted to the scan together — neighbours share the curve between them exactly and meet tangent across it, unless it is a crease. One body: a sheet, or a solid where the network closes — a fitted surface model, not a parametric one, for fold-back, several patches meeting tangent, and creases. Each curve is its points in order (first end, grips, last end), each taken onto the scan (offScan for one more than ${OFF_SCAN_MM} mm off it), the curve following the scan between them; curves meet only at their points — a point within snap of a node, a grip or the run of a curve given before is a node of both (joined). A region closes with three to six sides; fill: "all" (the default) fills every closed region, or give a point inside each. One undo step. Returns the feature’s row and result, line (the box’s status line), curves (the ids each curve given became), joined, offScan, openEnds, patches (rms, max, net), the cells refused and why, unfilled and the bodies changed; reverse.network.read reads it whole, reverse.network.edit changes it.`,
  input: createIn(false),
  label: ({ name }) => `add patch network${typeof name === 'string' ? ` “${name}”` : ''}`,
  run: async (input) => {
    holdTo(CREATE_WHOLE, input)
    const { name, curves, fill = 'all', snap = SNAP_MM, fit, detail = 'brief' } = input
    requireFreeName(name)
    const s = await ready()
    const pl = new Placing(scanPaths(s), emptyNetworkDraft(), snap)
    if (fit) pl.d = setNetworkFit(pl.d, fit)
    curves.forEach((c, i) => pl.place(c, i, picksOf(s, c, `curves[${i}]`)))
    pl.d = filled(pl, fill)
    if (!networkReady(pl.d)) nothingFilled(pl)
    const before = bodyRows(s)
    const id = await commit(s, pl.d, { ...(name !== undefined ? { name } : {}) })
    return changedAnswer(s, id, placedOut(pl, 'curves'), detail, before)
  },
}

/** What placing curves said: the ids each became, and what joined. */
const placedOut = (pl: Placing, key: 'curves' | 'added'): Json => ({
  [key]: pl.made,
  ...(pl.joined.length > 0 ? { joined: pl.joined } : {}),
  ...(pl.offScan.length > 0 ? { offScan: pl.offScan } : {}),
})

interface SetIn {
  curve: number
  crease?: boolean
  spans?: number | null
  along?: CurveIn['along'] | null
  side?: CurveIn['side'] | null
}

type MoveIn = { node: number; to: Vec3 } | { curve: number; grip: number; to: Vec3 }

interface EditIn {
  feature: Ref
  set?: SetIn[]
  move?: MoveIn[]
  remove?: { curves?: number[]; nodes?: number[]; grips?: { curve: number; index: number }[] }
  grips?: { curve: number; at: Vec3 }[]
  add?: CurveIn[]
  unfill?: 'all' | number[]
  fill?: FillIn
  fit?: { smoothness?: number; robust?: boolean; tolerance?: number }
  name?: string
  snap?: number
  detail?: 'none' | 'brief'
}

/** reverse.network.edit's input: as listed, or whole (holdTo). */
const editIn = (whole: boolean) =>
  obj(
    {
      feature: featureRef('patch network'),
      set: arr(
        obj(
          {
            curve: int('The curve’s id.'),
            crease: bool('true: the patches either side meet at an angle; false: tangent.'),
            spans: oneOf([spansIn, { type: 'null' }], 'The span count of the strip the curve runs along; null: Auto.'),
            along: oneOf([whole ? alongWhole : alongListed, { type: 'null' }], 'A body’s edge the curve runs along; null lets it go.'),
            side: oneOf([whole ? sideWhole : sideListed, { type: 'null' }], 'A body’s face the patch beside the curve meets; null lets it go.'),
          },
          ['curve'],
        ),
        'Curves’ fields set, by id.',
        { minItems: 1 },
      ),
      move: arr(
        oneOf([obj({ node: int('The node’s id.'), to: pointIn }, ['node', 'to'], 'A node moved.'), obj({ curve: int('The curve’s id.'), grip: int('The grip’s index along the curve, from 0.', { minimum: 0 }), to: pointIn }, ['curve', 'grip', 'to'], 'A grip moved.')]),
        'Nodes and grips moved.',
        { minItems: 1 },
      ),
      remove: obj(
        {
          curves: arr(int(), 'Curve ids.', { minItems: 1 }),
          nodes: arr(int(), 'Node ids — every curve ending at one goes with it.', { minItems: 1 }),
          grips: arr(obj({ curve: int(), index: int('', { minimum: 0 }) }, ['curve', 'index']), 'Grips, by curve and index.', { minItems: 1 }),
        },
        [],
        'What is taken out.',
      ),
      grips: arr(obj({ curve: int('The curve’s id.'), at: pointIn }, ['curve', 'at']), 'Grips put into curves.', { minItems: 1 }),
      add: curvesIn('Curves added, as reverse.network.create takes them.', whole),
      unfill: oneOf([enumOf(['all']), arr(int('', { minimum: 0 }), '', { minItems: 1 })], 'Cells emptied: by index, or "all".'),
      fill: fillIn,
      fit: fitIn,
      name: str('A new name.', { minLength: 1 }),
      snap: snapIn,
      detail: detailIn,
    },
    ['feature'],
  )
const EDIT_WHOLE = editIn(true)

export const networkEdit: Command<EditIn> = {
  name: 'edit',
  // A patch network's cells are the scan's triangles; a cloud has none.
  needsTriangles: true,
  title: 'Edit a patch network',
  description:
    'Change a Patch network as reopening its box and drawing does, in one undo step, the network built again after. Curves, nodes, grips and cells are named by the ids and indices reverse.network.read gives before the edit, and the changes go in this order: set (per curve: crease; spans, null back to Auto; along and side, null letting either go), move (a node or a curve’s grip to a point, taken onto the scan, the curves through it following), remove (grips; curves, with the nodes no other curve ends at; nodes, with every curve ending at them), grips (a grip put into a curve on its run nearest the point: on the curve it keeps its course, off it bends the curve there), add (curves as reverse.network.create takes them, joined where their points land on the network; added gives their ids), unfill and fill (cells by index or "all"; a network keeps one filled region at least), fit and name. Answers as reverse.network.create.',
  input: editIn(false),
  label: ({ feature }) => {
    try {
      return `edit ${featureNamed(feature).name}`
    } catch {
      return 'edit patch network'
    }
  },
  run: async (input) => {
    holdTo(EDIT_WHOLE, input)
    const { feature, set, move, remove, grips, add, unfill, fill, fit, name, snap = SNAP_MM, detail = 'brief' } = input
    const f = networkOf(feature)
    if (!re().features.includes(f)) throw new CommandError('invalid_state', `${f.name} is below the rollback bar — move the bar (reverse.feature.rollback) to edit it.`)
    if ([set, move, remove, grips, add, unfill, fill, fit, name].every((x) => x === undefined)) invalid('Nothing to change — give set, move, remove, grips, add, unfill, fill, fit or name.')
    requireFreeName(name, f.id)
    // Every id and index named, checked against the network as read.
    const curveIds = new Set(f.curves.map((c) => c.id))
    const nodeIds = new Set(f.nodes.map((n) => n.id))
    const curveOf = (id: number, at: string) => {
      const c = f.curves.find((x) => x.id === id)
      if (!c) throw new CommandError('not_found', `${at}: ${f.name} has no curve ${id} — it has ${[...curveIds].join(', ') || 'none'} (reverse.network.read).`)
      return c
    }
    for (const [k, x] of (set ?? []).entries()) curveOf(x.curve, `set[${k}]`)
    for (const [k, m] of (move ?? []).entries()) {
      if ('node' in m) {
        if (!nodeIds.has(m.node)) throw new CommandError('not_found', `move[${k}]: ${f.name} has no node ${m.node} — it has ${[...nodeIds].join(', ')}.`)
      } else if (m.grip >= curveOf(m.curve, `move[${k}]`).via.length) throw new CommandError('not_found', `move[${k}]: curve ${m.curve} has ${curveOf(m.curve, '').via.length} grips — 0 to ${curveOf(m.curve, '').via.length - 1}.`)
    }
    for (const [k, g] of (remove?.grips ?? []).entries()) if (g.index >= curveOf(g.curve, `remove.grips[${k}]`).via.length) throw new CommandError('not_found', `remove.grips[${k}]: curve ${g.curve} has ${curveOf(g.curve, '').via.length} grips.`)
    for (const [k, id] of (remove?.curves ?? []).entries()) curveOf(id, `remove.curves[${k}]`)
    for (const [k, id] of (remove?.nodes ?? []).entries()) if (!nodeIds.has(id)) throw new CommandError('not_found', `remove.nodes[${k}]: ${f.name} has no node ${id}.`)
    for (const [k, g] of (grips ?? []).entries()) curveOf(g.curve, `grips[${k}]`)
    const gone = new Set([...(remove?.curves ?? []), ...f.curves.filter((c) => remove?.nodes?.some((n) => n === c.from || n === c.to)).map((c) => c.id)])
    for (const [k, x] of (set ?? []).entries()) if (gone.has(x.curve)) invalid(`set[${k}]: curve ${x.curve} is removed in the same edit.`)
    for (const [k, g] of (grips ?? []).entries()) if (gone.has(g.curve)) invalid(`grips[${k}]: curve ${g.curve} is removed in the same edit.`)
    if (Array.isArray(unfill)) for (const [k, i] of unfill.entries()) if (i >= f.cells.length) throw new CommandError('not_found', `unfill[${k}]: ${f.name} has ${f.cells.length} cells — 0 to ${f.cells.length - 1}.`)

    const s = await ready()
    const pl = new Placing(scanPaths(s), networkDraftOf(f), snap)
    const strips = reportOf(f.id)?.strips ?? []
    // set: each curve's fields.
    for (const [k, x] of (set ?? []).entries()) {
      const c = pl.d.curves.find((y) => y.id === x.curve)!
      if (x.crease !== undefined && (c.crease === true) !== x.crease) pl.d = toggleCrease(pl.d, x.curve)
      if (x.spans !== undefined) {
        // Keyed by a curve of the feature's own: a split cell's spokes are
        // made again with every build.
        const strip = strips.find((st) => st.curves.includes(x.curve))
        if (strip) pl.d = setStripSpans(pl.d, strip.curves.filter((c) => curveIds.has(c)), x.spans)
        else {
          const spans = { ...pl.d.spans }
          if (x.spans === null) delete spans[String(x.curve)]
          else spans[String(x.curve)] = x.spans
          pl.d = { ...pl.d, spans }
        }
      }
      if (x.along !== undefined || x.side !== undefined) {
        const picks = picksOf(s, { ...(x.along ? { along: x.along } : {}), ...(x.side ? { side: x.side } : {}) }, `set[${k}]`)
        pl.d = {
          ...pl.d,
          curves: pl.d.curves.map((y) => {
            if (y.id !== x.curve) return y
            const next: NetworkCurve = { ...y }
            if (x.along === null) delete next.along
            else if (picks.along) next.along = picks.along
            if (x.side === null) delete next.side
            else if (picks.side) next.side = picks.side
            return next
          }),
        }
      }
    }
    // move: nodes and grips, onto the scan.
    for (const m of move ?? []) {
      const to = pl.onScan(m.to)
      pl.d = 'node' in m ? moveNode(pl.d, m.node, to) : moveGrip(pl.d, m.curve, m.grip, to)
    }
    // remove: grips last to first along each curve, then curves, then nodes.
    for (const g of [...(remove?.grips ?? [])].sort((a, b) => a.curve - b.curve || b.index - a.index)) pl.d = removeGrip(pl.d, g.curve, g.index)
    for (const id of remove?.curves ?? []) pl.d = removeCurve(pl.d, id)
    for (const id of remove?.nodes ?? []) pl.d = removeNode(pl.d, id)
    // grips: each on the run of its curve nearest the point.
    for (const g of grips ?? []) {
      const at = pl.onScan(g.at)
      const c = pl.d.curves.find((y) => y.id === g.curve)!
      const t = pl.traceOf(c)
      const near = t ? nearestOnTrace(t, at) : null
      pl.d = insertGrip(pl.d, g.curve, near?.run ?? c.via.length, at)
    }
    // add: curves joined to the network as it now stands.
    for (const [i, c] of (add ?? []).entries()) pl.place(c, i, picksOf(s, c, `add[${i}]`))
    // unfill, then fill.
    if (unfill === 'all') pl.d = { ...pl.d, cells: [] }
    else for (const i of [...(unfill ?? [])].sort((a, b) => b - a)) pl.d = removeSeed(pl.d, i)
    if (fill !== undefined) pl.d = filled(pl, fill)
    if (fit) pl.d = setNetworkFit(pl.d, fit)
    if (pl.d.curves.length === 0) invalid(`That leaves ${f.name} with no curves — remove the feature instead (reverse.feature.remove).`)
    if (!networkReady(pl.d)) {
      if (unfill !== undefined && fill === undefined) invalid(`That leaves no region of ${f.name} filled, and a network keeps one at least — fill one, or remove the feature (reverse.feature.remove).`)
      nothingFilled(pl)
    }
    const before = bodyRows(s)
    const id = await commit(s, pl.d, { edit: f.id, ...(name !== undefined ? { name } : {}) })
    return changedAnswer(s, id, add ? placedOut(pl, 'added') : {}, detail, before)
  },
}

export const networkRead: Command<{ feature: Ref; detail?: 'brief' | 'full' }> = {
  name: 'read',
  // A patch network's cells are the scan's triangles; a cloud has none.
  needsTriangles: true,
  title: 'Read a patch network',
  description:
    'A Patch network as its box reads it after the last build: status (ok, failed with why, not built, suppressed), line (the box’s status line), counts, closed (a solid), worstAngle (degrees, across a tangent curve) and worstGap (mm, between the kernel’s faces along a shared curve); patches (index, cell, rms and max off the scan, misfit — what it misses the scan by beyond the scan’s noise —, the worst points, net, points, dropped, the curves of its sides and its corners’ nodes); cells (each seed with its sides and patches, or why it was refused and where); unfilled (closed regions no seed fills, a point inside each); curves (id, from, to, via, crease, along, side, strip, and where two patches share it gap and angle, or fold on a crease); nodes; strips (spans, auto, curves); corners (where three, five or six patches meet, or four whose tangency could not be held, with their angle); openEnds; lost (curves with no path along the scan). detail "brief": status, line, counts, closed, worst, the patches’ rms, max, misfit and net, the cells refused and unfilled. Ids and indices are what reverse.network.edit names. Changes nothing.',
  input: obj({ feature: featureRef('patch network'), detail: enumOf(['brief', 'full'], 'full (the default): everything; brief: the reading in short.') }, ['feature']),
  readOnly: true,
  run: async ({ feature, detail = 'full' }) => {
    networkOf(feature)
    await ready()
    const f = networkOf(feature)
    const rolledBack = re().rolledBack.includes(f)
    const row = featureBrief(f, rolledBack)
    const report = rolledBack ? undefined : reportOf(f.id)
    const r = re().results[f.id]
    const head = {
      feature: { id: f.id, name: f.name },
      status: row.status,
      ...(r?.status === 'failed' && r.message ? { message: r.message } : {}),
      ...(r?.note ? { note: r.note } : {}),
      line: lineOf(f, report),
      counts: { nodes: f.nodes.length, curves: f.curves.length, cells: f.cells.length, patches: report?.patches.length ?? 0, unfilled: report?.unfilled.length ?? 0, refused: report ? refusedOut(report).length : 0 },
      ...(report ? { closed: report.closed, worstAngle: r4(report.worstAngle), worstGap: sig3(report.worstGap) } : {}),
    }
    // The network's own nodes, curves and cells always; what the build
    // read of them — patches, gaps, angles, strips — where it read them.
    const cellOfPatch = new Map<number, number>()
    report?.cells.forEach((c, i) => {
      for (const p of patchesOf(c)) cellOfPatch.set(p, i)
    })
    const unfilled = (report?.unfilled ?? []).map((u) => ({ seed: at4(u.seed), sides: u.sides }))
    const refused = report ? refusedOut(report) : []
    if (detail === 'brief') return { ...head, ...(report ? { patches: report.patches.map((p, i) => ({ ...patchRow(p, i, false), cell: cellOfPatch.get(i) ?? null })) } : {}), ...(refused.length > 0 ? { refused } : {}), ...(unfilled.length > 0 ? { unfilled } : {}) }
    const shared = new Map((report?.curves ?? []).map((c) => [c.curve, c]))
    const stripOf = new Map<number, number>()
    report?.strips.forEach((st, i) => {
      for (const c of st.curves) stripOf.set(c, i)
    })
    const open = openEnds(f)
    const outcome = (i: number) => report?.cells[i]
    return {
      ...head,
      ...(report ? { patches: report.patches.map((p, i) => ({ ...patchRow(p, i, true), cell: cellOfPatch.get(i) ?? null })) } : {}),
      cells: f.cells.map((cell, i) => {
        const c = outcome(i)
        const own = { cell: i, seed: at4(cell.seed), ...(cell.centre ? { centre: at4(cell.centre) } : {}) }
        if (!c) return own
        return 'refused' in c ? { ...own, refused: c.refused, ...(c.at ? { at: at4(c.at) } : {}) } : { ...own, sides: c.sides, patches: patchesOf(c) }
      }),
      ...(report ? { unfilled } : {}),
      curves: f.curves.map((c) => {
        const sh = shared.get(c.id)
        const strip = stripOf.get(c.id)
        return {
          id: c.id,
          from: c.from,
          to: c.to,
          via: c.via.map(at4),
          ...(c.crease ? { crease: true } : {}),
          ...(c.along ? { along: { body: c.along.body, edge: { mid: at4(c.along.edge.mid), length: round3(c.along.edge.length) } } } : {}),
          ...(c.side ? { side: { body: c.side.body, face: { kind: c.side.face.kind, centroid: at4(c.side.face.centroid) }, mode: c.side.mode } } : {}),
          ...(strip !== undefined ? { strip } : {}),
          ...(sh ? { gap: sig3(sh.gap), ...(sh.crease ? { fold: r4(sh.angle) } : { angle: r4(sh.angle) }) } : {}),
        }
      }),
      nodes: f.nodes.map((n) => ({ id: n.id, at: at4(n.at), ...(n.corner !== undefined ? { corner: n.corner } : {}) })),
      ...(report
        ? {
            strips: report.strips.map((st, i) => ({ strip: i, spans: st.spans, auto: st.auto, curves: st.curves })),
            corners: report.corners.map((c) => ({ node: c.node, at: at4(c.at), patches: c.patches, angle: r4(c.angle) })),
          }
        : {}),
      ...(open.length > 0 ? { openEnds: open } : {}),
      ...(report && report.lost.length > 0 ? { lost: report.lost } : {}),
      ...(report ? { ms: Math.round(report.ms.trace + report.ms.cells + report.ms.map + report.ms.fit + report.ms.faces) } : {}),
    }
  },
}

export const networkSuggestCreases: Command<{ box?: { min: Vec3; max: Vec3 }; strongDeg?: number; weakDeg?: number; limit?: number }> = {
  name: 'suggest_creases',
  // A patch network's cells are the scan's triangles; a cloud has none.
  needsTriangles: true,
  title: 'Suggest creases for a patch network',
  description:
    'The scan’s sharp ridges and folds traced as curves for a Patch network — the box’s Suggest creases: each edge’s fold between the scan’s normals, kept where it folds past strongDeg and followed on while it folds past weakDeg (25° and 12° unless given), thinned to single lines, chains too short for a patch’s side dropped, the rest fitted with their ends merged into shared nodes; within box, or over the whole scan. Each candidate’s curve is ready for reverse.network.create { curves } or reverse.network.edit { add } — its points end to end, crease: true — with its length (mm) and angle (how far the scan folds along it, degrees), the longest first, limit of them (40 by default). A fillet that rounds the fold over is no crease, and is not offered. Changes nothing.',
  input: obj({
    box: obj({ min: vec3('The lowest corner, mm.'), max: vec3('The highest corner, mm.') }, ['min', 'max'], 'Only the scan in this box, in the frame the part is measured in now.'),
    strongDeg: num('The fold a crease is started on, degrees.', { exclusiveMinimum: 0, maximum: 180 }),
    weakDeg: num('The fold a crease is followed on along, degrees; under strongDeg.', { exclusiveMinimum: 0, maximum: 180 }),
    limit: int('How many candidates come back, the longest first.', { minimum: 1 }),
  }),
  readOnly: true,
  long: true,
  run: async ({ box, strongDeg, weakDeg, limit = 40 }) => {
    if (strongDeg !== undefined && weakDeg !== undefined && weakDeg > strongDeg) invalid(`weakDeg (${weakDeg}) is over strongDeg (${strongDeg}) — a crease is followed on at a fold no larger than the one it starts on.`)
    const found = suggestCreases(scanPaths(session()), { ...(box ? { box } : {}), ...(strongDeg !== undefined ? { strongDeg } : {}), ...(weakDeg !== undefined ? { weakDeg } : {}) })
    const at = new Map(found.nodes.map((n) => [n.id, n.at]))
    const candidates = found.curves
      .map((c) => ({ curve: { points: [at.get(c.from)!, ...c.via, at.get(c.to)!].map(at4), crease: true }, length: round3(c.length), angle: Math.round(c.angle * 10) / 10 }))
      .sort((a, b) => b.length - a.length)
    return { count: candidates.length, candidates: candidates.slice(0, limit), ...(candidates.length > limit ? { more: candidates.length - limit } : {}) }
  },
}

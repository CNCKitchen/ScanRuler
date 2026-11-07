// SPDX-License-Identifier: AGPL-3.0-only
// How the Reverse engineer commands answer: a change's feature row, its
// regions and the bodies it touched at the detail asked for, the rollback
// bar, and what failed.

import { commandHost } from '../../../src/commands/host'
import { enumOf } from '../../../src/commands/schema'
import { roundTo } from '../../../src/core/round'
import type { SectionFrame } from '../../../src/core/section/frame'
import type { Vec3 } from '../../../src/core/types'
import { dot, sub } from '../../../src/core/vec'
import { useStore } from '../../../src/state/store'
import { openEnds } from '../core/corners'
import type { Feature, PlaneRef, SketchFeature } from '../core/features'
import { sketchBounds } from '../core/sketch'
import { collinearPieces, kinkedJoins, kinkFix, nearMissFix, sketchNearMisses } from '../core/sketchNearMiss'
import { splineOvershoots } from '../core/sketchSpline'
import { stepsAnswer } from '../core/stepWords'
import { allFeatures, type Json, re } from './reCommandCore'
import { bodiesOut, featureBrief, featureOut, lineMiddle, regionsOut, resultOut } from './reReadout'
import type { ReverseSession } from './reSession'

/** How many of a failure's places an answer lists. */
const FAILED_AT_CAP = 12

/** The middle of each edge or outline a failure was drawn red on — where
 *  an agent, which sees no red, finds what failed. */
function failedAt(where: readonly Float32Array[] | undefined): number[][] {
  return (where ?? []).slice(0, FAILED_AT_CAP).filter((p) => p.length >= 3).map((p) => lineMiddle(p).map((v) => Math.round(v * 1000) / 1000))
}

/** Every feature the last build failed, with why, and where on the part
 *  for a round, a chamfer or a shell. */
export const failures = () =>
  re()
    .features.filter((f) => re().results[f.id]?.status === 'failed')
    .map((f) => {
      const r = re().results[f.id]
      const at = r?.status === 'failed' ? failedAt(r.where) : []
      return { id: f.id, name: f.name, message: r?.message ?? 'failed', ...(at.length > 0 ? { at } : {}) }
    })

/** What each failing feature's message said last in an answer, by id: told
 *  in full once, then by its first sentence — a failed round's 7 k rode on
 *  every change after it until it was fixed. */
const failuresTold = new Map<number, string>()

/** How much of a failure said before an answer repeats, characters. */
const FAILURE_AGAIN = 200

const failureAgain = (message: string) => {
  const end = message.search(/[.:] /)
  const first = end >= 0 ? message.slice(0, end + 1) : message
  return first.length > FAILURE_AGAIN ? `${first.slice(0, FAILURE_AGAIN)}…` : first
}

/** A command's answer with what it says of failures said once: the feature
 *  row's message left to its result beside it, and each `failed` in full
 *  the first time, by its first sentence after — reverse.feature.list has
 *  the whole. */
export function failuresOnce(out: Json): Json {
  const failed = out.failed as { id: number; message: string }[] | undefined
  const row = out.feature as { message?: string } | undefined
  const result = out.result as { message?: string } | undefined
  const here = row?.message !== undefined && row.message === result?.message ? { feature: Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'message')) } : {}
  if (!Array.isArray(failed)) return { ...out, ...here }
  for (const id of [...failuresTold.keys()]) if (re().results[id]?.status !== 'failed') failuresTold.delete(id)
  return {
    ...out,
    ...here,
    failed: failed.map((f) => {
      const again = failuresTold.get(f.id) === f.message || f.message === result?.message
      failuresTold.set(f.id, f.message)
      return again ? { ...f, message: failureAgain(f.message), said: 'in full before; reverse.feature.list has it' } : f
    }),
  }
}

/** What this workspace's part of a history step's answer says: the
 *  features, the bar, the bodies and what failed, by name. */
export function afterStepOut() {
  const failed = failures()
  return {
    features: allFeatures().length,
    rollback: barOut(),
    bodies: re().bodies.map((b) => b.name),
    ...(failed.length > 0 ? { failed: failed.map((f) => ({ id: f.id, name: f.name })) } : {}),
  }
}

/** How much a change answers with: `none`, the feature's id and status,
 *  the rollback bar and what failed; `brief`, what it changed — the
 *  feature's row, the bodies it made, changed or took away; or `full`, the
 *  feature as stored and every body. */
export type Detail = 'none' | 'brief' | 'full'

export const detailIn = enumOf(
  ['none', 'brief', 'full'],
  'none: id, status, the bar, failed and what was read by number (fitted, picked, rounds, accept, moved); brief (the default): the row, regions, the bodies changed, made and picked; full: the feature as stored, every body, made.',
)

/** Where the rollback bar stands: how many features are above it, of how
 *  many. */
export function barOut() {
  const r = re()
  return { at: r.features.length, of: r.features.length + r.rolledBack.length }
}

/** What a change's answer keeps at every detail: the numbers it read or
 *  was asked for — a fitted value, what each pick landed on, a round's
 *  radius and sigma, the relations accepted, the pieces moved, the ids
 *  given in place of those asked for — a note on what it left standing,
 *  and the op it took when none was given, with what it joined. Asked for,
 *  they are the answer. */
const KEPT = ['ids', 'set', 'fitted', 'picked', 'rounds', 'accept', 'moved', 'movedFar', 'draftBothWays', 'nearSketches', 'nearSketchesFound', 'nearSketchesFix', 'collinearPieces', 'collinearFix', 'kinks', 'kinksFound', 'kinkFix', 'inset', 'draftOffset', 'ellipses', 'solids', 'note', 'renumbered', 'op', 'joined', 'element', 'farFromElement', 'largestInside'] as const

/** A change's answer with detail none: the feature's id and status, the
 *  bar, what failed, and from `extra` what every detail keeps (KEPT). */
export function noneAnswer(id: number, extra: Json = {}) {
  const f = allFeatures().find((x) => x.id === id)
  const failed = failures()
  // A fitted number's reading is kept; a sketch's fitted chains (a list,
  // each chain's pieces) are what brief adds.
  const kept = Object.fromEntries(KEPT.filter((k) => extra[k] !== undefined && !(k === 'fitted' && Array.isArray(extra[k]))).map((k) => [k, extra[k]]))
  // The fit's pieces by id: what the next relation names.
  const fittedPieces = Array.isArray(extra.fitted) ? (extra.fitted as { pieces?: { id: number }[] }[]).flatMap((c) => (c.pieces ?? []).map((p) => p.id)) : []
  return { id, status: f ? featureBrief(f, re().rolledBack.includes(f)).status : 'removed', rollback: barOut(), ...kept, ...(fittedPieces.length > 0 ? { fittedPieces } : {}), ...warnedOut(f), ...(failed.length > 0 ? { failed } : {}) }
}

/** What a change left that was likely meant otherwise, said at every
 *  detail: a join's steps against the faces it found (stepsBetween, the
 *  thinnest few — stepWords.ts), a sketch's pieces lying a hair off another
 *  sketch's on a parallel plane (nearSketches, with the fix —
 *  sketchNearMiss.ts), two lines end to end (collinearPieces), a join that
 *  turns a few degrees (kinks), a spline swinging past its points
 *  (splineOvershoot — sketchSpline.ts), and a taper
 *  through the sketch plane (draftBothWays). What only a sketch's or an
 *  extrude's shape could change is said once for that shape: a deliberate
 *  0.25 mm between two sketches warned on every edit of the last fan. */
function warnedOut(f: Feature | undefined): Json {
  if (!f) return {}
  if (f.kind !== 'sketch') return { ...stepsAnswer(re().results[f.id]?.stepsBetween, allFeatures()), ...(f.kind === 'extrude' ? draftBothWays(f) : {}) }
  const others = re().features.filter((x): x is SketchFeature => x.kind === 'sketch')
  const { misses, found } = sketchNearMisses(f, others, re().features)
  const fresh = misses.filter((m) => firstTime(`near|${f.id}|${m.sketch}|${m.offMm}`))
  const lines = collinearPieces(f.sketch).filter((c) => firstTime(`line|${f.id}|${c.pieces.join()}`))
  const kinks = kinkedJoins(f.sketch).filter((k) => firstTime(`kink|${f.id}|${k.pieces.join()}`))
  const overshoots = f.sketch.entities.flatMap((e) => (e.kind === 'spline' && !e.construction ? splineOvershoots(e).map((o) => ({ piece: e.id, ...o })) : [])).filter((o) => firstTime(`overshoot|${f.id}|${o.piece}|${o.axis}|${o.mm}`))
  return {
    ...(fresh.length > 0 ? { nearSketches: fresh, ...(found > fresh.length ? { nearSketchesFound: found } : {}), nearSketchesFix: nearMissFix(f, fresh, others) } : {}),
    ...(lines.length > 0 ? { collinearPieces: lines, collinearFix: 'Two lines end to end on one line are two faces where the viewer draws one: a split a round or a later cut can stop at. Draw one line in their place, unless the join is there for something else.' } : {}),
    ...(kinks.length > 0 ? { kinks: kinks.slice(0, KINKS_SHOWN), ...(kinks.length > KINKS_SHOWN ? { kinksFound: kinks.length } : {}), kinkFix: kinkFix(f, kinks) } : {}),
    // units-ok: the answer's warning, for the agent — in millimetres always.
    ...(overshoots.length > 0 ? { splineOvershoot: overshoots, splineOvershootFix: 'The spline swings past its own points where they run one way (mm past, at, stretch k between fit points k and k + 1): a smooth curve through few points bulges between them, most at a held end direction. Add a point where it bulges, set startDir/endDir the way the points run, or fit the stretch as lines and arcs (sketch fit: { points, arcs }).' } : {}),
  }
}

/** How many kinks an answer lists. */
const KINKS_SHOWN = 12

/** What warnedOut has said, by what it was said of. */
const warnedOf = new Set<string>()

const firstTime = (key: string) => {
  if (warnedOf.has(key)) return false
  warnedOf.add(key)
  return true
}

/** An extrude whose taper runs through its sketch plane: taperedPrism's two
 *  prisms joined there, so each side is two faces. */
function draftBothWays(f: Extract<Feature, { kind: 'extrude' }>): Json {
  if (!f.draftDeg) return {}
  const e = f.extent
  const through = e.kind === 'symmetric' || (e.kind === 'distance' && e.from * e.to < 0)
  if (!through || !firstTime(`draft|${f.id}|${JSON.stringify(e)}|${f.draftDeg}`)) return {}
  return { draftBothWays: 'The taper leans away from the sketch plane both ways, so each side is two faces meeting at that plane: right for a parting line there. For one face per side, put the sketch at the large end and extrude one way.' }
}

/** The bodies as they stand, each as its row reads — what a change is
 *  told against. */
export function bodyRows(s: ReverseSession | null): Map<number, string> {
  return new Map(bodiesOut(s).map((b) => [b.id, JSON.stringify(b)]))
}

/** The bodies a change touched: made or changed, with their rows, and
 *  taken away, by id — and how many there are now. */
export function bodiesChanged(s: ReverseSession, before: Map<number, string>) {
  const now = bodiesOut(s)
  const changed = now.filter((b) => before.get(b.id) !== JSON.stringify(b))
  const removed = [...before.keys()].filter((id) => !now.some((b) => b.id === id)).map((id) => ({ id, name: (JSON.parse(before.get(id)!) as { name: string }).name }))
  return { count: now.length, ...(changed.length > 0 ? { changed } : {}), ...(removed.length > 0 ? { removed } : {}) }
}

/** How far apart two ends may be and still be told as a near miss, mm:
 *  past it, an end left open on purpose — a path's, a sheet's. */
const NEAR_MISS_MM = 1

/** A sketch that closes no region: the ends of its outline that meet
 *  nothing, the smallest gaps first, each with the end nearest it — a miss
 *  of microns seen as one, not as no region. One that closes regions:
 *  its open ends within NEAR_MISS_MM of another (nearMiss) — an arc ended a
 *  tenth off its line closes the rest and leaves that profile open, which
 *  an extrude on it then finds "no longer closed". */
export function openOut(s: ReverseSession, f: SketchFeature) {
  const open = openEnds(f.sketch)
  const out = (list: typeof open) => list.slice(0, 12).map((o) => ({ piece: o.piece, end: o.end, nearest: o.nearest, gap: o.gap === null ? null : Number(o.gap.toPrecision(3)) }))
  if (s.regionsOf(f).length === 0) return open.length > 0 ? { open: out(open) } : {}
  // Two ends that miss each other are one miss, told once.
  const near = open.filter((o, i) => o.gap !== null && o.gap <= NEAR_MISS_MM && !open.slice(0, i).some((p) => p.piece === o.nearest?.piece && p.end === o.nearest.end && p.nearest?.piece === o.piece && p.nearest.end === o.end))
  return near.length > 0 ? { nearMiss: out(near) } : {}
}

/** A sketch's regions as a brief answer gives them: a point inside each to
 *  pick it by ({ at }), and its area. */
const regionsBrief = (s: ReverseSession, f: SketchFeature) => s.regionsOf(f).map((r) => ({ at: r.inside, area: r.area, ...(r.holes.length > 0 ? { holes: r.holes.length } : {}) }))

/** How many faces, and how many edges, a change's answer lists of what
 *  the feature made on each body — the rest counted. */
export const MADE_CAP = 20

/** The faces and edges a feature made, on the bodies a change touched,
 *  each by its index in reverse.body.describe as the body stands — what
 *  the next feature picks, without describing the body again: a face's
 *  kind, normal or axis, centroid, radius and area; an edge's kind,
 *  length, middle, radius and the faces either side by index. A face is
 *  the feature's when the feature made it (madeBy); an edge when its
 *  newest face is. Empty for a feature that made no face (a sketch). */
export function madeOut(s: ReverseSession, featureId: number, bodyIds: readonly number[]) {
  const out: Json[] = []
  for (const id of bodyIds) {
    const t = s.topologies.get(id)
    const body = re().bodies.find((b) => b.id === id)
    if (!t || !body) continue
    const faceIndex = new Map(t.faces.map((f, i) => [f.hash, i]))
    const faces = t.faces.flatMap((f, i) => (f.fingerprint.origin === featureId ? [{ f, i }] : []))
    const edges = t.edges.flatMap((e, i) => (e.fingerprint.origin === featureId ? [{ e, i }] : []))
    if (faces.length === 0 && edges.length === 0) continue
    out.push({
      body: { id, name: body.name },
      faces: faces.slice(0, MADE_CAP).map(({ f, i }) => {
        const fp = f.fingerprint
        const round = fp.kind === 'cylinder' || fp.kind === 'cone' || fp.kind === 'torus'
        return { index: i, kind: fp.kind, ...(round ? { axis: fp.dir } : { normal: fp.dir }), centroid: fp.centroid, ...(fp.radius !== undefined ? { radius: fp.radius } : {}), area: fp.area }
      }),
      edges: edges.slice(0, MADE_CAP).map(({ e, i }) => {
        const fp = e.fingerprint
        return { index: i, kind: fp.kind, length: fp.length, mid: fp.mid, ...(fp.radius !== undefined ? { radius: fp.radius } : {}), faces: e.faces.map((h) => faceIndex.get(h) ?? null) }
      }),
      ...(faces.length > MADE_CAP || edges.length > MADE_CAP ? { of: { faces: faces.length, edges: edges.length } } : {}),
    })
  }
  return out.length > 0 ? { made: out } : {}
}

/** A feature as a command answers with it: what the build said of it, and
 *  — brief — its row, a sketch's regions by a point in each, the bodies
 *  the change touched and the faces and edges the feature made on them;
 *  or — full — the feature as stored, its regions whole, every body, and
 *  what it made. With detail none, its id and status, and the numbers
 *  read or asked for (noneAnswer). */
export function featureAnswer(s: ReverseSession, id: number, extra: Json, detail: Detail, before: Map<number, string>) {
  if (detail === 'none') return noneAnswer(id, extra)
  const f = allFeatures().find((x) => x.id === id)
  const failed = failures()
  const full = detail === 'full'
  const changed = bodiesChanged(s, before)
  return {
    feature: f ? (full ? featureOut(f) : { ...featureBrief(f, re().rolledBack.includes(f)), ...frameOut(f) }) : null,
    result: resultOut(re().results[id]),
    ...extra,
    ...(f?.kind === 'sketch' ? { regions: full ? regionsOut(s.regionsOf(f)) : regionsBrief(s, f), ...openOut(s, f), freeIds: f.sketch.nextId } : {}),
    bodies: full ? bodiesOut(s) : changed,
    ...(f && f.kind !== 'sketch' && changed.changed ? madeOut(s, id, changed.changed.map((b) => b.id)) : {}),
    ...warnedOut(f),
    ...(failed.length > 0 ? { failed } : {}),
  }
}

/** A sketch's frame on its brief row, as the full one has it: where its
 *  [u, v] lie in the world — origin, normal, and the ways u and v run —
 *  what every point drawn on it is read in. The list's rows leave it out. */
function frameOut(f: Feature): Json {
  if (f.kind !== 'sketch') return {}
  const { origin, normal, basisU, basisV } = f.frame
  return { frame: { origin, normal, basisU, basisV } }
}

/** Where a measured plane lies on a sheet drawn on it: its name, its
 *  centre and box in the sheet's [u, v], what they were read from — the
 *  fitted patch, or for a plane constructed (whose patch is drawn at a
 *  share of the part, nothing measured) the scan where it meets the plane
 *  — and how far from the centre a drawing still counts as on it. */
export interface ElementOnSheet {
  name: string
  centre: [number, number]
  box: [[number, number], [number, number]]
  from: 'patch' | 'scan' | 'drawn'
  reach: number
}

/** How far from a plane element's centre pieces may lie, at least, before
 *  they are told as drawn elsewhere, mm. */
const ELEMENT_REACH_MIN_MM = 10

/** How many of the scan's points are read for a constructed plane's
 *  footprint, spread evenly through the scan. */
const FOOTPRINT_SAMPLE = 60_000

/** How few of them near the plane still make a footprint. */
const FOOTPRINT_MIN_POINTS = 12

/** The scan's points about a plane — within a hundredth of the scan's
 *  diagonal, a millimetre at least — as [u, v] on the sheet, or null with
 *  no scan or too few near it. */
async function footprintOn(origin: Vec3, normal: Vec3, frame: SectionFrame): Promise<[number, number][] | null> {
  let worker: ReturnType<typeof commandHost>['session']['clientRef']['current']
  try {
    worker = commandHost().session.clientRef.current
  } catch {
    return null
  }
  if (!worker || !useStore.getState().fileName) return null
  const { min, max } = await worker.bounds()
  const band = Math.max(1, 0.01 * Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]))
  const q = await worker.query({ min, max, limit: FOOTPRINT_SAMPLE })
  const out: [number, number][] = []
  for (let i = 0; i < q.positions.length / 3; i++) {
    const p: Vec3 = [q.positions[3 * i], q.positions[3 * i + 1], q.positions[3 * i + 2]]
    if (Math.abs(dot(sub(p, origin), normal)) > band) continue
    const d = sub(p, frame.origin)
    out.push([dot(d, frame.basisU), dot(d, frame.basisV)])
  }
  return out.length >= FOOTPRINT_MIN_POINTS ? out : null
}

/** A measured plane as a sheet on it sees it (ElementOnSheet), or null for
 *  a plane that is no element's — or an element gone. A sketch on an
 *  element counts from the world origin's foot, as on any plane, not from
 *  the element's centre: this says where on that sheet the element is. */
export async function elementOnSheet(ref: PlaneRef, frame: SectionFrame): Promise<ElementOnSheet | null> {
  if (ref.kind !== 'plane') return null
  const el = useStore.getState().elements.find((e) => e.id === ref.id)
  const fit = el?.fit
  if (!el || fit?.kind !== 'plane') return null
  const onSheet = (p: Vec3): [number, number] => {
    const d = sub(p, frame.origin)
    return [dot(d, frame.basisU), dot(d, frame.basisV)]
  }
  const scan = el.source.type === 'constructed' ? await footprintOn(fit.center, fit.normal, frame) : null
  const corners = scan ?? [-1, 1].flatMap((a) => [-1, 1].map((b) => onSheet([0, 1, 2].map((k) => fit.center[k] + a * fit.extentU * fit.basisU[k] + b * fit.extentV * fit.basisV[k]) as Vec3)))
  const lo: [number, number] = [Math.min(...corners.map((p) => p[0])), Math.min(...corners.map((p) => p[1]))]
  const hi: [number, number] = [Math.max(...corners.map((p) => p[0])), Math.max(...corners.map((p) => p[1]))]
  // The element's own centre — the patch's middle, or the point a plane
  // was constructed through — whatever the box was read from.
  const centre = onSheet(fit.center)
  const r2 = (p: [number, number]): [number, number] => [roundTo(p[0], 2) + 0, roundTo(p[1], 2) + 0]
  return {
    name: el.name,
    centre: r2(centre),
    box: [r2(lo), r2(hi)],
    from: scan ? 'scan' : el.source.type === 'constructed' ? 'drawn' : 'patch',
    reach: Math.max(ELEMENT_REACH_MIN_MM, Math.hypot(hi[0] - lo[0], hi[1] - lo[1]) / 2),
  }
}

/** An element on a sheet as an answer gives it. */
export const elementOut = (e: ElementOnSheet): Json => ({ name: e.name, centre: e.centre, box: e.box, from: e.from })

/** A number as a sentence writes it, with a true minus sign. */
const said = (v: number, places: number) => (v < 0 ? '−' : '') + Math.abs(v).toFixed(places)

/** Pieces drawn away from the plane element their sketch is on: their
 *  box's centre further from the element's than the element reaches, and
 *  the box not round the element's centre — a sketch drawn about [0, 0]
 *  in the belief that zero is the element's middle. Null when they lie on
 *  it, or there are none. */
export function farFromElement(e: ElementOnSheet, f: SketchFeature): string | null {
  const drawn = f.sketch.entities.filter((x) => !(x as { construction?: boolean }).construction)
  const b = sketchBounds({ entities: drawn.length > 0 ? drawn : f.sketch.entities })
  if (!b) return null
  const mid = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2]
  const off = Math.hypot(mid[0] - e.centre[0], mid[1] - e.centre[1])
  const round = e.centre[0] >= b.min[0] && e.centre[0] <= b.max[0] && e.centre[1] >= b.min[1] && e.centre[1] <= b.max[1]
  if (off <= e.reach || round) return null
  return `drawn ${said(off, 1)} mm from ${e.name}’s centre ([${said(e.centre[0], 2)}, ${said(e.centre[1], 2)}]); [0, 0] is the world origin’s foot, not the element’s centre — draw about element.centre (reverse.plane.describe gives the frame).`
}

/** What a sketch's answer says of the plane element it is on: where the
 *  element lies on its sheet (element) and, when the pieces lie away from
 *  it, farFromElement. Nothing for a sketch on another kind of plane. */
export async function elementAnswer(f: Feature | undefined): Promise<Json> {
  if (f?.kind !== 'sketch') return {}
  const e = await elementOnSheet(f.plane, f.frame)
  if (!e) return {}
  const far = farFromElement(e, f)
  return { element: elementOut(e), ...(far ? { farFromElement: far } : {}) }
}

export const toDeg = (rad: number) => (rad * 180) / Math.PI

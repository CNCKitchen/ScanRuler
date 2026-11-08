// SPDX-License-Identifier: AGPL-3.0-only
// The scan read through sections for a sketch: a slice fitted into lines and
// arcs or read as regular teeth, the candidate shapes a slice suggests, a
// stack of slices summarised, and a plane described.

import { invalid } from '../../../src/commands/core/common'
import { findSection } from '../../../src/commands/core/section'
import { commandHost } from '../../../src/commands/host'
import { anyObject, arr, bool, enumOf, int, num, obj, oneOf, str, validate, vec3 } from '../../../src/commands/schema'
import { errorMessage } from '../../../src/commands/types'
import { fitCircle2d } from '../../../src/core/fit/circle2d'
import { EDGE_MIN_FEATURE_MM } from '../../../src/core/flat/edges'
import { viewChain } from '../../../src/core/flat/grow'
import type { Vec2 } from '../../../src/core/flat/types'
import { round4, roundTo } from '../../../src/core/round'
import { pointOnSheet, type SectionFrame, sketchFrameOn } from '../../../src/core/section/frame'
import { projectCut } from '../../../src/core/section/slice'
import type { Vec3 } from '../../../src/core/types'
import { dot, normalize, sub } from '../../../src/core/vec'
import { type Command, CommandError, type SheetPlanes } from '../../../src/plugins/api'
import { useStore } from '../../../src/state/store'
import { type DatumTrace, datumTraces } from '../core/datums'
import { boxMissed, bridgedOf, chainsSpan, filterChains, type JoinedChain, joinChainEnds, outlineOf, pickChain, runsKept, sideOf, unjoined, withinOnSheet } from '../core/chainOutline'
import { type Feature, type PlaneRef, type SketchFeature } from '../core/features'
import { describePlaneRef, resolveAxis, resolvePlaneFrame } from '../core/resolve'
import { candidatesOf, DEFAULT_LIMIT as CANDIDATE_LIMIT, DEFAULT_NET, type IntentNet, readPieces } from '../core/intent'
import { arcsOfChain, chainsOfEdges, placeSegments, segmentChain } from '../core/segment'
import { emptySketch, entityOf } from '../core/sketch'
import { routePieces } from '../core/sweepRoute'
import { readTeeth, type TeethRead } from '../core/teeth'
import { traceTube, type TubeStation } from '../core/tubeTrace'
import { elementOnSheet, elementOut, toDeg } from './reCommandAnswers'
import { featureNamed, type Json, planeInput, planeOf, ready, type Ref, sketchNamed } from './reCommandCore'
import { facingIn, featureRef, planeIn, skinIn, withinIn } from './reSchemas'
import { type ReverseSession, reverseSession } from './reSession'
import { chainsOn, cutSpanWords, sectionCut, sidedOf, sidedOn, sideRuleOf, withinOf } from './reSketchInput'
import { throughBand, type ThroughIn, throughOn } from './reThrough'

/** The pieces of a segmented chain as the answer gives them — placed into
 *  a sketch of their own, as the fit places them, and read back. */
/** How wide reverse.section.fit and reverse.sketch.candidates cast their
 *  net, as the input gives it; the defaults where it does not. */
const netOf = (n?: { angleDeg?: number; mm?: number }): IntentNet => ({ angleDeg: n?.angleDeg ?? DEFAULT_NET.angleDeg, mm: n?.mm ?? DEFAULT_NET.mm })

const netIn = obj(
  {
    angleDeg: num(`Degrees off parallel, square, level, upright or a round angle still offered; ${DEFAULT_NET.angleDeg} by default.`, { exclusiveMinimum: 0, maximum: 45 }),
    mm: num(`mm off collinear, concentric, tangent, equal, on a datum or mirrored still offered; ${DEFAULT_NET.mm} by default.`, { exclusiveMinimum: 0 }),
  },
  [],
  'How wide the net is cast for candidates — reporting thresholds, not decisions.',
)

/** The pieces a chain was cut into, as reverse.section.fit lists them —
 *  each with its evidence (core/intent.ts) — and, when asked, the
 *  relations they nearly have. The pieces take ids from 1 within the
 *  chain, which the candidates name. */
function piecesOut(cut: ReturnType<typeof segmentChain>, frame: SectionFrame, intent?: { net: IntentNet; datums: DatumTrace[]; limit?: number }) {
  const sk = emptySketch()
  const placed = placeSegments(sk, cut)
  const lift = (p: Vec2): Vec3 => [0, 1, 2].map((k) => round4(frame.origin[k] + p[0] * frame.basisU[k] + p[1] * frame.basisV[k])) as Vec3
  const v2 = (p: Vec2): Vec2 => [round4(p[0]), round4(p[1])]
  const readings = new Map(readPieces(sk.entities).map((r) => [r.id, r]))
  const pieces = placed.flatMap((o, i): Json[] => {
    const e = entityOf(sk, o.id)
    const points = cut.segments[i]?.points.length ?? 0
    const read = readings.get(o.id)
    const evidence = read ? { residual: read.residual, sigma: read.sigma, nominal: read.nominal } : {}
    if (e?.kind === 'line') {
      const angle = ((toDeg(Math.atan2(e.b[1] - e.a[1], e.b[0] - e.a[0])) % 180) + 180) % 180
      const lean = Math.min(angle % 90, 90 - (angle % 90))
      return [{ id: o.id, kind: 'line', a: v2(e.a), b: v2(e.b), length: round4(Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1])), angleDeg: round4(angle), leanDeg: round4(lean), points, ...evidence, world: { a: lift(e.a), b: lift(e.b) } }]
    }
    if (e?.kind === 'arc') {
      const at = (t: number): Vec2 => [e.c[0] + e.r * Math.cos(t), e.c[1] + e.r * Math.sin(t)]
      return [{ id: o.id, kind: 'arc', center: v2(e.c), radius: round4(e.r), diameter: round4(2 * e.r), start: round4(e.start), sweep: round4(e.sweep), sweepDeg: round4(toDeg(e.sweep)), a: v2(at(e.start)), b: v2(at(e.start + e.sweep)), points, ...evidence, world: { center: lift(e.c), a: lift(at(e.start)), b: lift(at(e.start + e.sweep)) } }]
    }
    return []
  })
  return { pieces, candidates: intent ? candidatesOf(sk.entities, intent.datums, intent.net, [], intent.limit) : undefined }
}

/** What the evidence on a fitted piece and the candidates mean, for the
 *  descriptions of the commands that give them. */
const EVIDENCE =
  'Each piece carries residual, sigma and nominal (the round value beside the fitted one, with off and sigmas), and candidates are the relations the pieces come within the net of, each with off, sigma, sigmas and the constraint ready to add — evidence, not verdicts (the model-reference guide says how to read them).'

/** What the commands that read a cut's chains take to keep to one side of
 *  the material. */
interface SideIn {
  skin?: 'outer' | 'inner'
  facing?: { dir: Vec2; withinDeg?: number }
}

/** What the commands that read a cut's chains take to cut them down. */
interface ChainFilter {
  closeGaps?: number
  minLength?: number
  maxLength?: number
  closedOnly?: boolean
  maxChains?: number
}

const closeGapsIn = num('Join chain ends closer than this, mm, first (bridged says how many).', { exclusiveMinimum: 0 })
const filterIn = {
  closeGaps: closeGapsIn,
  minLength: num('Leave out chains shorter than this, mm.', { minimum: 0 }),
  maxLength: num('Leave out chains longer than this, mm (the part’s outline, to read what is inside it).', { exclusiveMinimum: 0 }),
  closedOnly: bool('Only closed chains.'),
  maxChains: int('At most this many chains — the longest kept.', { minimum: 1 }),
}

/** A cut's chains as the filters leave them: the ends joined across
 *  closeGaps first, then those `keep` keeps, then minLength, maxLength,
 *  closedOnly and maxChains — and what to say of it: the gaps bridged, and how many each
 *  filter left out (leftOut, by the filter's name). */
function chainsKept(all: Vec2[][], f: ChainFilter, keep?: (c: Vec2[]) => boolean): { chains: JoinedChain[]; said: Json } {
  const joined = f.closeGaps ? joinChainEnds(all, f.closeGaps) : unjoined(all)
  const boxed = keep ? joined.filter((j) => keep(j.chain)) : joined
  const { kept, left } = filterChains(
    boxed.map((j) => j.chain),
    f,
  )
  const bridged = bridgedOf(joined)
  const leftOut = { ...(left.short ? { minLength: left.short } : {}), ...(left.long ? { maxLength: left.long } : {}), ...(left.open ? { closedOnly: left.open } : {}), ...(left.beyond ? { maxChains: left.beyond } : {}) }
  return { chains: kept.map((i) => boxed[i]), said: { ...(bridged.gaps > 0 ? { bridged: { gaps: bridged.gaps, largest: round4(bridged.largest) } } : {}), ...(Object.keys(leftOut).length > 0 ? { leftOut } : {}) } }
}

/** A chain's name in an answer: its index in the cut — the lowest of those
 *  it was joined from — and, when joined, which. */
const chainName = (j: JoinedChain) => ({ index: j.from[0], ...(j.from.length > 1 ? { joined: j.from } : {}) })

/** A fitted piece as section.fit's brief answer gives it: its kind, where
 *  it runs in the world, an arc's radius, and how its points sit on it. */
function briefPiece(p: Json): Json {
  const rms = (p.residual as { rms: number } | null | undefined)?.rms
  return { id: p.id, kind: p.kind, ...(p.kind === 'arc' ? { radius: p.radius } : {}), world: p.world, ...(rms !== undefined ? { rms } : {}) }
}

/** How many chains section.fit fits when none are named and maxChains is
 *  not given — the longest. */
const FIT_MAX_CHAINS = 12

/** How a sketch on a section counts against the section's sheet: the
 *  sketch rule puts its zero at the world origin's foot on the plane and
 *  its u along the coordinate axis next round, the section's sheet at the
 *  part's centre — so the same point reads differently. Where the axes
 *  agree (every section square to a coordinate axis) the sketch's [u, v]
 *  is the sheet's plus `add`; elsewhere its frame. */
function sketchCounting(sec: { id: number; frame: SectionFrame }) {
  const s = reverseSession()
  const frame = s ? resolvePlaneFrame({ kind: 'section', id: sec.id }, s.resolveContext()) : null
  if (!frame) return undefined
  const d = sub(sec.frame.origin, frame.origin)
  if (dot(frame.basisU, sec.frame.basisU) > 1 - 1e-9 && dot(frame.basisV, sec.frame.basisV) > 1 - 1e-9) return { add: [roundTo(dot(d, frame.basisU), 6), roundTo(dot(d, frame.basisV), 6)] }
  return { origin: frame.origin, basisU: frame.basisU, basisV: frame.basisV }
}

/** A plane field of these commands: a coordinate plane by name, or a
 *  plane object as a sketch takes it — checked against planeIn when the
 *  command runs. */
export const planeField = (description: string) => oneOf([str('A coordinate plane by name: "XY", "YZ" or "XZ" ("ZX" too).', { minLength: 2 }), anyObject(description)])

/** A chain read as regular teeth (core/teeth.ts), as section.fit's
 *  periodic answer gives it: on the section's sheet, in the world, and the
 *  profile as a polyline for a sketch — in `sketch`'s own [u, v] when one
 *  is given, in the world otherwise. */
function periodicOut(t: TeethRead, frame: SectionFrame, sketch?: SectionFrame): Json {
  const lift = (p: Vec2): Vec3 => [0, 1, 2].map((k) => round4(frame.origin[k] + p[0] * frame.basisU[k] + p[1] * frame.basisV[k])) as Vec3
  const v2 = (p: Vec2): Vec2 => [round4(p[0]), round4(p[1])]
  const envelope = (e: TeethRead['crests']): Json =>
    e.kind === 'arc'
      ? { kind: 'arc', center: v2(e.center), radius: round4(e.radius), ...(Number.isFinite(e.radiusSigma) ? { radiusSigma: round4(e.radiusSigma) } : {}), rms: round4(e.rms), worst: round4(e.worst), corners: e.corners.length, world: { center: lift(e.center) } }
      : { kind: 'line', point: v2(e.point), angleDeg: round4(((toDeg(Math.atan2(e.dir[1], e.dir[0])) % 180) + 180) % 180), rms: round4(e.rms), worst: round4(e.worst), corners: e.corners.length, world: { point: lift(e.point) } }
  const world = t.profile.map(lift)
  // The profile in the sketch's frame, taken square onto its plane.
  let shape: Json
  let off = 0
  if (sketch) {
    const points = t.profile.map((p) => {
      const d = sub(lift(p), sketch.origin)
      off = Math.max(off, Math.abs(dot(d, sketch.normal)))
      return [round4(dot(d, sketch.basisU)) + 0, round4(dot(d, sketch.basisV)) + 0]
    })
    shape = { kind: 'polyline', closed: false, points }
  } else shape = { kind: 'polyline', closed: false, world: true, points: world }
  const notes: string[] = []
  if (t.spread > IRREGULAR_SHARE * t.pitch) notes.push(`the corners stray ${roundTo((100 * t.spread) / t.pitch, 1)} % of the pitch off a regular comb — more than one band of teeth, or teeth that are not regular; give within round one band`)
  if (off > OFF_SKETCH_MM) notes.push(`the profile lies up to ${round4(off)} mm off the sketch’s plane — taken square onto it; cut the section on the sketch’s plane to read it there`)
  return {
    teeth: t.kinds.filter((k) => k === 'crest').length,
    pitch: round4(t.pitch),
    along: t.along,
    spread: round4(t.spread),
    riser: round4(t.riser),
    facet: round4(t.facet),
    crestToTrough: round4(t.crestToTrough),
    depth: { mean: round4(t.depth.mean), min: round4(t.depth.min), max: round4(t.depth.max) },
    crestsBy: t.crestsBy,
    crests: envelope(t.crests),
    troughs: envelope(t.troughs),
    first: { kind: t.kinds[0], at: v2(t.profile[0]), s: round4(t.start) },
    profile: { count: t.profile.length, sheet: t.profile.map(v2), ...(sketch ? { world } : {}) },
    shape,
    fit: { points: t.fit.points, rms: round4(t.fit.rms), worst: round4(t.fit.worst) },
    ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
  }
}

/** A cut's chains with each point's way out of the material, or null for
 *  a cut taken before cuts carried it. */
function sidedIfKnown(cut: Awaited<ReturnType<typeof sectionCut>>, frame: SectionFrame) {
  try {
    return sidedOf(cut, frame)
  } catch (e) {
    if (e instanceof CommandError) return null
    throw e
  }
}

/** Past this share of the pitch, the corners' spread off a regular comb is
 *  said; past this, the profile's distance off the sketch's plane. */
const IRREGULAR_SHARE = 0.05

const OFF_SKETCH_MM = 0.01

export const sectionFit: Command<{ section: Ref; chains?: number[]; detail?: number; tolerance?: number; candidates?: boolean; brief?: boolean; net?: { angleDeg?: number; mm?: number }; limit?: number; arcs?: number; within?: unknown; through?: ThroughIn; periodic?: boolean; plane?: Json | string } & SideIn & ChainFilter> = {
  name: 'fit',
  title: 'Fit lines and arcs to a section',
  description:
    'A section’s chains cut into the lines and arcs they are, as Fit all chains cuts them for a sketch, without making one: per chain its pieces in order — a line by its ends, length, angleDeg (from the sheet’s +u) and leanDeg (off the nearest sheet axis), an arc by centre, radius, start and sweep (radians counter-clockwise from +u) — each also in world [x, y, z], with whether the chain closes, its points, scatter and tolerance. ' +
    EVIDENCE +
    ' [u, v] are the section’s sheet, from the part’s centre; a sketch on the section counts from the world origin’s foot: its [u, v] is the sheet’s plus sketch.add. Without chains the longest are fitted (maxChains); the filters, within, skin and facing choose and trim them (each run a chain of its own); arcs: n fits each chain as n arcs; brief: true gives each piece short; periodic: true reads regular teeth. The same pieces as a sketch: reverse.feature.add { kind: "sketch", plane: { kind: "section", id }, sketch: { fit: {} } }. Changes nothing.',
  input: obj(
    {
      section: oneOf([int('The section’s id.', { minimum: 1 }), str('The section’s name.', { minLength: 1 })], 'The section, by id or name.'),
      chains: arr(int('A chain’s index.', { minimum: 0 }), 'Which chains, whatever the filters say; every one when left out, up to maxChains.', { minItems: 1 }),
      detail: num('0 to 1; 0.5 by default.', { minimum: 0, maximum: 1 }),
      tolerance: num('mm', { exclusiveMinimum: 0 }),
      candidates: bool('Give each chain’s candidates — the relations its pieces nearly have (the default true).'),
      brief: bool('Each piece as its kind, world ends, radius and rms alone, and no candidates.'),
      net: netIn,
      limit: int(`How many candidates per chain at most; ${CANDIDATE_LIMIT} by default.`, { minimum: 1 }),
      arcs: int('Each chain as this many arcs end to end, in place of the cut.', { minimum: 1, maximum: 8 }),
      within: withinIn('Only what of each chain lies in this box: min and max [u, v] mm on the section’s sheet (from the part’s centre, not a sketch’s [u, v]), or world: { min, max } in mm.'),
      through: oneOf(
        [bool('true: seen through ±1.5 mm about the section’s plane.'), obj({ depth: arr(num(), '[from, to], mm along the section’s normal from its plane.', { minItems: 2, maxItems: 2 }) }, ['depth'])],
        'A thin sheet seen through, square onto the section, in place of its cut — the sheet’s edge and every hole in it traced where rays meet the scan within depth, each a closed chain (hole says which), as a sketch’s fit.through reads it; skin and facing are refused. through in the answer gives depth, cell, loops, holes and skipped.',
      ),
      skin: skinIn,
      facing: facingIn,
      ...filterIn,
      maxChains: int(`At most this many chains, the longest kept, when chains is left out; ${FIT_MAX_CHAINS} by default.`, { minimum: 1 }),
      periodic: bool('Read each chain as regular teeth (pitch, crests, troughs, the profile as a polyline) in place of lines and arcs.'),
      plane: planeField('With periodic: the plane of the sketch the profile is for, as a sketch takes it — shape then comes in that sketch’s [u, v]; in the world (world: true) otherwise.'),
    },
    ['section'],
  ),
  readOnly: true,
  run: async ({ section, chains: which, detail, tolerance, candidates = true, brief = false, net, limit, arcs, within, through, skin, facing, closeGaps, minLength, maxLength, closedOnly, maxChains = FIT_MAX_CHAINS, periodic = false, plane }) => {
    if (periodic && arcs !== undefined) invalid('periodic reads the chain as teeth, arcs as arcs end to end — give one of them.')
    if (plane !== undefined && !periodic) invalid('plane names the sketch periodic gives its profile for — give periodic: true, or leave plane out.')
    const sec = findSection(section)
    // The sketch the teeth's profile is given in.
    let sketch: SectionFrame | undefined
    if (plane !== undefined) {
      const errors = validate(planeIn, plane, 'input.plane')
      if (errors.length > 0) invalid(errors.join('; '))
      const s = await ready()
      const ref = planeOf(s, plane)
      const f = ref.kind === 'bodyFace' || ref.kind === 'fitted' ? ref.frame : resolvePlaneFrame(ref, s.resolveContext())
      if (!f) throw new CommandError('not_found', 'That plane is not there any more.')
      sketch = f
    }
    const rule = sideRuleOf(skin, facing)
    // Seen through, the sheet's loops stand for the cut.
    const seeing = through !== undefined && through !== false
    if (seeing && rule) invalid('through sees the sheet square on, with no side to it — leave skin and facing out.')
    const seen = seeing ? await throughOn(sec.frame, throughBand(through, undefined, 'through'), { tolerance, within: withinOf(within, 'within'), where: 'through' }) : null
    const cut = seen ? null : await sectionCut(sec.id)
    // Teeth are told crest from trough by the material, where the cut says
    // which side it is on.
    const sided = !cut ? null : rule ? sidedOf(cut, sec.frame) : periodic ? sidedIfKnown(cut, sec.frame) : null
    const side = rule && sided ? sideOf(sided, rule) : undefined
    const outward = periodic && sided ? new Map(sided.chains.flatMap((c, k) => c.map((p, i): [Vec2, Vec2] => [p, sided.normals[k][i]]))) : undefined
    const all = seen ? seen.chains : sided ? sided.chains : chainsOfEdges(projectCut(cut!, sec.frame))
    for (const c of which ?? []) if (!all[c]) throw new CommandError('not_found', `${sec.name} has no chain ${c} — it has ${all.length}${all.length > 0 ? ` (0 to ${all.length - 1})` : ''}.`)
    // Chains named are fitted whatever the filters say.
    const kept = which ? chainsKept(all, { closeGaps }) : chainsKept(all, { closeGaps, minLength, maxLength, closedOnly, maxChains })
    const picked = which ? [...new Set(which.map((c) => pickChain(kept.chains, c)))].map((i) => kept.chains[i]) : kept.chains
    const fitOne = (j: JoinedChain, chain: readonly Vec2[], run?: number) => {
      const which = { ...chainName(j), ...(seen ? { hole: seen.holes[j.from[0]] } : {}), ...(run !== undefined ? { run } : {}) }
      if (periodic) {
        try {
          return { ...which, points: chain.length, periodic: periodicOut(readTeeth(chain, { outward: outward && chain.map((p) => outward.get(p)) }), sec.frame, sketch) }
        } catch (e) {
          return { ...which, points: chain.length, error: errorMessage(e) }
        }
      }
      try {
        const opts = { ...(detail !== undefined ? { detail } : {}), ...(tolerance !== undefined ? { tolerance } : {}) }
        const seg = arcs ? arcsOfChain(chain, arcs, opts) : segmentChain(chain, opts)
        const fitted = piecesOut(seg, sec.frame, candidates && !brief ? { net: netOf(net), datums: datumTraces(sec.frame), limit } : undefined)
        const pieces = brief ? fitted.pieces.map(briefPiece) : fitted.pieces
        return { ...which, closed: seg.closed, points: seg.points.length, scatter: round4(seg.scatter), spacing: round4(seg.spacing), tolerance: round4(seg.tolerance), pieces, ...(fitted.candidates ? { candidates: fitted.candidates } : {}) }
      } catch (e) {
        return { ...which, points: chain.length, error: errorMessage(e) }
      }
    }
    // The box on the section's sheet, a world box converted to it.
    const box = withinOf(within, 'within', () => cutSpanWords(all))
    const boxed = box ? withinOnSheet(box, sec.frame) : {}
    if (box && picked.every((j) => runsKept(j.chain, boxed).length === 0)) throw new CommandError('not_found', `within: ${boxMissed(box, picked.map((j) => j.chain), sec.frame, `${sec.name}’s sheet (counted from the part’s centre)`)}`)
    const out = picked.flatMap((j) => (box || side ? runsKept(j.chain, { ...boxed, side }).map((r, k) => fitOne(j, r, k)) : [fitOne(j, j.chain)]))
    const span = chainsSpan(all)
    const bounds = span ? { min: span.min.map(round4), max: span.max.map(round4) } : null
    return { section: { id: sec.id, name: sec.name }, plane: { origin: sec.frame.origin, normal: sec.frame.normal, basisU: sec.frame.basisU, basisV: sec.frame.basisV }, sketch: sketchCounting(sec), bounds, chains: out, ...kept.said, ...(seen ? { through: seen.through } : {}) }
  },
}

export const sketchCandidates: Command<{ sketch: Ref; net?: { angleDeg?: number; mm?: number }; limit?: number; pieces?: number[] }> = {
  name: 'candidates',
  title: 'What a sketch’s pieces nearly are',
  description:
    'A sketch’s pieces read for the design behind them: for each line, arc and circle its evidence, and the relations the pieces come within the net of that the sketch does not hold yet — what to add with reverse.sketch.edit { add: { constraints } }, each candidate’s constraints copied as they stand; that edit’s answer says what the relation cost (solve.fit and moved). Relations the sketch already holds are left out, as are the pairs an axis relation on both pieces already says. ' +
    EVIDENCE +
    ' Changes nothing.',
  input: obj(
    {
      sketch: featureRef('sketch'),
      net: netIn,
      limit: int(`How many candidates at most; ${CANDIDATE_LIMIT} by default.`, { minimum: 1 }),
      pieces: arr(int('A piece’s id.'), 'Only these pieces; every one by default.', { minItems: 1 }),
    },
    ['sketch'],
  ),
  readOnly: true,
  run: async ({ sketch, net, limit, pieces }) => {
    const f = sketchNamed(sketch)
    const picked = pieces
      ? pieces.map((id) => {
          const e = entityOf(f.sketch, id)
          if (!e) throw new CommandError('not_found', `${f.name} has no piece ${id}.`)
          return e
        })
      : f.sketch.entities
    const n = netOf(net)
    return { sketch: { id: f.id, name: f.name }, net: n, pieces: readPieces(picked), candidates: candidatesOf(picked, datumTraces(f.frame), n, f.sketch.constraints, limit ?? CANDIDATE_LIMIT) }
  },
}

/** How many heights a stack takes at most. */
const STACK_MAX = 60

/** How far a chain's centre may move from one height to the next and still
 *  be the same feature, as a share of the chain's size, and at least. */
const TRACK_SHARE = 0.5

const TRACK_MIN_MM = 1

/** How much a chain's size may change from one height to the next and
 *  still be the same feature — each side of its box, and its area's square
 *  root (a length too), as a share of the larger of the two — and the
 *  change that counts as none however small the chain. */
const TRACK_SIZE_SHARE = 0.3

const TRACK_SIZE_MM = 0.2

/** Whether `next` can carry on the track `last` ends: both closed or both
 *  open, and of about one size — near centres alone join a dimple to the
 *  open wall above it, or a boss to the plate it stands on. */
export function continuesTrack(last: Pick<StackChain, 'closed' | 'size' | 'area'>, next: Pick<StackChain, 'closed' | 'size' | 'area'>): boolean {
  if (last.closed !== next.closed) return false
  const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(TRACK_SIZE_SHARE * Math.max(a, b), TRACK_SIZE_MM)
  if (!near(last.size[0], next.size[0]) || !near(last.size[1], next.size[1])) return false
  return last.area === null || next.area === null || near(Math.sqrt(last.area), Math.sqrt(next.area))
}

/** A closed chain is a circle when the circle fitted to it sits on its
 *  points within this many times the chain's own noise (its scatter) as an
 *  rms, or within this share of the radius where that is more — a large
 *  hole's scan waves more than its point-to-point noise says — and its
 *  worst point within three times that. */
const CIRCLE_NOISE = 2

const CIRCLE_SHARE = 0.004

interface StackChain {
  index: number
  run?: number
  joined?: number[]
  closed: boolean
  points: number
  centroid: Vec2
  world: Vec3
  area: number | null
  bounds: { min: Vec2; max: Vec2 }
  size: Vec2
  circle?: { center: Vec2; radius: number; rms: number }
  fromAxis?: { mm: number; towardDeg: number }
  pieces?: Json[]
}

/** How far a chain's centre — its circle's, else its centroid — lies from
 *  where an axis crosses the cut's plane, mm, and which way on the sheet
 *  (degrees from +u towards +v, 0 to 360). An axis that runs along the
 *  plane crosses it nowhere: the distance is then to the line itself. */
export function offAxis(chain: Pick<StackChain, 'centroid' | 'circle'>, frame: SectionFrame, axis: { origin: Vec3; dir: Vec3 }): { mm: number; towardDeg: number } {
  const c = chain.circle?.center ?? chain.centroid
  const at: Vec3 = [0, 1, 2].map((k) => frame.origin[k] + c[0] * frame.basisU[k] + c[1] * frame.basisV[k]) as Vec3
  const across = dot(axis.dir, frame.normal)
  let foot: Vec3
  if (Math.abs(across) > 1e-9) {
    const t = dot(sub(frame.origin, axis.origin), frame.normal) / across
    foot = [0, 1, 2].map((k) => axis.origin[k] + t * axis.dir[k]) as Vec3
  } else {
    const t = dot(sub(at, axis.origin), axis.dir) / dot(axis.dir, axis.dir)
    foot = [0, 1, 2].map((k) => axis.origin[k] + t * axis.dir[k]) as Vec3
  }
  const d = sub(at, foot)
  const du = dot(d, frame.basisU)
  const dv = dot(d, frame.basisV)
  return { mm: round4(Math.hypot(...d)), towardDeg: roundTo(((Math.atan2(dv, du) * 180) / Math.PI + 360) % 360, 1) }
}

/** The least-squares line y = a + b·x through points, and its rms. */
function lineThrough(xs: readonly number[], ys: readonly number[]): { slope: number; at0: number; rms: number } {
  const n = xs.length
  let sx = 0, sy = 0, sxx = 0, sxy = 0
  for (let i = 0; i < n; i++) {
    sx += xs[i]
    sy += ys[i]
    sxx += xs[i] * xs[i]
    sxy += xs[i] * ys[i]
  }
  const denom = n * sxx - sx * sx
  const slope = Math.abs(denom) > 1e-12 ? (n * sxy - sx * sy) / denom : 0
  const at0 = (sy - slope * sx) / n
  let ss = 0
  for (let i = 0; i < n; i++) ss += (ys[i] - (at0 + slope * xs[i])) ** 2
  return { slope, at0, rms: Math.sqrt(ss / n) }
}

/** A chain of a cut summed up: whether it closes, its centre, its area,
 *  its box, and whether it is a circle (CIRCLE_NOISE). */
export function summarizeChain(chain: readonly Vec2[], index: number, lift: (p: Vec2) => Vec3): StackChain {
  const n = chain.length
  const first = chain[0], last = chain[n - 1]
  const closed = n > 2 && Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-9
  const pts = closed ? chain.slice(0, n - 1) : chain
  const lo: Vec2 = [Infinity, Infinity], hi: Vec2 = [-Infinity, -Infinity]
  let cu = 0, cv = 0
  for (const p of pts) {
    cu += p[0] / pts.length
    cv += p[1] / pts.length
    if (p[0] < lo[0]) lo[0] = p[0]
    if (p[1] < lo[1]) lo[1] = p[1]
    if (p[0] > hi[0]) hi[0] = p[0]
    if (p[1] > hi[1]) hi[1] = p[1]
  }
  let area: number | null = null
  let centroid: Vec2 = [cu, cv]
  if (closed && pts.length >= 3) {
    let a2 = 0, au = 0, av = 0
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length]
      const w = p[0] * q[1] - q[0] * p[1]
      a2 += w
      au += (p[0] + q[0]) * w
      av += (p[1] + q[1]) * w
    }
    area = Math.abs(a2) / 2
    if (Math.abs(a2) > 1e-9) centroid = [au / (3 * a2), av / (3 * a2)]
  }
  let circle: StackChain['circle']
  if (closed && pts.length >= 8) {
    const c = fitCircle2d(
      pts.map((p) => p[0]),
      pts.map((p) => p[1]),
    )
    if (c && Number.isFinite(c.r) && c.r > 0) {
      let ss = 0, worst = 0
      for (const p of pts) {
        const d = Math.abs(Math.hypot(p[0] - c.cu, p[1] - c.cv) - c.r)
        ss += d * d
        worst = Math.max(worst, d)
      }
      const rms = Math.sqrt(ss / pts.length)
      const allowed = Math.max(CIRCLE_NOISE * viewChain(chain).scatter, CIRCLE_SHARE * c.r)
      if (rms <= allowed && worst <= 3 * allowed) circle = { center: [round4(c.cu), round4(c.cv)], radius: round4(c.r), rms: round4(rms) }
    }
  }
  return {
    index,
    closed,
    points: n,
    centroid: [round4(centroid[0]), round4(centroid[1])],
    world: lift(centroid),
    area: area === null ? null : round4(area),
    bounds: { min: [round4(lo[0]), round4(lo[1])], max: [round4(hi[0]), round4(hi[1])] },
    size: [round4(hi[0] - lo[0]), round4(hi[1] - lo[1])],
    ...(circle ? { circle } : {}),
  }
}

/** A stack's box as given — min and max, or world: { min, max }, both in
 *  the world. */
function stackBox(w: { min?: Vec3; max?: Vec3; world?: { min: Vec3; max: Vec3 } }): { min: Vec3; max: Vec3 } {
  if (w.world && (w.min || w.max)) invalid('within: give min and max, or world: { min, max } — the same box in the world — not both.')
  const box = w.world ?? (w.min && w.max ? { min: w.min, max: w.max } : null)
  if (!box) invalid('within: give min and max, [x, y, z] mm in the world (or world: { min, max }).')
  return box!
}

/** A plane as given, at an offset in place of its own: a coordinate plane
 *  at that coordinate, any other moved that far along its normal. */
export function planeAtOffset(s: ReverseSession, given: Json | string, offset: number): PlaneRef {
  const p = planeInput(given)
  if (p.kind === 'world') return { kind: 'world', axis: p.axis as 'x' | 'y' | 'z', offset }
  return planeOf(s, { ...p, offset })
}

/** A direction in words: the coordinate axis it is, or the one it mostly
 *  runs along, with its components. */
function axisWords(v: Vec3): string {
  const names = ['X', 'Y', 'Z']
  const i = [0, 1, 2].reduce((a, b) => (Math.abs(v[b]) > Math.abs(v[a]) ? b : a), 0)
  const name = `${v[i] < 0 ? '−' : '+'}${names[i]}`
  if (Math.abs(Math.abs(v[i]) - 1) < 1e-9) return name
  const off = (Math.acos(Math.min(1, Math.abs(v[i]))) * 180) / Math.PI
  return `mostly ${name}, ${Math.round(off * 10) / 10}° off it (${v.map((c) => round4(c)).join(', ')})`
}

export const planeDescribe: Command<{ plane: Json | string; point?: Vec3 }> = {
  name: 'describe',
  title: 'Describe a plane',
  description:
    'The frame a sketch on a plane takes, before any sketch is made on it: origin (where [0, 0] of the sketch lies), normal (the way an extrude goes, To in front) and basisU, basisV — world = origin + u·basisU + v·basisV, and back u = (p − origin)·basisU, v = (p − origin)·basisV — with the same in words. Any plane reverse.feature.add takes for a sketch. A point given (world mm) comes back as point: { at, above } — its [u, v] in that sketch frame (not always a section’s own sheet) and how far it lies off the plane along the normal. On a measured plane, element says where the element lies on that sheet (name, centre, box), since [0, 0] is the world origin’s foot, not the element’s centre. Changes nothing.',
  input: obj(
    {
      plane: planeField('The plane as a sketch takes it: { kind: "world" | "section" | "plane" | "bodyFace" | "radial", …, offset?, up? } — reverse.feature.schema { kind: "sketch" } gives the shape.'),
      point: vec3('A point in the world, mm, to have in the sketch’s [u, v].'),
    },
    ['plane'],
  ),
  readOnly: true,
  // A frame read here is computed from: a sketch laid on its numbers must
  // lie on the plane itself.
  exact: true,
  run: async ({ plane, point }) => {
    const errors = validate(planeIn, plane, 'input.plane')
    if (errors.length > 0) invalid(errors.join('; '))
    const s = await ready()
    const ref = planeOf(s, plane)
    const frame = ref.kind === 'bodyFace' || ref.kind === 'fitted' ? ref.frame : resolvePlaneFrame(ref, s.resolveContext())
    if (!frame) throw new CommandError('not_found', 'That plane is not there any more.')
    const r = (v: Vec3): Vec3 => v.map((c) => round4(c) + 0) as Vec3
    const store = useStore.getState()
    const element = await elementOnSheet(ref, frame)
    return {
      plane: describePlaneRef(ref, { sections: store.sections, elements: store.elements }),
      origin: r(frame.origin),
      normal: r(frame.normal),
      basisU: r(frame.basisU),
      basisV: r(frame.basisV),
      words: `u runs ${axisWords(frame.basisU)}; v runs ${axisWords(frame.basisV)}; the normal points ${axisWords(frame.normal)}. [0, 0] lies at (${r(frame.origin).join(', ')})${element ? ` — the world origin’s foot; ${element.name}’s centre is at [${element.centre.join(', ')}]` : ''}.`,
      ...(element ? { element: elementOut(element) } : {}),
      // The point on the sheet to twelve digits: what a piece is drawn at,
      // without the float's tail.
      ...(point ? { point: { at: [dot(sub(point, frame.origin), frame.basisU), dot(sub(point, frame.origin), frame.basisV)].map((c) => +c.toPrecision(12) + 0), above: +dot(sub(point, frame.origin), frame.normal).toPrecision(12) + 0 } } : {}),
    }
  },
}

/** An axis the stack measures the chains' centres from, as a plane through
 *  an axis names it. */
const stackAxisIn = oneOf(
  [
    obj({ kind: enumOf(['element']), id: int('The element’s id.'), name: str('Or its name.', { minLength: 1 }) }, ['kind'], 'A line, cylinder, cone or circle element of 3D Measure, by id or name.'),
    obj({ kind: enumOf(['world']), axis: enumOf(['x', 'y', 'z']) }, ['kind', 'axis'], 'A coordinate axis through the origin.'),
  ],
  'An axis each chain’s centre is measured from, at every offset: fromAxis.',
)

export const sectionStack: Command<{ plane: Json | string; offsets: number[]; within?: { min?: Vec3; max?: Vec3; world?: { min: Vec3; max: Vec3 }; clip?: boolean }; detail?: number; tolerance?: number; pieces?: boolean; axis?: Json } & SideIn & ChainFilter> = {
  name: 'stack',
  title: 'Slice the scan at several heights',
  description:
    'The scan cut at several offsets of one plane in one call, each cut summed up and the cuts set side by side — how a pocket, a boss, a slot or a round is read: the same outline at every height, shifting (a tilted axis), growing (a draft) or rounding off. plane is a coordinate plane, a section’s, a measured plane or a flat face of a body (as a sketch takes it); offsets are the coordinate on a coordinate plane, else mm along its normal. Per offset: each chain’s closed, centre ([u, v] and world), area, box and size, circle (centre, radius, rms) and, with pieces: true, its lines and arcs as reverse.section.fit gives them; tracks follows each chain across the offsets by its centre and gives the trend — tiltDeg with the axis’s direction, draftDeg per side, taperDeg and, from four offsets, round (its rms against linearRms). within (with clip), skin, facing, closeGaps, minLength, maxLength, closedOnly and maxChains choose the chains (bridged and leftOut per offset); axis gives each chain and each track level fromAxis { mm, towardDeg }. [u, v] are the plane’s sheet, as section.get and a sketch on the plane use them. No section is kept and nothing changes.',
  input: obj(
    {
      plane: planeField('The plane as a sketch takes it ({ kind: "world" | "section" | "plane" | "bodyFace", … }); on a coordinate plane the offsets are the coordinate, else mm along its normal.'),
      offsets: arr(num('mm'), `The offsets, in any order; ${STACK_MAX} at most.`, { minItems: 1, maxItems: STACK_MAX }),
      within: obj({ min: vec3('The lowest corner, [x, y, z] mm.'), max: vec3('The highest corner, [x, y, z] mm.'), world: obj({ min: vec3('[x, y, z] mm.'), max: vec3('[x, y, z] mm.') }, ['min', 'max'], 'The same box, as world.'), clip: bool('Keep only what of each chain lies in the box, each run a chain of its own (run).') }, [], 'Only chains with any point in this box, [x, y, z] mm (min and max, or world: { min, max }), whole.'),
      skin: skinIn,
      facing: facingIn,
      ...filterIn,
      detail: num('0 to 1 for the pieces; 0.5 by default.', { minimum: 0, maximum: 1 }),
      tolerance: num('mm for the pieces, in place of the one read off each chain.', { exclusiveMinimum: 0 }),
      pieces: bool('Fit each chain’s lines and arcs too (off by default: the summaries alone).'),
      axis: stackAxisIn,
    },
    ['plane', 'offsets'],
  ),
  readOnly: true,
  run: async ({ plane, offsets, within, skin, facing, detail, tolerance, pieces = false, axis, closeGaps, minLength, maxLength, closedOnly, maxChains }) => {
    const rule = sideRuleOf(skin, facing)
    // The box is the world's, as min and max or as world.
    const worldBox = within ? stackBox(within) : undefined
    if (!useStore.getState().fileName) throw new CommandError('no_scan', 'There is no scan to slice.')
    const planeErrors = validate(planeIn, plane, 'input.plane')
    if (planeErrors.length > 0) invalid(planeErrors.join('; '))
    const s = await ready()
    const worker = commandHost().session.clientRef.current
    if (!worker) throw new CommandError('unavailable', 'The mesh worker is not running.')
    // The axis as a plane through it takes it: an element by id or name,
    // checked to have one, or a coordinate axis.
    let line: { origin: Vec3; dir: Vec3 } | null = null
    if (axis) {
      const through = planeOf(s, { kind: 'radial', axis, angleDeg: 0 })
      line = through.kind === 'radial' ? resolveAxis(through.axis, undefined, s.resolveContext()) : null
      if (!line) throw new CommandError('not_found', 'That axis is not there any more.')
    }
    const order = offsets.map((o, i) => ({ o, i })).sort((a, b) => a.o - b.o)
    const levels: { offset: number; origin: Vec3; chains: StackChain[]; said: Json }[] = []
    let plane0: { origin: Vec3; normal: Vec3; basisU: Vec3; basisV: Vec3 } | null = null
    for (const { o } of order) {
      const ref = planeAtOffset(s, plane, o)
      const frame = ref.kind === 'bodyFace' || ref.kind === 'fitted' ? ref.frame : resolvePlaneFrame(ref, s.resolveContext())
      if (!frame) throw new CommandError('not_found', 'That plane is not there any more.')
      if (!plane0) plane0 = { origin: frame.origin, normal: frame.normal, basisU: frame.basisU, basisV: frame.basisV }
      const cut = await worker.section(frame.origin, frame.normal, EDGE_MIN_FEATURE_MM)
      const lift = (p: Vec2): Vec3 => [0, 1, 2].map((k) => round4(frame.origin[k] + p[0] * frame.basisU[k] + p[1] * frame.basisV[k])) as Vec3
      const inside = worldBox ? withinOnSheet({ world: worldBox }, frame).where : undefined
      const inBox = inside ? (chain: Vec2[]) => chain.some(inside) : undefined
      const sided = rule ? sidedOf(cut, frame) : null
      const side = rule && sided ? sideOf(sided, rule) : undefined
      const kept = chainsKept(sided ? sided.chains : chainsOfEdges(projectCut(cut, frame)), { closeGaps, minLength, maxLength, closedOnly, maxChains }, inBox)
      // Each chain whole, or its runs in the box (clip) and on the side asked.
      const clip = within?.clip ? inside : undefined
      const runs = kept.chains.flatMap((j): { j: JoinedChain; chain: Vec2[]; run?: number }[] => (clip || side ? runsKept(j.chain, { side, where: clip }).map((chain, run) => ({ j, chain, run })) : [{ j, chain: j.chain, run: undefined }]))
      const chains: StackChain[] = []
      for (const { j, chain, run } of runs) {
        const summary: StackChain = { ...summarizeChain(chain, j.from[0], lift), ...(run !== undefined ? { run } : {}), ...(j.from.length > 1 ? { joined: j.from } : {}) }
        if (line) summary.fromAxis = offAxis(summary, frame, line)
        if (pieces) {
          try {
            summary.pieces = piecesOut(segmentChain(chain, { ...(detail !== undefined ? { detail } : {}), ...(tolerance !== undefined ? { tolerance } : {}) }), frame).pieces
          } catch (e) {
            summary.pieces = [{ error: errorMessage(e) }]
          }
        }
        chains.push(summary)
      }
      levels.push({ offset: o, origin: frame.origin, chains, said: kept.said })
    }
    // The chains followed from one offset to the next by their centres,
    // a chain that closes, opens or changes size starting a track of its own.
    interface Track { id: number; levels: { offset: number; chain: number; at: StackChain }[] }
    const tracks: Track[] = []
    for (const level of levels) {
      const open = tracks.filter((t) => t.levels[t.levels.length - 1].offset !== level.offset)
      const pairs: { d: number; track: Track; chain: StackChain }[] = []
      for (const chain of level.chains)
        for (const t of open) {
          const last = t.levels[t.levels.length - 1].at
          const d = Math.hypot(chain.centroid[0] - last.centroid[0], chain.centroid[1] - last.centroid[1])
          const reach = Math.max(TRACK_MIN_MM, TRACK_SHARE * Math.hypot(last.size[0], last.size[1]))
          if (d <= reach && continuesTrack(last, chain)) pairs.push({ d, track: t, chain })
        }
      pairs.sort((a, b) => a.d - b.d)
      const taken = new Set<Track>()
      const placed = new Set<StackChain>()
      for (const p of pairs) {
        if (taken.has(p.track) || placed.has(p.chain)) continue
        taken.add(p.track)
        placed.add(p.chain)
        p.track.levels.push({ offset: level.offset, chain: p.chain.index, at: p.chain })
      }
      for (const chain of level.chains) if (!placed.has(chain)) tracks.push({ id: tracks.length, levels: [{ offset: level.offset, chain: chain.index, at: chain }] })
    }
    const toDeg = (rad: number) => round4((rad * 180) / Math.PI)
    const trendOf = (t: Track) => {
      if (t.levels.length < 2) return null
      const h = t.levels.map((l) => l.offset)
      const cu = lineThrough(h, t.levels.map((l) => l.at.centroid[0]))
      const cv = lineThrough(h, t.levels.map((l) => l.at.centroid[1]))
      const w = lineThrough(h, t.levels.map((l) => l.at.size[0]))
      const hh = lineThrough(h, t.levels.map((l) => l.at.size[1]))
      const drift = Math.hypot(cu.slope, cv.slope)
      const axisDir = plane0 ? normalize([0, 1, 2].map((k) => plane0!.normal[k] + cu.slope * plane0!.basisU[k] + cv.slope * plane0!.basisV[k]) as Vec3) : null
      const circles = t.levels.every((l) => l.at.circle)
      const radius = circles ? lineThrough(h, t.levels.map((l) => l.at.circle!.radius)) : null
      const areas = t.levels.every((l) => l.at.area !== null) ? lineThrough(h, t.levels.map((l) => l.at.area!)) : null
      let round: { radius: number; center: Vec2; rms: number } | null = null
      if (t.levels.length >= 4) {
        const half = t.levels.map((l) => l.at.size[0] / 2)
        const c = fitCircle2d(h, half)
        if (c && Number.isFinite(c.r) && c.r > 0) {
          let ss = 0
          for (let i = 0; i < h.length; i++) ss += (Math.hypot(h[i] - c.cu, half[i] - c.cv) - c.r) ** 2
          round = { radius: round4(c.r), center: [round4(c.cu), round4(c.cv)], rms: round4(Math.sqrt(ss / h.length)) }
        }
      }
      return {
        levels: t.levels.length,
        centre: { perMm: [round4(cu.slope), round4(cv.slope)], tiltDeg: toDeg(Math.atan(drift)), ...(axisDir ? { axis: axisDir.map(round4) } : {}), rms: round4(Math.hypot(cu.rms, cv.rms)) },
        size: { perMm: [round4(w.slope), round4(hh.slope)], draftDeg: [toDeg(Math.atan(w.slope / 2)), toDeg(Math.atan(hh.slope / 2))], linearRms: [round4(w.rms), round4(hh.rms)] },
        ...(radius ? { radius: { perMm: round4(radius.slope), taperDeg: toDeg(Math.atan(radius.slope)), at0: round4(radius.at0), rms: round4(radius.rms) } } : {}),
        ...(areas ? { area: { perMm: round4(areas.slope) } } : {}),
        ...(round ? { round } : {}),
      }
    }
    return {
      plane: plane0,
      offsets: order.map((x) => x.o),
      levels: levels.map((l) => ({ offset: l.offset, origin: l.origin.map(round4), chains: l.chains, ...l.said })),
      tracks: tracks.map((t) => ({ id: t.id, levels: t.levels.map((l) => ({ offset: l.offset, chain: l.chain, ...(l.at.run !== undefined ? { run: l.at.run } : {}), ...(l.at.fromAxis ? { fromAxis: l.at.fromAxis } : {}) })), trend: trendOf(t) })),
    }
  },
}

/** The sketches as the planes a picture of a section may lie on
 *  (section.render { plane: { sketch } }), each in its own frame — those
 *  below the rollback bar too: a picture changes nothing. */
export const sketchPlanes: SheetPlanes = {
  description: 'the sketches',
  find: (given) => {
    let f: Feature
    try {
      f = featureNamed(given)
    } catch (e) {
      if (e instanceof CommandError && e.code === 'not_found') return null
      throw e
    }
    if (f.kind !== 'sketch') invalid(`${f.name} is a ${f.kind}, not a sketch.`)
    const { origin, normal, basisU, basisV } = (f as SketchFeature).frame
    return { name: f.name, origin, normal, basisU, basisV }
  },
}

/** The tolerance an outline is thinned at, mm, unless asked otherwise or
 *  the chain's scatter asks for more. */
const OUTLINE_TOLERANCE_MM = 0.05

/** A station as the answer gives it: where, how big, and the widest way as a
 *  direction and as degrees from the u a sketch on a plane of that normal has
 *  by default (a measured plane's own u may differ; the direction does not). */
function tubeStationOut(x: TubeStation): Json {
  const frame = sketchFrameOn({ origin: x.at, normal: x.dir })
  const angle = frame ? (Math.atan2(dot(x.majorDir, frame.basisV), dot(x.majorDir, frame.basisU)) * 180) / Math.PI : 0
  const r3 = (v: number) => roundTo(v, 3)
  return { s: roundTo(x.s, 2), at: x.at.map(r3), major: r3(x.major), minor: r3(x.minor), majorDir: x.majorDir.map(r3), angleDeg: roundTo(((angle % 180) + 180) % 180, 1) }
}

export const tubeTrace: Command<{ start: Vec3; dir: Vec3; both?: boolean; stepMm?: number; maxLengthMm?: number }> = {
  name: 'tube_trace',
  title: 'Read a bent tube’s centreline from the scan',
  description:
    'Follow a tube through the scan: cut square to it, take the closed loop round the centre (its centre, major and minor diameter), step on from the last centres, and stop where the loop is lost, the wall is open, or the size jumps by over 15 % — a flange, a bellows, a junction, none of them crossed. stops says where and why, one per way; a smaller step (a cuff, a weld) goes in warnings. The centres are then fitted as one chain of straights and tangent arcs, and cut again square to it: route feeds a sweep’s route directly (reverse.feature.add { kind: "sweep", profile, route }), with one radius per bend; runs lists the straights and bends with the tube’s size on each, for its profile; residual is how far the centres lie off the route; startPlane, passed to element.construct, gives a plane for the profile square to the route at its start. Start inside the tube, best on its longest straight with both: true: a bend read with no straight beyond it leaves its turn and radius open. A bellows or anything that is no tube is not modelled here. Changes nothing.',
  input: obj(
    {
      start: vec3('A point inside the tube, near its centre, [x, y, z] mm.'),
      dir: vec3('Along the tube there, any length; within 20° will do.'),
      both: bool('Follow it both ways from start (off by default: the way dir goes).'),
      stepMm: num('mm between stations; an eighth of the tube’s size by default.', { exclusiveMinimum: 0 }),
      maxLengthMm: num('Stop after this far, each way; 3000 by default.', { exclusiveMinimum: 0 }),
    },
    ['start', 'dir'],
  ),
  readOnly: true,
  long: true,
  run: async ({ start, dir, both, stepMm, maxLengthMm }) => {
    if (!useStore.getState().fileName) throw new CommandError('no_scan', 'There is no scan to follow a tube through.')
    const worker = commandHost().session.clientRef.current
    if (!worker) throw new CommandError('unavailable', 'The mesh worker is not running.')
    const t = await traceTube((origin, normal) => worker.section(origin, normal, EDGE_MIN_FEATURE_MM), { start, dir, both, stepMm, maxLengthMm })
    const made = t.route ? routePieces(t.route, t.route.points[0]) : null
    return {
      stops: t.stops.map((x) => ({ kind: x.kind, at: x.at.map((v) => roundTo(v, 3)), s: roundTo(x.s, 2), says: x.says })),
      route: t.route,
      runs: t.runs,
      residual: t.residual && { ...t.residual, at: t.residual.at.map((v) => roundTo(v, 3)) },
      ...(made && typeof made !== 'string' ? { startPlane: { kind: 'plane', method: 'plane-coords', params: { nx: roundTo(made.tangent[0], 6), ny: roundTo(made.tangent[1], 6), nz: roundTo(made.tangent[2], 6), px: made.start[0], py: made.start[1], pz: made.start[2] } } } : {}),
      warnings: t.warnings,
      stations: t.stations.map(tubeStationOut),
    }
  },
}

/** How many corners an outline takes at most, unless asked otherwise. */
const OUTLINE_MAX_POINTS = 200

export const sectionOutline: Command<{ section?: Ref; plane?: Json | string; chain?: number | 'largest' | { at: number[] }; tolerance?: number; closeGaps?: number; snapDeg?: number; simplifyDeg?: number; maxPoints?: number; within?: unknown; maxLength?: number } & SideIn> = {
  name: 'outline',
  title: 'A section’s chain as a polyline',
  description:
    'One chain of the scan cut at a plane, thinned to the corners a polyline needs, ready to paste: shape is { kind: "polyline", closed, points } as a sketch’s shapes take it, its points in that sketch’s own [u, v] (frame says where they lie — on a section not the sheet, which counts from the part’s centre). chain: by index as reverse.section.fit counts them, "largest" (the closed chain of the most area, else the longest; the default) or { at } — the chain the point lies on within three of its scatters, else the smallest closed chain round it, else the nearest. maxLength, closeGaps, within, skin and facing choose and trim the chains as reverse.section.fit does (with skin or facing the chain is one run of it). Thinned within tolerance (0.05 mm, or three times the chain’s scatter, raised until at most maxPoints corners); snapDeg lays sides within that many degrees of u or v exactly along them, simplifyDeg takes out corners turned by less (merged); maxDeviation says how far the chain strays. A curve comes out as short sides — fit it (reverse.section.fit, a sketch’s fit) where its radius matters: this is for a throw-away cutter, not a part’s outline. Changes nothing.',
  input: obj(
    {
      section: oneOf([int('The section’s id.', { minimum: 1 }), str('The section’s name.', { minLength: 1 })], 'The section, by id or name — or give plane.'),
      plane: planeField('A plane as a sketch takes it, the scan cut there: { kind: "world" | "section" | "plane" | "bodyFace", …, offset? } — or give section.'),
      chain: oneOf(
        [int('A chain’s index.', { minimum: 0 }), enumOf(['largest']), obj({ at: arr(num(), '[u, v] mm in the sketch, or [x, y, z] mm in the world.', { minItems: 2, maxItems: 3 }) }, ['at'])],
        'Which chain: by index, largest (the default), or the one round a point.',
      ),
      tolerance: num('mm the polyline may stray from the chain.', { exclusiveMinimum: 0 }),
      closeGaps: closeGapsIn,
      skin: skinIn,
      facing: facingIn,
      snapDeg: num('Lay sides within this many degrees of u or v exactly along them; off by default.', { minimum: 0, maximum: 20 }),
      simplifyDeg: num('Take out the corners turned at by less than this many degrees; off by default.', { minimum: 0, maximum: 30 }),
      maxPoints: int(`At most this many corners; ${OUTLINE_MAX_POINTS} by default.`, { minimum: 3 }),
      within: withinIn('Only what of the chains lies in this box: min and max [u, v] mm in the sketch’s own frame (as frame says), or world: { min, max } in mm.'),
      maxLength: num('Leave out chains longer than this, mm.', { exclusiveMinimum: 0 }),
    },
    [],
  ),
  readOnly: true,
  run: async ({ section, plane, chain: given = 'largest', tolerance, closeGaps, skin, facing, snapDeg, simplifyDeg, maxPoints = OUTLINE_MAX_POINTS, within, maxLength }) => {
    if ((section === undefined) === (plane === undefined)) invalid('Give section or plane — one of them.')
    if (plane !== undefined) {
      const errors = validate(planeIn, plane, 'input.plane')
      if (errors.length > 0) invalid(errors.join('; '))
    }
    const s = await ready()
    const ref: PlaneRef = section !== undefined ? { kind: 'section', id: findSection(section).id } : planeOf(s, plane!)
    const frame = ref.kind === 'bodyFace' || ref.kind === 'fitted' ? ref.frame : resolvePlaneFrame(ref, s.resolveContext())
    if (!frame) throw new CommandError('not_found', 'That plane is not there any more.')
    // A point in the world taken square onto the sketch's plane.
    const atWorld = typeof given === 'object' && given.at.length === 3 ? pointOnSheet(frame, given.at as Vec3) : undefined
    const chain: number | 'largest' | { at: Vec2 } = typeof given === 'object' ? { at: atWorld ? atWorld.at : (given.at as Vec2) } : given
    const rule = sideRuleOf(skin, facing)
    const sided = rule ? await sidedOn(ref, frame) : null
    const all = sided ? sided.chains : await chainsOn(ref, frame)
    if (all.length === 0) throw new CommandError('not_found', 'The scan is not cut on this plane — there is no chain.')
    if (typeof chain === 'number' && !all[chain]) throw new CommandError('not_found', `There is no chain ${chain} — the cut has ${all.length} (0 to ${all.length - 1}).`)
    let joined = closeGaps ? joinChainEnds(all, closeGaps) : unjoined(all)
    // Too long to be what is looked for — the part's outline round the
    // opening; a chain named by its index is taken whatever its length.
    let long = 0
    if (maxLength !== undefined && typeof chain !== 'number') {
      const { kept, left } = filterChains(joined.map((c) => c.chain), { maxLength })
      if (kept.length === 0) throw new CommandError('not_found', `Every chain of the cut is longer than ${maxLength} mm (maxLength).`)
      joined = kept.map((i) => joined[i])
      long = left.long ?? 0
    }
    let j: JoinedChain & { run?: number } = joined[pickChain(joined, chain)]
    // The box in the sketch's frame, a world box converted to it.
    const box = withinOf(within, 'within', () => cutSpanWords(all))
    if ((rule && sided) || box) {
      // The runs in the box and on the side asked, each a chain of its own.
      const side = rule && sided ? sideOf(sided, rule) : undefined
      const boxed = box ? withinOnSheet(box, frame) : {}
      const runs = joined.flatMap((c) => runsKept(c.chain, { ...boxed, side }).map((r, run) => ({ ...c, chain: r, run })))
      const among = typeof chain === 'number' ? runs.filter((r) => r.from.includes(chain)) : runs
      const named = typeof chain === 'number' ? joined.filter((c) => c.from.includes(chain)) : joined
      if (among.length === 0 && box && named.every((c) => runsKept(c.chain, boxed).length === 0)) throw new CommandError('not_found', `within: ${boxMissed(box, named.map((c) => c.chain), frame, 'the sketch’s [u, v] (frame)')}`)
      if (among.length === 0) throw new CommandError('not_found', `No run of ${typeof chain === 'number' ? `chain ${chain}` : 'the cut'} lies ${[box ? 'in the box (within)' : '', side ? 'on the side asked (skin, facing)' : ''].filter(Boolean).join(' and ')} — four points at least.`)
      j = among[pickChain(among, typeof chain === 'number' ? 'largest' : chain)]
    }
    const o = outlineOf(j.chain, { tolerance: tolerance ?? Math.max(OUTLINE_TOLERANCE_MM, 3 * viewChain(j.chain).scatter), snapDeg, simplifyDeg, maxPoints })
    // On a measured plane: where the element lies on the sheet.
    const element = await elementOnSheet(ref, frame)
    // To the micrometre, no two corners on one point.
    const r3 = (x: number) => roundTo(x, 3) + 0
    const points = o.points.map((p): Vec2 => [r3(p[0]), r3(p[1])]).filter((p, i, ps) => {
      const q = ps[(i + 1) % ps.length]
      return ps.length < 2 || (!o.closed && i === ps.length - 1) || p[0] !== q[0] || p[1] !== q[1]
    })
    return {
      ...chainName(j),
      ...(j.run !== undefined ? { run: j.run } : {}),
      chains: joined.length,
      ...(long > 0 ? { leftOut: { maxLength: long } } : {}),
      shape: { kind: 'polyline', closed: o.closed, points },
      count: points.length,
      tolerance: round4(o.tolerance),
      maxDeviation: round4(o.maxDeviation),
      ...(o.snapped > 0 ? { snapped: o.snapped } : {}),
      ...(o.merged > 0 ? { merged: o.merged } : {}),
      ...(j.gaps > 0 ? { bridged: { gaps: j.gaps, largest: round4(j.largest) } } : {}),
      ...(atWorld ? { at: atWorld.at.map(round4), offPlane: round4(atWorld.off) } : {}),
      frame: { origin: frame.origin.map(round4), normal: frame.normal.map(round4), basisU: frame.basisU.map(round4), basisV: frame.basisV.map(round4) },
      ...(element ? { element: elementOut(element) } : {}),
    }
  },
}

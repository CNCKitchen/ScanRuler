// SPDX-License-Identifier: AGPL-3.0-only
// Why a round, a shell, a draft or an offset the kernel refused could not be
// made, read off the body: a round larger than a face beside its edges, a
// wall thinner than the shell or the offset, a face that will not lean or
// two that will not lean together — the Builder's diagnose (build.ts) names
// the culprits from these.

import { buildSolidIndex, computeThickness, DEFAULT_NORMAL_DEVIATION_DEG } from '../../../src/core/thickness/thickness'
import type { Vec3 } from '../../../src/core/types'
import { addScaled, cross, normalize } from '../../../src/core/vec'
import type { Builder } from './build'
import { type Body, type Diagnosis, diagonalOf, meshDeflection } from './buildTypes'
import type { BuildStep } from './features'
import type { RawEdge, ReKernel, Shape } from './kernel'
import { isTrap, KernelTrap } from './kernelOps'
import { type FaceOffsetLimit, largestSize, largestSizeWhile } from './kernelShell'
import { onOneSurface, splitEdges, tangentChain } from './topo'
import { edgeShares } from './edgeLines'

/** The thinnest places of a body, probed down its mesh's normals — where a
 *  shell's wall will not fit. At most this many are named. */
const THIN_SPOTS = 3

/** How many picks a diagnosis tries one at a time, at most — each try is
 *  a kernel operation on the whole body. The largest size a pick takes is
 *  found by halving to within a tenth of a millimetre (largestSize). */
const DIAGNOSE_PICKS = 24

/** A face beside a round or a chamfer under this many times the size
 *  squared is too small to carry it, and is named as the likely reason. */
const SMALL_FACE_SIZES = 4

/** A size in millimetres as a sentence says it: two decimals at most. */
// units-ok: build message, also the agent's answer
const mm = (v: number) => `${Math.round(v * 100) / 100} mm`

const mm2 = (v: number) => `${Math.round(v * 100) / 100}`

/** A point as a sentence gives it: two decimals at most. */
const point = (p: Vec3) => `(${p.map((v) => Math.round(v * 100) / 100).join(', ')})`

/** What a failure said, without the name of the operation the kernel
 *  wrapper puts before it ("Shelling: …"). */
const said = (e: unknown) => withoutCallName(e instanceof Error ? e.message : String(e)).replace(/^[A-Z][a-z ]+: /, '').replace(/\.$/, '')

/** A failed round's diagnosis spends at most this many times the step's
 *  own time — each try is a whole round of the body — and never less than
 *  ROUND_DIAGNOSIS_LEAST_MS. A nose corner's tries ran past two minutes
 *  with no limit. */
export const ROUND_DIAGNOSIS_TIMES = 4
export const ROUND_DIAGNOSIS_LEAST_MS = 10_000

/** The budget of a round's diagnosis whose step took `stepMs`, as
 *  shellDiagnosisBudget has it for a shell. */
export function roundDiagnosisBudget(stepMs: number): { ms: number; perTry: number } {
  return { ms: Math.max(ROUND_DIAGNOSIS_LEAST_MS, ROUND_DIAGNOSIS_TIMES * stepMs), perTry: stepMs }
}

/** Of its budget, what a diagnosis of several chains spends on them alone:
 *  the rest reads them together, the size the feature itself asks. */
const ALONE_SHARE = 0.5

/** Where a diagnosis ran out of time before it had the size. */
const TRY_IT = 'reverse.body.fillet_try tries a list of sizes on the body before this feature, with nothing after it rebuilt.'

/** No round or chamfer is tried smaller than this, mm, nor than an eighth
 *  of the size asked: a size that small is no answer for the part, and
 *  the kernel can take minutes over one (a nose corner's 0.04 mm round). */
const LEAST_TRY_MM = 0.1
const LEAST_TRY_SHARE = 1 / 8

/** Sizes above the one asked tried too, as shares of it: a round that
 *  fails at the size asked can build a little larger, where it ends
 *  somewhere else — then it is not the size that fails. */
const SIZES_ABOVE = [1.05, 1.1, 1.2]

/** How many sizes are tried evenly between the largest the halving found
 *  and the size asked — for one that builds between failing ones. */
const SIZES_BETWEEN = 4

/** At most this many sizes of each kind, built and failed, are named. */
const SIZES_NAMED = 5

/** What the sizes tried of a round or a chamfer came to: the largest the
 *  halving found under the size asked (zero for none at or above
 *  `floor`, the smallest tried), whether the halving was done, and every
 *  size tried that built or failed — the size asked among the failed. */
interface SizesRead {
  upTo: number
  floor: number
  settled: boolean
  built: number[]
  failed: number[]
}

/** The sizes a round or a chamfer takes, read both ways from the size
 *  asked, which failed: halved down to the floor, then the sizes above it
 *  (SIZES_ABOVE) and a few between the halving's answer and it — so a
 *  round that builds larger than one that fails is told apart from one
 *  too large. `goOn` is asked before each try. */
function readSizes(size: number, works: (at: number) => boolean, goOn: () => boolean): SizesRead {
  const floor = Math.min(size, Math.max(LEAST_TRY_MM, size * LEAST_TRY_SHARE))
  const built: number[] = []
  const failed: number[] = [size]
  const tried = (at: number) => [...built, ...failed].some((x) => Math.abs(x - at) < size * 0.01)
  const probe = (at: number) => {
    const ok = works(at)
    if (ok) built.push(at)
    else failed.push(at)
    return ok
  }
  const halved = largestSizeWhile(size, probe, goOn, floor)
  const from = halved.size > 0 ? halved.size : floor
  const between = Array.from({ length: SIZES_BETWEEN }, (_, i) => from + ((size - from) * (i + 1)) / (SIZES_BETWEEN + 1))
  let settled = halved.settled
  for (const at of [...SIZES_ABOVE.map((f) => size * f), ...between]) {
    if (tried(at)) continue
    if (!goOn()) {
      settled = false
      break
    }
    probe(at)
  }
  return { upTo: halved.size, floor, settled, built, failed }
}

/** Whether a size built above one that failed: the round does not fail
 *  for its size. */
const notBySize = (s: SizesRead) => s.built.some((b) => s.failed.some((f) => b > f))

/** The sizes tried that tell a round does not fail for its size, as a
 *  sentence says them: those that built from the halving's answer up, and
 *  those that failed below the largest that built — then what to do: with
 *  `outside` edges at the corner that are not in the feature, round them
 *  with it; with none, every edge there is in it already, and the size
 *  that builds nearest the one asked is the answer. */
function bothWays(s: SizesRead, size: number, outside: number, builds: 'builds' | 'build', verb: 'round' | 'chamfer', kind: 'fillet' | 'chamfer'): string {
  const top = Math.max(...s.built)
  const built = [...new Set(s.built.filter((b) => b >= s.upTo).map(mm2))].sort((a, b) => Number(a) - Number(b)).slice(0, SIZES_NAMED)
  const failed = [...new Set(s.failed.filter((f) => f < top).map(mm2))].sort((a, b) => Number(a) - Number(b)).slice(-SIZES_NAMED)
  const nearest = s.built.reduce((a, b) => (Math.abs(b - size) < Math.abs(a - size) ? b : a))
  const todo =
    outside > 0
      ? `${verb} the ${outside === 1 ? 'edge' : `${outside} edges`} there not in this ${kind} with ${builds === 'build' ? 'them' : 'it'}, every edge at that corner in one ${kind} — or take ${mm(nearest)}, the nearest size that builds`
      : `every edge there is in this ${kind} already; take ${mm(nearest)}, the nearest size that builds`
  // units-ok: build message, also the agent's answer
  return `${builds} at ${built.join(', ')}; ${builds === 'builds' ? 'fails' : 'fail'} at ${failed.join(', ')} mm — not a size limit: the corner where the ${verb}s meet; ${todo}`
}

/** How many edges meet the given edges' ends that are not among `asked`
 *  — the edges a corner's round would want in the same feature — seams
 *  (an edge with one face on both sides) left out. */
function edgesAtEndsBeside(edges: readonly RawEdge[], hashes: readonly number[], asked: ReadonlySet<number>): number {
  const ends: Vec3[] = []
  const of = new Set(hashes)
  for (const e of edges) if (of.has(e.hash)) ends.push(...e.ends)
  const meets = (p: Vec3) => ends.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) <= MEET_MM)
  let n = 0
  for (const e of edges) if (!asked.has(e.hash) && new Set(e.faceHashes).size === 2 && (meets(e.ends[0]) || meets(e.ends[1]))) n++
  return n
}

/** How many points along an edge its faces are read at, at most. */
const APART_POINTS = 16

/** How far apart the two faces along some edges stand, by their outward
 *  normals — 0° flat, 90° a square corner — the least and the most, read
 *  at points along each edge, and the point where they come closest to
 *  flat: what says it is the edge a round fails on at every size. Null
 *  where no edge has two faces to read. */
function facesApartAlong(kernel: ReKernel, shape: Shape, edges: readonly RawEdge[], hashes: readonly number[]): { least: number; most: number; at: Vec3 } | null {
  let least = Infinity
  let most = -Infinity
  let at: Vec3 | null = null
  for (const h of hashes) {
    const e = edges.find((x) => x.hash === h)
    if (!e || new Set(e.faceHashes).size !== 2 || e.polyline.length < 6) continue
    const n = e.polyline.length / 3
    const take = Math.min(n, APART_POINTS)
    const points: Vec3[] = Array.from({ length: take }, (_, i) => {
      const j = Math.round((i * (n - 1)) / Math.max(1, take - 1))
      return [e.polyline[j * 3], e.polyline[j * 3 + 1], e.polyline[j * 3 + 2]]
    })
    let normals: Vec3[][]
    try {
      normals = e.faceHashes.map((f) => kernel.faceNormals(shape, f, points))
    } catch (err) {
      if (isTrap(err) || kernel.trapped !== null) throw err
      continue
    }
    points.forEach((p, i) => {
      const [a, b] = [normals[0][i], normals[1][i]]
      const deg = (Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI
      if (deg < least) [least, at] = [deg, p]
      most = Math.max(most, deg)
    })
  }
  return at ? { least, most, at } : null
}

/** Degrees as a sentence gives them: one decimal under ten, whole above. */
const deg = (v: number) => `${v < 10 ? Math.round(v * 10) / 10 : Math.round(v)}°`

/** What an operation the kernel refused said, without the name of the
 *  kernel call it was in: "Filleting: filletWithHistory: produced an
 *  invalid solid" is "Filleting: produced an invalid solid" — the call is
 *  the kernel's own, and names nothing of the part. */
export const withoutCallName = (message: string): string => message.replace(/^([A-Z][a-z ]+: )[a-z]\w*[A-Z]\w*: /, '$1')

/**
 * Why a round or a chamfer the kernel refused could not be made: each
 * tangent chain of its edges tried alone at the size asked — one of each
 * set alike (alikeSets), its answer carried to the set — then the sizes the
 * failing ones take, read both ways (readSizes), and whether all of them
 * take that size together; or the sizes they take together, each taking
 * the size asked alone or none taking any. Within `limit`
 * (roundDiagnosisBudget; none given, no limit): what the budget did not
 * reach is said, and what it did holds for the chains read. With `crashed`, the step crashed the kernel and this
 * runs on a fresh one: the very operation that crashed is not tried
 * again — it counts as failed — and a try that traps stops the diagnosis
 * there, thrown on, for a broken kernel is asked nothing more.
 */
export function diagnoseRound(
  kernel: ReKernel,
  builder: Builder,
  step: Extract<BuildStep, { kind: 'fillet' | 'chamfer' }>,
  body: Body,
  limit?: { ms: number; perTry: number },
  crashed = false,
): Diagnosis | null {
  const k = kernel
  const found = builder.findEdges(step.body, step.edges, step.id, { asked: step.edgesWhere, quiet: true })
  if ('lost' in found) return null
  const edges = k.edges(body.shape, meshDeflection(diagonalOf(kernel, body.shape)))
  const splits = splitEdges({ faces: k.faces(body.shape).map((f) => ({ hash: f.hash, fingerprint: f })), edges: edges.map((e) => ({ hash: e.hash, faces: e.faceHashes })) })
  const hashes = step.chain ? tangentChain(edges, found.hashes, splits) : found.hashes
  const size = step.kind === 'fillet' ? step.radius : step.distance
  const verb = step.kind === 'fillet' ? 'round' : 'chamfer'
  const budget = new Budget(limit?.ms ?? Infinity, limit?.perTry ?? 0)
  const goOn = () => budget.affords()
  // The operation that crashed: every edge at the size asked, as the
  // build asked it — not a varying round, nor one that skips what fails,
  // which the build made otherwise.
  const asked = new Set(hashes)
  const same = crashed && !step.skipFailing && !(step.kind === 'fillet' && (step.variable?.length ?? 0) > 0)
  const isCrashed = (hs: readonly number[], at: number) => same && at === size && hs.length === asked.size && hs.every((h) => asked.has(h))
  const attempt = (hs: readonly number[], at: number): boolean => {
    if (isCrashed(hs, at)) return false
    return budget.timed(() => {
      try {
        const r = step.kind === 'fillet' ? k.filletTracked(body.shape, hs, at) : step.mode ? builder.chamferSided(step, body, hs, at / size) : k.chamferTracked(body.shape, hs, at)
        const ok = k.isClosedSolid(r.shape)
        k.release(r.shape)
        if (k.trapped !== null) throw new KernelTrap(k.trapped)
        return ok
      } catch (e) {
        // A trap leaves the kernel broken: nothing more is asked of it.
        if (isTrap(e) || k.trapped !== null) throw e
        // Refused at this size: that is the answer the try was for.
        return false
      }
    })
  }
  const drawn = (hs: readonly number[]) => hs.map((h) => edges.find((e) => e.hash === h)?.polyline).filter((p): p is Float32Array => p !== undefined && p.length >= 6)
  // The kernel rounds a tangent chain as one — an edge picked alone takes
  // the edges tangent to it with it — so what is probed is the chains,
  // each once. Probing a chain's edges one at a time would round the
  // whole chain every time and blame every edge of it ("none of the 17
  // edges round"), when it is the chain, or one place on it, that fails.
  const left = new Set(hashes)
  const chains: Chain[] = []
  for (const h of hashes) {
    if (!left.has(h)) continue
    const whole = tangentChain(edges, [h], splits)
    const picked = whole.filter((x) => left.has(x))
    for (const x of picked) left.delete(x)
    chains.push({ picked, whole })
  }
  // Chains alike — a patterned body's — answer once for all of them.
  const sets = alikeSets(chains, edges, k.faces(body.shape), body.origins)
  // One chain of each set alone at the size asked, as far as the budget goes.
  const probed: AlikeSet[] = []
  const failingSets: AlikeSet[] = []
  for (const set of sets.slice(0, DIAGNOSE_PICKS)) {
    if (!goOn()) break
    probed.push(set)
    if (!attempt(set.one.picked, size)) failingSets.push(set)
  }
  const failing = failingSets.flatMap((set) => set.all)
  const m = chains.length
  const edgeCount = hashes.length
  const unit = m === edgeCount ? 'edges' : 'chains'
  const reached = probed.reduce((c, set) => c + set.all.length, 0)
  const cut = probed.length < Math.min(sets.length, DIAGNOSE_PICKS)
  // A try of them all is the size of the step's own, however quick one
  // chain's was.
  const together = (from: number) => {
    budget.ahead(limit?.perTry ?? 0)
    return readSizes(from, (at) => attempt(hashes, at), goOn)
  }
  // Not even the floor: it is the edge, not the size — said with how far
  // apart its faces stand along it, and where they come closest to flat.
  const atNoSize = (n: number, floor: number, asked: number, how = '') => {
    const apart = facesApartAlong(k, body.shape, edges, failing.flatMap((c) => c.whole))
    const least = floor < asked / 8 + 1e-9 && floor > LEAST_TRY_MM ? 'an eighth of the size asked' : 'the least tried'
    const along = apart
      ? `: ${n === 1 ? 'its' : 'their'} two faces stand ${Math.abs(apart.most - apart.least) < 0.05 ? deg(apart.least) : `${deg(apart.least)}–${deg(apart.most)}`} apart along ${n === 1 ? 'it' : 'them'} (0° is flat), closest to flat at ${point(apart.at)}`
      : ''
    return `${n === 1 ? 'It does' : 'They do'} not ${verb} even at ${mm(floor)}, ${least}${how} — it is the edge, not the size${along}.`
  }
  if (failing.length > 0) {
    const n = failing.length
    // The sizes one chain of each failing set takes, the largest set first,
    // and of the budget the share the chains alone may take: a set of chains
    // that round only together is told by the tries left.
    const alone = m > 1 ? () => goOn() && budget.spent <= budget.ms * ALONE_SHARE : goOn
    const reads: { one: Chain; read: SizesRead }[] = []
    for (const set of [...failingSets].sort((a, b) => b.all.length - a.all.length)) {
      if (!alone()) break
      reads.push({ one: set.one, read: readSizes(size, (at) => attempt(set.one.picked, at), alone) })
    }
    // A read the budget stopped short of any size says nothing of them: it
    // is no zero, and neither is a chain not read at all.
    const known = reads.filter((r) => r.read.settled || r.read.upTo > 0)
    const upTo = known.length > 0 ? Math.min(...known.map((r) => r.read.upTo)) : 0
    const allRead = reads.length === failingSets.length
    const halvedAll = reads.every((r) => r.read.settled)
    const settled = allRead && halvedAll
    const odd = reads.findIndex((r) => notBySize(r.read))
    const tried = cut ? ` (the first ${reached} tried; the rest not: ${budget.over})` : reached < m ? ` (the first ${reached} tried)` : ''
    const chained = failing.filter((c) => c.whole.length > 1)
    const maker = makerNamer(builder, body, step)
    const what = (c: Chain) => `${c.whole.length > 1 ? `the chain of ${c.whole.length} tangent edges${c.picked.length < c.whole.length ? ` (${c.picked.length} picked)` : ''}` : 'the edge'}${edgePlace(edges, c, maker)}`
    let which: string
    if (m === 1) which = `${chained.length > 0 ? `The chain of ${failing[0].whole.length} tangent edges` : 'The edge'} does not ${verb}`
    else if (n === m) which = `None of the ${m} ${m === edgeCount ? 'edges' : `chains (${edgeCount} edges)`} ${verb}s`
    else which = `${n} of the ${m} ${m === edgeCount ? 'edges' : `chains (${edgeCount} edges)`} do not ${verb}: ${listFailing(failing.map((c) => ({ words: what(c), ...edgeWhere(edges, c, maker) })), m === edgeCount ? 'edges' : 'chains')}`
    const asOne = chained.length > 0 ? ` — the kernel ${verb}s a tangent chain as one, so no edge of ${chained.length === 1 && n === 1 ? 'it' : 'such a chain'} ${verb}s alone either` : ''
    const shown = n === m ? ' — drawn red on the part' : ' — drawn red on the part; the others do'
    // How far what was read goes.
    const readOn =
      reads.length === n
        ? ''
        : allRead
          ? ` Read on ${reads.length} of the ${n} ${unit}: the others are alike — the same lengths and the same faces either side — and taken to match.`
          : ` That holds for the ${reads.length} of the ${n} ${unit} read and those alike; the rest were not read${halvedAll ? `: ${budget.over}` : ''}.`
    const unfound = (they: string) => `The size ${they} was not found: ${budget.over}. ${TRY_IT}`
    const halved = (at: number, isSettled: boolean) => `${mm(at)}${isSettled ? '' : ` (not halved further: ${budget.over})`}`
    const togetherWords = (t: SizesRead, from: number) =>
      notBySize(t) ? `Together they ${bothWays(t, from, edgesAtEndsBeside(edges, hashes, asked), 'build', verb, step.kind)}.` : t.upTo > 0 ? `Together they ${verb} at up to ${halved(t.upTo, t.settled)}.` : `Together no size was found${t.settled ? '' : `: ${budget.over}`}.`
    let can: string
    // Built with the rest of the feature where it does not alone.
    let withTheRest = false
    if (odd >= 0 || upTo > 0) {
      const of = odd >= 0 ? reads[odd].read : null
      const said = of ? `${n === 1 ? 'It' : what(reads[odd].one).replace(/^t/, 'T')} ${bothWays(of, size, edgesAtEndsBeside(edges, reads[odd].one.whole, asked), 'builds', verb, step.kind)}.` : `${n === 1 ? 'It' : 'They'} ${verb}${n === 1 ? 's' : ''} at up to ${halved(upTo, halvedAll)}.`
      // Read alone, the size may still fail with the others: tried once
      // with them all, and read together where it does.
      const claim = of ? of.built.reduce((a, b) => (Math.abs(b - size) < Math.abs(a - size) ? b : a)) : upTo
      let all = ''
      if (m > 1) {
        budget.ahead(limit?.perTry ?? 0)
        if (goOn()) {
          const them = m === 2 ? 'Both' : `All ${m}`
          if (attempt(hashes, claim)) all = ` ${them} together build at ${mm(claim)}.`
          else {
            const t = together(claim)
            all = ` ${them} together do not build at ${mm(claim)}. ${togetherWords(t, claim)}`
          }
        }
      }
      can = `${said}${readOn}${all}${settled ? '' : ` ${TRY_IT}`}`
    } else if (m > 1) {
      // No size alone, or none found: the feature asks for them all at once,
      // and chains that meet may round only so.
      const t = together(size)
      withTheRest = t.built.length > 0
      const noneAlone = settled && reads.every((r) => r.read.built.length === 0)
      if (withTheRest) can = `${settled ? `Alone ${n === 1 ? 'it does' : noneAlone ? 'they do' : 'some do'} not ${verb} even at ${mm(reads[0].read.floor)}, but` : `Alone no size was found (${budget.over}), but`} they do with the rest of the feature. ${togetherWords(t, size)}${readOn}`
      else if (settled && t.settled) can = `${atNoSize(n, reads[0].read.floor, size, ', alone or together')}${readOn}`
      else can = unfound(n === 1 ? 'it takes' : 'they take')
    } else can = settled ? atNoSize(n, reads[0].read.floor, size) : unfound(n === 1 ? 'it takes' : 'they take')
    const beside = smallFacesBeside(kernel, body.shape, edges, failing.flatMap((c) => c.whole), size, maker)
    const creases = shallowCreasesAt(kernel, body.shape, edges, failing.flatMap((c) => c.whole))
    const crease =
      creases.length > 0
        ? ` ${n === 1 ? 'It meets' : 'They meet'} ${creases.join('; ')} — two faces a few degrees apart, which a ${verb} often cannot end on or run across: if the size is not the reason, make them one face (one profile curve in place of the two lines), or a clear corner.`
        : ''
    // A round that builds larger than one that fails is not too large for
    // the faces beside it, nor one that builds with the rest of the feature:
    // that reason is not given then.
    const why =
      (beside.length > 0
        ? ` Beside ${n === 1 ? 'it' : 'them'}: ${beside.map((b) => b.words).join('; ')} — a face too small for the ${verb} (reverse.body.check lists such faces); take it off, ${verb} the rest first, or ${verb} smaller there.`
        : creases.length > 0 || odd >= 0 || withTheRest
          ? ''
          : ` The faces beside ${n === 1 ? 'it' : 'them'} are too narrow for the ${verb}, or meet at an angle the kernel cannot ${verb}.`) + crease
    // What chains run into, read on one of each set: the same for those alike.
    const into = runsIntoText(kernel, builder, body, edges, failingSets.map((set) => set.one), verb, (c) => (n === 1 ? (c.whole.length > 1 ? 'The chain' : 'The edge') : what(c).replace(/^t/, 'T')), step)
    // A helper body's side on a failing edge or beside one: said once, with
    // the ways round it.
    const helpers = helpersAt(failing.flatMap((c) => c.whole), edges, beside, maker)
    return { message: `${which} at ${mm(size)}${tried}${asOne}${shown}. ${can}${why}${into}${helperText(builder, helpers, verb)}`, where: drawn(failing.flatMap((c) => c.picked)) }
  }
  if (m < 2 || reached < m) return null
  // Every chain takes the size alone: it is where two meet that fails.
  const read = together(size)
  const can = notBySize(read)
    ? `Together they ${bothWays(read, size, edgesAtEndsBeside(edges, hashes, asked), 'build', verb, step.kind)}.`
    : read.upTo > 0
      ? `Together they ${verb} at up to ${mm(read.upTo)}${read.settled ? '' : ` (not halved further: ${budget.over})`}; or ${verb} them in two features.`
      : `${verb === 'round' ? 'Round' : 'Chamfer'} them in two features${read.settled ? '' : ` — the size they take together was not found: ${budget.over}`}.`
  const readAlone = probed.length < m ? ` ${probed.length} of the ${m} were tried alone, the others alike.` : ''
  return { message: `Each of the ${m} ${unit} ${verb}s alone at ${mm(size)}; together they do not — where two meet, one runs into the other. ${can}${readAlone}`, where: drawn(hashes) }
}

/** A round's or a chamfer's tangent chain: the edges picked on it, and all
 *  of it. */
type Chain = { picked: number[]; whole: number[] }

/** Chains alike, and the one tried for them all. */
type AlikeSet = { one: Chain; all: Chain[] }

/** Lengths and areas of two chains alike agree within this share of the
 *  larger, and a hair: a pattern's copies agree to far better, and a chain
 *  wrongly apart from its like costs only a try. */
const ALIKE_SHARE = 0.002
const ALIKE_HAIR = 1e-3

const alikeWithin = (a: number, b: number) => Math.abs(a - b) <= Math.max(a, b) * ALIKE_SHARE + ALIKE_HAIR

/** What of a chain does not change as it moves, a pattern's copy to the next:
 *  how many edges are picked, each edge's kind and length, how far the
 *  chain's ends spread, and the faces either side and at its ends — by their
 *  surface, the feature that made them and their area. */
interface ChainPrint {
  picked: number
  kinds: string
  lengths: number[]
  spread: number
  sides: string
  sideAreas: number[]
  atEnds: string
  endAreas: number[]
}

/** The chains grouped by what is the same in each (ChainPrint) — a fair
 *  test that a round of one goes as a round of another, as a pattern's copies
 *  do: the same lengths between the same faces, ending against the same
 *  faces. It says nothing of a kink in one of them, so an answer carried
 *  across says that it was. In the order the chains came. */
function alikeSets(chains: readonly Chain[], edges: readonly RawEdge[], faces: readonly { hash: number; kind: string; area: number }[], origins: ReadonlyMap<number, number>): AlikeSet[] {
  if (chains.length < 2) return chains.map((one) => ({ one, all: [one] }))
  const edgeOf = new Map(edges.map((e) => [e.hash, e]))
  const faceOf = new Map(faces.map((f) => [f.hash, f]))
  // The faces at each vertex; an edge's two ends are its vertices' own
  // points, so edges that share one read it the same.
  const vertexKey = (p: Vec3) => p.map((v) => Math.round(v * 100)).join(',')
  const atVertex = new Map<string, number[]>()
  for (const e of edges) {
    for (const p of e.ends) {
      const key = vertexKey(p)
      atVertex.set(key, [...(atVertex.get(key) ?? []), ...e.faceHashes])
    }
  }
  const facesRead = (hashes: Iterable<number>) => {
    const read = [...new Set(hashes)].map((h) => ({ key: `${faceOf.get(h)?.kind}/${origins.get(h)}`, area: faceOf.get(h)?.area ?? 0 })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.area - b.area))
    return { keys: read.map((f) => f.key).join(' '), areas: read.map((f) => f.area) }
  }
  const printOf = (c: Chain): ChainPrint => {
    const own = c.whole.flatMap((h) => edgeOf.get(h) ?? [])
    const sorted = [...own].sort((a, b) => a.length - b.length)
    const ends = own.flatMap((e) => e.ends)
    const middle = ends.reduce<Vec3>((s, p) => [s[0] + p[0] / ends.length, s[1] + p[1] / ends.length, s[2] + p[2] / ends.length], [0, 0, 0])
    const sides = facesRead(own.flatMap((e) => e.faceHashes))
    const mine = new Set(own.flatMap((e) => e.faceHashes))
    const beyond = facesRead(ends.flatMap((p) => atVertex.get(vertexKey(p)) ?? []).filter((h) => !mine.has(h)))
    return {
      picked: c.picked.length,
      kinds: sorted.map((e) => e.kind).sort().join(' '),
      lengths: sorted.map((e) => e.length),
      spread: Math.max(0, ...ends.map((p) => Math.hypot(p[0] - middle[0], p[1] - middle[1], p[2] - middle[2]))),
      sides: sides.keys,
      sideAreas: sides.areas,
      atEnds: beyond.keys,
      endAreas: beyond.areas,
    }
  }
  const allWithin = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => alikeWithin(v, b[i]))
  const alike = (a: ChainPrint, b: ChainPrint) =>
    a.picked === b.picked && a.kinds === b.kinds && a.sides === b.sides && a.atEnds === b.atEnds && alikeWithin(a.spread, b.spread) && allWithin(a.lengths, b.lengths) && allWithin(a.sideAreas, b.sideAreas) && allWithin(a.endAreas, b.endAreas)
  const sets: (AlikeSet & { print: ChainPrint })[] = []
  for (const c of chains) {
    const print = printOf(c)
    const set = sets.find((s) => alike(s.print, print))
    if (set) set.all.push(c)
    else sets.push({ one: c, all: [c], print })
  }
  return sets
}

/** The faces beside the given edges that are too small to hold a round
 *  or a chamfer of `size` — a sliver a boolean left, a face narrower
 *  than the size — as a message names them, the smallest first, three at
 *  most. */
function smallFacesBeside(kernel: ReKernel, shape: Shape, edges: readonly RawEdge[], hashes: readonly number[], size: number, maker: MakerNamer): { words: string; hash: number }[] {
  const beside = new Set<number>()
  for (const h of hashes) for (const f of edges.find((e) => e.hash === h)?.faceHashes ?? []) beside.add(f)
  if (beside.size === 0) return []
  const small = kernel
    .faces(shape)
    .filter((f) => beside.has(f.hash) && f.area < SMALL_FACE_SIZES * size * size)
    .sort((a, b) => a.area - b.area)
    .slice(0, 3)
  return small.map((f) => {
    const by = maker(f.hash)
    const at = faceMiddle(f, edges)
    // units-ok: build message, also the agent's answer.
    return { hash: f.hash, words: `a ${f.kind === 'other' ? 'face' : f.kind} of ${f.area < 0.01 ? f.area.toPrecision(2) : mm2(f.area)} mm² at (${at.map((v) => v.toFixed(1)).join(', ')})${by ? `, ${by.words}` : ''}` }
  })
}

/** Under this area a face has no centroid worth the name: the kernel's sum
 *  over nothing comes to the origin, and a message then points there. */
export const NO_AREA_MM2 = 1e-6

/** Where a face is, as a message names it: its centroid, or where it has no
 *  area the middle of its edges. */
export function faceMiddle(f: { hash: number; area: number; centroid: Vec3 }, edges: readonly RawEdge[]): Vec3 {
  if (f.area >= NO_AREA_MM2) return f.centroid
  const round = edges.filter((e) => e.faceHashes.includes(f.hash))
  if (round.length === 0) return f.centroid
  const sum = round.reduce<Vec3>((s, e) => [s[0] + e.mid[0], s[1] + e.mid[1], s[2] + e.mid[2]], [0, 0, 0])
  return [sum[0] / round.length, sum[1] / round.length, sum[2] / round.length]
}

/** Flat faces meeting at under this many degrees — but not at none — are
 *  a crease a round cannot end on: a drafted band against an upright end. */
const SHALLOW_CREASE_DEG = 5
/** Under this two flat faces are one. */
const SAME_PLANE_DEG = 0.05
/** How near an edge's end lies to a chain's to meet it, mm. */
const MEET_MM = 1e-3

/** The shallow creases a chain of edges runs into: edges not of the chain,
 *  between two flat faces at a few degrees, that touch one of its ends —
 *  as a message names them, three at most. */
function shallowCreasesAt(kernel: ReKernel, shape: Shape, edges: readonly RawEdge[], hashes: readonly number[]): string[] {
  const chain = new Set(hashes)
  const ends: Vec3[] = []
  for (const e of edges) if (chain.has(e.hash)) ends.push(...e.ends)
  if (ends.length === 0) return []
  const faces = new Map(kernel.faces(shape).map((f) => [f.hash, f]))
  const meets = (p: Vec3) => ends.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) <= MEET_MM)
  const out: { deg: number; at: Vec3 }[] = []
  for (const e of edges) {
    if (chain.has(e.hash) || e.faceHashes.length !== 2) continue
    if (!meets(e.ends[0]) && !meets(e.ends[1])) continue
    const a = faces.get(e.faceHashes[0])
    const b = faces.get(e.faceHashes[1])
    if (a?.kind !== 'plane' || b?.kind !== 'plane') continue
    const c = Math.abs(a.dir[0] * b.dir[0] + a.dir[1] * b.dir[1] + a.dir[2] * b.dir[2])
    const deg = (Math.acos(Math.min(1, c)) * 180) / Math.PI
    if (deg > SAME_PLANE_DEG && deg < SHALLOW_CREASE_DEG) out.push({ deg, at: e.mid })
  }
  return out
    .sort((x, y) => x.deg - y.deg)
    .slice(0, 3)
    .map((x) => `a crease of ${Math.round(x.deg * 100) / 100}° between two flat faces at (${x.at.map((v) => v.toFixed(1)).join(', ')})`)
}

/** A face at a chain's open end faces back along the chain — a wall the
 *  chain runs into, not a corner it turns — when its normal there leans
 *  further than this, as a cosine, against the way the chain was going. */
const RUNS_INTO_COS = -0.1

/** The faces a chain of edges runs into at its open ends: faces at an end
 *  vertex that are not either side of any edge of the chain, and whose
 *  normal there faces back against the chain — the wall an arm's edge
 *  meets at a T, not the end face of a bar it turns a corner onto — by
 *  hash, each once, with the end it lies at. A closed chain has none. */
function facesRunInto(kernel: ReKernel, shape: Shape, edges: readonly RawEdge[], whole: readonly number[]): { hash: number; at: Vec3 }[] {
  const chain = new Set(whole)
  const own = new Set<number>()
  const ends: { at: Vec3; out: Vec3 }[] = []
  for (const e of edges) {
    if (!chain.has(e.hash)) continue
    for (const f of e.faceHashes) own.add(f)
    // The tangents point along the edge away from its start: out of the
    // edge at its start is against the first, at its end along the second.
    ends.push({ at: e.ends[0], out: [-e.endTangents[0][0], -e.endTangents[0][1], -e.endTangents[0][2]] })
    ends.push({ at: e.ends[1], out: e.endTangents[1] })
  }
  const near = (p: Vec3, q: Vec3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) <= MEET_MM
  // An open end is one no other end of the chain meets.
  const open = ends.filter((x, i) => !ends.some((y, j) => j !== i && near(x.at, y.at)))
  if (open.length === 0) return []
  const faces = new Map(kernel.faces(shape).map((f) => [f.hash, f]))
  let mesh: ReturnType<ReKernel['mesh']> | null = null
  // A face's outward normal at a point of it: a plane's own, else the
  // normal of its mesh vertex nearest the point (the kernel meshes face by
  // face, so a vertex at the corner carries this face's normal there).
  const normalAt = (h: number, p: Vec3): Vec3 | null => {
    const f = faces.get(h)
    if (f?.kind === 'plane') return f.dir
    mesh ??= kernel.mesh(shape, meshDeflection(diagonalOf(kernel, shape)))
    if (!mesh.faceHash) return null
    let best = -1
    let bestD = Infinity
    for (let t = 0; t < mesh.faceHash.length; t++) {
      if (mesh.faceHash[t] !== h) continue
      for (let c = 0; c < 3; c++) {
        const v = mesh.indices[t * 3 + c]
        const d = Math.hypot(mesh.positions[v * 3] - p[0], mesh.positions[v * 3 + 1] - p[1], mesh.positions[v * 3 + 2] - p[2])
        if (d < bestD) {
          bestD = d
          best = v
        }
      }
    }
    return best < 0 ? null : [mesh.normals[best * 3], mesh.normals[best * 3 + 1], mesh.normals[best * 3 + 2]]
  }
  const out: { hash: number; at: Vec3 }[] = []
  for (const end of open) {
    const at = new Set<number>()
    for (const e of edges) if (!chain.has(e.hash) && (near(e.ends[0], end.at) || near(e.ends[1], end.at))) for (const f of e.faceHashes) if (!own.has(f)) at.add(f)
    for (const h of at) {
      if (out.some((x) => x.hash === h)) continue
      const n = normalAt(h, end.at)
      if (n !== null && n[0] * end.out[0] + n[1] * end.out[1] + n[2] * end.out[2] < RUNS_INTO_COS) out.push({ hash: h, at: end.at })
    }
  }
  return out
}

/** A feature as a diagnosis names it: its name and id, or its id alone. */
function featureNamed(builder: Builder, id: number): string {
  const name = builder.nameOf(id)
  return name !== undefined ? `${name} (feature ${id})` : `feature ${id}`
}

/** A face of a body as a diagnosis names it: by its index in
 *  reverse.body.describe, its surface and the feature that made it — or,
 *  given the step, the helper body it bounds (makerNamer). */
function faceNamer(kernel: ReKernel, builder: Builder, body: Body, step?: { id: number; body: number }): (h: number) => string {
  const faces = kernel.faces(body.shape)
  const indexOf = new Map(faces.map((f, i) => [f.hash, i]))
  const maker = step ? makerNamer(builder, body, step) : null
  return (h) => {
    const i = indexOf.get(h)
    const made = body.origins.get(h)
    const helper = maker?.(h)
    const what = [i !== undefined ? surfaceName(faces[i].kind) : null, helper?.helper ? helper.words : made !== undefined ? `made by ${featureNamed(builder, made)}` : null].filter((x) => x !== null).join(', ')
    return `face ${i ?? '?'}${what ? ` (${what})` : ''}`
  }
}

/** A helper body a face bounds: the tool's maker, and the cut or the
 *  intersect that left its side on the part (Builder.helperOf). */
type Helper = { tool: number; by: number; op: 'cut' | 'intersect' }

/** A face's maker as a diagnosis says it — `words`, and `short` in a list
 *  of edges — with the helper, for a face a cut's or an intersect's tool
 *  body brought onto the part. */
type MakerNamer = (h: number) => { words: string; short: string; helper?: Helper } | null

/** Names the faces of `body` by their makers, as they stood for `step`. */
function makerNamer(builder: Builder, body: Body, step: { id: number; body: number }): MakerNamer {
  return (h) => {
    const made = body.origins.get(h)
    if (made === undefined) return null
    const helper = builder.helperOf(made, step.body, step.id)
    if (!helper) return { words: `a face of ${featureNamed(builder, made)}`, short: `a face of ${featureNamed(builder, made)}` }
    const tool = featureNamed(builder, helper.tool)
    return { words: `a bounding face of the helper ${tool}, left by ${featureNamed(builder, helper.by)}`, short: `a bounding face of the helper ${tool}`, helper }
  }
}

/** A failing edge or chain's place and the makers of the faces either side
 *  — two of one maker said once. */
function edgeWhere(edges: readonly RawEdge[], c: { picked: number[]; whole: number[] }, maker: MakerNamer): { at: string; between: string } {
  const first = edges.find((e) => e.hash === c.picked[0]) ?? edges.find((e) => e.hash === c.whole[0])
  if (!first) return { at: '', between: '' }
  const faces = [...new Set(edges.filter((e) => c.whole.includes(e.hash)).flatMap((e) => e.faceHashes))]
  const words = [...new Set(faces.map((h) => maker(h)?.short ?? 'a face'))]
  const own = 'a face of '
  const between = words.length === 1 && faces.length > 1 ? (words[0].startsWith(own) ? `two faces of ${words[0].slice(own.length)}` : `two faces, each ${words[0]}`) : words.slice(0, 3).join(' and ')
  return { at: point(first.mid), between }
}

/** Where a failing edge or chain is, as a list of them names it: the middle
 *  of its first edge picked and the makers of the faces either side, so
 *  "the edge, the edge" reads as which. */
function edgePlace(edges: readonly RawEdge[], c: { picked: number[]; whole: number[] }, maker: MakerNamer): string {
  const { at, between } = edgeWhere(edges, c, maker)
  return at ? ` at ${at} between ${between}` : ''
}

/** How many failing edges or chains a message names one by one, and how
 *  many groups of them past that. */
const PLACES_LISTED = 3
const GROUPS_LISTED = 4

/** The failing edges or chains of a message: each by itself up to
 *  PLACES_LISTED, past that grouped by what lies either side, with the first
 *  place of each — the last fan's rounds spent 4.5 k on 24 chains between the
 *  same three features, repeated in every later answer. */
export function listFailing(failing: readonly { words: string; at: string; between: string }[], unit: 'edges' | 'chains'): string {
  if (failing.length <= PLACES_LISTED) return failing.map((f) => f.words).join(', ')
  const groups = new Map<string, { words: string; at: string; between: string }[]>()
  for (const f of failing) groups.set(f.between, [...(groups.get(f.between) ?? []), f])
  const ranked = [...groups.values()].sort((a, b) => b.length - a.length)
  const said = ranked.slice(0, GROUPS_LISTED).map((g) => (g.length === 1 ? g[0].words : `${g.length} ${unit} between ${g[0].between}, the first at ${g[0].at}`))
  const left = ranked.slice(GROUPS_LISTED).reduce((n, g) => n + g.length, 0)
  return `${said.join('; ')}${left > 0 ? `; and ${left} more` : ''}`
}

/** The helper bodies a failing round's edges or the small faces beside
 *  them belong to (makerNamer), each once. */
function helpersAt(hashes: readonly number[], edges: readonly RawEdge[], beside: readonly { hash: number }[], maker: MakerNamer): Helper[] {
  const out = new Map<number, Helper>()
  const faces = [...edges.filter((e) => hashes.includes(e.hash)).flatMap((e) => e.faceHashes), ...beside.map((b) => b.hash)]
  for (const h of faces) {
    const helper = maker(h)?.helper
    if (helper && !out.has(helper.tool)) out.set(helper.tool, helper)
  }
  return [...out.values()]
}

/** What a diagnosis says of helper bodies' sides on the part: a cut's or
 *  an intersect's tool leaves its bounding faces where it ends inside the
 *  body — a seam a round then has to run across — and the ways round. */
function helperText(builder: Builder, helpers: readonly Helper[], verb: 'round' | 'chamfer'): string {
  if (helpers.length === 0) return ''
  const one = helpers.length === 1
  const tools = helpers.map((x) => featureNamed(builder, x.tool)).join(' and ')
  const by = [...new Set(helpers.map((x) => featureNamed(builder, x.by)))].join(' and ')
  const ops = [...new Set(helpers.map((x) => (x.op === 'cut' ? 'the cut' : 'the intersect')))].join(' or ')
  return ` ${tools} ${one ? 'is a helper body' : 'are helper bodies'}: ${one ? 'its' : 'their'} bounding faces stay on the part where ${by} left them — move or oversize that side, or ${verb} before ${ops}.`
}

/** What a failing round's or chamfer's chains run into at their ends, as
 *  the diagnosis says it — per chain, the faces at its open ends that are
 *  not its own and face back at it (facesRunInto), and the ways round:
 *  end it at a sharp corner, draw it in the sketch, or make it before the
 *  feature that brought the wall when that came after the chain's own
 *  faces. Empty when no chain runs into anything. */
function runsIntoText(
  kernel: ReKernel,
  builder: Builder,
  body: Body,
  edges: readonly RawEdge[],
  failing: readonly { picked: number[]; whole: number[] }[],
  verb: 'round' | 'chamfer',
  subject: (c: { picked: number[]; whole: number[] }) => string,
  step?: { id: number; body: number },
): string {
  const name = faceNamer(kernel, builder, body, step)
  const clauses: string[] = []
  const later = new Set<number>()
  for (const c of failing) {
    const into = facesRunInto(kernel, body.shape, edges, c.whole)
    if (into.length === 0) continue
    clauses.push(`${subject(c)} runs into ${into.map((x) => `${name(x.hash)} at ${point(x.at)}`).join(' and ')}`)
    // The makers of the chain's own faces: a wall made after all of them
    // can come after the round instead.
    const makers = new Set<number>()
    for (const e of edges) if (c.whole.includes(e.hash)) for (const f of e.faceHashes) if (body.origins.has(f)) makers.add(body.origins.get(f)!)
    for (const x of into) {
      const m = body.origins.get(x.hash)
      if (m !== undefined && makers.size > 0 && [...makers].every((o) => o < m)) later.add(m)
    }
  }
  if (clauses.length === 0) return ''
  const more = clauses.length - PLACES_LISTED
  if (more > 0) clauses.splice(PLACES_LISTED, more, `and ${more} more`)
  const inSketch = verb === 'round' ? 'round it in the sketch (reverse.sketch.edit add.rounds) instead' : 'draw it in the sketch instead'
  const before = later.size > 0 ? `, or ${verb} before ${[...later].map((m) => featureNamed(builder, m)).join(' and ')}` : ''
  return ` ${clauses.join('; ')} — a ${verb} that ends against a wall often fails there: end it at a sharp corner, ${inSketch}${before}.`
}

/** A failed shell's diagnosis spends at most this many times the step's
 *  own time: each try is a whole shell, by up to three ways, and the
 *  halvings and the faces tried one at a time ran past the build's limit
 *  on a part whose shell takes half a minute. */
export const SHELL_DIAGNOSIS_TIMES = 2

/** …and never less than this, ms: a small part's shell fails in a tenth of
 *  a second, and its whole diagnosis takes a second or two. */
export const SHELL_DIAGNOSIS_LEAST_MS = 5000

/** The budget of a shell's diagnosis whose step took `stepMs`: how long it
 *  may take, and what a try is expected to take before one is timed — the
 *  step's own time, which tried the same ways and failed. */
export function shellDiagnosisBudget(stepMs: number): { ms: number; perTry: number } {
  return { ms: Math.max(SHELL_DIAGNOSIS_LEAST_MS, SHELL_DIAGNOSIS_TIMES * stepMs), perTry: stepMs }
}

/** What a diagnosis may still spend: its budget against what one more try
 *  is expected to take — the slowest timed so far, or before any the step's
 *  own time, which tried the same ways and failed. Only until a try is timed:
 *  one try of less than the whole step takes a fraction of it, and a slow
 *  step's time kept as the guess locked out the tries it could afford. */
class Budget {
  private readonly start = performance.now()
  /** The slowest try timed since the guess was given; null before one is. */
  private slowest: number | null = null
  constructor(
    readonly ms: number,
    private guess: number,
  ) {}
  private get expected(): number {
    return this.slowest ?? this.guess
  }
  /** Whether one more try fits in the time left. */
  affords(): boolean {
    return performance.now() - this.start + this.expected <= this.ms
  }
  timed<T>(fn: () => T): T {
    const began = performance.now()
    try {
      return fn()
    } finally {
      this.slowest = Math.max(this.slowest ?? 0, performance.now() - began)
    }
  }
  /** The tries from here on are larger than those timed so far — every chain
   *  at once, after one: expected at `guess`, or as those were if slower,
   *  until one is timed. */
  ahead(guess: number): void {
    this.guess = Math.max(guess, this.expected)
    this.slowest = null
  }
  get spent(): number {
    return performance.now() - this.start
  }
  get deadline(): number {
    return this.start + this.ms
  }
  /** What was left untried, as a sentence says it. */
  get over(): string {
    const s = (ms: number) => (ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms)} ms`)
    return `over budget (a try takes about ${s(this.expected)}, the diagnosis ${s(this.ms)} at most)`
  }
}

/**
 * Why a shell the kernel refused could not be made, within a budget of
 * twice the step's own time (`limit`, from shellDiagnosisBudget; none
 * given, no limit). What is read off the body comes first, no shell tried: the outside rounds no larger
 * than the wall, named, and the places thinner than two walls. Then, as
 * far as the budget goes: whether the wall fits with no face opened, the
 * faces offset by the wall one at a time, the largest wall by halving, and
 * the opened faces one at a time. What the budget did not reach is said —
 * "not bisected: over budget" — with what was found.
 */
export function diagnoseShell(kernel: ReKernel, builder: Builder, step: Extract<BuildStep, { kind: 'shell' }>, body: Body, limit?: { ms: number; perTry: number }, crashed = false): Diagnosis | null {
  const k = kernel
  const found = builder.findFaces(step.body, step.faces, step.id, { asked: step.facesWhere, quiet: true })
  if ('lost' in found) return null
  const t = step.thickness
  const budget = new Budget(limit?.ms ?? Infinity, limit?.perTry ?? 0)
  // What the kernel said when the last try failed — for the answer when
  // nothing on the body explains it.
  let refusal = ''
  // The step's own shell, on a kernel it crashed: known to fail, and not
  // played again to find out (issue 34).
  const isStep = (faces: readonly number[], at: number) =>
    crashed && at === t && faces.length === found.hashes.length && faces.every((h) => found.hashes.includes(h))
  const attempt = (faces: readonly number[], at: number): boolean =>
    budget.timed(() => {
      if (isStep(faces, at)) {
        refusal = 'the kernel crashed on it'
        return false
      }
      try {
        const r = k.shellTracked(body.shape, faces, at)
        const ok = k.isClosedSolid(r.shape)
        k.release(r.shape)
        return ok
      } catch (e) {
        // A trap is no refusal: the kernel is broken, and nothing more is
        // tried on it (issue 34).
        if (isTrap(e) || k.trapped !== null) throw e
        // Refused at this thickness: that is the answer the try was for.
        refusal = said(e)
        return false
      }
    })
  const halved = (faces: readonly number[]) => largestSizeWhile(t, (at) => attempt(faces, at), () => budget.affords())
  const edges = k.edges(body.shape, meshDeflection(diagonalOf(kernel, body.shape)))
  const outlines = (faces: readonly number[]) => edges.filter((e) => e.faceHashes.some((h) => faces.includes(h)) && e.polyline.length >= 6).map((e) => e.polyline)
  const m = found.hashes.length
  // Read off the body, no shell tried: an outside round no larger than the
  // wall has no inside, and two walls do not fit where the body is thinner
  // than them.
  const rounds = k.collapsingRounds(body.shape, t)
  const thin = rounds.length > 0 ? [] : thinSpots(kernel, body, 2 * t)
  const faceOf = faceNamer(kernel, builder, body)
  // No shell lays a wall where the body is thinner than two: the ways
  // round — shelling before the feature that made the thin place, when
  // that is not the one the body began with, or an inner body cut out.
  const thinRoutes = (spots: readonly { face: number | null }[]): string => {
    const makers = [...new Set(spots.map((s) => (s.face !== null ? body.origins.get(s.face) : undefined)).filter((m): m is number => m !== undefined && m !== Math.floor(step.body)))]
    const before = makers.length > 0 ? `shell before ${makers.map((m) => featureNamed(builder, m)).join(' and ')}, or ` : ''
    return `${before}cut an inner body (a sketch's inset, offsetBody) from it instead`
  }
  // Whether the wall fits the body with no face opened — with none opened
  // that is the step's own try, failed already. Null: not tried, over
  // budget.
  const closed = m === 0 ? false : budget.affords() ? attempt([], t) : null
  if (closed === false || (closed === null && (rounds.length > 0 || thin.length > 0))) {
    // The wall does not fit the body — or, untried, what was read off it
    // says so: an outside round no larger than the wall, the body thinner
    // somewhere than two walls, a face of it curving tighter than the
    // wall, or a face of it narrower than the wall — a strip the inward
    // offset would have to lose, which the kernel's offset cannot.
    const failed = refusal
    const fits = `A wall of ${mm(t)} does not fit the body${closed === false && m > 0 ? ' even with no face opened' : ''}`
    if (rounds.length > 0) {
      const n = rounds.length
      const why = `${n === 1 ? 'an outside round of the body is' : `${n} outside rounds of the body are`} no larger than the wall — ${roundsNamed(kernel, body, rounds)}, drawn red on the part — and the wall could not be cut back behind ${n === 1 ? 'it' : 'them'}`
      return { message: `${fits}: ${why}. ${hollowsAt(halved([]), budget)}`, where: outlines(rounds) }
    }
    // No round to blame: the thinnest places, and the faces that do not
    // offset by the wall alone — read before the halving, which costs a
    // whole shell a try.
    const thinly = thin.length > 0 ? `the body is thinner than two walls (${mm(2 * t)}) at ${thin.map((s) => `${point(s.at)}, ${mm(s.thickness)} thick${s.face !== null ? ` on ${faceOf(s.face)}` : ''}`).join(', and at ')} — marked red on the part` : null
    const alone = facesAlone(kernel, body, -t, 'wall', outlines, budget.deadline)
    const why = [thinly, alone.why].filter((x) => x !== null).join('; and ')
    const upTo = halved([])
    const can = hollowsAt(upTo, budget)
    const folded = alone.folds !== null && upTo.size > alone.folds + 0.05 ? ` Past ${mm(alone.folds)} the inside of the wall folds over itself where the face curves tighter — the kernel passes it: keep the wall under that, or ease the bend.` : ''
    const routes = thin.length > 0 ? ` No wall of ${mm(t)} fits where the body is under ${mm(2 * t)}: ${thinRoutes(thin)}.` : ''
    if (why !== '') return { message: `${fits}: ${why}. ${can}${folded}${routes}`, where: [...thin.map((s) => s.mark), ...alone.where] }
    return { message: `${fits}: the kernel's offset failed${failed ? ` (${failed})` : ''}, no thin spot found, and ${alone.every} — so it fails where faces meet: an edge or a corner the offset faces cannot be joined at, or a face narrower than the wall. ${can}`, where: [] }
  }
  if (closed === null) {
    // Nothing read off the body, and no time to try the shell closed: the
    // faces offset alone are cheap, and all there is left to say.
    const alone = facesAlone(kernel, body, -t, 'wall', outlines, budget.deadline)
    const none = 'no outside round of the body is no larger than the wall, and it is nowhere thinner than two walls'
    const untried = `whether the wall fits with no face opened, and the faces opened one at a time, were not tried: ${budget.over}`
    if (alone.why !== null) return { message: `The shell at a wall of ${mm(t)} failed, likely because ${alone.why}; ${none}. Not bisected: ${budget.over}.`, where: alone.where }
    return { message: `The shell at a wall of ${mm(t)} failed: ${none}, and ${alone.every}; ${untried}.`, where: [] }
  }
  // The wall fits closed: it is the faces opened.
  const probed = found.hashes.slice(0, DIAGNOSE_PICKS)
  const tried: number[] = []
  const failing: number[] = []
  for (const h of probed) {
    if (!budget.affords()) break
    tried.push(h)
    if (!attempt([h], t)) failing.push(h)
  }
  const cut = tried.length < probed.length
  const short = cut ? ` (the first ${tried.length} tried; the rest not: ${budget.over})` : probed.length < m ? ` (the first ${probed.length} tried)` : ''
  if (failing.length > 0) {
    const n = failing.length
    const each = failing.map((h) => halved([h]))
    const upTo = Math.min(...each.map((x) => x.size))
    const which = m === 1 ? 'The face cannot be opened' : n === m ? `None of the ${m} faces can be opened` : `${n} of the ${m} faces cannot be opened`
    const shown = n < tried.length ? ' — outlined red on the part; the others tried can' : ' — outlined red on the part'
    const can = each.some((x) => !x.settled)
      ? `${n === 1 ? 'Its' : 'Their'} largest wall was not bisected: ${budget.over}.`
      : upTo > 0
        ? `${n === 1 ? 'It opens' : 'They open'} at a wall of up to ${mm(upTo)}.`
        : `${n === 1 ? 'It does' : 'They do'} not open at any wall — the wall cannot follow the edges round ${n === 1 ? 'the face' : 'them'}; open a neighbouring face as well, or leave ${n === 1 ? 'it' : 'them'} closed.`
    return { message: `${which} at a wall of ${mm(t)}${short}${shown}. ${can}`, where: outlines(failing) }
  }
  if (cut) return { message: `A wall of ${mm(t)} fits the body closed, and the first ${tried.length} of the ${m} faces open alone at it; the rest were not tried: ${budget.over}.`, where: [] }
  if (m < 2 || probed.length < m) return null
  const together = halved(found.hashes)
  const can = !together.settled ? `Together they were not bisected: ${budget.over}.` : together.size > 0 ? `Together they open at a wall of up to ${mm(together.size)}.` : 'Open them in two shells, or leave one closed.'
  return { message: `Each of the ${m} faces opens alone at a wall of ${mm(t)}; together they do not. ${can}`, where: outlines(found.hashes) }
}

/** The largest wall a shell takes, as the diagnosis says it — or how far
 *  the halving got before the budget ran out. */
function hollowsAt(upTo: { size: number; settled: boolean }, budget: Budget): string {
  if (upTo.settled) return upTo.size > 0 ? `It hollows at a wall of up to ${mm(upTo.size)}.` : 'It does not hollow at any wall.'
  return upTo.size > 0 ? `It hollows at a wall of ${mm(upTo.size)} at least — not bisected further: ${budget.over}.` : `Not bisected: ${budget.over}.`
}

/** Outside rounds of a body, by hash, as a diagnosis names them: by their
 *  index in reverse.body.describe, their surface and radius, and the
 *  feature that made them — the smallest first, three at most, and how
 *  many more. */
function roundsNamed(kernel: ReKernel, body: Body, rounds: readonly number[]): string {
  const faces = kernel.faces(body.shape)
  const indexOf = new Map(faces.map((f, i) => [f.hash, i]))
  const radius = (h: number) => faces[indexOf.get(h) ?? -1]?.radius ?? Infinity
  const named = [...rounds].sort((a, b) => radius(a) - radius(b)).slice(0, THIN_SPOTS).map((h) => {
    const i = indexOf.get(h)
    const f = i !== undefined ? faces[i] : undefined
    const made = body.origins.get(h)
    const what = [f ? `${f.kind}${f.radius !== undefined ? ` of ${mm(f.radius)} radius` : ''}` : null, made !== undefined ? `made by feature ${made}` : null].filter((x) => x !== null).join(', ')
    return `face ${i ?? '?'}${what ? ` (${what})` : ''}`
  })
  const more = rounds.length > named.length ? ` and ${rounds.length - named.length} more` : ''
  return `${named.join(', ')}${more}`
}

/** Why a draft the kernel refused could not be made: the faces tried one at
 *  a time at the angle each was asked — those that do not lean alone, with
 *  the largest angle each takes — or, each leaning alone, the faces
 *  together. A face meeting one picked at a tangent edge, and not picked
 *  itself, is named: the kernel leans it with the face it meets. */
export function diagnoseDraft(kernel: ReKernel, builder: Builder, step: Extract<BuildStep, { kind: 'draft' }>, body: Body): Diagnosis | null {
  const k = kernel
  const found = builder.draftPicks(step)
  if ('lost' in found) return null
  const { origin, pull } = builder.draftNeutral(step, body)
  const angleOf = new Map(found.hashes.map((h, i) => [h, found.angles[i]]))
  const attempt = (faces: readonly number[], scale = 1): boolean => {
    try {
      const shape = k.draftFaces(body.shape, faces, origin, pull, faces.map((h) => scale * angleOf.get(h)!))
      const ok = k.isClosedSolid(shape)
      k.release(shape)
      return ok
    } catch (e) {
      if (isTrap(e) || k.trapped !== null) throw e
      // Refused at this angle: that is the answer the try was for.
      return false
    }
  }
  const edges = k.edges(body.shape, meshDeflection(diagonalOf(kernel, body.shape)))
  const outlines = (faces: readonly number[]) => edges.filter((e) => e.faceHashes.some((h) => faces.includes(h)) && e.polyline.length >= 6).map((e) => e.polyline)
  const instead = 'Or draw the slope into the profile instead — a drafted extrude, or a sketch that draws the sloped side — which leans the face as it is made.'
  const m = found.hashes.length
  if (m === 0) return null
  const one = new Set(found.angles).size === 1
  const degOf = (rad: number) => `${Math.round(((Math.abs(rad) * 180) / Math.PI) * 100) / 100}°`
  const at = one ? ` at ${degOf(found.angles[0])}` : ' at its angle'
  const tangent = tangentNeighbours(kernel, body, found.hashes, edges)
  const beside = tangent.beside
  // Two picks the kernel leans together, asked at two angles: that is
  // the failure, whatever else the body does.
  const clash = tangent.clashes.find(([a, b]) => Math.abs(angleOf.get(a)! - angleOf.get(b)!) > 1e-9)
  if (clash) {
    const [a, b] = clash
    return {
      message: `${tangent.name(a)[0].toUpperCase()}${tangent.name(a).slice(1)} and ${tangent.name(b)} meet at a tangent edge, or through faces that do, and are asked to lean at ${degOf(angleOf.get(a)!)} and ${degOf(angleOf.get(b)!)}: the kernel leans faces that meet tangent together, at one angle — give them the same angle, or draft before the round between them.`,
      where: outlines([a, b]),
    }
  }
  const them = (one: string, more: string) => (beside.length === 1 ? one : more)
  const besideSaid =
    beside.length > 0
      ? ` ${them('A face meets', `${beside.length} faces meet`)} those picked at a tangent edge and ${them('is', 'are')} not picked — ${beside.slice(0, 4).map((x) => x.name).join(', ')}${beside.length > 4 ? ` and ${beside.length - 4} more` : ''}: the kernel leans ${them('it', 'them')} with the face ${them('it meets', 'they meet')}, so the draft runs on round ${them('it', 'them')}; pick ${them('it', 'them')} too, at the same angle, or draft before the round that joins ${them('it', 'them')}.`
      : ''
  // A picked face meeting another a hair off tangent: leaned, the two meet
  // at a grazing angle the kernel cannot join — named before any probing,
  // which would only find a small angle and blame the room.
  const creased = grazingEdges(k, body, found.hashes, edges)
  if (creased.length > 0) {
    const named = creased.slice(0, 3).map((c) => `${tangent.name(c.faces[0])} and ${tangent.name(c.faces[1])} meet ${Number(c.deg.toPrecision(2))}° off tangent at (${c.edge.mid.map((x) => Math.round(x * 100) / 100).join(', ')})`)
    const more = creased.length > named.length ? ` (and ${creased.length - named.length} more)` : ''
    const one = creased.length === 1
    return {
      message: `${named.join('; ').replace(/^f/, 'F')}${more}: leaned, ${one ? 'they meet' : 'the faces there meet'} at a grazing angle the kernel cannot join — make ${one ? 'that join' : 'those joins'} of the profile tangent (reverse.sketch.edit rounds, a tangent relation) or a real corner (≥ 0.2°), or draw the slope into the profile with a drafted extrude, which makes such joins tangent itself.${besideSaid}`,
      where: creased.map((c) => c.edge.polyline),
    }
  }
  const probed = found.hashes.slice(0, DIAGNOSE_PICKS)
  const failing = probed.filter((h) => !attempt([h]))
  if (failing.length > 0) {
    const n = failing.length
    const upTo = Math.min(...failing.map((h) => largestSize(Math.abs(angleOf.get(h)!), (a) => attempt([h], a / Math.abs(angleOf.get(h)!)))))
    const which = m === 1 ? 'The face does not lean' : n === m ? `None of the ${m} faces leans` : `${n} of the ${m} faces do not lean`
    const shown = n < m ? ' — outlined red on the part; the others do' : ' — outlined red on the part'
    const can = upTo > 0 ? `${n === 1 ? 'It leans' : 'They lean'} up to ${degOf(upTo)} — past that ${n === 1 ? 'it runs' : 'they run'} out of room against the faces beside ${n === 1 ? 'it' : 'them'}: a round or a sliver there (draft before rounding, or take the sliver out upstream), or the body's own width.` : `${n === 1 ? 'It does' : 'They do'} not lean at any angle about this neutral plane — ${n === 1 ? 'its' : 'their'} edges with the neighbouring faces cannot follow; draft the neighbours with ${n === 1 ? 'it' : 'them'}, or leave ${n === 1 ? 'it' : 'them'} out.`
    return { message: `${which}${at}${shown}. ${can}${besideSaid} ${instead}`, where: [...outlines(failing), ...outlines(beside.map((b) => b.hash))] }
  }
  if (m < 2 || probed.length < m) return beside.length > 0 ? { message: `The draft fails${at}.${besideSaid} ${instead}`, where: outlines(beside.map((b) => b.hash)) } : null
  const together = largestSize(1, (f) => attempt(found.hashes, f))
  const can = together > 0 ? (one ? `Together they lean up to ${degOf(together * found.angles[0])}.` : `Together they lean up to ${Math.floor(together * 100)} % of the angles asked.`) : 'Draft them in two features, one after the other.'
  return { message: `Each of the ${m} faces leans alone${at}; together they do not — they run into each other, or meet at an edge the kernel cannot lean both ways. ${can}${besideSaid} ${instead}`, where: [...outlines(found.hashes), ...outlines(beside.map((b) => b.hash))] }
}

/** Creases a draft cannot lean across, in degrees: a hair off tangent and
 *  no more — under it the faces lean together, past it as a corner. */
const GRAZING_DEG = [0.01, 0.5] as const

/** The edges of picked faces where the two faces meet a hair off tangent
 *  (GRAZING_DEG), by their normals at the edge's middle — the most nearly
 *  tangent first. */
function grazingEdges(kernel: ReKernel, body: Body, picked: readonly number[], edges: readonly RawEdge[]): { edge: RawEdge; faces: [number, number]; deg: number }[] {
  const pickedSet = new Set(picked)
  const candidates = edges.filter((e) => e.faceHashes.length === 2 && e.faceHashes[0] !== e.faceHashes[1] && e.faceHashes.some((h) => pickedSet.has(h)))
  if (candidates.length === 0) return []
  let sides
  try {
    sides = kernel.edgeSides(body.shape, candidates.map((e) => e.hash))
  } catch (e) {
    if (isTrap(e) || kernel.trapped !== null) throw e
    // Not read: nothing to add.
    return []
  }
  const out: { edge: RawEdge; faces: [number, number]; deg: number }[] = []
  candidates.forEach((edge, i) => {
    const s = sides[i]
    if (!s) return
    const [a, b] = s.normals
    const deg = (Math.atan2(Math.hypot(...cross(a, b)), a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) * 180) / Math.PI
    if (deg >= GRAZING_DEG[0] && deg <= GRAZING_DEG[1]) out.push({ edge, faces: s.faces, deg })
  })
  return out.sort((x, y) => x.deg - y.deg)
}

/** How the faces a draft picks run on into others across tangent edges
 *  (or a split of one surface), as the kernel's draft runs on: `beside`,
 *  the faces reached that are not picked, each by its index in
 *  reverse.body.describe and its kind; `clashes`, pairs of picks reached
 *  one from the other, which lean together. Read off the body's mesh,
 *  where the faces' normals agree across the edge. */
function tangentNeighbours(kernel: ReKernel, body: Body, picked: readonly number[], edges: readonly RawEdge[]): { beside: { hash: number; name: string }[]; clashes: [number, number][]; name: (hash: number) => string } {
  const faces = kernel.faces(body.shape)
  const byHash = new Map(faces.map((f) => [f.hash, f]))
  const indexOf = new Map(faces.map((f, i) => [f.hash, i]))
  const name = (h: number) => {
    const f = byHash.get(h)
    return `face ${indexOf.get(h) ?? '?'}${f ? ` (${f.kind}${f.radius !== undefined ? ` of ${mm(f.radius)} radius` : ''})` : ''}`
  }
  const none = { beside: [], clashes: [], name }
  let mesh
  try {
    mesh = kernel.mesh(body.shape, meshDeflection(diagonalOf(kernel, body.shape)))
  } catch (e) {
    if (isTrap(e) || kernel.trapped !== null) throw e
    // No mesh, no reading of how the faces meet: nothing to add.
    return none
  }
  if (!mesh.faceHash) return none
  const oneSurface = (a: number, b: number) => {
    const fa = byHash.get(a)
    const fb = byHash.get(b)
    return fa !== undefined && fb !== undefined && onOneSurface(fa, fb)
  }
  const { joins } = edgeShares(mesh.positions, mesh.normals, mesh.indices, mesh.faceHash, edges.map((e) => ({ hash: e.hash, faces: e.faceHashes, polyline: e.polyline })), oneSurface)
  const smooth = edges.filter((e) => e.faceHashes.length === 2 && e.faceHashes[0] !== e.faceHashes[1] && (joins.get(e.hash) === 'tangent' || joins.get(e.hash) === 'split'))
  // Each face reached, by the pick it was reached from first.
  const from = new Map<number, number>()
  const pickedSet = new Set(picked)
  const beside: number[] = []
  const clashes: [number, number][] = []
  for (const p of picked) {
    if (from.has(p)) {
      if (from.get(p) !== p) clashes.push([from.get(p)!, p])
      continue
    }
    from.set(p, p)
    const queue = [p]
    while (queue.length > 0) {
      const h = queue.shift()!
      for (const e of smooth) {
        const [a, b] = e.faceHashes
        const other = a === h ? b : b === h ? a : null
        if (other === null || from.has(other)) continue
        from.set(other, p)
        if (!pickedSet.has(other)) beside.push(other)
        queue.push(other)
      }
    }
  }
  return { beside: beside.map((h) => ({ hash: h, name: name(h) })), clashes, name }
}

/** Why an offset of a whole body the kernel refused could not be made.
 *  Inward, as a shell with no face opened: an outside round no larger than
 *  the distance has no inside to shrink to, where the body is thinner
 *  than twice the distance the two sides meet, and a face that curves
 *  tighter than the distance folds — each named by its face, by its index
 *  in reverse.body.describe, and drawn red — with the largest distance
 *  that offsets. Outward, a face that hollows tighter than the distance;
 *  where a hollow closes up is not read. With nothing found, the kernel's
 *  own words. */
export function diagnoseOffset(kernel: ReKernel, step: Extract<BuildStep, { kind: 'offsetBody' }>, body: Body, crashed?: { deadline: number }): Diagnosis | null {
  const k = kernel
  const d = step.distance
  const t = Math.abs(d)
  if (!(t > 0)) return null
  let refusal = ''
  const attempt = (at: number): boolean => {
    try {
      k.release(k.offsetSolid(body.shape, Math.sign(d) * at))
      return true
    } catch (e) {
      if (isTrap(e) || k.trapped !== null) throw e
      // Refused at this distance: that is the answer the try was for.
      refusal = said(e)
      return false
    }
  }
  // After a crash (`crashed`) the whole body is not offset again — that is
  // what crashed the kernel — and only the body and its faces one at a
  // time are read, none begun past the deadline.
  const upTo = crashed ? null : largestSize(t, attempt)
  // What the kernel said at the distance asked, for when nothing on the
  // body explains it: one more offset, asked only then.
  const failed = () => (crashed ? null : attempt(t) ? null : refusal)
  const can = upTo === null ? '' : upTo > 0 ? ` It offsets ${d > 0 ? 'outward' : 'inward'} by up to ${mm(upTo)}.` : ` It does not offset ${d > 0 ? 'outward' : 'inward'} at any distance.`
  const faces = k.faces(body.shape)
  const indexOf = new Map(faces.map((f, i) => [f.hash, i]))
  const edges = k.edges(body.shape, meshDeflection(diagonalOf(kernel, body.shape)))
  const outlines = (hashes: readonly number[]) => edges.filter((e) => e.faceHashes.some((h) => hashes.includes(h)) && e.polyline.length >= 6).map((e) => e.polyline)
  if (d > 0) {
    const alone = facesAlone(kernel, body, t, 'distance', outlines, crashed?.deadline)
    if (alone.why !== null) return { message: `The body does not offset outward by ${mm(t)}: ${alone.why}.${can}`, where: alone.where }
    return { message: `The body does not offset outward by ${mm(t)}: the kernel's offset failed (${failed() ?? 'at this distance'}), and ${alone.every}, so a hollow, a slot or a gap in it narrower than ${mm(2 * t)} likely closes up.${can}`, where: [] }
  }
  const rounds = k.collapsingRounds(body.shape, t)
  if (rounds.length > 0) {
    const named = rounds.slice(0, THIN_SPOTS).map((h) => {
      const f = faces[indexOf.get(h) ?? -1]
      return `face ${indexOf.get(h) ?? '?'}${f?.radius !== undefined ? ` (${f.kind} of ${mm(f.radius)} radius)` : f ? ` (${f.kind})` : ''}`
    })
    const more = rounds.length > named.length ? ` and ${rounds.length - named.length} more` : ''
    return { message: `The body does not offset inward by ${mm(t)}: ${rounds.length === 1 ? 'an outside round is' : `${rounds.length} outside rounds are`} no larger than that — ${named.join(', ')}${more}, drawn red on the part — and ${rounds.length === 1 ? 'it shrinks' : 'they shrink'} to nothing.${can}`, where: outlines(rounds) }
  }
  const thin = thinSpots(kernel, body, 2 * t)
  const where = (s: (typeof thin)[number]) => {
    const i = s.face !== null ? indexOf.get(s.face) : undefined
    const kind = i !== undefined && faces[i].kind !== 'other' ? ` (${faces[i].kind})` : ''
    return `${mm(s.thickness)} thick behind ${i !== undefined ? `face ${i}${kind}` : 'a face'} at ${point(s.at)}`
  }
  const thinly = thin.length > 0 ? `the body is thinner than twice that (${mm(2 * t)}): ${thin.map(where).join('; ')} — marked red on the part` : null
  const alone = facesAlone(kernel, body, -t, 'distance', outlines, crashed?.deadline)
  const why = [thinly, alone.why].filter((x) => x !== null).join('; and ')
  const folded = alone.folds !== null && upTo !== null && upTo > alone.folds + 0.05 ? ` Past ${mm(alone.folds)} the offset folds over itself where the face curves tighter — the kernel passes it: keep under that, or ease the bend.` : ''
  if (why !== '') return { message: `The body does not offset inward by ${mm(t)}: ${why}.${can}${folded}`, where: [...thin.map((s) => s.mark), ...alone.where] }
  return {
    message: `The body does not offset inward by ${mm(t)}: the kernel's offset failed (${failed() ?? 'at this distance'}), no thin spot found, and ${alone.every} — so it fails where faces meet: an edge or a corner the offset faces cannot be joined at, or a face narrower than ${mm(t)}.${can}`,
    where: [],
  }
}

/** A surface as a sentence names it. */
function surfaceName(kind: string): string {
  const names: Record<string, string> = { bspline: 'B-spline', bezier: 'Bézier', offset: 'offset surface', revolution: 'surface of revolution', extrusion: 'extruded surface' }
  return names[kind] ?? kind
}

/**
 * The faces of a body that do not offset by `distance` (negative inward)
 * alone — see faceOffsetLimits — as a diagnosis names them: by their
 * index in reverse.body.describe, their surface and the feature that made
 * them, with the largest distance each takes and why, three at most, the
 * nearest to nothing first; outlined, and a cross where one folds. `why`
 * is null when every face tried takes the distance, which `every` says;
 * `folds` is the smallest distance a face takes before it folds over
 * itself, or null where none folds. `as` is what the
 * distance is to the sentence: a shell's wall, an offset's distance. No
 * face is begun past `deadline` (performance.now()).
 */
function facesAlone(kernel: ReKernel, body: Body, distance: number, as: string, outlines: (hashes: readonly number[]) => Float32Array[], deadline?: number): { why: string | null; every: string; folds: number | null; where: Float32Array[] } {
  const t = Math.abs(distance)
  const dir = distance < 0 ? 'inward' : 'outward'
  let probe: { faces: FaceOffsetLimit[]; curved: number }
  try {
    probe = kernel.faceOffsetLimits(body.shape, distance, undefined, deadline)
  } catch (e) {
    if (isTrap(e) || kernel.trapped !== null) throw e
    // The probe failing itself has nothing to add.
    probe = { faces: [], curved: 0 }
  }
  const tried = probe.faces.length < probe.curved ? ` (the first ${probe.faces.length} of its ${probe.curved} curved faces tried)` : ''
  const every = `every face of it offsets ${dir} by ${mm(t)} alone${tried}`
  const failing = probe.faces.filter((f) => f.upTo < t * (1 - 1e-6)).sort((a, b) => a.upTo - b.upTo)
  if (failing.length === 0) return { why: null, every, folds: null, where: [] }
  const indexOf = new Map(kernel.faces(body.shape).map((f, i) => [f.hash, i]))
  const name = (f: FaceOffsetLimit) => {
    const made = body.origins.get(f.hash)
    return `face ${indexOf.get(f.hash) ?? '?'} (${surfaceName(f.surface)}${made !== undefined ? `, made by feature ${made}` : ''})`
  }
  const folds = (f: FaceOffsetLimit) => f.bend !== null && f.bend.radius <= f.upTo * (1 + 1e-6) + 1e-9
  const how = (f: FaceOffsetLimit) =>
    folds(f) ? `it ${distance < 0 ? 'curves' : 'hollows'} tighter than that at ${point(f.bend!.at)}, where its offset folds over itself` : `the kernel refuses its offset past that${f.refused ? ` (${f.refused})` : ''}`
  const named = failing.slice(0, THIN_SPOTS).map((f) => `${name(f)} by ${mm(f.upTo)} at most — ${how(f)}`)
  const more = failing.length > named.length ? `; and ${failing.length - named.length} more` : ''
  const n = failing.length
  const why = `${n === 1 ? 'a face of it offsets' : `${n} faces of it offset`} ${dir} by less than the ${as} alone${tried}: ${named.join('; ')}${more} — outlined red on the part`
  // A cross through the tightest point, along the axes, as wide as the
  // distance or a fiftieth of the body.
  const r = Math.max(t, diagonalOf(kernel, body.shape) * 0.02)
  const crosses = failing.filter(folds).map((f) => {
    const [x, y, z] = f.bend!.at
    return Float32Array.from([x - r, y, z, x + r, y, z, x, y, z, x, y - r, z, x, y + r, z, x, y, z, x, y, z - r, x, y, z + r])
  })
  const folding = failing.filter(folds)
  return { why, every, folds: folding.length > 0 ? folding[0].upTo : null, where: [...outlines(failing.map((f) => f.hash)), ...crosses] }
}

/**
 * Where a body is thinner than `limit`, probed from every vertex of its
 * mesh straight down the normal to the far wall: the thinnest places,
 * no two within a few walls of each other, each with a small cross to
 * draw on the part and the face it lies on, by hash. Empty where nothing
 * is that thin.
 */
function thinSpots(kernel: ReKernel, body: Body, limit: number): { at: Vec3; thickness: number; mark: Float32Array; face: number | null }[] {
  const diagonal = diagonalOf(kernel, body.shape)
  const mesh = kernel.mesh(body.shape, meshDeflection(diagonal))
  if (mesh.indices.length < 3) return []
  // The index is built on a copy: the tree reorders what it is given.
  const bvh = buildSolidIndex(mesh.positions, mesh.indices.slice())
  // The far wall has to face the ray: at an inner corner the ray from
  // one face grazes the other at no distance, and that is no wall.
  const thickness = computeThickness(bvh, mesh.positions, mesh.normals, {
    method: 'ray',
    coneRays: 0,
    coneAngle: 0,
    maxNormalDeviation: (DEFAULT_NORMAL_DEVIATION_DEG * Math.PI) / 180,
    maxThickness: limit,
    epsilon: Math.max(1e-4, limit * 1e-3),
  })
  const order: number[] = []
  for (let v = 0; v < thickness.length; v++) if (Number.isFinite(thickness[v]) && thickness[v] < limit * (1 - 1e-6)) order.push(v)
  order.sort((a, b) => thickness[a] - thickness[b])
  const apart = Math.max(3 * limit, diagonal * 0.05)
  // The face each vertex lies on: the kernel meshes face by face, so a
  // vertex is on one.
  const faceOfVertex = new Map<number, number>()
  if (mesh.faceHash) for (let i = 0; i < mesh.indices.length; i++) faceOfVertex.set(mesh.indices[i], mesh.faceHash[Math.floor(i / 3)])
  const spots: { at: Vec3; thickness: number; mark: Float32Array; face: number | null }[] = []
  for (const v of order) {
    if (spots.length >= THIN_SPOTS) break
    const at: Vec3 = [mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]]
    if (spots.some((s) => Math.hypot(s.at[0] - at[0], s.at[1] - at[1], s.at[2] - at[2]) < apart)) continue
    // A cross in the face, as long as the wall is wide, to draw there.
    const n: Vec3 = [mesh.normals[v * 3], mesh.normals[v * 3 + 1], mesh.normals[v * 3 + 2]]
    const seed: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
    const u: Vec3 = normalize(cross(n, seed)) ?? [1, 0, 0]
    const w = cross(n, u)
    const r = Math.max(limit, diagonal * 0.02)
    const a = addScaled(at, u, -r), b = addScaled(at, u, r), c = addScaled(at, w, -r), d = addScaled(at, w, r)
    spots.push({ at, thickness: thickness[v], mark: Float32Array.from([...a, ...b, ...at, ...c, ...d]), face: faceOfVertex.get(v) ?? null })
  }
  return spots
}

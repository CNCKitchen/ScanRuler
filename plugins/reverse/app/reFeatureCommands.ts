// SPDX-License-Identifier: AGPL-3.0-only
// reverse.feature.* and reverse.build: the feature list read, features added,
// changed, removed, suppressed and rolled back, the part built; a sketch
// edited in place; a STEP file brought in as bodies.

import { fileNameSchema, invalid } from '../../../src/commands/core/common'
import { anyObject, arr, bool, bytes, enumOf, int, type JsonSchema, num, obj, oneOf, str, validate } from '../../../src/commands/schema'
import { decodeWhole } from '../../../src/core/parsers/text'
import { type Command, CommandError } from '../../../src/plugins/api'
import { bodyMaker, dependentsOf, type Feature, movedList, type SketchFeature } from '../core/features'
import { evaluateFor } from '../core/expression'
import { findRegions, matchRegions, picksGrew, picksSeen } from '../core/regions'
import { readPieces, rounding } from '../core/intent'
import { reassignCornerPoints, roundCorner, roundRadiusSigma, roundUnread } from '../core/roundCorner'
import { cloneSketch, entityOf, removeEntities, type Sketch, type SketchArc, type SketchEntity } from '../core/sketch'
import { withoutTarget } from '../state/reFeatureHelpers'
import { useReverse } from '../state/reStore'
import { barOut, bodiesChanged, bodyRows, type Detail, detailIn, elementAnswer, failures, featureAnswer, noneAnswer, openOut } from './reCommandAnswers'
import { allFeatures, bodyAt, bodyNamed, change, changesSoFar, featureNamed, gathered, type Json, planeOf, re, ready, type Ref, session, sketchNamed, solidsNamed, startPickLog, takePickLog, topologyOf, unwrapped, type Where, whereIndices, withStaged } from './reCommandCore'
import { isWhere } from '../core/where'
import { addFeature, addInsetTwin, updateFeature } from './reFeatureInput'
import { asksFit, FIT, type FitReading, markFitted, refitInput, resolveFits, unmarkFitted } from './reFit'
import { bodiesOut, featureBrief, featureOut, regionsOut, resultOut } from './reReadout'
import { EXAMPLE_NOTES, FEATURE_EXAMPLES, FEATURE_IN, FEATURE_KINDS, featureInBrief, featureOf, featureRef, handOut, partialOf, SHARED_NAMES, sharedPart, sketchAddIn, sketchFieldsNamed } from './reSchemas'
import { reverseSession } from './reSession'
import { failedWith, recordRemoved, REMOVED_SAY, usePlan } from './rePlan'
import { acceptOnDraft, draftOffsetDraft, fitDraftShared, type FitIn, type FittedOut, givenOut, madeOut, movedFar, movedPieces, offPieceOut, piecesSetOut, setPieces, type PreparedFit, prepareFit, projectDraft, type ProjectIn, putLanded, putSketch, renumberClashes, sketchOf } from './reSketchInput'

export const list: Command<{ feature?: Ref; detail?: 'brief' | 'full' }> = {
  name: 'list',
  title: 'List the features',
  description:
    'The feature list as it stands, in order: each feature’s row — id, name, kind, status (ok, failed with the message, rolled back), its key value and expressions, what it uses — the rollback bar and whether the build is done. Give feature for one feature whole: as the list stores it — the same JSON reverse.feature.add takes, with its id — and what the last build said of it (result: ok or failed, with the message); a sketch with its regions (each closed region’s key, area, a point inside it and its extent in the sketch’s u and v); a fitted piece’s slice points as a count (fitted). detail "full" gives every feature whole; "brief" one feature’s row.',
  input: obj({ feature: featureRef(), detail: enumOf(['brief', 'full'], 'brief: rows (the default for the list). full: each feature whole (the default for one feature).') }),
  readOnly: true,
  // A sketch read here is handed back: its coordinates must be the ones
  // the build has, to the last digit, or a face drawn on them is a hair
  // off the face it was meant to share.
  exact: true,
  run: async ({ feature, detail }) => {
    const s = session()
    const r = re()
    const one = feature !== undefined ? featureNamed(feature) : null
    const whole = detail === 'full' || (one !== null && detail === undefined)
    const entry = (f: Feature, rolledBack: boolean) =>
      whole
        ? {
            ...featureOut(f),
            ...(rolledBack ? { rolledBack: true } : { result: resultOut(r.results[f.id]) }),
            ...(f.kind === 'sketch' ? { regions: regionsOut(s.regionsOf(f)), ...openOut(s, f) } : {}),
          }
        : featureBrief(f, rolledBack)
    if (one) return entry(one, r.rolledBack.includes(one))
    return {
      features: [...r.features.map((f) => entry(f, false)), ...r.rolledBack.map((f) => entry(f, true))],
      rollback: barOut(),
      build: s.buildState(),
    }
  },
}

/** A name as the commands match it: whole, case and the spaces round it
 *  aside. */
const nameKey = (name: string) => name.trim().toLowerCase()

/** A name free for a feature: the next "name n" no feature has. */
function freeName(name: string, taken: readonly string[]): string {
  const base = name.trim().replace(/\s+\d+$/, '')
  for (let n = 2; ; n++) if (!taken.includes(nameKey(`${base} ${n}`))) return `${base} ${n}`
}

/** Refuse a name another feature has — features go by their names in the
 *  commands, and two of a name stop a later one that names it. `self` is
 *  the feature renamed; `also` names given earlier in the same batch. */
export function requireFreeName(name: unknown, self?: number, also: readonly string[] = []): void {
  if (typeof name !== 'string' || !name.trim()) return
  const other = allFeatures().find((f) => f.id !== self && nameKey(f.name) === nameKey(name))
  const taken = [...allFeatures().filter((f) => f.id !== self).map((f) => nameKey(f.name)), ...also.map(nameKey)]
  if (other) invalid(`Feature ${other.id} is already named “${other.name}” — the commands find features by name, so each needs its own: “${freeName(name, taken)}”, say.`)
  if (also.some((x) => nameKey(x) === nameKey(name))) invalid(`Two features in this batch are named “${name.trim()}” — give each its own (“${freeName(name, taken)}”, say); nothing was added.`)
}

/** One of several features, as feature takes it — its kind's fields
 *  described once, under feature. */
const featuresItem: JsonSchema = { type: 'object', properties: { kind: featureInBrief.properties!.kind }, required: ['kind'], additionalProperties: true }

export const add: Command<{ feature?: Json; features?: Json[]; detail?: Detail; after?: Ref }> = {
  name: 'add',
  title: 'Add a feature',
  description:
    'Add a feature at the end of the list (at the rollback bar), as the panel’s box makes it — or, with after, right after a feature further up the list: the part built as it stood there, the feature added, the features below rebuilt on it; several (features) go in one after another, in their order. Modelling, as in any CAD: a sketch on a plane (pieces, relations, dimensions), then features that use it (extrude or revolve its closed regions), then features on the bodies (fillet, chamfer, shell, hole, thread — edges and faces from reverse.body.describe). Numbers may be expressions over the model’s parameters (reverse.parameter.add) and change with them. Each kind’s fields, with an example: reverse.feature.schema { kind }; the model-reference guide says how a sketch is written ([u, v] on the sheet, shapes, patterns, infer joining the ends that meet, dimensions and datums to define it fully) and what a revolve, an extrude and a thread take. One undo step; returns once the bodies are rebuilt — read result.status: a feature can be made and still fail to build, and failed lists every one that did. Change a sketch piece by piece with reverse.sketch.edit.',
  input: obj({
    feature: featureInBrief,
    features: arr(featuresItem, 'Several features in place of one, added in order and each built before the next (an item may name what an earlier one made); the first refused stops the rest (stopped; kept names those added).', { minItems: 1 }),
    detail: detailIn,
    after: featureRef(),
  }),
  label: ({ feature, features }) => (features ? `add ${features.length} features` : `add ${feature?.kind === 'moveFace' ? 'move face' : String(feature?.kind)}${typeof feature?.name === 'string' ? ` “${feature.name}”` : ''}`),
  run: async ({ feature, features, detail = 'brief', after }) => {
    if ((feature === undefined) === (features === undefined)) invalid('Give feature, or features — one of them.')
    // Names checked before anything is added: one taken, or two alike in
    // a batch, would stop it half-way.
    const names: string[] = []
    for (const f of features ?? [feature!]) {
      requireFreeName(f.name, undefined, names)
      if (typeof f.name === 'string' && f.name.trim()) names.push(f.name)
    }
    const addAll = async (): Promise<Json> => {
      if (feature) return addOne(feature, detail)
      const added: unknown[] = []
      const had = new Set(allFeatures().map((f) => f.id))
      for (let i = 0; i < features!.length; i++) {
        try {
          added.push(await addOne(features![i], detail))
        } catch (e) {
          if (!(e instanceof CommandError)) throw e
          // What was added before the stop stays in the list, by name.
          const kept = allFeatures().filter((f) => !had.has(f.id)).map((f) => f.name)
          return { added, stopped: { index: i, kind: String(features![i].kind), code: e.code, message: e.message, kept } }
        }
      }
      return { added }
    }
    // Detail none: each feature's id and status with what every detail
    // keeps, and the bar and what failed once for them all — read as the
    // list stands at the end.
    const none = (out: Json): Json => {
      if (feature) return noneAnswer((out as { id: number }).id, out)
      const failed = failures()
      return {
        added: (out.added as Json[]).map((a) => {
          const { rollback: _bar, failed: _failed, ...own } = noneAnswer(a.id as number, a)
          void _bar
          void _failed
          return own
        }),
        ...(out.stopped ? { stopped: out.stopped } : {}),
        rollback: barOut(),
        ...(failed.length > 0 ? { failed } : {}),
      }
    }
    if (after === undefined) {
      const out = await addAll()
      return detail === 'none' && !feature ? none(out) : out
    }
    // Inserted: the bar put under the feature named, the part built as it
    // stood there — a pick by index then names the body as it was — the
    // feature added at the bar, and the bar put back at the end, the
    // features below rebuilt on what was added. One undo step in all.
    const anchor = featureNamed(after)
    const at = allFeatures().indexOf(anchor) + 1
    const before = bodyRows(reverseSession())
    let out: Json
    try {
      await change(() => re().rollTo(at), { now: true })
      out = await addAll()
    } finally {
      await change(() => re().rollTo(null))
    }
    if (detail === 'none') return none(out)
    // What failed while the bar stood higher is told again as it stands.
    const { failed: _then, ...added } = out
    void _then
    const failed = failures()
    return {
      ...added,
      insertedAfter: { id: anchor.id, name: anchor.name },
      rollback: barOut(),
      bodies: detail === 'full' ? bodiesOut(session()) : bodiesChanged(session(), before),
      ...(failed.length > 0 ? { failed } : {}),
    }
  },
}

/** What a fitted number's answer says: the reading, less how it was asked. */
const fittedOut = (fitted: Record<string, FitReading & { spec?: Json }>) =>
  Object.keys(fitted).length > 0 ? { fitted: Object.fromEntries(Object.entries(fitted).map(([k, { spec: _spec, ...v }]) => [k, v])) } : {}

/** One feature added, as the command adds it. */
async function addOne(asked: Json, detail: Detail) {
  if (asked.exprs !== undefined) noNumbers(String(asked.kind))
  // The kind's whole shape, held to here: the tool lists it loosely.
  const errors = validate(featureOf(String(asked.kind)), asked, 'input.feature')
  if (errors.length > 0) invalid(`${sketchFieldsNamed(errors).join('; ')} — reverse.feature.schema { kind: "${String(asked.kind)}" } gives the fields.`)
  if (asked.kind === 'loft' && (asked.sections !== undefined || asked.fit !== undefined || asked.inner !== undefined || asked.exprs !== undefined)) return addLoftStations(asked, detail)
  if (asked.kind === 'loft' && asked.sketches === undefined) invalid('A loft takes sketches — or sections: planes to fit its stations on (fit.like).')
  const solids = PER_SOLID.includes(String(asked.kind)) ? await solidsAsked(asked) : null
  if (solids) return addOnSolids(asked, solids, detail)
  // What each pick by index or query landed on, told back (picked).
  startPickLog()
  let picked: Json[] = []
  let feature: Json, fitted: Record<string, FitReading & { spec?: Json }>, id: number
  let extra: Json = {}
  const before = bodyRows(reverseSession())
  try {
    // "fit" in place of a number: fitted to the scan first, the number put
    // where it was asked for.
    ;({ input: feature, fitted } = asksFit(String(asked.kind), asked) ? await resolveFits(await ready(), String(asked.kind), asked) : { input: asked, fitted: {} })
    // A sketch fitted to the scan has its outline cut first — the worker's
    // job, outside the box.
    const prepared = feature.kind === 'sketch' ? await prepareFit(await ready(), planeOf(session(), feature.plane as Json), (feature.sketch as Json | undefined)?.fit as FitIn | undefined) : undefined
    const target = feature.target !== undefined ? targetOf(feature.target as Ref) : undefined
    id = await change((s) => {
      const { id, ...rest } = addFeature(s, feature, prepared)
      if (target !== undefined) setTarget(id, target)
      extra = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined && !(typeof v === 'object' && v !== null && Object.keys(v).length === 0)))
      return id
    })
  } finally {
    picked = takePickLog()
  }
  markFitted(id, fitted)
  // A sketch on a plane element: where the element lies on its sheet.
  const onElement = await elementAnswer(allFeatures().find((x) => x.id === id))
  return featureAnswer(session(), id, { ...extra, ...fittedOut(fitted), ...(picked.length > 0 ? { picked } : {}), ...besideOut(id), ...defaultOpOut(asked, id, before), ...onElement }, detail, before)
}

/** A failure as a list of them says it: its first sentence. */
const firstSentence = (text: string) => /^.*?[.:](?=\s|$)/.exec(text)?.[0] ?? text

/** The kinds that take a feature of several solids solid by solid. */
const PER_SOLID = ['fillet', 'chamfer']

/** The solids a round or a chamfer names by the feature that made them,
 *  with edges all queries, which each solid can answer on its own — null
 *  for one solid, or edges by index or fingerprint, which number one solid's
 *  edges: those go the way of any pick, a name refused (bodyNamed). */
async function solidsAsked(asked: Json): Promise<ReturnType<typeof solidsNamed>> {
  const s = await ready()
  if (s.held() || asked.body === undefined) return null
  const named = solidsNamed(asked.body as Ref)
  if (!named) return null
  const queries = (asked.edges as unknown[]).map((p) => unwrapped(p, 'edge'))
  if (!queries.every((p) => isWhere(p) && !('edge' in p))) return null
  const byIndex = (queries as Where[]).find((w) => w.faces !== undefined || Array.isArray(w.exclude))
  if (byIndex) invalid(`${named.feature.name} made ${named.solids.length} bodies, and faces or exclude by index number the faces and edges of one of them — give queries that any of them can answer (box, near, kind, madeBy…), or name one body: ${named.solids.map((b) => `${b.id} (${b.name})`).join(', ')}.`)
  return named
}

/**
 * A round or a chamfer on a feature of several solids: one feature on each
 * solid the query hits, named "<name> 1..n", added in one change and built
 * once. All or none: a pick or a fit refused on any solid stops it before
 * anything is added, and one that does not build takes them all out again,
 * by solid in the refusal. The answer is the first one's, with solids listing
 * them all and those no edge of which answers.
 */
async function addOnSolids(asked: Json, of: NonNullable<ReturnType<typeof solidsNamed>>, detail: Detail): Promise<Json> {
  const s = await ready()
  const kind = String(asked.kind)
  const picks = asked.edges as unknown[]
  const hit = of.solids.flatMap((solid) => {
    const t = topologyOf(s, solid)
    const counts = picks.map((p) => whereIndices(unwrapped(p, 'edge') as Where, t, solid, 'edge').length)
    const edges = picks.filter((_, i) => counts[i] > 0)
    return edges.length > 0 ? [{ solid, edges, count: counts.reduce((a, b) => a + b, 0) }] : []
  })
  if (hit.length === 0) throw new CommandError('not_found', `No edge of the ${of.solids.length} solids of ${of.feature.name} answers ${JSON.stringify(picks)} — reverse.body.describe { body: ${of.solids[0].id}, where } shows what one of them has.`)
  const base = typeof asked.name === 'string' && asked.name.trim() ? asked.name.trim() : `${kind === 'fillet' ? 'Fillet' : 'Chamfer'} on ${of.feature.name}`
  const names = hit.map((_, k) => `${base} ${k + 1}`)
  names.forEach((n, k) => requireFreeName(n, undefined, names.slice(0, k)))
  const before = bodyRows(reverseSession())
  startPickLog()
  let picked: Json[] = []
  let ids: number[]
  const fittedBy: Record<string, FitReading & { spec?: Json }>[] = []
  try {
    const inputs: Json[] = []
    for (const [k, h] of hit.entries()) {
      const one: Json = { ...asked, body: h.solid.id, edges: h.edges, name: names[k] }
      try {
        const read = asksFit(kind, one) ? await resolveFits(s, kind, one) : { input: one, fitted: {} }
        inputs.push(read.input)
        fittedBy.push(read.fitted)
      } catch (e) {
        if (e instanceof CommandError) throw new CommandError(e.code, `${h.solid.name} (${h.solid.id}): ${e.message} Nothing was added.`)
        throw e
      }
    }
    ids = await change((s) => inputs.map((input) => addFeature(s, input).id))
  } finally {
    picked = takePickLog()
  }
  const failing = ids.flatMap((id, k) => (re().results[id]?.status === 'failed' ? [`${names[k]} on ${hit[k].solid.name} (${hit[k].solid.id}): ${firstSentence(re().results[id]?.message ?? 'it did not build')}`] : []))
  if (failing.length > 0) {
    await change(() => [...ids].reverse().forEach((id) => re().removeFeature(id)))
    throw new CommandError('failed', `${failing.length} of the ${ids.length} ${kind}s on ${of.feature.name} did not build, and none was added — ${failing.join(' ')}`)
  }
  ids.forEach((id, k) => markFitted(id, fittedBy[k]))
  const leftOut = of.solids.filter((b) => !hit.some((h) => h.solid.id === b.id)).map((b) => ({ id: b.id, name: b.name }))
  const solids = {
    of: of.feature.name,
    made: ids.map((id, k) => ({ id, name: names[k], body: hit[k].solid.id, edges: hit[k].count, status: re().results[id]?.status ?? 'held', ...fittedOut(fittedBy[k]) })),
    ...(leftOut.length > 0 ? { leftOut } : {}),
    note: `One ${kind} per solid the query hits, in one undo step${leftOut.length > 0 ? `; ${leftOut.length} of the ${of.solids.length} solids left out, no edge of them answering` : ''}.`,
  }
  return featureAnswer(session(), ids[0], { solids, ...(picked.length > 0 ? { picked } : {}) }, detail, before)
}

/** The kinds whose op is join unless another is given. */
const JOIN_BY_DEFAULT = ['extrude', 'revolve', 'loft', 'sweep']

/** A volume as an answer says it, mm³. */
const mm3 = (v: number) => Math.round(v * 10) / 10

/** For a solid added without an op: the op it took — join, one body with
 *  every solid it meets, or for a face pulled into its body cut — and what
 *  it joined, each body's volume before and after: "Cup raw (4): 1200 →
 *  1450 mm³". A join an agent did not ask for is otherwise seen only as a
 *  body grown. */
function defaultOpOut(asked: Json, id: number, before: Map<number, string>): Json {
  if (asked.op !== undefined || !JOIN_BY_DEFAULT.includes(String(asked.kind))) return {}
  const f = allFeatures().find((x) => x.id === id) as { op?: string } | undefined
  if (f?.op === 'cut') return { op: 'cut (the default for a face pulled into its body)' }
  if (f?.op !== 'join') return {}
  const r = re().results[id]
  if (r?.status !== 'ok') return { op: 'join (default)' }
  const now = new Map(bodiesOut(session()).map((b) => [b.id, b]))
  const was = (bid: number) => JSON.parse(before.get(bid)!) as { name: string; volume: number }
  const grown = [...before.keys()].flatMap((bid) => {
    const b = now.get(bid)
    return b && Math.abs(b.volume - was(bid).volume) > 1e-9 ? [`${b.name} (${bid}): ${mm3(was(bid).volume)} → ${mm3(b.volume)} mm³`] : []
  })
  const taken = [...before.keys()].filter((bid) => !now.has(bid)).map((bid) => `${was(bid).name} (${bid})`)
  const made = (r.bodies ?? []).filter((bid) => !before.has(bid)).map((bid) => `${now.get(bid)?.name ?? `Solid ${bid}`} (${bid})`)
  const joined = grown.length > 0 ? `${grown.join('; ')}${taken.length > 0 ? `, taking in ${taken.join(', ')}` : ''}` : made.length > 0 ? `nothing — it met no body, and is a new body: ${made.join(', ')}` : 'nothing it changed'
  return { op: 'join (default)', joined }
}

/**
 * A loft added with its stations, in one call: each section given as a
 * plane a sketch of the scan's run there fitted like fit.like (a sketch
 * named stands as it is), each station's inner twin moved in by `inner`
 * with a loft of its own, and the loft through the stations — ordinary
 * sketches and lofts, added in order and built once. A recipe rather than a
 * kind of feature: a station is fitted to the scan, which the build does
 * not have, and as a sketch each one is refitted or edited on its own
 * (reverse.feature.update { features }).
 */
async function addLoftStations(asked: Json, detail: Detail): Promise<Json> {
  const sections = asked.sections as Json[] | undefined
  const listed = asked.sketches as Ref[] | undefined
  if (sections && listed) invalid('Give sketches or sections, not both — a sketch you have goes in sections as { sketch }.')
  const items: Json[] = [...(sections ?? (listed ?? []).map((sketch) => ({ sketch })))]
  if (items.length < 2) invalid('A loft takes two sketches or more — sketches, or sections to fit its stations on.')
  const fit = asked.fit as FitIn | undefined
  // The stations' numbers by expression: a plane's offset, the wall.
  const { offsets, inner: innerExpr } = loftExprsIn(asked.exprs as Json | undefined, items)
  const inner = innerExpr !== undefined ? innerExpr.value : (asked.inner as number | undefined)
  for (const [k, o] of offsets) if (items[k].sketch === undefined) items[k] = { ...items[k], offset: o.value }
  const onPlanes = items.some((it) => it.sketch === undefined)
  if (onPlanes && fit?.like === undefined) invalid('fit.like names the sketch the stations are fitted like: one station fitted to the scan and closed — its run, and a line across its base drawn on.')
  if (fit && !onPlanes) invalid('fit is for sections given as planes — every section here is a sketch you have.')
  const s = await ready()
  const name = typeof asked.name === 'string' && asked.name.trim() ? asked.name.trim() : unusedName('Loft')
  const stationName = (k: number) => `${name} station ${k + 1}`
  const twinName = (k: number) => `${name} inner ${k + 1}`
  const innerName = `${name} inner`
  // Every name made checked first: one taken would stop it half-way.
  const names: string[] = [name]
  for (const n of [...items.flatMap((it, k) => (it.sketch === undefined ? [stationName(k)] : [])), ...(inner !== undefined ? [...items.map((_, k) => twinName(k)), innerName] : [])]) {
    requireFreeName(n, undefined, names)
    names.push(n)
  }
  const had = items.map((it) => (it.sketch !== undefined ? sketchNamed(it.sketch as Ref) : null))
  // The scan cut on each plane first — the worker's job, outside the box.
  const prepared: (PreparedFit | undefined)[] = []
  for (const it of items) prepared.push(it.sketch === undefined ? await prepareFit(s, planeOf(session(), it), fit) : undefined)
  const target = asked.target !== undefined && asked.target !== null ? targetOf(asked.target as Ref) : undefined
  const loftOf = (sketches: number[], loftName: string, op?: unknown) => ({ kind: 'loft', name: loftName, sketches, ...(asked.ruled !== undefined ? { ruled: asked.ruled } : {}), ...(op !== undefined ? { op } : {}) })
  const before = bodyRows(reverseSession())
  const stations: Json[] = []
  const twins: Json[] = []
  let innerId: number | undefined
  const id = await change((s) => {
    const ids = items.map((it, k) => {
      const was = had[k]
      if (was) {
        // A sketch you have takes its offset's expression as an edit.
        const o = offsets.get(k)
        if (o) updateFeature(s, featureNamed(was.id), { exprs: { offset: o.expr } })
        return was.id
      }
      const o = offsets.get(k)
      const made = addFeature(s, { kind: 'sketch', name: stationName(k), plane: it, sketch: {}, ...(o ? { exprs: { offset: o.expr } } : {}) }, prepared[k]) as Json & { id: number }
      const fitted = (made.fitted as FittedOut[] | undefined)?.[0]
      const solved = made.solve as { fit?: unknown } | undefined
      stations.push({ id: made.id, name: stationName(k), ...(fitted ? { pieces: fitted.pieces, ...(fitted.like?.reversed ? { reversed: true } : {}) } : {}), ...(solved?.fit ? { fit: solved.fit } : {}), ...(made.accept ? { accept: made.accept } : {}) })
      return made.id
    })
    const loft = addFeature(s, loftOf(ids, name, asked.op)).id
    if (target !== undefined) setTarget(loft, target)
    if (inner !== undefined) {
      const twinIds = ids.map((sid, k) => {
        const twin = addInsetTwin(featureNamed(sid) as SketchFeature, twinName(k), inner, innerExpr?.expr)
        const { by: _by, ...inset } = twin.inset
        void _by
        twins.push({ id: twin.id, name: twinName(k), of: sid, ...inset })
        return twin.id
      })
      innerId = addFeature(s, loftOf(twinIds, innerName, 'new')).id
    }
    return loft
  })
  const innerOut =
    innerId !== undefined
      ? { inner: { by: inner, loft: { id: innerId, name: innerName, result: resultOut(re().results[innerId]) }, stations: detail === 'none' ? twins.map((t) => ({ id: t.id, name: t.name })) : twins, note: `${innerName} is a body of its own: cut it from the outer (boolean op cut) once the outer is joined to the rest.` } }
      : {}
  const made = { stations: detail === 'none' ? stations.map((t) => ({ id: t.id, name: t.name })) : stations, ...innerOut }
  return detail === 'none' ? { ...noneAnswer(id), ...made } : featureAnswer(session(), id, made, detail, before)
}

/** A kind with no number for an expression to drive, refused as such —
 *  not as a field the schema does not know. */
function noNumbers(kind: string): void {
  if (FEATURE_IN[kind] && !FEATURE_IN[kind].properties?.exprs) invalid(`exprs: a ${kind} has no numbers for an expression to drive — the kinds that have them list them under exprs (reverse.feature.schema { kind }).`)
}

/** A loft's expressions as reverse.feature.add takes them, evaluated:
 *  sections.<k>.offset by the section, inner. */
function loftExprsIn(exprs: Json | undefined, items: readonly Json[]): { offsets: Map<number, { expr: string; value: number }>; inner?: { expr: string; value: number } } {
  const offsets = new Map<number, { expr: string; value: number }>()
  let inner: { expr: string; value: number } | undefined
  const scope = re().parameterTable.scope
  for (const [key, expr] of Object.entries(exprs ?? {})) {
    if (typeof expr !== 'string' || expr.trim() === '') invalid(`exprs.${key}: an expression is a string.`)
    const r = evaluateFor(expr as string, 'length', scope)
    if (!r.ok) invalid(`exprs.${key}: “${expr as string}” — ${r.error}`)
    const value = r.ok ? r.value : 0
    const at = /^sections\.(\d+)\.offset$/.exec(key)
    if (at) {
      const k = Number(at[1])
      if (k >= items.length) invalid(`exprs.${key}: there are ${items.length} sections — sections.0.offset to sections.${items.length - 1}.offset.`)
      const plane = items[k].sketch === undefined ? (items[k] as { kind?: string }) : null
      if (plane && plane.kind === 'fitted') invalid(`exprs.${key}: a plane fitted where the scan was clicked takes no offset.`)
      offsets.set(k, { expr: expr as string, value })
    } else if (key === 'inner') inner = { expr: expr as string, value }
    else invalid(`exprs.${key}: no such field — a loft has sections.<k>.offset (the k-th section’s plane offset, k from 0) and inner (the inner stations’ wall).`)
  }
  if (inner && !(inner.value > 0)) invalid(`exprs.inner: “${inner.expr}” comes to ${inner.value} mm — the wall is above zero.`)
  return { offsets, ...(inner ? { inner } : {}) }
}

/** "Loft 1", or the first such name no feature has. */
function unusedName(base: string): string {
  const taken = new Set(allFeatures().map((f) => nameKey(f.name)))
  let n = 1
  while (taken.has(nameKey(`${base} ${n}`))) n++
  return `${base} ${n}`
}

/** The kinds that make a solid and may join or cut one body alone. */
const TARGETED = ['extrude', 'revolve', 'loft', 'sweep', 'thicken']

/** The body a feature's `target` names, by id — refused for a sheet,
 *  which has no inside to join or cut. */
function targetOf(ref: Ref): number {
  const b = bodyNamed(ref)
  if (b.surface) invalid(`target: ${b.name} is a sheet — a solid joins or cuts a solid; a sheet is closed into one by a trim.`)
  return b.id
}

/** A feature's one body to join or cut written into the list, or let go
 *  (undefined) — the box a feature is committed through has no field for
 *  it and saves the feature without one. */
function setTarget(id: number, target: number | undefined): void {
  useReverse.setState((s) => ({
    features: s.features.map((f) => (f.id === id && TARGETED.includes(f.kind) ? ({ ...withoutTarget(f as Feature & { target?: number }), ...(target !== undefined ? { target } : {}) } as Feature) : f)),
    buildVersion: s.buildVersion + 1,
  }))
}

/** For an offset that keeps its body: that the body it made stands beside
 *  the one it was made from, which is unchanged — what a boolean on the
 *  wrong one of them misses. */
function besideOut(id: number): Json {
  const f = allFeatures().find((x) => x.id === id)
  const r = re().results[id]
  if (f?.kind !== 'offsetBody' || f.keep === false || r?.status !== 'ok' || !r.bodies?.length) return {}
  const source = bodyAt(f.body)
  const made = r.bodies.map((b) => `${b} (${bodyAt(b).name})`).join(', ')
  return { note: `new body ${made} beside ${source.name} (${source.id}); ${source.name} unchanged (keep: false replaces it)` }
}

/** The most characters a schema is answered whole in; past it, its fields
 *  with what each costs, to be asked for one at a time. */
const SCHEMA_WHOLE = 20_000

/** The JSON a part of a schema is answered as, and its length — what it
 *  names by $ref alone (refs) not counted. */
const charsOf = (part: JsonSchema) => JSON.stringify(handOut(part).schema).length

/** A part of a schema answered whole: the schema, and the large shared
 *  parts it names by $ref alone, each with what asking for it costs. */
function wholeOut(part: JsonSchema): Json {
  const { schema, refs } = handOut(part)
  const named = Object.keys(refs)
  return { schema, ...(named.length > 0 ? { refs, note: `${named.join(', ')}: named by $ref, not given here — reverse.feature.schema { def: "${named[0]}" } answers ${named.length === 1 ? 'it' : 'one'}.` } : {}) }
}

/** A description as a listing gives it: its first 200 characters. */
const shortened = (text: string | undefined) => (text && text.length > 200 ? `${text.slice(0, 199).trimEnd()}…` : (text ?? ''))

/** What a part of a schema holds, a step down: an object's fields, a
 *  list's items' fields, a oneOf's branches by their titles. */
function partsOf(part: JsonSchema): Record<string, JsonSchema> {
  if (part.type === 'array' && part.items) return partsOf(part.items)
  if (part.properties) return part.properties
  if (part.oneOf) return Object.fromEntries(part.oneOf.map((b, i) => [b.title ?? `${i}`, b]))
  return {}
}

/** The part of a kind's schema a dotted path names — `sketch.constraints`,
 *  `plane` — each step a field of an object (of a list's items), or of a
 *  oneOf's branches, or one branch by its title. */
function partAt(kind: string, path: string): JsonSchema {
  let part = FEATURE_IN[kind]
  const walked: string[] = []
  for (const step of path.split('.').map((x) => x.trim())) {
    const parts = partsOf(part)
    let next: JsonSchema | undefined
    if (part.oneOf) {
      // A field of the branches — the one shape, or each branch's — before
      // a branch by its title: a plane's name is its branches' name field.
      const found = part.oneOf.flatMap((b) => {
        const f = partsOf(b)[step]
        return f ? [{ ...f, title: b.title }] : []
      })
      const shapes = new Set(found.map(({ title: _t, ...x }) => JSON.stringify(x)))
      if (shapes.size === 1) next = (({ title: _t, ...x }) => x)(found[0])
      else if (found.length > 1) next = oneOf(found, `${step}, as each branch takes it.`)
    }
    next ??= parts[step]
    if (!next) {
      const at = walked.length ? `${walked.join('.')} (${kind})` : kind
      const names = Object.keys(parts)
      invalid(`field: ${kind}'s "${path}" — ${at} has no field "${step}"; ${names.length ? `its fields are ${names.join(', ')}` : 'it has no fields'}.`)
    }
    part = next
    walked.push(step)
  }
  return part
}

/** A worked example's part at a path, where it has one. */
function exampleAt(example: unknown, path: string): unknown {
  let v = example
  for (const step of path.split('.')) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined
    v = (v as Record<string, unknown>)[step.trim()]
  }
  return v
}

/** A part of a schema answered: whole, or past SCHEMA_WHOLE its fields,
 *  each with its size — what asking for it costs. */
function schemaOut(kind: string, field: string | undefined, part: JsonSchema): Json {
  const chars = charsOf(part)
  if (chars <= SCHEMA_WHOLE) return wholeOut(part)
  const parts = partsOf(part)
  const fields = Object.fromEntries(
    Object.entries(parts).map(([name, p]) => [name, { chars: charsOf(p), ...(part.required?.includes(name) ? { required: true } : {}), what: shortened(p.description) }]),
  )
  const largest = Object.entries(fields)
    .sort((a, b) => b[1].chars - a[1].chars)
    .map(([name]) => name)[0]
  const asked = (name: string) => (field ? `${field}.${name}` : name)
  return {
    chars,
    fields,
    note: `The schema${field ? ` of ${field}` : ''} is ${Math.round(chars / 1000)} k characters, past the ${SCHEMA_WHOLE / 1000} k given whole: here are its fields, each with what it costs. Ask for one — reverse.feature.schema { kind: "${kind}", field: "${asked(largest ?? 'name')}" } — or a part of one by its dotted path.`,
  }
}

export const schema: Command<{ kind?: string; field?: string; def?: string }> = {
  name: 'schema',
  title: 'The fields of a kind of feature',
  description: `What reverse.feature.add takes for one kind of feature: the JSON Schema of its fields — the same it is checked against, each small part it holds more than once given once under $defs and named by $ref — and, for the common kinds, a worked example with what it does. The large parts the kinds share (a plane, a face or an edge pick, the where query) are named by $ref alone and listed under refs with their size (chars) and what each is: def answers one — { def: "face" } — the same way. A schema past ${SCHEMA_WHOLE / 1000} k characters (a sketch's) answers its fields instead, each with its size: ask for one with field — a dotted path, "sketch.constraints", "plane" — which answers that part the same way. Without kind, every kind with what it is and which fields it needs. Changes nothing.`,
  input: obj({
    kind: enumOf(FEATURE_KINDS, 'The kind of feature.'),
    field: str('One field of the kind, or a part of one by a dotted path — "plane", "sketch.constraints", "extent.toPlane" (a branch by its kind). Only with kind.', { minLength: 1 }),
    def: enumOf(SHARED_NAMES, 'One part the kinds share, as a $ref names it (#/$defs/face is "face") — alone, without kind or field.'),
  }),
  readOnly: true,
  askForLess: 'one field at a time — field, a dotted path: "sketch.constraints", "plane"; a part named by $ref alone with def; without field, a schema past 20 k answers its fields with their sizes',
  run: async ({ kind, field, def }) => {
    if (def !== undefined) {
      if (kind !== undefined || field !== undefined) invalid(`def: "${def}" is a part the kinds share, answered on its own — give def alone, without kind or field.`)
      const part = sharedPart(def)!
      return { def, what: part.description ?? '', ...wholeOut(part) }
    }
    if (!kind) {
      if (field !== undefined) invalid('field: a field of which kind? Give kind with it.')
      return {
        kinds: FEATURE_KINDS.map((k) => ({ kind: k, what: FEATURE_IN[k].description ?? '', required: (FEATURE_IN[k].required ?? []).filter((r) => r !== 'kind'), example: k in FEATURE_EXAMPLES })),
      }
    }
    if (field !== undefined) {
      const part = partAt(kind, field)
      const example = exampleAt(FEATURE_EXAMPLES[kind], field)
      return { kind, field, what: part.description ?? '', ...schemaOut(kind, field, part), ...(example !== undefined ? { example } : {}) }
    }
    return {
      kind,
      what: FEATURE_IN[kind].description ?? '',
      ...schemaOut(kind, undefined, FEATURE_IN[kind]),
      ...(FEATURE_EXAMPLES[kind] ? { example: FEATURE_EXAMPLES[kind], about: EXAMPLE_NOTES[kind] } : {}),
    }
  },
}

/** What an edit took in, kept for its answer — read once the part is
 *  built, which for edits gathered is after the last of them. */
interface Edited {
  f: Feature
  below: boolean
  before: Map<number, string>
  /** What every detail keeps: the box's own, fitted, picked. */
  kept: Json
}

/** An edit's answer as update gives it, from the part as built now. */
function editedAnswer({ f, below, before, kept }: Edited, detail: Detail): Json {
  const out = featureAnswer(session(), f.id, { ...kept, ...besideOut(f.id) }, detail, before)
  return below && detail !== 'none' ? { ...out, rollback: barOut() } : out
}

export const update: Command<{ feature?: Ref; set?: Json; features?: { feature: Ref; set: Json }[]; detail?: Detail }> = {
  name: 'update',
  title: 'Edit a feature',
  description:
    'Change a feature as reopening it in the panel does: set holds the fields to change, named as reverse.feature.add takes them for the kind — a sketch’s whole sketch or its plane, any feature’s visible and suppressed; exprs { field: "expression" } sets expressions, { field: null } lets one go, and a number set without its expression lets that go too. The features after it are rebuilt on it, keeping their picks. A face or an edge picked by index names it on the body as it stood before the feature — what reverse.body.describe { before: this feature } lists — so a feature further up the list is edited by index too. Below the rollback bar the feature is edited as an insert is made (the bar put past it and back; the answer says where it stands). Several edits go in features: [{ feature, set }…], made in order and built once, in one undo step, each finding the part as it was built before them all; the first refused stops the rest (stopped). Returns the feature and the bodies the rebuild changed — with features, updated per edit (id, status, result, picked, fitted). To add to a sketch or take pieces out: reverse.sketch.edit.',
  input: obj({
    feature: featureRef(),
    set: anyObject('The fields to change, named as reverse.feature.add takes them for the kind (reverse.feature.schema { kind } lists them); any feature’s visible, suppressed and exprs.'),
    features: arr(obj({ feature: featureRef(), set: anyObject('The fields to change, as set takes them.') }, ['feature', 'set']), 'Several edits in place of feature and set, made in order and built once, after the last.', { minItems: 1 }),
    detail: detailIn,
  }),
  label: ({ feature, features }) => {
    if (features) return `edit ${features.length} features`
    try {
      return `edit ${featureNamed(feature!).name}`
    } catch {
      return 'edit feature'
    }
  },
  run: async ({ feature, set, features, detail = 'brief' }) => {
    if (features !== undefined) {
      if (feature !== undefined || set !== undefined) invalid('Give feature and set, or features — not both.')
      return updateMany(features, detail)
    }
    if (feature === undefined || set === undefined) invalid('Give feature and set — or features, several edits built once.')
    return editedAnswer(await editOne(feature!, set!), detail)
  },
}

/** The fields of a set that name bodies — read against the bodies as they
 *  stood when the feature was built, not as they stand at the bar. */
const BODY_FIELDS = ['body', 'tool', 'tools', 'sheet', 'target', 'bodies']

/** One feature edited as update edits it: the fields checked, the edit
 *  made, and what its answer needs kept. */
async function editOne(ref: Ref, set: Json): Promise<Edited> {
  const f = featureNamed(ref)
  if (set.kind !== undefined && set.kind !== f.kind) invalid(`${f.name} is a ${f.kind} and stays one.`)
  requireFreeName(set.name, f.id)
  const { kind: _kind, visible, suppressed, ...rest } = set
  void _kind
  if (f.kind === 'loft' && ['sections', 'fit', 'inner'].some((k) => rest[k] !== undefined)) invalid('sections, fit and inner make a loft’s stations when it is added — edit the stations themselves (reverse.feature.update { features }), or the loft’s sketches.')
  if (rest.exprs !== undefined) noNumbers(f.kind)
  if (visible !== undefined && typeof visible !== 'boolean') invalid('set.visible: expected true or false')
  if (suppressed !== undefined && typeof suppressed !== 'boolean') invalid('set.suppressed: expected true or false')
  const errors = validate(partialOf(FEATURE_IN[f.kind]), { kind: f.kind, ...rest }, 'input.set')
  if (errors.length > 0) invalid(sketchFieldsNamed(errors).join('; '))
  const before = bodyRows(reverseSession())
  let extra: Json = {}
  const s = await ready()
  // Below the rollback bar: the bar put just past the feature, the part
  // built up to it — a pick by index then names the body as it stood
  // before it — the edit made, and the bar put at the end, the features
  // after it built on the edit; as an insert does. One undo step in all.
  const below = !re().features.includes(f)
  // A feature further up re-pointed at other bodies: they are named as
  // they stood when it was built — one a later feature took in is there
  // to name — so the bar goes just past it for the edit, as below it.
  const rolled = below || (BODY_FIELDS.some((k) => rest[k] !== undefined && rest[k] !== null) && re().features.indexOf(f) < re().features.length - 1)
  if (rest.target !== undefined && !TARGETED.includes(f.kind)) invalid(`set.target: a ${f.kind} has none — an extrude, a revolve, a loft, a sweep or a thicken joins or cuts one body alone.`)
  let fitted: Record<string, FitReading & { spec?: Json }> = {}
  let picked: Json[] = []
  startPickLog()
  try {
    if (rolled) await change(() => re().rollTo(allFeatures().indexOf(f) + 1), { now: true })
    // The one body it joins or cuts: the one named (null lets it go), or
    // the one it had — the box it is committed through saves none.
    const had = (f as { target?: number }).target
    const target = rest.target === null ? undefined : rest.target !== undefined ? targetOf(rest.target as Ref) : had
    if (target !== undefined && allFeatures().findIndex((x) => x.id === bodyMaker(target)) >= allFeatures().indexOf(f)) invalid(`set.target: ${bodyAt(target).name} is made by ${f.name} or after it — a feature joins or cuts a body made before it.`)
    await withStaged(s, f, rest, async () => {
      // "fit" in place of a number: fitted on the part as it stood before
      // the feature, what the set leaves out read off the feature.
      let fields = rest
      if (asksFit(f.kind, rest)) ({ input: fields, fitted } = await resolveFits(s, f.kind, rest, featureNamed(f.id)))
      return change((s) => {
        const done = updateFeature(s, featureNamed(f.id), { ...fields, ...(visible !== undefined ? { visible } : {}), ...(suppressed !== undefined ? { suppressed } : {}) })
        if (TARGETED.includes(f.kind) && (featureNamed(f.id) as { target?: number }).target !== target) setTarget(f.id, target)
        extra = Object.fromEntries(Object.entries(done).filter(([, v]) => v !== undefined && !(typeof v === 'object' && v !== null && Object.keys(v).length === 0)))
      })
    })
  } finally {
    picked = takePickLog()
    if (rolled) await change(() => re().rollTo(null))
  }
  // A number set by hand is no longer the scan's.
  unmarkFitted(
    f.id,
    ['radius', 'distance', 'angleDeg']
      .filter((k) => rest[k] !== undefined && rest[k] !== FIT)
      .concat(rest.extent !== undefined && (rest.extent as Json).kind !== 'toScan' ? ['extent.to'] : [])
      .concat(Array.isArray(rest.groups) ? (rest.groups as Json[]).flatMap((g, i) => (g?.angleDeg !== FIT ? [`groups.${i}.angleDeg`] : [])) : []),
  )
  markFitted(f.id, fitted)
  const onElement = await elementAnswer(allFeatures().find((x) => x.id === f.id))
  return { f, below, before, kept: { ...extra, ...fittedOut(fitted), ...(picked.length > 0 ? { picked } : {}), ...onElement } }
}

/** Several edits, made in order and built once, after the last — the
 *  first refused stopping the rest, those before it standing. */
async function updateMany(edits: { feature: Ref; set: Json }[], detail: Detail): Promise<Json> {
  // Names checked before anything is changed: one taken, or two alike,
  // would stop it half-way.
  const names: string[] = []
  for (const { feature, set } of edits) {
    requireFreeName(set.name, featureNamed(feature).id, names)
    if (typeof set.name === 'string' && set.name.trim()) names.push(set.name)
  }
  const s = await ready()
  const before = bodyRows(s)
  const done: Edited[] = []
  let stopped: Json | undefined
  await gathered(async () => {
    for (let i = 0; i < edits.length; i++) {
      try {
        done.push(await editOne(edits[i].feature, edits[i].set))
      } catch (e) {
        if (!(e instanceof CommandError)) throw e
        stopped = { index: i, feature: edits[i].feature, code: e.code, message: e.message, kept: done.map((d) => d.f.name) }
        return
      }
    }
  })
  const failed = failures()
  return {
    updated: done.map((d) => {
      // Each edit's id, status and what every detail keeps; the bar and
      // what failed once for them all.
      const { rollback: _bar, failed: _failed, ...own } = noneAnswer(d.f.id, { ...d.kept, ...besideOut(d.f.id) })
      void _bar
      void _failed
      if (detail === 'none') return own
      const f = featureNamed(d.f.id)
      return { ...own, name: f.name, result: resultOut(re().results[f.id]), ...(detail === 'full' ? { feature: featureOut(f) } : {}) }
    }),
    ...(stopped ? { stopped } : {}),
    rollback: barOut(),
    ...(detail === 'none' ? {} : { bodies: detail === 'full' ? bodiesOut(s) : bodiesChanged(s, before) }),
    ...(failed.length > 0 ? { failed } : {}),
  }
}

export const refit: Command<{ feature: Ref; fields?: string[]; detail?: Detail }> = {
  name: 'refit',
  title: 'Fit a feature’s numbers again',
  description:
    'Fit a feature’s numbers to the scan again — after something it is built on moved, or the scan was aligned again: each number made with "fit" this session (a fillet’s radius, a chamfer’s distance, a draft’s angleDeg and its groups’ (groups.0.angleDeg), an extrude’s extent.to — fittedOf the feature), or those named in fields. One undo step, as reverse.feature.update. Returns the feature as update does, with fitted (each number’s value, sigma, nominal, off, sigmas, points) and was (the number before).',
  input: obj({ feature: featureRef(), fields: arr(str('radius, distance, angleDeg or extent.to — or a draft group’s angle by its path, groups.0.angleDeg for the first group.'), 'The numbers to fit; those fitted this session by default.', { minItems: 1 }), detail: detailIn }, ['feature']),
  label: ({ feature }) => {
    try {
      return `refit ${featureNamed(feature).name}`
    } catch {
      return 'refit feature'
    }
  },
  run: async ({ feature, fields, detail = 'brief' }) => {
    const f = featureNamed(feature)
    const { set, fields: asked } = refitInput(f, fields)
    // Each field's number as it stood, by its path: extent.to, a draft's
    // groups.1.angleDeg.
    const was = Object.fromEntries(asked.map((k) => [k, k.split('.').reduce<unknown>((o, key) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[key] : undefined), f) ?? null]))
    const answer = (await update.run({ feature: f.id, set, detail }, undefined as never)) as Json
    return { ...answer, was }
  },
}

/** How far a piece may move in an edit before the answer warns, mm, on a
 *  part with no T in its plan. */
const MOVED_FAR_MM = 0.5

export const remove: Command<{ feature: Ref; detail?: Detail }> = {
  name: 'remove',
  title: 'Remove a feature',
  description: 'Take a feature out of the list, as its row’s delete does. Refused while another feature is made on it — a sketch an extrude uses, a body a fillet works on, or a sketch lies on a face of or projects: remove those first. A feature whose last build failed is kept in the plan’s removed list (name, kind, the failure) and the answer says removedAfterFailing: say so in the chat, with what its removal leaves — the final comparison lists it. Returns the bodies the rebuild changed (detail "full": every body; "none": the bar and what failed).',
  input: obj({ feature: featureRef(), detail: detailIn }, ['feature']),
  label: ({ feature }) => {
    try {
      return `remove ${featureNamed(feature).name}`
    } catch {
      return 'remove feature'
    }
  },
  run: async ({ feature, detail = 'brief' }) => {
    const f = featureNamed(feature)
    const users = dependentsOf(f.id, allFeatures())
    if (users.length > 0) throw new CommandError('invalid_state', `${f.name} is used by ${users.map((u) => u.name).join(', ')} — remove ${users.length === 1 ? 'that' : 'those'} first.`)
    const before = bodyRows(reverseSession())
    // A failure taken out of the list is no failure fixed: kept for the
    // plan's verdict, and said.
    const failing = failedWith(f)
    await change(() => re().removeFeature(f.id))
    const gone = failing !== null ? { removedAfterFailing: { ...recordRemoved(f, failing), say: REMOVED_SAY } } : {}
    if (detail === 'none') return { ...noneAnswer(f.id), ...gone }
    return { removed: { id: f.id, name: f.name }, ...gone, bodies: detail === 'full' ? bodiesOut(session()) : bodiesChanged(session(), before), ...(failures().length > 0 ? { failed: failures() } : {}) }
  },
}

export const move: Command<{ features: Ref[]; after: Ref | null; detail?: Detail }> = {
  name: 'move',
  title: 'Move features in the list',
  description:
    'Move features to another place in the list, as dragging their rows would: features, in the order they stand, go to just after the feature named by after (null: the top of the list), and the part is built again in the new order. One undo step; each keeps its id, its name and its picks (found again by fingerprint). Refused when a feature moved would come before one it builds on — its sketch, the body it works on, the feature that made a face or an edge it picks — or when one it is moved past builds on it: move those with it. The rollback bar stays between the features it stood between. Returns the features moved with their status, where they went, the bar, the bodies the rebuild changed and what failed.',
  input: obj(
    {
      features: arr(featureRef(), 'The features to move, by id or name — in the order they stand in the list, whatever order they are given in.', { minItems: 1 }),
      after: oneOf([featureRef(), { type: 'null' }], 'The feature they go just after, by id or name; null puts them at the top of the list.'),
      detail: detailIn,
    },
    ['features', 'after'],
  ),
  label: ({ features }) => {
    try {
      return features.length === 1 ? `move ${featureNamed(features[0]).name}` : `move ${features.length} features`
    } catch {
      return 'move features'
    }
  },
  run: async ({ features, after, detail = 'brief' }) => {
    const ids = [...new Set(features.map((f) => featureNamed(f).id))]
    const anchor = after === null ? null : featureNamed(after)
    const order = movedList(allFeatures(), ids, anchor?.id ?? null)
    if (typeof order === 'string') throw new CommandError('invalid_state', order)
    const where = (list: readonly Feature[]) => {
      const at = list.findIndex((f) => ids.includes(f.id))
      const next = list[at + ids.length]
      return { after: anchor ? { id: anchor.id, name: anchor.name } : null, next: next ? { id: next.id, name: next.name } : null }
    }
    const before = bodyRows(reverseSession())
    if (order.every((f, i) => f.id === allFeatures()[i].id)) return { moved: [], already: ids.length, ...where(order), rollback: barOut() }
    await change(() => {
      const why = re().moveFeatures(ids, anchor?.id ?? null)
      if (why) throw new CommandError('invalid_state', why)
    })
    const failed = failures()
    const moved = allFeatures().filter((f) => ids.includes(f.id))
    if (detail === 'none') return { moved: moved.map((f) => f.id), rollback: barOut(), ...(failed.length > 0 ? { failed } : {}) }
    return {
      moved: moved.map((f) => ({ id: f.id, name: f.name, status: featureBrief(f, re().rolledBack.includes(f)).status })),
      ...where(allFeatures()),
      rollback: barOut(),
      bodies: detail === 'full' ? bodiesOut(session()) : bodiesChanged(session(), before),
      ...(failed.length > 0 ? { failed } : {}),
    }
  },
}

export const clear: Command = {
  name: 'clear',
  title: 'Remove every feature',
  description: 'Take every feature out of the list — those below the rollback bar too — as starting the model over, in one undo step (history.undo brings them all back). The parameters stay. Returns how many went.',
  input: obj({}),
  label: () => 'remove every feature',
  run: async () => {
    const removed = allFeatures().length
    await change(() => re().clearFeatures())
    return { removed, rollback: barOut() }
  },
}

/** What a run of suppressing is told: on the last fan four of them, each
 *  rebuilding all that follows, took 135 s to look at one upstream sketch. */
const SUPPRESS_AGAIN = 'Each suppress rebuilds everything after it. To look upstream, reverse.feature.rollback { after } builds only that far, and moving the bar back is a look-up; several changes built once: scanruler_batch { build: "end" }.'

/** changesSoFar at the last suppress. */
let lastSuppress = -Infinity

export const suppress: Command<{ kinds?: string[]; features?: Ref[]; on?: boolean }> = {
  name: 'suppress',
  title: 'Suppress features',
  description:
    'Leave features out of the build, or build them again: every feature of the kinds given — { kinds: ["fillet", "chamfer"] } is a draft of the part without its rounds, quick to rebuild while the rest is modelled — or the features named. A suppressed feature stays in the list, its picks and numbers as they were, and builds again as it was with on: false; while it is out, a later feature that picked an edge or a face it made fails as it would without it, and comes back with it. Below the rollback bar too. One undo step. Returns the features switched, the bar and what failed.',
  input: obj({
    kinds: arr(enumOf(FEATURE_KINDS), 'Every feature of these kinds.', { minItems: 1 }),
    features: arr(featureRef(), 'These features, by id or name.', { minItems: 1 }),
    on: bool('true (the default) leaves them out of the build; false builds them again.'),
  }),
  label: ({ on = true }) => (on ? 'suppress features' : 'build suppressed features again'),
  run: async ({ kinds, features, on = true }, ctx) => {
    // Straight after another, or with one change between: a sketch edited
    // with what follows it suppressed. Not where the build is held anyway.
    const again = changesSoFar() - lastSuppress <= 2 && !ctx?.deferred && !session().held()
    lastSuppress = changesSoFar()
    if (!kinds && !features) invalid('Give kinds, features, or both.')
    const picked = [...(kinds ? allFeatures().filter((f) => kinds.includes(f.kind)) : []), ...(features ?? []).map(featureNamed)]
    if (picked.length === 0) throw new CommandError('not_found', `No feature is a ${kinds!.join(' or ')}.`)
    const ids = [...new Set(picked.map((f) => f.id))]
    const switched = await change(() => re().setSuppressed(ids, on))
    const failed = failures()
    return {
      switched: switched.map((id) => ({ id, name: allFeatures().find((f) => f.id === id)!.name })),
      // Those that were so already.
      ...(switched.length < ids.length ? { already: ids.length - switched.length } : {}),
      rollback: barOut(),
      ...(failed.length > 0 ? { failed } : {}),
      ...(again ? { note: SUPPRESS_AGAIN } : {}),
    }
  },
}

export const rollback: Command<{ to?: number | null; after?: Ref; detail?: Detail }> = {
  name: 'rollback',
  title: 'Move the rollback bar',
  description:
    'Put the rollback bar under the first `to` features of the list (0 for none, null for all of them), or right after the feature named by after: the part is built as it stood there, and a feature added now lands there, the ones below the bar following it once the bar moves down again. Moving the bar back to where it stood is a look-up, not a rebuild. Returns the bar and what failed; detail "full" adds every feature’s row (as reverse.feature.list lists them) and the bodies built by name.',
  input: obj({
    to: oneOf([int('How many features stay above the bar.', { minimum: 0 }), { type: 'null' }], 'How many features stay above the bar; null puts it at the end.'),
    after: featureRef(),
    detail: enumOf(['none', 'brief', 'full'], 'none and brief (the default): the bar and what failed. full: every feature’s row and the bodies by name besides.'),
  }),
  label: () => 'move rollback bar',
  run: async ({ to, after, detail = 'brief' }) => {
    if ((to === undefined) === (after === undefined)) invalid('Give either to or after.')
    const count = after !== undefined ? allFeatures().indexOf(featureNamed(after)) + 1 : to!
    await change(() => re().rollTo(count))
    const r = re()
    const failed = failures()
    return {
      rollback: barOut(),
      ...(detail === 'full'
        ? {
            features: [...r.features.map((f) => featureBrief(f, false)), ...r.rolledBack.map((f) => featureBrief(f, true))],
            bodies: r.bodies.map((b) => ({ id: b.id, name: b.name })),
          }
        : {}),
      ...(failed.length > 0 ? { failed } : {}),
    }
  },
}

export const build: Command = {
  name: 'build',
  title: 'Build the bodies',
  description:
    'The bodies built for the features as they stand — the CAD kernel brought up first if it is not, as opening the workspace does, and any build under way waited for. Returns every feature with what the build said (status ok or failed, the message saying why, where on the part a round, a chamfer or a shell failed), and the bodies with their volume, faces and bounding box. Changes nothing.',
  input: obj({}),
  readOnly: true,
  run: async () => {
    const s = await ready()
    const r = re()
    return {
      kernel: r.kernelVersion,
      features: [...r.features.map((f) => ({ ...featureBrief(f, false), result: resultOut(r.results[f.id]) })), ...r.rolledBack.map((f) => featureBrief(f, true))],
      bodies: bodiesOut(s),
      ...(failures().length > 0 ? { failed: failures() } : {}),
      ...(r.buildError ? { buildError: r.buildError } : {}),
    }
  },
}

export const sketchEdit: Command<{ sketch: Ref; add?: Json; remove?: { pieces?: number[]; constraints?: number[] }; set?: Record<string, Json>; name?: string; detail?: Detail }> = {
  name: 'edit',
  title: 'Edit a sketch piece by piece',
  description:
    'Change a sketch without handing all of it back, as reopening it in the panel and drawing does: add takes what a sketch takes — fit, project, entities, shapes, constraints, patterns, infer — naming the sketch’s pieces by their ids, and rounds: [{ a, b, radius? }], an arc tangent to pieces a and b where they meet, the pieces cut back to it and held with tangencies, at the radius given or the scan’s. remove takes pieces out by id, with every relation on them, and relations by id. set moves pieces in place, by id, each keeping its id and every relation on it: { "12": { b: [u, v] } } — a line’s a, b; an arc’s c, r, start, sweep, or its ends a, b (r too if you like), keeping its sweep or its bulge; a circle’s c, r; a spline’s pts, or a fit point by name (a, b, p1, …); a point’s p. The solve follows as a drag’s does: what you put a piece at holds, the rest gives way, and relations win over it (set.short says how far one fell short). A fitted piece lets go of its slice points (set.detached), as one dragged does; a projected piece is refused. Prefer it over remove and add: ids and relations stay. Order: removals, set, project, fit (with fit.level the walls the sketch already has are not fitted again — their points join those pieces, shared, and the new runs’ ends land on them, junctions), the rest, then the rounds; ends that meet are joined (infer), and a new end within 0.05 mm of one place other ends lie is moved onto it first (snapped). The sketch is solved and the features on it rebuilt, keeping their picks where the regions can still be told apart. Returns what was made (ids; a fit’s in fitted, each chain’s pieces), set (pieces, detached, short), each round (arc, a, b, radius, sigma, nominal, off, sigmas, residual, points, held, warning), moved (with radii: each arc or circle whose radius changed, was and now), offPiece (a T-junction come apart), the solve, the regions and the bodies changed — ids, fittedPieces, set, rounds, accept and moved even with detail "none".',
  input: obj(
    {
      sketch: featureRef('sketch'),
      add: anyObject('What to add, as a sketch takes it ({ fit?, project?, entities?, shapes?, constraints?, patterns?, infer? }), and rounds: [{ a, b, radius? }]. Leave a new piece’s id out unless a relation here names it (ids answers those given).'),
      remove: obj({ pieces: arr(int(), 'Piece ids — every relation and dimension on them goes too.'), constraints: arr(int(), 'Relation or dimension ids.') }),
      set: anyObject('Pieces moved in place, by id: { "12": { a?, b? }, "13": { c?, r?, start?, sweep? } or { a?, b?, r? }, "14": { c?, r? }, "15": { pts } or { a?, b?, p1?, … }, "16": { p } }, [u, v] mm, angles in radians. Each keeps its id and its relations.'),
      name: str('A new name for the sketch.', { minLength: 1 }),
      detail: detailIn,
    },
    ['sketch'],
  ),
  label: ({ sketch }) => {
    try {
      return `edit ${featureNamed(sketch).name}`
    } catch {
      return 'edit sketch'
    }
  },
  run: async ({ sketch: ref, add, remove, set, name, detail = 'brief' }) => {
    const f = sketchNamed(ref)
    requireFreeName(name, f.id)
    const { rounds: roundsIn, ...addRest } = add ?? {}
    if (roundsIn !== undefined) {
      const errors = validate(roundsSchema, roundsIn, 'input.add.rounds')
      if (errors.length > 0) invalid(errors.join('; '))
    }
    add = add ? addRest : add
    if (add?.inset !== undefined) invalid('add.inset: an inset makes a new sketch — reverse.feature.add { kind: "sketch", plane: its plane, sketch: { inset: { of: this sketch, by } } } — or takes one again in place: reverse.feature.update { feature, set: { sketch: { inset } } }.')
    if (add) {
      const errors = validate(sketchAddIn, add, 'input.add')
      if (errors.length > 0) invalid(`${sketchFieldsNamed(errors).join('; ')} — reverse.feature.schema { kind: "sketch" } gives a sketch’s fields.`)
    }
    const base: Sketch = JSON.parse(JSON.stringify(f.sketch)) as Sketch
    // The picks of the features on the sketch as they stand before the
    // edit, to tell one that grew by after it (picksGrew).
    const onSketch = () => allFeatures().filter((x): x is Extract<Feature, { kind: 'extrude' | 'revolve' }> => (x.kind === 'extrude' || x.kind === 'revolve') && x.sketchId === f.id && x.regions.length > 0)
    const wasRegions = findRegions(f.sketch)
    const picksWere = new Map(onSketch().map((x) => [x.id, { name: x.name, seen: picksSeen(f.id, matchRegions(x.regions, wasRegions)) }]))
    const gonePieces = remove?.pieces ?? []
    const goneConstraints = remove?.constraints ?? []
    for (const id of gonePieces) if (!base.entities.some((e) => e.id === id)) throw new CommandError('not_found', `${f.name} has no piece ${id}.`)
    for (const id of goneConstraints) if (!base.constraints.some((c) => c.id === id)) throw new CommandError('not_found', `${f.name} has no relation or dimension ${id}.`)
    const constraintsBefore = base.constraints.length
    removeEntities(base, gonePieces)
    base.constraints = base.constraints.filter((c) => !goneConstraints.includes(c.id))
    // What moved is told from the sketch before the set; what a piece set then
    // came off (movedFar), from where the set put it.
    const beforeSet = cloneSketch(base)
    const piecesSet = set ? setPieces(base, set, f.name) : null
    const { fit: fitIn, project, ...added } = add ?? {}
    const prepared = await prepareFit(await ready(), f.plane, fitIn as FitIn | undefined)
    const before = bodyRows(reverseSession())
    let extra: Json = {}
    await change((s) => {
      re().editSketch(f.id)
      if (name !== undefined) re().setSketchName(name)
      if (gonePieces.length + goneConstraints.length + (piecesSet?.pieces.length ?? 0) > 0) re().setSketch(base, piecesSet?.pull)
      // The part's geometry projected first, so a fit lands on it too.
      const projected = project ? projectDraft(s, project as ProjectIn[], re().features.findIndex((x) => x.id === f.id), f.id) : undefined
      const fit = prepared ? fitDraftShared(prepared) : undefined
      const fitted = fit?.fitted
      // The pieces fitted now, as the fit put them: what the rest moved them.
      const asFitted = fitted ? cloneSketch(re().sketchDraft!.sketch) : undefined
      const held = re().sketchDraft!.sketch
      // A new piece on an id a relation has is given a free one, what this
      // add names it by following it.
      const { add: given, rounds: roundsGiven, renumbered } = renumberClashes(added, held, re().sketchDraft!.frame, roundsIn as RoundIn[] | undefined)
      const merged: Json = {
        ...given,
        entities: [...held.entities, ...(((given.entities as Json[] | undefined) ?? []) as unknown as SketchEntity[])],
        constraints: [...held.constraints, ...((given.constraints as Json[] | undefined) ?? [])],
      }
      const { sketch, made } = sketchOf(merged, re().sketchDraft!.frame, held, { snap: true })
      // The corners made round, on the sketch as it now stands; then the
      // solve, and the slice points shared out again by the round the
      // solve settled on, until they stay — twice at most.
      const rounds = (roundsGiven ?? []).map((r, i) => {
        const done = roundCorner(sketch, r.a, r.b, r.radius)
        if (typeof done === 'string') throw new CommandError('invalid_input', `add.rounds[${i}]: ${done}`)
        return { ...r, arc: done.arc, found: done.found, dimension: done.dimension }
      })
      let solve = putLanded(sketch, fit, piecesSet?.pull)
      for (let pass = 0; pass < 2 && rounds.length > 0; pass++) {
        const now = cloneSketch(re().sketchDraft!.sketch)
        let moved = 0
        for (const r of rounds) if (r.radius === undefined) moved += reassignCornerPoints(now, r.a, r.b, r.arc)
        if (moved === 0) break
        solve = putSketch(now)
      }
      // The relations the fit was asked to accept, last.
      const accepted = acceptOnDraft((fitIn as FitIn | undefined)?.accept)
      if (accepted.solve) solve = accepted.solve
      // The chains fitted moved for the taper the fit says is to come.
      const offset = draftOffsetDraft(fitIn as FitIn | undefined, fit)
      if (offset.solve) solve = offset.solve
      const roundsOut = rounds.map((r) => {
        const solved = re().sketchDraft!.sketch
        const arc = entityOf(solved, r.arc) as SketchArc
        const sigma = r.radius === undefined ? roundRadiusSigma(solved, r.a, r.b, r.arc) : null
        const read = readPieces([arc])[0]
        const nominal = rounding(arc.r, 'radius', sigma)
        const points = arc.points?.length ?? 0
        // What holds the radius: the one given, the scan's points with the
        // tangencies held, or — too few points to fit — a dimension at the
        // radius the search came to, which is no reading.
        const held = r.radius !== undefined ? 'given' : r.dimension !== undefined ? 'dimension' : 'points'
        const warning = r.radius === undefined ? roundUnread(points, r.found) : null
        return { arc: r.arc, a: r.a, b: r.b, radius: arc.r, sigma, nominal: nominal.nominal, off: nominal.off, sigmas: nominal.sigmas, ...(read?.residual ? { residual: read.residual } : {}), points, held, ...(warning ? { warning } : {}) }
      })
      if (re().commitSketch() === null) throw new CommandError('failed', 'That leaves the sketch with nothing in it — remove the sketch instead.')
      void s
      const after = (allFeatures().find((x) => x.id === f.id) as SketchFeature | undefined)?.sketch
      // Typed points read again on the sketch as it was made.
      givenOut(fit, after)
      const moved = after ? movedPieces(beforeSet, after, asFitted) : { count: 0 }
      const far = after ? movedFar(base, after, asFitted, usePlan.getState().plan?.target.tolerance ?? MOVED_FAR_MM) : null
      extra = {
        ...(gonePieces.length + goneConstraints.length > 0 ? { removed: { pieces: gonePieces.length, constraints: constraintsBefore - base.constraints.length } } : {}),
        ...(Object.keys(renumbered).length > 0 ? { renumbered } : {}),
        ...madeOut(made),
        ...(piecesSet ? { set: piecesSetOut(piecesSet, after) } : {}),
        ...(roundsOut.length > 0 ? { rounds: roundsOut } : {}),
        ...(accepted.accept ? { accept: accepted.accept } : {}),
        ...(offset.draftOffset ? { draftOffset: offset.draftOffset } : {}),
        ...(fitted ? { fitted } : {}),
        ...(fit?.shared ? { shared: fit.shared } : {}),
        ...(fit?.junctions ? { junctions: fit.junctions } : {}),
        ...(fit?.corners ? { corners: fit.corners } : {}),
        ...(fit?.through ? { through: fit.through } : {}),
        ...(projected ? { projected: projected.projected, ...(projected.skipped > 0 ? { skipped: projected.skipped } : {}) } : {}),
        moved,
        ...(far ? { movedFar: far } : {}),
        ...offPieceOut(after),
        solve,
      }
    })
    // What the rows of the features on the sketch say after the rebuild — a
    // region picked that took in another's, say (core/regions.ts picksGrew).
    const nowSketch = (allFeatures().find((x) => x.id === f.id) as SketchFeature | undefined)?.sketch
    const nowRegions = nowSketch ? findRegions(nowSketch) : []
    const warnings = onSketch().flatMap((x) => {
      const said = [picksGrew(x.name, picksWere.get(x.id)?.seen, matchRegions(x.regions, nowRegions), [...picksWere].filter(([id]) => id !== x.id).map(([, o]) => o)), re().results[x.id]?.warning].filter((w): w is string => Boolean(w))
      return said.length > 0 ? [{ feature: x.id, name: x.name, warning: said.join(' ') }] : []
    })
    return featureAnswer(session(), f.id, { ...extra, ...(warnings.length > 0 ? { warnings } : {}), ...(await elementAnswer(allFeatures().find((x) => x.id === f.id))) }, detail, before)
  },
}

/** A corner to round, as reverse.sketch.edit's add takes it. */
interface RoundIn {
  a: number
  b: number
  radius?: number
}

const roundsSchema = arr(
  obj(
    {
      a: int('One piece of the corner, by id: a line or an arc.'),
      b: int('The other piece, by id.'),
      radius: num('mm; the scan’s when left out.', { exclusiveMinimum: 0 }),
    },
    ['a', 'b'],
  ),
  'Corners made round.',
  { minItems: 1 },
)

export const importStep: Command<{ bytes: Uint8Array; name: string; detail?: Detail }> = {
  name: 'import.step',
  title: 'Import a STEP file',
  description:
    'Bring a STEP file in as bodies of their own, as the panel’s Import STEP does: a body for every solid in the file, in the frame the file was drawn in, named after its part where the file names it — a bought-in part, a mating part, the CAD model to check the scan against. An Import feature at the rollback bar, saved with the project. Put the bodies in place with reverse.feature.add { kind: "moveBody", bodies, translate, rotate } — copy: true moves a copy. Returns the feature and the bodies made. One undo step.',
  input: obj({ bytes: bytes('The STEP file’s contents.'), name: fileNameSchema('"motor.step"'), detail: detailIn }, ['bytes', 'name']),
  label: ({ name }) => `import ${name}`,
  run: async ({ bytes: data, name, detail = 'brief' }) => {
    const text = decodeWhole(data, name, 'Export the part with less in it.')
    if (!/^\s*ISO-10303-21\s*;/.test(text.slice(0, 256))) invalid(`${name} is not a STEP file — it does not begin as one (ISO-10303-21).`)
    const before = bodyRows(reverseSession())
    const id = await change(() => {
      re().startFeature('import', { file: re().addStepFile(name, text), name: name.replace(/\.(step|stp)$/i, '') })
      const made = re().commitFeature()
      if (made === null) throw new CommandError('failed', `${name} could not be imported.`)
      return made
    })
    return featureAnswer(session(), id, {}, detail, before)
  },
}

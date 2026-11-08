// SPDX-License-Identifier: AGPL-3.0-only
// Features as the commands take them in: a feature's JSON filled into the
// box the panel would open for it and committed as the panel commits it —
// the extrude and the revolve their own boxes, the rest the feature box —
// with its expressions read through the parameters.

import { invalid } from '../../../src/commands/core/common'
import { findSection } from '../../../src/commands/core/section'
import type { SectionFrame } from '../../../src/core/section/frame'
import type { Vec3 } from '../../../src/core/types'
import { addScaled, cross, dot, normalize } from '../../../src/core/vec'
import { CommandError } from '../../../src/plugins/api'
import { useStore } from '../../../src/state/store'
import { evaluateFor } from '../core/expression'
import { bodyMaker, type ExtrudeExtent, type Feature, type LoftFeature, type NetworkCurve, type NetworkNode, planeOffset, type PlaneRef, planeTakesOffset, revolveMaxDeg, type SketchFeature, type SketchInset, type TrimTool } from '../core/features'
import { SPANS_MAX, SPANS_MIN } from '../core/networkCurve'
import { DEFAULT_NETWORK_FIT } from '../state/reNetworkDraft'
import { describePlaneRef, resolveHoleAxis, resolvePlaneFrame } from '../core/resolve'
import { cloneSketch, emptySketch, type SketchEntity } from '../core/sketch'
import { INSERT_SIZES, insertHole, insertSize } from '../core/inserts'
import { applySlots, type ExprMap, exprsFromCommand, slotAt, slotsOf, unlinkSlot } from '../core/parameters'
import { shadowSketch } from '../core/shadowPieces'
import { DEFAULT_SURFACE_FIT, NET_MAX } from '../core/surfaceFit'
import { sizeOf, threadFaceReading, threadProblem, threadSizes, type ThreadStandard } from '../core/thread'
import { bodiesOfFeature } from '../state/reFeatureHelpers'
import { settle } from '../state/reSketchDraft'
import { type BodyInfo, type ExtrudeDraft, extrudeDraftReady, type FeatureDraft, type FeatureDraftKind, featureDraftReady, type RevolveDraft, revolveDraftReady, roundFaceLength, trimToleranceFor, useReverse } from '../state/reStore'
import { allFeatures, axisOf, bodyAt, bodyFamilyNamed, bodyNamed, edgePicked, type EdgePickIn, edgesPicked, elementNamed, facePicked, type FacePickIn, facesPicked, featureNamed, type Json, largestInside, mirrorPlaneOf, planeOf, re, type Ref, regionKeys, regionPickOf, sketchNamed, storedPicks } from './reCommandCore'
import type { ReverseSession } from './reSession'
import { acceptOnDraft, draftOffsetDraft, fitDraftShared, type FittedOut, givenOut, insetDraft, type InsetIn, type JunctionOut, madeOut, movedPieces, namedIds, type OffPiece, offPieceOut, overDraft, type PreparedFit, projectDraft, type ProjectedOut, type ProjectIn, putLanded, putSketch, type SharedOut, sketchOf } from './reSketchInput'

/** A box with the expressions handed in written into it and every one of
 *  its numbers evaluated: an expression of null lets a field's go; a
 *  number handed in without its expression for a field that had one lets
 *  that go too, as typing a number over it does. */
function withExpressions<T extends { kind?: string; exprs?: ExprMap }>(before: T, after: T, given: Json | undefined, kind: string | undefined, plain: Json): T {
  let next = after
  const slots = slotsOf(next, kind)
  // A number typed over a field's expression lets the expression go.
  for (const path of Object.keys(before.exprs ?? {})) {
    if (given && (path in given || (path === 'taper' && kind === 'extrude' && 'draftDeg' in given))) continue
    const slot = slotAt(before, path, kind)
    const moved = slot && slotAt(next, path, kind) && Math.abs(slot.get(before) - slotAt(next, path, kind)!.get(next)) > 1e-12
    if (moved && Object.keys(plain).length > 0) next = unlinkSlot(next, path)
  }
  if (!given) return applyAll(next, kind)
  if (kind === 'extrude' && 'draftDeg' in given && 'taper' in given) invalid('exprs: give draftDeg or taper, not both — taper is −draftDeg.')
  const exprs = exprsFromCommand(kind, given)
  for (const [asked, expr] of Object.entries(exprs)) {
    // A field named by its last part where one slot ends so — offset for a
    // cut's plane.offset, as a sketch names its own — is that slot.
    const tail = slots.filter((s) => s.path.endsWith(`.${asked}`))
    const path = !slots.some((s) => s.path === asked) && tail.length === 1 ? tail[0].path : asked
    if (!slots.some((s) => s.path === path)) invalid(`exprs.${path}: no such field — this one has ${slots.map((s) => s.path).join(', ') || `none${noSlotsWhy(kind, next)}`}.`)
    if (expr === null) next = unlinkSlot(next, path)
    else if (typeof expr !== 'string' || expr.trim() === '') invalid(`exprs.${path}: an expression is a string.`)
    else next = { ...next, exprs: { ...(next.exprs ?? {}), [path]: expr } }
  }
  return applyAll(next, kind)
}

/** Why a feature of a kind that takes expressions has no number for one. */
function noSlotsWhy(kind: string | undefined, x: object): string {
  const plane = (x as { plane?: { kind: string } | null }).plane
  if ((kind === 'cutPlane' || kind === 'mirror') && plane) return plane.kind === 'face' ? ': its plane is a face of the body, which has no offset — give a plane for one' : ': its plane was fitted where the scan was clicked, and takes no offset'
  if (kind === 'surface') return ': its region was not read in a box — give region: { box } with the expressions'
  return ''
}

function applyAll<T extends { kind?: string; exprs?: ExprMap }>(x: T, kind: string | undefined): T {
  const { next, errors } = applySlots(x, re().parameterTable.scope, kind)
  const wrong = Object.entries(errors)
  if (wrong.length > 0) invalid(wrong.map(([path, e]) => `exprs.${path}: “${x.exprs?.[path]}” — ${e}`).join('; '))
  return next
}

/** The fields of an input that set a number — what lets an expression go. */
const plainNumbers = (input: Json): Json => Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'exprs' && k !== 'kind' && k !== 'name'))

/** A size as it is matched: no spaces, no case, no diameter sign — the
 *  printing form's "Ø10" is "10" too. */
const sizeKey = (label: string) => label.trim().toLowerCase().replace(/\s+/g, '').replace(/^[ø⌀]/, '')

/** What the sizes of a standard are called in a refusal. */
const STANDARD_NAME: Record<ThreadStandard, string> = { metric: 'ISO metric', unc: 'UNC', unf: 'UNF', print45: '45° printing' }

/** A size as it is written with its pitch — "M10x1", "M10×1", "M10 x 1",
 *  "Ø16×3.5 print", "1/4-20 UNC" — split into the size of the table and
 *  the pitch in millimetres; the standard a designation names (UNC, UNF,
 *  print) with it. A size alone has no pitch. */
export function readDesignation(text: string, asked?: ThreadStandard): { size: string; pitch?: number; standard?: ThreadStandard } {
  let t = text.trim()
  let standard: ThreadStandard | undefined
  const named = /\s*\b(unc|unf|print)$/i.exec(t)
  if (named) {
    standard = named[1].toLowerCase() === 'print' ? 'print45' : (named[1].toLowerCase() as ThreadStandard)
    t = t.slice(0, named.index)
  }
  // Metric and the printing form: the pitch after an x or a ×.
  const metric = /^(.+?)\s*[x×*]\s*(\d+(?:[.,]\d+)?)\s*(?:mm)?$/i.exec(t)
  if (metric && !t.includes('/') && !t.startsWith('#')) return { size: metric[1], pitch: Number(metric[2].replace(',', '.')), ...(standard ? { standard } : {}) }
  // Unified: threads per inch after a dash.
  const inch = /[/#]/.test(t) || [standard, asked].some((x) => x === 'unc' || x === 'unf')
  const unified = inch ? /^(.+?)\s*-\s*(\d+(?:\.\d+)?)$/.exec(t) : null
  if (unified) return { size: unified[1], pitch: 25.4 / Number(unified[2]), ...(standard ? { standard } : {}) }
  return { size: t, ...(standard ? { standard } : {}) }
}

/** A thread's size from what was asked: a size of the table — alone, or
 *  as a designation with its pitch — a diameter, or neither — the face
 *  then sizes it, as a click on it does. */
function threadSize(standard: ThreadStandard, input: Json): { diameter: number; pitch: number } | null {
  if (typeof input.size === 'string') {
    const read = readDesignation(input.size, standard)
    const want = sizeKey(read.size)
    const size = threadSizes(standard).find((z) => sizeKey(z.label) === want)
    if (!size) invalid(`There is no ${input.size} among the ${STANDARD_NAME[standard]} sizes — they are ${threadSizes(standard).map((z) => z.label).join(', ')}${read.pitch !== undefined ? ' (a pitch after the size: "M10x1", "1/4-20")' : ''}.`)
    const given = input.pitch as number | undefined
    // units-ok: the agent's input refused — the commands speak millimetres always.
    if (read.pitch !== undefined && given !== undefined && Math.abs(given - read.pitch) > 1e-4) invalid(`size “${input.size}” says a pitch of ${Math.round(read.pitch * 10000) / 10000} mm and pitch says ${given} — give one of them.`)
    return { diameter: size!.diameter, pitch: given ?? read.pitch ?? size!.pitches[0] }
  }
  if (typeof input.diameter === 'number') {
    const pitch = (input.pitch as number | undefined) ?? sizeOf(standard, input.diameter)?.pitches[0]
    // units-ok: as above.
    if (pitch === undefined) invalid(`Ø${input.diameter} mm is no size of the table — give its pitch too.`)
    return { diameter: input.diameter, pitch: pitch! }
  }
  return null
}

/** The fields of a feature's box from what was handed in — all of them for
 *  a new feature, those given for an edit; `box` is the box as it stands,
 *  `editing` whether it was opened on a feature. */
function boxFields(s: ReverseSession, kind: FeatureDraftKind, input: Json, box: FeatureDraft, editing: boolean): Json {
  const has = (k: string) => input[k] !== undefined
  const out: Json = {}
  const d = editing ? box : null
  // A boolean takes a feature that made several bodies by its name: every
  // piece of it, as the builder fuses the family.
  const named = kind === 'boolean' ? bodyFamilyNamed : bodyNamed
  const bodyOf = (): BodyInfo => {
    if (has('body')) return named(input.body as Ref)
    const id = 'body' in box ? box.body : null
    if (id === null) invalid('Name the body it works on (body).')
    return editing ? bodyAt(id!) : bodyNamed(id!)
  }
  if (has('name')) out.name = input.name
  if (has('body')) out.body = bodyOf().id
  switch (kind) {
    case 'shell':
      if (has('faces')) out.faces = facesPicked(s, bodyOf(), input.faces as FacePickIn[])
      if (has('thickness')) Object.assign(out, { thickness: input.thickness, thicknessFrom: 'typed' })
      break
    case 'fillet':
    case 'chamfer':
      if (has('edges')) {
        // An edge at a varying radius is { edge, radius: [start, end] }.
        const all = input.edges as (EdgePickIn | { edge: EdgePickIn; radius: [number, number] })[]
        const varying = all.filter((p): p is { edge: EdgePickIn; radius: [number, number] } => typeof p === 'object' && p !== null && 'edge' in p && Array.isArray((p as { radius?: unknown }).radius))
        const plain = all.filter((p) => !varying.includes(p as never)) as EdgePickIn[]
        out.edges = plain.length > 0 ? edgesPicked(s, bodyOf(), plain, kind === 'fillet' ? 'round' : 'bevel') : []
        if (plain.length > 0 && (out.edges as unknown[]).length === 0 && varying.length === 0)
          throw new CommandError('not_found', `None of the ${plain.length} edge picks names an edge of ${bodyOf().name} — every one is optional and missed (reverse.body.describe { where } shows what there is).`)
        if (kind === 'fillet') out.variable = varying.length > 0 ? varying.map((v) => ({ edge: edgePicked(s, bodyOf(), v.edge), radius: v.radius })) : undefined
        if (kind === 'fillet' && plain.length > 0 && !editing && !has('radius')) invalid('radius: the edges given plainly need one — or give each { edge, radius: [start, end] }.')
      }
      // A box given its edges at a varying radius alone opens on them.
      if (kind === 'fillet' && has('edges')) out.mode = (out.edges as unknown[]).length === 0 && ((out.variable as unknown[] | undefined)?.length ?? 0) > 0 ? 'variable' : 'constant'
      if (has('radius')) Object.assign(out, { radius: input.radius, radiusTyped: true })
      if (has('distance')) out.distance = input.distance
      if (kind === 'chamfer') for (const k of ['mode', 'distance2', 'angleDeg', 'flip']) if (has(k)) out[k] = input[k]
      // A second distance not given starts at the first, an angle at 45°.
      if (kind === 'chamfer' && input.mode === 'twoDistances' && !has('distance2') && !editing) out.distance2 = (input.distance as number | undefined) ?? (box.kind === 'chamfer' ? box.distance : 1)
      if (has('chain')) out.chain = input.chain
      if (has('skipFailing')) out.skipFailing = input.skipFailing
      break
    case 'hole': {
      if (has('axis')) {
        const a = input.axis as Json
        if (a.kind === 'point') {
          const face = facePicked(s, bodyOf(), a.face as FacePickIn).fingerprint
          if (face.kind !== 'plane') invalid(`A hole is drilled into a flat face — that face is a ${face.kind}.`)
          out.axis = { kind: 'point', face, at: (a.at as [number, number, number] | undefined) ?? face.centroid }
        } else out.axis = a.kind === 'face' ? { kind: 'face', face: facePicked(s, bodyOf(), a.face as FacePickIn).fingerprint } : { kind: 'element', id: elementNamed(a, 'axis').id }
      }
      if (has('insert')) {
        const size = insertSize(input.insert as string)
        if (!size) invalid(`There is no insert ${String(input.insert)} — there are ${INSERT_SIZES.map((z) => z.label).join(', ')}.`)
        Object.assign(out, { insert: size!.label, ...insertHole(size!) })
      }
      if (has('radius')) out.radius = input.radius
      else if (has('axis') && !editing && !has('insert')) {
        // Its axis's own radius — which a flat face has none of.
        const axis = resolveHoleAxis(out.axis as never, s.resolveContext())
        if (typeof axis === 'string') invalid(axis)
        if (typeof axis !== 'string' && axis.radius) out.radius = axis.radius
        else invalid('Give the hole a radius, or an insert — its axis has none of its own.')
      }
      if (has('depth')) out.depth = input.depth
      // A number given over the insert's lets the insert go.
      if ((has('radius') || has('depth')) && !has('insert')) out.insert = null
      break
    }
    case 'thread': {
      // A designation that names its standard ("1/4-20 UNC") sets it.
      const named = typeof input.size === 'string' ? readDesignation(input.size).standard : undefined
      if (named && has('standard') && input.standard !== named) invalid(`size “${input.size as string}” is ${STANDARD_NAME[named]}, and standard says ${input.standard as string} — give one of them.`)
      const standard = (input.standard as ThreadStandard | undefined) ?? named ?? (box.kind === 'thread' ? box.standard : 'metric')
      if (has('standard') || named) out.standard = standard
      if (has('face')) {
        const face = facePicked(s, bodyOf(), input.face as FacePickIn)
        if (face.fingerprint.kind !== 'cylinder') invalid(`A thread is cut on a full round face — that face is a ${face.fingerprint.kind}.`)
        Object.assign(out, { face, internal: null, ...(box.kind === 'thread' && box.face ? {} : { length: roundFaceLength(face.fingerprint) }) })
      }
      const size = threadSize(standard, input)
      if (size) Object.assign(out, size, { sized: true })
      else if (has('pitch')) Object.assign(out, { pitch: input.pitch, sized: true })
      if (has('leftHanded')) out.leftHanded = input.leftHanded
      if (has('length')) Object.assign(out, input.length === null ? { fullLength: true } : { fullLength: false, length: input.length })
      for (const k of ['start', 'flip', 'offset', 'chamfer']) if (has(k)) out[k] = input[k]
      break
    }
    case 'extract': {
      for (const k of ['thickness', 'op']) if (has(k)) out[k] = input[k]
      if (has('element') && has('section')) invalid('Give element or section, not both — a body is extracted from one.')
      if (has('element')) Object.assign(out, { element: elementNamed({ id: input.element }, 'element').id, section: null })
      if (has('section')) {
        const sec = findSection(input.section as number | string)
        if (sec.kind !== 'shadow') invalid(`${sec.name} is a cut — only a shadow section stands as a body (section.cut { kind: "shadow" }).`)
        Object.assign(out, { section: sec.id, element: null })
      }
      if (box.kind === 'extract' && box.element === null && box.section === null && !has('element') && !has('section')) invalid('An extract takes element — a plane, cylinder, cone, sphere or torus of 3D Measure — or section, a shadow section.')
      break
    }
    case 'cutPlane':
      if (has('plane')) out.plane = planeOf(s, input.plane as Json)
      if (has('keep')) out.keep = input.keep
      break
    case 'mirror':
      if (has('plane')) out.plane = mirrorPlaneOf(s, input.plane as Json, bodyOf())
      if (has('join')) out.join = input.join
      break
    case 'boolean':
      if (has('op')) out.op = input.op
      if (has('tool')) {
        // One body, or a list: the first in the box's Tool, the rest past it.
        const tools = [...new Set((Array.isArray(input.tool) ? (input.tool as Ref[]) : [input.tool as Ref]).map((t) => bodyFamilyNamed(t).id))]
        if (tools.length === 0) invalid('tool: name a body, or a list of them.')
        Object.assign(out, { tool: tools[0], moreTools: tools.slice(1) })
      }
      if (has('keep')) out.keep = input.keep
      break
    case 'sheet':
      if (has('sketchId')) out.sketchId = sketchNamed(input.sketchId as Ref).id
      for (const k of ['from', 'to']) if (has(k)) out[k] = input[k]
      break
    case 'split':
      if (has('tools')) out.tools = (input.tools as Ref[]).map((t) => bodyNamed(t).id)
      for (const k of ['keep', 'tolerance', 'overlap']) if (has(k)) out[k] = input[k]
      // null takes within off: the whole sheet cuts again.
      if (has('within')) out.within = input.within ?? undefined
      break
    case 'loft':
      if (has('sketches')) out.sketches = (input.sketches as Ref[]).map((t) => sketchNamed(t).id)
      for (const k of ['ruled', 'op']) if (has(k)) out[k] = input[k]
      break
    case 'sweep':
      if (has('profile')) out.profile = sketchNamed(input.profile as Ref).id
      if (has('path') && has('route')) invalid('A sweep follows path or route, not both.')
      if (!editing && !has('path') && !has('route')) invalid('A sweep takes path — a sketch’s one chain — or route: points and a bend radius in 3D.')
      if (has('path')) Object.assign(out, { path: sketchNamed(input.path as Ref).id, route: undefined })
      if (has('route')) Object.assign(out, { route: input.route, path: null })
      if (has('op')) out.op = input.op
      break
    case 'thicken':
      if (has('sheet')) {
        const sheet = bodyNamed(input.sheet as Ref)
        if (!sheet.surface) invalid(`sheet: ${sheet.name} is a solid — thicken takes a sheet or a fitted surface; a solid is grown by offsetBody or hollowed by shell.`)
        out.sheet = sheet.id
      }
      for (const k of ['thickness', 'side', 'op']) if (has(k)) out[k] = input[k]
      // A body named to join it to joins it, unless told to cut.
      if (has('target') && input.target !== null && !has('op')) out.op = 'join'
      break
    case 'pattern':
      if (has('axis')) out.axis = axisOf(input.axis as Json)
      if (has('axis2')) out.axis2 = input.axis2 === null ? null : axisOf(input.axis2 as Json)
      for (const k of ['mode', 'count', 'step', 'count2', 'step2']) if (has(k)) out[k] = input[k]
      break
    case 'draft':
      if (has('neutral')) out.neutral = mirrorPlaneOf(s, input.neutral as Json, bodyOf())
      if (has('faces')) out.faces = facesPicked(s, bodyOf(), input.faces as FacePickIn[])
      if (has('angleDeg')) out.angleDeg = input.angleDeg
      if (has('groups')) {
        const groups = ((input.groups as Json[] | null) ?? []).map((g) => ({ faces: facesPicked(s, bodyOf(), g.faces as FacePickIn[]), angleDeg: g.angleDeg as number }))
        // Each face leans by one angle: in one group, once.
        const first = (out.faces ?? (d?.kind === 'draft' ? d.faces : [])) as { hash: number }[]
        const seen = new Set(first.map((f) => f.hash).filter((h) => h >= 0))
        groups.forEach((g, i) => {
          for (const f of g.faces) {
            if (f.hash >= 0 && seen.has(f.hash)) invalid(`groups[${i}]: a face is picked twice — each face leans by one angle, in faces or in one group.`)
            if (f.hash >= 0) seen.add(f.hash)
          }
        })
        out.groups = groups.length > 0 ? groups : undefined
      }
      break
    case 'offsetBody':
      for (const k of ['distance', 'keep']) if (has(k)) out[k] = input[k]
      break
    case 'moveBody':
      // The bodies first, the pivot following them to their middle — then
      // a pivot given stands over it.
      if (has('bodies')) re().setMoveBodies((input.bodies as Ref[]).map((b) => bodyNamed(b).id))
      for (const k of ['translate', 'rotate', 'pivot', 'copy']) if (has(k)) out[k] = input[k]
      break
    case 'deleteFace':
      if (has('faces')) {
        const body = bodyOf()
        const given = facesPicked(s, body, input.faces as FacePickIn[])
        // Each face with what a click on it takes, each face once.
        const all = input.whole === true ? given.flatMap((f) => s.deleteFacesAt(body.id, f.hash, true)) : given
        out.faces = all.filter((f, i) => all.findIndex((x) => x.hash === f.hash) === i)
      }
      break
    case 'moveFace':
      if (has('faces')) out.faces = facesPicked(s, bodyOf(), input.faces as FacePickIn[])
      if (has('offset')) out.offset = input.offset
      Object.assign(out, { snap: false, reading: null, history: false, lean: false })
      break
    case 'surface': {
      if (has('region')) {
        const n = useStore.getState().vertexCount
        if (!useStore.getState().fileName) throw new CommandError('no_scan', 'A surface is fitted through the scan, and none is open.')
        const region = input.region as number[]
        const out_ = region.find((v) => v >= n)
        if (out_ !== undefined) invalid(`The scan has ${n} vertices; ${out_} is not one of them.`)
        out.region = Uint32Array.from(region)
        // The box it was read in, when it was read in one (reFit), for
        // the box's expressions; read afresh, it is not stale.
        out.regionBox = (input.regionBox as Json | null | undefined) ?? undefined
        out.regionStale = undefined
      }
      if (has('fit')) {
        // A net past the largest would be cut down to it without a word.
        const net = (input.fit as Json).net as { u: number; v: number } | null | undefined
        if (net && (net.u > NET_MAX || net.v > NET_MAX)) invalid(`fit.net: ${net.u} × ${net.v} — a surface's net is ${NET_MAX} × ${NET_MAX} at most; leave net out for one chosen from the region's size and noise.`)
        const normal = (input.fit as Json).normal as number[] | undefined
        if (normal && !(Math.hypot(...normal) > 0)) invalid('fit.normal: give the way the region faces, not a zero vector.')
        out.fit = { ...DEFAULT_SURFACE_FIT, ...(input.fit as Json) }
      }
      for (const k of ['shape', 'constrain']) if (has(k)) out[k] = input[k]
      break
    }
    case 'network': {
      // As the feature list stores it, handed back whole — a copy, or the
      // list's own edited; reverse.network.* takes points on the scan.
      const was = box.kind === 'network' ? box : null
      for (const k of ['nodes', 'curves', 'cells'] as const) if (has(k)) out[k] = JSON.parse(JSON.stringify(input[k]))
      if (has('spans')) {
        const spans = input.spans as Json
        for (const [k, v] of Object.entries(spans)) if (typeof v !== 'number' || !Number.isInteger(v) || v < SPANS_MIN || v > SPANS_MAX) invalid(`spans.${k}: a strip's span count is a whole number from ${SPANS_MIN} to ${SPANS_MAX}.`)
        out.spans = { ...spans }
      }
      if (has('fit')) out.fit = { ...(was?.fit ?? DEFAULT_NETWORK_FIT), ...(input.fit as Json) }
      if (has('nodes') || has('curves')) {
        const nodes = (out.nodes ?? was?.nodes ?? []) as NetworkNode[]
        const curves = (out.curves ?? was?.curves ?? []) as NetworkCurve[]
        const ids = new Set<number>()
        for (const n of nodes) {
          if (ids.has(n.id)) invalid(`nodes: two nodes have the id ${n.id}.`)
          ids.add(n.id)
        }
        const curveIds = new Set<number>()
        for (const c of curves) {
          if (curveIds.has(c.id)) invalid(`curves: two curves have the id ${c.id}.`)
          curveIds.add(c.id)
          const missing = [c.from, c.to].find((n) => !ids.has(n))
          if (missing !== undefined) invalid(`curves: curve ${c.id} runs from node ${c.from} to node ${c.to}, and there is no node ${missing}.`)
        }
        Object.assign(out, { nextId: Math.max(0, ...ids, ...curveIds) + 1, placing: null, history: [], future: [], picked: null })
      }
      break
    }
    case 'trim':
      if (has('tools')) out.tools = (input.tools as Json[]).map((t): TrimTool => (t.kind === 'body' ? { kind: 'body', id: bodyNamed(t.id as Ref).id } : { kind: 'element', id: elementNamed(t, 'tools').id }))
      if (has('tolerance')) Object.assign(out, { tolerance: input.tolerance, toleranceTyped: true })
      else if (has('tools') && !d) out.tolerance = trimToleranceFor(out.tools as TrimTool[], re().results)
      void d
      if (has('overlap')) out.overlap = input.overlap
      break
  }
  return out
}

/** Why a feature's box will not make its feature. */
function notReady(d: FeatureDraft): string {
  if (d.kind === 'thread') return threadProblem(d) ?? (d.face === null ? 'Pick the round face to thread.' : 'The thread needs a length, starting on the face.')
  if ('body' in d && d.body === null) return 'Name the body it works on.'
  if (d.kind === 'import') return 'An import takes its file through reverse.import.step.'
  if (d.kind === 'moveBody') return d.bodies.length === 0 ? 'Name the bodies it moves (bodies).' : 'The move moves nothing — give translate or rotate, or copy: true for a copy where it stands.'
  if (d.kind === 'boolean' && (d.body === d.tool || (d.moreTools ?? []).includes(d.body!))) return 'A body cannot be combined with itself.'
  if (d.kind === 'draft' && ![d.angleDeg, ...(d.groups ?? []).map((g) => g.angleDeg)].every((a) => Math.abs(a) < 89)) return 'The draft needs an angle under 89°.'
  if (d.kind === 'chamfer' && d.mode === 'distanceAngle' && !(d.angleDeg > 0 && d.angleDeg < 90)) return 'The chamfer’s angle is between 0° and 90°.'
  if (d.kind === 'fillet' && (d.variable ?? []).some((v) => !(v.radius[0] > 0 && v.radius[1] > 0))) return 'An edge at a varying radius needs both its radii above zero.'
  if (d.kind === 'pattern' && !(d.count >= 2)) return 'A pattern needs a count of two or more.'
  if (d.kind === 'thicken') return d.sheet === null ? 'Name the sheet to thicken (sheet).' : 'The thicken needs a thickness above zero.'
  if (d.kind === 'split' && d.keep === 'between' && d.tools.length < 2) return 'Keeping what lies between the sheets takes two sheets or more (tools).'
  if (d.kind === 'network') return d.curves.length === 0 ? 'A patch network needs curves (curves, between nodes) — reverse.network.create makes one from points on the scan.' : 'A patch network needs a region filled (cells: a seed inside it) — reverse.network.create and edit fill them (fill: "all").'
  return `The ${d.kind} is missing something it needs — see the feature’s fields.`
}

/** A body feature's box filled from what was handed in, and committed. */
function commitBox(s: ReverseSession, kind: FeatureDraftKind, input: Json, editing: boolean): number {
  const before = re().featureDraft!
  re().setFeatureDraft(boxFields(s, kind, input, before, editing) as Partial<FeatureDraft>)
  let d = re().featureDraft!
  // A thread on a face: a boss or a bore, read off the body's mesh — and,
  // with no size asked for, the standard's size for the face — as a click
  // on the face reads it.
  if (d.kind === 'thread' && d.face && d.body !== null && (input.face !== undefined || d.internal === null)) {
    const mesh = s.meshes.get(d.body)
    const reading = mesh ? threadFaceReading(mesh, d.face, d.standard, d.sized) : null
    if (reading) re().setFeatureDraft(reading)
    else if (!d.sized) invalid('The face could not be read for its size — give the thread a size, or a diameter and a pitch.')
    d = re().featureDraft!
  }
  const next = withExpressions(before, d, input.exprs as Json | undefined, d.kind, plainNumbers(input))
  if (next !== d) re().setFeatureDraft({ ...next, exprs: next.exprs } as Partial<FeatureDraft>)
  d = re().featureDraft!
  if (!featureDraftReady(d)) invalid(notReady(d))
  const id = re().commitFeature()
  if (id === null) throw new CommandError('failed', notReady(d))
  keepQueries(s, id, kind, input)
  return id
}

function extentOf(s: ReverseSession, e: Json): ExtrudeExtent {
  if (e.kind === 'toPlane') return { kind: 'toPlane', from: e.from as number, plane: planeOf(s, e.plane as Json) }
  if (e.kind === 'betweenPlanes') return { kind: 'betweenPlanes', a: planeOf(s, e.a as Json), b: planeOf(s, e.b as Json) }
  if (e.kind === 'toFace') {
    const body = bodyNamed(e.body as Ref)
    const face = facePicked(s, body, e.face as FacePickIn)
    return { kind: 'toFace', from: e.from as number, body: body.id, face: face.fingerprint }
  }
  if (e.kind === 'toBody') return { kind: 'toBody', from: e.from as number, body: bodyNamed(e.body as Ref).id, ...(e.reverse ? { reverse: true } : {}) }
  return e as unknown as ExtrudeExtent
}

/** An extrude's box filled and committed. */
function commitExtrude(s: ReverseSession, input: Json): number {
  const before = re().extrudeDraft!
  const patch: Partial<ExtrudeDraft> = {}
  if (input.name !== undefined) patch.name = input.name as string
  if (input.extent !== undefined) patch.extent = extentOf(s, input.extent as Json)
  if (input.draftDeg !== undefined) patch.draftDeg = input.draftDeg as number
  if (input.direction === null) patch.direction = undefined
  else if (input.direction !== undefined) {
    const d = normalize(input.direction as Vec3)
    if (!d) invalid('direction has no length — give the way to sweep, or null for the sketch plane’s normal.')
    else patch.direction = d
  }
  if (input.op !== undefined) patch.op = input.op as ExtrudeDraft['op']
  if (input.sketchId !== undefined) {
    const sketch = sketchNamed(input.sketchId as Ref)
    Object.assign(patch, { sketchId: sketch.id, regions: regionKeys(s, sketch, input.regions) })
  } else if (input.regions !== undefined && before.sketchId !== null) patch.regions = regionKeys(s, sketchNamed(before.sketchId), input.regions)
  re().setExtrude(patch)
  const d = re().extrudeDraft!
  const next = withExpressions({ ...before, kind: 'extrude' }, { ...d, kind: 'extrude' }, input.exprs as Json | undefined, 'extrude', plainNumbers(input))
  re().setExtrude({ extent: next.extent, draftDeg: next.draftDeg, exprs: next.exprs })
  if (!extrudeDraftReady(re().extrudeDraft!)) invalid('The extrude needs a profile — a sketch’s regions or a face — and an extent with everything it names.')
  const id = re().commitExtrude()
  if (id === null) throw new CommandError('failed', 'The extrude could not be made.')
  if (input.sketchId !== undefined || input.regions !== undefined) keepRegionPick(id, input.regions)
  return id
}

/** A revolve's box filled and committed. */
function commitRevolve(s: ReverseSession, input: Json): number {
  const before = re().revolveDraft!
  const sketch = sketchNamed((input.sketchId as Ref | undefined) ?? before.sketchId!)
  const patch: Partial<RevolveDraft> = {}
  if (input.name !== undefined) patch.name = input.name as string
  if (input.sketchId !== undefined || input.regions !== undefined) Object.assign(patch, { sketchId: sketch.id, regions: regionKeys(s, sketch, input.regions) })
  if (input.axis !== undefined) patch.axis = axisOf(input.axis as Json, sketch)
  if (input.op !== undefined) patch.op = input.op as RevolveDraft['op']
  if (input.leftHanded !== undefined) patch.leftHanded = input.leftHanded as boolean
  re().setRevolve(patch)
  // A coil starts as the panel starts one: its pitch, three turns.
  if (typeof input.pitch === 'number' && input.pitch !== 0 && re().revolveDraft!.pitch === 0) re().setRevolveCoil(true)
  if (input.pitch !== undefined) re().setRevolve({ pitch: input.pitch as number })
  if (input.angleDeg !== undefined) re().setRevolve({ angleDeg: input.angleDeg as number })
  const d = re().revolveDraft!
  const next = withExpressions({ ...before, kind: 'revolve' }, { ...d, kind: 'revolve' }, input.exprs as Json | undefined, 'revolve', plainNumbers(input))
  re().setRevolve({ angleDeg: next.angleDeg, pitch: next.pitch, exprs: next.exprs })
  const ready = re().revolveDraft!
  if (!revolveDraftReady(ready)) invalid(ready.angleDeg > revolveMaxDeg(ready.pitch) ? 'A revolve turns 360° at most — give it a pitch to coil past a whole turn.' : 'The revolve needs a profile, an axis and an angle.')
  const id = re().commitRevolve()
  if (id === null) throw new CommandError('failed', 'The revolve could not be made.')
  if (input.sketchId !== undefined || input.regions !== undefined) keepRegionPick(id, input.regions)
  return id
}

/** A sketch's offset from what was handed in: `offset`, or the
 *  expression in `exprs.offset` (null lets it go) — written into the
 *  sketch in hand, which moves along its plane's normal. */
function sketchOffset(input: Json, plane: PlaneRef, inset?: SketchInset): void {
  const exprs = input.exprs as Record<string, string | null> | undefined
  for (const k of Object.keys(exprs ?? {})) if (k !== 'offset' && !(k === 'inset' && inset)) invalid(`exprs.${k}: no such field — a sketch has offset${inset ? ' and inset' : ''}; its dimensions take their own expr.`)
  const expr = exprs?.offset
  if (input.offset === undefined && expr === undefined) return
  if (!planeTakesOffset(plane)) invalid('A plane fitted where the scan was clicked takes no offset.')
  if (typeof expr === 'string') {
    const r = evaluateFor(expr, 'length', re().parameterTable.scope)
    if (!r.ok) invalid(`exprs.offset: “${expr}” — ${r.error}`)
    re().setSketchOffset(r.ok ? r.value : 0, expr)
  } else re().setSketchOffset((input.offset as number | undefined) ?? planeOffset(plane), null)
}

/** What an inset's expression comes to, mm — refused when it does not. */
function insetWall(expr: string): number {
  const r = evaluateFor(expr, 'length', re().parameterTable.scope)
  if (!r.ok) invalid(`exprs.inset: “${expr}” — ${r.error}`)
  return r.ok ? r.value : 0
}

/** An expression of the sketch in hand set, or let go (null). */
function setDraftExpr(path: string, expr: string | null): void {
  useReverse.setState((s) => {
    const d = s.sketchDraft
    if (!d) return {}
    const exprs = { ...(d.exprs ?? {}) }
    if (expr) exprs[path] = expr
    else delete exprs[path]
    return { sketchDraft: { ...d, exprs: Object.keys(exprs).length > 0 ? exprs : undefined } }
  })
}

/** The kinds whose picks are kept as their queries too, by the field the
 *  picks are given in — the feature's own field for them. */
const KEPT_QUERIES: Partial<Record<FeatureDraftKind, { field: 'edges' | 'faces'; kept: 'edgesWhere' | 'facesWhere' }>> = {
  fillet: { field: 'edges', kept: 'edgesWhere' },
  chamfer: { field: 'edges', kept: 'edgesWhere' },
  shell: { field: 'faces', kept: 'facesWhere' },
  draft: { field: 'faces', kept: 'facesWhere' },
  moveFace: { field: 'faces', kept: 'facesWhere' },
  deleteFace: { field: 'faces', kept: 'facesWhere' },
}

/** The queries (where) a feature's faces or edges were given by, kept on
 *  it to be run again at every build (core/where.ts) — or let go, for
 *  picks given otherwise. Written after the commit, as the inset record
 *  is: not a step of its own. An edge at a varying radius, a draft group's
 *  faces and faces taken whole keep their fingerprints alone. */
function keepQueries(s: ReverseSession, id: number, kind: FeatureDraftKind, input: Json): void {
  const kept = KEPT_QUERIES[kind]
  if (!kept || input[kept.field] === undefined) return
  const f = re().features.find((x) => x.id === id)
  if (!f || !('body' in f) || typeof f.body !== 'number') return
  const given = (input[kept.field] as unknown[]).filter((p) => !(typeof p === 'object' && p !== null && 'edge' in p && Array.isArray((p as { radius?: unknown }).radius)))
  const picks = kind === 'deleteFace' && input.whole === true ? undefined : storedPicks(s, bodyAt(f.body), given, kept.field === 'edges' ? 'edge' : 'face')
  useReverse.setState((st) => ({
    features: st.features.map((x) => {
      if (x.id !== id) return x
      const { [kept.kept]: _was, ...rest } = x as Feature & Record<string, unknown>
      void _was
      return (picks ? { ...rest, [kept.kept]: picks } : rest) as Feature
    }),
  }))
}

/** How an extrude's or a revolve's regions were asked for, kept on it to
 *  be taken again as given when its sketch is edited (regionPickOf) — or
 *  let go, for keys alone; regions given anew are no longer ones found by
 *  place. */
function keepRegionPick(id: number, pick: unknown): void {
  useReverse.setState((st) => ({
    features: st.features.map((f) => {
      if (f.id !== id || (f.kind !== 'extrude' && f.kind !== 'revolve')) return f
      const { regionPick: _pick, regionsByPlace: _placed, ...rest } = f
      void _pick
      void _placed
      const kept = regionPickOf(pick, f.regions)
      return (kept ? { ...rest, regionPick: kept } : rest) as Feature
    }),
  }))
}

/** A sketch feature's inset record written (undefined lets it go, and its
 *  expression with it) — not a step of its own: the edit it follows is. */
function setInsetRecord(id: number, inset: SketchInset | undefined): void {
  useReverse.setState((s) => ({
    features: s.features.map((f) => {
      if (f.id !== id || f.kind !== 'sketch') return f
      if (inset) return { ...f, inset }
      const next: SketchFeature = unlinkSlot(f, 'inset')
      delete next.inset
      return next
    }),
  }))
}

const ANGLE_ON_FLAT = 'angleDeg turns a sketch on a plane through an axis about that axis — this one is on a flat plane; move it along its normal with offset.'

/** A sketch on a plane through an axis turned to `angleDeg` about it, as
 *  an offset moves a flat one along its normal: its pieces keep their
 *  [u, v], and what is built on it follows. */
function sketchAngle(input: Json, plane: PlaneRef): void {
  if (input.angleDeg === undefined) return
  if (plane.kind !== 'radial') invalid(ANGLE_ON_FLAT)
  if (!re().setSketchAngle(input.angleDeg as number)) throw new CommandError('not_found', 'The axis this sketch’s plane goes through is not there any more.')
}

/** What a sketch on a face of a body starts with: the face's outline,
 *  as the panel's Sketch here projects it — on the face itself; a sketch
 *  stood off it (offset) is no feature that starts there. */
const faceOutlineOf = (plane: PlaneRef): ProjectIn[] => (plane.kind === 'bodyFace' && !plane.offset ? [{ body: plane.body, face: plane.face as FacePickIn }] : [])

/** A new feature through its box. */
export function addFeature(s: ReverseSession, input: Json, prepared?: PreparedFit): { id: number; largestInside?: string; solve?: unknown; fitted?: FittedOut[]; projected?: ProjectedOut[]; skipped?: number; notProjected?: string; shared?: SharedOut[]; junctions?: JunctionOut[]; corners?: number; offPiece?: OffPiece[] } & Partial<ReturnType<typeof madeOut>> {
  const r = re()
  switch (input.kind) {
    case 'sketch': {
      const p = input.plane as Json
      if (p.kind === 'bodyFace') {
        const plane = planeOf(s, p) as Extract<PlaneRef, { kind: 'bodyFace' }>
        r.startSketch(plane, plane.frame)
      } else if (!r.startSketchOn(planeOf(s, p))) throw new CommandError('not_found', 'That plane is not there any more.')
      if (input.name !== undefined) re().setSketchName(input.name as string)
      sketchOffset(input, re().sketchDraft!.plane)
      sketchAngle(input, re().sketchDraft!.plane)
      const { fit: _fit, project, inset, ...drawn } = input.sketch as Json
      void _fit
      // On a shadow section, its outline is in already, as the panel's
      // sketch on one starts — laid again with its ids clear of those the
      // sketch handed in names, or taken out for project: false.
      const under = re().sketchDraft!.plane
      const shadowSec = under.kind === 'section' ? useStore.getState().sections.find((x) => x.id === under.id) : undefined
      const shadow = shadowSec?.kind === 'shadow' && shadowSec.cut?.shadow && shadowSec.cut.shadow.loops.length > 0 ? shadowSec.cut.shadow : undefined
      if (shadow) re().setSketch(project === false ? emptySketch() : shadowSketch(shadow, re().sketchDraft!.frame, namedIds(drawn, re().sketchDraft!.frame) + 1))
      const shadowed = shadow !== undefined && project !== false
      // A profile moved in from another sketch: its pieces and relations
      // first, at the same [u, v].
      const of = (inset as InsetIn | undefined)?.of
      if (of !== undefined) {
        if (prepared) invalid('inset.of moves another sketch’s profile in — leave fit out with it.')
        re().setSketch(cloneSketch(sketchNamed(of).sketch))
      }
      // Then the part's own geometry, projected — on a face of a body, the
      // face's outline first, as the panel's sketch on a face starts — so
      // that the outline fitted next lands on it; then what was drawn.
      // A face whose outline does not project (its edges not found on the
      // body as it stands) leaves the sketch to start empty, and says why.
      let projected: ReturnType<typeof projectDraft> | undefined
      let notProjected: string | undefined
      // Not twice: a project that names the face itself stands for it.
      const plane = re().sketchDraft!.plane
      const own = Array.isArray(project) && plane.kind === 'bodyFace' ? facePicked(s, bodyNamed(plane.body), plane.face as FacePickIn).hash : -1
      const named = own >= 0 && (project as ProjectIn[]).some((it) => 'face' in it && plane.kind === 'bodyFace' && bodyNamed(it.body).id === plane.body && facePicked(s, bodyNamed(it.body), it.face).hash === own)
      const outline = project !== false && !named ? faceOutlineOf(plane) : []
      if (outline.length > 0) {
        // The outline put in first, its ids clear of those the sketch
        // handed in names: a piece given id 1 is that piece, as on a plane.
        const top = namedIds(drawn, re().sketchDraft!.frame)
        const held = re().sketchDraft!.sketch
        if (top >= held.nextId) re().setSketch({ ...held, nextId: top + 1 })
        try {
          projected = projectDraft(s, outline, re().features.length)
        } catch (e) {
          if (!(e instanceof CommandError)) throw e
          notProjected = `The face’s outline is not projected: ${e.message}`
        }
      }
      if (Array.isArray(project)) {
        const more = projectDraft(s, project as ProjectIn[], re().features.length)
        projected = projected ? { projected: [...projected.projected, ...more.projected], skipped: projected.skipped + more.skipped } : more
      }
      const fit = prepared ? fitDraftShared(prepared) : undefined
      const fitted = fit?.fitted
      // The pieces as the fit put them, for what accept moved.
      const asFitted = fitted ? cloneSketch(re().sketchDraft!.sketch) : undefined
      // Ends a hair apart joined (snapNewEnds), as reverse.sketch.edit joins them.
      const { sketch, made } = fitted || projected || of !== undefined || shadowed ? sketchOf(overDraft(drawn), re().sketchDraft!.frame, re().sketchDraft!.sketch, { snap: true }) : sketchOf(drawn, re().sketchDraft!.frame, undefined, { snap: true })
      const first = putLanded(sketch, fit)
      // The relations the fit was asked to accept, on the sketch solved.
      const accepted = acceptOnDraft(prepared?.fit.accept)
      const { accept } = accepted
      const moved = accept && asFitted ? movedPieces(emptySketch(), re().sketchDraft!.sketch, asFitted) : undefined
      // The chains fitted moved for the taper the fit says is to come.
      const offset = draftOffsetDraft(prepared?.fit, fit)
      // Last, the whole profile moved in.
      const insetOut = inset ? insetDraft(inset as InsetIn) : undefined
      const solve = insetOut?.solve ?? offset.solve ?? accepted.solve ?? first
      const id = re().commitSketch()
      if (id === null) throw new CommandError('failed', 'The sketch could not be made.')
      const after = (re().features.find((x) => x.id === id) as SketchFeature | undefined)?.sketch
      // Typed points read again on the sketch as it was made.
      givenOut(fit, after)
      return {
        id,
        solve,
        ...(accept ? { accept } : {}),
        ...(moved ? { moved } : {}),
        ...(offset.draftOffset ? { draftOffset: offset.draftOffset } : {}),
        ...(insetOut ? { inset: insetOut.inset } : {}),
        ...madeOut(made),
        ...(fitted ? { fitted } : {}),
        ...(fit?.shared ? { shared: fit.shared } : {}),
        ...(fit?.junctions ? { junctions: fit.junctions } : {}),
        ...(fit?.corners ? { corners: fit.corners } : {}),
        ...(fit?.through ? { through: fit.through } : {}),
        ...(projected ? { projected: projected.projected, ...(projected.skipped > 0 ? { skipped: projected.skipped } : {}) } : {}),
        ...(notProjected ? { notProjected } : {}),
        ...offPieceOut(after),
      }
    }
    case 'extrude': {
      if (input.face !== undefined) {
        const f = input.face as Json
        const body = bodyNamed(f.body as Ref)
        const why = r.extrudeFace(body.id, facePicked(s, body, f.face as FacePickIn))
        if (why) invalid(why)
      } else if (input.sketchId === undefined) invalid('An extrude takes a sketch (sketchId) or a face of a body (face).')
      else {
        const sketch = sketchNamed(input.sketchId as Ref)
        r.startExtrude(sketch.id, regionKeys(s, sketch, input.regions))
      }
      const id = commitExtrude(s, { ...input, sketchId: undefined, regions: undefined })
      if (input.face === undefined) keepRegionPick(id, input.regions)
      const hole = input.face === undefined ? largestInside(s, sketchNamed(input.sketchId as Ref), input.regions) : undefined
      return { id, ...(hole ? { largestInside: hole } : {}) }
    }
    case 'revolve': {
      const sketch = sketchNamed(input.sketchId as Ref)
      r.startRevolve(sketch.id, regionKeys(s, sketch, input.regions), axisOf(input.axis as Json, sketch))
      const id = commitRevolve(s, { ...input, sketchId: undefined, regions: undefined, axis: undefined })
      keepRegionPick(id, input.regions)
      const hole = largestInside(s, sketch, input.regions)
      return { id, ...(hole ? { largestInside: hole } : {}) }
    }
    default: {
      const kind = input.kind as FeatureDraftKind
      r.startFeature(kind)
      if (!re().featureDraft) invalid(`A ${kind} cannot be added.`)
      return { id: commitBox(s, kind, input, false) }
    }
  }
}

/** A station's inner twin: a sketch on the station's plane, in its frame,
 *  holding its profile moved inward by `by` (insetDraft) — and where it
 *  came from, so that the wall's expression, `expr` when one is given,
 *  moves it in again from the station as it stands. */
export function addInsetTwin(source: SketchFeature, name: string, by: number, expr?: string): { id: number } & ReturnType<typeof insetDraft> {
  re().startSketch(source.plane, source.frame)
  re().setSketchName(name)
  re().setSketch(cloneSketch(source.sketch))
  const out = insetDraft({ by })
  if (expr) setDraftExpr('inset', expr)
  // On its station's plane, it follows what moves that plane.
  if (source.exprs?.offset) setDraftExpr('offset', source.exprs.offset)
  const id = re().commitSketch()
  if (id === null) throw new CommandError('failed', `${name} could not be made.`)
  setInsetRecord(id, { of: source.id, by, keep: out.inset.kept })
  return { id, ...out }
}

/** A feature shown or hidden: a sketch on the part, any other feature its
 *  bodies (bodiesOfFeature) — as their eyes in the body list do, so the
 *  export, the comparison and the pictures leave hidden ones out. What was
 *  shown or hidden, for the answer. */
/** The bodies `visible` shows or hides for a feature other than a sketch —
 *  refused, changing nothing, when it has none standing. */
function bodiesToShow(f: Feature): number[] {
  const r = re()
  const ids = bodiesOfFeature(f, r.bodies, r.results[f.id])
  if (ids.length === 0) invalid(`${f.name} has no body standing to show or hide — it built none, or a later feature took its body into another; show or hide that body (reverse.body.set { visible }).`)
  return ids
}

function showFeature(f: Feature, visible: boolean): { visibility?: { visible: boolean; bodies: { id: number; name: string }[] } } {
  const r = re()
  if (f.kind === 'sketch') {
    if (visible !== r.features.concat(r.rolledBack).find((x) => x.id === f.id)?.visible) r.toggleFeatureVisible(f.id)
    return {}
  }
  const ids = bodiesToShow(f)
  r.setBodiesVisible(ids, visible)
  return { visibility: { visible, bodies: ids.map((id) => ({ id, name: bodyAt(id).name })) } }
}

/** Where a loft's expression went: the sketch, and the expression it took. */
interface Routed {
  sketch: { id: number; name: string }
  exprs: Json
}

/** A loft's inner stations: its own sketches, where it is the inner loft,
 *  or the sketches moved in from its own. */
function innerStations(f: LoftFeature): SketchFeature[] {
  const sketches = allFeatures().filter((x): x is SketchFeature => x.kind === 'sketch')
  const own = f.sketches.map((id) => sketches.find((x) => x.id === id)).filter((x): x is SketchFeature => x !== undefined)
  if (own.length > 0 && own.every((x) => x.inset)) return own
  return sketches.filter((x) => x.inset && f.sketches.includes(x.inset.of))
}

/** A loft's expressions written onto its stations: sections.<k>.offset on
 *  its k-th sketch as the sketch's offset — and on that station's inner
 *  one, on its plane — inner on each inner station as its inset; each
 *  edited as reverse.feature.update edits a sketch. */
function loftExprs(s: ReverseSession, f: LoftFeature, exprs: Json): Routed[] {
  const out: Routed[] = []
  const n = f.sketches.length
  for (const [key, expr] of Object.entries(exprs)) {
    if (expr !== null && (typeof expr !== 'string' || expr.trim() === '')) invalid(`exprs.${key}: an expression is a string.`)
    const at = /^sections\.(\d+)\.offset$/.exec(key)
    let targets: { sketch: SketchFeature; path: string }[]
    if (at) {
      const k = Number(at[1])
      if (k >= n) invalid(`exprs.${key}: ${f.name} has ${n} sections — sections.0.offset to sections.${n - 1}.offset.`)
      const sketch = allFeatures().find((x): x is SketchFeature => x.id === f.sketches[k] && x.kind === 'sketch')
      if (!sketch) throw new CommandError('not_found', `exprs.${key}: the sketch of section ${k} is gone.`)
      if (!planeTakesOffset(sketch.plane)) invalid(`exprs.${key}: ${sketch.name} is on a plane fitted where the scan was clicked, which takes no offset.`)
      // Its inner station stands on its plane, and goes with it.
      const twins = allFeatures().filter((x): x is SketchFeature => x.kind === 'sketch' && x.inset?.of === sketch.id)
      targets = [sketch, ...twins].map((t) => ({ sketch: t, path: 'offset' }))
    } else if (key === 'inner') {
      const twins = innerStations(f)
      if (twins.length === 0) invalid(`exprs.inner: ${f.name} has no inner stations — inner makes them when the loft is added (reverse.feature.add { kind: "loft", sections, fit, inner }).`)
      targets = twins.map((sketch) => ({ sketch, path: 'inset' }))
    } else invalid(`exprs.${key}: no such field — a loft has sections.<k>.offset (its k-th station’s plane, k from 0 to ${n - 1}) and inner (its inner stations’ wall).`)
    for (const t of targets!) {
      updateFeature(s, allFeatures().find((x) => x.id === t.sketch.id)!, { exprs: { [t.path]: expr } })
      out.push({ sketch: { id: t.sketch.id, name: t.sketch.name }, exprs: { [t.path]: expr } })
    }
  }
  return out
}

/** A sketch's u flattened onto another plane, or null where it stands
 *  about square to the plane (under about 6° in it) and gives no way. */
function flatU(u: Vec3, normal: Vec3): Vec3 | null {
  const n = normalize(normal)
  if (!n) return null
  const flat = addScaled(u, n, -dot(u, n))
  return Math.hypot(flat[0], flat[1], flat[2]) < 0.1 ? null : normalize(flat)
}

/** The plane and frame a sketch moved to another plane lands in: the plane
 *  as given, its u started from the one the sketch had (resolvePlaneFrame
 *  seedU) where the plane leaves the choice — so a profile goes over as
 *  drawn — and `up` or a plane through an axis lay it out as they lay any
 *  sketch. A body's face is one made before the sketch. */
function planeMovedTo(s: ReverseSession, f: SketchFeature, given: Json | string): { plane: PlaneRef; frame: SectionFrame } {
  const plane = planeOf(s, given)
  const up = typeof given === 'object' && given !== null && given.up !== undefined
  if (plane.kind === 'bodyFace') {
    const all = allFeatures()
    const maker = all.findIndex((x) => x.id === bodyMaker(plane.body))
    if (maker >= all.indexOf(f)) invalid(`plane: ${bodyAt(plane.body).name} is made by ${all[maker].name}, below ${f.name} — a sketch lies on a face made before it; move ${f.name} below ${all[maker].name} first (reverse.feature.move).`)
    const u = up ? null : flatU(f.frame.basisU, plane.frame.normal)
    const frame = u ? { ...plane.frame, basisU: u, basisV: cross(plane.frame.normal, u) } : plane.frame
    return { plane: { ...plane, frame }, frame }
  }
  const store = useStore.getState()
  const ctx = { sections: store.sections, elements: store.elements, modelCenter: store.modelCenter }
  const laid = resolvePlaneFrame(plane, ctx)
  if (!laid) throw new CommandError('not_found', 'That plane is not there any more.')
  const u = flatU(f.frame.basisU, laid.normal)
  return { plane, frame: (u && resolvePlaneFrame(plane, ctx, u)) || laid }
}

/** The sketch in hand put on another plane: its pieces keep their [u, v],
 *  so its regions and a revolve's axis line — named by piece — stay picked.
 *  A fitted piece's slice points were the old plane's cut of the scan, and
 *  go; a projected piece is taken again on the new plane by the build; the
 *  old plane's offset expression goes with the old plane. What the answer
 *  says of it. */
function putOnPlane(to: { plane: PlaneRef; frame: SectionFrame }): { plane: string; note?: string } {
  const d = re().sketchDraft!
  const before = cloneSketch(d.sketch)
  const sketch = cloneSketch(d.sketch)
  const dropped: number[] = []
  sketch.entities = sketch.entities.map((e) => {
    if (!('points' in e) || !e.points?.length) return e
    dropped.push(e.id)
    const { points: _points, scatter: _scatter, ...rest } = e as SketchEntity & { points?: unknown; scatter?: unknown }
    void _points
    void _scatter
    return rest as SketchEntity
  })
  const { offset: lostExpr, ...exprs } = d.exprs ?? {}
  useReverse.setState({ sketchDraft: settle({ ...d, plane: to.plane, frame: to.frame, sketch, fitted: {}, exprs: Object.keys(exprs).length > 0 ? exprs : undefined }, before) })
  const projected = sketch.entities.filter((e) => e.projected && e.source).length
  const store = useStore.getState()
  const said = [
    dropped.length > 0 ? `${dropped.length === 1 ? 'Piece' : 'Pieces'} ${dropped.join(', ')} let ${dropped.length === 1 ? 'its' : 'their'} slice points go — the old plane’s cut of the scan; fit them again on this one (reverse.sketch.edit { remove: { pieces }, add: { fit } }) where the scan should hold them.` : '',
    projected > 0 ? `${projected} projected ${projected === 1 ? 'piece is' : 'pieces are'} taken again on this plane.` : '',
    lostExpr ? `The old plane’s offset expression (${lostExpr}) went with it.` : '',
  ].filter(Boolean)
  return { plane: describePlaneRef(to.plane, { sections: store.sections, elements: store.elements }), ...(said.length > 0 ? { note: said.join(' ') } : {}) }
}

/** An extrude's or a revolve's regions given again as "largest" on an
 *  edit: the warning when that took a ring's hole (largestInside). */
function holeTaken(s: ReverseSession, f: Feature, pick: unknown): { largestInside?: string } {
  const sketchId = (featureNamed(f.id) as { sketchId?: number | null }).sketchId
  const hole = sketchId != null ? largestInside(s, sketchNamed(sketchId), pick) : undefined
  return hole ? { largestInside: hole } : {}
}

/** A feature's box opened on it, what was handed in written over it, and
 *  committed: the panel's edit. */
export function updateFeature(s: ReverseSession, f: Feature, set: Json): { solve?: unknown; inset?: unknown; routed?: Routed[]; largestInside?: string } & Partial<ReturnType<typeof madeOut>> & ReturnType<typeof showFeature> & Partial<ReturnType<typeof putOnPlane>> {
  // Shown or hidden, suppressed or not, only once the rest of the edit is
  // taken: set first, they stood after an edit refused — and the refusal
  // still recorded a step (issue 34). What would refuse them is asked first.
  if (set.visible !== undefined && f.kind !== 'sketch') bodiesToShow(f)
  const fields = Object.fromEntries(Object.entries(set).filter(([k]) => k !== 'visible' && k !== 'suppressed'))
  const edited = Object.keys(fields).length === 0 ? {} : editFields(s, f, fields)
  const shown = set.visible !== undefined ? showFeature(f, set.visible === true) : {}
  if (set.suppressed !== undefined) re().setSuppressed([f.id], set.suppressed === true)
  return { ...edited, ...shown }
}

/** The fields of an update other than visible and suppressed, written over
 *  the feature's box and committed. */
function editFields(s: ReverseSession, f: Feature, fields: Json): { solve?: unknown; inset?: unknown; routed?: Routed[]; largestInside?: string } & Partial<ReturnType<typeof madeOut>> & Partial<ReturnType<typeof putOnPlane>> {
  const r = re()
  switch (f.kind) {
    case 'sketch': {
      const given = fields.sketch as Json | undefined
      // A fit lays pieces over what the sketch has; handed back whole, the
      // sketch has nothing for it to go over.
      if (given?.fit !== undefined) invalid('sketch.fit is not taken by an update — refit a sketch with reverse.sketch.edit { sketch, remove: { pieces: the fitted ones }, add: { fit } }; reverse.feature.list gives its pieces.')
      // On another plane, its pieces where they lie on the sheet.
      const onPlane = fields.plane !== undefined ? planeMovedTo(s, f, fields.plane as Json | string) : undefined
      const plane = onPlane?.plane ?? f.plane
      if (fields.angleDeg !== undefined && plane.kind !== 'radial') invalid(ANGLE_ON_FLAT)
      r.editSketch(f.id)
      const moved = onPlane ? putOnPlane(onPlane) : {}
      if (fields.name !== undefined) re().setSketchName(fields.name as string)
      sketchOffset(fields, plane, f.inset)
      sketchAngle(fields, plane)
      // A profile moved in from another sketch, its wall by an expression:
      // moved in again from that sketch, by what the expression comes to.
      const insetExpr = (fields.exprs as Json | undefined)?.inset as string | null | undefined
      const byExpr = typeof insetExpr === 'string' ? insetWall(insetExpr) : undefined
      if (byExpr !== undefined && given?.inset !== undefined) invalid('Give sketch.inset or exprs.inset, not both — exprs.inset moves the profile in again from the sketch it came from.')
      if (insetExpr !== undefined) setDraftExpr('inset', insetExpr)
      const asked = byExpr !== undefined ? { of: f.inset!.of, by: byExpr, keep: f.inset!.keep } : (given?.inset as InsetIn | undefined)
      if (asked !== undefined) {
        // The inset taken again, in place: from `of` as it stands now, or
        // this sketch's own profile; what is drawn with it goes on top.
        const { inset: _inset, ...drawn } = given ?? {}
        void _inset
        const of = asked.of
        if (of !== undefined) re().setSketch(cloneSketch(sketchNamed(of).sketch))
        const read = ['entities', 'shapes', 'constraints', 'patterns'].some((k) => drawn[k] !== undefined) ? sketchOf(overDraft(drawn), re().sketchDraft!.frame, re().sketchDraft!.sketch, { snap: true }) : null
        if (read) putSketch(read.sketch)
        const out = insetDraft(asked)
        // A wall given as a number lets its expression go.
        if (byExpr === undefined) setDraftExpr('inset', null)
        if (re().commitSketch() === null) throw new CommandError('failed', 'A sketch with nothing in it is no sketch — remove it instead.')
        // What the sketch was moved in from, kept for the expression: a
        // profile of its own moved in further is the old wall and more.
        if (f.inset || byExpr !== undefined) setInsetRecord(f.id, of !== undefined ? { of: sketchNamed(of).id, by: asked.by, keep: out.inset.kept } : f.inset ? { ...f.inset, by: f.inset.by + asked.by } : undefined)
        return { solve: out.solve, inset: out.inset, ...(read ? madeOut(read.made) : {}), ...moved }
      }
      // Handed back on another plane: the slice points the move let go stay
      // gone.
      const read = given !== undefined ? sketchOf(given, re().sketchDraft!.frame, onPlane ? re().sketchDraft!.sketch : f.sketch, { snap: true }) : null
      const solve = read ? putSketch(read.sketch) : undefined
      if (re().commitSketch() === null) throw new CommandError('failed', 'A sketch with nothing in it is no sketch — remove it instead.')
      // The inset's expression let go: a sketch closed with nothing else
      // done is left as it was, so it goes here.
      if (insetExpr === null) useReverse.setState((s) => ({ features: s.features.map((x) => (x.id === f.id ? unlinkSlot(x, 'inset') : x)) }))
      return { solve, ...(read ? madeOut(read.made) : {}), ...moved }
    }
    case 'extrude':
      r.editExtrude(f.id)
      if (fields.face !== undefined) invalid('An extrude keeps what it is pulled from — make a new one.')
      commitExtrude(s, fields)
      return holeTaken(s, f, fields.regions)
    case 'revolve':
      r.editRevolve(f.id)
      commitRevolve(s, fields)
      return holeTaken(s, f, fields.regions)
    case 'loft': {
      // A loft's numbers are its stations': the expressions go to them.
      const { exprs, ...others } = fields
      const routed = exprs !== undefined ? loftExprs(s, f, exprs as Json) : undefined
      if (Object.keys(others).length > 0) {
        r.editFeature(f.id)
        commitBox(s, 'loft', others, true)
      }
      return routed ? { routed } : {}
    }
    default:
      r.editFeature(f.id)
      if (!re().featureDraft) invalid(`${f.name} cannot be edited.`)
      commitBox(s, f.kind as FeatureDraftKind, fields, true)
      return {}
  }
}

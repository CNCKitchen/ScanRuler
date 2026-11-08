// SPDX-License-Identifier: AGPL-3.0-only
// Elements: fitted on the scan, constructed from others, renamed, removed,
// shown and hidden. Each goes through the 3D Measure panel's own box — the
// draft is opened, filled and created exactly as a person does it, and closed
// again before the command returns.

import { hasDiameter } from '../../core/elements/assumed'
import { methodsForKind } from '../../core/elements/construct'
import { isExtendable, type ExtendSide } from '../../core/elements/extend'
import { isOrientable, type OrientRelation } from '../../core/elements/orient'
import { worldAxisDir, worldPlaneName, type WorldAxis } from '../../core/section/frame'
import { providesRole } from '../../core/elements/refs'
import type { ScanSpot } from '../../core/geometry/nearest'
import type { ElementKind, FitTold, PointFit, SigmaPreset, Vec3 } from '../../core/types'
import { forgetSurface } from '../../app/surfaces'
import { useStore } from '../../state/store'
import { commandHost } from '../host'
import {
  elementRefSchema,
  findElement,
  locationSchema,
  measuredElement,
  parsePlaneName,
  planeRef,
  requireScan,
  resolveLocation,
  type ElementRef,
  type Location,
} from '../refs'
import { anyObject, arr, bool, enumOf, int, num, obj, oneOf, str, vec3 } from '../schema'
import type { FitGuide } from '../../core/fit/guide'
import { looksLikeCrown } from '../../core/fit/segment'
import { seedOff } from '../../core/fit/seedOff'
import { describeElement } from '../state'
import { unlinkedSource } from '../../state/elementModel'
import { requireMarked, setMarked } from '../marked'
import { roundTo } from '../../core/round'
import { CommandError, type Command } from '../types'
import { requireMeasureFree, showWorkspace, waitFor } from './common'
import { measureRef } from './dimension'

/** The kinds a fit on the scan makes: the five fitted ones, a point picked
 *  on it, and a circle through picked points. */
const FIT_KINDS = ['plane', 'sphere', 'cylinder', 'cone', 'torus', 'point', 'circle'] as const
type FitKind = (typeof FIT_KINDS)[number]
const SURFACE_KINDS = ['plane', 'sphere', 'cylinder', 'cone', 'torus'] as const
const ALL_KINDS: readonly ElementKind[] = ['point', 'line', 'plane', 'sphere', 'cylinder', 'cone', 'circle', 'torus']

const sigmaSchema = enumOf(
  [3, 2, 1, 0] as SigmaPreset[],
  'Outlier cut-off, sigma: 3 (the default), 2, 1, or 0 for all points.',
)

const orientSchema = obj(
  {
    to: elementRefSchema('A plane element, a section, or "XY", "YZ", "XZ".'),
    relation: enumOf(['normal', 'inPlane'] as OrientRelation[], 'normal (the default): the direction is the plane’s normal. inPlane: it lies in the plane.'),
  },
  ['to'],
  'Align the direction to a plane, as designed; the measured fit is kept beside it.',
)

const extendSchema = obj(
  {
    start: num('Cylinder: mm past the start (negative pulls it in).'),
    end: num('Cylinder: mm past the end.'),
    uMin: num('Plane: mm past the edge along its first axis.'),
    uMax: num('Plane: the opposite edge.'),
    vMin: num('Plane: along its second axis.'),
    vMax: num('Plane: the opposite edge.'),
  },
  [],
  'Mm a cylinder or plane is drawn and exported past the measured surface.',
)

const finishing = {
  sigma: sigmaSchema,
  knownDiameter: num('Sphere: a known diameter held, mm (a gauge ball); the centre alone is fitted.', { exclusiveMinimum: 0 }),
  assumed: num('The designed diameter, mm: drawn and exported at it, reported as measured.', { exclusiveMinimum: 0 }),
  orient: orientSchema,
  extend: extendSchema,
  name: str('A name; else numbered by kind — "Sphere 2".', { minLength: 1 }),
}

interface Finishing {
  sigma?: SigmaPreset
  knownDiameter?: number
  assumed?: number
  orient?: { to: ElementRef; relation?: OrientRelation }
  extend?: Partial<Record<ExtendSide, number>>
  name?: string
}

/** A known diameter is a sphere's: refused on anything else before a box
 *  is opened. */
function requireSphereForKnown(input: { kind: string; knownDiameter?: number }) {
  if (input.knownDiameter !== undefined && input.kind !== 'sphere') {
    throw new CommandError('invalid_input', `knownDiameter is for a sphere, not a ${input.kind}.`)
  }
}

/** Close whatever box a command left open — the empty one Create leaves for
 *  the next element, or one a failure stopped half way. */
function closeDraft() {
  if (useStore.getState().draft) commandHost().session.measure.cancelDraft()
}

/** Settle the draft's extras the way the box's fields do, then create it.
 *  Returns the new element's id. */
function finishAndCreate(f: Finishing): number {
  const store = useStore.getState()
  const d = store.draft
  if (!d || d.status !== 'ready' || !d.fit) {
    throw new CommandError('failed', d?.message ?? 'Nothing was measured there.')
  }
  if (f.assumed !== undefined) {
    if (!hasDiameter(d.fit)) throw new CommandError('invalid_input', `A ${d.fit.kind} has no diameter to assume.`)
    store.setDraftAssumed(f.assumed)
  }
  if (f.orient) {
    if (!isOrientable(d.fit)) throw new CommandError('invalid_input', `A ${d.fit.kind} has no direction to align.`)
    store.setDraftOrientRef(planeOrSectionRef(f.orient.to))
    if (!useStore.getState().draft?.orient) throw new CommandError('invalid_input', 'That plane cannot be aligned to.')
    if (f.orient.relation) store.setDraftOrientRelation(f.orient.relation)
  }
  if (f.extend && Object.keys(f.extend).length) {
    if (!isExtendable(d.fit)) throw new CommandError('invalid_input', `A ${d.fit.kind} cannot be extended — only a cylinder or a plane.`)
    const sides = d.fit.kind === 'cylinder' ? ['start', 'end'] : ['uMin', 'uMax', 'vMin', 'vMax']
    for (const [side, mm] of Object.entries(f.extend)) {
      if (mm === undefined) continue
      if (!sides.includes(side)) throw new CommandError('invalid_input', `A ${d.fit.kind} has no side "${side}" — it has ${sides.join(', ')}.`)
      store.setDraftExtend(side as ExtendSide, mm)
    }
  }
  const id = commandHost().session.measure.confirmDraft()
  if (id === null) throw new CommandError('failed', 'The element could not be created.')
  if (f.name) rename(id, f.name)
  return id
}

/** Rename through the box, as the panel does: open the element, change the
 *  name, save. */
function rename(id: number, name: string) {
  const store = useStore.getState()
  store.editElement(id)
  useStore.getState().setDraftName(name)
  if (commandHost().session.measure.confirmDraft() === null) {
    closeDraft()
    throw new CommandError('failed', 'The element could not be renamed.')
  }
}

const spotJson = (spot: ScanSpot) => ({ vertex: spot.vertex, point: spot.point, distance: spot.distance })

const created = (id: number) => describeElement(useStore.getState().elements.find((e) => e.id === id)!)

// ---- element.fit ----------------------------------------------------------------

/** What a guide may say, by kind: side, radius and axis are a round
 *  surface's; within any surface's. */
const ROUND_KINDS: readonly FitKind[] = ['sphere', 'cylinder', 'cone']

/** The guide the input gives, checked against the kind; undefined when none. */
function guideOf(input: { kind: FitKind } & FitGuide): FitGuide | undefined {
  const { kind, side, radius, axis, within } = input
  if (side === undefined && radius === undefined && axis === undefined && within === undefined) return undefined
  if (kind === 'point' || kind === 'circle') throw new CommandError('invalid_input', `A ${kind} is picked, not grown — side, radius, axis and within do not apply.`)
  if ((side !== undefined || radius !== undefined) && !ROUND_KINDS.includes(kind)) throw new CommandError('invalid_input', `side and radius are for a sphere, cylinder or cone, not a ${kind}.`)
  if (axis !== undefined && kind !== 'cylinder' && kind !== 'cone') throw new CommandError('invalid_input', `axis is for a cylinder or cone, not a ${kind}.`)
  if (axis !== undefined && !(Math.hypot(...axis) > 0)) throw new CommandError('invalid_input', 'axis: give a direction, not a zero vector.')
  if (radius && radius.min !== undefined && radius.max !== undefined && radius.min > radius.max) throw new CommandError('invalid_input', 'radius: min lies past max.')
  if (within) for (let k = 0; k < 3; k++) if (!(within.min[k] <= within.max[k])) throw new CommandError('invalid_input', 'within: the box’s min lies past its max.')
  return { ...(side ? { side } : {}), ...(radius ? { radius } : {}), ...(axis ? { axis } : {}), ...(within ? { within } : {}) }
}

/** What the region a surface grew to holds, and — a plane's or a
 *  cylinder's — whether it looks like two surfaces, as the answer puts it;
 *  a plane's whether it looks like no face at all, and a bore's whether its
 *  axis runs into the scan at an end. */
async function regionAnswer(kind: FitKind, region: Uint32Array, elementId: number, seed: number) {
  const client = commandHost().session.clientRef.current
  if (!client) return {}
  const el = useStore.getState().elements.find((e) => e.id === elementId)
  const fit = el?.measured ?? el?.fit
  const normal = kind === 'plane' && fit?.kind === 'plane' ? fit.normal : undefined
  const cylinder = kind === 'cylinder' && fit?.kind === 'cylinder' ? { center: fit.center, axis: fit.axis, radius: fit.radius, seed } : undefined
  const r = await client.planeRegion(region, normal ? { normal, seed } : undefined, cylinder)
  const v = (p: readonly number[], places: number) => p.map((x) => roundTo(x, places))
  const out: { region: Record<string, unknown>; closed?: Record<string, unknown>; warning?: string } = {
    region: {
      area: roundTo(r.area, 1),
      box: { min: v(r.min, 2), max: v(r.max, 2) },
      ...(r.normalSpreadDeg !== undefined ? { normalSpreadDeg: roundTo(r.normalSpreadDeg, 2) } : {}),
      ...(r.fill !== undefined ? { fill: roundTo(r.fill, 3) } : {}),
      ...(r.curve ? { sagitta: roundTo(r.curve.sagitta, 3) } : {}),
    },
  }
  const warnings: string[] = []
  const second = r.second
  if (second && fit?.kind === 'plane') {
    out.region.second = {
      share: roundTo(second.share, 3),
      centroid: v(second.centroid, 3),
      box: { min: v(second.min, 2), max: v(second.max, 2) },
      angleDeg: roundTo(second.angleDeg, 2),
      offset: roundTo(second.offset, 3),
      rmsTwo: roundTo(second.rmsTwo, 4),
    }
    const side = second.offset >= 0 ? 'above' : 'below'
    warnings.push(
      `two surfaces? ${Math.round(second.share * 100)} % of the region lies on a second plane ${roundTo(second.angleDeg, 2)}° off this one and ${roundTo(Math.abs(second.offset), 3)} mm ${side} it at its centroid [${v(second.centroid, 2).join(', ')}], ` +
        `box [${v(second.min, 1).join(', ')}]–[${v(second.max, 1).join(', ')}] (σ ${roundTo(fit.sigma, 4)} mm${fit.formError !== undefined ? `, form error ${roundTo(fit.formError, 3)}` : ''}; two planes leave ${roundTo(second.rmsTwo, 4)}) — shrink the box or move the seed.`,
    )
  }
  // On curvature, not the spread alone: relief on a face (lettering, a
  // label) spreads the normals as wide, and is no crown (looksLikeCrown).
  if (fit?.kind === 'plane' && looksLikeCrown(r)) {
    const curved = r.curve ? ` and curves ${roundTo(r.curve.sagitta, 3)} mm across it (σ ${roundTo(r.curve.sigma, 3)} left by a quadric)` : ''
    warnings.push(
      `the crown of a bead or round, not a face? 95 % of its normals lie within ${roundTo(r.normalSpreadDeg ?? 0, 1)}° of the plane's and it fills ${Math.round((r.fill ?? 1) * 100)} % of the rectangle it spans (${roundTo(r.area, 0)} mm²)${curved} — seed in the middle of the face, or give within.`,
    )
  }
  const taper = fit?.kind === 'cylinder' ? r.taper : undefined
  if (taper) {
    out.region.taper = {
      double: taper.double,
      axis: v(taper.axis, 3),
      parts: taper.parts.map((c) => ({ band: v(c.band, 2), draftDeg: roundTo(c.draftDeg, 2), box: { min: v(c.min, 2), max: v(c.max, 2) } })),
      ...(taper.parting ? { parting: { at: v(taper.parting.at, 3), radius: roundTo(taper.parting.radius, 2), t: roundTo(taper.parting.t, 2) } } : {}),
    }
    const box = (c: { min: readonly number[]; max: readonly number[] }) => `[${v(c.min, 1).join(', ')}]–[${v(c.max, 1).join(', ')}]`
    const degs = taper.parts.map((c) => `${roundTo(Math.abs(c.draftDeg), 1)}°`).join(' and ')
    const off = `along [${v(taper.axis, 3).join(', ')}]`
    if (taper.parting) {
      const line = `at [${v(taper.parting.at, 2).join(', ')}], radius about ${roundTo(taper.parting.radius, 2)}`
      warnings.push(
        `${taper.double ? `a double cone, not a cylinder: the wall tapers ${degs} ${off}, away from its ${taper.parts[0].draftDeg > 0 ? 'widest' : 'narrowest'} line ${line} — where a casting drafted both ways parts` : `two tapers, not one cylinder: ${degs} ${off}, breaking ${line}`} — ` +
          `fit each with kind "cone" and within, the boxes ${taper.parts.map(box).join(' and ')}.`,
      )
    } else {
      warnings.push(`a cone, not a cylinder: the wall tapers ${degs} ${off}; a cylinder fitted on part of a turn leans to take that up — fit it with kind "cone", or read how far this axis lies off that one.`)
    }
  }
  const two = r.secondCylinder
  if (two && fit?.kind === 'cylinder') {
    out.region.second = {
      share: roundTo(two.share, 3),
      centroid: v(two.centroid, 3),
      box: { min: v(two.min, 2), max: v(two.max, 2) },
      band: v(two.band, 2),
      angleDeg: roundTo(two.angleDeg, 2),
      radius: roundTo(two.radiusSecond, 3),
      leanDeg: v(two.leanDeg, 2),
      rmsTwo: roundTo(two.rmsTwo, 4),
    }
    if (!taper) {
      warnings.push(
        `two surfaces? ${Math.round(two.share * 100)} % of the region lies on a second cylinder, its axis ${roundTo(two.angleDeg, 2)}° off and its radius ${roundTo(two.radiusSecond, 3)} against ${roundTo(two.radius, 3)}, ` +
          `in the band ${roundTo(two.band[0], 2)} to ${roundTo(two.band[1], 2)} mm along this axis from the centre, box [${v(two.min, 1).join(', ')}]–[${v(two.max, 1).join(', ')}]; ` +
          `the normals lean ${roundTo(two.leanDeg[0], 1)}° and ${roundTo(two.leanDeg[1], 1)}° off square to this axis (σ ${roundTo(fit.sigma, 4)} mm${fit.formError !== undefined ? `, form error ${roundTo(fit.formError, 3)}` : ''}; two cylinders leave ${roundTo(two.rmsTwo, 4)}) — ` +
          'fit each part with within (a box round its band) or axis, or move the seed.',
      )
    }
  }
  const closed = r.closed
  if (closed && fit?.kind === 'cylinder') {
    out.closed = { from: roundTo(closed.from, 2), ...(closed.to !== undefined ? { to: roundTo(closed.to, 2) } : {}), at: v(closed.at, 2) }
    const past = Math.max(0, Math.abs(closed.from) - fit.length / 2)
    const through = closed.to !== undefined ? ` and leaves it ${roundTo(Math.abs(closed.to - closed.from), 2)} mm further on` : ''
    warnings.push(
      `closed: the axis meets the scan ${roundTo(past, 2)} mm past this end of the bore, at [${v(closed.at, 2).join(', ')}]${through} — a floor, or the skin of a wrap bridging a hole the scan did not see through; read it from both ends (scan.heightmap along the axis each way) before modelling it blind.`,
    )
  }
  if (warnings.length) out.warning = warnings.join(' ')
  return out
}

/** A seed left out that lies off the surface past this many sigma (and a
 *  hundredth of a millimetre), or turned past this many degrees, is on
 *  another surface; one within both, at the region's rim or past a gap. */
const SEED_OFF_SIGMA = 3.5
const SEED_OFF_DEG = 25

/** Several seeds, each as the answer gives it: whether the surface grew
 *  from it (inRegion — a corner of its triangle in the region), how far it
 *  lies off the fitted surface and how far its normal turns from the
 *  surface's there; and, a seed left out, a warning saying where it lies.
 *  One seed answers as it always has. */
function seedsAnswer(spots: ScanSpot[], kind: FitKind, region: Uint32Array, elementId: number): { seeds: Record<string, unknown>[]; warning?: string } {
  if (spots.length < 2) return { seeds: spots.map(spotJson) }
  const el = useStore.getState().elements.find((e) => e.id === elementId)
  const fit = el?.measured ?? el?.fit
  const members = new Set(region)
  const read = spots.map((s) => ({ spot: s, inRegion: s.triangle.some((v) => members.has(v)), off: fit ? seedOff(fit, s.point, s.normal) : null }))
  const seeds = read.map(({ spot, inRegion, off }) => ({ ...spotJson(spot), inRegion, ...(off ? { offMm: roundTo(off.offMm, 3), deg: roundTo(off.deg, 1) } : {}) }))
  const out = read.map((r, i) => ({ ...r, n: i + 1 })).filter((r) => !r.inRegion)
  if (!out.length || !fit) return { seeds }
  const sigma = 'sigma' in fit ? fit.sigma : 0
  const elsewhere = (r: (typeof out)[number]) => r.off !== null && (Math.abs(r.off.offMm) > SEED_OFF_SIGMA * sigma + 0.01 || r.off.deg > SEED_OFF_DEG)
  const where = (r: (typeof out)[number]) => (r.off ? `${roundTo(Math.abs(r.off.offMm), 2)} mm off it, turned ${roundTo(r.off.deg, 1)}°` : 'where it has no normal')
  const from = read.flatMap((r, i) => (r.inRegion ? [i + 1] : []))
  const grew = from.length ? `the ${kind} grew from seed${from.length > 1 ? 's' : ''} ${from.join(', ')}` : `the ${kind} grew from none of the seeds`
  const far = out.filter(elsewhere)
  const near = out.filter((r) => !elsewhere(r))
  const parts: string[] = []
  if (far.length) {
    parts.push(
      `seeds lie on two surfaces? ${grew}; ${far.map((r) => `seed ${r.n} lies ${where(r)}`).join('; ')} — fit each on its own, or mark both (scan.segment { mark: [ids] }) and fit the marked (element.fit_marked { marked: true }).`,
    )
  }
  if (near.length) {
    parts.push(`${near.map((r) => `seed ${r.n} lies on it (${where(r)})`).join('; ')} but outside the region it grew to — at its rim, or on a part the growing did not reach: fit it alone to see.`)
  }
  return { seeds, warning: parts.join(' ') }
}

/** The seed the region's own reading starts from: the first the surface
 *  grew from, else the first. */
const seedInRegion = (spots: ScanSpot[], seeded: { seeds: Record<string, unknown>[] }) => spots[Math.max(0, seeded.seeds.findIndex((s) => s.inRegion !== false))].vertex

/** What a fit told besides its numbers, as the answer gives it: its note,
 *  and the other surface its first region took in. */
function toldAnswer(told: FitTold | undefined) {
  if (!told) return {}
  const s = told.second
  return {
    note: told.note,
    ...(s ? { second: { radius: roundTo(s.radius, 3), band: s.band.map((x) => roundTo(x, 2)), share: roundTo(s.share, 3) } } : {}),
  }
}

const fit: Command<{ kind: FitKind; at?: Location | Location[]; rim?: number; mark?: boolean } & FitGuide & Finishing> = {
  name: 'fit',
  title: 'Fit an element',
  description:
    'Fit an element on the scan where the panel would take a click: a plane, sphere, cylinder, cone or torus grows its surface from the place (or places) in at and is best-fitted to it; a point is the place itself; a circle goes through three or more places, or round an open rim (rim, numbered by scan.qa). A place is { vertex } or { point: [x, y, z] } (mm, current frame; the nearest vertex is taken). Trap: a seed near an edge can land on the wrong surface — say what is sought with side, radius, axis or within, and surfaces that do not match are passed over. Returns the element with its fit, the seeds used (inRegion, offMm, deg), the region grown (area, box, normalSpreadDeg, fill, sagitta) and a warning when the points look like two surfaces, a bore steps or is closed at an end, or a plane is a bead’s crown — the measure-reference guide (Elements) says how to read each. One undo step.',
  input: obj(
    {
      kind: enumOf(FIT_KINDS, 'What to fit.'),
      at: oneOf([locationSchema('One place.'), arr(locationSchema('A place.'), 'Several places.', { minItems: 1 })], 'Where on the scan.'),
      side: enumOf(['inside', 'outside'], 'Sphere, cylinder, cone: inside (concave, a bore) or outside (convex, a shaft).'),
      radius: obj({ min: num('mm.', { exclusiveMinimum: 0 }), max: num('mm.', { exclusiveMinimum: 0 }) }, [], 'Sphere, cylinder, cone: the radius range sought.'),
      axis: vec3('Cylinder, cone: the axis direction, roughly (within 20°).'),
      within: obj({ min: vec3('Lowest corner, mm.'), max: vec3('Highest corner, mm.') }, ['min', 'max'], 'The surface stays inside this box.'),
      mark: bool('Leave the grown region marked for element.fit_marked.'),
      rim: int('Circle: an open rim of the scan by its scan.qa number, in place of at.', { minimum: 0 }),
      ...finishing,
    },
    ['kind'],
  ),
  label: ({ kind }) => `fit ${kind}`,
  run: async (input) => {
    requireScan()
    requireMeasureFree()
    const guide = guideOf(input)
    requireSphereForKnown(input)
    if (input.rim !== undefined) return fitRim(input as Finishing & { kind: FitKind; at?: unknown; rim: number })
    if (input.at === undefined) throw new CommandError('invalid_input', 'Give at — the place on the scan; or, for a circle, rim.')
    const places = Array.isArray(input.at) ? input.at : [input.at]
    if (input.kind === 'point' && places.length !== 1) throw new CommandError('invalid_input', 'A point is one place.')
    if (input.kind === 'circle' && places.length < 3) throw new CommandError('invalid_input', 'A circle needs three places or more.')
    if (input.mark && (input.kind === 'point' || input.kind === 'circle')) throw new CommandError('invalid_input', `A ${input.kind} is picked, not grown — it has no region to mark.`)
    const spots: ScanSpot[] = []
    for (const at of places) spots.push(await resolveLocation(at))
    const m = commandHost().session.measure
    showWorkspace('elements')
    let told: FitTold | undefined
    try {
      m.startDraft(input.kind)
      if (input.sigma !== undefined) useStore.getState().setDraftSigma(input.sigma)
      if (input.knownDiameter !== undefined) useStore.getState().setDraftKnownDiameter(input.knownDiameter)
      const picks = spots.map((s) => s.triangle)
      const points = spots.map((s) => s.point)
      if (input.kind === 'point') {
        // A picked point is the place itself — no worker round-trip.
        useStore.getState().setDraftPicks(picks, points)
        const p: PointFit = { kind: 'point', center: points[0], sigma: 0, usedPoints: 0, regionSize: 0 }
        useStore.getState().resolveDraft({ ...p, region: new Uint32Array(0) })
      } else if (input.kind === 'circle') {
        useStore.getState().setDraftPicks(picks, points)
        m.runPickFit(points)
      } else {
        useStore.getState().setDraftPicks(picks, points)
        told = await m.runDraftFit(input.kind, picks, guide)
      }
      // The region goes to the element as it is created; it is read first.
      const region = input.kind === 'point' || input.kind === 'circle' ? null : m.draftRegion.current
      const id = finishAndCreate(input)
      if (!region) return { element: created(id), seeds: spots.map(spotJson) }
      const seeded = seedsAnswer(spots, input.kind, region, id)
      const grown = await regionAnswer(input.kind, region, id, seedInRegion(spots, seeded))
      const warning = [seeded.warning, 'warning' in grown ? grown.warning : undefined].filter(Boolean).join(' ')
      const marked = input.mark ? setMarked(region, `element.fit ${useStore.getState().elements.find((e) => e.id === id)?.name ?? id}`) : undefined
      return { element: created(id), seeds: seeded.seeds, ...grown, ...(warning ? { warning } : {}), ...toldAnswer(told), ...(marked ? { marked } : {}) }
    } finally {
      closeDraft()
    }
  },
}

/** How many of a rim's vertices a circle keeps as its picks, spread evenly
 *  round the loop: enough for the fit, few enough for the recipe. */
const RIM_PICKS = 120

/** A circle through an open rim of the scan, the rim scan.qa numbers. */
async function fitRim(input: Finishing & { kind: FitKind; at?: unknown; rim: number }) {
  if (input.kind !== 'circle') throw new CommandError('invalid_input', `rim makes a circle, not a ${input.kind} — give kind: "circle".`)
  if (input.at !== undefined) throw new CommandError('invalid_input', 'Give at, or rim — one of them.')
  const client = commandHost().session.clientRef.current
  if (!client) throw new CommandError('unavailable', 'The mesh worker is not running.')
  const rim = await client.scanRim(input.rim)
  if (!rim) throw new CommandError('not_found', `The scan has no rim ${input.rim} — scan.qa numbers its rims, longest first.`)
  if (!rim.closed) throw new CommandError('failed', `Rim ${input.rim} does not close on itself — its open edges run out at a vertex; pick three places on it instead.`)
  const n = rim.vertices.length
  const step = Math.max(1, Math.ceil(n / RIM_PICKS))
  const picks: [number, number, number][] = []
  const points: [number, number, number][] = []
  // Each vertex kept, with the triangle along the edge that leaves it.
  for (let i = 0; i < n; i += step) {
    points.push([rim.positions[i * 3], rim.positions[i * 3 + 1], rim.positions[i * 3 + 2]])
    picks.push([rim.corners[i * 3], rim.corners[i * 3 + 1], rim.corners[i * 3 + 2]])
  }
  if (points.length < 3) throw new CommandError('failed', `Rim ${input.rim} has ${n} vertices — a circle needs three.`)
  const m = commandHost().session.measure
  showWorkspace('elements')
  try {
    m.startDraft('circle')
    useStore.getState().setDraftPicks(picks, points)
    m.runPickFit(points)
    const id = finishAndCreate(input)
    const el = useStore.getState().elements.find((e) => e.id === id)
    return { element: created(id), rim: { index: input.rim, points: points.length, rms: el?.fit && 'sigma' in el.fit ? roundTo(el.fit.sigma, 4) : null } }
  } finally {
    closeDraft()
  }
}

// ---- element.fit_marked -------------------------------------------------------

const fitMarked: Command<{ kind: (typeof SURFACE_KINDS)[number]; vertices?: number[]; marked?: boolean; box?: { min: Vec3; max: Vec3 }; normal?: { dir: Vec3; withinDeg?: number } } & Finishing> = {
  name: 'fit_marked',
  title: 'Fit an element to a marked surface',
  description:
    'Fit a plane, sphere, cylinder, cone or torus to exactly the scan vertices given, with no search for the surface — vertices, or marked: true for the points the last element.fit { mark: true }, scan.segment { mark } or scan.query { mark: true } left marked, or box (with normal: only those facing a way) for every vertex inside it. The element keeps the marking as its recipe. Returns the element, and with box how many points it took. One undo step.',
  input: obj(
    {
      kind: enumOf(SURFACE_KINDS, 'What to fit.'),
      vertices: arr(int(undefined, { minimum: 0 }), 'The scan vertices of the surface.', { minItems: 3 }),
      marked: bool('The points left marked, in place of vertices.'),
      box: obj({ min: vec3('Lowest corner, mm.'), max: vec3('Highest corner, mm.') }, ['min', 'max'], 'The scan inside a box, in place of vertices.'),
      normal: obj({ dir: vec3('A direction, any length.'), withinDeg: num('Degrees; 30 by default.', { exclusiveMinimum: 0, maximum: 180 }) }, ['dir'], 'With box: only the vertices facing this way.'),
      ...finishing,
    },
    ['kind'],
  ),
  label: ({ kind }) => `fit ${kind} to a marked surface`,
  run: async (input) => {
    requireScan()
    requireMeasureFree()
    requireSphereForKnown(input)
    if ([input.vertices !== undefined, input.marked === true, input.box !== undefined].filter(Boolean).length !== 1) throw new CommandError('invalid_input', 'Give vertices, marked: true or box — one of them.')
    if (input.normal && !input.box) throw new CommandError('invalid_input', 'normal goes with box.')
    const count = useStore.getState().vertexCount
    const bad = input.vertices?.find((v) => v >= count)
    if (bad !== undefined) throw new CommandError('invalid_input', `The scan has no vertex ${bad} — it has ${count}.`)
    const vertices = input.vertices ? Uint32Array.from(input.vertices) : input.box ? await boxVertices(input.box, input.normal) : Uint32Array.from(requireMarked().vertices)
    if (input.box && vertices.length < 3) throw new CommandError('invalid_input', `Only ${vertices.length} scan points lie in the box${input.normal ? ' facing that way' : ''} — a surface needs more.`)
    const m = commandHost().session.measure
    showWorkspace('elements')
    try {
      m.startDraft(input.kind)
      if (input.sigma !== undefined) useStore.getState().setDraftSigma(input.sigma)
      if (input.knownDiameter !== undefined) useStore.getState().setDraftKnownDiameter(input.knownDiameter)
      await m.runDraftPaintFit(input.kind, vertices)
      const id = finishAndCreate(input)
      return { element: created(id), ...(input.box ? { points: vertices.length } : {}) }
    } finally {
      closeDraft()
    }
  },
}

/** Every scan vertex in a box, facing a way within an angle if asked. */
async function boxVertices(box: { min: Vec3; max: Vec3 }, normal?: { dir: Vec3; withinDeg?: number }): Promise<Uint32Array> {
  for (let k = 0; k < 3; k++) if (!(box.min[k] <= box.max[k])) throw new CommandError('invalid_input', 'The box’s min lies past its max.')
  if (normal && !(Math.hypot(...normal.dir) > 0)) throw new CommandError('invalid_input', 'normal.dir: give a direction, not a zero vector.')
  const client = commandHost().session.clientRef.current
  if (!client) throw new CommandError('unavailable', 'The mesh worker is not running.')
  const cosLimit = Math.cos(((normal?.withinDeg ?? 30) * Math.PI) / 180)
  const found = await client.query({ min: box.min, max: box.max, ...(normal ? { normal: { dir: normal.dir, cosLimit } } : {}), limit: Math.max(1, useStore.getState().vertexCount) })
  return found.vertices
}

// ---- element.construct ----------------------------------------------------------

/** A construction's source given as a coordinate plane by name — "XY",
 *  "XZ" — when no element or section goes by that name. */
function coordinatePlaneRef(ref: ElementRef): WorldAxis | null {
  if (typeof ref !== 'string') return null
  const want = ref.trim().toLowerCase()
  const { elements, sections } = useStore.getState()
  if ([...elements, ...sections].some((e) => e.name.trim().toLowerCase() === want)) return null
  return parsePlaneName(ref)
}

/** A plane a construction is seeded or aligned by: a coordinate plane by
 *  name, a plane element, or a section as the plane it was cut on. */
function planeOrSectionRef(ref: ElementRef): number {
  if (typeof ref === 'string' && parsePlaneName(ref) !== null) return planeRef(ref)
  const r = measureRef(ref)
  if (r.kind !== 'plane') throw new CommandError('invalid_input', `${r.name} is a ${r.kind}; this takes a plane.`)
  return r.id
}

/** The coordinate plane as an element a construction can be built on — a
 *  plane from coordinates through the origin, as a person makes one first:
 *  one already made so is taken again, else it is made, named "XY plane"
 *  while that name is free, and listed in `made`. */
function coordinatePlane(axis: WorldAxis, made: { id: number; name: string }[]): number {
  const params = [...worldAxisDir(axis), 0, 0, 0]
  const same = useStore.getState().elements.find(
    (e) => e.source.type === 'constructed' && e.source.method === 'plane-coords' && e.source.params.length === 6 && e.source.params.every((v, i) => Math.abs(v - params[i]) < 1e-9),
  )
  if (same) return same.id
  const name = worldPlaneName(axis)
  const taken = useStore.getState().elements.some((e) => e.name.trim().toLowerCase() === name.toLowerCase())
  const m = commandHost().session.measure
  try {
    m.startDraft('plane')
    useStore.getState().setDraftMethod('plane-coords')
    params.forEach((v, i) => useStore.getState().setDraftParam(i, v))
    const id = finishAndCreate(taken ? {} : { name })
    made.push({ id, name: useStore.getState().elements.find((e) => e.id === id)?.name ?? name })
    return id
  } finally {
    closeDraft()
  }
}

const construct: Command<{
  kind: ElementKind
  method: string
  refs?: ElementRef[]
  params?: number[] | Record<string, number>
  seed?: ElementRef
  vertices?: number[]
} & Omit<Finishing, 'sigma' | 'knownDiameter' | 'extend'>> = {
  name: 'construct',
  title: 'Construct an element',
  description:
    'Construct an element from others and typed-in numbers, as the panel’s creation methods do — point: point-coords, point-centroid, point-midpoint, point-line-plane, point-center (of a sphere, circle or torus), point-three-planes, point-line-line (params gap: the most two measured lines may pass apart and be taken to cross, 0.1 mm by default; skew past it is refused), point-project (a point onto a plane); line: line-two-points, line-axis (of a cylinder, cone, torus or circle), line-plane-plane, line-plane-point (square to a plane through a point), line-project (a line or axis onto a plane), line-coords (dx, dy, dz, px, py, pz, length); plane: plane-three-points, plane-offset, plane-offset-point (parallel through a point), plane-midplane, plane-line-point (normal to a line through a point), plane-angle (refs axis, zero-angle plane; params angle in degrees, right-handed about the axis), plane-line-plane (through a line, square to a plane), plane-two-lines (params gap as for point-line-line), plane-tangent-sphere, plane-tangent-cylinder (refs the feature, a point on the side to touch), plane-coords, plane-symmetry; circle: circle-plane-cylinder, circle-plane-sphere, circle-coords. Constructions stay linked to their sources, rebuilt when one changes; element.unlink freezes one where it stands. refs fill the slots in order, by id or name (a section stands in a plane’s slot as its cut plane; "XY", "YZ", "XZ" become plane elements, listed under made); params are the numbers in order or by key. point-centroid and plane-symmetry measure the scan (vertices confines them, seed starts the symmetry search), plane-symmetry answering symmetry { rms, matched, sampled }. Returns the element. One undo step.',
  input: obj(
    {
      kind: enumOf(ALL_KINDS, 'What to construct.'),
      method: str('The creation method — see the description.', { minLength: 1 }),
      refs: arr(elementRefSchema('A source element; in a plane’s slot also a section or "XY", "YZ", "XZ".'), 'The method’s source elements, slot by slot.'),
      params: oneOf(
        [
          arr(num(), 'The numbers in the method’s order.'),
          anyObject('The numbers by key (x, y, z; offset; angle; gap; nx, ny, nz, px, py, pz; dx, dy, dz, length; d, cx, cy, cz).', { additionalProperties: true }),
        ],
        'The method’s typed-in numbers, mm.',
      ),
      seed: elementRefSchema('plane-symmetry: the plane the search starts from.'),
      vertices: arr(int(undefined, { minimum: 0 }), 'point-centroid, plane-symmetry: only these scan vertices.', { minItems: 3 }),
      assumed: finishing.assumed,
      orient: orientSchema,
      name: finishing.name,
    },
    ['kind', 'method'],
  ),
  label: ({ method }) => `construct ${method}`,
  run: async (input) => {
    requireScan()
    requireMeasureFree()
    const method = methodsForKind(input.kind).find((m) => m.id === input.method)
    if (!method) {
      const offered = methodsForKind(input.kind).filter((m) => m.mode === 'construct').map((m) => m.id)
      throw new CommandError('invalid_input', `A ${input.kind} has no method "${input.method}" — it has ${offered.join(', ') || 'none to construct'}.`)
    }
    if (method.mode !== 'construct') throw new CommandError('invalid_input', `"${input.method}" works on the scan — use element.fit.`)
    const refs = input.refs ?? []
    if (refs.length !== method.slots.length) {
      throw new CommandError('invalid_input', `${method.label} takes ${method.slots.length} source element${method.slots.length === 1 ? '' : 's'} (${method.slots.map((s) => s.label).join(', ') || 'none'}), not ${refs.length}.`)
    }
    // A coordinate plane by name stands in a plane's slot: made a plane
    // element (coordinatePlane) once the whole input has passed.
    const sources = refs.map((ref, i): number | WorldAxis => {
      const slot = method.slots[i]
      const axis = coordinatePlaneRef(ref)
      const name = axis ? worldPlaneName(axis) : null
      const el = axis ? null : measureRef(ref)
      const kind: ElementKind = el?.kind ?? 'plane'
      // As the panel's slot lists offer it: a circle is an axis too, a torus
      // a point (its ring's centre) too.
      const plays = providesRole(kind, slot.role)
      if (!plays || (slot.kinds && !slot.kinds.includes(kind))) {
        throw new CommandError('invalid_input', `${el?.name ?? name} cannot be “${slot.label}” — that takes a ${slot.kinds?.join(' or ') ?? slot.role}.`)
      }
      return el ? el.id : axis!
    })
    const typed = method.params.filter((p) => !p.hidden)
    const given = input.params ?? []
    const values = Array.isArray(given)
      ? given
      : typed.map((p) => {
          const v = (given as Record<string, unknown>)[p.key]
          // A number the method starts with (Max gap) may be left out.
          if (v === undefined && p.initial !== undefined) return p.initial
          if (typeof v !== 'number' || !Number.isFinite(v)) throw new CommandError('invalid_input', `params.${p.key} (${p.label}) is required.`)
          return v
        })
    if (values.length !== typed.length) {
      throw new CommandError('invalid_input', `${method.label} takes ${typed.length} number${typed.length === 1 ? '' : 's'} (${typed.map((p) => p.key).join(', ') || 'none'}), not ${values.length}.`)
    }
    const m = commandHost().session.measure
    showWorkspace('elements')
    const made: { id: number; name: string }[] = []
    const ids = sources.map((s) => (typeof s === 'number' ? s : coordinatePlane(s, made)))
    let symmetry: { rms: number; matched: number; sampled: number; note?: string } | null = null
    try {
      m.startDraft(input.kind)
      const store = useStore.getState()
      store.setDraftMethod(input.method)
      ids.forEach((id, i) => useStore.getState().setDraftRef(i, id))
      typed.forEach((p, i) => useStore.getState().setDraftParam(method.params.indexOf(p), values[i]))
      const settled = () => {
        const d = useStore.getState().draft
        return d && (d.status === 'ready' || d.status === 'failed') ? d : null
      }
      if (input.method === 'point-centroid') {
        // It measures itself the moment it is opened (measureWorkspace.watch);
        // a marking measures it again, on the marked surface.
        await waitFor(settled, 'the centroid')
        if (input.vertices) {
          useStore.getState().setDraftSelection(Uint32Array.from(input.vertices))
          await waitFor(settled, 'the centroid of the marked surface')
        }
      } else if (input.method === 'plane-symmetry') {
        if (input.seed !== undefined) useStore.getState().setDraftSeed(planeOrSectionRef(input.seed))
        if (input.vertices) useStore.getState().setDraftSelection(Uint32Array.from(input.vertices))
        await m.findSymmetry()
        // The search's verdict lives on the draft, which confirming closes:
        // read it off first. Its params run normal, point, rms, matched, sampled.
        const d = useStore.getState().draft
        if (d?.method === 'plane-symmetry' && d.params.length >= 9) {
          symmetry = { rms: d.params[6], matched: d.params[7], sampled: d.params[8], ...(d.note ? { note: d.note } : {}) }
        }
      } else if (input.vertices || input.seed !== undefined) {
        throw new CommandError('invalid_input', `${method.label} takes no marked surface and no seed.`)
      }
      const id = finishAndCreate(input)
      return { element: created(id), ...(made.length > 0 ? { made } : {}), ...(symmetry ? { symmetry } : {}) }
    } finally {
      closeDraft()
    }
  },
}

// ---- Renaming, removing, showing -----------------------------------------------

const renameCommand: Command<{ element: ElementRef; name: string }> = {
  name: 'rename',
  title: 'Rename an element',
  description: 'Give an element another name; dimensions and constructions on it keep pointing at it. One undo step.',
  input: obj({ element: elementRefSchema('The element.'), name: str('Its new name.', { minLength: 1 }) }, ['element', 'name']),
  label: () => 'rename element',
  run: async ({ element, name }) => {
    requireMeasureFree()
    const el = measuredElement(element)
    try {
      rename(el.id, name)
    } finally {
      closeDraft()
    }
    return { element: created(el.id) }
  },
}

const unlink: Command<{ element: ElementRef }> = {
  name: 'unlink',
  title: 'Unlink a construction from its sources',
  description:
    'Freeze a constructed element where it stands: its sources give way to coordinates of its own (point-coords, line-coords, plane-coords or circle-coords), so it no longer moves when they do and stays if they are deleted. Refused for an element that is not linked to others. Returns the element. One undo step.',
  input: obj({ element: elementRefSchema('The constructed element.') }, ['element']),
  label: () => 'unlink element',
  run: async ({ element }) => {
    requireMeasureFree()
    const el = findElement(element)
    if (!unlinkedSource(el)) {
      throw new CommandError('invalid_input', `${el.name} is not built from other elements — there is nothing to unlink.`)
    }
    useStore.getState().unlinkElement(el.id)
    return { element: created(el.id) }
  },
}

const remove: Command<{ element: ElementRef }> = {
  name: 'remove',
  title: 'Delete an element',
  description:
    'Delete an element — and with it every construction built on it and every dimension on any of them. Returns what went. One undo step.',
  input: obj({ element: elementRefSchema('The element.') }, ['element']),
  label: () => 'delete element',
  run: async ({ element }) => {
    requireMeasureFree()
    const el = findElement(element)
    const before = useStore.getState()
    const scene = commandHost().session.sceneRef.current
    forgetSurface(el.id)
    scene?.clearElement(el.id)
    useStore.getState().removeElement(el.id)
    const after = useStore.getState()
    const gone = before.elements.filter((e) => !after.elements.some((x) => x.id === e.id))
    for (const e of gone) if (e.id !== el.id) forgetSurface(e.id)
    return {
      removed: gone.map((e) => ({ id: e.id, name: e.name })),
      dimensionsRemoved: before.dimensions.filter((d) => !after.dimensions.some((x) => x.id === d.id)).map((d) => ({ id: d.id, name: d.name })),
    }
  },
}

const setVisible: Command<{ element?: ElementRef; all?: boolean; visible: boolean }> = {
  name: 'set_visible',
  title: 'Show or hide elements',
  description: 'Show or hide one element, or all of them with all: true. A hidden element still measures; only its drawing and surface tint go. One undo step.',
  input: obj(
    {
      element: elementRefSchema('The element.'),
      all: bool('Every element.'),
      visible: bool('Shown (true) or hidden (false).'),
    },
    ['visible'],
  ),
  label: ({ visible }) => (visible ? 'show elements' : 'hide elements'),
  run: async ({ element, all, visible }) => {
    if (all) {
      useStore.getState().setAllElementsVisible(visible)
      return { elements: useStore.getState().elements.map((e) => ({ id: e.id, name: e.name, visible: e.visible })) }
    }
    if (element === undefined) throw new CommandError('invalid_input', 'Name an element, or pass all: true.')
    const el = findElement(element)
    if (el.visible !== visible) useStore.getState().toggleElementVisible(el.id)
    return { element: { id: el.id, name: el.name, visible } }
  },
}

export const elementCommands = [fit, fitMarked, construct, renameCommand, unlink, remove, setVisible]

// SPDX-License-Identifier: AGPL-3.0-only
// The session's plan for the part: its archetype, the regions an agent
// inventoried before building — each with its function, the route meant for
// it and a place on it — and the share of the scan within T the model is to
// reach, by the archetype's class unless the person set another. Ticked
// region by region as they are built (reverse.plan.*), read back in the
// session's readout, and held against at the end: the final comparison
// answers whether the target is met, which regions are still open, and what
// was removed after failing — a run that stops short says so in the chat,
// and the person signs off on less. Nothing refuses for want of a plan: the
// first feature added without one answers a warning, once a session.
//
// A store of its own, as the notes are, saved with the project under
// `reversePlan` and let go with the part: another scan is another part.

import { create } from 'zustand'
import { invalid } from '../../../src/commands/core/common'
import { guideSectionRead } from '../../../src/commands/guides'
import { arr, bool, enumOf, num, obj, oneOf, str, vec3 } from '../../../src/commands/schema'
import type { ProjectSection } from '../../../src/app/projectSections'
import { array, fields, object, invalid as malformed, vector } from '../../../src/core/project/validation'
import type { Vec3 } from '../../../src/core/types'
import { type Command, CommandError } from '../../../src/plugins/api'
import { useStore } from '../../../src/state/store'
import type { Feature } from '../core/features'
import type { ReviewMark } from '../core/reviewPlaces'
import { useReverse } from '../state/reStore'
import { allFeatures, featureNamed, type Ref } from './reCommandCore'
import { featureRef } from './reSchemas'
import type { ReverseSession } from './reSession'

/** The archetypes of the scan-to-cad guide's §4a, by their names there —
 *  and `other`, for a part none of them fits. */
export const ARCHETYPES = [
  'plate',
  'turned',
  'machined',
  'sheetMetal',
  'shelledHousing',
  'facetedHousing',
  'rotationallyPatterned',
  'castWithMachinedFeatures',
  'smoothSolidCasting',
  'mouldedHousingWithKeys',
  'volute',
  'freeformThinShell',
  'freeformSurface',
  'other',
] as const
export type Archetype = (typeof ARCHETYPES)[number]

/** The classes the default target goes by, % of the scan within T. */
const CLASSES = {
  analytic: { withinT: 90, says: 'analytic' },
  cast: { withinT: 85, says: 'casting or moulding' },
  freeform: { withinT: 75, says: 'freeform' },
  other: { withinT: 85, says: 'other' },
} as const
const CLASS_OF: Record<Archetype, keyof typeof CLASSES> = {
  plate: 'analytic',
  turned: 'analytic',
  machined: 'analytic',
  sheetMetal: 'analytic',
  shelledHousing: 'analytic',
  facetedHousing: 'analytic',
  rotationallyPatterned: 'analytic',
  castWithMachinedFeatures: 'cast',
  smoothSolidCasting: 'cast',
  mouldedHousingWithKeys: 'cast',
  volute: 'cast',
  freeformThinShell: 'freeform',
  freeformSurface: 'freeform',
  other: 'other',
}

type Box = { min: Vec3; max: Vec3 }

export interface PlanRegion {
  name: string
  function?: string
  route?: string
  /** A point on it, or a box round it, in the frame the features are built
   *  in — what a place on the part is named by (planRegionAt). */
  at?: Vec3 | Box
  /** Ticked off: when, and the feature that built it, where one was named. */
  done?: string
  feature?: { id: number; name: string }
  /** Left out on purpose, and why. */
  skip?: string
  /** Modelled from what the part must be where the scan saw nothing — a bore
   *  a wrap closed. Material missing inside its box is told apart: named with
   *  how much, not ranked as a place, not held against the verdict. */
  inferred?: boolean
}

export interface Plan {
  archetype: Archetype
  regions: PlanRegion[]
  target: {
    /** % of the scan within ±T. */
    withinT: number
    side: 'scan' | 'model'
    /** T, ± mm, where the plan was given one. */
    tolerance?: number
    /** Set by the person (through the agent), or the archetype class's. */
    by: 'given' | 'archetype'
  }
  set: string
}

/** A feature taken out of the list after its build failed; replaced, when
 *  another that is built made it needless (reverse.plan.replace). */
export interface Removed {
  name: string
  kind: string
  message: string
  at: string
  /** A round's radius when it was removed, mm — none in a project saved
   *  before it was kept. */
  radius?: number
  replaced?: {
    by: { id: number; name: string }
    reason: string
    at: string
    /** The arc of by's own sketch taken as the round. */
    arc?: { sketch: string; piece: number; radius: number }
  }
}

interface PlanState {
  plan: Plan | null
  removed: Removed[]
}

export const usePlan = create<PlanState>(() => ({ plan: null, removed: [] }))

const now = () => new Date().toISOString()
const pct = (v: number) => Math.round(v * 10) / 10

// ---- What a place on the part is ---------------------------------------------

/** How far from a region's point or box a place still counts as on it, mm. */
const NEAR_MM = 5

const isBox = (at: Vec3 | Box): at is Box => !Array.isArray(at)

/** How far p lies from a region's place, mm: 0 inside its box. */
function distanceTo(at: Vec3 | Box, p: readonly number[]): number {
  if (!isBox(at)) return Math.hypot(p[0] - at[0], p[1] - at[1], p[2] - at[2])
  let sq = 0
  for (let k = 0; k < 3; k++) {
    const d = Math.max(at.min[k] - p[k], 0, p[k] - at.max[k])
    sq += d * d
  }
  return Math.sqrt(sq)
}

const boxVolume = (at: Vec3 | Box) => (isBox(at) ? (at.max[0] - at.min[0]) * (at.max[1] - at.min[1]) * (at.max[2] - at.min[2]) : 0)

/** The plan's region a place on the part lies in: the one whose box holds
 *  it or whose point or box is nearest, within NEAR_MM — of two boxes that
 *  hold it, the smaller (a tab inside the wall's box is the tab). None
 *  without a plan, or with no region placed there. */
export function planRegionAt(_s: ReverseSession, p: [number, number, number]): string | undefined {
  const plan = usePlan.getState().plan
  let best: { name: string; d: number; v: number } | null = null
  for (const r of plan?.regions ?? []) {
    if (!r.at) continue
    const d = distanceTo(r.at, p)
    if (d > NEAR_MM) continue
    const v = boxVolume(r.at)
    if (!best || d < best.d - 1e-9 || (Math.abs(d - best.d) <= 1e-9 && v < best.v)) best = { name: r.name, d, v }
  }
  return best?.name
}

/** The region marked inferred a place lies in: the one planRegionAt names,
 *  if its box holds the place — near it is not in it. */
function inferredAt(s: ReverseSession, p: readonly number[]): PlanRegion | undefined {
  const name = planRegionAt(s, [p[0], p[1], p[2]])
  const r = name === undefined ? undefined : usePlan.getState().plan?.regions.find((x) => x.name === name)
  return r?.inferred && r.at && distanceTo(r.at, p) === 0 ? r : undefined
}

/** The places left to rank, and what is set aside of them, by region: those
 *  of material missing whose centre lies in a region marked inferred and
 *  whose box stays on it (within NEAR_MM) — a lump reaching out of the box
 *  is more than what was inferred, and stays a place. */
export function setAsideInferred<P extends { kind: string; mm3: number; centroid: readonly number[]; box: Box }>(s: ReverseSession, places: readonly P[]): { ranked: P[]; inferred: { region: string; mm3: number; places: number }[] } {
  const inferred = new Map<string, { region: string; mm3: number; places: number }>()
  const ranked = places.filter((p) => {
    const r = p.kind === 'missing' ? inferredAt(s, p.centroid) : undefined
    const box = r?.at as Box | undefined
    if (!r || !box || [0, 1, 2].some((k) => p.box.min[k] < box.min[k] - NEAR_MM || p.box.max[k] > box.max[k] + NEAR_MM)) return true
    const had = inferred.get(r.name) ?? { region: r.name, mm3: 0, places: 0 }
    inferred.set(r.name, { region: r.name, mm3: had.mm3 + p.mm3, places: had.places + 1 })
    return false
  })
  return { ranked, inferred: [...inferred.values()].map((x) => ({ ...x, mm3: Math.round(x.mm3) })) }
}

// ---- The verdict ---------------------------------------------------------------

const openRegions = (plan: Plan) => plan.regions.filter((r) => !r.done && r.skip === undefined)

/** How much of a removed feature's failure the verdict and the readout
 *  repeat, characters: the first sentence, or this much of it. */
const REMOVED_SAID = 240

/** A failure's first sentence, at most REMOVED_SAID characters: the whole of
 *  each was repeated in every comparison, 13 k of the last fan's 20 k. */
function firstSaid(message: string): string {
  const end = message.search(/[.:] /)
  const first = end >= 0 ? message.slice(0, end + 1) : message
  return first.length > REMOVED_SAID ? `${first.slice(0, REMOVED_SAID)}…` : first
}

const isBuilt = (f: Feature) => useReverse.getState().results[f.id]?.status === 'ok'

/** How near an arc's radius has to come to a removed round's to stand in for
 *  it, mm: a fifth of it, at least 0.2 — the arc is drawn to the scan, the
 *  round was asked at a radius read off it. */
const arcNear = (radius: number) => Math.max(0.2, 0.2 * radius)

/** The arcs of the sketch an extrude or a revolve built, none of any other
 *  feature's; construction ones draw nothing. */
function profileArcs(by: Feature): { sketch: string; piece: number; radius: number }[] {
  if (by.kind !== 'extrude' && by.kind !== 'revolve') return []
  const sketch = allFeatures().find((f) => f.id === by.sketchId)
  if (sketch?.kind !== 'sketch') return []
  return sketch.sketch.entities.flatMap((e) => (e.kind === 'arc' && !e.construction ? [{ sketch: sketch.name, piece: e.id, radius: Math.round(e.r * 1000) / 1000 }] : []))
}

/** The arc of by's sketch taken for a round of this radius: the nearest to
 *  it within arcNear. With no radius kept, the smallest arc — a round is the
 *  small one in a profile. */
function arcFor(by: Feature, radius: number | undefined) {
  const arcs = profileArcs(by)
  if (radius === undefined) return arcs.sort((a, b) => a.radius - b.radius)[0] ?? null
  return arcs.filter((a) => Math.abs(a.radius - radius) <= arcNear(radius)).sort((a, b) => Math.abs(a.radius - radius) - Math.abs(b.radius - radius))[0] ?? null
}

/** Whether a removed feature's replacement still stands, built — with the arc
 *  taken for it still in its sketch, where one was. */
function replacedNow(r: Removed): boolean {
  const by = r.replaced ? allFeatures().find((f) => f.id === r.replaced!.by.id) : undefined
  if (by === undefined || !isBuilt(by)) return false
  const arc = r.replaced!.arc
  return !arc || arcFor(by, r.radius ?? arc.radius) !== null
}

/** The features removed after failing that still have something to say, each
 *  name once with its last failure and how many times: nothing for one built
 *  again under its name. */
function removedOut(removed: readonly Removed[]) {
  const built = new Set(allFeatures().filter(isBuilt).map((f) => f.name))
  const byName = new Map<string, { last: Removed; times: number }>()
  for (const r of removed) {
    if (!built.has(r.name)) byName.set(r.name, { last: r, times: (byName.get(r.name)?.times ?? 0) + 1 })
  }
  return [...byName.values()].map(({ last: r, times }) => ({
    name: r.name,
    kind: r.kind,
    at: r.at,
    ...(times > 1 ? { times } : {}),
    ...(r.replaced && replacedNow(r) ? { replaced: { by: r.replaced.by.name, reason: r.replaced.reason, ...(r.replaced.arc ? { arc: r.replaced.arc } : {}) } } : { message: firstSaid(r.message) }),
  }))
}

/** A feature removed after failing with no feature of its name built since
 *  and no built one standing in its place: the last fan's root rounds were
 *  removed three times and the verdict read "met" without them. Each name
 *  once. */
function unbuilt(removed: readonly Removed[]): Removed[] {
  return removedOut(removed)
    .filter((r) => !('replaced' in r))
    .map((r) => removed.find((x) => x.name === r.name)!)
}

/** A patch of kind "feature" over T on the scan side — material missing,
 *  misplaced or extra, as the review's places and the comparison's patches
 *  read it — with where it lies and the feature nearest it. */
export interface FeaturePatch {
  at: Vec3
  /** mm past the tolerance at its deepest. */
  depth: number
  madeBy?: string | null
  /** The scan stands outside the bodies there: material the model lacks. */
  outside?: boolean
}

/** What the model was read at: the share within T (%), the T it was read
 *  at, and the feature patches over T it left on the scan. */
export interface Got {
  withinT: number
  tolerance?: number
  featurePatches?: readonly FeaturePatch[]
}

const r1 = (v: number) => Math.round(v * 10) / 10

/** The model held against the plan: the target, the share of the scan
 *  within T read now (got, %; tolerance, ± mm, the T it was read at) and
 *  whether it meets it — the share alone never does: every region ticked or
 *  skipped, nothing removed after failing that was not built again, and no
 *  feature patch over T left on a place no skipped region covers, nor of
 *  material missing in a region marked inferred — the regions still open,
 *  those skipped with why and those inferred, the features removed after
 *  failing, and next, what the agent says in the chat when the run is not
 *  done or rests on what was inferred. Undefined with no plan and nothing
 *  removed. */
export function planVerdict(s: ReverseSession, got: Got | null): Record<string, unknown> | undefined {
  const { plan, removed } = usePlan.getState()
  const said = removedOut(removed)
  if (!plan && said.length === 0) return undefined
  const gone = said.length > 0 ? { removed: said } : {}
  const goneSaid = said.length > 0 ? `${said.length} removed after failing (${said.map((r) => r.name).join(', ')})` : ''
  if (!plan) return { target: null, ...gone, next: `no plan set; ${goneSaid} — name them in the chat with what they leave` }
  const open = openRegions(plan).map((r) => r.name)
  const skipped = plan.regions.filter((r) => r.skip !== undefined).map((r) => ({ name: r.name, reason: r.skip! }))
  const skippedNames = new Set(skipped.map((r) => r.name))
  const inferred = plan.regions.filter((r) => r.inferred).map((r) => r.name)
  const t = plan.target
  const at = got ? pct(got.withinT) : null
  // Read at a looser T than the plan's, the share is not the plan's.
  const looser = t.tolerance !== undefined && got?.tolerance !== undefined && got.tolerance > t.tolerance + 1e-9
  const lost = unbuilt(removed)
  // A feature patch on a region skipped with a reason (a warp, lettering) is
  // the skip's, and one of material missing in an inferred region's box the
  // inference's: the wrap's skin over what the scan did not see. Any other
  // stands against the verdict.
  const standing = (got?.featurePatches ?? []).map((p) => ({ ...p, region: planRegionAt(s, p.at) })).filter((p) => !(p.region && skippedNames.has(p.region)))
  const patches = standing.filter((p) => !(p.outside && inferredAt(s, p.at))).sort((a, b) => b.depth - a.depth)
  const patchesInferred = standing.length - patches.length
  const met = at !== null && at >= t.withinT && !looser && open.length === 0 && lost.length === 0 && patches.length === 0
  const short: string[] = []
  if (at === null) short.push(`the ${t.side} side's share within T was not read${t.side === 'model' ? ' (compare_in_deviation with ways "both")' : ''}`)
  else if (at < t.withinT) short.push(`${at} % of ${t.withinT}`)
  if (looser) short.push(`read at ±${got!.tolerance}, the plan's T is ±${t.tolerance} — compare at tolerance ${t.tolerance}`)
  if (open.length > 0) short.push(`${open.length} region${open.length === 1 ? '' : 's'} open (${open.join(', ')})`)
  if (lost.length > 0) short.push(`${lost.map((r) => r.name).join(', ')} removed after failing and not built again — build ${lost.length === 1 ? 'it' : 'them'} another way, never the part around ${lost.length === 1 ? 'it' : 'them'}`)
  if (patches.length > 0) {
    const where = patches
      .slice(0, 3)
      // units-ok: the verdict's text, for the agent — in millimetres always.
      .map((p) => `${p.depth.toFixed(2)} mm at (${p.at.map(r1).join(', ')})${p.madeBy ? ` by ${p.madeBy}` : ''}${p.region ? ` on ${p.region}` : ''}`)
      .join('; ')
    short.push(`${patches.length} feature patch${patches.length === 1 ? '' : 'es'} over T (${where}) — model ${patches.length === 1 ? 'it' : 'them'}, or add the place to the plan as a region skipped with its reason (a warp, lettering) and compare again`)
  }
  const inferredSaid = inferred.length > 0 ? `${inferred.join(', ')} inferred where the scan saw nothing — say which in the chat` : ''
  const next = !met
    ? `not done: ${short.join('; ')} — say so in the chat; the person signs off on less`
    : said.length > 0
      ? `target met, every region done or skipped; ${goneSaid}, each replaced — name them in the chat with why${inferredSaid ? `; ${inferredSaid}` : ''}`
      : inferredSaid
        ? `target met, every region done or skipped; ${inferredSaid}`
        : undefined
  return {
    target: t.withinT,
    side: t.side,
    ...(t.tolerance !== undefined ? { tolerance: t.tolerance } : {}),
    got: at,
    ...(got?.tolerance !== undefined ? { readAt: got.tolerance } : {}),
    met,
    regions: { open, skipped, ...(inferred.length > 0 ? { inferred } : {}) },
    ...(lost.length > 0 ? { unbuilt: lost.map((r) => r.name) } : {}),
    ...(got?.featurePatches ? { featurePatches: { overT: patches.length, ...(patchesInferred > 0 ? { inInferred: patchesInferred } : {}), ...(patches.length > 0 ? { worst: patches.slice(0, 3).map((p) => ({ at: p.at.map(r1), depth: Math.round(p.depth * 100) / 100, ...(p.madeBy ? { madeBy: p.madeBy } : {}), ...(p.region ? { region: p.region } : {}) })) } : {}) } } : {}),
    ...gone,
    ...(next ? { next } : {}),
  }
}

// ---- The gate ------------------------------------------------------------------

export const PLAN_GATE = 'no plan set: reverse.plan.set with the archetype, the regions and the target before building — the person sees it in the chat'

/** The sessions told already, and whether one was told with none. */
const warned = new WeakSet<ReverseSession>()
let warnedBare = false

/** What a change that added a feature answers while no plan is set — once
 *  a session; null otherwise, and with no scan open: the plan's regions and
 *  target are read off a scan, and a part drawn from a drawing has none. */
export function planGate(s: ReverseSession | null): string | null {
  if (usePlan.getState().plan || !useStore.getState().fileName) return null
  if (s ? warned.has(s) : warnedBare) return null
  if (s) warned.add(s)
  else warnedBare = true
  return PLAN_GATE
}

/** The model guide's building section, read before the first feature: the
 *  kernel's habits, the order of rounds and the pre-fillet gate are there. */
const BUILDING_GUIDE = { topic: 'model', section: '2. Building' } as const
export const GUIDE_GATE = `the model guide's §2 Building was not read: guide_read { topic: "${BUILDING_GUIDE.topic}", section: "${BUILDING_GUIDE.section}" } before building — the kernel's habits and the order of rounds are there`

const guideWarned = new WeakSet<ReverseSession>()
let guideWarnedBare = false

/** What a change that added a feature answers while the building section
 *  was not read — once a session; null otherwise. */
export function guideGate(s: ReverseSession | null): string | null {
  if (guideSectionRead(BUILDING_GUIDE.topic, BUILDING_GUIDE.section)) return null
  if (s ? guideWarned.has(s) : guideWarnedBare) return null
  if (s) guideWarned.add(s)
  else guideWarnedBare = true
  return GUIDE_GATE
}

/** A command whose answer, when it added a feature with no plan set or the
 *  building guide unread, says so (planGate, guideGate) — under warning, or
 *  beside one the answer has. */
export function withPlanGate(command: Command<never>, session: () => ReverseSession | null): Command<never> {
  if (command.readOnly || command.name.startsWith('plan.')) return command
  return {
    ...command,
    run: async (input, ctx) => {
      const before = allFeatures().length
      const out = await command.run(input, ctx)
      if (!out || typeof out !== 'object' || Array.isArray(out) || allFeatures().length <= before) return out
      const gate = [planGate(session()), guideGate(session())].filter((g): g is string => g !== null).join('; ')
      if (!gate) return out
      const has = (out as Record<string, unknown>).warning
      if (has === undefined) return { ...out, warning: gate }
      return typeof has === 'string' ? { ...out, warning: `${has}; ${gate}` } : { ...out, planWarning: gate }
    },
  }
}

// ---- Removed after failing -------------------------------------------------------

/** What each feature's last build said when it failed, by id — kept while
 *  the feature is in the list, so one suppressed or put below the bar after
 *  failing is still known for it. */
const lastFailed = new Map<number, string>()

function noteFailures(): void {
  const { results, features, rolledBack } = useReverse.getState()
  for (const r of Object.values(results)) {
    if (r.status === 'failed') lastFailed.set(r.id, r.message ?? 'failed')
    else lastFailed.delete(r.id)
  }
  const ids = new Set([...features, ...rolledBack].map((f) => f.id))
  for (const id of [...lastFailed.keys()]) if (!ids.has(id)) lastFailed.delete(id)
}

/** Why a feature's build last failed, if it did. */
export function failedWith(f: Feature): string | null {
  const r = useReverse.getState().results[f.id]
  if (r?.status === 'failed') return r.message ?? 'failed'
  if (r?.status === 'ok') return null
  return lastFailed.get(f.id) ?? null
}

/** A feature taken out after failing, kept for the verdict. */
export function recordRemoved(f: Feature, message: string): Removed {
  const entry: Removed = { name: f.name, kind: f.kind, message, at: now(), ...(f.kind === 'fillet' ? { radius: f.radius } : {}) }
  usePlan.setState((s) => ({ removed: [...s.removed, entry] }))
  return entry
}

export const REMOVED_SAY = 'removed after failing — say so in the chat, with what it leaves'

// ---- In the readout ----------------------------------------------------------------

const regionOut = (r: PlanRegion) => ({
  name: r.name,
  ...(r.function ? { function: r.function } : {}),
  ...(r.route ? { route: r.route } : {}),
  ...(r.at ? { at: r.at } : {}),
  ...(r.inferred ? { inferred: true } : {}),
  ...(r.skip !== undefined ? { skipped: r.skip } : r.done ? { done: r.feature ? r.feature.name : true } : {}),
})

function planOut(plan: Plan) {
  const open = openRegions(plan).length
  return { archetype: plan.archetype, target: plan.target, regions: plan.regions.map(regionOut), open }
}

/** The plan in the session's readout — its regions, which are done, and
 *  what was removed after failing; null with neither. */
export function planBrief(): Record<string, unknown> | null {
  const { plan, removed } = usePlan.getState()
  const said = removedOut(removed)
  if (!plan && said.length === 0) return null
  return { ...(plan ? planOut(plan) : { none: PLAN_GATE }), ...(said.length > 0 ? { removed: said } : {}) }
}

// ---- The commands ---------------------------------------------------------------

// units-ok: the command's schema, for the agent — in millimetres always.
const boxIn = obj({ min: vec3('The lowest corner, mm.'), max: vec3('The highest corner, mm.') }, ['min', 'max'])

const regionFields = {
  name: str('Its name, as the chat calls it: "+X swage", "socket entrance", "tab 2".', { minLength: 1 }),
  function: str('What it does on the part — "seats the gasket", "styling".'),
  route: str('How it is to be built — "profile extruded along the normals’ direction", "sweep along the plan chain", "cutPlane".'),
  // units-ok: the command's schema, for the agent — in millimetres always.
  at: oneOf([vec3('A point on it, mm.'), boxIn], 'Where it is, in the frame the features are built in: a point on it, or a box round it — what reverse.body.review names a place by.'),
  inferred: bool('Modelled from what the part must be where the scan saw nothing — a bore a wrap closed; needs at as a box. Material missing inside the box is reported apart by reverse.body.review, not ranked as a place and not held against the verdict; the verdict names the region.'),
}

const regionIn = obj(regionFields, ['name'])

type RegionIn = { name: string; function?: string; route?: string; at?: Vec3 | Box; inferred?: boolean }

/** The regions refused where a plan cannot hold them, by plan.set and
 *  plan.update alike: each with a name of its own, a box the right way out,
 *  and an inferred one a box. Returns the names, as keys. */
function checkRegions(regions: readonly RegionIn[]): Set<string> {
  const names = new Set<string>()
  for (const r of regions) {
    const key = r.name.trim().toLowerCase()
    if (!key) invalid('A region needs a name.')
    if (names.has(key)) invalid(`Two regions are named “${r.name.trim()}” — give each its own.`)
    names.add(key)
    const box = r.at && isBox(r.at) ? r.at : null
    if (box && box.min.some((v, k) => v > box.max[k])) invalid(`${r.name}: the box’s min lies past its max.`)
    if (r.inferred && !box) invalid(`${r.name}: inferred needs at as a box — the box says which missing material was inferred.`)
  }
  return names
}

/** The plan, or refused for there being none. */
function planInHand(): Plan {
  const plan = usePlan.getState().plan
  if (!plan) throw new CommandError('invalid_state', `There is no plan — ${PLAN_GATE.replace(/^no plan set: /, '')}.`)
  return plan
}

/** Where the plan holds a region, by its name; not there, refused with those
 *  it has. */
function regionIndex(plan: Plan, region: string): number {
  const key = region.trim().toLowerCase()
  const at = plan.regions.findIndex((r) => r.name.toLowerCase() === key)
  if (at < 0) throw new CommandError('not_found', `The plan has no region “${region.trim()}” — it has ${plan.regions.map((r) => `“${r.name}”`).join(', ')}; a new one goes in with reverse.plan.set.`)
  return at
}

export const planSet: Command<{
  archetype: Archetype
  regions: RegionIn[]
  target?: { withinT: number; side?: 'scan' | 'model'; tolerance?: number }
}> = {
  name: 'set',
  title: 'Set the plan for the part',
  description: `Set the plan before the first feature — what you post in the chat for the person, held by the session so the final comparison is judged against it: the archetype (the scan-to-cad guide’s §4a; "other" when none fits), the region inventory — every region with its function, the route you mean to build it by and at, a point on it or a box round it, so a place the review finds is named by its region — and the target, the share of the scan within ±T the model is to reach. Without target, by the archetype’s class: ${CLASSES.analytic.withinT} % on analytic parts (plate, turned, machined, sheetMetal, shelledHousing, facetedHousing, rotationallyPatterned), ${CLASSES.cast.withinT} % on castings and mouldings (castWithMachinedFeatures, smoothSolidCasting, mouldedHousingWithKeys, volute), ${CLASSES.freeform.withinT} % on freeformThinShell and freeformSurface, ${CLASSES.other.withinT} % for other; the person’s own target, where they gave one, goes in target. Set again to change it — a region found later, a route changed: regions of the same name keep their ticks; reverse.plan.update changes one region alone. Tick each region off with reverse.plan.tick as it is built, or skip it with a reason. reverse.body.compare_in_deviation answers the verdict against it (plan: target, got, met, the regions open and skipped, removed) and, short of it, next: "not done: …" — say so in the chat; the person signs off on less. Saved with the project; session.state carries it under reverse.plan. No step of the undo history. Returns the plan.`,
  input: obj(
    {
      archetype: enumOf(ARCHETYPES, 'The part’s archetype — the guide’s §4a; other when none fits.'),
      regions: arr(regionIn, 'The region inventory: every region of the part, the small ones too — tabs, notches, lips, lettering.', { minItems: 1 }),
      target: obj(
        {
          withinT: num('% of the scan within ±T the model is to reach.', { exclusiveMinimum: 0, maximum: 100 }),
          side: enumOf(['scan', 'model'], 'scan (the default): the share of the scan within T; model: the share of the bodies’ area within T (compare_in_deviation’s onReference).'),
          // units-ok: the command's schema, for the agent — in millimetres always.
          tolerance: num('T, ± mm — a comparison read at a looser tolerance does not meet the target.', { exclusiveMinimum: 0 }),
        },
        ['withinT'],
        'The target; by the archetype’s class when left out.',
      ),
    },
    ['archetype', 'regions'],
  ),
  history: false,
  run: async ({ archetype, regions, target }) => {
    const names = checkRegions(regions)
    const was = usePlan.getState().plan
    const before = new Map((was?.regions ?? []).map((r) => [r.name.trim().toLowerCase(), r]))
    const kept: string[] = []
    const plan: Plan = {
      archetype,
      regions: regions.map((r) => {
        const old = before.get(r.name.trim().toLowerCase())
        const ticks = old ? { ...(old.done ? { done: old.done } : {}), ...(old.feature ? { feature: old.feature } : {}), ...(old.skip !== undefined ? { skip: old.skip } : {}) } : {}
        if (Object.keys(ticks).length > 0) kept.push(r.name.trim())
        return { name: r.name.trim(), ...(r.function ? { function: r.function } : {}), ...(r.route ? { route: r.route } : {}), ...(r.at ? { at: r.at } : {}), ...(r.inferred ? { inferred: true } : {}), ...ticks }
      }),
      target: target
        ? { withinT: target.withinT, side: target.side ?? 'scan', ...(target.tolerance !== undefined ? { tolerance: target.tolerance } : {}), by: 'given' }
        : { withinT: CLASSES[CLASS_OF[archetype]].withinT, side: 'scan', by: 'archetype' },
      set: now(),
    }
    usePlan.setState({ plan })
    // Ticked regions the new plan no longer has, said: their ticks go.
    const dropped = [...before.values()].filter((r) => (r.done || r.skip !== undefined) && !names.has(r.name.trim().toLowerCase())).map((r) => r.name)
    return {
      plan: planOut(plan),
      ...(target ? {} : { targetBy: `the archetype’s class (${CLASSES[CLASS_OF[archetype]].says}): ${plan.target.withinT} % within T — the person’s own goes in target` }),
      ...(kept.length > 0 ? { kept } : {}),
      ...(dropped.length > 0 ? { dropped } : {}),
      next: 'post the plan in the chat — the archetype, the regions and the target — and tick each region with reverse.plan.tick as it is built',
    }
  },
}

export const planTick: Command<{ region: string; feature?: Ref; skip?: string }> = {
  name: 'tick',
  title: 'Tick a region of the plan off',
  description:
    'Tick a region of the plan (reverse.plan.set) off once it is built — with feature, the one that built it, by id or name — or skip it: skip, why it is left out ("the gasket is a separate part", "the person said leave the lettering"). A skipped region is no open one, but the verdict lists it with its reason: say it in the chat. Ticked again, the last says. A region the plan lacks goes in with reverse.plan.set (the regions you have and the new one; ticks stay). No step of the undo history. Returns the region, and the regions still open.',
  input: obj(
    {
      region: str('The region, by its name in the plan.', { minLength: 1 }),
      feature: featureRef('feature that built it'),
      skip: str('Why it is left out — in place of feature.', { minLength: 1 }),
    },
    ['region'],
  ),
  history: false,
  run: async ({ region, feature, skip }) => {
    const plan = planInHand()
    if (feature !== undefined && skip !== undefined) invalid('Give feature or skip, not both: a region is built or left out.')
    const at = regionIndex(plan, region)
    const f = feature !== undefined ? featureNamed(feature) : null
    const r = plan.regions[at]
    const { done: _done, feature: _feature, skip: _skip, ...rest } = r
    void _done
    void _feature
    void _skip
    const ticked: PlanRegion = skip !== undefined ? { ...rest, skip: skip.trim() } : { ...rest, done: now(), ...(f ? { feature: { id: f.id, name: f.name } } : {}) }
    const next: Plan = { ...plan, regions: plan.regions.map((x, i) => (i === at ? ticked : x)) }
    usePlan.setState({ plan: next })
    const open = openRegions(next).map((x) => x.name)
    return { region: regionOut(ticked), open, ...(open.length === 0 ? { next: 'every region is done or skipped — reverse.body.compare_in_deviation for the verdict against the target' } : {}) }
  },
}

export const planUpdate: Command<{ region: string; set: Partial<RegionIn> }> = {
  name: 'update',
  title: 'Change one region of the plan',
  description:
    'Change the fields of one region of the plan (reverse.plan.set) and nothing else — its box widened, its route changed, marked inferred: the ticks and every other region stay. set holds the fields to change: name, function, route, at, inferred; what it leaves out stays as it is. The same checks as reverse.plan.set. No step of the undo history. Returns the region, and the regions still open.',
  input: obj(
    {
      region: str('The region, by its name in the plan.', { minLength: 1 }),
      set: obj(regionFields, [], 'The fields to change.'),
    },
    ['region', 'set'],
  ),
  history: false,
  run: async ({ region, set }) => {
    const plan = planInHand()
    if (Object.keys(set).length === 0) invalid('set: give a field to change — name, function, route, at or inferred.')
    const at = regionIndex(plan, region)
    const changed: PlanRegion = { ...plan.regions[at], ...set, name: (set.name ?? plan.regions[at].name).trim() }
    if (!changed.function) delete changed.function
    if (!changed.route) delete changed.route
    if (!changed.inferred) delete changed.inferred
    const regions = plan.regions.map((x, i) => (i === at ? changed : x))
    checkRegions(regions)
    const next: Plan = { ...plan, regions }
    usePlan.setState({ plan: next })
    return { region: regionOut(changed), open: openRegions(next).map((x) => x.name) }
  },
}

export const planReplace: Command<{ removed: string; by: Ref; reason: string }> = {
  name: 'replace',
  title: 'Say what took a removed feature’s place',
  description:
    'A feature removed after failing that another, built, has made needless — a join of a piece no longer there, a round of a blade since rebuilt in one: the verdict stops holding it against the run and lists it with by and reason. by must be built, and a round or chamfer takes a round or chamfer — or, for a round built into the profile instead, an extrude or a revolve whose own sketch holds an arc of about its radius: nothing here waves a missing feature away. Should by fail or go, or the arc leave its sketch, the removed feature is owed again. No step of the undo history. Returns what was replaced, the arc taken for the round where one was, and what is still unbuilt.',
  input: obj(
    {
      removed: str('The feature removed after failing, by its name in the verdict.', { minLength: 1 }),
      by: featureRef('feature built in its place'),
      reason: str('Why it is no longer needed, in words the person can read in the chat.', { minLength: 1 }),
    },
    ['removed', 'by', 'reason'],
  ),
  history: false,
  run: async ({ removed: name, by, reason }) => {
    const { removed } = usePlan.getState()
    const wanted = name.trim()
    const of = removed.filter((r) => r.name === wanted)
    if (of.length === 0) throw new CommandError('not_found', `Nothing named “${wanted}” was removed after failing — ${removed.length > 0 ? `these were: ${[...new Set(removed.map((r) => r.name))].join(', ')}` : 'nothing was'}.`)
    const f = featureNamed(by)
    if (!isBuilt(f)) throw new CommandError('invalid_state', `${f.name} is not built, so it stands in for nothing — build it first, or build ${wanted} another way.`)
    const isRound = (kind: string) => kind === 'fillet' || kind === 'chamfer'
    const radius = of.at(-1)!.radius
    const inProfile = isRound(of[0].kind) && !isRound(f.kind)
    // A round drawn as an arc of the profile is there; a chamfer has no arc.
    const arc = inProfile && of[0].kind === 'fillet' ? arcFor(f, radius) : null
    if (inProfile && !arc) {
      const arcs = profileArcs(f).map((a) => `R${a.radius}`)
      const none = (f.kind === 'extrude' || f.kind === 'revolve') && of[0].kind === 'fillet' ? `, whose sketch holds no arc${radius !== undefined ? ` of about R${radius}` : ''}${arcs.length > 0 ? ` (it has ${arcs.join(', ')})` : ''}` : ''
      invalid(`${wanted} is a ${of[0].kind}, and ${f.name} ${/^[aeiou]/.test(f.kind) ? 'an' : 'a'} ${f.kind}${none}: a round is replaced by a round or a chamfer that builds, or by a revolve or an extrude whose own sketch holds an arc of about its radius, or stays owed.`)
    }
    const replaced = { by: { id: f.id, name: f.name }, reason: reason.trim(), at: now(), ...(arc ? { arc } : {}) }
    const next = removed.map((r) => (r.name === wanted ? { ...r, replaced } : r))
    usePlan.setState({ removed: next })
    const arcSaid = arc ? { arc: { ...arc, ...(radius !== undefined ? { roundWas: radius } : { note: `the removal kept no radius — the smallest arc of ${arc.sketch} was taken; check it is the round` }) } } : {}
    return { replaced: { removed: wanted, by: f.name, reason: replaced.reason, ...arcSaid }, unbuilt: unbuilt(next).map((r) => r.name) }
  },
}

// ---- Saved with the project ---------------------------------------------------------

export interface PlanPart {
  plan?: Plan
  removed?: Removed[]
}

function validateAt(at: unknown, path: string): void {
  if (Array.isArray(at)) return vector(at, 3, path)
  const box = object(at, path)
  vector(box.min, 3, `${path}.min`)
  vector(box.max, 3, `${path}.max`)
}

function validatePlan(value: unknown): Plan {
  const p = object(value, 'plan')
  if (!ARCHETYPES.includes(p.archetype as Archetype)) malformed('plan.archetype')
  fields(p, 'set', 'string', 'plan')
  for (const item of array(p.regions, 'plan.regions')) {
    const r = object(item, 'plan.regions')
    fields(r, 'name', 'string', 'plan.regions')
    for (const k of ['function', 'route', 'done', 'skip']) if (r[k] !== undefined && typeof r[k] !== 'string') malformed(`plan.regions.${k}`)
    if (r.at !== undefined) validateAt(r.at, 'plan.regions.at')
    if (r.inferred !== undefined && typeof r.inferred !== 'boolean') malformed('plan.regions.inferred')
    if (r.feature !== undefined) {
      fields(object(r.feature, 'plan.regions.feature'), 'id', 'number', 'plan.regions.feature')
      fields(object(r.feature, 'plan.regions.feature'), 'name', 'string', 'plan.regions.feature')
    }
  }
  const t = object(p.target, 'plan.target')
  fields(t, 'withinT', 'number', 'plan.target')
  if (t.side !== 'scan' && t.side !== 'model') malformed('plan.target.side')
  if (t.by !== 'given' && t.by !== 'archetype') malformed('plan.target.by')
  if (t.tolerance !== undefined) fields(t, 'tolerance', 'number', 'plan.target')
  return p as unknown as Plan
}

function validateRemoved(value: unknown): Removed[] {
  return array(value, 'plan.removed').map((item) => {
    const r = object(item, 'plan.removed')
    fields(r, 'name kind message at', 'string', 'plan.removed')
    if (r.radius !== undefined) fields(r, 'radius', 'number', 'plan.removed')
    if (r.replaced !== undefined) {
      const by = object(object(r.replaced, 'plan.removed.replaced').by, 'plan.removed.replaced.by')
      fields(by, 'id', 'number', 'plan.removed.replaced.by')
      fields(by, 'name', 'string', 'plan.removed.replaced.by')
      fields(object(r.replaced, 'plan.removed.replaced'), 'reason at', 'string', 'plan.removed.replaced')
      const arc = object(r.replaced, 'plan.removed.replaced').arc
      if (arc !== undefined) {
        fields(object(arc, 'plan.removed.replaced.arc'), 'sketch', 'string', 'plan.removed.replaced.arc')
        fields(object(arc, 'plan.removed.replaced.arc'), 'piece radius', 'number', 'plan.removed.replaced.arc')
      }
    }
    return r as unknown as Removed
  })
}

/** The plan as a save or an export finds it, in a sentence: the regions left
 *  open and the target, so a file is not taken for the finished part. Null
 *  with no plan or none open. */
export function planOpenSaid(): string | null {
  const { plan } = usePlan.getState()
  if (!plan) return null
  const open = openRegions(plan).map((r) => r.name)
  if (open.length === 0) return null
  const names = open.length > 6 ? `${open.slice(0, 6).join(', ')} and ${open.length - 6} more` : open.join(', ')
  return `The plan has ${open.length} of ${plan.regions.length} regions open (${names}), target ${plan.target.withinT} % within T: tick or skip them (reverse.plan.tick), or say in the report that they stand.`
}

export const planSection: ProjectSection<PlanPart> = {
  key: 'reversePlan',
  saveSays: () => {
    const open = planOpenSaid()
    return open ? [open] : []
  },
  collect: () => {
    const { plan, removed } = usePlan.getState()
    if (!plan && removed.length === 0) return undefined
    return { ...(plan ? { plan } : {}), ...(removed.length > 0 ? { removed } : {}) }
  },
  prepare(value) {
    if (value !== undefined && (typeof value !== 'object' || value === null)) throw new Error('Malformed project: plan.')
    const part = (value ?? {}) as PlanPart
    const plan = part.plan === undefined ? null : validatePlan(part.plan)
    const removed = part.removed === undefined ? [] : validateRemoved(part.removed)
    // The project's, or none — as its notes replace those in hand.
    return () => usePlan.setState({ plan, removed })
  },
  hasContent: (value) => value.plan !== undefined || (value.removed?.length ?? 0) > 0,
  watch(changed) {
    return usePlan.subscribe((s, prev) => {
      if (s.plan !== prev.plan || s.removed !== prev.removed) changed()
    })
  },
}

/** Keep the plan with its part and the failures known: another scan put on
 *  the stage lets the plan go — a project opened puts its own in place
 *  after its scan's name is set — and each build's failures are noted for
 *  failedWith. Returns what stops it. */
export function watchPlan(): () => void {
  let part = useStore.getState().fileName ?? ''
  const stopPart = useStore.subscribe((s) => {
    const name = s.fileName ?? ''
    if (name === part) return
    // A blank stage's plan goes with the scan that comes onto it.
    if (part !== '') usePlan.setState({ plan: null, removed: [] })
    part = name
  })
  noteFailures()
  const stopFailures = useReverse.subscribe((s, prev) => {
    if (s.results !== prev.results || s.features !== prev.features || s.rolledBack !== prev.rolledBack) noteFailures()
  })
  return () => {
    stopPart()
    stopFailures()
  }
}

// ---- the loops --------------------------------------------------------------------

/** Every reverse.body.review of this session, on the scan open when it ran —
 *  kept here, beside the plan, so the final comparison can say what the
 *  loops were without importing the review. */
const histories = new WeakMap<ReverseSession, { file: string | null; marks: ReviewMark[] }>()

/** The reviews kept in the session on the scan open now, the first first. */
export function reviewHistory(s: ReverseSession): readonly ReviewMark[] {
  const h = histories.get(s)
  return h && h.file === useStore.getState().fileName ? h.marks : []
}

/** A review kept; the reviews on this scan so far, this one last. */
export function keepReview(s: ReverseSession, mark: ReviewMark): ReviewMark[] {
  const file = useStore.getState().fileName
  let h = histories.get(s)
  if (!h || h.file !== file) {
    h = { file, marks: [] }
    histories.set(s, h)
  }
  h.marks.push(mark)
  return h.marks
}

/** The loops as the final comparison and the report give them: how many
 *  reviews, and the first and the last — % within T and mm³ each way. */
export function loopsOf(s: ReverseSession): Record<string, unknown> | undefined {
  const marks = reviewHistory(s)
  if (marks.length === 0) return undefined
  const brief = (m: ReviewMark) => ({ features: m.features, withinT: m.withinT, excess: m.excess, missing: m.missing })
  return { reviews: marks.length, first: brief(marks[0]), last: brief(marks[marks.length - 1]) }
}

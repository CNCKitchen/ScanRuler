// SPDX-License-Identifier: AGPL-3.0-only
// The parameters of a model and the numbers that read them. A parameter is
// a named expression of a kind — a length, an angle, a whole number, a
// plain number — in one list for the whole model, outside the feature list
// and the rollback bar. A feature's numbers stay numbers, holding the value
// last evaluated; beside them the feature keeps the expressions that
// drive them, keyed by *slot* — the field as the box shows it (an extrude's
// To, a hole's Diameter), which is not always the field as the feature
// stores it (a radius, a draft with the opposite sign). A sketch dimension
// keeps its expression beside its value the same way. When a parameter
// changes, every expression is evaluated again, the numbers written, every
// sketch with a changed dimension solved again, and the part rebuilt from
// nothing but numbers — the kernel never sees an expression.

import { datumTraces } from './datums'
import { dimOfKind, evaluateFor, references, renameIn, RESERVED_NAMES, validName, type ParameterKind, type Scope } from './expression'
import { planeAtOffset, planeOffset, planeTakesOffset, revolveMaxDeg, withPlaneOffset, type Feature, type PlaneRef, type RegionBox, type RegionPick, type SketchFeature, type SketchInset } from './features'
import type { SectionFrame } from '../../../src/core/section/frame'
import { findRegions, matchRegion, regionByPlace, regionsByPick, splitParts, type Region } from './regions'
import { cloneSketch, isDimension, type Constraint, type Sketch } from './sketch'
import { solveSketch } from './solver'
import { insetChains } from './stations'
import type { SweepRoute } from './sweepRoute'

export type { ParameterKind } from './expression'

export interface Parameter {
  id: number
  /** The identifier expressions use — see expression.ts validName. */
  name: string
  kind: ParameterKind
  /** As typed: "25", "25.4/12", "threadlength+10". */
  expression: string
  comment?: string
}

export const PARAMETER_KINDS: readonly { kind: ParameterKind; label: string; unit: string }[] = [
  // units-ok: the unit a parameter's value is answered in, not shown
  { kind: 'length', label: 'Length', unit: 'mm' },
  { kind: 'angle', label: 'Angle', unit: '°' },
  { kind: 'integer', label: 'Integer', unit: '' },
  { kind: 'number', label: 'Number', unit: '' },
]

/** The expressions a feature or a draft keeps beside its numbers, by slot. */
export type ExprMap = Record<string, string>

/** An expression of the opposite sign: "-(e)", or e again for "-(e)". */
export function negatedExpr(e: string): string {
  const t = e.trim()
  if (/^[+-]?\d*\.?\d+(e[+-]?\d+)?$/i.test(t)) return String(-Number(t))
  const m = /^-\s*\((.*)\)$/s.exec(t)
  if (m) {
    // Only when the outer brackets pair with each other: not "-(a) * (b)".
    let depth = 0
    let pairs = true
    for (const ch of m[1]) {
      if (ch === '(') depth++
      else if (ch === ')' && --depth < 0) pairs = false
    }
    if (pairs && depth === 0) return m[1].trim()
  }
  return `-(${t})`
}

/** An extrude keeps its lean as draftDeg (positive leans in) and the
 *  expression on the panel's taper, the other way round. Commands take and
 *  give it as `draftDeg` too, so the sign never has to be turned by hand. */
export function exprsFromCommand(kind: string | undefined, given: Record<string, unknown>): Record<string, unknown> {
  if (kind !== 'extrude' || !('draftDeg' in given)) return given
  const { draftDeg, ...rest } = given
  return { ...rest, taper: typeof draftDeg === 'string' && draftDeg.trim() !== '' ? negatedExpr(draftDeg) : draftDeg }
}

/** The expressions as a command answers them: an extrude's taper as draftDeg. */
export function exprsForCommand(kind: string | undefined, exprs: ExprMap): ExprMap {
  if (kind !== 'extrude' || !('taper' in exprs)) return exprs
  const { taper, ...rest } = exprs
  return { ...rest, draftDeg: negatedExpr(taper) }
}

// ---- the table ------------------------------------------------------------------

/** A parameter as the table reads it: its value, or why it has none. */
export interface ParameterReading {
  id: number
  name: string
  kind: ParameterKind
  value: number | null
  error: string | null
}

export interface ParameterTable {
  readings: ParameterReading[]
  /** The parameters as a scope for the features' expressions: a parameter
   *  with no value answers with why. */
  scope: Scope
}

/** Why a name will not do, or null. */
export function nameProblem(name: string, others: readonly Parameter[], self?: number): string | null {
  if (name === '') return 'needs a name'
  if (RESERVED_NAMES.has(name)) return `“${name}” is a word the expressions keep`
  if (!validName(name)) return 'a name is a letter or an underscore, then letters, digits and underscores'
  const clash = others.find((p) => p.id !== self && p.name.toLowerCase() === name.toLowerCase())
  if (clash) return clash.name === name ? `another parameter is named “${name}” already` : `too like “${clash.name}” — a name may not differ from another’s by its case alone`
  return null
}

/** Evaluate the whole table, each parameter after the ones it reads: a
 *  parameter that cannot be read — a name that is wrong, an expression
 *  that does not evaluate, a loop of parameters reading each other — is
 *  reported with why, and whatever read it says so too. */
export function evaluateParameters(parameters: readonly Parameter[]): ParameterTable {
  const byName = new Map<string, Parameter>()
  for (const p of parameters) if (!byName.has(p.name)) byName.set(p.name, p)
  const readings = new Map<number, ParameterReading>()
  const visiting: Parameter[] = []
  const looped = new Map<number, string>()
  const read = (p: Parameter): ParameterReading => {
    const done = readings.get(p.id)
    if (done) return done
    const at = visiting.indexOf(p)
    if (at >= 0) {
      const loop = [...visiting.slice(at).map((q) => q.name), p.name]
      const message = `goes round in a loop: ${loop.join(' → ')}`
      for (const q of visiting.slice(at)) looped.set(q.id, message)
      return { id: p.id, name: p.name, kind: p.kind, value: null, error: message }
    }
    visiting.push(p)
    let reading: ParameterReading
    const problem = nameProblem(p.name, parameters, p.id)
    if (problem) reading = { id: p.id, name: p.name, kind: p.kind, value: null, error: problem }
    else {
      const scope: Scope = (name) => {
        const q = byName.get(name)
        if (!q) return undefined
        const r = read(q)
        return r.value === null ? { error: `“${name}” has no value: ${r.error}` } : { value: r.value, dim: dimOfKind(r.kind) }
      }
      const r = evaluateFor(p.expression, p.kind, scope, { whole: true })
      reading = r.ok ? { id: p.id, name: p.name, kind: p.kind, value: r.value, error: null } : { id: p.id, name: p.name, kind: p.kind, value: null, error: r.error }
    }
    visiting.pop()
    const loop = looped.get(p.id)
    if (loop) reading = { ...reading, value: null, error: loop }
    readings.set(p.id, reading)
    return reading
  }
  // Read first those whose parameters are read already, the ones they read
  // found without recursion: a long chain of parameters each reading the
  // next is then read one link at a time, not as deep as it is long. One
  // in a loop is left for the reading below, which says where it goes round.
  const ordered = new Set<Parameter>()
  for (const root of parameters) {
    const stack: [Parameter, boolean][] = [[root, false]]
    while (stack.length > 0) {
      const [p, expanded] = stack.pop()!
      const reads = references(p.expression).flatMap((name) => byName.get(name) ?? [])
      if (expanded) {
        if (reads.every((q) => readings.has(q.id))) read(p)
        continue
      }
      if (ordered.has(p)) continue
      ordered.add(p)
      stack.push([p, true])
      for (const q of reads) if (!ordered.has(q)) stack.push([q, false])
    }
  }
  const list = parameters.map(read)
  const byReadName = new Map<string, ParameterReading>()
  for (const r of list) if (!byReadName.has(r.name)) byReadName.set(r.name, r)
  const scope: Scope = (name) => {
    const r = byReadName.get(name)
    if (!r) return undefined
    return r.value === null ? { error: `“${name}” has no value` } : { value: r.value, dim: dimOfKind(r.kind) }
  }
  return { readings: list, scope }
}

// ---- slots ------------------------------------------------------------------------

/** What a slot reads and writes: a feature, or the draft of one — the
 *  fields are named alike on both. An extrude's or a revolve's draft has
 *  no kind of its own, and says which it is. */
interface Slotted { kind?: string }

/** A number of a feature as its box shows it, read and written through
 *  the feature's own fields. */
export interface Slot<T extends Slotted = Slotted> {
  path: string
  label: string
  kind: ParameterKind
  get(x: T): number
  set(x: T, value: number): T
}

type Fields = Record<string, unknown>

const num = (x: Slotted, key: string): number => ((x as Fields)[key] as number) ?? 0

/** A slot on one top-level number field. `tidy` is what a typed number
 *  goes through — its sign dropped, a count rounded. */
function field<T extends Slotted>(path: string, label: string, kind: ParameterKind, tidy: (v: number) => number = (v) => v): Slot<T> {
  return { path, label, kind, get: (x) => num(x, path), set: (x, v) => ({ ...x, [path]: tidy(v) }) }
}

const positive = (v: number) => Math.abs(v)

/** The slots a feature or a draft offers, as its box shows them. */
export function slotsOf<T extends Slotted>(x: T, kind: string | undefined = x.kind): Slot<T>[] {
  const f = x as unknown as Fields
  switch (kind) {
    case 'extrude': {
      const extent = f.extent as { kind: string } & Fields
      const out: Slot<T>[] = []
      const ext = (key: string, label: string, tidy: (v: number) => number = (v) => v): Slot<T> => ({
        path: `extent.${key}`,
        label,
        kind: 'length',
        get: (y) => (((y as unknown as Fields).extent as Fields)[key] as number) ?? 0,
        set: (y, v) => ({ ...y, extent: { ...((y as unknown as Fields).extent as Fields), [key]: tidy(v) } }),
      })
      if (extent.kind === 'distance') out.push(ext('from', 'From'), ext('to', 'To'))
      else if (extent.kind === 'symmetric') out.push(ext('total', 'Total', positive))
      else if (extent.kind !== 'betweenPlanes') out.push(ext('from', 'From'))
      // Shown as a taper, Fusion's way round: positive leans the sides out.
      out.push({
        path: 'taper',
        label: 'Taper',
        kind: 'angle',
        get: (y) => {
          const d = ((y as unknown as Fields).draftDeg as number | undefined) ?? 0
          return d === 0 ? 0 : -d
        },
        set: (y, v) => ({ ...y, draftDeg: v === 0 ? 0 : -v }),
      })
      return out
    }
    case 'revolve': {
      const pitch = (f.pitch as number | undefined) ?? 0
      const out: Slot<T>[] = [
        { path: 'angleDeg', label: 'Angle', kind: 'angle', get: (y) => num(y, 'angleDeg'), set: (y, v) => ({ ...y, angleDeg: Math.min(revolveMaxDeg(pitchOf(y)), Math.max(0.1, Math.abs(v))) }) },
      ]
      if (pitch) {
        out.push(
          field('pitch', 'Pitch', 'length'),
          { path: 'turns', label: 'Turns', kind: 'number', get: (y) => num(y, 'angleDeg') / 360, set: (y, v) => ({ ...y, angleDeg: Math.min(revolveMaxDeg(pitchOf(y)), Math.max(0.1, Math.abs(v) * 360)) }) },
          {
            path: 'height',
            label: 'Height',
            kind: 'length',
            get: (y) => (Math.abs(pitchOf(y)) * num(y, 'angleDeg')) / 360,
            set: (y, v) => (pitchOf(y) ? { ...y, angleDeg: Math.min(revolveMaxDeg(pitchOf(y)), Math.max(0.1, (Math.abs(v) / Math.abs(pitchOf(y))) * 360)) } : y),
          },
        )
      }
      return out
    }
    case 'shell':
      return [field('thickness', 'Wall', 'length', positive)]
    case 'fillet':
      return [field('radius', 'Radius', 'length', positive)]
    case 'chamfer': {
      const out: Slot<T>[] = [field('distance', 'Distance', 'length', positive)]
      if (f.mode === 'twoDistances') out.push(field('distance2', 'Distance 2', 'length', positive))
      if (f.mode === 'distanceAngle') out.push(field('angleDeg', 'Angle', 'angle', (v) => Math.min(89.9, Math.max(0.1, Math.abs(v)))))
      return out
    }
    case 'hole': {
      const out: Slot<T>[] = [{ path: 'diameter', label: 'Diameter', kind: 'length', get: (y) => 2 * num(y, 'radius'), set: (y, v) => ({ ...y, radius: Math.abs(v) / 2 }) }]
      if (f.depth !== null && f.depth !== undefined) out.push(field('depth', 'Depth', 'length', positive))
      return out
    }
    case 'thread': {
      const out: Slot<T>[] = [field('diameter', 'Diameter', 'length', positive), field('pitch', 'Pitch', 'length', positive)]
      const runs = 'fullLength' in f ? !f.fullLength : f.length !== null && f.length !== undefined
      if (runs) out.push(field('length', 'Length', 'length', positive), field('start', 'Start', 'length', positive))
      out.push(field('offset', 'Offset', 'length'))
      return out
    }
    case 'extract':
    case 'thicken':
      return [field('thickness', 'Thickness', 'length', positive)]
    case 'draft':
      return [field('angleDeg', 'Angle', 'angle')]
    case 'moveFace':
      return [field('offset', 'Offset', 'length')]
    case 'offsetBody':
      return [field('distance', 'Distance', 'length')]
    case 'moveBody': {
      // Each of the six numbers on its own: `translate.x`, `rotate.z`.
      const axis = (key: 'translate' | 'rotate', i: number): Slot<T> => ({
        path: `${key}.${'xyz'[i]}`,
        label: `${key === 'translate' ? 'Move' : 'Turn'} ${'XYZ'[i]}`,
        kind: key === 'translate' ? 'length' : 'angle',
        get: (y) => ((y as unknown as Fields)[key] as number[] | undefined)?.[i] ?? 0,
        set: (y, v) => {
          const next = [...(((y as unknown as Fields)[key] as number[] | undefined) ?? [0, 0, 0])]
          next[i] = v
          return { ...y, [key]: next }
        },
      })
      return [0, 1, 2].map((i) => axis('translate', i)).concat([0, 1, 2].map((i) => axis('rotate', i)))
    }
    case 'sheet':
      return [field('from', 'From', 'length'), field('to', 'To', 'length')]
    case 'sweep':
      if (!f.route) return []
      return [{ path: 'route.bendRadius', label: 'Bend radius', kind: 'length', get: (y) => ((y as unknown as Fields).route as SweepRoute).bendRadius, set: (y, v) => ({ ...y, route: { ...((y as unknown as Fields).route as SweepRoute), bendRadius: Math.abs(v) } }) }]
    case 'pattern': {
      const out: Slot<T>[] = [
        field('count', 'Count', 'integer', (v) => Math.max(2, Math.round(Math.abs(v)))),
        field('step', f.mode === 'circular' ? 'Over' : 'Spacing', f.mode === 'circular' ? 'angle' : 'length', positive),
      ]
      if (f.mode === 'linear' && f.axis2) out.push(field('count2', 'Count 2', 'integer', (v) => Math.max(1, Math.round(Math.abs(v)))), field('step2', 'Spacing 2', 'length', positive))
      return out
    }
    case 'sketch': {
      // The plane's offset: a coordinate plane's coordinate, how far off a
      // face or a measured plane the sketch stands.
      const plane = f.plane as PlaneRef
      const out: Slot<T>[] = []
      if (plane && planeTakesOffset(plane)) out.push({ path: 'offset', label: plane.kind === 'world' ? `${plane.axis.toUpperCase()} =` : 'Offset', kind: 'length', get: (y) => planeOffset((y as unknown as Fields).plane as PlaneRef), set: (y, v) => withPlaneOffset(y as unknown as { plane: PlaneRef; frame: SectionFrame }, v) as unknown as T })
      // A profile moved in from another sketch: the wall it was moved by.
      // The number alone is written here; applyParameters moves the
      // profile in again.
      if (f.inset) out.push({ path: 'inset', label: 'Inset', kind: 'length', get: (y) => ((y as unknown as Fields).inset as SketchInset).by, set: (y, v) => ({ ...y, inset: { ...((y as unknown as Fields).inset as SketchInset), by: v } }) })
      return out
    }
    case 'cutPlane':
    case 'mirror': {
      // The plane's offset, as a sketch's: a coordinate plane's coordinate,
      // how far off a face or a measured plane the cut or the mirror is.
      const plane = f.plane as PlaneRef | { kind: 'face' } | null
      if (!plane || plane.kind === 'face' || !planeTakesOffset(plane)) return []
      return [{ path: 'plane.offset', label: 'Offset', kind: 'length', get: (y) => planeOffset((y as unknown as Fields).plane as PlaneRef), set: (y, v) => ({ ...y, plane: planeAtOffset((y as unknown as Fields).plane as PlaneRef, v) }) }]
    }
    case 'surface': {
      // The box the region was read in: each of its six numbers. A number
      // moved leaves the region to be read again in the box (regionStale).
      if (!f.regionBox) return []
      const corner = (end: 'min' | 'max', i: number): Slot<T> => ({
        path: `region.box.${end}.${'xyz'[i]}`,
        label: `Box ${end} ${'XYZ'[i]}`,
        kind: 'length',
        get: (y) => ((y as unknown as Fields).regionBox as RegionBox).box[end][i],
        set: (y, v) => {
          const was = (y as unknown as Fields).regionBox as RegionBox
          const at = [...was.box[end]] as RegionBox['box']['min']
          at[i] = v
          return { ...y, regionBox: { ...was, box: { ...was.box, [end]: at } }, regionStale: true }
        },
      })
      return (['min', 'max'] as const).flatMap((end) => [0, 1, 2].map((i) => corner(end, i)))
    }
    case 'split':
    case 'trim':
      return [
        field('tolerance', 'Tolerance', 'length', positive),
        { path: 'overlap', label: 'Overlap', kind: 'number', get: (y) => num(y, 'overlap') * 100, set: (y, v) => ({ ...y, overlap: Math.min(1, Math.max(0.05, Math.abs(v) / 100)) }) },
      ]
    default:
      return []
  }
}

const pitchOf = (x: Slotted): number => ((x as Fields).pitch as number | undefined) ?? 0

/** The slot of a feature or a draft at a path, or undefined. */
export function slotAt<T extends Slotted>(x: T, path: string, kind?: string): Slot<T> | undefined {
  return slotsOf(x, kind).find((s) => s.path === path)
}

/** The kind of a sketch dimension's number. */
export function dimensionKind(kind: Constraint['kind']): ParameterKind {
  return kind === 'angle' ? 'angle' : 'length'
}

// ---- writing the expressions through ------------------------------------------------

/** Where an expression went wrong, by slot path (a sketch's by `dim:<id>`). */
export type ExprErrors = Record<string, string>

/** A feature or a draft with every expression it keeps evaluated and the
 *  numbers written — the same object back when nothing changes. An
 *  expression that does not evaluate leaves its number as it was and is
 *  reported; one whose slot the feature no longer has (an extent of
 *  another kind) is dropped. */
export function applySlots<T extends Slotted & { exprs?: ExprMap }>(x: T, scope: Scope, kind?: string): { next: T; errors: ExprErrors } {
  const errors: ExprErrors = {}
  if (!x.exprs) return { next: x, errors }
  let next = x
  let exprs: ExprMap | null = null
  for (const [path, expr] of Object.entries(x.exprs)) {
    const slot = slotAt(next, path, kind)
    if (!slot) {
      exprs = exprs ?? { ...x.exprs }
      delete exprs[path]
      continue
    }
    const r = evaluateFor(expr, slot.kind, scope)
    if (!r.ok) {
      errors[path] = r.error
      continue
    }
    if (Math.abs(slot.get(next) - r.value) > 1e-9) next = slot.set(next, r.value)
  }
  if (exprs) next = Object.keys(exprs).length > 0 ? { ...next, exprs } : withoutExprs(next)
  return { next, errors }
}

function withoutExprs<T extends { exprs?: ExprMap }>(x: T): T {
  const { exprs: _exprs, ...rest } = x
  void _exprs
  return rest as T
}

/** A feature or a draft with one slot's number set — and its expression,
 *  or none: a plain number typed over an expression unlinks it. */
export function withSlot<T extends Slotted & { exprs?: ExprMap }>(x: T, path: string, value: number, expr: string | null, kind?: string): T {
  const slot = slotAt(x, path, kind)
  let next = slot ? slot.set(x, value) : x
  const exprs: ExprMap = { ...(x.exprs ?? {}) }
  if (expr) exprs[path] = expr
  else delete exprs[path]
  next = Object.keys(exprs).length > 0 ? { ...next, exprs } : withoutExprs(next)
  return next
}

/** A feature or a draft with a slot's expression let go — a grip dragged,
 *  a number typed. */
export function unlinkSlot<T extends Slotted & { exprs?: ExprMap }>(x: T, path: string): T {
  if (!x.exprs || !(path in x.exprs)) return x
  const exprs = { ...x.exprs }
  delete exprs[path]
  return Object.keys(exprs).length > 0 ? { ...x, exprs } : withoutExprs(x)
}

/** The dimensions of a sketch with their expressions evaluated: the
 *  values written and the sketch solved again on them — a copy, the given
 *  sketch untouched — or the same sketch back when no value changes. */
export function applySketchExpressions(sketch: Sketch, frame: Parameters<typeof datumTraces>[0], scope: Scope): { next: Sketch; errors: ExprErrors } {
  const errors: ExprErrors = {}
  const values = new Map<number, number>()
  for (const c of sketch.constraints) {
    if (!isDimension(c) || !c.expr) continue
    const r = evaluateFor(c.expr, dimensionKind(c.kind), scope)
    if (!r.ok) {
      errors[`dim:${c.id}`] = r.error
      continue
    }
    if (Math.abs(c.value - r.value) > 1e-9) values.set(c.id, r.value)
  }
  if (values.size === 0) return { next: sketch, errors }
  const next = cloneSketch(sketch)
  next.constraints = next.constraints.map((c) => (values.has(c.id) ? { ...c, value: values.get(c.id)! } : c))
  try {
    solveSketch(next, { datums: datumTraces(frame) })
  } catch (e) {
    errors.sketch = e instanceof Error ? e.message : String(e)
  }
  return { next, errors }
}

/** The feature list with another sketch in the place of the one with
 *  `id`: the features on that sketch keep their profiles — every pick is
 *  matched to the region it names in the sketch as it is now and the key
 *  written over, so a side moved does not leave an extrude pointing at a
 *  middle that moved. */
export function replaceSketch(features: readonly Feature[], id: number, sketch: Sketch, patch: Partial<Omit<SketchFeature, 'sketch'>> = {}): Feature[] {
  const regions = findRegions(sketch)
  const old = features.find((f): f is SketchFeature => f.id === id && f.kind === 'sketch')
  let before: Region[] | null = null
  return features.map((f) => {
    if (f.id === id && f.kind === 'sketch') return { ...f, ...patch, sketch }
    if ((f.kind === 'extrude' || f.kind === 'revolve') && f.sketchId === id) return rekeyed(f, regions, () => (before ??= old ? findRegions(old.sketch) : []))
    return f
  })
}

/** A feature's picks written over with the keys of the regions they name
 *  now. A pick kept as it was given — every region, the largest, points
 *  inside them (RegionPick) — is taken again as given, while it stands.
 *  Otherwise each key is matched (matchRegion); one whose pieces were all
 *  remade is found by place, the region now covering half of it or more
 *  (regionByPlace), and its row says so (regionsByPlace). A picked region
 *  the edit cut in two is picked in both parts — the feature makes what it
 *  made — and a pick that names nothing now, or a region another pick
 *  names, is kept as it was: the build names it lost on the feature's row
 *  rather than the profile leaving quietly. */
function rekeyed<T extends { regions: string[]; regionPick?: RegionPick; regionsByPlace?: string[] }>(f: T, regions: readonly Region[], before: () => readonly Region[]): T {
  const pick = f.regionPick && sameKeys(f.regionPick.keys, f.regions) ? f.regionPick : null
  const asked = pick ? regionsByPick(pick.given, regions) : null
  if (pick && asked) {
    const keys = asked.map((r) => r.key)
    if (sameKeys(keys, f.regions) && f.regionsByPlace === undefined && keys.every((k, i) => k === f.regions[i])) return f
    const { regionsByPlace: _byPlace, ...rest } = f
    void _byPlace
    return { ...rest, regions: keys, regionPick: { given: pick.given, keys } } as T
  }
  const taken = new Set<Region>()
  const byPlace: string[] = []
  const out = f.regions.map((key) => {
    let r = matchRegion(key, regions)
    if (!r) {
      const was = before().find((x) => x.key === key)
      r = was ? regionByPlace(was, regions, taken) : null
      if (r) byPlace.push(r.key)
    }
    if (!r || taken.has(r)) return key
    taken.add(r)
    return r.key
  })
  if (taken.size === 0) return f
  for (const key of f.regions) {
    const was = before().find((r) => r.key === key)
    if (!was) continue
    for (const part of splitParts(was, regions)) {
      if (taken.has(part)) continue
      taken.add(part)
      out.push(part.key)
    }
  }
  // Found by place before and still picked: still said.
  const placed = [...new Set([...(f.regionsByPlace ?? []).filter((k) => out.includes(k)), ...byPlace])]
  const same = out.length === f.regions.length && out.every((k, i) => k === f.regions[i])
  if (same && placed.length === (f.regionsByPlace?.length ?? 0)) return f
  const { regionsByPlace: _was, ...rest } = f
  void _was
  return { ...rest, regions: out, ...(placed.length > 0 ? { regionsByPlace: placed } : {}) } as T
}

/** Whether two lists of region keys hold the same keys. */
const sameKeys = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((k) => b.includes(k))

/** Every feature with its expressions evaluated against the parameters:
 *  the numbers written, the sketches with a changed dimension solved
 *  again and the features on them re-keyed. A feature that comes out the
 *  same is the same object, so a list where nothing moved is the same
 *  list. `errors` is by feature id. */
export function applyParameters(features: readonly Feature[], scope: Scope): { features: Feature[]; changed: boolean; errors: Map<number, ExprErrors> } {
  const errors = new Map<number, ExprErrors>()
  let out: Feature[] = [...features]
  let changed = false
  for (let i = 0; i < out.length; i++) {
    const f = out[i]
    if (f.kind === 'sketch') {
      // The plane's offset first: the dimensions are solved in the frame
      // it leaves.
      const placed = f.exprs ? applySlots(f, scope) : { next: f, errors: {} as ExprErrors }
      // A profile moved in from another sketch, by a wall that came to
      // another number: moved in again from that sketch as it stands now.
      let movedIn: Sketch | null = null
      if (placed.next.inset && f.inset && placed.next.inset.by !== f.inset.by) {
        const again = insetAgain(placed.next, out)
        if (typeof again === 'string') placed.errors = { ...placed.errors, inset: again }
        else movedIn = again
        placed.next = typeof again === 'string' ? { ...placed.next, inset: f.inset } : { ...placed.next, sketch: again }
      }
      if (placed.next !== f) {
        out[i] = placed.next
        changed = true
      }
      // The features on it keep their profiles, as a dimension's change
      // leaves them.
      if (movedIn) out = replaceSketch(out, f.id, movedIn)
      const g = placed.next
      const r = applySketchExpressions(g.sketch, g.frame, scope)
      const wrong = { ...placed.errors, ...r.errors }
      if (Object.keys(wrong).length > 0) errors.set(f.id, wrong)
      if (r.next !== g.sketch) {
        out = replaceSketch(out, f.id, r.next)
        changed = true
      }
    } else {
      const r = applySlots(f, scope)
      if (Object.keys(r.errors).length > 0) errors.set(f.id, r.errors)
      if (r.next !== f) {
        out[i] = r.next
        changed = true
      }
    }
  }
  return { features: changed ? out : [...features], changed, errors }
}

/** A sketch's profile moved in again from the sketch it was moved in from,
 *  by its inset's wall, and solved — or why not. */
function insetAgain(f: SketchFeature, features: readonly Feature[]): Sketch | string {
  const inset = f.inset!
  const of = features.find((x): x is SketchFeature => x.id === inset.of && x.kind === 'sketch')
  if (!of) return `the sketch it was moved in from (${inset.of}) is gone`
  const datums = datumTraces(f.frame)
  const moved = insetChains(of.sketch, { by: inset.by, keep: () => new Set(inset.keep), datums, name: of.name })
  if (typeof moved === 'string') return moved
  try {
    solveSketch(moved.sketch, { datums })
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
  return moved.sketch
}

/** The expressions of a feature that do not evaluate now, by slot — for
 *  its row to say so. */
export function featureExpressionErrors(f: Feature, scope: Scope): ExprErrors {
  if (f.kind === 'sketch') {
    const errors: ExprErrors = {}
    for (const [path, expr] of Object.entries(f.exprs ?? {})) {
      const r = evaluateFor(expr, 'length', scope)
      if (!r.ok) errors[path] = r.error
    }
    for (const c of f.sketch.constraints) {
      if (!isDimension(c) || !c.expr) continue
      const r = evaluateFor(c.expr, dimensionKind(c.kind), scope)
      if (!r.ok) errors[`dim:${c.id}`] = r.error
    }
    return errors
  }
  const errors: ExprErrors = {}
  for (const [path, expr] of Object.entries((f as { exprs?: ExprMap }).exprs ?? {})) {
    const slot = slotAt(f, path)
    if (!slot) continue
    const r = evaluateFor(expr, slot.kind, scope)
    if (!r.ok) errors[path] = r.error
  }
  return errors
}

// ---- who reads a parameter -------------------------------------------------------------

export interface ParameterUser {
  kind: 'parameter' | 'feature'
  id: number
  name: string
}

/** Whether a feature's expressions — its slots', or its sketch's
 *  dimensions' — read the name. */
export function featureReads(f: { kind?: string; exprs?: ExprMap; sketch?: Sketch }, name: string): boolean {
  if (f.exprs && Object.values(f.exprs).some((e) => references(e).includes(name))) return true
  if (f.sketch) return f.sketch.constraints.some((c) => isDimension(c) && !!c.expr && references(c.expr).includes(name))
  return false
}

/** Everything that reads a parameter by name: the parameters whose
 *  expressions use it, and the features — a feature's slots, a sketch's
 *  dimensions. */
export function usersOf(name: string, parameters: readonly Parameter[], features: readonly Feature[]): ParameterUser[] {
  const out: ParameterUser[] = []
  for (const p of parameters) if (p.name !== name && references(p.expression).includes(name)) out.push({ kind: 'parameter', id: p.id, name: p.name })
  for (const f of features) if (featureReads(f, name)) out.push({ kind: 'feature', id: f.id, name: f.name })
  return out
}

/** Where a feature reads a parameter: its slots by their paths ("extent.to"),
 *  a sketch's dimensions as "dimension 14". */
export function fieldsReading(f: { kind?: string; exprs?: ExprMap; sketch?: Sketch }, name: string): string[] {
  const slots = Object.entries(f.exprs ?? {}).filter(([, e]) => references(e).includes(name)).map(([path]) => path)
  const dims = (f.sketch?.constraints ?? []).filter((c) => isDimension(c) && !!c.expr && references(c.expr).includes(name)).map((c) => `dimension ${c.id}`)
  return [...slots, ...dims]
}

/** The parameters that drive nothing: no feature reads them, nor reads a
 *  parameter that does. One only another idle parameter reads is idle too:
 *  changing it moves no face. */
export function idleParameters(parameters: readonly Parameter[], features: readonly Feature[]): Parameter[] {
  const driving = new Set(parameters.filter((p) => features.some((f) => featureReads(f, p.name))).map((p) => p.name))
  for (let grew = true; grew; ) {
    grew = false
    for (const p of parameters) {
      if (!driving.has(p.name)) continue
      for (const name of references(p.expression)) {
        if (driving.has(name) || !parameters.some((q) => q.name === name)) continue
        driving.add(name)
        grew = true
      }
    }
  }
  return parameters.filter((p) => !driving.has(p.name))
}

/** A feature or a draft with a parameter renamed in every expression it
 *  keeps — the same object back when it reads no such name. */
export function renameInFeature<T extends { kind?: string; exprs?: ExprMap; sketch?: Sketch }>(f: T, from: string, to: string): T {
  if (!featureReads(f, from)) return f
  let next = f
  if (f.exprs) next = { ...next, exprs: Object.fromEntries(Object.entries(f.exprs).map(([k, e]) => [k, renameIn(e, from, to)])) }
  if (f.sketch) next = { ...next, sketch: renameInSketch(f.sketch, from, to) }
  return next
}

export function renameInSketch(sketch: Sketch, from: string, to: string): Sketch {
  if (!sketch.constraints.some((c) => isDimension(c) && !!c.expr && references(c.expr).includes(from))) return sketch
  return { ...sketch, constraints: sketch.constraints.map((c) => (isDimension(c) && c.expr ? { ...c, expr: renameIn(c.expr, from, to) } : c)) }
}

/** The parameters with one of them renamed, in its row and in every
 *  expression that reads it. */
export function renameInParameters(parameters: readonly Parameter[], id: number, to: string): Parameter[] {
  const from = parameters.find((p) => p.id === id)?.name
  if (from === undefined || from === to) return [...parameters]
  return parameters.map((p) => (p.id === id ? { ...p, name: to } : references(p.expression).includes(from) ? { ...p, expression: renameIn(p.expression, from, to) } : p))
}

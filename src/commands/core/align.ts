// SPDX-License-Identifier: AGPL-3.0-only
// The part's coordinate system: a 3-2-1 datum alignment, the pose the scan
// suggests for itself, that pose settled on the mirror plane, and the way
// back. Each is set up in the panel's alignment box and confirmed, as a
// person does it — the elements, dimensions and sections move with the part.

import { ALIGN_PICK_COUNT, axisIndex, fitFromAlignPicks, parallelFaceNear, type AxisDir } from '../../core/alignment'
import type { AutoAlignLevel, AutoAlignTilts } from '../../core/autoAlign'
import { rigidApply, type Rigid } from '../../core/deviation/rigid'
import { orthoBasis } from '../../core/fit/linalg'
import { roundTo } from '../../core/round'
import type { Vec3 } from '../../core/types'
import { normalize } from '../../core/vec'
import { alignCenterOf, alignmentPreview, useStore, type AlignSlot } from '../../state/store'
import { commandHost } from '../host'
import { elementRefSchema, measuredElement, requireScan, type ElementRef } from '../refs'
import { arr, bool, enumOf, obj, oneOf, vec3, type JsonSchema } from '../schema'
import { describeElement, rigidJson } from '../state'
import { CommandError, type Command } from '../types'
import { lastError, requireMeasureFree, showWorkspace } from './common'

const AXES: readonly AxisDir[] = ['x+', 'x-', 'y+', 'y-', 'z+', 'z-']

type Slot =
  | { element: ElementRef }
  | { points: Vec3[] }
  | { point: Vec3 }
  | { plane: { origin: Vec3; normal: Vec3 } }

const slotSchema = (what: string, count: number, points: string): JsonSchema =>
  oneOf(
    [
      obj({ element: elementRefSchema(`An element for ${what}.`) }, ['element']),
      count === 1
        ? obj({ point: vec3(`A point for ${what}, mm.`) }, ['point'])
        : obj({ points: arr(vec3('A point, mm.'), `${count} points, mm — ${points}.`, { minItems: count, maxItems: count }) }, ['points']),
    ],
    `${what[0].toUpperCase()}${what.slice(1)}: an element, or ${count === 1 ? 'a point' : `${count} points`} on the scan.`,
  )

/** The primary's slot: as any other, or a plane given by a point and its
 *  outward normal — a level's plane from scan.heightmap { levels }. */
const primarySchema: JsonSchema = oneOf(
  [
    obj({ element: elementRefSchema('An element for levelling.') }, ['element']),
    obj({ points: arr(vec3('A point, mm.'), '3 points, mm — they span the face.', { minItems: 3, maxItems: 3 }) }, ['points']),
    obj(
      { plane: obj({ origin: vec3('A point on the plane, mm; it lands on 0 along primaryAxis.'), normal: vec3('Its outward normal: out of the face, away from the material.') }, ['origin', 'normal'], 'A plane as given — a level’s plane from scan.heightmap { levels: true }.') },
      ['plane'],
    ),
  ],
  'Levelling: an element, 3 points on the scan, or a plane { origin, normal }.',
)

/** The outward normal at a point on the scan, from the vertex nearest it. */
async function normalAt(p: Vec3): Promise<Vec3> {
  const spot = await commandHost().session.clientRef.current!.nearest({ point: p })
  return spot.normal
}

/** Fill a slot of the open alignment box, by element or by points. */
async function fillSlot(slot: AlignSlot, value: Slot) {
  if ('element' in value) {
    useStore.getState().setAlignmentRef(slot, measuredElement(value.element).id)
    return
  }
  if ('plane' in value) {
    // Three points round the origin on the plane, each with the normal
    // given — the plane they span is the one given, its centre the origin,
    // facing the way it was told to.
    const n = normalize(value.plane.normal)
    if (!n) throw new CommandError('invalid_input', 'plane.normal: give a direction, not a zero vector.')
    const [u, v] = orthoBasis(n)
    const r = Math.max(1, useStore.getState().modelSize / 4)
    const o = value.plane.origin
    useStore.getState().beginAlignmentPick(slot)
    for (let i = 0; i < 3; i++) {
      const a = (2 * Math.PI * i) / 3
      const p = [0, 1, 2].map((j) => o[j] + r * (Math.cos(a) * u[j] + Math.sin(a) * v[j])) as Vec3
      useStore.getState().addAlignmentPick(p, n)
    }
    return
  }
  const points = 'points' in value ? value.points : [value.point]
  if (points.length !== ALIGN_PICK_COUNT[slot]) {
    throw new CommandError('invalid_input', `The ${slot} slot takes ${ALIGN_PICK_COUNT[slot]} point${ALIGN_PICK_COUNT[slot] === 1 ? '' : 's'}.`)
  }
  useStore.getState().beginAlignmentPick(slot)
  for (const p of points) useStore.getState().addAlignmentPick(p, slot === 'primary' ? await normalAt(p) : [0, 0, 1])
}

/** Confirm the pose the box holds — the Confirm alignment button. With
 *  `keepFree`, a first alignment leaves the coordinates no datum sets where
 *  they are instead of centring the part on them. */
async function applyOpenBox(keepFree = false): Promise<Rigid> {
  const s = useStore.getState()
  const ad = s.alignDraft
  if (!ad) throw new CommandError('internal', 'The alignment box is not open.')
  const { preview, error } = alignmentPreview(ad, s.elements, s.modelSize, keepFree ? null : alignCenterOf(s))
  if (!preview) throw new CommandError('invalid_input', error ?? 'The alignment needs a levelling face or a zero point.')
  if (!(await commandHost().session.alignment.applyAlignment(preview.rigid))) {
    throw new CommandError('failed', lastError('The alignment could not be applied.'))
  }
  return preview.rigid
}

const closeBox = () => {
  if (useStore.getState().alignDraft) useStore.getState().cancelAlignment()
}

type Detail = 'brief' | 'full'

const detailIn = enumOf(['brief', 'full'], 'brief (the default): the transform and how many elements moved. full: every element where it now is.')

/** The elements after an alignment: how many moved with the part — or,
 *  with detail full, each where it now is. */
const elementsOut = (detail: Detail | undefined) => {
  const elements = useStore.getState().elements
  return detail === 'full' ? elements.map(describeElement) : elements.length
}

/** What an alignment leaves: the step applied, the whole alignment the part
 *  now carries when that is more than the step, and the elements. */
const applied = (step: Rigid, detail: Detail | undefined, extra: Record<string, unknown> = {}) => {
  const now = rigidJson(useStore.getState().appliedAlignment)
  const out = rigidJson(step)
  return {
    applied: out,
    ...(detail === 'full' || JSON.stringify(now) !== JSON.stringify(out) ? { appliedAlignment: now } : {}),
    ...extra,
    elements: elementsOut(detail),
  }
}

/** Which coordinates the origin sets: those the datums leave open — a plane
 *  owns the one along its normal, an axis or a line the two across it (as
 *  core/alignment zeroes them). */
function originCoords(input: { primary?: Slot; primaryAxis?: AxisDir; secondary?: Slot; secondaryAxis?: AxisDir }): number[] {
  const owned = new Set<number>()
  const own = (slot: Slot | undefined, axis: AxisDir, pickedPlane: boolean) => {
    if (!slot) return
    const kind = 'element' in slot ? measuredElement(slot.element).kind : pickedPlane ? 'plane' : 'line'
    const k = axisIndex(axis)
    for (const i of kind === 'plane' ? [k] : [0, 1, 2].filter((i) => i !== k)) owned.add(i)
  }
  own(input.primary, input.primaryAxis ?? 'z-', true)
  own(input.secondary, input.secondaryAxis ?? 'x+', false)
  return [0, 1, 2].filter((i) => !owned.has(i))
}

/** Where the origin's point stands before the alignment: an element's
 *  centre, or the point given. */
function originPoint(origin: Slot): Vec3 | null {
  if ('point' in origin) return origin.point
  if ('points' in origin) return origin.points[0] ?? null
  if ('plane' in origin) return origin.plane.origin
  const fit = measuredElement(origin.element).fit as { center?: Vec3 } | null
  return fit?.center ?? null
}

/** What the origin did: the coordinates it set and where its point now
 *  stands, with a note when the datums kept it off zero. */
function originReport(input: Parameters<typeof originCoords>[0] & { origin?: Slot }, before: Vec3 | null, step: Rigid) {
  if (!input.origin) return {}
  const set = originCoords(input)
  const names = set.map((i) => 'xyz'[i])
  if (!before) return { origin: { set: names } }
  const out = new Float64Array(3)
  rigidApply(step, before[0], before[1], before[2], out)
  const at = Array.from(out, (v) => roundTo(v, 4))
  const off = [0, 1, 2].filter((i) => !set.includes(i) && Math.abs(out[i]) > 1e-3)
  return {
    origin: {
      set: names,
      at,
      ...(off.length
        ? { note: `The datums own ${off.map((i) => 'xyz'[i]).join(' and ')}: the origin point stands at ${off.map((i) => `${'xyz'[i]} ${at[i]}`).join(', ')}. To put it at 0, 0, 0, call align.datum again with origin alone (the same place) — that moves the datums off zero along those axes.` }
        : {}),
    },
  }
}

/** The coordinates a first alignment centres the part on: those neither
 *  the datums nor an origin set. None once the part has been aligned or
 *  moved, or when told to keep them. */
function centredCoords(input: Parameters<typeof originCoords>[0] & { origin?: Slot; keepFree?: boolean }): string[] {
  if (input.keepFree || !input.primary || input.origin || !alignCenterOf(useStore.getState())) return []
  return originCoords(input).map((i) => 'xyz'[i])
}

/** At most this many scan points facing the levelling plane's way are read
 *  to look for a face parallel to it, and how far their normals may lean. */
const PARALLEL_SAMPLE = 20_000
const PARALLEL_WITHIN_DEG = 5

/** A note when the levelling plane has a parallel face a few millimetres off
 *  it that holds more of the scan — the plane may be a pad's floor or a
 *  step, not the face the part stands on. Read before the part moves, off
 *  the plane the box holds. */
async function parallelFace(): Promise<Record<string, unknown>> {
  const s = useStore.getState()
  const ad = s.alignDraft
  const client = commandHost().session.clientRef.current
  if (!ad || !client) return {}
  const fit =
    ad.primary !== null
      ? (s.elements.find((e) => e.id === ad.primary)?.fit ?? null)
      : fitFromAlignPicks('primary', ad.primaryPicks, s.modelSize, ad.primaryPickNormals)
  if (fit?.kind !== 'plane') return {}
  const inf = Infinity
  const cosLimit = Math.cos((PARALLEL_WITHIN_DEG * Math.PI) / 180)
  const { positions } = await client.query({ min: [-inf, -inf, -inf], max: [inf, inf, inf], normal: { dir: fit.normal, cosLimit }, limit: PARALLEL_SAMPLE })
  const found = parallelFaceNear(positions, fit.center, fit.normal)
  if (!found) return {}
  const offset = roundTo(found.offset, 2)
  const times = roundTo(found.times, 1)
  return {
    parallelFace: {
      offset,
      times,
      note: `A face parallel to the levelling plane, ${Math.abs(offset)} mm ${offset < 0 ? 'behind it' : 'out from it'} along its outward normal, has about ${times}× its area on the scan. If the part stands on that face — or the plane sits on bead crowns or a warp's high spots — level on it instead: scan.heightmap { levels: true } gives each level's plane for primary: { plane }.`,
    },
  }
}

const datum: Command<{
  primary?: Slot
  primaryAxis?: AxisDir
  secondary?: Slot
  secondaryAxis?: AxisDir
  origin?: Slot
  keepFree?: boolean
  detail?: Detail
}> = {
  name: 'datum',
  title: 'Align the part to datums',
  description:
    'A 3-2-1 alignment, as the panel’s alignment box sets it up: primary levels the part — a plane (or 3 points, or plane { origin, normal }: a level’s plane from scan.heightmap { levels: true }) whose outward normal becomes primaryAxis (default z-); secondary turns it — a line or axis (or 2 points) laid along secondaryAxis (default x+), or a plane; origin is the zero point — a point, sphere or circle (or 1 point). Elements by id or name, or points in mm used as given, not snapped. Trap: a plane as secondary puts its outward NORMAL on secondaryAxis, not its face along it. Each datum zeroes the coordinates it owns, the origin only those left open; an origin alone moves without turning. On a first alignment the coordinates nothing sets are centred on the scan’s box (keepFree: true leaves them). Returns the transform applied, how many elements moved, centred, origin { set, at, note } and parallelFace when a face parallel to the levelling plane, 0.3 to 5 mm off it (further on a noisy scan), holds more of the scan. Trap: on an embossed or warped sheet a plane fitted to the outermost faces lies on the bead crowns or the high spots, not the sheet — level on the largest level’s plane instead. One undo step.',
  input: obj({
    primary: primarySchema,
    primaryAxis: enumOf(AXES, 'The axis the primary’s outward normal becomes; default z-.'),
    secondary: slotSchema('rotation', 2, 'they run along the edge'),
    secondaryAxis: enumOf(AXES, 'The axis the secondary runs along (a plane: its normal); default x+.'),
    origin: slotSchema('the zero point', 1, ''),
    keepFree: bool('First alignment: leave the coordinates nothing sets where they are instead of centring.'),
    detail: detailIn,
  }),
  label: () => 'datum alignment',
  run: async (input) => {
    requireScan()
    requireMeasureFree()
    if (!input.primary && !input.origin) throw new CommandError('invalid_input', 'Give a primary (levelling) datum, an origin, or both.')
    showWorkspace('elements')
    try {
      useStore.getState().startAlignment()
      if (input.primary) await fillSlot('primary', input.primary)
      if (input.primaryAxis) useStore.getState().setAlignmentAxis('primary', input.primaryAxis)
      if (input.secondary) await fillSlot('secondary', input.secondary)
      if (input.secondaryAxis) useStore.getState().setAlignmentAxis('secondary', input.secondaryAxis)
      if (input.origin) await fillSlot('origin', input.origin)
      const before = input.origin ? originPoint(input.origin) : null
      const centred = centredCoords(input)
      const parallel = await parallelFace()
      const step = await applyOpenBox(input.keepFree)
      return applied(step, input.detail, { ...(centred.length ? { centred } : {}), ...originReport(input, before, step), ...parallel })
    } finally {
      closeBox()
    }
  },
}

/** How square the pose came out, as the answer gives it: degrees to three
 *  places, areas in whole mm², middles to a tenth. */
const squareOut = (t: AutoAlignTilts) => ({
  largest: t.largest && { axis: t.largest.axis, area: Math.round(t.largest.area), tiltDeg: roundTo(t.largest.tiltDeg, 3) },
  axes: t.axes.map((a) => ({
    axis: a.axis,
    tiltDeg: roundTo(a.tiltDeg, 3),
    area: Math.round(a.area),
    faces: a.faces.map((f) => ({ area: Math.round(f.area), tiltDeg: roundTo(f.tiltDeg, 3), center: f.center.map((v) => roundTo(v, 1)) })),
  })),
})

const auto: Command<{ level?: AutoAlignLevel; detail?: Detail }> = {
  name: 'auto',
  title: 'Auto-align the part',
  description:
    'Read a coordinate system off the scan and apply it, as Auto-align then Confirm alignment do: the directions most faces are square to and the axis round walls run along, the part standing on its base, its long side along X. level: settled (the default) lays all the faces on the axes at once, by area; largest squares the largest flat face exactly and settles the rest about its normal. Returns what the pose was read from, the transform, how many elements moved, and square — how square it came out: largest (the largest flat face’s axis, area, tiltDeg) and per axis the faces square to it with their tilts. Trap: a drafted wall reads as its draft, not as an alignment error. One undo step.',
  input: obj({
    level: enumOf(['settled', 'largest'], 'settled (the default): all faces at once, by area. largest: the largest flat face exactly, the rest settled about its normal.'),
    detail: detailIn,
  }),
  label: () => 'auto-align',
  run: async ({ level, detail }) => {
    requireScan()
    requireMeasureFree()
    showWorkspace('elements')
    try {
      const tilts = await commandHost().session.alignment.proposeAutoAlign({ level })
      if (!tilts) {
        throw new CommandError('failed', lastError('Auto-align found no pose.'))
      }
      const note = useStore.getState().alignDraft?.proposal
      return applied(await applyOpenBox(), detail, { note, square: squareOut(tilts) })
    } finally {
      closeBox()
    }
  },
}

const symmetry: Command<{ detail?: Detail }> = {
  name: 'symmetry',
  title: 'Align the part on its symmetry plane',
  description:
    'Settle the part’s pose on its mirror plane and apply it, as Use symmetry then Confirm alignment do: the pose is Auto-align’s, the mirror plane a measured symmetry plane or one searched for on the scan; the axis nearest its normal is turned onto it and the zero point put on it. Refuses when the scan has no symmetry plane. Returns the note on what it settled on, the transform and how many elements moved. One undo step.',
  input: obj({ detail: detailIn }),
  label: () => 'symmetry alignment',
  run: async ({ detail }) => {
    requireScan()
    requireMeasureFree()
    showWorkspace('elements')
    try {
      if (!(await commandHost().session.alignment.proposeSymmetry())) {
        throw new CommandError('failed', lastError('No symmetry plane was found.'))
      }
      const note = useStore.getState().alignDraft?.proposal
      return applied(await applyOpenBox(), detail, { note })
    } finally {
      closeBox()
    }
  },
}

const clear: Command<{ detail?: Detail }> = {
  name: 'clear',
  title: 'Reset the alignment',
  description: 'Put the part back in the coordinates the scanner delivered it in, with everything measured on it. Returns how many elements moved with it. One undo step.',
  input: obj({ detail: detailIn }),
  label: () => 'reset alignment',
  run: async ({ detail }) => {
    requireScan()
    requireMeasureFree()
    const total = useStore.getState().appliedAlignment
    if (!total) throw new CommandError('invalid_state', 'The part is in scan coordinates already.')
    showWorkspace('elements')
    if (!(await commandHost().session.alignment.resetAlignment())) {
      throw new CommandError('failed', lastError('The alignment could not be reset.'))
    }
    return { appliedAlignment: null, elements: elementsOut(detail) }
  },
}

export const alignCommands = [datum, auto, symmetry, clear]

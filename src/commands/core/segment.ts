// SPDX-License-Identifier: AGPL-3.0-only
// The scan's flat faces found all at once: scan.segment grows planar regions
// over it in the mesh worker (core/fit/segment) and answers each region's
// plane, σ, area, box and neighbours — no vertex lists, which cost more to
// read than they say. A round surface comes out as strips that read as
// facets: each strip says it is curved, each edge whether it is smooth, and
// the runs of strips that are one surface are answered with what that
// surface is. One region's points, or several regions' together, can be
// left marked for element.fit_marked instead; the answer is then the marked
// region, not the list again. Mirror twins are paired across a plane given.

import { worldAxisDir } from '../../core/section/frame'
import { SMOOTH_DEG, type CurvedRun, type Segmentation, type SegmentedPlane } from '../../core/fit/segment'
import { roundTo } from '../../core/round'
import type { Vec3 } from '../../core/types'
import { useStore } from '../../state/store'
import { commandHost } from '../host'
import { setMarked } from '../marked'
import { elementRefSchema, measuredElement, parsePlaneName, requireScan, type ElementRef } from '../refs'
import { arr, bool, enumOf, int, num, obj, oneOf, vec3 } from '../schema'
import { CommandError, type Command } from '../types'

/** Unless told otherwise: the angle a vertex normal may lean off its
 *  region's plane, degrees; the RMS a region may have off it, mm; how many
 *  regions are listed. The smallest region kept is a square 2 % of the
 *  scan's diagonal on a side. */
const SEGMENT_DEG = 15
const SEGMENT_RMS = 0.05
const SEGMENT_LIMIT = 20
const SEGMENT_LIMIT_MAX = 200
const MIN_SIDE_SHARE = 0.02
/** Mirror twins: their planes within this many degrees once one is
 *  mirrored, their centroids within half the larger one's side (as the
 *  square root of its area) and a millimetre, and neither more than twice
 *  the other's area. */
const MIRROR_DEG = 3
const MIRROR_AREA_RATIO = 2

interface SegmentIn {
  kind?: 'plane'
  box?: { min: Vec3; max: Vec3 }
  minArea?: number
  maxRms?: number
  maxDeg?: number
  limit?: number
  symmetric?: ElementRef
  mark?: number | number[]
  list?: boolean
}

/** The last segmentation, kept for a follow-up `mark` with the same
 *  options on the scan as it stood. */
let last: { key: string; result: Segmentation } | null = null

/** What the result depends on: the options, the scan, and where the
 *  alignment has put it. */
function cacheKey(options: object): string {
  const s = useStore.getState()
  const version = commandHost().session.clientRef.current?.scanVersion ?? -1
  return JSON.stringify({ options, version, pose: s.appliedAlignment })
}

const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** The plane mirror twins are paired across: a plane element, or a
 *  coordinate plane through the origin. */
function mirrorPlane(ref: ElementRef): { point: Vec3; normal: Vec3 } {
  const world = typeof ref === 'string' ? parsePlaneName(ref) : null
  if (world) return { point: [0, 0, 0], normal: worldAxisDir(world) }
  const fit = measuredElement(ref, ['plane']).fit
  if (fit?.kind !== 'plane') throw new CommandError('invalid_input', 'symmetric takes a plane.')
  return { point: fit.center, normal: fit.normal }
}

/** Each region's mirror twin across the plane: the region its mirror image
 *  matches best, when the match goes both ways — the region itself when it
 *  straddles the plane. */
function pairMirrors(regions: SegmentedPlane[], plane: { point: Vec3; normal: Vec3 }) {
  const m = plane.normal
  const ml = Math.hypot(m[0], m[1], m[2])
  const u: Vec3 = [m[0] / ml, m[1] / ml, m[2] / ml]
  const mirrored = regions.map((r) => {
    const dn = 2 * dot(r.normal, u)
    const dc = 2 * (dot(r.point, u) - dot(plane.point, u))
    return {
      normal: [r.normal[0] - dn * u[0], r.normal[1] - dn * u[1], r.normal[2] - dn * u[2]] as Vec3,
      point: [r.point[0] - dc * u[0], r.point[1] - dc * u[1], r.point[2] - dc * u[2]] as Vec3,
    }
  })
  const cosMax = Math.cos((MIRROR_DEG * Math.PI) / 180)
  const best = regions.map((a, i) => {
    let pick = -1
    let score = Infinity
    regions.forEach((b, k) => {
      if (Math.max(a.area, b.area) > MIRROR_AREA_RATIO * Math.min(a.area, b.area)) return
      if (dot(mirrored[i].normal, b.normal) < cosMax) return
      const p = mirrored[i].point
      const d = Math.hypot(p[0] - b.point[0], p[1] - b.point[1], p[2] - b.point[2])
      if (d > 0.5 * Math.sqrt(Math.max(a.area, b.area)) + 1) return
      if (d < score) {
        score = d
        pick = k
      }
    })
    return pick
  })
  return regions.map((b, i) => {
    const k = best[i]
    if (k < 0 || best[k] !== i) return null
    const mp = mirrored[k]
    return {
      id: k === i ? ('self' as const) : k + 1,
      deg: roundTo((Math.acos(Math.min(1, dot(mp.normal, b.normal))) * 180) / Math.PI, 2),
      // How far this region's plane lies from its twin's mirrored, at its
      // own centroid.
      mm: roundTo(Math.abs(dot([b.point[0] - mp.point[0], b.point[1] - mp.point[1], b.point[2] - mp.point[2]], b.normal)), 3),
    }
  })
}

/** A curved run as answered: its regions, area, what it holds as, and a
 *  note saying what to model it as. */
function runRow(r: CurvedRun, i: number, maxRms: number) {
  const v = (p: readonly number[], places: number) => p.map((x) => roundTo(x, places))
  const range = (a: number, b: number, places: number, unit = '') => {
    const lo = roundTo(a, places), hi = roundTo(b, places)
    return lo === hi ? `${lo}${unit}` : `${lo}–${hi}${unit}`
  }
  const cylinder = r.cylinder ? { radius: roundTo(r.cylinder.radius, 2), axis: v(r.cylinder.axis, 3), sigma: roundTo(r.cylinder.sigma, 3) } : null
  const one = `one curved surface cut into ${r.regions.length} strips — smooth joins ${range(r.joins[0], r.joins[1], 0, '°')}, planes’ σ ${range(r.planeSigma[0], r.planeSigma[1], 3)} against maxRms ${maxRms}`
  let note: string
  if (r.kind === 'cylinder' && cylinder)
    note = `${one}; one cylinder R${roundTo(cylinder.radius, 1)} σ ${cylinder.sigma}: mark its regions and fit a cylinder (element.fit_marked)`
  else if (r.along)
    note = `${one}; normals square to along within ${roundTo(r.along.leanDeg, 1)}°: an extruded profile — section square to along and extrude it${cylinder ? `; not one arc (a cylinder leaves σ ${cylinder.sigma} at R${roundTo(cylinder.radius, 1)})` : ''}`
  else note = `${one}; no one direction or cylinder: freeform — section across and sweep or loft`
  return {
    id: i + 1,
    regions: r.regions,
    area: roundTo(r.area, 1),
    ...(r.along ? { along: v(r.along.direction, 3) } : {}),
    ...(r.kind === 'cylinder' && cylinder ? { cylinder } : {}),
    note,
  }
}

const segment: Command<SegmentIn> = {
  name: 'segment',
  scanOps: ['segment'],
  title: 'Find the scan’s flat regions',
  description:
    `The scan’s planar regions, found all at once: grown from the flattest places outward within maxDeg (${SEGMENT_DEG}°) and maxRms (${SEGMENT_RMS} mm), those smaller than minArea given back. Returns found, considered, claimed, noise and the regions, largest first, at most limit (${SEGMENT_LIMIT}): id, normal, point (a vertex of the region — the one nearest its centroid, so a fit seeded there lands on it), sigma, area (mm²), box, vertices, neighbours { id, deg, smooth } and, with symmetric, mirror (its twin across that plane). Trap: a round surface comes out as strips that look like facets — such a region says curved { sagitta } and run, and curvedRuns joins them into surfaces with a note saying what to model each as; read the runs before taking regions for faces. mark: a region’s id, or several, leaves their points marked for element.fit_marked { marked: true }. Changes nothing.`,
  input: obj({
    kind: enumOf(['plane'], 'What to find; plane, the default and for now the only one.'),
    box: obj({ min: vec3('Lowest corner, mm.'), max: vec3('Highest corner, mm.') }, ['min', 'max'], 'Only the scan inside this box.'),
    minArea: num('mm²; by default a square 2 % of the scan’s diagonal on a side.', { minimum: 0 }),
    maxRms: num(`mm; ${SEGMENT_RMS} by default.`, { exclusiveMinimum: 0 }),
    maxDeg: num(`Degrees; ${SEGMENT_DEG} by default.`, { exclusiveMinimum: 0, maximum: 60 }),
    limit: int(`How many regions are listed; ${SEGMENT_LIMIT} by default.`, { minimum: 1, maximum: SEGMENT_LIMIT_MAX }),
    symmetric: elementRefSchema('Pair regions mirrored across this plane: a plane element, or "XY", "YZ", "XZ".'),
    mark: oneOf([int('A region’s id.', { minimum: 1 }), arr(int(undefined, { minimum: 1 }), 'Several regions’ ids, their points together.', { minItems: 1 })], 'Leave this region’s points marked, or several regions’.'),
    list: bool('With mark: the list of regions too.'),
  }),
  readOnly: true,
  run: async ({ box, minArea, maxRms = SEGMENT_RMS, maxDeg = SEGMENT_DEG, limit = SEGMENT_LIMIT, symmetric, mark, list }, ctx) => {
    requireScan()
    const client = commandHost().session.clientRef.current
    if (!client) throw new CommandError('unavailable', 'The mesh worker is not running.')
    if (box) for (let k = 0; k < 3; k++) if (!(box.min[k] <= box.max[k])) throw new CommandError('invalid_input', 'The box’s min lies past its max.')
    const mirror = symmetric !== undefined ? mirrorPlane(symmetric) : null
    const diag = 2 * useStore.getState().modelSize
    const options = { ...(box ? { box } : {}), minArea: minArea ?? (MIN_SIDE_SHARE * diag) ** 2, maxRms, maxDeg }
    const key = cacheKey(options)
    let result: Segmentation
    if (last && last.key === key) result = last.result
    else {
      ctx.progress('Growing planar regions over the scan…')
      result = await client.segment(options)
      last = { key, result }
    }
    const { regions } = result
    // Each vertex is in one region, so the regions' points together are
    // their lists one after the other.
    const ids = mark === undefined ? [] : [...new Set(typeof mark === 'number' ? [mark] : mark)]
    let marked: { points: number; from: string } | undefined
    if (ids.length) {
      const missing = ids.filter((id) => id > regions.length)
      if (missing.length) throw new CommandError('invalid_input', `There is no region ${missing.join(', ')} — ${regions.length} were found.`)
      const points = new Uint32Array(ids.reduce((n, id) => n + result.offsets[id] - result.offsets[id - 1], 0))
      let at = 0
      for (const id of ids) {
        const part = result.vertices.subarray(result.offsets[id - 1], result.offsets[id])
        points.set(part, at)
        at += part.length
      }
      marked = setMarked(points, `scan.segment region${ids.length > 1 ? 's' : ''} ${ids.join(', ')}`)
    }
    const shown = Math.min(limit, regions.length)
    const twins = mirror ? pairMirrors(regions, mirror) : null
    const v = (p: readonly number[], places: number) => p.map((x) => roundTo(x, places))
    const row = (i: number) => {
      const r = regions[i]
      return {
        id: i + 1,
        normal: v(r.normal, 5),
        // A point of the region, not its centroid: a boss top's centroid
        // lies in the hole, and a fit seeded there fits the wrong surface.
        point: v(r.on, 4),
        sigma: roundTo(r.sigma, 4),
        area: roundTo(r.area, 1),
        box: { min: v(r.min, 2), max: v(r.max, 2) },
        vertices: r.count,
        ...(r.curved && r.curve ? { curved: { sagitta: roundTo(r.curve.sagitta, 3) } } : {}),
        ...(r.run !== undefined ? { run: r.run + 1 } : {}),
        // Past the regions listed, the neighbours a run could run through.
        neighbours: r.neighbours.filter((n) => n.id <= shown || n.deg <= SMOOTH_DEG).map((n) => ({ id: n.id, deg: roundTo(n.deg, 1), smooth: n.smooth })),
        ...(twins?.[i] ? { mirror: twins[i] } : {}),
      }
    }
    const runsShown = Math.min(limit, result.runs.length)
    // A mark answers the region it marked; the list, which a mark follows
    // and need not repeat, only when asked for.
    const listed = !marked || list === true
    return {
      found: regions.length,
      ...(listed && shown < regions.length ? { shown } : {}),
      considered: result.considered,
      claimed: result.claimed,
      maxRms,
      noise: roundTo(result.noise, 4),
      ...(marked ? { marked, region: ids.length === 1 ? row(ids[0] - 1) : ids.map((id) => row(id - 1)) } : {}),
      ...(listed ? { regions: regions.slice(0, shown).map((_, i) => row(i)) } : {}),
      ...(listed && result.runs.length ? { curvedRuns: result.runs.slice(0, runsShown).map((r, i) => runRow(r, i, maxRms)) } : {}),
      ...(listed && runsShown < result.runs.length ? { runsFound: result.runs.length } : {}),
    }
  },
}

export const segmentCommands = [segment]

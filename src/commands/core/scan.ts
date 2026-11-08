// SPDX-License-Identifier: AGPL-3.0-only
// The scan: opening one, and finding places on it.

import { MESH_UNITS, type MeshUnits } from '../../core/meshUnits'
import type { Vec3 } from '../../core/types'
import { useStore } from '../../state/store'
import { useDeviation } from '../../state/deviationStore'
import { commandHost, sceneOf } from '../host'
import { locationSchema, requireScan, resolveLocation, type Location } from '../refs'
import { arr, bool, bytes, enumOf, int, num, obj, oneOf, str, vec3 } from '../schema'
import { densifyEdgeFor, dominantFacing, type RimCircle, robustPlane } from '../../core/geometry/scanQa'
import { listCommands } from '../registry'
import { SHEET_SHARE } from '../../core/geometry/sheet'
import { orthoBasis } from '../../core/fit/linalg'
import { niceCeil } from '../../core/field/stats'
import { gridOver } from '../../core/geometry/rayGrid'
import { scanBounds } from '../state'
import { CommandError, type Command } from '../types'
import { discardSchema, fileNameSchema, fileOf, lastError, mapSettled, requireDiscardable } from './common'
import { roundTo } from '../../core/round'
import { cellNoise, heightLevels, levelsThroughWarp, rampsOf, reliefGrid, slopedCells, type HeightLevel, type LevelsResult, type Warp } from '../../core/geometry/heightGrid'
import { basePlaneOf } from '../../core/basePlanes'
import { axisLineOf, boxOnSheet, pointOnSheet, RADIAL_AXIS_KINDS, radialFrame, sketchFrameOn, worldAxisDir, type WorldAxis } from '../../core/section/frame'
import { projectCut } from '../../core/section/slice'
import { EDGE_MIN_FEATURE_MM } from '../../core/flat/edges'
import type { PlaneFit } from '../../core/types'
import { usePrefs } from '../../state/prefsStore'
import { elementRefSchema, findElement, planeRef, type ElementRef } from '../refs'
import { setMarked } from '../marked'
import { scale } from './scanScale'

export const unitsSchema = enumOf(
  MESH_UNITS.map((u) => u.id),
  'The file’s units: mm (the default), cm, m or in. Everything is measured in mm once read.',
)

/** The scan as the readout names it. */
export async function scanSummary() {
  const bounds = await scanBounds()
  const s = useStore.getState()
  const units = commandHost().session.sources.current.scan?.units ?? 'mm'
  return {
    fileName: s.fileName,
    units,
    vertices: s.vertexCount,
    triangles: s.triangleCount,
    bounds,
    center: s.modelCenter,
    size: 2 * s.modelSize,
    ...(s.scanScale ? { scaled: roundTo(s.scanScale.factor, 6) } : {}),
  }
}

const open: Command<{ bytes: Uint8Array; name: string; units?: MeshUnits; discard?: boolean }> = {
  name: 'open',
  title: 'Open a scan',
  description:
    'Open a mesh as the scan to measure — STL, PLY, OBJ or 3MF, or a STEP part cut into triangles — in place of the one there is; everything measured on the old one goes with it, so it refuses while the session holds measurements unless discard is true (the refusal names what is held). A reference part opened from a file stays, its alignment and maps gone (referenceKept); one made from the session’s own work goes (referenceDropped). Returns the scan: name, units, vertex and triangle counts, bounding box, centre and diagonal (size), mm. Not undoable: a new scan starts a new history.',
  input: obj(
    {
      bytes: bytes('The file’s contents.'),
      name: fileNameSchema('"ballbar.stl"'),
      units: unitsSchema,
      discard: discardSchema,
    },
    ['bytes', 'name'],
  ),
  history: false,
  discards: ({ discard }) => discard === true,
  run: async ({ bytes: data, name, units, discard }) => {
    requireDiscardable(discard, 'opening another scan')
    const { session } = commandHost()
    const before = session.clientRef.current!.scanVersion
    const reference = useDeviation.getState().nominalName
    await session.scan.openScan(fileOf(data, name), units ?? 'mm')
    if (session.clientRef.current!.scanVersion === before) {
      throw new CommandError('failed', lastError(`${name} could not be opened.`))
    }
    const kept = useDeviation.getState().nominalName
    return {
      scan: await scanSummary(),
      ...(kept ? { referenceKept: kept } : reference ? { referenceDropped: reference } : {}),
    }
  },
}

/** How many vertices a query hands back unless told otherwise, and at most. */
const QUERY_LIMIT = 1000
const QUERY_MAX = 20_000
/** How far round a direction a normal may lie and still face it, degrees,
 *  unless told otherwise. */
const QUERY_WITHIN_DEG = 30

const triples = (a: Float32Array, places: number): [number, number, number][] => {
  const out: [number, number, number][] = []
  for (let i = 0; i + 2 < a.length; i += 3) out.push([roundTo(a[i], places), roundTo(a[i + 1], places), roundTo(a[i + 2], places)])
  return out
}

interface QueryIn {
  box?: { min: Vec3; max: Vec3 }
  near?: { at: Vec3; radius: number }
  normal?: { dir: Vec3; withinDeg?: number }
  limit?: number
  mark?: boolean
  fields?: 'count' | 'ids' | 'all'
}

const query: Command<QueryIn> = {
  name: 'query',
  title: 'Read the scan’s points',
  description:
    'The scan’s vertices inside a box, or within a radius of a point (near), with their outward normals — the points on a face, to measure a dimension or a draft off; normal keeps only those facing a direction. Returns matched, the vertex numbers, points and normals (mm, current frame), the box round them, centroid and mean normal; fields: count, ids or all (the default) says how much. Trap: at most limit come back (1000 by default, 20000 at most), every k-th spread evenly, step saying k — mark: true marks every matching vertex, not the thinned list, for element.fit_marked { marked: true }. Changes nothing on the part.',
  input: obj({
    box: obj({ min: vec3('Lowest corner, mm.'), max: vec3('Highest corner, mm.') }, ['min', 'max'], 'A box in the current frame.'),
    near: obj({ at: vec3('The centre, mm.'), radius: num('mm.', { exclusiveMinimum: 0 }) }, ['at', 'radius'], 'A ball about a point, in place of box.'),
    normal: obj(
      { dir: vec3('A direction, any length.'), withinDeg: num('Degrees; 30 by default.', { exclusiveMinimum: 0, maximum: 180 }) },
      ['dir'],
      'Only the vertices whose outward normal faces this way.',
    ),
    limit: int(`How many vertices at most; ${QUERY_LIMIT} by default, ${QUERY_MAX} at most.`, { minimum: 1, maximum: QUERY_MAX }),
    mark: bool('Leave every matching vertex marked, for element.fit_marked { marked: true }.'),
    fields: enumOf(['count', 'ids', 'all'], 'count: the numbers alone (the default with mark); ids: with the vertices; all: with points and normals (the default).'),
  }),
  readOnly: true,
  run: async ({ box, near, normal, limit = QUERY_LIMIT, mark = false, fields = mark ? 'count' : 'all' }) => {
    requireScan()
    if ((box === undefined) === (near === undefined)) throw new CommandError('invalid_input', 'Give box or near — one of them.')
    const client = commandHost().session.clientRef.current
    if (!client) throw new CommandError('unavailable', 'The mesh worker is not running.')
    const min: Vec3 = box ? box.min : [near!.at[0] - near!.radius, near!.at[1] - near!.radius, near!.at[2] - near!.radius]
    const max: Vec3 = box ? box.max : [near!.at[0] + near!.radius, near!.at[1] + near!.radius, near!.at[2] + near!.radius]
    for (let k = 0; k < 3; k++) if (!(min[k] <= max[k])) throw new CommandError('invalid_input', 'The box’s min lies past its max.')
    const cosLimit = normal ? Math.cos(((normal.withinDeg ?? QUERY_WITHIN_DEG) * Math.PI) / 180) : undefined
    // A ball is asked for as its box and the corners trimmed off here —
    // the limit then counts what is inside the ball.
    const facing = normal && cosLimit !== undefined ? { normal: { dir: normal.dir, cosLimit } } : {}
    const r = await client.query({ min, max, ...facing, limit: near ? Math.min(QUERY_MAX, Math.ceil(limit * 1.91)) : limit })
    /** The indices into a query's answer that lie inside the ball. */
    const inBall = (q: { vertices: Uint32Array; positions: Float32Array }): number[] => {
      const keep: number[] = []
      for (let i = 0; i < q.vertices.length; i++) {
        const d = Math.hypot(q.positions[i * 3] - near!.at[0], q.positions[i * 3 + 1] - near!.at[1], q.positions[i * 3 + 2] - near!.at[2])
        if (d <= near!.radius) keep.push(i)
      }
      return keep
    }
    // Marked, every vertex that matched — the limit thins only what comes
    // back: a fit to the marked points is to the whole face. Read again
    // without a limit when the first answer was thinned.
    let every: Uint32Array | null = null
    if (mark) {
      const all = r.step > 1 ? await client.query({ min, max, ...facing, limit: Math.max(1, useStore.getState().vertexCount) }) : r
      every = near ? Uint32Array.from(inBall(all).map((i) => all.vertices[i])) : all.vertices
    }
    let vertices = Array.from(r.vertices)
    let positions = r.positions
    let normals = r.normals
    let matched = r.matched
    if (near) {
      const keep = inBall(r)
      // What the ball holds — counted when every vertex was read, else
      // scaled up from the share of the box's sample that fell inside it.
      matched = every ? every.length : r.step > 1 ? Math.round((keep.length / Math.max(1, vertices.length)) * r.matched) : keep.length
      const stride = Math.max(1, Math.ceil(keep.length / limit))
      const kept = keep.filter((_, i) => i % stride === 0)
      positions = Float32Array.from(kept.flatMap((i) => [r.positions[i * 3], r.positions[i * 3 + 1], r.positions[i * 3 + 2]]))
      normals = Float32Array.from(kept.flatMap((i) => [r.normals[i * 3], r.normals[i * 3 + 1], r.normals[i * 3 + 2]]))
      vertices = kept.map((i) => vertices[i])
    }
    const n = vertices.length
    const lo: Vec3 = [Infinity, Infinity, Infinity]
    const hi: Vec3 = [-Infinity, -Infinity, -Infinity]
    const centroid: Vec3 = [0, 0, 0]
    const meanNormal: Vec3 = [0, 0, 0]
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) {
        const v = positions[i * 3 + k]
        if (v < lo[k]) lo[k] = v
        if (v > hi[k]) hi[k] = v
        centroid[k] += v / n
        meanNormal[k] += normals[i * 3 + k]
      }
    }
    const nl = Math.hypot(meanNormal[0], meanNormal[1], meanNormal[2])
    const marked = every ? setMarked(every, `scan.query ${box ? 'box' : 'ball'}${normal ? ' facing a way' : ''}`) : undefined
    return {
      matched,
      returned: n,
      step: near ? Math.max(1, Math.round(matched / Math.max(1, n))) : r.step,
      ...(n > 0
        ? {
            bounds: { min: lo.map((v) => roundTo(v, 4)), max: hi.map((v) => roundTo(v, 4)) },
            centroid: centroid.map((v) => roundTo(v, 4)),
            meanNormal: nl > 0 ? meanNormal.map((v) => roundTo(v / nl, 4)) : null,
          }
        : {}),
      ...(marked ? { marked } : {}),
      ...(fields !== 'count' ? { vertices } : {}),
      ...(fields === 'all' ? { points: triples(positions, 4), normals: triples(normals, 3) } : {}),
    }
  },
}

const nearest: Command<{ at: Location }> = {
  name: 'nearest',
  title: 'Find a place on the scan',
  description:
    'Where a place lands on the scan: the vertex (a point snaps to the nearest), its coordinates and outward normal, a triangle it is a corner of, and how far it lies from the point asked about. Use it to check a point lies on the surface before fitting there.',
  input: obj({ at: locationSchema('The place on the scan.') }, ['at']),
  readOnly: true,
  run: async ({ at }) => resolveLocation(at),
}

/** How many scan points a surface is fitted to at most. */
const SURFACE_LIMIT = 20_000

const fitSurface: Command<{ vertices?: number[]; box?: { min: Vec3; max: Vec3 }; normal?: { dir: Vec3; withinDeg?: number }; model?: 'plane' | 'bilinear' | 'quadric' | 'best'; limit?: number }> = {
  name: 'fit_surface',
  title: 'Fit a sloped or curved patch',
  description:
    'A patch of the scan measured as a surface — a sloped side, a twisted ruled face, a dome, a saddle — from vertices or a box (normal keeps those facing a way). Returns the patch’s frame (origin, normal, basisU, basisV) and each model as a height over (u, v): plane (a + b·u + c·v), bilinear (+ d·u·v) and quadric (+ d·u² + e·u·v + f·v², with curvature { k1, k2, r1, r2, axis1, axis2, shape }), each with coefficients, rms and worst; model: best (the default) fits every one and names the simplest whose rms is within a tenth of the lowest. Trap: 7 points at least, at most limit (20000) spread evenly. Changes nothing.',
  input: obj({
    vertices: arr(int(undefined, { minimum: 0 }), 'The scan vertices of the patch.', { minItems: 7 }),
    box: obj({ min: vec3('Lowest corner, mm.'), max: vec3('Highest corner, mm.') }, ['min', 'max'], 'The scan inside a box, in place of vertices.'),
    normal: obj({ dir: vec3('A direction, any length.'), withinDeg: num('Degrees; 30 by default.', { exclusiveMinimum: 0, maximum: 180 }) }, ['dir'], 'With box: only the vertices facing this way.'),
    model: enumOf(['plane', 'bilinear', 'quadric', 'best'], 'Which surface; best (the default) fits each and names the simplest that holds.'),
    limit: int(`How many points at most; ${SURFACE_LIMIT} by default.`, { minimum: 7, maximum: SURFACE_LIMIT }),
  }),
  readOnly: true,
  run: async ({ vertices, box, normal, model = 'best', limit = SURFACE_LIMIT }) => {
    requireScan()
    if ((vertices === undefined) === (box === undefined)) throw new CommandError('invalid_input', 'Give vertices or box — one of them.')
    let points: Float32Array
    if (box) {
      for (let k = 0; k < 3; k++) if (!(box.min[k] <= box.max[k])) throw new CommandError('invalid_input', 'The box’s min lies past its max.')
      const client = commandHost().session.clientRef.current
      if (!client) throw new CommandError('unavailable', 'The mesh worker is not running.')
      const cosLimit = normal ? Math.cos(((normal.withinDeg ?? QUERY_WITHIN_DEG) * Math.PI) / 180) : undefined
      points = (await client.query({ min: box.min, max: box.max, ...(normal && cosLimit !== undefined ? { normal: { dir: normal.dir, cosLimit } } : {}), limit })).positions
    } else {
      // The vertices by number, as the viewport holds them — in the frame
      // the part is measured in now.
      const all = commandHost().session.sceneRef.current?.scanPositions()
      if (!all) throw new CommandError('unavailable', 'Reading vertices by number needs the viewport — give box instead.')
      const count = all.length / 3
      const bad = vertices!.find((v) => v >= count)
      if (bad !== undefined) throw new CommandError('invalid_input', `vertices: ${bad} is past the scan’s ${count} vertices.`)
      const step = Math.max(1, Math.ceil(vertices!.length / limit))
      const picked = vertices!.filter((_, i) => i % step === 0)
      points = new Float32Array(picked.length * 3)
      picked.forEach((v, i) => points.set([all[v * 3], all[v * 3 + 1], all[v * 3 + 2]], i * 3))
    }
    if (points.length / 3 < 7) throw new CommandError('invalid_input', `Only ${points.length / 3} scan points lie there — a surface needs 7 at least.`)
    const { fitSurfaceModels, SURFACE_MODELS } = await import('../../core/fit/heightSurface')
    const models = model === 'best' ? SURFACE_MODELS : [model]
    const r = fitSurfaceModels(points, models)
    if (!r) throw new CommandError('failed', 'The points lie on a line — no surface is fitted through them.')
    const v4 = (v: Vec3) => v.map((x) => roundTo(x, 4))
    return {
      points: points.length / 3,
      frame: { origin: v4(r.frame.origin), basisU: v4(r.frame.basisU), basisV: v4(r.frame.basisV), normal: v4(r.frame.normal) },
      models: Object.fromEntries(
        r.fits.map((f) => [
          f.model,
          {
            coefficients: f.coefficients,
            rms: f.rms,
            worst: f.worst,
            ...(f.curvature ? { curvature: { ...f.curvature, axis1: v4(f.curvature.axis1), axis2: v4(f.curvature.axis2) } } : {}),
          },
        ]),
      ),
      ...(model === 'best' ? { best: r.best } : {}),
    }
  },
}

/** How many scan points the draft is read off at most, spread evenly. */
const DRAFT_LIMIT = 400_000

type DraftSplitIn = ElementRef | { point: Vec3; normal: Vec3 }

/** The plane a draft's patches are kept apart by: a plane element or a
 *  coordinate plane, a point and normal, or "symmetry" — the scan's mirror
 *  plane, as a measured symmetry plane has it or searched for on the scan. */
async function draftSplit(split: DraftSplitIn): Promise<{ point: Vec3; normal: Vec3; from: string; rms?: number }> {
  if (typeof split === 'object') {
    if (!Array.isArray(split.point) || !Array.isArray(split.normal)) throw new CommandError('invalid_input', 'split: give a plane element, "XY", "YZ" or "XZ", "symmetry", or { point, normal }.')
    if (!(Math.hypot(...split.normal) > 0)) throw new CommandError('invalid_input', 'split.normal: give a direction, not a zero vector.')
    return { point: split.point, normal: split.normal, from: 'the plane given' }
  }
  if (typeof split === 'string' && split.trim().toLowerCase() === 'symmetry') {
    const measured = [...useStore.getState().elements].reverse().find((e) => e.fit?.kind === 'plane' && e.source.type === 'constructed' && e.source.method === 'plane-symmetry')
    if (measured?.fit?.kind === 'plane') return { point: measured.fit.center, normal: measured.fit.normal, from: measured.name }
    const client = commandHost().session.clientRef.current
    if (!client) throw new CommandError('unavailable', 'The mesh worker is not running.')
    const r = await client.symmetry(null)
    if (!Number.isFinite(r.rms) || r.sampled === 0 || r.matched / r.sampled < 0.5) {
      throw new CommandError('failed', `The scan has no mirror plane — the best mirror image matched ${r.sampled ? Math.round((100 * r.matched) / r.sampled) : 0} % of the samples. Give split a plane instead.`)
    }
    return { point: r.point, normal: r.normal, from: 'the scan’s mirror plane', rms: r.rms }
  }
  const id = planeRef(split)
  if (id < 0) {
    const base = basePlaneOf(id)!
    return { point: [0, 0, 0], normal: [...base.normal] as Vec3, from: base.name }
  }
  const el = findElement(id)
  const fit = el.fit as PlaneFit
  return { point: fit.center, normal: fit.normal, from: el.name }
}

const draft: Command<{ pull: Vec3; box?: { min: Vec3; max: Vec3 }; nearDeg?: number; patches?: number; minArea?: number; split?: DraftSplitIn }> = {
  name: 'draft',
  title: 'Read the draft against a pull',
  description:
    'The scan’s walls that run near a pull direction — the sides a mould opens along — gathered into patches, each with draftDeg, the angle it leans off the pull: positive where the wall faces partly along the pull, negative where it faces back (a back draft, an undercut); with sigmaDeg, spreadDeg, centroid, box, area (mm²), count, facing, turnDeg and round for a boss’s or hole’s round side. Needs pull; box, nearDeg (10), patches (12), minArea (1 mm²) and split (a plane no patch reaches across: "symmetry", a plane element, "XY", "YZ", "XZ" or { point, normal }) narrow it. Trap: read it early on a moulded or cast part, along each direction the tools open — walls that lean half a degree to a few explain fits that miss by the lean. Changes nothing.',
  input: obj({
    pull: vec3('The pull direction, any length.'),
    box: obj({ min: vec3('Lowest corner, mm.'), max: vec3('Highest corner, mm.') }, ['min', 'max'], 'Only the scan inside this box.'),
    nearDeg: num('Degrees; 10 by default.', { exclusiveMinimum: 0, maximum: 45 }),
    patches: int('How many patches; 12 by default.', { minimum: 1, maximum: 50 }),
    minArea: num('mm²; 1 by default.', { minimum: 0 }),
    split: oneOf([str('"symmetry", a plane element’s name, or "XY", "YZ", "XZ".', { minLength: 1 }), int('A plane element’s id.', { minimum: 1 }), obj({ point: vec3('A point on it, mm.'), normal: vec3('Its normal, any length.') }, ['point', 'normal'])], 'Keep every patch to one side of this plane.'),
  }, ['pull']),
  readOnly: true,
  run: async ({ pull, box, nearDeg, patches, minArea, split }) => {
    requireScan()
    if (!(Math.hypot(...pull) > 0)) throw new CommandError('invalid_input', 'pull: give a direction, not a zero vector.')
    const client = commandHost().session.clientRef.current
    if (!client) throw new CommandError('unavailable', 'The mesh worker is not running.')
    const parted = split !== undefined ? await draftSplit(split) : undefined
    const inf = Infinity
    const found = await client.query({ min: box?.min ?? [-inf, -inf, -inf], max: box?.max ?? [inf, inf, inf], limit: DRAFT_LIMIT })
    if (!found.normals || found.positions.length < 9) throw new CommandError('invalid_input', 'Too few scan points lie there to read a wall off.')
    const { draftPatches } = await import('../../core/fit/draft')
    const r = draftPatches(found.positions, found.normals, pull, { ...(nearDeg !== undefined ? { nearDeg } : {}), ...(patches !== undefined ? { limit: patches } : {}), ...(minArea !== undefined ? { minArea } : {}), ...(parted ? { split: parted } : {}) })
    const v3 = (v: readonly number[]) => v.map((x) => roundTo(x, 3))
    return {
      pull: v3(r.pull),
      nearDeg: r.nearDeg,
      points: r.points,
      walls: r.walls,
      found: r.found,
      ...(parted && r.split ? { split: { point: v3(r.split.point), normal: v3(r.split.normal), from: parted.from, ...(parted.rms !== undefined ? { rms: roundTo(parted.rms, 4) } : {}) } } : {}),
      patches: r.patches.map((p) => ({
        draftDeg: roundTo(p.draftDeg, 3),
        sigmaDeg: roundTo(p.sigmaDeg, 3),
        spreadDeg: roundTo(p.spreadDeg, 2),
        area: roundTo(p.area, 1),
        count: p.count,
        centroid: v3(p.centroid),
        box: { min: v3(p.min), max: v3(p.max) },
        facing: v3(p.facing),
        turnDeg: roundTo(p.turnDeg, 1),
        ...(p.round ? { round: true } : {}),
        ...(p.side ? { side: p.side } : {}),
      })),
    }
  },
}

/** The most cells a height map's numbers hold, and how many a side it
 *  aims at unless a cell is given; and the same for one that answers
 *  without its numbers — a picture, or the levels — which may be finer. */
const HEIGHT_CELLS = 1600
const HEIGHT_SIDE = 40
const HEIGHT_CELLS_FINE = 25_600
const HEIGHT_SIDE_FINE = 160
/** How many levels an answer names, the largest first. */
const HEIGHT_LEVELS = 12
/** The least gap between two levels, mm, however clean the scan. */
const LEVEL_GAP_MIN = 0.02
/** How steep a cell of a height map may be and still count towards its
 *  levels, degrees, unless told otherwise. */
const LEVEL_SLOPE_DEG = 10
/** The share of the map a level of a height must hold for the answer to
 *  give its plane. */
const LEVEL_PLANE_SHARE = 0.05
/** The share of the map's cells on a slope past which levels say where
 *  the ramps are, and how many they name, the largest first. */
const RAMP_SHARE = 0.2
const RAMPS_NAMED = 3
/** How many scan vertices a plane's map looks at for its box and side. */
const PLANE_SAMPLE = 20_000
const AXIS_NAMES = ['+x', '-x', '+y', '-y', '+z', '-z'] as const
type AxisName = (typeof AXIS_NAMES)[number]
type HeightOf = 'height' | 'deviation' | 'relief'
type PlaneIn = ElementRef | { origin: Vec3; normal: Vec3; u?: Vec3 }
/** A map's box as given: min and max — in the plane's frame with a plane,
 *  [u, v, height] — or world: { min, max }, the box in the world. */
type BoxIn = { min?: Vec3; max?: Vec3; world?: { min: Vec3; max: Vec3 } }

/** The box schema of the maps: in the plane's frame with a plane, or a
 *  box of the world laid onto it. */
const mapBoxSchema = (description: string) =>
  obj(
    {
      min: vec3('Lowest corner, mm ([u, v, height] with plane).'),
      max: vec3('Highest corner, mm ([u, v, height] with plane).'),
      world: obj({ min: vec3('Lowest corner, [x, y, z] mm.'), max: vec3('Highest corner, [x, y, z] mm.') }, ['min', 'max'], 'A box in the world, in place of min and max.'),
    },
    [],
    description,
  )

/** A map's box checked: min and max, or world, each with its min below
 *  its max. */
function boxOf(box: BoxIn | undefined): { min: Vec3; max: Vec3; world: boolean } | undefined {
  if (!box) return undefined
  if (box.world && (box.min || box.max)) throw new CommandError('invalid_input', 'box: give min and max, or world: { min, max } — not both.')
  const b = box.world ?? (box.min && box.max ? { min: box.min, max: box.max } : null)
  if (!b) throw new CommandError('invalid_input', 'box: give min and max (in the plane’s frame with plane, [u, v, height]), or world: { min, max } ([x, y, z] in the world).')
  for (let k = 0; k < 3; k++) if (!(b.min[k] <= b.max[k])) throw new CommandError('invalid_input', 'The box’s min lies past its max.')
  return { min: b.min, max: b.max, world: Boolean(box.world) }
}

/** Under this share of a map's cells meeting the scan, the answer says
 *  where the scan lies in the map's frame. */
const SPARSE_SHARE = 0.2

const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const unit = (i: number, s = 1): Vec3 => [i === 0 ? s : 0, i === 1 ? s : 0, i === 2 ? s : 0]

/** The plane a map is read on, as its frame: a coordinate plane by name, a
 *  plane element, or a plane given by a point and a normal; laid as a
 *  sketch on it is (sketchFrameOn). The map looks down `normal`: the
 *  sketch's, but turned over for an element when most of the scan lies in
 *  front of it (so the map looks at the face it was fitted on), and by
 *  `flip` — u and v stay the sketch's either way, so a point has the same
 *  [u, v] in the map as in a sketch on the plane, and `flipped` says the
 *  map sees that sheet from behind. `center` is where the element's
 *  centre, or the origin given, lies in its [u, v] — the frame's zero is
 *  the world origin's foot, not that. */
function planeFrame(plane: PlaneIn, flip: boolean, sample: Float32Array) {
  let point: Vec3
  let normal: Vec3
  let seedU: Vec3 | undefined
  let name: string | undefined
  let element = false
  let centred = false
  if (typeof plane === 'object') {
    point = plane.origin
    normal = plane.normal
    seedU = plane.u
    centred = true
  } else {
    const id = planeRef(plane)
    if (id < 0) {
      const base = basePlaneOf(id)!
      point = [0, 0, 0]
      normal = [...base.normal] as Vec3
      name = base.name
    } else {
      const el = findElement(id)
      const fit = el.fit as PlaneFit
      point = fit.center
      normal = fit.normal
      name = el.name
      element = true
      centred = true
    }
  }
  const len = Math.hypot(normal[0], normal[1], normal[2])
  if (!(len > 1e-9)) throw new CommandError('invalid_input', 'plane.normal: give a direction, not a zero vector.')
  normal = [normal[0] / len, normal[1] / len, normal[2] / len]
  let flipped = flip
  if (element) {
    // Most of the scan lies behind the face a plane was fitted on.
    const hs: number[] = []
    for (let i = 0; i + 2 < sample.length; i += 3) hs.push((sample[i] - point[0]) * normal[0] + (sample[i + 1] - point[1]) * normal[1] + (sample[i + 2] - point[2]) * normal[2])
    hs.sort((a, b) => a - b)
    if (hs.length && hs[Math.floor(hs.length / 2)] > 0) flipped = !flipped
  }
  const f = sketchFrameOn({ origin: point, normal }, seedU)
  if (!f) throw new CommandError('invalid_input', 'plane.normal: give a direction, not a zero vector.')
  return {
    name,
    origin: f.origin,
    u: f.basisU,
    v: f.basisV,
    normal: flipped ? ([-f.normal[0], -f.normal[1], -f.normal[2]] as Vec3) : f.normal,
    flipped,
    ...(centred ? { center: pointOnSheet(f, point).at } : {}),
  }
}

/** A map's plane as the answer gives it: its frame in the world, whether
 *  it looks at the sketch's sheet from behind, and where the element's
 *  centre (or the origin given) lies in [u, v]. */
function planeOut(frame: ReturnType<typeof planeFrame>) {
  return {
    ...(frame.name ? { name: frame.name } : {}),
    origin: frame.origin.map((x) => roundTo(x, 4)),
    u: frame.u.map((x) => roundTo(x, 6)),
    v: frame.v.map((x) => roundTo(x, 6)),
    normal: frame.normal.map((x) => roundTo(x, 6)),
    ...(frame.flipped ? { flipped: true } : {}),
    ...(frame.center ? { center: frame.center.map((x) => roundTo(x, 4)) } : {}),
  }
}

/** The deviation map in hand, per scan vertex, and the search distance
 *  past which a reading is bare on it. */
function deviationValues() {
  const d = useDeviation.getState()
  const maps = commandHost().session.maps
  const values = d.source === 'element' ? maps.elementField.current : maps.deviation.current
  const ready = d.source === 'element' ? d.elementStatus === 'ready' : d.mapStatus === 'ready'
  if (!ready || !values) throw new CommandError('invalid_state', 'There is no deviation map to read — deviation.align measures one against the reference part, deviation.set_target one against an element.')
  return { values, search: d.maxDistance, source: d.source, range: d.range }
}

/** The grid of rays a map is read over: looking along an axis, or square
 *  onto a plane (its frame), over the box asked for or the whole scan;
 *  `cell` as asked, or a round size giving `side` cells on the longer
 *  side, widened to keep `most` cells at most. Each ray's distance d to
 *  its hit is the height from + sign·d. A world box with a plane is the
 *  box round its corners in the plane's frame. `scanIn` is the box round
 *  the scan in the grid's frame — [u, v, height] on a plane, [u, v] and
 *  the coordinate looked along on an axis. */
async function rayGrid(
  client: NonNullable<ReturnType<typeof commandHost>['session']['clientRef']['current']>,
  { box, axis, plane, flip, cell, side, most }: { box?: { min: Vec3; max: Vec3; world: boolean }; axis?: AxisName; plane?: PlaneIn; flip: boolean; cell?: number; side: number; most: number },
) {
  // The grid's frame: start corner, the way the rays run, u and v, and
  // the height at the start with the way it counts along a ray.
  let frame: ReturnType<typeof planeFrame> | null = null
  let g: ReturnType<typeof gridOver>
  let start: Vec3
  let dir: Vec3
  let du: Vec3
  let dv: Vec3
  let from: number
  let sign: number
  let far: number
  let k: 0 | 1 | 2 = 2
  let scanIn: { min: Vec3; max: Vec3 }
  const look = axis ?? '-z'
  if (plane !== undefined) {
    const sample = (await client.query({ min: [-Infinity, -Infinity, -Infinity], max: [Infinity, Infinity, Infinity], limit: PLANE_SAMPLE })).positions
    frame = planeFrame(plane, flip, sample)
    const sheet = { origin: frame.origin, normal: frame.normal, basisU: frame.u, basisV: frame.v }
    let lo: Vec3 = [Infinity, Infinity, Infinity]
    let hi: Vec3 = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i + 2 < sample.length; i += 3) {
      const d: Vec3 = [sample[i] - frame.origin[0], sample[i + 1] - frame.origin[1], sample[i + 2] - frame.origin[2]]
      const p: Vec3 = [dot3(d, frame.u), dot3(d, frame.v), dot3(d, frame.normal)]
      for (let j = 0; j < 3; j++) {
        lo[j] = Math.min(lo[j], p[j])
        hi[j] = Math.max(hi[j], p[j])
      }
    }
    if (!Number.isFinite(lo[0])) throw new CommandError('invalid_state', 'The scan has no vertices to map.')
    // The sample is every k-th vertex: a little room round it for the
    // ones between.
    const pad = 0.01 * Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) + 1e-3
    lo = [lo[0] - pad, lo[1] - pad, lo[2] - pad]
    hi = [hi[0] + pad, hi[1] + pad, hi[2] + pad]
    scanIn = { min: lo, max: hi }
    if (box) {
      const b = box.world ? boxOnSheet(sheet, box) : box
      lo = b.min
      hi = b.max
    }
    g = gridOver(lo, hi, 2, cell, side, most)
    const { origin: o, u, v, normal: n } = frame
    start = [0, 1, 2].map((j) => o[j] + g.u0 * u[j] + g.v0 * v[j] + hi[2] * n[j]) as Vec3
    dir = [-n[0], -n[1], -n[2]]
    du = u
    dv = v
    from = hi[2]
    sign = -1
    far = hi[2] - lo[2]
  } else {
    const whole = await client.bounds()
    const b = box ?? whole
    k = 'xyz'.indexOf(look[1]) as 0 | 1 | 2
    sign = look[0] === '+' ? 1 : -1
    g = gridOver(b.min, b.max, k, cell, side, most)
    scanIn = { min: [whole.min[g.ua], whole.min[g.va], whole.min[k]], max: [whole.max[g.ua], whole.max[g.va], whole.max[k]] }
    from = sign > 0 ? b.min[k] : b.max[k]
    const to = sign > 0 ? b.max[k] : b.min[k]
    start = unit(k, from)
    start[g.ua] = g.u0
    start[g.va] = g.v0
    dir = unit(k, sign)
    du = unit(g.ua)
    dv = unit(g.va)
    far = Math.abs(to - from)
  }
  const rays = { origin: start, dir, u: du, v: dv, cell: g.cell, cols: g.cols, rows: g.rows, far }
  return { frame, g, k, look, from, sign, rays, scanIn }
}

/** Where the scan lies in a map's frame, said when few of its cells met
 *  it — a box given in one frame and read in another lands off the part:
 *  the share met, the scan's box in the frame and the grid's. */
function sparseWords(hit: number, g: ReturnType<typeof gridOver>, scanIn: { min: Vec3; max: Vec3 }, onPlane: boolean, along: string) {
  const r = (x: number) => roundTo(x, 2)
  const cells = g.cols * g.rows
  if (cells === 0 || hit / cells >= SPARSE_SHARE) return undefined
  const [lo, hi] = [scanIn.min, scanIn.max]
  const u1 = g.u0 + g.cols * g.cell
  const v1 = g.v0 + g.rows * g.cell
  const third = onPlane ? `height ${r(lo[2])}…${r(hi[2])}` : `${along} ${r(lo[2])}…${r(hi[2])}`
  return {
    hitPct: roundTo((100 * hit) / cells, 1),
    min: lo.map(r),
    max: hi.map(r),
    note: `Only ${roundTo((100 * hit) / cells, 1)} % of the cells met the scan. In this map’s frame the scan lies at u ${r(lo[0])}…${r(hi[0])}, v ${r(lo[1])}…${r(hi[1])}, ${third}; the grid spans u ${r(g.u0)}…${r(u1)}, v ${r(g.v0)}…${r(v1)}.${onPlane ? ' A box in world coordinates goes as box: { world: { min, max } }.' : ''}`,
  }
}

/** A level's plane in the world, as align.datum { primary: { plane } } and
 *  a map's plane take it: the point over the middle of its cells, and the
 *  normal out of the face the map sees — towards where it looks from. */
function levelPlaneOut(p: HeightLevel['plane'], frame: ReturnType<typeof planeFrame> | null, g: { ua: number; va: number }, k: number, sign: number) {
  const U = frame ? frame.u : unit(g.ua)
  const V = frame ? frame.v : unit(g.va)
  const H = frame ? frame.normal : unit(k)
  const O: Vec3 = frame ? frame.origin : [0, 0, 0]
  const [u, v, h] = p.at
  const [b, c] = p.slope
  const origin = [0, 1, 2].map((j) => O[j] + u * U[j] + v * V[j] + h * H[j])
  const n = [0, 1, 2].map((j) => -sign * (H[j] - b * U[j] - c * V[j]))
  const len = Math.hypot(n[0], n[1], n[2])
  return { origin: origin.map((x) => roundTo(x, 4)), normal: n.map((x) => roundTo(x / len, 6)) }
}

const heightmap: Command<{
  box?: BoxIn
  axis?: AxisName
  plane?: PlaneIn
  flip?: boolean
  of?: HeightOf
  smooth?: number
  cell?: number
  grid?: boolean
  levels?: boolean
  gap?: number
  slopeDeg?: number
  picture?: boolean
}> = {
  name: 'heightmap',
  title: 'Map the scan’s heights',
  description:
    `Where the scan is first met looking along an axis (axis, -z by default: the top surface from above) or square onto a plane (plane: an element, "XY", "YZ", "XZ", or { origin, normal, u? }), over a grid of cells: pocket floors, ledges, a step's height, a face's tilt, a pad's tiers, an icon on a key in one call. of: height (the default), deviation (the map's reading where each ray lands) or relief (the height less the surface round it, for icons, grooves and lettering). Returns cell, origin [u0, v0], cols, rows, grid (rows of mm from the low v up, null where nothing; grid[r][c] stands at u0 + (c + ½)·cell, v0 + (r + ½)·cell), min, max, hit, valued; with plane also its frame (a cell's point is origin + u·U + v·V + height·normal). levels: true gives the values gathered into levels in place of the grid, largest first — of a height, each holding 5 % of the map or more with its plane { origin, normal } (fitted to its cells, normal towards the viewer), which align.datum { primary: { plane } } levels on: the sheet itself, not its bead crowns; a gentle warp that ran levels together is taken out first and said (warp { rise, bow, note }); picture: true adds the map coloured. Trap: with plane, box is [u, v, height] in the plane's frame (or { world }), and scanLies says where the scan lies when few cells meet it. Changes nothing.`,
  input: obj({
    box: mapBoxSchema('The part looked at; the scan’s box by default. With plane: [u, v, height], or world: { min, max }.'),
    axis: enumOf(AXIS_NAMES, 'The way looked: -z (the default) from above, +z from below, ±x, ±y.'),
    plane: oneOf(
      [
        elementRefSchema('A plane element, or "XY", "YZ", "XZ".'),
        obj({ origin: vec3('A point on the plane, mm.'), normal: vec3('Its normal: the side looked from.'), u: vec3('A direction for u, flattened into the plane; a sketch’s by default.') }, ['origin', 'normal']),
      ],
      'Look square onto this plane instead of along an axis.',
    ),
    flip: bool('With plane: look from its other side.'),
    of: enumOf(['height', 'deviation', 'relief'], 'height (the default), deviation (the map’s, where the ray lands) or relief (height less the surface round it).'),
    smooth: num('relief: the smoothing sigma, mm; three cells by default.', { exclusiveMinimum: 0 }),
    cell: num('The cell’s side, mm.', { exclusiveMinimum: 0 }),
    grid: bool('The grid of numbers (the default unless levels); false returns the picture alone.'),
    levels: bool('Gather the values into levels, largest first, in place of the grid; of a height, a warp taken out first when it ran two together, and each level of 5 % or more with its plane.'),
    gap: num('levels: the least gap between two levels, mm.', { exclusiveMinimum: 0 }),
    slopeDeg: num(`levels of a height: cells steeper are left out, degrees; ${LEVEL_SLOPE_DEG} by default, 90 keeps every one.`, { exclusiveMinimum: 0, maximum: 90 }),
    picture: bool('Add a picture of the map with a scale.'),
  }),
  readOnly: true,
  returnsFile: true,
  returnsImage: true,
  run: async ({ box, axis, plane, flip = false, of = 'height', smooth, cell, grid, levels = false, gap, slopeDeg, picture }) => {
    requireScan()
    const client = commandHost().session.clientRef.current
    if (!client) throw new CommandError('unavailable', 'The mesh worker is not running.')
    if (plane !== undefined && axis !== undefined) throw new CommandError('invalid_input', 'Give axis, or plane — one of them.')
    if (flip && plane === undefined) throw new CommandError('invalid_input', 'flip turns a plane over — give plane.')
    if (smooth !== undefined && of !== 'relief') throw new CommandError('invalid_input', 'smooth is the relief’s — give of: "relief".')
    if (slopeDeg !== undefined && !(levels && of === 'height')) throw new CommandError('invalid_input', 'slopeDeg is for the levels of a height — give levels: true, of: "height".')
    const showGrid = grid ?? !levels
    const showPicture = picture || grid === false
    const boxed = boxOf(box)
    // Read up front, so a map with nothing to read refuses before it rays.
    if (of === 'deviation') await mapSettled(sceneOf())
    const dev = of === 'deviation' ? deviationValues() : null
    const side = showGrid ? HEIGHT_SIDE : HEIGHT_SIDE_FINE
    const most = showGrid ? HEIGHT_CELLS : HEIGHT_CELLS_FINE

    const { frame, g, k, look, from, sign, rays, scanIn } = await rayGrid(client, { box: boxed, axis, plane, flip, cell, side, most })
    const names = 'xyz'
    let values: Float32Array
    let heights: Float32Array
    if (dev) {
      // The deviation where each ray lands: its triangle's corners weighed
      // as the hit lies between them, a corner with no reading within the
      // search distance left out.
      const hits = await client.heightsAt(rays)
      if (dev.values.length !== useStore.getState().vertexCount) throw new CommandError('internal', `The map has ${dev.values.length} readings and the scan ${useStore.getState().vertexCount} vertices.`)
      values = new Float32Array(hits.values.length).fill(Number.NaN)
      for (let i = 0; i < values.length; i++) {
        if (Number.isNaN(hits.values[i])) continue
        let s = 0
        let w = 0
        for (let j = 0; j < 3; j++) {
          const reading = dev.values[hits.corners[3 * i + j]]
          if (!(Math.abs(reading) <= dev.search)) continue
          s += hits.weights[3 * i + j] * reading
          w += hits.weights[3 * i + j]
        }
        if (w > 1e-6) values[i] = s / w
      }
      for (let i = 0; i < hits.values.length; i++) hits.values[i] = from + sign * hits.values[i]
      heights = hits.values
    } else {
      heights = await client.heights(rays)
      for (let i = 0; i < heights.length; i++) heights[i] = from + sign * heights[i]
      values = of === 'relief' ? reliefGrid(heights, g.cols, g.rows, (smooth ?? 3 * g.cell) / g.cell) : heights
    }
    let lo = Infinity
    let hi = -Infinity
    let hit = 0
    let valued = 0
    for (let i = 0; i < values.length; i++) {
      if (!Number.isNaN(heights[i])) hit++
      const v = values[i]
      if (Number.isNaN(v)) continue
      valued++
      lo = Math.min(lo, v)
      hi = Math.max(hi, v)
    }
    const places = of === 'height' ? 2 : 3
    const sparse = sparseWords(hit, g, scanIn, frame !== null, names[k])
    const out: Record<string, unknown> = {
      ...(frame ? { plane: planeOut(frame), along: 'normal', across: ['u', 'v'] } : { axis: look, along: names[k], across: [names[g.ua], names[g.va]] }),
      of,
      ...(of === 'relief' ? { smooth: roundTo(smooth ?? 3 * g.cell, 4) } : {}),
      ...(dev ? { source: dev.source, searchDistance: dev.search } : {}),
      cell: g.cell,
      ...(g.widened ? { note: `cell widened to ${g.cell} mm to keep ${most} cells at most` } : {}),
      origin: [roundTo(g.u0, 3), roundTo(g.v0, 3)],
      cols: g.cols,
      rows: g.rows,
      hit,
      valued,
      min: valued ? roundTo(lo, 3) : null,
      max: valued ? roundTo(hi, 3) : null,
      ...(sparse ? { scanLies: sparse } : {}),
    }
    if (showGrid) {
      const rowsOut: (number | null)[][] = []
      for (let r = 0; r < g.rows; r++) {
        const row: (number | null)[] = []
        for (let c = 0; c < g.cols; c++) {
          const v = values[r * g.cols + c]
          row.push(Number.isNaN(v) ? null : roundTo(v, places))
        }
        rowsOut.push(row)
      }
      out.grid = rowsOut
    }
    if (levels) {
      // Of a height, the cells on a slope are left out before anything is
      // counted: a fillet's ramp would fill the bins between two tiers and
      // join them, and its steps would read as noise and widen the gap.
      // A relief has the lean taken off already, and a deviation is read
      // on every face alike.
      let counted = values
      let sloped = 0
      let steep: Uint8Array | null = null
      if (of === 'height') {
        steep = slopedCells(values, g.cols, g.rows, g.cell, slopeDeg ?? LEVEL_SLOPE_DEG)
        counted = values.slice()
        for (let i = 0; i < steep.length; i++) {
          if (!steep[i]) continue
          counted[i] = Number.NaN
          sloped++
        }
      }
      const noise = cellNoise(counted, g.cols, g.rows)
      // A height may be warped — a stamped sheet, a plate bent in the
      // making — and its levels run together across the warp: they are
      // gathered again with a smooth surface taken out, and the answer
      // says so when that reading is kept.
      const levelGrid = { cols: g.cols, rows: g.rows, cell: g.cell, u0: g.u0, v0: g.v0 }
      const levelGap = gap ?? Math.max(3 * noise, LEVEL_GAP_MIN)
      const found: LevelsResult & { warp?: Warp } = of === 'height' ? levelsThroughWarp(counted, values, levelGrid, levelGap) : heightLevels(counted, levelGrid, levelGap)
      if (of === 'height') {
        out.slopeDeg = slopeDeg ?? LEVEL_SLOPE_DEG
        out.sloped = sloped
      }
      out.noise = roundTo(noise, 4)
      out.gap = roundTo(found.gap, 4)
      if (found.warp) {
        const { rise, bow, base } = found.warp
        out.warp = {
          rise: roundTo(rise, 3),
          bow: roundTo(bow, 3),
          note: `A warp was taken out before the levels were gathered: a smooth surface fitted to the largest level, rising ${roundTo(rise, 2)} mm over the map (${roundTo(bow, 2)} mm of it a bend past a plane). Heights, ranges and sigmas are read off it, put back at its median height ${roundTo(base, 3)} — the gaps between levels are the steps; each level's plane is fitted to the heights as read.`,
        }
      }
      out.levels = found.levels.slice(0, HEIGHT_LEVELS).map((l) => ({
        height: roundTo(l.height, 3),
        sigma: roundTo(l.sigma, 4),
        range: l.range.map((x) => roundTo(x, 3)),
        cells: l.cells,
        area: roundTo(l.area, 2),
        sharePct: roundTo(100 * l.share, 1),
        box: { min: l.box.min.map((x) => roundTo(x, 3)), max: l.box.max.map((x) => roundTo(x, 3)) },
        ...(of === 'height' && l.share >= LEVEL_PLANE_SHARE ? { plane: levelPlaneOut(l.plane, frame, g, k, sign) } : {}),
      }))
      if (found.levels.length > HEIGHT_LEVELS) out.moreLevels = found.levels.length - HEIGHT_LEVELS
      out.unassigned = found.unassigned
      // The sloped cells left out are the ramps between the tiers, which
      // the levels do not say: past a share of the map, or a ramp off one
      // tier that leads to none, the answer says where they are.
      if (steep) {
        const r = rampsOf(found.warp?.flat ?? values, steep, g, found.levels)
        const share = r.sloped / Math.max(1, r.valued)
        if (share > RAMP_SHARE || r.ramps.some((x) => x.joins.length === 1)) {
          out.ramps = {
            note: `ramps between tiers (sloped ${Math.round(100 * share)} %) — a section along them gives their profile`,
            found: r.ramps.length,
            largest: r.ramps.slice(0, RAMPS_NAMED).map((x) => ({ cells: x.cells, area: roundTo(x.cells * g.cell * g.cell, 2), box: { min: x.box.min.map((v) => roundTo(v, 3)), max: x.box.max.map((v) => roundTo(v, 3)) }, joins: x.joins.map((h) => roundTo(h, 3)) })),
          }
        }
      }
    }
    if (!showPicture) return out
    if (typeof OffscreenCanvas === 'undefined') throw new CommandError('unavailable', 'A picture of the height map needs the browser.')
    const { heightPicturePng } = await import('../../app/heightPicture')
    // A deviation in the workspace's own colours over its range; a relief
    // even about zero; a height from its lowest to its highest.
    const reach = Math.max(Math.abs(lo), Math.abs(hi)) || 1
    const [low, high] = !valued ? [0, 1] : dev ? [-dev.range, dev.range] : of === 'relief' ? [-reach, reach] : [lo, hi]
    const what = of === 'height' ? (frame ? 'Height' : names[k].toUpperCase()) : of === 'deviation' ? 'Deviation' : 'Relief'
    const png = await heightPicturePng({
      values,
      cols: g.cols,
      rows: g.rows,
      u0: g.u0,
      v0: g.v0,
      cell: g.cell,
      uName: frame ? 'U' : names[g.ua].toUpperCase(),
      vName: frame ? 'V' : names[g.va].toUpperCase(),
      title: frame
        ? `${what} over ${frame.name ?? 'the plane'}, looking down its normal — cell ${g.cell} mm`
        : `${what} first met looking ${look} — cell ${g.cell} mm`,
      low,
      high,
      ...(dev ? { colormap: usePrefs.getState().colormap, bare: 'no reading' } : {}),
    })
    const stem = frame ? 'plane' : look.replace('+', 'p').replace('-', 'm')
    return { ...out, file: { name: `heightmap-${stem}${of === 'height' ? '' : `-${of}`}.png`, mimeType: 'image/png', bytes: png.bytes }, width: png.width, height: png.height }
  },
}

/** The outline's tolerance unless told otherwise, mm; the cells are half
 *  of it, widened to keep OUTLINE_CELLS at most. How many loops are
 *  answered unless told otherwise. */
const OUTLINE_TOLERANCE = 0.2
const OUTLINE_CELLS = 250_000
const OUTLINE_LOOPS = 4

const outline: Command<{ axis?: AxisName; plane?: PlaneIn; flip?: boolean; box?: BoxIn; tolerance?: number; loops?: number }> = {
  name: 'outline',
  title: 'Read the scan’s outline',
  description: `The scan’s outline seen along an axis, or square onto a plane, read as a sketch would draw it: a flange’s plan, a bezel’s opening, a gasket’s shape — each loop as the fewest lines and arcs that follow it within tolerance (mm, ${OUTLINE_TOLERANCE} by default), a round loop as one circle. axis, plane, flip and box as scan.heightmap takes them, u, v as it lays them. Returns loops, the largest first (${OUTLINE_LOOPS} by default): hole, area (mm²), box, points ([u, v] corners), rounds { at, radius, center }, arcs { from, radius, center, mid } (from points[from] through mid to the next point: mid says which way it bulges, a slot’s half-round end too) or circle { center, radius, rms }, and worst (mm the trace strays from what is drawn, worstAt when past the tolerance). Changes nothing.`,
  input: obj({
    axis: enumOf(AXIS_NAMES, 'The way looked: -z (the default) from above, and so on.'),
    plane: oneOf(
      [
        elementRefSchema('A plane element, or "XY", "YZ", "XZ".'),
        obj({ origin: vec3('A point on the plane, mm.'), normal: vec3('Its normal: the side looked from.'), u: vec3('A direction for u, flattened into the plane.') }, ['origin', 'normal']),
      ],
      'Look square onto this plane instead of along an axis.',
    ),
    flip: bool('With plane: look from its other side.'),
    box: mapBoxSchema('Only the scan inside it; the whole scan by default. With plane: [u, v, height], or world: { min, max }.'),
    tolerance: num(`How closely the sketch follows the outline, mm; ${OUTLINE_TOLERANCE} by default.`, { exclusiveMinimum: 0 }),
    loops: int(`How many loops, the largest first; ${OUTLINE_LOOPS} by default.`, { minimum: 1, maximum: 50 }),
  }),
  readOnly: true,
  run: async ({ axis, plane, flip = false, box, tolerance = OUTLINE_TOLERANCE, loops: most = OUTLINE_LOOPS }) => {
    requireScan()
    const client = commandHost().session.clientRef.current
    if (!client) throw new CommandError('unavailable', 'The mesh worker is not running.')
    if (plane !== undefined && axis !== undefined) throw new CommandError('invalid_input', 'Give axis, or plane — one of them.')
    if (flip && plane === undefined) throw new CommandError('invalid_input', 'flip turns a plane over — give plane.')
    const { frame, g, look, rays } = await rayGrid(client, { box: boxOf(box), axis, plane, flip, cell: tolerance / 2, side: 1, most: OUTLINE_CELLS })
    const hits = await client.heights(rays)
    const mask = new Uint8Array(hits.length)
    for (let i = 0; i < hits.length; i++) mask[i] = Number.isNaN(hits[i]) ? 0 : 1
    const { maskLoops, loopShape } = await import('../../core/geometry/outline')
    const found = maskLoops(mask, { cols: g.cols, rows: g.rows, cell: g.cell, u0: g.u0, v0: g.v0 }, (3 * g.cell) ** 2)
    // A widened grid traces coarser than asked: the sketch follows it to
    // its own steps, no closer.
    const tol = Math.max(tolerance, g.cell)
    const r3 = (x: number) => roundTo(x, 3)
    const pt = (p: readonly number[]) => [r3(p[0]), r3(p[1])]
    const names = 'xyz'
    return {
      ...(frame
        ? { plane: planeOut(frame), across: ['u', 'v'] }
        : { axis: look, across: [names[g.ua], names[g.va]] }),
      cell: g.cell,
      tolerance: roundTo(tol, 4),
      ...(g.widened ? { note: `cell widened to ${g.cell} mm to keep ${OUTLINE_CELLS} cells at most; the outline is read to ${roundTo(tol, 3)} mm — give a box round the part looked for to read it finer` } : {}),
      loops: found.slice(0, most).map((l) => {
        const shape = loopShape(l.points, tol, g.cell)
        const us = l.points.map((p) => p[0])
        const vs = l.points.map((p) => p[1])
        return {
          hole: l.hole,
          area: roundTo(l.area, 1),
          box: { min: pt([Math.min(...us), Math.min(...vs)]), max: pt([Math.max(...us), Math.max(...vs)]) },
          ...(shape.circle
            ? { circle: { center: pt(shape.circle.center), radius: r3(shape.circle.radius), rms: roundTo(shape.circle.rms, 4) } }
            : {
                points: shape.points.map(pt),
                ...(shape.rounds.length > 0 ? { rounds: shape.rounds.map((r) => ({ at: r.at, radius: r3(r.radius), center: pt(r.center) })) } : {}),
                ...(shape.arcs.length > 0 ? { arcs: shape.arcs.map((a) => ({ from: a.from, radius: r3(a.radius), center: pt(a.center), mid: pt(a.mid) })) } : {}),
              }),
          worst: r3(shape.worst),
          ...(shape.worstAt && shape.worst > tol ? { worstAt: pt(shape.worstAt) } : {}),
        }
      }),
      ...(found.length > most ? { more: found.length - most } : {}),
    }
  },
}

/** How many heights a pattern is read at unless told, and at most; the
 *  most copies looked for unless told. */
const PATTERN_HEIGHTS = 6
const PATTERN_HEIGHTS_MAX = 12
const PATTERN_COUNT = 60

type AxisIn = ElementRef | { origin: Vec3; dir: Vec3 }

/** An axis as scan.pattern takes it, as a line: its direction turned to
 *  the + end of the coordinate axis it lies nearest (as a plane through an
 *  axis takes it), and its origin the world origin's foot on it — so a
 *  height along it is the coordinate itself on a coordinate axis. */
function axisLine(axis: AxisIn): { origin: Vec3; dir: Vec3; name?: string } {
  let line: { origin: Vec3; dir: Vec3 } | null
  let name: string | undefined
  if (typeof axis === 'object') line = axis
  else if (typeof axis === 'string' && /^\s*[xyz]\s*$/i.test(axis) && !useStore.getState().elements.some((e) => e.name.trim().toLowerCase() === axis.trim().toLowerCase())) {
    const world = axis.trim().toLowerCase() as WorldAxis
    line = { origin: [0, 0, 0], dir: worldAxisDir(world) }
    name = world.toUpperCase()
  } else {
    const el = findElement(axis)
    line = el.fit && RADIAL_AXIS_KINDS.includes(el.kind) ? axisLineOf(el.fit) : null
    if (!line) throw new CommandError('invalid_input', `${el.name} has no axis — choose a cylinder, cone, line or circle.`)
    name = el.name
  }
  const l = Math.hypot(line.dir[0], line.dir[1], line.dir[2])
  if (!(l > 1e-9)) throw new CommandError('invalid_input', 'axis.dir: give a direction, not a zero vector.')
  let dir: Vec3 = [line.dir[0] / l, line.dir[1] / l, line.dir[2] / l]
  const big = [0, 1, 2].reduce((m, i) => (Math.abs(dir[i]) > Math.abs(dir[m]) ? i : m), 0)
  if (dir[big] < 0) dir = [-dir[0], -dir[1], -dir[2]]
  const along = dot3(line.origin, dir)
  return { origin: [line.origin[0] - along * dir[0], line.origin[1] - along * dir[1], line.origin[2] - along * dir[2]], dir, ...(name ? { name } : {}) }
}

const pattern: Command<{ axis: AxisIn; at?: (number | Vec3)[]; radius?: { min?: number; max?: number }; maxCount?: number; instances?: boolean }> = {
  name: 'pattern',
  title: 'Count the repeats round an axis',
  description: `Rotational repeats about an axis — a fan's blades, a flange's holes, a wheel's spokes, a gear's teeth — counted from the scan: it is cut square to the axis at each height in at, and each cut (between radius.min and radius.max) is turned against itself. Needs axis: a cylinder, cone, line or circle element, "X", "Y", "Z", or { origin, dir }. Returns per height count, pitchDeg, phaseDeg, betweenDeg (angles as section.cut { across: { axis, angleDeg } } takes them), score (0 to 1; under 0.5 count is 1 and tried says the best), rms, worst, instances (each angleDeg, radius, offDeg, rms, worst, share) and rings (round outlines about the axis: radius, off, towardDeg, rms). Trap: features at different heights and radii need a cut through each, radius kept to one ring. Changes nothing.`,
  input: obj(
    {
      axis: oneOf(
        [
          elementRefSchema('A cylinder, cone, line or circle element, or a coordinate axis "X", "Y", "Z".'),
          obj({ origin: vec3('A point on the axis, mm.'), dir: vec3('Its direction, any length.') }, ['origin', 'dir']),
        ],
        'The axis the copies repeat round.',
      ),
      at: arr(oneOf([num('mm along the axis.'), vec3('A world point, mm: the height of its foot on the axis.')]), `Heights to cut at; ${PATTERN_HEIGHTS} spread over the scan by default.`, { minItems: 1, maxItems: PATTERN_HEIGHTS_MAX }),
      radius: obj({ min: num('mm', { minimum: 0 }), max: num('mm', { exclusiveMinimum: 0 }) }, [], 'Only the cut between these distances from the axis.'),
      maxCount: int(`The most copies looked for; ${PATTERN_COUNT} by default.`, { minimum: 2, maximum: 120 }),
      instances: bool('List each copy; true by default.'),
    },
    ['axis'],
  ),
  readOnly: true,
  run: async ({ axis, at, radius, maxCount = PATTERN_COUNT, instances = true }) => {
    requireScan()
    const client = commandHost().session.clientRef.current
    if (!client) throw new CommandError('unavailable', 'The mesh worker is not running.')
    if (radius?.min !== undefined && radius.max !== undefined && !(radius.min < radius.max)) throw new CommandError('invalid_input', 'radius.min must lie below radius.max.')
    const line = axisLine(axis)
    const zero = radialFrame(line, 0)!.basisU
    const quarter = radialFrame(line, 90)!.basisU
    // A point in the world is the height of its foot on the axis.
    let heights = at?.map((a) => (typeof a === 'number' ? a : roundTo(dot3([a[0] - line.origin[0], a[1] - line.origin[1], a[2] - line.origin[2]], line.dir), 4)))
    if (!heights) {
      // Spread over the scan's run along the axis, clear of its ends.
      const sample = (await client.query({ min: [-Infinity, -Infinity, -Infinity], max: [Infinity, Infinity, Infinity], limit: PLANE_SAMPLE })).positions
      let lo = Infinity
      let hi = -Infinity
      for (let i = 0; i + 2 < sample.length; i += 3) {
        const h = sample[i] * line.dir[0] + sample[i + 1] * line.dir[1] + sample[i + 2] * line.dir[2]
        lo = Math.min(lo, h)
        hi = Math.max(hi, h)
      }
      if (!Number.isFinite(lo)) throw new CommandError('invalid_state', 'The scan has no vertices to cut.')
      heights = Array.from({ length: PATTERN_HEIGHTS }, (_, i) => roundTo(lo + ((i + 0.5) / PATTERN_HEIGHTS) * (hi - lo), 3))
    }
    const { rotationalRepeat } = await import('../../core/geometry/rotationalRepeat')
    const r3 = (x: number) => roundTo(x, 3)
    const out = []
    for (const h of heights) {
      const origin: Vec3 = [line.origin[0] + h * line.dir[0], line.origin[1] + h * line.dir[1], line.origin[2] + h * line.dir[2]]
      const cut = await client.section(origin, line.dir, EDGE_MIN_FEATURE_MM)
      const flat = projectCut(cut, { origin, normal: line.dir, basisU: zero, basisV: quarter })
      const r = rotationalRepeat(flat, { ...(radius?.min !== undefined ? { minRadius: radius.min } : {}), ...(radius?.max !== undefined ? { maxRadius: radius.max } : {}), maxCount })
      const rings = r.rings.map((g) => ({ radius: r3(g.radius), off: r3(g.off), towardDeg: roundTo(g.towardDeg, 1), rms: roundTo(g.rms, 4) }))
      if (r.count === 1) {
        out.push({ at: h, count: 1, length: roundTo(r.length, 1), ...(r.tried ? { tried: { count: r.tried.count, score: r3(r.tried.score) } } : {}), rings })
        continue
      }
      out.push({
        at: h,
        count: r.count,
        pitchDeg: roundTo(r.pitchDeg, 4),
        phaseDeg: roundTo(r.phaseDeg, 2),
        betweenDeg: roundTo((r.phaseDeg + r.pitchDeg / 2) % 360, 2),
        score: r3(r.score),
        rms: roundTo(r.rms, 4),
        worst: r3(r.worst),
        worstInstance: r.worstInstance,
        length: roundTo(r.length, 1),
        ...(instances
          ? { instances: r.instances.map((c) => ({ angleDeg: roundTo(c.angleDeg, 2), offDeg: roundTo(c.offDeg, 3), radius: r3(c.radius), rms: roundTo(c.rms, 4), worst: r3(c.worst), share: roundTo(c.share, 2) })) }
          : {}),
        rings,
      })
    }
    const v6 = (v: readonly number[]) => v.map((x) => roundTo(x, 6) + 0)
    return { axis: { ...(line.name ? { name: line.name } : {}), origin: v6(line.origin), dir: v6(line.dir), zeroDir: v6(zero) }, heights: out }
  },
}

/** A scan's checks: how many vertices the noise is read on, how many rims
 *  are named, and how many cells a side the thickness is read over. */
const QA_NOISE_SAMPLE = 4000
const QA_RIMS = 4
const QA_SIDE = 60
const QA_SAMPLE = 60_000
/** Faces this far out of parallel are worth a note, degrees. */
const QA_TILT_NOTE = 0.2
/** Open rims this short in all, against the part's diagonal, are pinholes a
 *  wrap left, not holes the scanner saw through: 9 rims of 1.6 mm in all on a
 *  149 × 89 × 71 mm pipe with two big openings bridged are 0.9 % of its 188 mm,
 *  while one real hole of 1.5 mm, 4.7 mm round, is 2.5 %. */
const QA_PINHOLES = 0.02
/** What a skin closed all round asks of whoever reads holes off it. */
const QA_WRAP_ADVICE = 'a wrap bridges holes it did not see through — read each hole from both ends (scan.heightmap along its axis each way); element.fit on a bore answers closed where its axis runs into the skin.'

/** How many points look for a sheet's other skin, and how many what stands
 *  apart from its walls is gathered over — see geometry/sheet. */
const QA_SHEET_SAMPLE = 6000
const QA_APART_SAMPLE = 30_000
/** A gauge this even, p95 against p5, and no thicker (mm), is sheet metal,
 *  not a moulding or a plate. */
const QA_SHEET_EVEN = 1.5
const QA_SHEET_GAUGE = 3

/** A rim's circle as an answer gives it. */
const circleOut = (c: RimCircle) => ({ center: c.center.map((x) => roundTo(x, 3)), axis: c.axis.map((x) => roundTo(x, 4)), radius: roundTo(c.radius, 3), rms: roundTo(c.rms, 3) })

const qa: Command<{ axis?: 'x' | 'y' | 'z' | Vec3 }> = {
  name: 'qa',
  title: 'Check the scan before modelling',
  description:
    'One call before modelling, to know what the scan will and will not give. Returns rims (the open edges of its holes: count, total length, the longest few with rim number, centre, size and circle where one fits — element.fit { kind: "circle", rim } makes it an element), noise (the median scatter of small plane fits, mm; 0 on a CAD tessellation), tessellation where the mesh is an STL exported from CAD (cad, its facets exactly flat; sparse where its vertices lie only on edges and rims, too far apart to fit on — densifyTo, the edge length to subdivide it to first, noise.measured the bends between facets that a fit would read), thickness through the part along axis (p5, p50, p95, the main faces’ tiltDeg and faces { topDeg, bottomDeg }), sheet where most of the area has a second skin facing back within reach mm (gauge { p5, p50, p95 }, twoSkins: that share), apart on such a part with flat walls (regions standing over reach mm off every main wall — tabs bent in, ribs, bosses: center, box, area mm², largest first) and notes, what looks wrong, plainly. Traps: a scanned skin with no rims, or only pinholes, is a wrap bridging the holes it did not see through; on a sheet, thickness reads the box across the part — the gauge is sheet.gauge. Changes nothing.',
  input: obj({ axis: oneOf([enumOf(['x', 'y', 'z'], 'A world axis.'), vec3('A direction, any length.')], 'The thickness axis.') }),
  readOnly: true,
  run: async ({ axis }) => {
    requireScan()
    const client = commandHost().session.clientRef.current
    if (!client) throw new CommandError('unavailable', 'The mesh worker is not running.')
    const { rims, noise: measured, sheet, tessellation: tess } = await client.scanQa(QA_NOISE_SAMPLE, QA_RIMS, { sample: QA_SHEET_SAMPLE, apartSample: QA_APART_SAMPLE })
    // A CAD tessellation has no scatter: what the small plane fits read on
    // one whose vertices lie only on its edges and rims is the bend between
    // its facets (issue 42), kept beside the noise as measured.
    const noise = tess.cad ? { median: 0, p90: 0, sampled: measured.sampled } : measured
    // The scan's points and normals, spread evenly: the box across the axis
    // and the way most of it faces come off them.
    const inf = Infinity
    const sample = await client.query({ min: [-inf, -inf, -inf], max: [inf, inf, inf], limit: QA_SAMPLE })
    let d: Vec3 | null
    let axisFrom: string
    if (Array.isArray(axis)) {
      const l = Math.hypot(...axis)
      if (!(l > 0)) throw new CommandError('invalid_input', 'axis: give a direction, not a zero vector.')
      d = [axis[0] / l, axis[1] / l, axis[2] / l]
      axisFrom = 'given'
    } else if (axis || useStore.getState().appliedAlignment) {
      const k = 'xyz'.indexOf(axis ?? 'z')
      d = [k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0]
      axisFrom = axis ? 'given' : 'the alignment’s z'
    } else {
      d = dominantFacing(sample.normals)
      axisFrom = 'the way most of the surface faces'
      if (!d) throw new CommandError('failed', 'The scan has too few points to read a thickness axis off — give axis.')
      // Pointing the way of its largest component, so +z stays +z.
      const big = [0, 1, 2].reduce((m, i) => (Math.abs(d![i]) > Math.abs(d![m]) ? i : m), 0)
      if (d[big] < 0) d = [-d[0], -d[1], -d[2]]
    }
    const [u, v] = orthoBasis(d)
    const dot = (p: Float32Array, i: number, a: Vec3) => p[i] * a[0] + p[i + 1] * a[1] + p[i + 2] * a[2]
    const lo = [Infinity, Infinity, Infinity]
    const hi = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i + 2 < sample.positions.length; i += 3) {
      const s = [dot(sample.positions, i, u), dot(sample.positions, i, v), dot(sample.positions, i, d)]
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], s[k])
        hi[k] = Math.max(hi[k], s[k])
      }
    }
    const cell = niceCeil(Math.max(hi[0] - lo[0], hi[1] - lo[1], 1e-6) / QA_SIDE)
    const cols = Math.max(1, Math.ceil((hi[0] - lo[0]) / cell))
    const rows = Math.max(1, Math.ceil((hi[1] - lo[1]) / cell))
    const u0 = (lo[0] + hi[0]) / 2 - (cols * cell) / 2
    const v0 = (lo[1] + hi[1]) / 2 - (rows * cell) / 2
    const pad = 0.01 * (hi[2] - lo[2]) + 0.1
    const far = hi[2] - lo[2] + 2 * pad
    const at = (w: number): Vec3 => [u0 * u[0] + v0 * v[0] + w * d![0], u0 * u[1] + v0 * v[1] + w * d![1], u0 * u[2] + v0 * v[2] + w * d![2]]
    const neg: Vec3 = [-d[0], -d[1], -d[2]]
    const top = await client.heights({ origin: at(hi[2] + pad), dir: neg, u, v, cell, cols, rows, far })
    const bottom = await client.heights({ origin: at(lo[2] - pad), dir: d, u, v, cell, cols, rows, far })
    const us: number[] = []
    const vs: number[] = []
    const ts: number[] = []
    const tops: number[] = []
    const bottoms: number[] = []
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c
        const tTop = hi[2] + pad - top[i]
        const tBottom = lo[2] - pad + bottom[i]
        const t = tTop - tBottom
        if (!(t > 0)) continue
        us.push(u0 + (c + 0.5) * cell)
        vs.push(v0 + (r + 0.5) * cell)
        ts.push(t)
        tops.push(tTop)
        bottoms.push(tBottom)
      }
    }
    const v3 = (x: readonly number[]) => x.map((y) => roundTo(y, 2))
    const axisName = d[0] === 1 ? 'x' : d[1] === 1 ? 'y' : d[2] === 1 ? 'z' : `[${v3(d).join(', ')}]`
    const notes: string[] = []
    const out: Record<string, unknown> = {
      rims: {
        count: rims.count,
        total: roundTo(rims.total, 1),
        largest: rims.largest.map((r) => ({ rim: r.index, length: roundTo(r.length, 1), at: v3(r.at), size: roundTo(r.size, 1), ...(r.circle ? { circle: circleOut(r.circle) } : {}) })),
        ...(rims.circles.length > 0 ? { circles: rims.circles.map((r) => ({ rim: r.index, length: roundTo(r.length, 1), circle: circleOut(r.circle!) })) } : {}),
        ...(rims.moreCircles > 0 ? { moreCircles: rims.moreCircles } : {}),
      },
      noise: { median: roundTo(noise.median, 4), p90: roundTo(noise.p90, 4), sampled: noise.sampled, ...(tess.cad && measured.median >= 1e-4 ? { measured: { median: roundTo(measured.median, 4), p90: roundTo(measured.p90, 4) } } : {}) },
    }
    // The edge to densify a sparse one to: a hundredth of the part across.
    const densifyTo = densifyEdgeFor(Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]))
    if (tess.cad) {
      out.tessellation = {
        cad: true,
        sparse: tess.sparse,
        spacing: roundTo(tess.spacing, 3),
        edges: { p50: roundTo(tess.edgeP50, 3), p90: roundTo(tess.edgeP90, 3) },
        ...(tess.sparse ? { densifyTo } : {}),
      }
    }
    // A scan closed all round was wrapped: the skin runs across every hole
    // the scanner did not see through — and so was one whose only rims are
    // pinholes against its size. A CAD tessellation is closed by nature, and
    // says so below.
    const scanned = !(noise.median < 1e-4)
    const size = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])
    const pinholes = rims.count > 0 && scanned && rims.total <= QA_PINHOLES * size
    if (pinholes) {
      notes.push(`Closed skin but for pinholes, ${rims.count} open rim${rims.count === 1 ? '' : 's'}, ${roundTo(rims.total, 1)} mm in all on a part ${roundTo(size, 0)} mm across: ${QA_WRAP_ADVICE}`)
    } else if (rims.count > 0) {
      const l = rims.largest[0]
      notes.push(`${rims.count} open rim${rims.count === 1 ? '' : 's'}, ${roundTo(rims.total, 1)} mm in all — the longest ${roundTo(l.length, 1)} mm round [${v3(l.at).join(', ')}]: the scan has holes there; fits and sections near them see less surface.`)
    }
    if (rims.count === 0 && scanned) notes.push(`Closed skin, no open rims: ${QA_WRAP_ADVICE}`)
    // Two skins close together over most of it: a sheet, whose gauge no
    // thickness through the part reads; and what stands apart from its walls.
    const gauge = sheet?.gauge && sheet.twoSkins >= SHEET_SHARE ? sheet.gauge : null
    const sheetNotes = (through?: number): string[] => {
      if (!sheet || !gauge) return []
      const even = gauge.p95 <= QA_SHEET_EVEN * gauge.p5 + 2 * noise.median && gauge.p50 <= QA_SHEET_GAUGE
      const said = [
        `${even ? 'Sheet metal' : 'Thin walls'}: two skins ${roundTo(gauge.p50, 2)} mm apart over ${Math.round(100 * sheet.twoSkins)} % of the area (p5–p95 ${roundTo(gauge.p5, 2)}–${roundTo(gauge.p95, 2)} mm)${
          through !== undefined && through > 3 * gauge.p50 ? ` — thickness along ${axisName} (p50 ${roundTo(through, 1)} mm) reads the box across the part, not the ${even ? 'sheet' : 'wall'}` : ''
        }.`,
      ]
      const regions = sheet.apart?.regions ?? []
      if (regions.length > 0) {
        const n = regions.length + (sheet.apart!.more ?? 0)
        said.push(`${n} place${n === 1 ? '' : 's'} stand${n === 1 ? 's' : ''} over ${roundTo(sheet.apart!.reach, 1)} mm off every main wall — tabs bent in, ribs, bosses (apart): the largest ${Math.round(regions[0].area)} mm² round [${v3(regions[0].center).join(', ')}]. Model them too.`)
      }
      return said
    }
    if (gauge && sheet) {
      out.sheet = { gauge: { p5: roundTo(gauge.p5, 3), p50: roundTo(gauge.p50, 3), p95: roundTo(gauge.p95, 3) }, twoSkins: roundTo(sheet.twoSkins, 3), reach: roundTo(sheet.reach, 2), sampled: sheet.sampled }
      if (sheet.apart && sheet.apart.regions.length > 0) {
        out.apart = {
          reach: roundTo(sheet.apart.reach, 2),
          regions: sheet.apart.regions.map((r) => ({ center: v3(r.center), box: { min: v3(r.min), max: v3(r.max) }, area: roundTo(r.area, 0) })),
          ...(sheet.apart.more > 0 ? { more: sheet.apart.more } : {}),
        }
      }
    }
    if (tess.cad && tess.sparse) {
      const tool = listCommands().some((c) => c.name === 'mesh.densify') ? `mesh.densify { maxEdge: ${densifyTo} } (Mesh Tools)` : `subdivide it outside to edges of ${densifyTo} mm or less`
      notes.push(
        `A CAD tessellation, not a scan — and a sparse one: its vertices lie ${roundTo(tess.spacing, 2)} mm apart on average, on its edges and rims, with triangles up to ${roundTo(tess.edgeP90, 1)} mm long across its faces. The noise is 0; the ${roundTo(measured.median, 3)} mm the small fits measured (noise.measured) is the bend between facets, and a segmentation, a seeded fit or a section fit finds too few points inside a face. Densify it first — ${tool} — then read it exactly: take T from the process, not from the noise, and radii off the rim vertices, which lie on the circle (a facet reads short by its sagitta).`,
      )
    } else if (tess.cad || noise.median < 1e-4) notes.push('The surface has no noise — a CAD tessellation, not a scan: read its numbers exactly.')
    else if (noise.median > 0.03) notes.push(`Noisy surface: ${roundTo(noise.median, 3)} mm median scatter — read sizes from fits over large patches, not single points.`)
    if (ts.length < 12) {
      out.thickness = { axis: d.map((x) => roundTo(x, 4)), axisFrom, cells: ts.length }
      notes.push(`Thickness along ${axisName}: too few rays went through the part to read it.`, ...sheetNotes())
      return { ...out, notes }
    }
    const sorted = [...ts].sort((a, b) => a - b)
    const pct = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
    const p50 = pct(0.5)
    // The main faces: the thickness most cells share, and the cells near it
    // — wide enough for a lean of a degree or two across the part, narrow
    // enough to leave a step of another thickness out.
    const near = (t: number) => Math.max(0.3, 0.06 * t)
    let mode = p50
    let most = 0
    for (let i = 0; i < ts.length; i += Math.max(1, Math.floor(ts.length / 400))) {
      const w = near(ts[i]) / 2
      let n = 0
      for (const t of ts) if (Math.abs(t - ts[i]) <= w) n++
      if (n > most) {
        most = n
        mode = ts[i]
      }
    }
    const main = ts.map((t, i) => (Math.abs(t - mode) <= near(mode) ? i : -1)).filter((i) => i >= 0)
    const pick = (a: number[]) => main.map((i) => a[i])
    const trend = robustPlane(pick(us), pick(vs), pick(ts))
    const thickness: Record<string, unknown> = { axis: d.map((x) => roundTo(x, 4)), axisFrom, cells: ts.length, p5: roundTo(pct(0.05), 3), p50: roundTo(p50, 3), p95: roundTo(pct(0.95), 3) }
    if (trend) {
      const slope = Math.hypot(trend.b, trend.c)
      const tiltDeg = (Math.atan(slope) * 180) / Math.PI
      const dir: Vec3 = slope > 0 ? ([0, 1, 2].map((i) => (trend.b * u[i] + trend.c * v[i]) / slope) as Vec3) : [0, 0, 0]
      // The run of the trend across the main cells, along the way it rises.
      const along = main.map((i) => (slope > 0 ? (us[i] * trend.b + vs[i] * trend.c) / slope : 0))
      const lo = Math.min(...along)
      const hi = Math.max(...along)
      const mean = trend.a + (trend.b * pick(us).reduce((s, x) => s + x, 0) + trend.c * pick(vs).reduce((s, x) => s + x, 0)) / main.length
      const midAlong = along.reduce((s, x) => s + x, 0) / along.length
      const from = mean - slope * (midAlong - lo)
      const to = mean + slope * (hi - midAlong)
      Object.assign(thickness, { tiltDeg: roundTo(tiltDeg, 3), thickensToward: v3(dir), run: [roundTo(from, 3), roundTo(to, 3)], over: roundTo(hi - lo, 1) })
      const ft = robustPlane(pick(us), pick(vs), pick(tops))
      const fb = robustPlane(pick(us), pick(vs), pick(bottoms))
      const deg = (f: { b: number; c: number } | null) => (f ? roundTo((Math.atan(Math.hypot(f.b, f.c)) * 180) / Math.PI, 3) : null)
      // The faces fitted each on its own, their worst cells left out apart.
      thickness.faces = { topDeg: deg(ft), bottomDeg: deg(fb) }
      if (tiltDeg >= QA_TILT_NOTE) {
        notes.push(`Faces across ${axisName} that should be parallel are ${roundTo(tiltDeg, 2)}° apart: the part thickens from ${roundTo(from, 2)} to ${roundTo(to, 2)} mm over ${roundTo(hi - lo, 0)} mm toward [${v3(dir).join(', ')}]. A scan merge or alignment error, or a real taper — decide before modelling to one thickness, which misses by up to ${roundTo(Math.abs(to - from) / 2, 2)} mm.`)
      }
    }
    notes.push(...sheetNotes(p50))
    if (!gauge && pct(0.95) - pct(0.05) > 0.3 * p50) notes.push(`Thickness along ${axisName} varies from ${roundTo(pct(0.05), 2)} to ${roundTo(pct(0.95), 2)} mm (p5–p95): steps, pockets or bosses — scan.heightmap shows where.`)
    out.thickness = thickness
    return { ...out, notes }
  },
}

export const scanCommands = [open, nearest, query, fitSurface, draft, heightmap, outline, pattern, qa, scale]

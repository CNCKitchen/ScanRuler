// SPDX-License-Identifier: AGPL-3.0-only
// The scan: opening one, and finding places on it.

import { MESH_UNITS, type MeshUnits } from '../../core/meshUnits'
import type { Vec3 } from '../../core/types'
import { useStore } from '../../state/store'
import { commandHost } from '../host'
import { locationSchema, requireScan, resolveLocation, type Location } from '../refs'
import { bytes, enumOf, int, num, obj, vec3 } from '../schema'
import { scanBounds } from '../state'
import { CommandError, type Command } from '../types'
import { discardSchema, fileNameSchema, fileOf, lastError, requireDiscardable } from './common'

export const unitsSchema = enumOf(
  MESH_UNITS.map((u) => u.id),
  'What the file’s coordinates are in: mm (the default), cm, m or in. An STL carries no units of its own; PLY and OBJ are taken in millimetres unless told otherwise. Everything is measured in millimetres once read.',
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
  }
}

const open: Command<{ bytes: Uint8Array; name: string; units?: MeshUnits; discard?: boolean }> = {
  name: 'open',
  title: 'Open a scan',
  description:
    'Open a mesh as the scan to measure — STL, PLY or OBJ — in place of the one there is; everything measured on the old one goes with it, so it refuses while the session holds measurements unless discard is true. Returns the scan: name, units, vertex and triangle counts, its bounding box (min and max corners), the box’s centre and its diagonal (size), in millimetres. Not undoable: a new scan starts a new history.',
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
  run: async ({ bytes: data, name, units, discard }) => {
    requireDiscardable(discard, 'opening another scan')
    const { session } = commandHost()
    const before = session.clientRef.current!.scanVersion
    await session.scan.openScan(fileOf(data, name), units ?? 'mm')
    if (session.clientRef.current!.scanVersion === before) {
      throw new CommandError('failed', lastError(`${name} could not be opened.`))
    }
    return { scan: await scanSummary() }
  },
}

/** How many vertices a query hands back unless told otherwise, and at most. */
const QUERY_LIMIT = 1000
const QUERY_MAX = 20_000
/** How far round a direction a normal may lie and still face it, degrees,
 *  unless told otherwise. */
const QUERY_WITHIN_DEG = 30

const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places
const triples = (a: Float32Array, places: number): [number, number, number][] => {
  const out: [number, number, number][] = []
  for (let i = 0; i + 2 < a.length; i += 3) out.push([round(a[i], places), round(a[i + 1], places), round(a[i + 2], places)])
  return out
}

interface QueryIn {
  box?: { min: Vec3; max: Vec3 }
  near?: { at: Vec3; radius: number }
  normal?: { dir: Vec3; withinDeg?: number }
  limit?: number
}

const query: Command<QueryIn> = {
  name: 'query',
  title: 'Read the scan’s points',
  description:
    'The scan’s vertices inside a box, or within a radius of a point, with their outward normals — the points on a face, to measure a dimension or a draft angle off, or to see what the scan has where a model is being built. normal keeps only the vertices facing a direction (within withinDeg, 30 by default): the top face alone, say. At most limit come back (1000 by default, 20000 at most): past it every k-th matching vertex is kept, spread evenly, and step says which k. Returns how many matched, the vertices kept (their numbers, as scan.nearest and element.fit_marked name them), their points and normals in millimetres, in the frame the part is measured in now, the box round the points kept, their centroid and mean normal. Changes nothing.',
  input: obj({
    box: obj({ min: vec3('The lowest corner, mm.'), max: vec3('The highest corner, mm.') }, ['min', 'max'], 'A box in the frame the part is measured in now.'),
    near: obj({ at: vec3('The centre, mm.'), radius: num('How far from it, mm.', { exclusiveMinimum: 0 }) }, ['at', 'radius'], 'A ball about a point — in place of box.'),
    normal: obj(
      { dir: vec3('The direction, any length.'), withinDeg: num('How far from it a normal may lean, degrees; 30 by default.', { exclusiveMinimum: 0, maximum: 180 }) },
      ['dir'],
      'Keep only the vertices whose outward normal faces this way.',
    ),
    limit: int(`How many vertices at most; ${QUERY_LIMIT} by default, ${QUERY_MAX} at most.`, { minimum: 1, maximum: QUERY_MAX }),
  }),
  readOnly: true,
  run: async ({ box, near, normal, limit = QUERY_LIMIT }) => {
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
    const r = await client.query({ min, max, ...(normal && cosLimit !== undefined ? { normal: { dir: normal.dir, cosLimit } } : {}), limit: near ? Math.min(QUERY_MAX, Math.ceil(limit * 1.91)) : limit })
    let vertices = Array.from(r.vertices)
    let positions = r.positions
    let normals = r.normals
    let matched = r.matched
    if (near) {
      const keep: number[] = []
      for (let i = 0; i < vertices.length; i++) {
        const d = Math.hypot(positions[i * 3] - near.at[0], positions[i * 3 + 1] - near.at[1], positions[i * 3 + 2] - near.at[2])
        if (d <= near.radius) keep.push(i)
      }
      // What the ball holds, scaled up from the share of the box's sample
      // that fell inside it.
      matched = r.step > 1 ? Math.round((keep.length / Math.max(1, vertices.length)) * r.matched) : keep.length
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
    return {
      matched,
      returned: n,
      step: near ? Math.max(1, Math.round(matched / Math.max(1, n))) : r.step,
      ...(n > 0
        ? {
            bounds: { min: lo.map((v) => round(v, 4)), max: hi.map((v) => round(v, 4)) },
            centroid: centroid.map((v) => round(v, 4)),
            meanNormal: nl > 0 ? meanNormal.map((v) => round(v / nl, 4)) : null,
          }
        : {}),
      vertices,
      points: triples(positions, 4),
      normals: triples(normals, 3),
    }
  },
}

const nearest: Command<{ at: Location }> = {
  name: 'nearest',
  title: 'Find a place on the scan',
  description:
    'Where a location lands on the scan: the vertex (a point snaps to the nearest one), its coordinates and outward normal, a triangle it is a corner of, and how far it is from the point asked about. Use it to check a point lies on the surface before fitting there.',
  input: obj({ at: locationSchema('The place on the scan.') }, ['at']),
  readOnly: true,
  run: async ({ at }) => resolveLocation(at),
}

export const scanCommands = [open, nearest, query]

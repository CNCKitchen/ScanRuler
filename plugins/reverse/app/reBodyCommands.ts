// SPDX-License-Identifier: AGPL-3.0-only
// reverse.body.*: a body described, shown and hidden, its clearance to the
// scan, compared with the scan face by face, checked and audited, and
// written out as STEP or STL.

import { invalid } from '../../../src/commands/core/common'
import { featuresOut, PATCH_KIND_WORDS, patchFigures, readingInput, type Reading, referenceHotspots, scanFeaturePatches, setReading } from '../../../src/commands/core/deviation'
import { arr, bool, enumOf, int, num, obj, oneOf, str, vec3 } from '../../../src/commands/schema'
import { MESH_FORMATS, MESH_FORMAT_LABEL, type MeshFormat } from '../../../src/core/exportMesh'
import { describeDeviation, referenceFigures, referenceSpacing } from '../../../src/commands/state'
import { errorMessage } from '../../../src/commands/types'
import { round3 } from '../../../src/core/round'
import type { Vec3 } from '../../../src/core/types'
import { type Command, CommandError } from '../../../src/plugins/api'
import { useDeviation } from '../../../src/state/deviationStore'
import { useStore } from '../../../src/state/store'
import { ASK_MM, AUDIT_DEFAULTS, auditBody, type FaceTrace, type Finding, traceFace } from '../core/audit'
import { COMPARE_REFERENCE_NAME, VIEW_MESH_MAP_TOLERANCE } from '../core/compare'
import type { FarPatch, PatchReading, PatchRequest } from '../core/compareDetail'
import { bodyMaker, type Feature } from '../core/features'
import { meshFaultOut } from '../core/kernelMesh'
import type { KernelMesh } from '../core/kernelTypes'
import type { StepCheck, StepEdge, StepFace, StepMend, StepShell } from '../core/kernel'
import { meshDeflection, type RoundTrip } from '../core/buildTypes'
import { DEFAULT_FACING_DEG, liveMapReach, type ScanSide, type SideCounts } from '../core/liveMap'
import { roundFaceIsBoss } from '../core/thread'
import { useRePrefs } from '../state/rePrefs'
import { BODY_SWATCHES, bodyColorOf } from '../state/reStore'
import { allFeatures, bodyAt, bodyNamed, change, featureNamed, knowMesh, nullable, re, ready, type Ref, session, type Topology, topologyOf, type Where, whereIndices } from './reCommandCore'
import { bodiesOut, edgeOut, faceOut, idleParametersOut } from './reReadout'
import { bodyRef, featureRef, whereIn } from './reSchemas'
import { compareInDeviation, type ReverseSession } from './reSession'
import { nearestOnBodies } from '../core/notes'
import { compareFeature } from './reCompareFeature'
import { volumeInView } from './reVolumeCompare'
import { loopsOf, planOpenSaid, planVerdict, usePlan } from './rePlan'

export const describe: Command<{ body?: Ref; edges?: boolean; before?: Ref; where?: Where; exclude?: Where; limit?: number; fingerprints?: boolean; sort?: 'largest' | 'smallest' }> = {
  name: 'describe',
  title: 'Describe a body',
  description:
    'A body’s faces and edges, as a feature picks them: each face’s index, kind (plane, cylinder, cone, sphere, torus), area, centroid, normal or axis, radius and diameter, a round face’s length and side (boss — outward, a bolt’s — or bore) and the feature that made it; each edge’s index, kind, length, middle, ends and the faces either side (by index). Pick a face or an edge by its index in reverse.feature.add — the feature keeps its fingerprint and finds it again on every rebuild. Without body, every body. where keeps only what answers a query — a box, a point and a radius, a kind, the normals of the faces either side of an edge, the feature that made it, a size — matched says how many did, of how many; exclude leaves out what answers another query ({ madeBy: "Thread 1" } drops a thread’s faces); limit caps each list; fingerprints: true adds each one’s fingerprint, to pick it by. before: the body as it stood before that feature — what the feature’s own picks by index name (reverse.feature.update) — the feature’s body when body is left out. edges: false leaves the edges out.',
  input: obj({
    body: bodyRef,
    edges: bool('List the edges too (the default).'),
    before: featureRef(),
    where: whereIn,
    exclude: { type: 'object', description: 'Leave out what answers this query (as where takes it) — { madeBy: "Thread 1" } drops a thread’s faces.' },
    limit: int('How many faces, and how many edges, at most — with sort the largest or smallest.', { minimum: 1 }),
    fingerprints: bool('Give each face’s and edge’s fingerprint too (off by default) — a pick by index needs none.'),
    sort: enumOf(['largest', 'smallest'], 'The faces by area and the edges by length, largest or smallest first.'),
  }),
  readOnly: true,
  run: async ({ body, edges = true, before, where, exclude, limit, fingerprints = false, sort }) => {
    const s = await ready()
    const feature = before !== undefined ? featureNamed(before) : null
    if (feature && !re().features.includes(feature)) throw new CommandError('invalid_state', `${feature.name} is below the rollback bar — the part is not built up to it.`)
    const own = feature && 'body' in feature && typeof feature.body === 'number' ? feature.body : null
    if (feature && body === undefined && own === null) invalid(`${feature.name} works on no body — name the body (body).`)
    const bodies = feature ? [body !== undefined ? (typeof body === 'number' ? bodyAt(body) : bodyNamed(body)) : bodyAt(own!)] : body !== undefined ? [bodyNamed(body)] : re().bodies
    const out = bodiesOut(s)
    const strip = <T extends { fingerprint: unknown }>(row: T) => {
      if (fingerprints) return row
      const { fingerprint: _fp, ...rest } = row
      void _fp
      return rest
    }
    const described = []
    for (const b of bodies) {
      let t: Topology
      let mesh = s.meshes.get(b.id)
      if (feature) {
        const staged = await s.staged(feature.id, b.id).catch(() => null)
        if (!staged) throw new CommandError('not_found', `${feature.name} did not work on ${b.name}, or the part as it stood before it is not kept — build again (reverse.build) and ask once more.`)
        t = staged.topology
        mesh = staged.mesh
        // where.sharp reads how faces meet off the mesh of the topology.
        if (mesh) knowMesh(t, mesh)
      } else t = topologyOf(s, b)
      const faceIndex = new Map(t.faces.map((f, i) => [f.hash, i]))
      // What answers where, less what answers exclude.
      const pick = (what: 'face' | 'edge', all: number) => {
        const ids = where ? whereIndices(where, t, b, what) : [...Array(all).keys()]
        const gone = exclude ? new Set(whereIndices(exclude, t, b, what)) : null
        return gone ? ids.filter((i) => !gone.has(i)) : ids
      }
      // A query only edges can answer lists the edges, and says so.
      const edgeTerms = edges && where ? EDGE_ONLY.filter((k) => (where as Record<string, unknown>)[k] !== undefined) : []
      const faces = edgeTerms.length > 0 ? [] : pick('face', t.faces.length).map((i) => ({ f: t.faces[i], i }))
      const edgeRows = edges ? pick('edge', t.edges.length).map((i) => ({ e: t.edges[i], i })) : []
      if (sort) {
        const dir = sort === 'largest' ? -1 : 1
        faces.sort((x, y) => dir * (x.f.fingerprint.area - y.f.fingerprint.area))
        edgeRows.sort((x, y) => dir * (x.e.fingerprint.length - y.e.fingerprint.length))
      }
      described.push({
        ...(out.find((x) => x.id === b.id) ?? { id: b.id, name: b.name }),
        ...(feature ? { before: { id: feature.id, name: feature.name } } : {}),
        matched: { faces: faces.length, ...(edges ? { edges: edgeRows.length } : {}) },
        of: { faces: t.faces.length, ...(edges ? { edges: t.edges.length } : {}) },
        ...(edgeTerms.length > 0 ? { facesLeftOut: `${edgeTerms.join(' and ')} ${edgeTerms.length === 1 ? 'picks' : 'pick'} edges: no faces listed` } : {}),
        faceList: faces.slice(0, limit ?? faces.length).map(({ f, i }) => strip(faceOut(f, i, mesh))),
        ...(edges ? { edgeList: edgeRows.slice(0, limit ?? edgeRows.length).map(({ e, i }) => strip(edgeOut(e, i, faceIndex))) } : {}),
      })
    }
    return { bodies: described }
  },
}

/** The terms of a query that only edges answer. */
const EDGE_ONLY = ['sides', 'through', 'loop'] as const

export const bodySet: Command<{ body: Ref; name?: string | null; color?: string | null; visible?: boolean }> = {
  name: 'set',
  title: 'Name, colour, show or hide a body',
  description:
    `Give a body a name and a colour of its own, as its row in the panel does — what a STEP export calls the part and paints it. name: null or empty takes it back to Solid n. color: #rrggbb, #rgb, or one of ${BODY_SWATCHES.map((x) => `"${x.name}"`).join(', ')} (null takes it back to the one it had). visible: false hides it, as its eye in the body list does — out of the view, the pictures and what takes the visible bodies when none are named (the STEP and STL export, the comparisons); true shows it again. The name and the colour are one undo step; nothing is rebuilt. Returns the body.`,
  input: obj(
    {
      body: bodyRef,
      name: nullable(str('The name.'), 'The body’s name; null for Solid n again.'),
      color: nullable(str('#rrggbb, #rgb or a colour by name.'), 'Its colour; null for the one it had.'),
      visible: bool('Show the body (true) or hide it (false).'),
    },
    ['body'],
  ),
  label: ({ body, name, color, visible }) => (typeof name === 'string' ? `name body “${name}”` : color !== undefined ? `colour body ${String(body)}` : `${visible ? 'show' : 'hide'} body ${String(body)}`),
  run: async ({ body, name, color, visible }) => {
    if (name === undefined && color === undefined && visible === undefined) invalid('Give a name, a color, visible, or more than one.')
    const b = bodyNamed(body)
    const hex = typeof color === 'string' ? bodyColorOf(color) : color
    if (hex === null && typeof color === 'string') invalid(`“${color}” is no colour — give #rrggbb, #rgb or one of ${BODY_SWATCHES.map((x) => x.name).join(', ')}.`)
    if (typeof name === 'string' && name.trim() && re().bodies.some((x) => x.id !== b.id && x.name.toLowerCase() === name.trim().toLowerCase())) invalid(`Another body is called “${name.trim()}” — bodies go by their names in the commands and in a STEP file; give it another.`)
    await change(() => {
      if (name !== undefined || color !== undefined) re().setBodyStyle(b.id, { ...(name !== undefined ? { name } : {}), ...(color !== undefined ? { color: hex } : {}) })
      if (visible !== undefined) re().setBodiesVisible([b.id], visible)
    })
    return { body: bodiesOut(session()).find((x) => x.id === b.id) ?? null }
  },
}

export const clearance: Command<{ body: Ref; against?: Ref[] }> = {
  name: 'clearance',
  title: 'How bodies stand to each other',
  description:
    'The clearance between a body and others — every other solid body by default: for each, the least distance between the two (gap, mm), or, where they touch or run into each other, a gap of 0 and the volume they share (overlap, mm³) — the check that a part fits its case, a board its standoffs. Nearest first. Changes nothing.',
  input: obj({ body: bodyRef, against: arr(bodyRef, 'The bodies to measure it against; every other solid one by default.', { minItems: 1 }) }, ['body']),
  readOnly: true,
  run: async ({ body, against }) => {
    const s = await ready()
    const b = bodyNamed(body)
    if (b.surface) invalid(`${b.name} is a surface — a clearance is between solids.`)
    const others = against ? against.map(bodyNamed) : re().bodies.filter((x) => x.id !== b.id && !x.surface)
    if (others.some((x) => x.id === b.id)) invalid('A body is not measured against itself.')
    if (others.length === 0) throw new CommandError('invalid_state', 'There is no other solid body to measure it against.')
    const client = s.client()
    if (!client) throw new CommandError('unavailable', 'The CAD kernel is not running.')
    const rows = []
    for (const o of others) {
      const r = await client.clearance(b.id, o.id).catch((e) => {
        throw new CommandError('failed', errorMessage(e))
      })
      rows.push({ id: o.id, name: o.name, gap: r.gap, ...(r.overlap > 0 ? { overlap: r.overlap } : {}), ...(r.gap === 0 ? { touching: true } : {}) })
    }
    rows.sort((x, y) => x.gap - y.gap || (y.overlap ?? 0) - (x.overlap ?? 0))
    return { body: { id: b.id, name: b.name }, against: rows }
  },
}

/** How many worst spots, faces and patches a comparison names unless told
 *  otherwise. */
const COMPARE_SPOTS = 8

const COMPARE_FACES = 12

const COMPARE_PATCHES = 8

/** How many features byFeature names unless told otherwise, the worst
 *  first. */
const COMPARE_FEATURES = 8

/** How far past the reach the scan is still looked for, mm — far enough
 *  to read the wall of a hole or a pocket that was never cut, deep in a
 *  part's thickness, and not so far that a vertex off every body opens the
 *  whole tree looking. */
const COMPARE_FAR_MM = 25

/** What detail: "score" names unless told otherwise — the loop's answer:
 *  the patches, the far patches a side and the features, the worst first. */
const SCORE_PATCHES = 5
const SCORE_FAR = 2
const SCORE_FEATURES = 3

type CompareIn = { bodies?: Ref[]; range?: number; spots?: number; faces?: number; patches?: number; features?: number; patchVertices?: boolean; tolerance?: number; grain?: number; within?: { min: Vec3; max: Vec3 }; far?: number; feature?: Ref; picture?: boolean; at?: Vec3; facingDeg?: number | null; unfacing?: 'keep' | 'drop'; skin?: 'outer'; detail?: 'score' | 'full' }

export const compare: Command<CompareIn> = {
  name: 'compare',
  title: 'Compare the bodies with the scan',
  description:
    `How far the scan lies from the bodies — the live deviation map’s reading as a score to iterate on, and where it is off: the scan’s signed distance to the bodies at the vertices within reach — read, share, within, mean, rms, p50, p95 — then patches, the connected regions over tolerance (centre, box, area, vertices, mean, extreme, ${PATCH_KIND_WORDS}, side and the nearest face with its maker), worst, faces, byFeature, far (the scan past every body’s reach, by side: a hole not cut or a boss not modelled shows here and nowhere else) and volume (the last reverse.body.volume_compare). detail: "score" is the answer to iterate by between steps; feature reads one feature’s faces alone, with numbers and, picture: true, a section across it; facingDeg and skin: "outer" say which surface a vertex is read against. The visible solids by default. Needs a scan. Changes nothing.`,
  input: obj({
    bodies: arr(bodyRef, 'The bodies; the visible solid ones by default.', { minItems: 1 }),
    range: num('± mm counted as on the scan.', { exclusiveMinimum: 0 }),
    spots: int('How many worst spots to name; 8 by default, 50 at most.', { minimum: 0, maximum: 50 }),
    faces: int('How many faces to list; 12 by default, 200 at most.', { minimum: 0, maximum: 200 }),
    patches: int('How many patches over tolerance to name; 8 by default, 50 at most; 0 for none.', { minimum: 0, maximum: 50 }),
    features: int('How many features byFeature names, the worst first; 8 by default; 0 for none.', { minimum: 0, maximum: 200 }),
    patchVertices: bool('Give each patch a few of its scan vertices (off by default).'),
    tolerance: num('± mm a vertex is over when its reading is past; the range by default.', { exclusiveMinimum: 0 }),
    grain: num('How close two vertices over tolerance must be to share a patch, mm; three point spacings by default.', { exclusiveMinimum: 0 }),
    within: obj({ min: vec3('The lowest corner, mm.'), max: vec3('The highest corner, mm.') }, ['min', 'max'], 'Only the scan inside this box, in the part’s frame.'),
    far: num(`How far past the reach the far reading looks, mm; ${COMPARE_FAR_MM} by default; 0 for no far reading.`, { minimum: 0 }),
    feature: featureRef(),
    picture: bool('With feature: a picture of a section across it too.'),
    at: vec3('With feature and picture: cut the place of the feature nearest this point.'),
    facingDeg: nullable(num(undefined, { minimum: 1, maximum: 90 }), `The facing limit, degrees; ${DEFAULT_FACING_DEG} by default; null for the nearest surface whatever it faces.`),
    unfacing: enumOf(['keep', 'drop'], 'A vertex no surface faces: read against the nearest ("keep", the default) or left out ("drop").'),
    skin: enumOf(['outer'], 'Read only the scan facing out of the model — the outer skin of a body not hollowed yet.'),
    detail: enumOf(['score', 'full'], `"score": the figures, the ${SCORE_PATCHES} largest patches, far by counts and its ${SCORE_FAR} largest a side, the ${SCORE_FEATURES} worst features — between steps; "full" (the default): everything.`),
  }),
  readOnly: true,
  long: true,
  returnsImage: true,
  run: async (input) => {
    if (!useStore.getState().fileName) throw new CommandError('no_scan', 'There is no scan to compare the bodies with.')
    if (input.detail === 'score' && input.feature !== undefined) invalid('detail: "score" is of the bodies against the scan — leave it out with feature, whose answer is of that feature alone.')
    const s = await ready()
    if (input.detail === 'score') {
      if (input.picture) invalid('picture: a picture is of one feature — give feature too.')
      const out = await compareBodies(s, { ...input, spots: 0, faces: 0, patches: input.patches ?? SCORE_PATCHES, features: input.features ?? SCORE_FEATURES })
      return { ...scoreOf(out), volume: volumeInView(s, out.bodies.map((b) => b.id)) }
    }
    if (input.feature !== undefined) {
      const range = input.range ?? useRePrefs.getState().liveMapRange
      const out = await compareFeature(s, input.feature, { range, tolerance: input.tolerance, far: input.far ?? COMPARE_FAR_MM, picture: input.picture === true, spots: input.spots ?? COMPARE_SPOTS, faces: input.faces ?? COMPARE_FACES, patches: input.patches ?? COMPARE_PATCHES, grain: input.grain, ...(input.at ? { at: input.at } : {}) }, (ids, box, ask) =>
        compareBodies(s, { ...input, bodies: ids, within: box, faces: 200, patches: ask.patches, spots: ask.spots, features: 0 }, ask.faces),
      )
      return { ...out, volume: volumeInView(s, comparedIds(input.bodies)) }
    }
    if (input.picture) invalid('picture: a picture is of one feature — give feature too.')
    if (input.at) invalid('at: a place is of one feature’s picture — give feature and picture too.')
    const out = await compareBodies(s, input)
    // The volume compare kept in view: its totals, or since when it is owed.
    return { ...out, volume: volumeInView(s, out.bodies.map((b) => b.id)) }
  },
}

/** The solid bodies a comparison reads: those named, or the visible ones. */
const comparedIds = (bodies?: Ref[]): number[] => (bodies ? bodies.map(bodyNamed) : re().bodies.filter((b) => b.visible && !b.surface)).filter((b) => !b.surface).map((b) => b.id)

/** The bodies against the scan — reverse.body.compare without a feature;
 *  with `on`, the patches and the worst spots kept to those faces. */
export async function compareBodies(s: ReverseSession, { bodies, range, spots = COMPARE_SPOTS, faces: faceCount = COMPARE_FACES, patches: patchCount = COMPARE_PATCHES, features: featureCount = COMPARE_FEATURES, patchVertices = false, tolerance, grain, within: box, far = COMPARE_FAR_MM, facingDeg, unfacing, skin }: CompareIn, on?: PatchRequest['faces']) {
  const picked = bodies ? bodies.map(bodyNamed) : re().bodies.filter((b) => b.visible && !b.surface)
  if (picked.length === 0) throw new CommandError('invalid_state', 'There is no solid body to compare — build one first.')
  const within = range ?? useRePrefs.getState().liveMapRange
  if ((await s.syncScan()) === 'none') throw new CommandError('unavailable', 'The scan could not be handed to the CAD kernel for the comparison.')
  const side: Omit<ScanSide, 'normals'> = { facingDeg: facingDeg === undefined ? DEFAULT_FACING_DEG : facingDeg, ...(unfacing ? { unfacing } : {}), ...(skin ? { skin } : {}) }
  const detail = await s.bodiesCompare(picked.map((b) => b.id), within, spots, { count: patchCount, tolerance: tolerance ?? within, ...(grain !== undefined ? { grain } : {}), ...(on ? { faces: on } : {}) }, box, far > 0 ? far : undefined, side)
  const v = detail.field.values
  const n = v.length
  let sum = 0, sumSq = 0, outside = -Infinity, inside = Infinity, withinCount = 0
  for (let i = 0; i < n; i++) {
    const d = v[i]
    sum += d
    sumSq += d * d
    if (d > outside) outside = d
    if (d < inside) inside = d
    if (Math.abs(d) <= within) withinCount++
  }
  const abs = Float32Array.from(v, Math.abs).sort()
  const pct = (p: number) => (n ? abs[Math.min(n - 1, Math.floor(p * n))] : null)
  const { bodyName: name, faceOf } = faceLookup(s)
  const rows = detail.faces.map((r) => ({ body: { id: r.body, name: name(r.body) }, face: faceOf(r.body, r.faceHash), read: r.read, within: r.within, mean: round3(r.sum / r.read), rms: round3(Math.sqrt(r.sumSq / r.read)), outside: round3(r.outside), inside: round3(r.inside), sum: r.sum, sumSq: r.sumSq }))
  rows.sort((a, b) => Math.max(b.outside, -b.inside) - Math.max(a.outside, -a.inside))
  const byFeature = new Map<number, { id: number; name: string | null; faces: number; read: number; within: number; sum: number; sumSq: number; outside: number; inside: number }>()
  for (const r of rows) {
    const id = r.face?.madeBy.id ?? -1
    const g = byFeature.get(id) ?? { id, name: r.face?.madeBy.name ?? null, faces: 0, read: 0, within: 0, sum: 0, sumSq: 0, outside: 0, inside: 0 }
    g.faces++
    g.read += r.read
    g.within += r.within
    g.sum += r.sum
    g.sumSq += r.sumSq
    g.outside = Math.max(g.outside, r.outside)
    g.inside = Math.min(g.inside, r.inside)
    byFeature.set(id, g)
  }
  return {
    bodies: picked.map((b) => ({ id: b.id, name: b.name })),
    ...(box ? { box } : {}),
    range: within,
    reach: liveMapReach(within),
    scanVertices: useStore.getState().vertexCount,
    read: n,
    share: n / Math.max(1, useStore.getState().vertexCount),
    within: withinCount,
    mean: n ? sum / n : null,
    rms: n ? Math.sqrt(sumSq / n) : null,
    outside: n ? outside : null,
    inside: n ? inside : null,
    p50: pct(0.5),
    p95: pct(0.95),
    patches: detail.patches.map((p: PatchReading) => ({
      ...patchFigures(p),
      side: p.extreme > 0 ? 'outside' : 'inside',
      at: p.at.map(round3),
      vertex: p.vertex,
      ...(patchVertices ? { vertices: p.vertices } : {}),
      body: { id: p.body, name: name(p.body) },
      face: faceOf(p.body, p.faceHash),
    })),
    patchesFound: detail.patchesFound,
    features: featuresOut(detail.features),
    over: detail.over,
    tolerance: tolerance ?? within,
    ...(detail.far
      ? {
          far: {
            reach: detail.far.reach,
            count: detail.far.count,
            share: detail.far.count / Math.max(1, useStore.getState().vertexCount),
            inside: farSide(detail.far.inside, 'inside', patchVertices),
            outside: farSide(detail.far.outside, 'outside', patchVertices),
          },
        }
      : {}),
    ...(detail.spacing > 0 ? { spacing: round3(detail.spacing) } : {}),
    side: sideOut(side, detail.side),
    worst: detail.spots.map((sp) => ({ at: sp.at.map(round3), deviation: round3(sp.value), body: { id: sp.body, name: name(sp.body) }, face: faceOf(sp.body, sp.faceHash) })),
    faces: rows.slice(0, faceCount).map(({ sum: _s, sumSq: _q, ...row }) => {
      void _s
      void _q
      return row
    }),
    ...(featureCount > 0
      ? {
          byFeature: [...byFeature.values()]
            .map((g) => ({ id: g.id, name: g.name, faces: g.faces, read: g.read, within: g.within, mean: round3(g.sum / g.read), rms: round3(Math.sqrt(g.sumSq / g.read)), outside: round3(g.outside), inside: round3(g.inside) }))
            .sort((a, b) => Math.max(b.outside, -b.inside) - Math.max(a.outside, -a.inside))
            .slice(0, featureCount),
        }
      : {}),
    ...(byFeature.size > featureCount ? { featuresFound: byFeature.size } : {}),
  }
}

export type BodiesCompared = Awaited<ReturnType<typeof compareBodies>>

/** A comparison as detail: "score" gives it — the figures to iterate a
 *  model by and where it is off, without what only the last look needs:
 *  the patches without their scan vertex and side (the sign of mean says
 *  it), the body only when there are several, far by its counts and its
 *  largest patches a side, no worst spots and no face rows. */
export function scoreOf(out: BodiesCompared) {
  const several = out.bodies.length > 1
  const r2 = (p: readonly number[]) => p.map((v) => Math.round(v * 100) / 100)
  const r1 = (v: number) => Math.round(v * 10) / 10
  type Read = (typeof out.patches)[number]
  type FarRead = Omit<Read, 'body' | 'face'> & { body: Read['body'] | null; face: Read['face'] }
  // A patch to the hundredth of a millimetre, its vertex count left to its
  // area; past the reach, where it is and how large alone.
  const slim = (p: FarRead) => ({ centroid: r2(p.centroid), box: { min: r2(p.box.min), max: r2(p.box.max) }, area: r1(p.area), mean: p.mean, extreme: p.extreme, depth: p.depth, volume: r1(p.volume), kind: p.kind, at: r2(p.at), ...('vertices' in p && p.vertices ? { vertices: p.vertices } : {}), face: p.face, ...(several ? { body: p.body } : {}) })
  const farSlim = (side: { count: number; found: number; patches: FarRead[] }) => ({
    count: side.count,
    found: side.found,
    largest: side.patches.slice(0, SCORE_FAR).map((p) => ({ centroid: r2(p.centroid), box: { min: r2(p.box.min), max: r2(p.box.max) }, area: r1(p.area), depth: p.depth, volume: r1(p.volume), kind: p.kind, face: p.face, ...(several ? { body: p.body } : {}) })),
  })
  return {
    ...(several ? { bodies: out.bodies } : {}),
    ...(out.box ? { box: out.box } : {}),
    range: out.range,
    tolerance: out.tolerance,
    read: out.read,
    share: round3(out.share),
    within: out.within,
    withinShare: out.read ? round3(out.within / out.read) : null,
    mean: out.mean === null ? null : round3(out.mean),
    rms: out.rms === null ? null : round3(out.rms),
    p50: out.p50 === null ? null : round3(out.p50),
    p95: out.p95 === null ? null : round3(out.p95),
    patchesFound: out.patchesFound,
    over: out.over,
    features: { count: out.features.count, shareOfExcess: out.features.shareOfExcess },
    patches: out.patches.map(slim),
    ...(out.far ? { far: { count: out.far.count, share: round3(out.far.share), inside: farSlim(out.far.inside), outside: farSlim(out.far.outside) } } : {}),
    ...(out.byFeature ? { byFeature: out.byFeature } : {}),
  }
}

/** How a comparison read the scan by its side, as the answer gives it:
 *  the limit and what it left out, or why it read the nearest surface. */
function sideOut(side: Omit<ScanSide, 'normals'>, counts: SideCounts | undefined) {
  if (!counts) return { off: 'the scan came without its normals: every vertex read against the nearest surface, whatever it faces, a sheet on both sides' }
  return { facingDeg: side.facingDeg, ...(side.skin ? { skin: side.skin } : {}), refaced: counts.refaced, [side.unfacing === 'drop' ? 'unfacingDropped' : 'unfacingKept']: counts.unfacing, back: counts.back, inward: counts.inward }
}

/** The meshes of the bodies compared alone, which the patches on them are
 *  told by: a hidden sheet, or a body left out, nearer a patch still names
 *  none. */
export function comparedMeshes(meshes: ReadonlyMap<number, KernelMesh>, ids: readonly number[]): Map<number, KernelMesh> {
  return new Map([...meshes].filter(([id]) => ids.includes(id)))
}

/** How many patches of each kind the map on the bodies names. */
const ON_REFERENCE_PATCHES = 6

/** The map the other way round after a Compare in Deviation: the bodies,
 *  the reference now, read against the scan — its figures and its patches,
 *  each told by the body face nearest it and the feature that made it —
 *  among the bodies compared alone, so a hidden sheet or a body left out
 *  never names a patch. A map that could not be measured leaves it out,
 *  saying why. */
async function bodiesOnScan(ids: readonly number[]): Promise<Record<string, unknown>> {
  let read: Awaited<ReturnType<typeof referenceHotspots>>
  try {
    read = await referenceHotspots(undefined, ON_REFERENCE_PATCHES, undefined)
  } catch (e) {
    return { onReference: { error: errorMessage(e) } }
  }
  const s = session()
  const compared = comparedMeshes(s.meshes, ids)
  const faceAt = (p: readonly number[]) => {
    const near = nearestOnBodies(compared, [p[0], p[1], p[2]])
    if (!near) return {}
    const faces = s.topologies.get(near.body)?.faces ?? []
    const index = faces.findIndex((f) => f.hash === near.faceHash)
    if (index < 0) return {}
    const fp = faces[index].fingerprint
    return { face: { body: re().bodies.find((b) => b.id === near.body)?.name ?? near.body, index, kind: fp.kind, madeBy: { id: fp.origin, name: allFeatures().find((f) => f.id === fp.origin)?.name ?? null } } }
  }
  const withFace = <P extends { centroid: number[]; at?: number[] }>(p: P) => ({ ...p, ...faceAt(p.at ?? p.centroid) })
  return {
    onReference: {
      ...referenceFigures(),
      features: read.features,
      patches: read.patches.map(withFace),
      far: { ...read.far, outside: { ...read.far.outside, patches: read.far.outside.patches.map(withFace) }, inside: { ...read.far.inside, patches: read.far.inside.patches.map(withFace) } },
      noScan: { ...read.noScan, patches: read.noScan.patches.map(withFace) },
    },
  }
}

export const compareInDeviationCommand: Command<{ bodies?: Ref[]; ways?: 'both' | 'scan' } & Reading> = {
  name: 'compare_in_deviation',
  title: 'Compare in Deviation',
  description:
    `The panel’s Compare in Deviation: the bodies go to the Deviation workspace as its reference part (meshed to a 0.01 mm chord, named "Bodies from Reverse engineer.stl") and the scan is measured against them there, in the scan’s own frame — no best fit, the alignment is the identity (built), so the offset the comparison is for is not hidden. The search distance stays as it was, by hand or automatic, so runs around an edit read alike; tolerance, range and maxDistance set the reading first and stay so. Returns the reference’s name, the map’s statistics, referenceSpacing, onReference (the bodies read against the scan: backedPct, withinTolerancePct, farPct, noScanPct, its patches, far.outside, far.inside and noScan, each patch with the nearest body face and madeBy), volume (the last reverse.body.volume_compare) and, with a plan set, plan (target, got, met, regions, removed) with next: "not done: …" short of it. ways: "scan" skips the map on the bodies. The visible solids by default; a sheet named is read on its front only (the facing limit turned on at ${DEFAULT_FACING_DEG}°, facingOn); from ${VIEW_MESH_MAP_TOLERANCE} mm tolerance the bodies are read on their viewport meshes (chord ${meshDeflection(Infinity)} mm). One undo step. Needs a scan.`,
  input: obj({
    bodies: arr(bodyRef, 'The bodies; the visible solid ones by default; a sheet when named.', { minItems: 1 }),
    ways: enumOf(['both', 'scan'], 'both (the default): scan against bodies and bodies against scan; scan: the scan against the bodies only, quicker.'),
    tolerance: { ...readingInput.tolerance, description: 'Tolerance, ± mm, set as deviation.settings sets it before the comparison; the workspace’s own when left out.' },
    range: { ...readingInput.range, description: 'Colour scale, ± mm, as deviation.settings sets it.' },
    maxDistance: { ...readingInput.maxDistance, description: 'Search distance, mm, as deviation.settings sets it — then set by hand, no longer automatic.' },
  }),
  run: async ({ bodies, ways = 'both', tolerance, range, maxDistance }) => {
    if (!useStore.getState().fileName) throw new CommandError('no_scan', 'There is no scan to compare the bodies with.')
    await ready()
    const picked = bodies ? bodies.map(bodyNamed) : re().bodies.filter((b) => b.visible && !b.surface)
    if (picked.length === 0) throw new CommandError('invalid_state', 'There is no solid body to compare — build one first.')
    // A sheet has no inside: only the facing limit keeps the scan behind
    // it from reading against its front.
    const facingOn = picked.some((b) => b.surface) && useDeviation.getState().mapFacingDeg === null
    if (facingOn) useDeviation.getState().setMapFacing(DEFAULT_FACING_DEG)
    const run = compareInDeviation()
    if (!run) throw new CommandError('unavailable', 'The Reverse engineer workspace is not set up.')
    // The reading asked for, before the map is measured under it — the
    // tolerance also says which meshes the bodies are read on.
    setReading({ tolerance, range, maxDistance })
    // One way only: the map painted on the scan, so neither the measure
    // nor the watcher reads the bodies against the scan behind it.
    if (ways === 'scan' && useDeviation.getState().mapOn === 'reference') useDeviation.getState().setMapOn('scan')
    try {
      await run(picked.map((b) => b.id))
    } catch (e) {
      throw new CommandError('failed', errorMessage(e))
    }
    const onScan = ways === 'scan' ? { onReference: { skipped: 'ways: "scan" — the bodies were not read against the scan; deviation.settings { on: "reference" } reads them now, or compare_in_deviation without ways' } } : await bodiesOnScan(picked.map((b) => b.id))
    const deviation = describeDeviation()
    return { reference: COMPARE_REFERENCE_NAME, bodies: picked.map((b) => ({ id: b.id, name: b.name, ...(b.surface ? { sheet: true } : {}) })), ...(facingOn ? { facingOn: `the facing limit was off; it is ${DEFAULT_FACING_DEG}° now, for the sheets` } : {}), reading: setReading({}), deviation, referenceSpacing: referenceSpacing(), ...onScan, volume: volumeInView(session(), picked.filter((b) => !b.surface).map((b) => b.id)), ...(await planOn(deviation.stats)) }
  },
}

/** The plan's verdict on a comparison in Deviation (rePlan): the share
 *  within T of the scan measured — or, for a target on the model side, of
 *  the bodies' area — at the tolerance read, with the feature patches the
 *  scan's map holds over T, its next lifted to the top; and the loops the
 *  session's reviews made, or that there were none. */
async function planOn(stats: ReturnType<typeof describeDeviation>['stats']): Promise<Record<string, unknown>> {
  const side = usePlan.getState().plan?.target.side ?? 'scan'
  const within = side === 'model' ? (referenceFigures()?.withinTolerancePct ?? null) : stats && stats.measured > 0 ? (stats.withinTolerance / stats.measured) * 100 : null
  const tolerance = useDeviation.getState().tolerance
  const featurePatches = within === null ? [] : (await scanFeaturePatches(tolerance)).map((p) => ({ at: p.at, depth: p.depth, outside: p.outside }))
  const verdict = planVerdict(session(), within === null ? null : { withinT: within, tolerance, featurePatches })
  const loops = loopsOf(session()) ?? { reviews: 0, note: 'no reverse.body.review this session — the design loop was not run' }
  if (!verdict) return { loops, ...idleParametersOut() }
  const { next, ...plan } = verdict
  return { plan, loops, ...idleParametersOut(), ...(next ? { next } : {}) }
}

/** Names for the bodies and faces a comparison's answer points at: a body
 *  by its id, a face by its hash — its index, its kind and the feature that
 *  made it. */
export function faceLookup(s: ReverseSession) {
  const bodyName = (id: number) => re().bodies.find((b) => b.id === id)?.name ?? `Body ${id}`
  const faceOf = (body: number, hash: number) => {
    const t = s.topologies.get(body)
    const i = t ? t.faces.findIndex((f) => f.hash === hash) : -1
    if (!t || i < 0) return null
    const fp = t.faces[i].fingerprint
    return { index: i, kind: fp.kind, madeBy: { id: fp.origin, name: allFeatures().find((f) => f.id === fp.origin)?.name ?? null } }
  }
  return { bodyName, faceOf }
}

/** One side of a comparison's far reading, as the answer gives it. */
function farSide(side: { count: number; patches: FarPatch[]; found: number }, name: 'inside' | 'outside', withVertices: boolean) {
  const { bodyName, faceOf } = faceLookup(session())
  return {
    count: side.count,
    found: side.found,
    patches: side.patches.map((p) => ({
      ...patchFigures(p),
      side: name,
      at: p.at.map(round3),
      vertex: p.vertex,
      ...(withVertices ? { vertices: p.vertices } : {}),
      body: p.body !== null ? { id: p.body, name: bodyName(p.body) } : null,
      face: p.body !== null && p.faceHash !== null ? faceOf(p.body, p.faceHash) : null,
    })),
  }
}

/** What a body is looked over for unless told otherwise: a face under this
 *  area, mm², is a sliver. */
const TINY_FACE_MM2 = 0.01

/** How narrow a face may be, mm — twice its area over its perimeter —
 *  before reverse.body.check lists it as narrow (the builder's sliver
 *  width). */
const NARROW_MM = 0.01

/** A face of a body by hash, as an answer names it: its index in
 *  reverse.body.describe (on the topology given), its kind and the
 *  feature that made it — the origin given, else the topology's. */
function faceNamer(t: Topology | undefined, features: readonly Feature[]) {
  return (hash: number, origin?: number) => {
    const i = t ? t.faces.findIndex((f) => f.hash === hash) : -1
    const fp = i >= 0 ? t!.faces[i].fingerprint : null
    const made = origin ?? fp?.origin
    return { index: i >= 0 ? i : null, ...(fp ? { kind: fp.kind } : {}), ...(made !== undefined ? { madeBy: { id: made, name: features.find((f) => f.id === made)?.name ?? null } } : {}) }
  }
}

type FaceNamer = ReturnType<typeof faceNamer>

const round3s = (p: readonly number[]) => p.map(round3)

/** An odd edge of a STEP check as an answer gives it: where, how long,
 *  what is odd about it, how many faces meet at it, where it was found,
 *  and the body's faces at the body's edge nearest it with their makers. */
const stepEdgeOut = (e: StepEdge, face: FaceNamer) => ({ at: round3s(e.at), length: round3(e.length), kind: e.kind, meet: e.faces, in: e.in, faces: e.near.map((f) => face(f.hash, f.origin)) })
const stepShellOut = (sh: StepShell, face: FaceNamer) => ({ at: round3s(sh.at), faces: sh.faces, near: sh.near.map((f) => face(f.hash, f.origin)) })

/** The makers of faces, each once, in a few words. */
const makersOf = (faces: readonly StepFace[], face: FaceNamer) => {
  const named = faces.map((f) => face(f.hash, f.origin))
  const makers = [...new Set(named.flatMap((f) => (f.madeBy?.name ? [f.madeBy.name] : [])))]
  const indices = named.flatMap((f) => (f.index !== null ? [f.index] : []))
  return { indices, makers }
}

/** A STEP check's problem lines with the first odd edge's or stray
 *  shell's faces and makers named where a line points at it. */
function problemsNamed(problems: readonly string[], body: StepCheck['bodies'][number] | null | undefined, face: FaceNamer): string[] {
  if (!body) return [...problems]
  const say = (near: readonly StepFace[]) => {
    const { indices, makers } = makersOf(near, face)
    if (indices.length === 0 && makers.length === 0) return ''
    return ` (face${indices.length === 1 ? '' : 's'} ${indices.join(', ') || '?'}${makers.length > 0 ? `, made by ${makers.join(', ')}` : ''})`
  }
  const edge = body.freeEdges[0] ? say(body.freeEdges[0].near) : ''
  const shell = body.strayShells[0] ? say(body.strayShells[0].near) : body.farthest ? say(body.farthest.near) : ''
  return problems.map((line) => {
    if (edge && /the first at \(/.test(line)) return line.replace(/(the first at \([^)]*\))/, `$1${edge}`)
    if (shell && /about \(/.test(line)) return line.replace(/(about \([^)]*\))/, `$1${shell}`)
    return line
  })
}

/** A body's STEP round trip as an answer gives it. */
/** A part the export mended (ReKernel.exportStepMended), as an answer
 *  gives it. */
const mendOut = (m: StepMend) => ({ part: m.name, at: m.at.map(round3s), moved: m.moved, offMax: Number(m.offMax.toPrecision(2)), gap: Number(m.gap.toPrecision(2)) })

/** The same in a sentence. */
const mendWords = (m: StepMend) =>
  `${m.name} read back open by ${m.at.length === 1 ? 'a hair' : `${m.at.length} hairs`} at (${round3s(m.at[0]).join(', ')}) — a round's curve ending up to ${m.offMax.toPrecision(2)} mm off its corner; the file has ${m.moved === 1 ? 'that curve end' : `${m.moved} curve ends`} moved onto the corner and reads back closed, ${m.gap.toPrecision(2)} mm off the body.`

function roundTripOut(trip: RoundTrip, face: FaceNamer) {
  const b = trip.body
  return {
    ok: trip.ok,
    ...(trip.problems.length > 0 ? { problems: problemsNamed(trip.problems, b, face) } : {}),
    ...(trip.notes.length > 0 ? { notes: trip.notes } : {}),
    parts: trip.parts,
    ...(b
      ? {
          closed: b.closed,
          valid: b.valid,
          faces: b.faces,
          shells: b.shells,
          gap: { max: round3(b.gap.max), rms: round3(b.gap.rms) },
          freeEdges: b.freeEdges.map((e) => stepEdgeOut(e, face)),
          freeEdgeCount: b.freeEdgeCount,
          ...(b.strayShells.length > 0 ? { strayShells: b.strayShells.map((sh) => stepShellOut(sh, face)) } : {}),
          ...(b.farthest ? { farthest: { at: round3s(b.farthest.at), off: round3(b.farthest.off), faces: b.farthest.near.map((f) => face(f.hash, f.origin)) } } : {}),
        }
      : {}),
    ...(trip.mended ? { mended: trip.mended.map(mendOut) } : {}),
  }
}

/** How many findings of each kind audit: "brief" gives a line, unless
 *  limit says otherwise; counts says how many there are. */
const BRIEF_PER_KIND = 3

export const check: Command<{ body?: Ref; before?: Ref; tinyArea?: number; audit?: boolean | 'brief' | 'full'; kinkDeg?: number; stepMm?: number; parallelDeg?: number; shortEdge?: number; limit?: number; tolerance?: number; roundTrip?: boolean | 'find' }> = {
  name: 'check',
  title: 'Check a body',
  description:
    'A body looked over for what will trouble the next feature or the export: valid, closed and solids, volume and area, and the faces and edges to look at — tiny (under tinyArea), narrow (under 0.01 mm wide, the slivers tiny misses), untessellated, edges { free, nonManifold, contacts }, hairs, shells and voids (a hollow sealed inside: a warning, with voidList), folds and readBack — the body written as STEP and read back, with the edges that then do not join two faces, or a face the reader lost whole; roundTrip: true does the whole round trip as reverse.export.step { verify: true } does, "find" walks the build to the first step whose body does not come back. ok and problems sum it up. Then the audit (audit, "brief" by default): what is not wrong but not clean either — kinks, steps (and stepsBetweenFeatures), nearParallel, nearAxis, shortEdges — each with where, the faces by index with the feature that made them, and a repair; clean says whether it found nothing. Findings alike across a pattern (one kind and figure, on faces of the same kinds from the same features) come once, with count and a few places; audit "full" lists each. Bodies alike, without body — a pattern’s instances before they are joined — come once too: the first’s row, with alike { count, ids } and checked, how many were looked over. These are places to look, not faults: whether a 0.3° lean was designed so is yours to say from the part. Without body, every solid body; before: a feature — the body as it stood before it, its input. Changes nothing.',
  input: obj({
    body: bodyRef,
    before: { ...featureRef(), description: 'The body as it stood before this feature (its input, which a failure may blame): one that works on a body, or that joined or cut body; built or failed in the last build.' },
    tinyArea: num('mm² — a face under it is listed; 0.01 by default.', { exclusiveMinimum: 0 }),
    audit: oneOf([bool(), enumOf(['brief', 'full'])], 'The topology audit: "brief" (the default) one line per finding and counts; true the lists; "full" with centroids and sketch traces; false none.'),
    kinkDeg: num(`Degrees: two faces meeting at under this — but not at none — are a kink; ${AUDIT_DEFAULTS.kinkDeg} by default.`, { exclusiveMinimum: 0, maximum: 45 }),
    stepMm: num(`mm: two flat faces facing one way within this of each other — but not in one plane — are a step; ${AUDIT_DEFAULTS.stepMm} by default.`, { exclusiveMinimum: 0 }),
    parallelDeg: num(`Degrees: how far off parallel to each other, or off a coordinate axis, a face may lean and still be listed; ${AUDIT_DEFAULTS.parallelDeg} by default.`, { exclusiveMinimum: 0, maximum: 45 }),
    shortEdge: num(`mm: an edge under this is listed; ${AUDIT_DEFAULTS.shortEdge} by default.`, { exclusiveMinimum: 0 }),
    limit: int(`How many findings of each kind at most — of steps, how many lines (a line a pair of features), and findings alike across a pattern as one; ${BRIEF_PER_KIND} a kind with audit "brief", ${AUDIT_DEFAULTS.limit} otherwise.`, { minimum: 1 }),
    tolerance: num(`The part’s tolerance T, mm: a step under max(${ASK_MM}, T/2) is asked about; ${ASK_MM * 2} by default — and a lean moving its face under T/2 across it is left out.`, { exclusiveMinimum: 0 }),
    roundTrip: oneOf([bool(), enumOf(['find'])], 'true: write the body as STEP and read it back in memory, answering where it does not come back whole; "find": walk the build to the first step whose body does not. Off by default.'),
  }),
  readOnly: true,
  long: true,
  run: async ({ body, before, tinyArea = TINY_FACE_MM2, audit = 'brief', kinkDeg, stepMm, parallelDeg, shortEdge, limit, tolerance, roundTrip }) => {
    const s = await ready()
    // Before a feature: its input body, as the build kept it for editing.
    const at = before !== undefined ? featureNamed(before) : null
    const input = at && 'body' in at && typeof at.body === 'number' ? at.body : null
    if (at && input === null && body === undefined) invalid(`before: ${at.name} works on no body of its own — name the body it joined or cut (body), or give a feature that works on one (a fillet, a chamfer, a shell, a draft, …).`)
    if (at && roundTrip === 'find') invalid('roundTrip: "find" walks the whole build of the body — leave before out, or give roundTrip: true for that step’s input.')
    const picked = at ? [body !== undefined ? bodyNamed(body) : bodyAt(input!)] : body !== undefined ? [bodyNamed(body)] : re().bodies.filter((b) => !b.surface)
    if (picked.length === 0) throw new CommandError('invalid_state', 'There is no body to check — build one first.')
    const features = allFeatures()
    const options = { ...AUDIT_DEFAULTS, ...(kinkDeg !== undefined ? { kinkDeg } : {}), ...(stepMm !== undefined ? { stepMm } : {}), ...(parallelDeg !== undefined ? { parallelDeg } : {}), ...(shortEdge !== undefined ? { shortEdge } : {}), ...(limit !== undefined ? { limit } : {}) }
    const out = []
    for (const b of picked) {
      const c = await s.checkBody(b.id, tinyArea, at?.id, roundTrip).catch((e) => {
        throw new CommandError('failed', errorMessage(e))
      })
      if (!c && at) throw new CommandError('invalid_state', `The build kept no ${b.name} as it stood before ${at.name} — ${at.suppressed ? `${at.name} is suppressed` : `${at.name} did not run in the last build (past the rollback bar, or a step before it stopped it), or works on another body`}.`)
      if (!c) throw new CommandError('not_found', `${b.name} is not among the bodies built.`)
      // Faces by index as they stood before the feature, where it is read
      // there — as a pick on the feature's input counts them.
      const st = at ? await s.staged(at.id, b.id).catch(() => null) : null
      const t = at ? st?.topology : s.topologies.get(b.id)
      const mesh = at ? st?.mesh : s.meshes.get(b.id)
      const namer = faceNamer(t, features)
      const face = (hash: number) => namer(hash)
      const tiny = c.tiny.map((f) => ({ ...face(f.hash), area: f.area, centroid: f.centroid }))
      const narrow = c.narrow.map((f) => ({ ...face(f.hash), width: Number(f.width.toPrecision(3)), area: Number(f.area.toPrecision(3)), centroid: round3s(f.centroid) }))
      const edgeCounts = { free: c.odd.counts.free, nonManifold: c.odd.counts.nonManifold, contacts: c.odd.counts.inside + c.odd.counts.knife, ...(c.short.count > 0 ? { hairs: c.short.count } : {}) }
      const hairEdges = c.short.edges.map((e) => ({ at: round3s(e.at), length: Number(e.length.toPrecision(2)), faces: makersOf(e.faces.map((hash) => ({ hash })), namer) }))
      const whole = !c.readBackSolid || (c.readBackSolid.closed && c.readBackSolid.valid)
      const readBack =
        c.readBack && (c.readBack.length > 0 || !whole)
          ? { edges: c.readBack.length, ...(c.readBack[0] ? { first: { at: round3s(c.readBack[0].at), length: Number(c.readBack[0].length.toPrecision(2)), kind: c.readBack[0].kind } } : {}), ...(c.readBackSolid && !whole ? { closed: c.readBackSolid.closed, valid: c.readBackSolid.valid } : {}) }
          : null
      const oddAt = (kinds: readonly string[]) => c.odd.edges.find((e) => kinds.includes(e.kind))
      const oddWhere = (kinds: readonly string[]) => {
        const e = oddAt(kinds)
        if (!e) return ''
        const { indices, makers } = makersOf(e.faces.map((hash) => ({ hash })), namer)
        return ` — the first at (${round3s(e.at).join(', ')}), face${indices.length === 1 ? '' : 's'} ${indices.join(', ') || '?'}${makers.length > 0 ? ` made by ${makers.join(', ')}` : ''}`
      }
      // The STEP round trip: of the body (or that step's input), and the
      // first stage of the build that does not come back whole.
      const trip = c.roundTrip ? roundTripOut(c.roundTrip, namer) : null
      let found: Record<string, unknown> | null = null
      if (c.find) {
        const f = c.find
        const stage = f.before !== null ? await s.staged(f.before, b.id).catch(() => null) : null
        const stageNamer = f.before !== null ? faceNamer(stage?.topology, features) : namer
        const beforeFeature = f.before !== null ? features.find((x) => x.id === f.before) : undefined
        found = {
          step: f.step,
          before: f.before !== null ? { id: f.before, name: beforeFeature?.name ?? null } : null,
          checked: f.checked,
          of: f.of,
          done: f.done,
          ...(f.trip ? { roundTrip: roundTripOut(f.trip, stageNamer) } : {}),
        }
      }
      const untessellated = c.untessellated.map(face)
      const voidList = c.voids.map((v) => ({ ...(c.shells.length > 1 ? { solid: v.solid } : {}), volume: round3(v.volume), box: { min: v.bounds.min.map(round3), max: v.bounds.max.map(round3) } }))
      const voidWarning =
        voidList.length > 0
          ? `${voidList.length} void${voidList.length === 1 ? '' : 's'} sealed inside the body — a shell of ${voidList.length === 1 ? 'its' : 'their'} own the outside does not show: ${voidList.map((v) => `${v.volume} mm³ in (${v.box.min.join(', ')})–(${v.box.max.join(', ')})`).join('; ')}. Fill ${voidList.length === 1 ? 'it' : 'them'} (a join of a body over ${voidList.length === 1 ? 'it' : 'them'}), or build the bands to meet the core.`
          : null
      const problems: string[] = []
      if (!c.valid) problems.push('The kernel’s check fails on it.')
      if (!c.closed) problems.push(c.solids === 0 ? 'It is no solid.' : c.solids > 1 ? `It is ${c.solids} solids, not one.` : 'It is not closed.')
      if (tiny.length > 0) problems.push(`${tiny.length} face${tiny.length === 1 ? '' : 's'} under ${tinyArea} mm²: ${tiny.map((f) => `${f.index ?? '?'} (${f.area.toPrecision(2)} mm² at ${f.centroid.map(round3).join(', ')})`).join(', ')}.`)
      if (narrow.length > 0) problems.push(`${narrow.length} face${narrow.length === 1 ? '' : 's'} under ${NARROW_MM} mm wide — a sliver two faces a hair apart leave, which a round beside it stumbles on: ${narrow.slice(0, 6).map((f) => `${f.index ?? '?'} (${f.width} mm wide at ${f.centroid.join(', ')}${f.madeBy?.name ? `, made by ${f.madeBy.name}` : ''})`).join(', ')}${narrow.length > 6 ? ` and ${narrow.length - 6} more` : ''}.`)
      if (edgeCounts.free > 0) problems.push(`${edgeCounts.free} edge${edgeCounts.free === 1 ? '' : 's'} with one face — a hole in the skin${oddWhere(['free'])}.`)
      if (edgeCounts.nonManifold > 0) problems.push(`${edgeCounts.nonManifold} edge${edgeCounts.nonManifold === 1 ? '' : 's'} where three or more faces meet — the skin runs into itself, which a STEP reader takes for no closed solid${oddWhere(['nonManifold'])}.`)
      if (trip && !trip.ok) problems.push(`Written as STEP and read back, it does not hold: ${trip.problems?.[0] ?? 'see roundTrip'}${c.roundTrip?.mended ? ` reverse.export.step mends it: ${c.roundTrip.mended.map(mendWords).join(' ')}` : ''}`)
      if (readBack?.first) problems.push(`Written as STEP and read back, ${readBack.edges === 1 ? 'an edge does' : `${readBack.edges} edges do`} not join two faces — the first at (${readBack.first.at.join(', ')}), ${readBack.first.length} mm long: a hole a reader makes that the body in memory does not show${readBack.first.kind === 'free' && readBack.first.length < 0.01 ? ' — a round’s curve ending a hair off its corner, which reverse.export.step mends where it can; roundTrip: true says whether' : ' — roundTrip: true for the faces there'}.`)
      else if (readBack) problems.push(`Written as STEP and read back, it is ${readBack.closed === false ? 'no closed solid' : 'a solid the kernel’s check fails'}, with no edge open — a face the reader lost whole, as an off-centre dome turned from its base to its pole is: roundTrip: true names the face.`)
      if (found?.step) problems.push(`The first body of the build that does not come back whole from STEP is ${(found.step as { name: string | null }).name ?? 'a step'}'s result${found.before ? ` (the input of ${(found.before as { name: string | null }).name ?? 'the next step'})` : ''}.`)
      if (untessellated.length > 0) problems.push(`${untessellated.length} face${untessellated.length === 1 ? '' : 's'} the mesher drew nothing for: ${untessellated.map((f) => f.index ?? '?').join(', ')}.`)
      const meshFaults = (c.meshFaults ?? []).map((f) => meshFaultOut(b.name, f, face(f.hash)))
      for (const f of meshFaults) problems.push(f.words)
      const folds = c.folds?.map((f) => ({ loft: { id: f.loft, name: f.name }, at: round3s(f.at), words: f.words }))
      for (const f of folds ?? []) problems.push(`The skin ${f.loft.name} made ${f.words} — the kernel's check passes it, but a boolean with it comes out empty or wrong: drop or move a section of ${f.loft.name} that lies close to another and differs, or make it ruled.`)
      // The audit: what is clean or not about a body that is sound.
      const looked = t ? auditBody(t.faces, t.edges, { ...options, alike: audit !== 'full', ...(tolerance !== undefined ? { tolerance } : {}) }, (f) => (mesh && f.fingerprint.center ? roundFaceIsBoss(mesh, f.hash, f.fingerprint.center, f.fingerprint.dir) : null), c.odd.edges) : null
      const findings = audit && looked ? looked.findings : []
      const audited = t ? auditOut(findings, t, features, audit === 'full', audit === 'brief' ? (limit ?? BRIEF_PER_KIND) : Infinity) : null
      const contactWarning = edgeCounts.contacts > 0 ? `${edgeCounts.contacts} tangent contact${edgeCounts.contacts === 1 ? '' : 's'} — a face that only touched another and left its line${oddWhere(['inside', 'knife'])}: let the one cross the other clearly (0.05 mm or more) or meet it with a round; reverse.export.step may read back as no closed solid.` : null
      const first = hairEdges[0]
      const hairWarning = first ? `${c.short.count === 1 ? 'An edge' : `${c.short.count} edges`} between two faces under 0.0001 mm — a hair a round left, which a STEP reader may drop from one face and read back as a hole: the first at (${first.at.join(', ')}), faces ${first.faces.indices.join(', ') || '?'}${first.faces.makers.length > 0 ? ` made by ${first.faces.makers.join(', ')}` : ''}; reverse.export.step { verify: true } says whether it holds.` : null
      // Edges on a conic too small for a part: the export writes those
      // that run straight as lines; any other is a problem in the file.
      const conics = c.conics ?? []
      const bent = conics.filter((k) => !k.straight)
      const conicWords = (list: typeof conics) => `${list.length === 1 ? 'an edge' : `${list.length} edges`} on a ${list[0].kind} only ${list[0].size.toPrecision(2)} mm across, the first at (${round3s(list[0].at).join(', ')}) and centred at (${round3s(list[0].centre).join(', ')}) — a plane a hair off a cone's apex makes one, as a wedge's side meant to pass through a revolve's axis does when its sketch is rounded`
      if (bent.length > 0) problems.push(`It has ${conicWords(bent)}: a reader that draws it (Fusion) can draw a spike out to its centre, and the export cannot write it as a line. Put the plane on the axis.`)
      const conicWarning = conics.length > bent.length ? `It has ${conicWords(conics.filter((k) => k.straight))}. The edge runs straight, and reverse.export.step writes it as a line, so the file holds; to clear it, put the plane on the axis.` : null
      const warnings = [...(voidWarning ? [voidWarning] : []), ...(contactWarning ? [contactWarning] : []), ...(hairWarning ? [hairWarning] : []), ...(conicWarning ? [conicWarning] : []), ...(audit !== 'brief' && audited ? audited.warnings : [])]
      out.push({
        id: b.id,
        name: b.name,
        ...(at ? { before: { id: at.id, name: at.name } } : {}),
        ok: problems.length === 0,
        valid: c.valid,
        closed: c.closed,
        ...(looked ? { stepsBetweenFeatures: looked.stepsBetweenFeatures } : {}),
        solids: c.solids,
        volume: c.volume,
        area: c.area,
        faces: c.faces,
        tiny,
        narrow,
        untessellated,
        ...(meshFaults.length > 0 ? { meshFaults } : {}),
        edges: edgeCounts,
        ...(hairEdges.length > 0 ? { hairEdges: hairEdges.map((e) => ({ at: e.at, length: e.length, faces: e.faces.indices })) } : {}),
        ...(readBack ? { readBack } : {}),
        shells: c.shells,
        voids: voidList.length,
        ...(voidList.length > 0 ? { voidList } : {}),
        ...(problems.length > 0 ? { problems } : {}),
        ...(audit && audited ? { clean: findings.length === 0, ...(audit === 'brief' ? { findings: audited.brief, ...(findings.length > 0 ? { counts: looked!.found } : {}) } : audited.lists), ...(looked?.underHalfT ? { underHalfT: looked.underHalfT } : {}) } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(folds ? { folds } : {}),
        ...(trip ? { roundTrip: trip } : {}),
        ...(found ? { find: found } : {}),
      })
    }
    // Bodies alike — a pattern's instances before they are joined — answered
    // once: fifteen rows saying one thing each in its own place were 22 kB on
    // the last fan, a limit no help. Named, a body answers for itself.
    if (body !== undefined || at || roundTrip === 'find') return { bodies: out }
    const rows = onePerAlike(out)
    return { bodies: rows, ...(rows.length < out.length ? { checked: out.length } : {}) }
  },
}

/** What makes two bodies' rows one answer: their size and shape, to five
 *  figures, and what the check found, but for where. */
function checkAlike(r: Record<string, unknown>): string {
  const n = (k: string) => Number(r[k]).toPrecision(5)
  const many = (k: string) => (r[k] as unknown[] | undefined)?.length ?? 0
  const trip = r.roundTrip as { ok?: boolean } | undefined
  return JSON.stringify([n('volume'), n('area'), r.faces, r.ok, r.valid, r.closed, r.solids, r.edges, r.shells, r.voids, r.clean, r.counts, (r.readBack as { edges?: number } | undefined)?.edges, trip?.ok, many('tiny'), many('narrow'), many('untessellated'), many('problems'), many('meshFaults')])
}

/** The bodies' rows with those alike given once: the first, with the others'
 *  ids in alike. */
function onePerAlike(rows: readonly (Record<string, unknown> & { id: number })[]) {
  const groups = new Map<string, (typeof rows)[number][]>()
  for (const r of rows) {
    const key = checkAlike(r)
    ;(groups.get(key) ?? groups.set(key, []).get(key)!).push(r)
  }
  return [...groups.values()].map(([first, ...rest]) => (rest.length === 0 ? first : { ...first, alike: { count: rest.length, ids: rest.map((r) => r.id), say: 'As this body, each where it lies: same volume, area and faces, and the same findings. body: an id gives its own row.' } }))
}

/** What the audit's findings are listed under in reverse.body.check. */
const FINDING_LISTS: Record<Finding['kind'], 'kinks' | 'steps' | 'nearParallel' | 'nearAxis' | 'shortEdges' | 'freeEdges' | 'nonManifold' | 'contacts'> = { kink: 'kinks', step: 'steps', nearParallel: 'nearParallel', nearAxis: 'nearAxis', shortEdge: 'shortEdges', freeEdge: 'freeEdges', nonManifold: 'nonManifold', contact: 'contacts' }

/** A face's trace back to the feature list, as an answer gives it. */
const traceOut = (t: FaceTrace) => ({ feature: t.feature, ...(t.sketch ? { sketch: t.sketch } : {}), ...(t.piece ? { piece: t.piece } : {}), role: t.role, ...(t.end ? { end: t.end } : {}) })

/** The audit's findings as reverse.body.check lists them: each with the
 *  faces and edges it concerns, by index, the feature that made each face
 *  and the sketch piece behind it where there is one, and a repair — where
 *  a relation or a dimension would put it right. With them a sentence per
 *  kind for the answer's warnings. A face's centroid and trace are listed
 *  only when `full` — the repair is read off them either way; the brief
 *  lines are `briefPerKind` of each kind at most. */
function auditOut(findings: readonly Finding[], t: Topology, features: readonly Feature[], full = true, briefPerKind = Infinity) {
  const lists: Record<string, unknown[]> = {}
  const brief: string[] = []
  const counts = new Map<Finding['kind'], Finding[]>()
  for (const f of findings) {
    const traced = f.faces.map((i) => {
      const fp = t.faces[i].fingerprint
      const trace = traceFace(features, fp)
      return { index: i, kind: fp.kind, centroid: fp.centroid, madeBy: { id: fp.origin, name: features.find((x) => x.id === fp.origin)?.name ?? null }, ...(trace ? { trace: traceOut(trace) } : {}) }
    })
    const faces = full ? traced : traced.map(({ index, kind, madeBy }) => ({ index, kind, madeBy }))
    const edges = f.edges.map((i) => {
      const fp = t.edges[i].fingerprint
      return { index: i, kind: fp.kind, length: fp.length, mid: fp.mid }
    })
    const named = (id: number) => features.find((x) => x.id === id)?.name ?? null
    const step = f.kind === 'step' && f.between ? { form: f.form, between: f.between[0] === f.between[1] ? [named(f.between[0])] : f.between.map(named), count: f.count, ...(f.hair ? { hair: true } : {}), ...(f.riser !== undefined ? { riser: f.riser } : {}) } : {}
    const alike = f.places ? { count: f.count, places: f.places.map(round3s) } : {}
    const row = { at: f.at, off: f.off, unit: f.unit, ...(f.axis ? { axis: f.axis } : {}), ...step, ...alike, note: f.note, faces, edges, repair: repairFor(f, traced) }
    ;(lists[FINDING_LISTS[f.kind]] ??= []).push(row)
    if ((counts.get(f.kind)?.length ?? 0) < briefPerKind) brief.push(briefLine(f, faces, row.repair))
    ;(counts.get(f.kind) ?? counts.set(f.kind, []).get(f.kind)!).push(f)
  }
  const list = (fs: Finding[], what: (f: Finding) => string) => fs.map((f) => `${what(f)}${f.places ? ` ×${f.count}` : ''}`).join(', ')
  // Those a finding stands for counted with it.
  const many = (fs: Finding[]) => fs.reduce((sum, f) => sum + (f.places ? f.count! : 1), 0)
  const warnings: string[] = []
  const pair = (f: Finding) => `${f.faces[0]}+${f.faces[1]} (${f.off} ${f.unit === 'deg' ? '°' : 'mm'})`
  const kinks = counts.get('kink')
  if (kinks) warnings.push(`${many(kinks)} place${many(kinks) === 1 ? '' : 's'} where two faces meet at a hair's angle instead of flush or tangent: edge${kinks.length === 1 ? '' : 's'} ${list(kinks, (f) => `${f.edges[0]} (${f.off}°)`)}.`)
  const steps = counts.get('step')
  if (steps) {
    // A line a pair of features: those between two first, by name.
    const name = (id: number) => features.find((x) => x.id === id)?.name ?? `feature ${id}`
    const across = steps.filter((f) => f.between && f.between[0] !== f.between[1])
    const within = steps.filter((f) => !across.includes(f))
    const line = (f: Finding) => `${f.between ? (f.between[0] === f.between[1] ? name(f.between[0]) : `${name(f.between[0])}+${name(f.between[1])}`) : '?'} ${f.count ?? 1}${f.hair ? ' hairline' : ''} (${f.count && f.count > 1 ? 'widest ' : ''}${f.off} mm, faces ${f.faces[0]}+${f.faces[1]})`
    const parts = [across.length > 0 ? `between features: ${across.map(line).join(', ')}` : '', within.length > 0 ? `within one feature: ${within.map(line).join(', ')}` : ''].filter(Boolean)
    warnings.push(`Faces a step apart — ${parts.join('; ')}.`)
  }
  const parallel = counts.get('nearParallel')
  if (parallel) warnings.push(`${many(parallel)} pair${many(parallel) === 1 ? '' : 's'} of flat faces nearly parallel: faces ${list(parallel, pair)}.`)
  const axis = counts.get('nearAxis')
  if (axis) warnings.push(`${many(axis)} face${many(axis) === 1 ? '' : 's'} nearly square to a coordinate axis but off it: ${list(axis, (f) => `${f.faces[0]} (${f.off}° off ${f.axis})`)}.`)
  const free = counts.get('freeEdge')
  if (free) warnings.push(`${free.length} edge${free.length === 1 ? '' : 's'} with one face: edge${free.length === 1 ? '' : 's'} ${list(free, (f) => `${f.edges[0] ?? '?'} at (${f.at.map(round3).join(', ')})`)}.`)
  const manifold = counts.get('nonManifold')
  if (manifold) warnings.push(`${manifold.length} edge${manifold.length === 1 ? '' : 's'} where three or more faces meet: edge${manifold.length === 1 ? '' : 's'} ${list(manifold, (f) => `${f.edges[0] ?? '?'} at (${f.at.map(round3).join(', ')})`)}.`)
  const short = counts.get('shortEdge')
  if (short) warnings.push(`${many(short)} edge${many(short) === 1 ? '' : 's'} under a tenth of a millimetre or so: ${list(short, (f) => `${f.edges[0]} (${f.off} mm)`)}.`)
  return { lists, warnings, brief }
}

/** A finding in one line, as audit: "brief" gives it: what and how much,
 *  where, the edges and the faces by index with the feature that made
 *  each, and the repair. */
function briefLine(f: Finding, faces: readonly { index: number; madeBy: { id: number; name: string | null } }[], repair: string): string {
  const at = f.at.map((v) => Math.round(v * 100) / 100).join(', ')
  const off = `${f.off}${f.unit === 'deg' ? '°' : ' mm'}${f.axis ? ` off ${f.axis}` : ''}`
  const edges = f.edges.length > 0 ? `edge${f.edges.length === 1 ? '' : 's'} ${f.edges.join(', ')}, ` : ''
  const named = faces.map((x) => `${x.index} (${x.madeBy.name ?? '?'})`).join(' + ')
  // One standing for others alike: how many, and where the next few lie.
  const also = f.places ? `, ×${f.count} alike, also at ${f.places.map((p) => `(${p.map((v) => Math.round(v * 100) / 100).join(', ')})`).join(', ')}` : ''
  return `${f.kind} ${off} at (${at})${also}: ${edges}face${faces.length === 1 ? '' : 's'} ${named} — ${repair}`
}

/** Where a finding's repair goes, in a sentence: the sketch piece behind a
 *  leaning wall, the two extents behind a step, the tangency behind a
 *  kink — as far as the faces trace back. */
function repairFor(f: Finding, faces: readonly { index: number; kind: string; madeBy: { id: number; name: string | null }; trace?: ReturnType<typeof traceOut> }[]): string {
  const piece = (x: (typeof faces)[number]) => (x.trace?.piece && x.trace.sketch ? `${x.trace.piece.kind} ${x.trace.piece.id} of ${x.trace.sketch.name}` : null)
  const [a, b] = faces
  switch (f.kind) {
    case 'nearAxis': {
      const p = a && piece(a)
      if (p) return `${p} leans ${f.off}° — a horizontal or vertical relation on it (reverse.sketch.edit), or the fit with alignAxes, squares it; reverse.sketch.candidates shows what else it is near.`
      if (a?.trace?.role === 'cap') return `the cap of ${a.trace.feature.name} leans with its sketch plane — the plane, not the sketch, is what to square.`
      return `the face leans ${f.off}° off the ${f.axis} axis — square the sketch plane or the piece behind it, if it was meant square.`
    }
    case 'nearParallel': {
      const pa = a && piece(a), pb = b && piece(b)
      if (pa && pb && a.trace?.sketch?.id === b.trace?.sketch?.id) return `a parallel relation between ${pa} and ${pb} (reverse.sketch.edit) — or horizontal or vertical on both.`
      if (pa && pb) return `${pa} and ${pb} are in different sketches: hold both to a coordinate plane, or project one into the other's sketch (project).`
      return `the two faces lean ${f.off}° to each other — parallel in the sketches behind them, if meant so.`
    }
    case 'step': {
      if (f.form === 'round') {
        const pa = a && piece(a), pb = b && piece(b)
        if (pa && pb && a.trace?.sketch?.id === b.trace?.sketch?.id) return `${pa} and ${pb} are one round drawn twice — one piece for both, or a concentric relation and equal radii (reverse.sketch.edit).`
        if (pa && pb) return `${pa} and ${pb} are one round drawn twice in two sketches — project ${pb} into ${a.trace!.sketch!.name} in place of ${a.trace!.piece!.kind} ${a.trace!.piece!.id}, or fit that level into ${b.trace!.sketch!.name} (fit.level).`
        return 'one round drawn twice — one sketch piece for both: project the one, or fit both levels into one sketch (fit.level).'
      }
      if (f.form === 'tangent') {
        const round = faces.find((x) => x.kind === 'cylinder') ?? a
        const p = round && piece(round)
        return `${p ?? 'the round'} was likely meant to touch the other feature’s face — a tangent relation to the face’s edge projected into its sketch, or let it cross clearly.`
      }
      if (f.form === 'foot') {
        const round = faces.find((x) => x.kind === 'cylinder') ?? a
        const p = round && piece(round)
        return `${p ?? 'the round’s profile'} nearly starts on the other feature’s face — hold its end on that face (project the face’s edge into the sketch and put the end on it), or let it start clearly off it.`
      }
      const caps = a?.trace?.role === 'cap' && b?.trace?.role === 'cap'
      if (caps) return `${a.trace!.feature.name} and ${b.trace!.feature.name} end ${f.off} mm apart — give both extents one parameter, or extrude the later one up to the earlier one's face.`
      const pa = a && piece(a), pb = b && piece(b)
      if (pa && pb) return `${pa} and ${pb} lie ${f.off} mm apart across their faces — project one into the other's sketch (project) so they are one line, or dimension both from one coordinate plane.`
      return `two faces ${f.off} mm apart that were likely meant as one — one height or one plane for both: a shared parameter, or the earlier face's edge projected into the later sketch.`
    }
    case 'kink': {
      const pa = a && piece(a), pb = b && piece(b)
      if (pa && pb && a.trace?.sketch?.id === b.trace?.sketch?.id) return `a tangent relation between ${pa} and ${pb} (reverse.sketch.edit) — reverse.sketch.candidates lists it with the evidence.`
      return `a tangent relation in the sketch where the two pieces meet, or a round (fillet) in place of the sketched arc.`
    }
    case 'shortEdge':
      return `a sliver — a boolean's leftover (tiny lists faces under an area), or two corners that nearly meet: join them in the sketch, or round the edge away.`
    case 'freeEdge':
      return `the body is open here — a face is missing beside this edge: find the step that opened it (roundTrip: "find"), and close it there.`
    case 'nonManifold':
    case 'contact': {
      const makers = [...new Set(faces.map((x) => x.madeBy.name).filter((n): n is string => n !== null))]
      return `${makers.length > 0 ? `${makers.join(' and ')} ` : 'two faces '}only touch here at a tangent: let the one cross the other clearly (0.05 mm or more — a circle a hair larger or moved in) or meet it with a round; a point contact is never meant.`
    }
  }
}

export const step: Command<{ bodies?: Ref[]; verify?: boolean }> = {
  name: 'step',
  title: 'Export the bodies as STEP',
  description:
    'The bodies as one STEP file of solids, for CAD — the visible ones by default, as the panel’s Export STEP writes them: each a part of its own, under its name and in its colour (reverse.body.set). Returns the file’s bytes and the name the panel would save it under. A body that reads back open only by free edges a hair long (under 0.01 mm) has the curves there made to end on their corners in the file, kept only where it then reads back a closed, valid solid within 0.001 mm of the body (mended names each such part, and the status says so); a body that reads back whole is never touched. verify: true reads the file back and holds it against the bodies, in place of opening it as a reference: verify: { ok, problems, notes, parts, bodies: [{ name, volume, faces, shells, closed, gap, freeEdges, freeEdgeCount, strayShells }], loops: { read, of, unread, wrong } } — unread counts by surface type the faces whose loops are not read (not a fault), wrong the faces whose loops a strict reader (Onshape, SolidWorks) takes the wrong way round.',
  input: obj({
    bodies: arr(bodyRef, 'The bodies; the visible ones by default.', { minItems: 1 }),
    verify: bool('Read the file back and check it against the bodies (off by default).'),
  }),
  readOnly: true,
  long: true,
  returnsFile: true,
  timeoutMs: 600_000,
  run: async ({ bodies, verify = false }) => {
    const s = await ready()
    const picked = bodies ? bodies.map(bodyNamed) : re().bodies.filter((b) => b.visible)
    if (picked.length === 0) throw new CommandError('invalid_state', 'There is no visible body to export — build one first.')
    const { name, text, check, mended } = await s.stepFile(picked.map((b) => b.id), verify).catch((e) => {
      throw new CommandError('failed', `STEP export failed: ${errorMessage(e)}`)
    })
    // The check's bodies are the solids among those picked, in order, and a
    // Patch network's sheet — a skin of the part, which the file holds as
    // any other sheet it leaves out; each odd edge's faces by index on its
    // body, with their makers.
    const features = check ? allFeatures() : []
    const networks = new Set(allFeatures().filter((f) => f.kind === 'network').map((f) => f.id))
    const solids = picked.filter((b) => !b.surface || networks.has(bodyMaker(b.id)))
    const namers = solids.map((b) => faceNamer(s.topologies.get(b.id), features))
    const problems = check ? check.problems.map((line) => check.bodies.reduce((l, body, i) => (l.startsWith(body.name ?? `Part ${i + 1}`) ? (problemsNamed([l], body, namers[i])[0] ?? l) : l), line)) : []
    return {
      file: { name, mimeType: 'model/step', bytes: new TextEncoder().encode(text) },
      bodies: picked.map((b) => ({ id: b.id, name: b.name })),
      status: `${picked.length} bod${picked.length === 1 ? 'y' : 'ies'} as STEP solids, each under its name.${mended ? ` Mended: ${mended.map(mendWords).join(' ')}` : ''}${check ? (check.ok ? ' Read back and checked: it holds.' : ` Read back: ${check.problems.length} problem${check.problems.length === 1 ? '' : 's'}.`) : ''}`,
      ...(mended ? { mended: mended.map(mendOut) } : {}),
      ...(planOpenSaid() ? { plan: planOpenSaid() } : {}),
      ...(check
        ? {
            verify: {
              ok: check.ok,
              problems,
              ...(check.notes.length > 0 ? { notes: check.notes } : {}),
              parts: check.parts,
              bodies: check.bodies.map((body, i) => {
                const { freeEdges, strayShells, ...rest } = body
                return { ...rest, freeEdges: freeEdges.map((e) => stepEdgeOut(e, namers[i])), freeEdgeCount: body.freeEdgeCount, ...(strayShells.length > 0 ? { strayShells: strayShells.map((sh) => stepShellOut(sh, namers[i])) } : {}) }
              }),
              loops: { read: check.loops.read, of: check.loops.of, ...(Object.keys(check.loops.unread).length > 0 ? { unread: check.loops.unread } : {}), ...(check.loops.wrong.length > 0 ? { wrong: check.loops.wrong } : {}) },
            },
          }
        : {}),
    }
  },
}

/** How far a triangle may stand off a curved face in a mesh for printing,
 *  millimetres, unless told otherwise. */
const STL_CHORD_MM = 0.02

export const stl: Command<{ bodies?: Ref[]; chord?: number; format?: MeshFormat }> = {
  name: 'stl',
  title: 'Export the bodies as a mesh',
  description:
    'The bodies as one binary STL in millimetres — or, format 3mf, a 3MF with each body an object of its own — for printing or for a mesh tool — the visible solid ones by default, meshed to the chord: how far a triangle may stand off a curved face, 0.02 mm by default (finer is larger). A sheet or a fitted surface is left out. Returns the file’s bytes, the name the panel would save it under and how many triangles it holds.',
  input: obj({ bodies: arr(bodyRef, 'The bodies; the visible solid ones by default.', { minItems: 1 }), chord: num('mm; 0.02 by default.', { exclusiveMinimum: 0, maximum: 1 }), format: enumOf([...MESH_FORMATS], 'stl (the default) or 3mf.') }),
  readOnly: true,
  long: true,
  returnsFile: true,
  timeoutMs: 600_000,
  run: async ({ bodies, chord = STL_CHORD_MM, format = 'stl' }) => {
    const s = await ready()
    const picked = bodies ? bodies.map(bodyNamed) : re().bodies.filter((b) => b.visible && !b.surface)
    const sheet = picked.find((b) => b.surface)
    if (sheet) invalid(`${sheet.name} is a surface — a mesh export is of solids.`)
    if (picked.length === 0) throw new CommandError('invalid_state', 'There is no visible solid body to export — build one first.')
    const f = await s.meshFile(picked, chord, format).catch((e) => {
      throw new CommandError('failed', `Mesh export failed: ${errorMessage(e)}`)
    })
    if (!f) throw new CommandError('failed', 'The bodies meshed to no triangle.')
    return {
      file: { name: f.name, mimeType: f.mimeType, bytes: f.bytes },
      bodies: picked.map((b) => ({ id: b.id, name: b.name })),
      chord,
      triangles: f.triangles,
      status: `${picked.length} bod${picked.length === 1 ? 'y' : 'ies'} as one ${MESH_FORMAT_LABEL[format]} of ${f.triangles} triangles.`,
    }
  },
}

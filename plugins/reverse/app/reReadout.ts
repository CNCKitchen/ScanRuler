// SPDX-License-Identifier: AGPL-3.0-only
// The Reverse engineer workspace read out as JSON — its part of the
// session's readout (registerStateSection), and the pieces the commands
// answer with: the parameters with their values, the features as the list
// stores them with what the last build said of each, the bodies, a body's
// faces and edges with their fingerprints. Read from the same store the
// panel draws from, at full precision, millimetres and degrees.

import type { Vec3 } from '../../../src/core/types'
import type { EdgeInfo, FaceInfo, FeatureResult, SurfaceReport } from '../core/build'
import { referencesOf, type Feature } from '../core/features'
import { describePlaneRef } from '../core/resolve'
import type { KernelMesh } from '../core/kernel'
import { exprsForCommand, featureExpressionErrors, fieldsReading, idleParameters, PARAMETER_KINDS, usersOf } from '../core/parameters'
import type { Region } from '../core/regions'
import { roundFaceIsBoss } from '../core/thread'
import { bodiesOfFeature } from '../state/reFeatureHelpers'
import { keyParameterOf, useReverse } from '../state/reStore'
import { featureToJson } from './projectSection'
import { reverseSession, type ReverseSession } from './reSession'
import { useStore } from '../../../src/state/store'
import { fittedOf } from './reFitMarks'

/** A box round some points, or null for none. */
export function boundsOf(points: ArrayLike<number>): { min: Vec3; max: Vec3; size: Vec3 } | null {
  if (points.length < 3) return null
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i + 2 < points.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = points[i + k]
      if (v < min[k]) min[k] = v
      if (v > max[k]) max[k] = v
    }
  }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] }
}

/** A number as it is shown, to twelve significant digits: what an
 *  expression's arithmetic leaves past them (4.999999999999999) is not the
 *  part's. Only for numbers that are read, or that an expression holds
 *  exactly — never for a coordinate handed back, which has to be the
 *  build's to the last digit. */
export const shown = (x: number): number => (Number.isFinite(x) ? +x.toPrecision(12) + 0 : x)

const shown2 = (p: readonly [number, number]): [number, number] => [shown(p[0]), shown(p[1])]

/** The fields an expression drives, shown: the expression is the exact
 *  value, and is handed back with them. */
function exprFieldsShown(out: Record<string, unknown>, exprs: Record<string, unknown>): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(out)) as Record<string, unknown>
  for (const path of Object.keys(exprs)) {
    const keys = path.split('.')
    let at: Record<string, unknown> | undefined = copy
    for (const k of keys.slice(0, -1)) at = at && typeof at[k] === 'object' && at[k] !== null ? (at[k] as Record<string, unknown>) : undefined
    const last = keys[keys.length - 1]
    if (at && typeof at[last] === 'number') at[last] = shown(at[last] as number)
  }
  return copy
}

/** A feature as the list stores it, less what is per scan vertex: a fitted
 *  piece's slice points are a count (`fitted`, by piece), a surface's
 *  region its size. What goes back in through reverse.feature.update takes
 *  the points from the stored feature. A number an expression drives is
 *  shown to twelve digits, the expression beside it exact. */
/** The queries a feature's picks were given by, as a list shows them: the
 *  queries alone — what each found is in the feature's edges or faces. */
function queriesShown(out: Record<string, unknown>): Record<string, unknown> {
  const shown = (picks: unknown) => (Array.isArray(picks) ? picks.map((p) => (p as { where: unknown }).where) : picks)
  if (!('edgesWhere' in out) && !('facesWhere' in out)) return out
  return { ...out, ...('edgesWhere' in out ? { edgesWhere: shown(out.edgesWhere) } : {}), ...('facesWhere' in out ? { facesWhere: shown(out.facesWhere) } : {}) }
}

export function featureOut(f: Feature): Record<string, unknown> {
  if (f.kind === 'surface') {
    const { region, ...rest } = f
    return { ...rest, region: { points: region.length } }
  }
  if (f.kind !== 'sketch') {
    const out = queriesShown(featureToJson(f) as unknown as Record<string, unknown>)
    return 'exprs' in f && f.exprs ? { ...exprFieldsShown(out, f.exprs), exprs: exprsForCommand(f.kind, f.exprs) } : out
  }
  // A picture under it is said by its size and place, not sent.
  const image = f.image ? { image: { name: f.image.name, width: f.image.width, height: f.image.height, origin: f.image.origin, mmPerPx: f.image.mmPerPx, angleDeg: f.image.angleDeg } } : {}
  const fitted: Record<number, number> = {}
  const entities = f.sketch.entities.map((e) => {
    if (!('points' in e) || !e.points) return e
    const { points, scatter: _scatter, ...rest } = e
    void _scatter
    fitted[e.id] = points.length
    return rest
  })
  // A dimension with an expression is worked out again from it when the
  // sketch is handed back: its number is for reading.
  const constraints = f.sketch.constraints.map((c) => ('expr' in c && c.expr && 'value' in c && typeof c.value === 'number' ? { ...c, value: shown(c.value) } : c))
  return { ...f, sketch: { ...f.sketch, entities, constraints }, ...image, ...(Object.keys(fitted).length > 0 ? { fitted } : {}) }
}

/** The middle of a polyline by its points: of an even count, halfway between
 *  the two in the middle, as a straight edge's two points have no middle of
 *  their own. */
export function lineMiddle(line: Float32Array): Vec3 {
  const n = Math.floor(line.length / 3)
  const at = (i: number): Vec3 => [line[i * 3], line[i * 3 + 1], line[i * 3 + 2]]
  if (n % 2 === 1) return at(n >> 1)
  const p = at(n / 2 - 1)
  const q = at(n / 2)
  return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2]
}

/** A polyline the kernel drew a failure along, briefly: where it runs. */
const whereOut = (line: Float32Array) => {
  const n = Math.floor(line.length / 3)
  const at = (i: number): Vec3 => [line[i * 3], line[i * 3 + 1], line[i * 3 + 2]]
  return n === 0 ? { points: 0 } : { points: n, start: at(0), middle: lineMiddle(line), end: at(n - 1) }
}

/** A surface's fit as an answer gives it: how close, the net, how many
 *  points, and a freeform fit's worst points and those a robust fit left
 *  out. */
function surfaceOut(s: SurfaceReport) {
  const r4 = (x: number) => Math.round(x * 1e4) / 1e4
  return {
    rms: s.rms,
    max: s.max,
    net: s.net,
    points: s.points,
    ...(s.shape ? { shape: s.shape } : {}),
    ...(s.dropped !== undefined ? { dropped: s.dropped } : {}),
    ...(s.worst?.length ? { worst: s.worst.map((w) => ({ at: w.at.map((x) => Math.round(x * 1e3) / 1e3), off: r4(w.off) })) } : {}),
    ...(s.strays?.length ? { strays: s.strays } : {}),
    ...(s.pastRegion ? { pastRegion: s.pastRegion } : {}),
  }
}

/** What the last build said of a feature. */
export function resultOut(r: FeatureResult | undefined) {
  if (!r) return null
  return {
    status: r.status,
    ...(r.message ? { message: r.message } : {}),
    ...(r.note ? { note: r.note } : {}),
    ...(r.warning ? { warning: r.warning } : {}),
    ...(r.edges ? { edges: r.edges } : {}),
    ...(r.where?.length ? { where: r.where.map(whereOut) } : {}),
    ...(r.bodies ? { bodies: r.bodies } : {}),
    ...(r.took !== undefined ? { took: r.took } : {}),
    ...(r.surface ?{ surface: surfaceOut(r.surface) } : {}),
    ...(r.strays?.length ? { strays: r.strays } : {}),
    ...(r.offScan?.length ? { offScan: r.offScan } : {}),
    ...(r.trim ? { trim: { faces: r.trim.faces, kept: r.trim.kept, closed: r.trim.closed, openEdges: r.trim.openEdges.length } } : {}),
  }
}

/** A feature as its row reads: what it is, whether it built, what it
 *  reads. */
/** The numbers of a feature fitted to the scan this session: each one's
 *  value, sigma and nominal, for the row. */
function fittedBrief(f: Feature) {
  const m = fittedOf(f.id, f)
  const read = (x: number | null) => (x === null ? x : shown(x))
  return m ? { fitted: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { value: read(v.value), sigma: read(v.sigma), nominal: read(v.nominal), sigmas: read(v.sigmas) }])) } : {}
}

/** Whether a feature's bodies are shown: any of them, or the feature's own
 *  flag where none stands. */
function visibleBodies(f: Feature): boolean {
  const re = useReverse.getState()
  const ids = new Set(bodiesOfFeature(f, re.bodies, re.results[f.id]))
  return ids.size > 0 ? re.bodies.some((b) => ids.has(b.id) && b.visible) : f.visible
}

export function featureBrief(f: Feature, rolledBack: boolean) {
  const re = useReverse.getState()
  const result = rolledBack ? undefined : re.results[f.id]
  const errors = featureExpressionErrors(f, re.parameterTable.scope)
  const key = keyParameterOf(f)
  const store = useStore.getState()
  return {
    id: f.id,
    name: f.name,
    kind: f.kind,
    // A sketch is shown on the part or not; any other feature is as its
    // bodies are — shown while one of them is.
    visible: f.kind === 'sketch' || rolledBack ? f.visible : visibleBodies(f),
    // A sketch builds nothing of its own — but one placed on a body's face,
    // which the build finds again — and stands once the part is built.
    status: rolledBack ? 'rolled back' : f.suppressed ? 'suppressed' : result ? result.status : f.kind === 'sketch' && reverseSession()?.buildState() === 'built' ? 'ok' : 'not built',
    ...(rolledBack && f.suppressed ? { suppressed: true } : {}),
    ...(result?.message ? { message: result.message } : {}),
    ...(result?.note ? { note: result.note } : {}),
    ...(result?.warning ? { warning: result.warning } : {}),
    ...(result?.bodies ? { bodies: result.bodies } : {}),
    ...(key ? { value: shown(key.value), unit: key.unit } : {}),
    ...fittedBrief(f),
    ...('exprs' in f && f.exprs ? { exprs: exprsForCommand(f.kind, f.exprs) } : {}),
    ...(Object.keys(errors).length > 0 ? { expressionErrors: errors } : {}),
    ...(f.kind === 'sketch'
      ? { plane: describePlaneRef(f.plane, { sections: store.sections, elements: store.elements }), pieces: f.sketch.entities.length, constraints: f.sketch.constraints.length }
      : { uses: referencesOf(f) }),
  }
}

/** The bodies of the last build, with the box round each. */
export function bodiesOut(session: ReverseSession | null = reverseSession()) {
  return useReverse.getState().bodies.map((b) => {
    const mesh = session?.meshes.get(b.id)
    return {
      id: b.id,
      name: b.name,
      ...(useReverse.getState().bodyStyles[b.id] ? { style: useReverse.getState().bodyStyles[b.id] } : {}),
      visible: b.visible,
      volume: b.volume,
      faces: b.faces,
      closed: b.closed,
      ...(b.surface ? { surface: true } : {}),
      bounds: mesh ? boundsOf(mesh.positions) : null,
    }
  })
}

const UNITS = Object.fromEntries(PARAMETER_KINDS.map((k) => [k.kind, k.unit]))

/** The model's parameters with what each comes to, and who reads it:
 *  usedBy is empty for one nothing reads, and drivesNothing marks one only
 *  other idle parameters read. */
export function parametersOut() {
  const re = useReverse.getState()
  const all = [...re.features, ...re.rolledBack]
  const idle = new Set(idleParameters(re.parameters, all).map((p) => p.id))
  return re.parameters.map((p) => {
    const reading = re.parameterTable.readings.find((r) => r.id === p.id)
    const users = usersOf(p.name, re.parameters, all)
    return {
      id: p.id,
      name: p.name,
      kind: p.kind,
      expression: p.expression,
      value: reading?.value ?? null,
      unit: UNITS[p.kind] ?? '',
      ...(reading?.error ? { error: reading.error } : {}),
      ...(p.comment ? { comment: p.comment } : {}),
      ...(p.pinned ? { pinned: true } : {}),
      usedBy: users.map((u) => (u.kind === 'parameter' ? { parameter: u.name } : { feature: u.name, fields: fieldsReading(all.find((f) => f.id === u.id)!, p.name) })),
      ...(idle.has(p.id) && users.length > 0 ? { drivesNothing: true } : {}),
    }
  })
}

/** The line a review or a final comparison carries for parameters that
 *  drive nothing — a table of them reads as a design that has none. */
export function idleParametersOut(): { idleParameters?: { names: string[]; say: string } } {
  const re = useReverse.getState()
  const names = idleParameters(re.parameters, [...re.features, ...re.rolledBack]).map((p) => p.name)
  if (names.length === 0) return {}
  return { idleParameters: { names, say: `${names.length === 1 ? 'This parameter drives' : 'These parameters drive'} nothing: no feature or sketch dimension reads ${names.length === 1 ? 'it' : 'them'}. Do not report ${names.length === 1 ? 'it' : 'them'} as drivers; wire ${names.length === 1 ? 'it' : 'them'} in with exprs, or remove ${names.length === 1 ? 'it' : 'them'}.` } }
}

/** A sketch's closed regions — what an extrude or a revolve picks — with a
 *  point inside each and the box round it, in the sketch's u and v. */
export function regionsOut(regions: readonly Region[]) {
  return regions.map((r) => {
    let lo: [number, number] = [Infinity, Infinity]
    let hi: [number, number] = [-Infinity, -Infinity]
    for (const [u, v] of r.outer.polygon) {
      lo = [Math.min(lo[0], u), Math.min(lo[1], v)]
      hi = [Math.max(hi[0], u), Math.max(hi[1], v)]
    }
    return { key: r.key, area: shown(r.area), inside: shown2(r.inside), holes: r.holes.length, min: shown2(lo), max: shown2(hi) }
  })
}

const featureName = (id: number) => {
  const re = useReverse.getState()
  return [...re.features, ...re.rolledBack].find((f) => f.id === Math.floor(id))?.name ?? null
}

/** A face of a body as reverse.body.describe lists it. */
export function faceOut(face: FaceInfo, index: number, mesh: KernelMesh | undefined) {
  const fp = face.fingerprint
  const round = fp.kind === 'cylinder' || fp.kind === 'cone' || fp.kind === 'torus'
  const boss = fp.kind === 'cylinder' && mesh && fp.center ? roundFaceIsBoss(mesh, face.hash, fp.center, fp.dir) : null
  return {
    index,
    kind: fp.kind,
    area: fp.area,
    centroid: fp.centroid,
    ...(round ? { axis: fp.dir } : { normal: fp.dir }),
    ...(fp.radius !== undefined ? { radius: fp.radius, diameter: 2 * fp.radius } : {}),
    ...(fp.center ? { center: fp.center } : {}),
    // A full round face's length along its axis, read off its area.
    ...(fp.kind === 'cylinder' && fp.radius ? { length: fp.area / (2 * Math.PI * fp.radius) } : {}),
    ...(boss !== null ? { side: boss ? 'boss' : 'bore' } : {}),
    madeBy: { id: fp.origin, name: featureName(fp.origin) },
    // A pattern's copy: made by what made the face it copies, and which
    // copy of the pattern it is on.
    ...(face.copy ? { copy: { pattern: { id: face.copy.pattern, name: featureName(face.copy.pattern) }, instance: face.copy.instance } } : {}),
    fingerprint: fp,
  }
}

/** An edge of a body as reverse.body.describe lists it: the faces on
 *  either side by their indices. */
export function edgeOut(edge: EdgeInfo, index: number, faceIndex: Map<number, number>) {
  const fp = edge.fingerprint
  return {
    index,
    kind: fp.kind,
    length: fp.length,
    mid: fp.mid,
    ...(fp.kind === 'circle' ? { axis: fp.dir } : { dir: fp.dir }),
    ...(fp.radius !== undefined ? { radius: fp.radius } : {}),
    ends: edge.ends,
    faces: edge.faces.map((h) => faceIndex.get(h) ?? null),
    madeBy: { id: fp.origin, name: featureName(fp.origin) },
    fingerprint: fp,
  }
}

/** Which editor of the panel is open, if any. */
function openEditor() {
  const re = useReverse.getState()
  if (re.sketchDraft) return { editor: 'sketch', name: re.sketchDraft.name, ...(re.sketchDraft.featureId !== undefined ? { feature: re.sketchDraft.featureId } : {}), pieces: re.sketchDraft.sketch.entities.length }
  const d = re.extrudeDraft ?? re.revolveDraft
  if (d) return { editor: re.extrudeDraft ? 'extrude' : 'revolve', ...(d.featureId !== undefined ? { feature: d.featureId } : {}) }
  if (re.featureDraft) return { editor: re.featureDraft.kind, ...(re.featureDraft.featureId !== undefined ? { feature: re.featureDraft.featureId } : {}) }
  return null
}

/** The workspace's part of the session's readout. */
export function describeReverse() {
  const re = useReverse.getState()
  const session = reverseSession()
  return {
    kernel: { status: re.kernelStatus, ...(re.kernelVersion ? { version: re.kernelVersion } : {}), ...(re.kernelMessage ? { message: re.kernelMessage } : {}) },
    ready: re.kernelStatus === 'ready',
    build: session?.buildState() ?? 'waiting',
    ...(re.buildError ? { buildError: re.buildError } : {}),
    open: openEditor(),
    parameters: parametersOut(),
    features: [...re.features.map((f) => featureBrief(f, false)), ...re.rolledBack.map((f) => featureBrief(f, true))],
    rollback: { at: re.features.length, of: re.features.length + re.rolledBack.length },
    bodies: bodiesOut(session),
  }
}


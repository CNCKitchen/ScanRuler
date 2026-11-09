// SPDX-License-Identifier: AGPL-3.0-only
// The Merge workspace's commands — what an agent lays extra scan passes on
// the scan through, registered from the plugin's install() under `merge`:
// merge.open_layer, merge.move_layer, merge.fit_datum, merge.align_pairs,
// merge.align_datums, merge.refine, merge.merge and the rest. Each is the
// panel's own verb (mergeSession.ts) and nothing more: the session checks,
// runs and records its own step of the undo history ("Merge: …"), so none
// of these is wrapped in one. A verb the session turned down says why on
// the error line, which becomes the command's refusal. Lengths go in and out
// in millimetres, whatever the panel shows.

import { CommandError, type Command } from '../../../src/plugins/api'
import { arr, bool, bytes, enumOf, int, num, obj, str, vec3, type JsonSchema } from '../../../src/commands/schema'
import { requireScan } from '../../../src/commands/refs'
import { fileNameSchema, fileOf, lastError } from '../../../src/commands/core/common'
import { cloneRigid, rigidCompose, rigidFromAxisAngle, rigidToColumnMajor, type Rigid } from '../../../src/core/deviation/rigid'
import { roundTo } from '../../../src/core/round'
import type { ElementKind, Vec3 } from '../../../src/core/types'
import { useStore } from '../../../src/state/store'
import { UNDER_CONSTRAINED } from '../core/datums'
import { BASE, type DatumIds } from '../core/protocol'
import type { LayerAlignResult } from '../core/layerAlign'
import { useMerge, type LayerRow, type LayerUnits } from '../state/mergeStore'
import { MESH_BASE_CONFIRM, mergeSession, type MergeSession } from './mergeSession'

/** The session the panel runs on, or why there is none. */
function sessionOf(): MergeSession {
  const s = mergeSession()
  if (!s) throw new CommandError('unavailable', 'The Merge workspace is not running.')
  return s
}

/** The layer an id names — `not_found` when there is none. */
function layerOf(id: string): LayerRow {
  const row = useMerge.getState().layers.find((l) => l.id === id)
  if (!row) throw new CommandError('not_found', `There is no layer "${id}".`)
  return row
}

/** A side of an alignment or a fit: the base, or a layer. */
function sideOf(id: string, what: string): void {
  if (id !== BASE && !useMerge.getState().layers.some((l) => l.id === id)) {
    throw new CommandError('not_found', `There is no ${what} "${id}" — "${BASE}" or a layer's id.`)
  }
}

/** Clear the error line, so a refusal read after a verb is its own. */
const fresh = () => useStore.setState({ errorText: null })

const failed = (fallback: string) => new CommandError('failed', lastError(fallback))

const round = (v: ArrayLike<number>, places = 6): number[] => Array.from(v, (x) => roundTo(x, places))
const poseOut = (pose: Rigid): number[] => round(rigidToColumnMajor(pose), 6)

/** The rotation of `deg` about x, then y, then z — the order of rigidOf in the tests. */
function rotationXYZ(deg: Vec3): Rigid {
  const rad = (d: number) => (d * Math.PI) / 180
  const rx = rigidFromAxisAngle([1, 0, 0], rad(deg[0]))
  const ry = rigidFromAxisAngle([0, 1, 0], rad(deg[1]))
  const rz = rigidFromAxisAngle([0, 0, 1], rad(deg[2]))
  return rigidCompose(rz, rigidCompose(ry, rx))
}

const alignOut = (id: string, target: string, r: LayerAlignResult) => ({
  id,
  target,
  rms: roundTo(r.rms, 4),
  matched: roundTo(r.matched, 4),
  confident: r.confident,
  low_overlap: r.lowOverlap,
  pose: poseOut(r.pose),
})

const POSE_NOTE = 'pose is the layer frame to the base as shown, 4x4 column-major, mm'

const unitsOf = enumOf<LayerUnits>(['mm', 'in'], 'The file’s units: mm (the default) or in. Read in mm either way.') // units-ok: ids of the file's units, not on-screen text

const datumIds = (what: string): JsonSchema =>
  obj(
    {
      primary: int('fit_id of the first datum, from merge.fit_datum.', { minimum: 0 }),
      secondary: int('fit_id of the second datum.', { minimum: 0 }),
      origin: int('fit_id of a point datum that sets the origin.', { minimum: 0 }),
    },
    ['primary'],
    what,
  )

type DatumsIn = { primary: number; secondary?: number; origin?: number }
const datumsOf = (d: DatumsIn): DatumIds => ({ primary: d.primary, secondary: d.secondary ?? null, origin: d.origin ?? null })

const open: Command<{ bytes: Uint8Array; name: string; units?: LayerUnits }> = {
  name: 'open_layer',
  title: 'Open a layer',
  description:
    'Open a scan pass — a point cloud or a mesh, PLY, STL, OBJ, 3MF, XYZ — as a layer beside the scan, to lay on it and merge. With no scan open the file becomes the scan instead: the answer’s id is then "base" and base is true. Returns the layer id, its name, point or vertex count, whether it is a cloud and its point spacing (mm); a layer starts where its file puts it, so move it near its place (merge.move_layer) or align it. No step of the history: merge.remove_layer takes it away.',
  input: obj({ bytes: bytes('The file’s contents.'), name: fileNameSchema('"pass2.ply"'), units: unitsOf }, ['bytes', 'name']),
  history: false,
  run: async ({ bytes: data, name, units }) => {
    const session = sessionOf()
    fresh()
    let id: string
    try {
      id = await session.openLayer(fileOf(data, name), units ?? 'mm')
    } catch (e) {
      throw new CommandError('failed', e instanceof Error ? e.message : String(e))
    }
    if (id === BASE) return { id, name, base: true }
    const row = layerOf(id)
    return { id, name: row.name, vertices: row.vertexCount, is_cloud: row.isCloud, spacing_mm: roundTo(row.spacing, 4) }
  },
}

const list: Command<Record<string, never>> = {
  name: 'list_layers',
  title: 'List the layers',
  description:
    'The layers opened beside the scan: id, name, units, whether shown or locked, vertex count, whether a cloud, point spacing (mm), pose (the layer frame to the base as shown, 4x4 column-major, mm), what its last alignment came to (rms mm, matched share, confident, low_overlap) and the datum fit_ids fitted on it; datums_base are those fitted on the scan. Changes nothing.',
  input: obj({}),
  readOnly: true,
  run: async () => {
    const m = useMerge.getState()
    const datumsAt = (side: string) => (m.datums[side] ?? []).map((d) => ({ fit_id: d.fitId, kind: d.kind }))
    return {
      layers: m.layers.map((l) => ({
        id: l.id,
        name: l.name,
        units: l.units,
        visible: l.visible,
        locked: l.locked,
        vertices: l.vertexCount,
        is_cloud: l.isCloud,
        spacing_mm: roundTo(l.spacing, 4),
        pose: poseOut(l.pose),
        ...(l.last ? { last: { rms: roundTo(l.last.rms, 4), matched: roundTo(l.last.matched, 4), confident: l.last.confident, low_overlap: l.last.lowOverlap } } : {}),
        datums: datumsAt(l.id),
      })),
      datums_base: datumsAt(BASE),
    }
  },
}

const move: Command<{ id: string; translate_mm?: Vec3; rotate_deg?: Vec3 }> = {
  name: 'move_layer',
  title: 'Move a layer',
  description:
    'Nudge a layer from where it stands: rotate_deg turns it about x, then y, then z (degrees) about the middle of its own bounding box, then translate_mm moves it (mm, in the base’s frame) — both relative to the current pose, not absolute. A locked layer refuses. One step of the history ("Merge: move layer"); it clears the layer’s last alignment and makes the pose a start a refine is confident from. Returns the new pose (' +
    POSE_NOTE +
    ').',
  input: obj(
    {
      id: str('The layer’s id, from merge.list_layers.'),
      translate_mm: vec3('Shift in the base’s frame, mm. [0, 0, 0] by default.'),
      rotate_deg: vec3('Turn about x, then y, then z, degrees, about the layer’s centre. [0, 0, 0] by default.'),
    },
    ['id'],
  ),
  history: false,
  run: async ({ id, translate_mm = [0, 0, 0], rotate_deg = [0, 0, 0] }) => {
    requireScan()
    const row = layerOf(id)
    if (row.locked) throw new CommandError('invalid_state', `${row.name} is locked — unlock it to move it.`)
    const session = sessionOf()
    // R about the centre's place c: x ↦ R(x − c) + c, then the shift.
    const rot = rotationXYZ(rotate_deg)
    const lc = session.layerCentre(id)
    const p = row.pose
    const c = [0, 1, 2].map((i) => p.r[i * 3] * lc[0] + p.r[i * 3 + 1] * lc[1] + p.r[i * 3 + 2] * lc[2] + p.t[i])
    const about: Rigid = cloneRigid(rot)
    for (let i = 0; i < 3; i++) about.t[i] = c[i] - (rot.r[i * 3] * c[0] + rot.r[i * 3 + 1] * c[1] + rot.r[i * 3 + 2] * c[2]) + translate_mm[i]
    fresh()
    if (!session.moveLayer(id, rigidCompose(about, p))) throw failed(`${row.name} did not move.`)
    return { id, pose: poseOut(layerOf(id).pose) }
  },
}

const FIT_KINDS = ['plane', 'cylinder', 'sphere'] as const

const fit: Command<{ layer: string; kind: ElementKind; seeds?: number[]; at?: Vec3 }> = {
  name: 'fit_datum',
  title: 'Fit a datum',
  description:
    'Fit a datum — a plane, cylinder or sphere — on a layer or on the scan ("base") from one place on it — `at`, a point in mm (in the layer’s own frame, as it was read; for "base" in the scan’s frame as shown), whose nearest vertex seeds the fit — or `seeds`, vertex numbers of that side (as scan.query gives for the scan); give exactly one. For merge.align_datums; it is kept by number, never a session element. Returns fit_id, kind and the fit’s centre, axis or normal, radius and sigma (mm). Two datums on each side are needed to align.',
  input: obj(
    {
      layer: str('A layer’s id, or "base" for the scan.'),
      kind: enumOf(FIT_KINDS, 'plane, cylinder or sphere.'),
      seeds: arr(int('A vertex number.', { minimum: 0 }), 'Vertices on the feature to fit, in place of at.', { minItems: 1 }),
      at: vec3('A point on the feature, mm — the nearest vertex of the layer is the seed; in place of seeds.'),
    },
    ['layer', 'kind'],
  ),
  history: false,
  long: true,
  run: async ({ layer, kind, seeds, at }) => {
    requireScan()
    if ((seeds === undefined) === (at === undefined)) throw new CommandError('invalid_input', 'Give seeds or at — exactly one of them.')
    sideOf(layer, 'layer')
    const session = sessionOf()
    fresh()
    const picked = seeds ?? [(await session.nearestVertex(layer, at!)).vertex]
    const r = await session.fitDatum(layer, kind, picked)
    if (!r) throw failed('The datum could not be fitted.')
    const f = r.fit as unknown as Record<string, unknown>
    const pick = (k: string) => (Array.isArray(f[k]) ? { [k]: round(f[k] as number[], 4) } : typeof f[k] === 'number' ? { [k]: roundTo(f[k] as number, 4) } : {})
    return { fit_id: r.fitId, kind: r.fit.kind, ...pick('center'), ...pick('axis'), ...pick('normal'), ...pick('radius'), ...pick('sigma') }
  },
}

interface AlignIn {
  id: string
  target: string
}

const alignTarget = { id: str('The layer to move, from merge.list_layers.'), target: str('What it lands on: "base" or another layer’s id.') }

/** The layer and its target checked, before the session runs. */
function checkAlign(id: string, target: string): void {
  requireScan()
  const row = layerOf(id)
  sideOf(target, 'target')
  if (target === id) throw new CommandError('invalid_input', 'A layer cannot be laid on itself.')
  if (row.locked) throw new CommandError('invalid_state', `${row.name} is locked — unlock it to move it.`)
}

const pairs: Command<AlignIn & { pairs: { layer: Vec3; target: Vec3 }[] }> = {
  name: 'align_pairs',
  title: 'Align a layer by point pairs',
  description:
    'Lay a layer on its target from three or more pairs of the same point: layer, a point on the layer in its own frame; target, the same point on the target in the target’s frame (mm). They must not lie in a line. The pairs give a start, which is then refined onto the target. One step of the history. Returns rms (mm, over the points that found the target), matched (share of the layer on the target), confident, low_overlap (check the result before merging) and pose (' +
    POSE_NOTE +
    ').',
  input: obj(
    {
      ...alignTarget,
      pairs: arr(
        obj({ layer: vec3('The point on the layer, in its own frame, mm.'), target: vec3('The same point on the target, in its frame, mm.') }, ['layer', 'target']),
        'At least three pairs.',
        { minItems: 3 },
      ),
    },
    ['id', 'target', 'pairs'],
  ),
  history: false,
  long: true,
  run: async ({ id, target, pairs: p }) => {
    checkAlign(id, target)
    fresh()
    const r = await sessionOf().alignPairs(id, target, p)
    if (!r) throw failed('The layer could not be aligned.')
    return alignOut(id, target, r)
  },
}

const datums: Command<AlignIn & { layer: DatumsIn; target_datums: DatumsIn }> = {
  name: 'align_datums',
  title: 'Align a layer by datums',
  description:
    'Lay a layer on its target by datums fitted on both (merge.fit_datum; the numbers are fit_ids): layer holds the layer’s, target_datums the target’s — a primary, a secondary that fixes the turn about it, and optionally an origin point. Two datums on each side are needed; one alone leaves the part free to turn or slide. The datums give a start, which is then refined. One step of the history. Returns rms (mm), matched, confident, low_overlap and pose (' +
    POSE_NOTE +
    ').',
  input: obj({ ...alignTarget, layer: datumIds('The layer’s datums.'), target_datums: datumIds('The target’s datums.') }, ['id', 'target', 'layer', 'target_datums']),
  history: false,
  long: true,
  run: async ({ id, target, layer, target_datums }) => {
    checkAlign(id, target)
    if (layer.secondary === undefined || target_datums.secondary === undefined) throw new CommandError('invalid_input', UNDER_CONSTRAINED)
    fresh()
    const r = await sessionOf().alignDatums(id, target, datumsOf(layer), datumsOf(target_datums))
    if (!r) throw failed('The layer could not be aligned.')
    return alignOut(id, target, r)
  },
}

const refine: Command<AlignIn> = {
  name: 'refine',
  title: 'Refine a layer',
  description:
    'Settle a layer onto its target from where it stands (closest-point refinement). Move or align it near its place first: a layer never moved or aligned is refined from no one’s guess and is never confident. One step of the history. Returns rms (mm), matched, confident, low_overlap (too little of it on the target — check the result before merging) and pose (' +
    POSE_NOTE +
    ').',
  input: obj(alignTarget, ['id', 'target']),
  history: false,
  long: true,
  run: async ({ id, target }) => {
    checkAlign(id, target)
    fresh()
    const r = await sessionOf().refine(id, target)
    if (!r) throw failed('The layer could not be refined.')
    return alignOut(id, target, r)
  },
}

const mergeCmd: Command<{ dedupe_mm?: number | null; confirm?: boolean }> = {
  name: 'merge',
  title: 'Merge the layers',
  description:
    'Merge the scan and the layers shown into one point cloud, in place of the scan, under everything measured on it (carried across and measured again); the layers are hidden after. dedupe_mm: a layer point within this of one kept before it goes (mm); null keeps every point; left out, the panel’s own (the layers’ median point spacing). A mesh scan becomes a cloud — triangle-only tools and their results go — so it is refused (with that warning) until confirm is true, which says yes to it. One step of the history ("Merge: merge layers"). Returns the points of the scan now and the layers merged.',
  input: obj({
    dedupe_mm: { oneOf: [num('mm.', { minimum: 0 }), { type: 'null' }], description: 'Drop doubles within this distance, mm; null keeps every point.' },
    confirm: bool('true: go ahead though the scan is a mesh and becomes a point cloud.'),
  }),
  history: false,
  long: true,
  run: async ({ dedupe_mm, confirm }) => {
    requireScan()
    const session = sessionOf()
    const shown = useMerge.getState().layers.filter((l) => l.visible).length
    if (shown === 0) throw new CommandError('invalid_state', 'Show at least one layer to merge — the hidden ones are left out.')
    const mesh = !useStore.getState().scanIsCloud
    if (mesh && confirm !== true) throw new CommandError('invalid_state', `${MESH_BASE_CONFIRM} Pass confirm: true to go ahead.`)
    fresh()
    const running = dedupe_mm === undefined ? session.mergeShown() : session.merge({ dedupe: dedupe_mm })
    // The question a mesh base asks is on the panel by now: yes, as confirmed.
    if (mesh) session.answerConfirm(true)
    if (!(await running)) throw failed('The layers were not merged.')
    return { points: useStore.getState().vertexCount, layers_merged: shown }
  },
}

const remove: Command<{ id: string }> = {
  name: 'remove_layer',
  title: 'Remove a layer',
  description: 'Close a layer: it goes from the panel, the viewport and the worker, with the datums fitted on it. The scan is untouched. Returns the layers left.',
  input: obj({ id: str('The layer’s id, from merge.list_layers.') }, ['id']),
  history: false,
  run: async ({ id }) => {
    requireScan()
    layerOf(id)
    fresh()
    await sessionOf().removeLayer(id)
    if (useMerge.getState().layers.some((l) => l.id === id)) throw failed(`Layer "${id}" could not be removed.`)
    return { removed: id, layers: useMerge.getState().layers.map((l) => l.id) }
  },
}

export const mergeCommands = [open, list, move, fit, pairs, datums, refine, mergeCmd, remove] as unknown as Command<never>[]

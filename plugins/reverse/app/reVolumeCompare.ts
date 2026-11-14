// SPDX-License-Identifier: AGPL-3.0-only
// reverse.body.volume_compare: the bodies against the scan as solids — the
// volume error of the core's Deviation workspace (core/deviation/volume)
// run on the bodies themselves, in the scan's frame, each region named by
// the body face nearest its deepest point and the feature that made it: a
// boss not modelled, a hole not cut, a wall too thick, as so many mm³ and
// where to look.

import { invalid } from '../../../src/commands/core/common'
import { commandHost } from '../../../src/commands/host'
import { arr, enumOf, int, num, obj, vec3 } from '../../../src/commands/schema'
import { errorMessage } from '../../../src/commands/types'
import { MAX_REGIONS, VOLUME_REGIONS, volumeOut } from '../../../src/commands/volumeAnswer'
import { identityRigid } from '../../../src/core/deviation/rigid'
import type { Vec3 } from '../../../src/core/types'
import { type Command, CommandError } from '../../../src/plugins/api'
import { useStore } from '../../../src/state/store'
import { mapChord } from '../core/compare'
import { meshFaultOut } from '../core/kernelMesh'
import { useRePrefs } from '../state/rePrefs'
import { bodyRows } from './reCommandAnswers'
import { allFeatures, bodyNamed, re, ready, type Ref } from './reCommandCore'
import { bodyRef } from './reSchemas'
import type { ReverseSession } from './reSession'

type VolumeIn = { bodies?: Ref[]; tolerance?: number; cell?: number; regions?: number; within?: { min: Vec3; max: Vec3 }; kinds?: ('excess' | 'missing' | 'unsure')[] }

export const volumeCompare: Command<VolumeIn> = {
  name: 'volume_compare',
  // The scan as a solid: a cloud has no inside to read.
  needsTriangles: true,
  title: 'Volume error of the bodies',
  description:
    // units-ok: the command's description, for the agent — in millimetres always.
    'The bodies and the scan compared as solids on a grid of small cells: each cell inside one and not the other is an error, touching cells a region — how much material is wrong and where, which reverse.body.compare’s nearest-point reading cannot say. Run it after each major step, before reading patches: a lump of more than a few mm³ is a feature missing or extra. excess is material the bodies have and the part has not, missing the other way round, wherever it is; where the scan has a hole the bodies stand in for it, and what it still does not say is unsure, never an error. Answers totals (mm³ and % of the bodies’ volume) and the regions largest first, each with kind, volume, maxDepth, thickness, shape (layer or lump), centroid, deepest, box, evidence, confidence and the body face nearest its deepest point with the feature that made it. Within the tolerance a difference is noise, and nothing thinner than smallestSeen (two cells) is seen — reverse.body.compare stays the tool for faces a few tenths off. The visible solids by default; a sheet has no inside. About 15 s on a 1.5M-triangle scan, less within a box. Shows nothing on screen. Needs a scan. Changes nothing.',
  input: obj({
    bodies: arr(bodyRef, 'The solid bodies; the visible ones by default.', { minItems: 1 }),
    // units-ok: the command's schema, for the agent — in millimetres always.
    tolerance: num('± mm: a difference within this of the scan’s surface is noise; the live map’s range by default.', { exclusiveMinimum: 0 }),
    // units-ok: as above.
    cell: num('The cell, mm; half the tolerance or a 250th of the bodies’ longest side by default.', { exclusiveMinimum: 0 }),
    regions: int(`How many regions to name; ${VOLUME_REGIONS} by default, ${MAX_REGIONS} at most.`, { minimum: 1, maximum: MAX_REGIONS }),
    // units-ok: as above.
    within: obj({ min: vec3('The lowest corner, mm.'), max: vec3('The highest corner, mm.') }, ['min', 'max'], 'Only this box, in the scan’s frame.'),
    kinds: arr(enumOf(['excess', 'missing', 'unsure'], 'A kind of region.'), 'Only regions of these kinds named; all by default. The totals are of all.'),
  }),
  readOnly: true,
  long: true,
  timeoutMs: 600_000,
  run: async ({ bodies, tolerance, cell, regions = VOLUME_REGIONS, within, kinds }, ctx) => {
    if (!useStore.getState().fileName) throw new CommandError('no_scan', 'There is no scan to compare the bodies with.')
    if (within) for (let k = 0; k < 3; k++) if (!(within.min[k] < within.max[k])) invalid('within: min must lie below max on every axis.')
    const s = await ready()
    const picked = bodies ? bodies.map(bodyNamed) : re().bodies.filter((b) => b.visible && !b.surface)
    if (picked.length === 0) throw new CommandError('invalid_state', 'There is no solid body to compare — build one first.')
    const sheet = picked.find((b) => b.surface)
    if (sheet) invalid(`bodies: ${sheet.name} is a sheet — a volume error needs solids, which have an inside.`)
    const out = await measureVolume(s, picked, { tolerance: tolerance ?? useRePrefs.getState().liveMapRange, cell, regions, within, kinds }, ctx.progress)
    return { bodies: picked.map((b) => ({ id: b.id, name: b.name })), ...out }
  },
}

/** What measureVolume answers: volume_compare's figures (volumeOut), each
 *  region named by the body face nearest its deepest point. */
export type VolumeMeasured = Awaited<ReturnType<typeof measureVolume>>

/**
 * The bodies against the scan as solids — reverse.body.volume_compare
 * without its checks of the input, for whatever else runs one (the
 * review): the bodies meshed to the map's chord for the tolerance, the
 * volume error found on a grid, the regions named by the body face nearest
 * their deepest point, and the measurement kept for the comparisons after
 * (volumeInView).
 */
export async function measureVolume(s: ReverseSession, picked: readonly { id: number; name: string }[], { tolerance: tol, cell, regions = VOLUME_REGIONS, within, kinds }: { tolerance: number; cell?: number; regions?: number; within?: { min: Vec3; max: Vec3 }; kinds?: ('excess' | 'missing' | 'unsure')[] }, progress: (text: string) => void = () => {}) {
  const kernel = s.client()
  const scanClient = commandHost().session.clientRef.current
  if (!kernel || !scanClient) throw new CommandError('unavailable', 'The CAD kernel or the mesh worker is not running.')

  // The bodies as one mesh, each triangle with its body and face.
  progress('Meshing the bodies…')
  const meshes = await kernel.referenceMeshes(picked.map((b) => b.id), mapChord(tol))
  if (meshes.length !== picked.length) throw new CommandError('internal', `${picked.length} bodies asked for, ${meshes.length} meshed.`)
  let vertices = 0, corners = 0
  for (const m of meshes) {
    vertices += m.positions.length
    corners += m.indices.length
  }
  const positions = new Float32Array(vertices)
  const indices = new Uint32Array(corners)
  const bodyOf = new Float64Array(corners / 3)
  const faceOf = new Int32Array(corners / 3).fill(-1)
  let pv = 0, pi = 0
  meshes.forEach((m, b) => {
    positions.set(m.positions, pv)
    for (let i = 0; i < m.indices.length; i++) indices[pi + i] = m.indices[i] + pv / 3
    bodyOf.fill(picked[b].id, pi / 3, (pi + m.indices.length) / 3)
    if (m.faceHash) faceOf.set(m.faceHash, pi / 3)
    pv += m.positions.length
    pi += m.indices.length
  })

  progress('Finding volume errors…')
  let volume
  try {
    // The bodies were built on the scan, in its frame.
    volume = await scanClient.deviateVolume(identityRigid(), tol, { mesh: { positions, indices }, ...(cell !== undefined ? { cell } : {}), ...(within ? { within } : {}) })
  } catch (e) {
    throw new CommandError('failed', errorMessage(e))
  }
  const out = volumeOut(volume, tol, regions, kinds)
  const rows = bodyRows(s)
  // Each region named by the face nearest its deepest point.
  const listed = volume.regions.filter((r) => (!kinds || kinds.includes(r.kind)) && (r.kind !== 'unsure' || r.cells >= 64)).slice(0, regions)
  const name = (id: number) => re().bodies.find((b) => b.id === id)?.name ?? `Body ${id}`
  const faceNamed = (body: number, hash: number) => {
    const t = s.topologies.get(body)
    const i = t ? t.faces.findIndex((f) => f.hash === hash) : -1
    if (!t || i < 0) return null
    const fp = t.faces[i].fingerprint
    return { index: i, kind: fp.kind, madeBy: { id: fp.origin, name: allFeatures().find((f) => f.id === fp.origin)?.name ?? null } }
  }
  const named = out.regions.map((r, i) => {
    const t = listed[i].referenceTriangle
    if (t < 0) return { ...r, body: null, face: null }
    const body = bodyOf[t]
    return { ...r, body: { id: body, name: name(body) }, face: faceOf[t] >= 0 ? faceNamed(body, faceOf[t]) : null }
  })
  // What the mesher could not draw whole, face by face.
  const meshFaults = meshes.flatMap((m, b) => (m.faults ?? []).map((f) => meshFaultOut(picked[b].name, f, faceNamed(picked[b].id, f.hash))))
  const warnings = [...meshFaults.map((f) => f.words), ...(out.warnings ?? [])]
  const last = re().features.at(-1)
  kept = {
    file: useStore.getState().fileName,
    step: re().features.length,
    feature: last?.name ?? null,
    rows: new Map(picked.map((b) => [b.id, rows.get(b.id) ?? ''])),
    excess: out.totals.excess,
    missing: out.totals.missing,
    largest: named.filter((r) => r.kind !== 'unsure').slice(0, KEPT_REGIONS).map((r) => ({ kind: r.kind, volume: r.volume, maxDepth: r.maxDepth, centroid: r.centroid, ...(r.face ? { face: { body: r.body?.name ?? null, index: r.face.index, madeBy: r.face.madeBy.name } } : {}) })),
    ...(within ? { within } : {}),
  }
  return { ...out, regions: named, ...(meshFaults.length > 0 ? { meshFaults } : {}), ...(warnings.length > 0 ? { warnings } : {}) }
}

/** How many of the last volume compare's regions a comparison carries. */
const KEPT_REGIONS = 2

/** The last volume compare, as a comparison carries it after: the scan it
 *  was of, the step the list stood at, the bodies as they were (their rows,
 *  to tell a change by), the totals and the largest regions. */
interface VolumeKept {
  file: string | null
  step: number
  feature: string | null
  rows: Map<number, string>
  excess: { volume: number; share: number }
  missing: { volume: number; share: number }
  largest: Record<string, unknown>[]
  within?: { min: Vec3; max: Vec3 }
}

let kept: VolumeKept | null = null

/**
 * What reverse.body.compare and compare_in_deviation say of the volume
 * error beside their own reading, so the volume compare stays in view: the
 * last one's totals and its largest regions while the bodies compared are
 * as it found them; once they have changed, since which step it was run
 * and what it said then; never run on this scan, that it was not.
 */
export function volumeInView(s: ReverseSession, ids: readonly number[]): string | Record<string, unknown> {
  const file = useStore.getState().fileName
  const ask = 'reverse.body.volume_compare'
  if (!kept || kept.file !== file) return `not compared yet — ${ask}: how much material is wrong and where, which this nearest-point reading cannot say`
  const rows = bodyRows(s)
  const changed = [...new Set([...kept.rows.keys(), ...ids])].some((id) => kept!.rows.get(id) !== rows.get(id))
  const at = `step ${kept.step}${kept.feature ? `, ${kept.feature}` : ''}`
  // units-ok: the agent's answer — in millimetres always.
  if (changed) return `volume not compared since ${at} (excess ${kept.excess.volume} / missing ${kept.missing.volume} mm³ then) — ${ask}`
  return { at, excess: kept.excess, missing: kept.missing, largest: kept.largest, ...(kept.within ? { within: kept.within } : {}) }
}

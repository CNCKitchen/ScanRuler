// SPDX-License-Identifier: AGPL-3.0-only
// Surface deviation: the scan against a reference part — opened, best-fitted
// onto it, mapped — or against one of its own fitted elements.

import type { MeshUnits } from '../../core/meshUnits'
import { isDeviationTarget } from '../../core/deviation/elementField'
import type { Hotspot } from '../../core/deviation/hotspots'
import { FEATURE_DEPTH, FEATURE_MIN_AREA, FEATURE_MIN_SPACINGS, type PatchKind } from '../../core/deviation/patchKind'
import { rigidApply } from '../../core/deviation/rigid'
import type { Vec3 } from '../../core/types'
import { useDeviation, type MapSide } from '../../state/deviationStore'
import { usePrefs } from '../../state/prefsStore'
import { COLORMAPS, type ColormapId } from '../../core/field/colormap'
import { useMark } from '../../state/markStore'
import { useStore } from '../../state/store'
import { commandHost, requireScene, sceneOf } from '../host'
import { elementRefSchema, measuredElement, requireScan, type ElementRef } from '../refs'
import { arr, bool, bytes, enumOf, int, num, obj, oneOf, vec3, type JsonSchema } from '../schema'
import { describeDeviation } from '../state'
import { CommandError, type Command } from '../types'
import { fileNameSchema, fileOf, lastError, mapSettled, showWorkspace, waitFor } from './common'
import { unitsSchema } from './scan'
import { round3 } from '../../core/round'
import { deviationFileBytes, isMeasured, type DeviationFormat } from '../../core/deviation/exportDeviation'
import { exportStem } from '../../app/exports'

const nullable = (schema: JsonSchema, description: string): JsonSchema =>
  oneOf([schema, { type: 'null', description: 'Off.' }], description)

function requireReference() {
  requireScan()
  if (!useDeviation.getState().nominalName) {
    throw new CommandError('invalid_state', 'No reference part is open — open one with deviation.open_reference.')
  }
}

/** Measuring against the reference part rather than an element. */
function onReference() {
  showWorkspace('deviation')
  if (useDeviation.getState().source !== 'reference') useDeviation.getState().setSource('reference')
}

const openReference: Command<{ bytes: Uint8Array; name: string; units?: MeshUnits }> = {
  name: 'open_reference',
  title: 'Open the reference part',
  description:
    'Open the nominal part the scan is compared with — STEP from CAD, or STL, PLY, OBJ or 3MF — in place of the one there is; any alignment and map against the old one go, the elements measured on the scan stay. Returns the deviation state. Not undoable: a new reference starts a new history.',
  input: obj({ bytes: bytes('The file’s contents.'), name: fileNameSchema('"bracket.step"'), units: unitsSchema }, ['bytes', 'name']),
  history: false,
  run: async ({ bytes: data, name, units }) => {
    const { session } = commandHost()
    onReference()
    const before = session.clientRef.current!.nominalVersion
    await session.deviation.openNominal(fileOf(data, name), units ?? 'mm')
    if (session.clientRef.current!.nominalVersion === before) {
      throw new CommandError('failed', lastError(`${name} could not be opened.`))
    }
    return { deviation: describeDeviation(), status: useStore.getState().statusText }
  },
}

interface Pair { scan: [number, number, number]; reference: [number, number, number] }

const align: Command<{ mode?: 'auto' | 'points' | 'local'; pairs?: Pair[]; vertices?: number[]; searchDistance?: number }> = {
  name: 'align',
  title: 'Best-fit the scan onto the reference',
  description:
    'Rigid best fit (no scale) of the scan onto the reference part, then the deviation map under it. mode auto (the default) finds the pose on its own; points starts from three or more pairs of corresponding points (scan and reference, mm) then refines; local refines the fit in hand on a marked surface only (vertices), within searchDistance mm. Returns the alignment (RMS, points matched, transform) and the map’s statistics. One undo step.',
  input: obj({
    mode: enumOf(['auto', 'points', 'local'], 'auto (the default), points or local.'),
    pairs: arr(
      obj({ scan: vec3('On the scan, mm.'), reference: vec3('The same point on the reference, mm.') }, ['scan', 'reference']),
      'points: the corresponding pairs.',
      { minItems: 3 },
    ),
    vertices: arr(int(undefined, { minimum: 0 }), 'local: the surface to refine on, scan vertex numbers.', { minItems: 3 }),
    searchDistance: num('local: how far a point may lie from the reference to count, mm.', { exclusiveMinimum: 0 }),
  }),
  label: ({ mode = 'auto' }) => (mode === 'local' ? 'local fine fit' : 'best-fit alignment'),
  run: async ({ mode = 'auto', pairs, vertices, searchDistance }) => {
    requireReference()
    onReference()
    const { session } = commandHost()
    const dev = useDeviation.getState()
    if (mode === 'points') {
      if (!pairs) throw new CommandError('invalid_input', 'points needs pairs.')
      // A clean sheet, as the picker opens with: nothing marked narrows the
      // refinement but the pairs given.
      session.sceneRef.current?.clearPaint()
      useMark.getState().reset()
      dev.clearPairs()
      for (const p of pairs) {
        useDeviation.getState().addPickPoint('scan', p.scan)
        useDeviation.getState().addPickPoint('nominal', p.reference)
      }
      await session.deviation.runAlign(true)
    } else if (mode === 'local') {
      if (!dev.align) throw new CommandError('invalid_state', 'There is no alignment to refine — run deviation.align first.')
      if (!vertices) throw new CommandError('invalid_input', 'local needs vertices — the surface to refine on.')
      const count = useStore.getState().vertexCount
      if (vertices.some((v) => v >= count)) throw new CommandError('invalid_input', `The scan has ${count} vertices.`)
      if (searchDistance !== undefined) dev.setLocalMaxDistance(searchDistance)
      await session.deviation.runLocalAlign(Uint32Array.from(vertices))
    } else {
      await session.deviation.runAlign(false)
    }
    const after = useDeviation.getState()
    if (after.alignStatus !== 'done' || !after.align) {
      throw new CommandError('failed', after.alignMessage ?? 'The alignment did not converge.')
    }
    return { deviation: describeDeviation(), status: useStore.getState().statusText }
  },
}

const measure: Command = {
  name: 'measure',
  title: 'Measure the deviation map',
  description:
    'Measure the deviation map again under the alignment in hand — after a change of facing limit or search distance, say. deviation.align measures it already. Returns the map’s statistics (min, max, mean, RMS, sigma, share within the tolerance, points matched). One undo step.',
  input: obj({}),
  label: () => 'measure deviation',
  run: async () => {
    requireReference()
    onReference()
    if (!useDeviation.getState().align) throw new CommandError('invalid_state', 'The scan is not aligned to the reference — run deviation.align first.')
    await commandHost().session.deviation.runDeviation()
    const d = useDeviation.getState()
    if (d.mapStatus !== 'ready') throw new CommandError('failed', lastError('The deviation could not be measured.'))
    return { deviation: describeDeviation() }
  },
}

const setTarget: Command<{ element: ElementRef | null; side?: 'outward' | 'inward'; facingDeg?: number | null }> = {
  name: 'set_target',
  title: 'Measure against an element',
  description:
    'Map how far the scan strays from one of its own fitted elements — a plane, cylinder, cone, sphere or torus — instead of from a reference part; null goes back to the reference. side is the material side, read off the scan when the element is chosen (outward: the element’s outer side; inward: a bore or shell) — give it to override. facingDeg limits which surface counts to what faces the element within that many degrees, null for any. Needs the viewport. Returns the map’s statistics. One undo step.',
  input: obj(
    {
      element: oneOf([elementRefSchema('The element.'), { type: 'null', description: 'Back to the reference part.' }], 'The element, or null.'),
      side: enumOf(['outward', 'inward'], 'The material side; read off the scan by default.'),
      facingDeg: nullable(num(undefined, { minimum: 1, maximum: 90 }), 'The facing limit, degrees, or null for any.'),
    },
    ['element'],
  ),
  label: () => 'measure against element',
  run: async ({ element, side, facingDeg }) => {
    requireScan()
    const scene = requireScene('A map against an element')
    showWorkspace('deviation')
    const { session } = commandHost()
    if (element === null) {
      session.deviation.selectTarget(null)
      useDeviation.getState().setSource('reference')
      return { deviation: describeDeviation() }
    }
    const el = measuredElement(element)
    if (!isDeviationTarget(el.fit)) throw new CommandError('invalid_input', `A ${el.kind} has no surface to measure against.`)
    if (useDeviation.getState().source !== 'element') useDeviation.getState().setSource('element')
    session.deviation.selectTarget(el.id)
    const want = side === undefined ? undefined : side === 'outward' ? 1 : -1
    if (want !== undefined && useDeviation.getState().targetSide !== want) useDeviation.getState().flipTargetSide()
    if (facingDeg !== undefined) useDeviation.getState().setTargetFacing(facingDeg)
    // The map follows the choice on its own (useElementField), once the stores' change has reached it.
    await mapSettled(scene, { always: true })
    if (useDeviation.getState().elementStatus !== 'ready') throw new CommandError('failed', 'The map against the element could not be measured.')
    return { deviation: describeDeviation() }
  },
}

/** The map's reading a command that measures one may set first, as
 *  deviation.settings sets it: the colour scale, the search distance and
 *  the tolerance, as inputs. */
export const readingInput = {
  range: num('Colour scale, ± mm.', { exclusiveMinimum: 0 }),
  maxDistance: num('Search distance, mm.', { exclusiveMinimum: 0 }),
  tolerance: num('Tolerance, ± mm.', { exclusiveMinimum: 0 }),
}

export type Reading = { range?: number; maxDistance?: number; tolerance?: number }

/** Set the reading as given (readingInput) — a search distance given is
 *  then set by hand, no longer automatic — and answer the one standing
 *  now. */
export function setReading({ range, maxDistance, tolerance }: Reading): { range: number; maxDistance: number; maxDistanceAuto: boolean; tolerance: number } {
  const d = useDeviation.getState()
  if (range !== undefined) d.setRange(range)
  if (maxDistance !== undefined) d.setMaxDistance(maxDistance)
  if (tolerance !== undefined) d.setTolerance(tolerance)
  const now = useDeviation.getState()
  return { range: now.range, maxDistance: now.maxDistance, maxDistanceAuto: now.maxDistanceAuto, tolerance: now.tolerance }
}

const settings: Command<{ range?: number; maxDistance?: number; bands?: number | null; tolerance?: number; facingDeg?: number | null; colormap?: ColormapId; on?: MapSide; show?: boolean }> = {
  name: 'settings',
  title: 'Set how the deviation is read',
  description:
    'The deviation map’s reading: range (colour scale, ± mm), maxDistance (search distance, mm), bands, tolerance (± mm the statistics count within), facingDeg (a change measures the map again), colormap (the person’s own choice, kept outside the undo — read settings.colormap for the ramp before judging a picture), on (which surface a map against the reference is painted on; read both sides) and show (the map switch; false leaves the surface bare, the map still measured). Returns the deviation state. Trap: the map paints in the Deviation workspace only — workspace.set deviation brings it back, and view.render says which map it painted (map) or why none (mapWhy). One undo step.',
  input: obj({
    range: readingInput.range,
    maxDistance: readingInput.maxDistance,
    bands: nullable(int(undefined, { minimum: 2, maximum: 256 }), 'Stepped colours, or null for smooth.'),
    tolerance: readingInput.tolerance,
    facingDeg: nullable(num(undefined, { minimum: 1, maximum: 90 }), 'Facing limit, degrees, or null.'),
    colormap: enumOf(
      COLORMAPS.map((m) => m.id),
      'jet (blue inside, green on the surface, red outside) or a perceptual ramp.',
    ),
    on: enumOf(['scan', 'reference'], 'The surface the map is painted on; scan by default.'),
    show: bool('The map painted (true) or the surface left bare (false).'),
  }),
  label: () => 'deviation settings',
  run: async ({ range, maxDistance, bands, tolerance, facingDeg, colormap, on, show }) => {
    const { session } = commandHost()
    const d = useDeviation.getState()
    if (colormap !== undefined) usePrefs.getState().setColormap(colormap)
    setReading({ range, maxDistance, tolerance })
    if (bands !== undefined) d.setBands(bands)
    if (show !== undefined) d.setShowMap(show)
    if (facingDeg !== undefined) {
      session.deviation.setMapFacing(facingDeg)
      await waitFor(() => useDeviation.getState().mapStatus !== 'running', 'the map to be measured again')
    }
    if (on !== undefined) {
      if (on === 'reference' && d.source !== 'reference') throw new CommandError('invalid_state', 'The map is measured against an element — there is no reference part to paint it on.')
      await session.deviation.setMapOn(on)
    }
    return { deviation: describeDeviation() }
  },
}

/** How many patches an answer names unless told otherwise, and how many
 *  of a patch's vertices. */
const HOTSPOT_PATCHES = 8
const HOTSPOT_VERTICES = 12

/** The figures every answer about a patch gives first, in this order:
 *  where it is, how big, how far off, and so what it is. */
export function patchFigures(p: { centroid: readonly number[]; min: readonly number[]; max: readonly number[]; area: number; count: number; mean: number; extreme: number; depth: number; volume: number; kind: PatchKind }) {
  return {
    centroid: p.centroid.map(round3),
    box: { min: p.min.map(round3), max: p.max.map(round3) },
    area: round3(p.area),
    count: p.count,
    mean: round3(p.mean),
    extreme: round3(p.extreme),
    depth: round3(p.depth),
    volume: round3(p.volume),
    kind: p.kind,
  }
}

/** What the feature patches come to, as every answer with patches gives
 *  it beside them: how many, their share of what lies past the tolerance,
 *  and what a feature patch asks of a model. */
export function featuresOut(f: { count: number; shareOfExcess: number }) {
  return { count: f.count, shareOfExcess: round3(f.shareOfExcess), ...(f.count > 0 ? { note: FEATURES_NOTE } : {}) }
}

const FEATURES_NOTE = 'each feature patch is material missing or misplaced: model it or name it'

/** How a patch's kind, depth and volume read, for the commands that
 *  answer patches to say so. */
export const PATCH_KIND_WORDS = `depth, the median |deviation| over the patch; volume, mm³ past the tolerance (the ranking key); kind, "feature" when the patch is at least ${FEATURE_MIN_AREA} mm² and ${FEATURE_MIN_SPACINGS} point spacings² across and its depth at least ${FEATURE_DEPTH}× the tolerance — material missing or misplaced, to model or to name — else "texture", the surface's own roughness poking past the tolerance, small or shallow`

const hotspotsCommand: Command<{ tolerance?: number; patches?: number; grain?: number; on?: MapSide }> = {
  name: 'hotspots',
  title: 'Where the deviation lies over tolerance',
  description:
    `The deviation map read as patches: the vertices past the tolerance gathered into connected regions, the largest and farthest first — where the part is off, how large each place is and by how much. Needs a map (deviation.align or deviation.set_target). Returns each patch’s centroid, box, area, count, mean, extreme, depth, volume, kind ("feature": material missing or misplaced, to model or name; "texture": roughness), side, the extreme’s point and vertex, a few vertices, and onReference; features, found, over and unmeasured; on: "reference" reads the map on the reference, adding noScan. Trap: read far every time — the vertices past the search distance, which the map draws bare: far.inside is scan deep inside the reference (a hole, pocket or slot the model lacks), far.outside scan standing off it. Changes nothing.`,
  input: obj({
    tolerance: num('± mm; the map’s tolerance by default.', { exclusiveMinimum: 0 }),
    patches: int(`How many patches to name; ${HOTSPOT_PATCHES} by default, 50 at most.`, { minimum: 1, maximum: 50 }),
    grain: num('mm two vertices over tolerance may lie apart and be one patch; three point spacings by default.', { exclusiveMinimum: 0 }),
    on: enumOf(['scan', 'reference'], 'The map read: on the scan (the default) or on the reference.'),
  }),
  readOnly: true,
  run: async ({ tolerance, patches = HOTSPOT_PATCHES, grain, on = 'scan' }) => {
    requireScan()
    if (on === 'reference') return referenceHotspots(tolerance, patches, grain)
    await mapSettled(sceneOf())
    const d = useDeviation.getState()
    const maps = commandHost().session.maps
    const values = d.source === 'element' ? maps.elementField.current : maps.deviation.current
    const ready = d.source === 'element' ? d.elementStatus === 'ready' : d.mapStatus === 'ready'
    if (!ready || !values) throw new CommandError('invalid_state', 'There is no deviation map to read — deviation.align measures one against the reference part, deviation.set_target one against an element.')
    const client = commandHost().session.clientRef.current
    if (!client) throw new CommandError('unavailable', 'The mesh worker is not running.')
    const n = useStore.getState().vertexCount
    const all = await client.query({ min: [-Infinity, -Infinity, -Infinity], max: [Infinity, Infinity, Infinity], limit: n })
    if (all.positions.length !== values.length * 3) throw new CommandError('internal', `The map has ${values.length} readings and the scan ${all.positions.length / 3} vertices.`)
    const tol = tolerance ?? d.tolerance
    // Loaded when first asked for: the gathering is no part of the page
    // that every session loads.
    const { hotspots } = await import('../../core/deviation/hotspots')
    const m = d.source === 'reference' && d.align ? d.align.transform : null
    const out = new Float64Array(3)
    const onReference = (p: Vec3): Vec3 => {
      rigidApply(m!, p[0], p[1], p[2], out)
      return [round3(out[0]), round3(out[1]), round3(out[2])]
    }
    const patchOut = (p: Hotspot) => {
      const stride = Math.max(1, Math.floor(p.members.length / HOTSPOT_VERTICES))
      const vertices: number[] = []
      for (let k = 0; k < p.members.length && vertices.length < HOTSPOT_VERTICES; k += stride) vertices.push(p.members[k])
      return {
        ...patchFigures(p),
        side: p.extreme > 0 ? 'outside' : 'inside',
        at: p.at.map(round3),
        vertex: p.index,
        vertices,
        ...(m ? { onReference: { centroid: onReference(p.centroid), at: onReference(p.at) } } : {}),
      }
    }
    // The map's search distance parts the measured from the bare: the
    // patches are of the measured, and the bare are told on their own, by
    // side — a vertex deep inside the reference is a hole the model lacks,
    // which no patch over tolerance would show.
    const search = d.maxDistance
    const measured = (i: number) => Math.abs(values[i]) <= search
    const report = hotspots(all.positions, values, tol, { limit: patches, ...(grain !== undefined ? { grain } : {}), only: measured })
    let unmeasured = 0
    let farInside = 0
    let farOutside = 0
    for (let i = 0; i < values.length; i++) {
      const v = values[i]
      if (!Number.isFinite(v)) unmeasured++
      else if (v < -search) farInside++
      else if (v > search) farOutside++
    }
    const farSide = (inside: boolean, count: number) => {
      if (count === 0) return { count, found: 0, patches: [] }
      const r = hotspots(all.positions, values, search, { limit: patches, ...(grain !== undefined ? { grain } : {}), featureDepth: FEATURE_DEPTH * tol, only: (i) => (values[i] < 0) === inside })
      return { count, found: r.found, patches: r.patches.map(patchOut) }
    }
    return {
      source: d.source,
      tolerance: tol,
      over: report.over,
      found: report.found,
      features: featuresOut(report.features),
      spacing: round3(report.spacing),
      grain: round3(report.grain),
      patches: report.patches.map(patchOut),
      far: { searchDistance: search, count: farInside + farOutside, inside: farSide(true, farInside), outside: farSide(false, farOutside) },
      unmeasured,
    }
  },
}

/** The patches of kind "feature" over the tolerance on the scan's map —
 *  within the search distance, and past it by side — each with the point
 *  of its extreme, its depth past the tolerance and whether it lies far:
 *  material missing, misplaced or extra, as hotspotsCommand reads it,
 *  for a judgement on the model as a whole. Empty with no map to read. */
export async function scanFeaturePatches(tolerance: number | undefined, limit = 50): Promise<{ at: Vec3; depth: number; far: boolean; outside: boolean }[]> {
  await mapSettled(sceneOf())
  const d = useDeviation.getState()
  const maps = commandHost().session.maps
  const values = d.source === 'element' ? maps.elementField.current : maps.deviation.current
  const ready = d.source === 'element' ? d.elementStatus === 'ready' : d.mapStatus === 'ready'
  if (!ready || !values) return []
  const client = commandHost().session.clientRef.current
  if (!client) return []
  const n = useStore.getState().vertexCount
  const all = await client.query({ min: [-Infinity, -Infinity, -Infinity], max: [Infinity, Infinity, Infinity], limit: n })
  if (all.positions.length !== values.length * 3) return []
  const tol = tolerance ?? d.tolerance
  const { hotspots } = await import('../../core/deviation/hotspots')
  const search = d.maxDistance
  const out: { at: Vec3; depth: number; far: boolean; outside: boolean }[] = []
  const take = (report: ReturnType<typeof hotspots>, far: boolean) => {
    for (const p of report.patches) if (p.kind === 'feature') out.push({ at: [p.at[0], p.at[1], p.at[2]], depth: p.depth, far, outside: p.extreme > 0 })
  }
  take(hotspots(all.positions, values, tol, { limit, only: (i) => Math.abs(values[i]) <= search }), false)
  for (const inside of [true, false]) {
    let any = false
    for (let i = 0; i < values.length && !any; i++) if (Number.isFinite(values[i]) && Math.abs(values[i]) > search && values[i] < 0 === inside) any = true
    if (any) take(hotspots(all.positions, values, search, { limit, featureDepth: FEATURE_DEPTH * tol, only: (i) => Number.isFinite(values[i]) && Math.abs(values[i]) > search && values[i] < 0 === inside }), true)
  }
  return out
}

/** The map on the reference read as patches — see hotspotsCommand. */
export async function referenceHotspots(tolerance: number | undefined, patches: number, grain: number | undefined) {
  const d = useDeviation.getState()
  const { session } = commandHost()
  if (d.source !== 'reference' || !d.align || d.mapStatus !== 'ready') throw new CommandError('invalid_state', 'There is no map against the reference part — deviation.align measures one.')
  if (d.referenceStatus !== 'ready') await session.deviation.runReferenceMap()
  const map = session.maps.referenceMap.current
  if (useDeviation.getState().referenceStatus !== 'ready' || !map) throw new CommandError('invalid_state', `The map on the reference could not be measured${useDeviation.getState().alignMessage ? `: ${useDeviation.getState().alignMessage}` : ''}.`)
  const { hotspots } = await import('../../core/deviation/hotspots')
  const { values, positions } = map
  const tol = tolerance ?? d.tolerance
  const search = d.maxDistance
  // The readings lie about the spacing apart, by how the reference was
  // cut: three of them make a patch's grain unless told.
  const opts = { limit: patches, grain: grain ?? 3 * map.spacing, featureDepth: FEATURE_DEPTH * tol }
  const patchOut = (p: Hotspot) => ({ ...patchFigures(p), side: p.extreme > 0 ? 'outside' : 'inside', at: p.at.map(round3) })
  const report = hotspots(positions, values, tol, { ...opts, only: (i) => Math.abs(values[i]) <= search })
  let farProud = 0
  let farShort = 0
  let noScan = 0
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (Number.isNaN(v)) noScan++
    else if (v > search) farProud++
    else if (v < -search) farShort++
  }
  const farSide = (proud: boolean, count: number) => {
    if (count === 0) return { count, found: 0, patches: [] }
    const r = hotspots(positions, values, search, { ...opts, only: (i) => (values[i] > 0) === proud })
    return { count, found: r.found, patches: r.patches.map(patchOut) }
  }
  // No scan as a field of its own: one where there is none, nothing where
  // there is.
  const bare = new Float32Array(values.length)
  for (let i = 0; i < values.length; i++) bare[i] = Number.isNaN(values[i]) ? 1 : 0
  const unbacked = noScan > 0 ? hotspots(positions, bare, 0.5, opts) : null
  const bareOut = (p: Hotspot) => {
    const { centroid, box, area, count } = patchFigures(p)
    return { centroid, box, area, count }
  }
  return {
    on: 'reference',
    tolerance: tol,
    spacing: round3(map.spacing),
    over: report.over,
    found: report.found,
    features: featuresOut(report.features),
    patches: report.patches.map(patchOut),
    far: { searchDistance: search, count: farProud + farShort, outside: farSide(true, farProud), inside: farSide(false, farShort) },
    noScan: { count: noScan, found: unbacked?.found ?? 0, patches: (unbacked?.patches ?? []).map(bareOut) },
  }
}

const exportCommand: Command<{ side?: MapSide; format?: DeviationFormat }> = {
  name: 'export',
  title: 'Export the deviation as data',
  description:
    'The deviation map as a file of readings, for working on it elsewhere: side "scan" (the default) a reading per scan vertex with its signed distance from the reference (or the element measured against), side "reference" a reading per sample on the reference; format ply (the default, binary), npy (N × 4 float32 x, y, z, d) or csv. Returns the file with readings, measured, withinTolerance, withinTolerancePct, tolerance and searchDistance. Trap: the distance is NaN where there is no reading, and a reading past the search distance is kept as it is — |d| ≤ searchDistance says it counts. Changes nothing.',
  input: obj({
    side: enumOf(['scan', 'reference'], 'The readings: per scan vertex (the default), or per sample on the reference.'),
    format: enumOf(['ply', 'npy', 'csv'], 'ply (the default), npy or csv.'),
  }),
  readOnly: true,
  returnsFile: true,
  run: async ({ side = 'scan', format = 'ply' }) => {
    requireScan()
    await mapSettled(sceneOf())
    const d = useDeviation.getState()
    const { session } = commandHost()
    let positions: Float32Array
    let values: Float32Array
    let what: string
    if (side === 'reference') {
      if (d.source !== 'reference' || !d.align || d.mapStatus !== 'ready') throw new CommandError('invalid_state', 'There is no map against the reference part — deviation.align measures one.')
      if (d.referenceStatus !== 'ready') await session.deviation.runReferenceMap()
      const map = session.maps.referenceMap.current
      if (useDeviation.getState().referenceStatus !== 'ready' || !map) throw new CommandError('invalid_state', 'The map on the reference could not be measured.')
      positions = map.positions
      values = map.values
      what = `the reference${d.nominalName ? ` ${d.nominalName}` : ''} by its distance to the scan, a reading per sample ${round3(map.spacing)} mm apart`
    } else {
      const maps = session.maps
      const map = d.source === 'element' ? maps.elementField.current : maps.deviation.current
      const ready = d.source === 'element' ? d.elementStatus === 'ready' : d.mapStatus === 'ready'
      if (!ready || !map) throw new CommandError('invalid_state', 'There is no deviation map to export — deviation.align measures one against the reference part, deviation.set_target one against an element.')
      const client = session.clientRef.current
      if (!client) throw new CommandError('unavailable', 'The mesh worker is not running.')
      const n = useStore.getState().vertexCount
      const all = await client.query({ min: [-Infinity, -Infinity, -Infinity], max: [Infinity, Infinity, Infinity], limit: n })
      if (all.positions.length !== map.length * 3) throw new CommandError('internal', `The map has ${map.length} readings and the scan ${all.positions.length / 3} vertices.`)
      positions = all.positions
      values = map
      what = d.source === 'element' ? 'the scan by its distance to an element, a reading per vertex' : 'the scan by its distance to the reference, a reading per vertex'
    }
    const search = d.maxDistance
    const tolerance = d.tolerance
    let measured = 0
    let within = 0
    for (const v of values) {
      if (!isMeasured(v, search)) continue
      measured++
      if (Math.abs(v) <= tolerance) within++
    }
    const bytes = deviationFileBytes({ positions, values, searchDistance: search, what }, format)
    const mimeType = format === 'csv' ? 'text/csv' : 'application/octet-stream'
    return {
      side,
      format,
      readings: values.length,
      measured,
      withinTolerance: within,
      withinTolerancePct: measured ? Math.round((within / measured) * 1000) / 10 : 0,
      tolerance,
      searchDistance: search,
      file: { name: `${exportStem()}-deviation-${side}.${format}`, mimeType, bytes },
    }
  },
}

export const deviationCommands = [openReference, align, measure, setTarget, settings, hotspotsCommand, exportCommand]

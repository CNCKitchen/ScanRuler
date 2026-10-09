// SPDX-License-Identifier: AGPL-3.0-only
// Surface deviation: the scan against a reference part — opened, best-fitted
// onto it, mapped — or against one of its own fitted elements.

import type { MeshUnits } from '../../core/meshUnits'
import { isDeviationTarget } from '../../core/deviation/elementField'
import { useDeviation } from '../../state/deviationStore'
import { useMark } from '../../state/markStore'
import { useStore } from '../../state/store'
import { commandHost, requireScene } from '../host'
import { elementRefSchema, measuredElement, requireScan, type ElementRef } from '../refs'
import { arr, bytes, enumOf, int, num, obj, oneOf, vec3, type JsonSchema } from '../schema'
import { describeDeviation } from '../state'
import { CommandError, type Command } from '../types'
import { fileNameSchema, fileOf, lastError, showWorkspace, waitFor } from './common'
import { unitsSchema } from './scan'

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
    'Open the nominal part the scan is compared with — STEP straight from CAD, or STL, PLY or OBJ — in place of the one there is; any alignment and map against the old one go. The elements measured on the scan stay. Returns the deviation state. Not undoable: a new reference starts a new history.',
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

type Pair = { scan: [number, number, number]; reference: [number, number, number] }

const align: Command<{ mode?: 'auto' | 'points' | 'local'; pairs?: Pair[]; vertices?: number[]; searchDistance?: number }> = {
  name: 'align',
  title: 'Best-fit the scan onto the reference',
  description:
    'Rigid best fit (no scale) of the scan onto the reference part, then the deviation map under it. mode auto (the default) finds the pose on its own; points starts from three or more pairs of corresponding points — a point on the scan and the same point on the reference, mm — then refines; local refines the fit in hand on a marked surface only (vertices, scan vertex numbers), within searchDistance mm. Returns the alignment (RMS, points matched, transform) and the map’s statistics. One undo step.',
  input: obj({
    mode: enumOf(['auto', 'points', 'local'], 'auto (default), points or local.'),
    pairs: arr(
      obj({ scan: vec3('On the scan, mm.'), reference: vec3('The same point on the reference, mm.') }, ['scan', 'reference']),
      'points: the corresponding pairs.',
      { minItems: 3 },
    ),
    vertices: arr(int(undefined, { minimum: 0 }), 'local: the marked surface, scan vertex numbers.', { minItems: 3 }),
    searchDistance: num('local: how far a point may be from the reference to count, mm.', { exclusiveMinimum: 0 }),
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
    'Map how far the scan strays from one of its own fitted elements — a plane, cylinder, cone, sphere or torus — instead of from a reference part, as choosing the element in the panel does; null goes back to the reference. side is the material side, read off the scan when the element is chosen (outward: the element’s outer side; inward: a bore or shell) — give it to override. facingDeg limits which surface counts to what faces the element within that many degrees, null for any. Needs the viewport. Returns the map’s statistics. One undo step.',
  input: obj(
    {
      element: oneOf([elementRefSchema('The element.'), { type: 'null', description: 'Back to the reference part.' }], 'The element, or null.'),
      side: enumOf(['outward', 'inward'], 'The material side.'),
      facingDeg: nullable(num(undefined, { minimum: 1, maximum: 90 }), 'The facing limit, degrees.'),
    },
    ['element'],
  ),
  label: () => 'measure against element',
  run: async ({ element, side, facingDeg }) => {
    requireScan()
    requireScene('A map against an element')
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
    // The map follows the choice on its own (useElementField).
    await waitFor(() => useDeviation.getState().elementStatus === 'ready', 'the map against the element', 30_000)
    return { deviation: describeDeviation() }
  },
}

const settings: Command<{ range?: number; maxDistance?: number; bands?: number | null; tolerance?: number; facingDeg?: number | null }> = {
  name: 'settings',
  title: 'Set how the deviation is read',
  description:
    'The deviation map’s reading: range, the colour scale ± mm; maxDistance, how far from the reference a point may be to count, mm; bands, a stepped scale of that many colours or null for smooth; tolerance, ± mm, the share within which the statistics give; facingDeg, how far the reference surface a point is measured against may turn from facing it, degrees, or null for the nearest surface whatever it faces — a change of it measures the map again. Returns the deviation state. One undo step.',
  input: obj({
    range: num('Colour scale, ± mm.', { exclusiveMinimum: 0 }),
    maxDistance: num('Search distance, mm.', { exclusiveMinimum: 0 }),
    bands: nullable(int(undefined, { minimum: 2 }), 'Stepped colours, or null for smooth.'),
    tolerance: num('Tolerance, ± mm.', { exclusiveMinimum: 0 }),
    facingDeg: nullable(num(undefined, { minimum: 1, maximum: 90 }), 'Facing limit, degrees, or null.'),
  }),
  label: () => 'deviation settings',
  run: async ({ range, maxDistance, bands, tolerance, facingDeg }) => {
    const { session } = commandHost()
    const d = useDeviation.getState()
    if (range !== undefined) d.setRange(range)
    if (maxDistance !== undefined) d.setMaxDistance(maxDistance)
    if (bands !== undefined) d.setBands(bands)
    if (tolerance !== undefined) d.setTolerance(tolerance)
    if (facingDeg !== undefined) {
      session.deviation.setMapFacing(facingDeg)
      await waitFor(() => useDeviation.getState().mapStatus !== 'running', 'the map to be measured again')
    }
    return { deviation: describeDeviation() }
  },
}

export const deviationCommands = [openReference, align, measure, setTarget, settings]

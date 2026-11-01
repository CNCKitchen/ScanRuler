// SPDX-License-Identifier: AGPL-3.0-only
// The workspace through its commands alone, as an agent drives it: a cube
// scanned with a speck beside it cleaned up — the speck off, the top face
// deleted and the hole filled again, cut, expanded and hollowed, a step of
// the history each — every step walked back, and the copy taken into use;
// then a body trimmed to a block's top, a peg taken out of it and the block
// reduced. The mesh worker runs in this thread under the app's own headless
// session (tests/commandKit.ts).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManifoldToplevel } from 'manifold-3d'
import { listCommands } from '../../../src/commands/registry'
import { SCHEMA_BUDGET, schemaWeight } from '../../../src/commands/schema'
import { buildMeshGraph } from '../../../src/core/geometry/buildGraph'
import { offerSolids } from '../../../src/app/solids'
import { useHistory } from '../../../src/state/historyStore'
import { useShell } from '../../../src/state/shellStore'
import { boxMesh } from '../../../tests/helpers'
import { refused, run, startHeadless, stlBytes, undoLabels, type Headless } from '../../../tests/commandKit'
import { createMeshToolsSession, installMeshToolsSession } from '../app/meshToolsSession'
import { useMeshTools } from '../state/meshStore'
import plugin from '../plugin'

// Kernel builds and real-scan fits run long, and longer on a slow machine.
vi.setConfig({ testTimeout: 180_000 })

// The worker loads Manifold's WebAssembly from the address the page serves
// it at; under Node, Manifold finds it beside itself.
vi.mock('../core/manifold', async () => {
  const { default: Module } = await import('manifold-3d')
  let loading: Promise<ManifoldToplevel> | null = null
  return {
    loadManifold: () =>
      (loading ??= Module().then((wasm) => {
        wasm.setup()
        return wasm
      })),
  }
})

type Vec3 = [number, number, number]
interface Figures { working: string; vertices: number; triangles: number; bounds: { min: Vec3; max: Vec3 }; open: number; bad: number; volume: number | null; edits: string[] }
interface EditAnswer { edit: { kind: string; text: string }; status: string; report: Record<string, number>; mesh: Figures }

/** A box from `min` to `max` as a triangle soup, `grid` triangles' pairs a
 *  side. */
function cuboid(min: Vec3, max: Vec3, grid = 8): Float32Array {
  const unit = boxMesh(2, grid)
  const out = new Float32Array(unit.length)
  for (let i = 0; i < unit.length; i++) {
    const k = i % 3
    out[i] = min[k] + ((unit[i] + 1) / 2) * (max[k] - min[k])
  }
  return out
}

const joined = (...soups: Float32Array[]): Float32Array => {
  const out = new Float32Array(soups.reduce((n, s) => n + s.length, 0))
  let at = 0
  for (const s of soups) {
    out.set(s, at)
    at += s.length
  }
  return out
}

/** A solid offered as another workspace offers its bodies. */
function offer(...solids: { key: string; name: string; soup: Float32Array }[]) {
  offerSolids(
    'test',
    solids.map((s) => ({
      key: s.key,
      name: s.name,
      source: 'Test',
      version: 1,
      mesh: async () => {
        const g = buildMeshGraph({ kind: 'soup', positions: s.soup })
        return { positions: g.positions, indices: g.indices }
      },
    })),
  )
}

let headless: Headless
const stops: (() => void)[] = []

beforeAll(async () => {
  plugin.install?.()
  headless = await startHeadless()
  const s = headless.session
  const session = createMeshToolsSession({
    clientRef: s.clientRef,
    sceneRef: { current: null },
    sources: s.sources,
    imports: s.imports,
    swapScan: s.swap.swapScan,
    remapScan: s.swap.remapScan,
    remeasureScan: s.swap.remeasureScan,
  })
  stops.push(installMeshToolsSession(session), session.watch())
}, 120_000)
afterAll(() => {
  for (const stop of stops) stop()
  offerSolids('test', [])
  headless.stop()
})
beforeEach(() => {
  offerSolids('test', [])
  useMeshTools.setState({ editing: false })
})

const open = (name: string, soup: Float32Array) => run('scan.open', { bytes: stlBytes(soup), name, discard: true })

describe('cleaning a scan up through the commands', () => {
  it('refuses with no scan, and lists every command within the schema budget', async () => {
    expect((await refused('mesh.cut', { plane: 'XY', offset: 0, keep: 'plus' })).code).toBe('no_scan')
    expect((await refused('mesh.inspect')).code).toBe('no_scan')
    const mesh = listCommands().filter((c) => c.name.startsWith('mesh.'))
    expect(mesh.map((c) => c.name)).toEqual(
      expect.arrayContaining(['mesh.parts', 'mesh.inspect', 'mesh.remove_islands', 'mesh.delete_marked', 'mesh.flip_normals', 'mesh.cut', 'mesh.fill_holes', 'mesh.smooth', 'mesh.offset', 'mesh.boolean', 'mesh.shell', 'mesh.reduce', 'mesh.trim', 'mesh.use_edited', 'mesh.discard_edited', 'mesh.export']),
    )
    for (const c of mesh) {
      const w = schemaWeight(c.input)
      expect(w.bytes, c.name).toBeLessThanOrEqual(SCHEMA_BUDGET.bytes)
      expect(w.depth, c.name).toBeLessThanOrEqual(SCHEMA_BUDGET.depth)
    }
  })

  it('takes a speck off, deletes the top face, fills it, cuts, expands and hollows — a step each, all undone', async () => {
    await open('cube.stl', joined(cuboid([-10, -10, -10], [10, 10, 10], 10), cuboid([30, 0, 0], [30.5, 0.5, 0.5], 1)))
    useHistory.setState({ past: [], future: [] })
    const cubeTriangles = 6 * 10 * 10 * 2

    const seen = await run<{ working: string; open: number; volume: number; islands: { pieces: number; islands: number; centres: Vec3[] } }>('mesh.inspect', { pieceSize: 2 })
    expect(seen.working).toBe('scan')
    expect(seen.open).toBe(0)
    expect(seen.islands).toMatchObject({ pieces: 2, islands: 1 })
    expect(seen.islands.centres[0][0]).toBeCloseTo(30.25, 2)

    const islands = await run<EditAnswer>('mesh.remove_islands', { size: 2 })
    expect(islands.edit.kind).toBe('pieces')
    expect(islands.mesh).toMatchObject({ working: 'edited copy', triangles: cubeTriangles, open: 0 })
    expect(islands.mesh.volume).toBeCloseTo(8000, 0)

    // The top face by a box and the direction it faces: the rim's corners
    // face along the sides too, so the triangles touching it stay.
    const top = await run<EditAnswer>('mesh.delete_marked', { region: { box: { min: [-11, -11, 9.5], max: [11, 11, 11] }, facing: [0, 0, 1] } })
    expect(top.edit.kind).toBe('delete')
    expect(top.report.triangles).toBeGreaterThan(100)
    expect(top.mesh.open).toBeGreaterThan(0)
    expect(top.mesh.volume).toBeNull()

    const holes = await run<{ holes: { holes: number; centres: Vec3[] } }>('mesh.inspect', { holeSize: 25 })
    expect(holes.holes.holes).toBe(1)
    expect(holes.holes.centres[0][2]).toBeCloseTo(10, 1)
    const filled = await run<EditAnswer>('mesh.fill_holes', { size: 25, patch: 'flat', at: [0, 0, 10] })
    expect(filled.mesh.open).toBe(0)
    expect(filled.mesh.volume).toBeCloseTo(8000, -1)

    const preview = await run<{ cuts: boolean; capped: number; open: number }>('mesh.cut_preview', { plane: 'XY', offset: 5, keep: 'minus' })
    expect(preview).toMatchObject({ cuts: true, capped: 1, open: 0 })
    const cut = await run<EditAnswer>('mesh.cut', { plane: 'XY', offset: 5, keep: 'minus' })
    expect(cut.mesh.bounds.max[2]).toBeCloseTo(5, 3)
    expect(cut.mesh.open).toBe(0)
    expect(cut.mesh.volume).toBeCloseTo(20 * 20 * 15, -1)

    const grown = await run<EditAnswer>('mesh.offset', { direction: 'expand', distance: 0.5 })
    expect(grown.mesh.bounds.min[0]).toBeCloseTo(-10.5, 2)
    expect(grown.mesh.bounds.max[2]).toBeCloseTo(5.5, 2)

    const hollow = await run<EditAnswer>('mesh.shell', { thickness: 2 })
    expect(hollow.edit.kind).toBe('shell')
    expect(hollow.report.cavities).toBe(1)
    // The cavity is the part 2 mm in all round: 17 × 17 × 12.
    expect(hollow.mesh.volume!).toBeCloseTo(21 * 21 * 16 - 17 * 17 * 12, -2)

    expect(undoLabels()).toEqual([
      'Agent: remove islands',
      'Agent: delete surface',
      'Agent: fill a hole',
      'Agent: cut at XY plane, Z 5 mm',
      'Agent: expand by 0.5 mm',
      'Agent: hollow',
    ])
    expect(useMeshTools.getState().pending.map((e) => e.kind)).toEqual(['pieces', 'delete', 'fill', 'cut', 'offset', 'shell'])

    // Back through every step to the scan as it was opened.
    const back: number[] = []
    for (let i = 0; i < 6; i++) {
      await run('history.undo')
      back.push(useMeshTools.getState().copyTriangles ?? -1)
    }
    expect(back.slice(0, 5)).toEqual([grown.mesh.triangles, cut.mesh.triangles, filled.mesh.triangles, top.mesh.triangles, islands.mesh.triangles])
    expect(back[5]).toBe(-1)
    expect((await run<Figures & { working: string }>('mesh.inspect')).working).toBe('scan')

    // Forward again to the expanded part, taken into use.
    for (let i = 0; i < 5; i++) await run('history.redo')
    expect(useMeshTools.getState().copyTriangles).toBe(grown.mesh.triangles)
    const file = await run<{ file: { name: string; bytes: Uint8Array } }>('mesh.export', { part: 'edited' })
    expect(file.file.name).toBe('cube-edited.stl')
    expect(file.file.bytes.length).toBe(84 + 50 * grown.mesh.triangles)
    const used = await run<{ scan: { triangles: number; edits: { kind: string }[] } }>('mesh.use_edited')
    expect(used.scan.triangles).toBe(grown.mesh.triangles)
    expect(used.scan.edits.map((e) => e.kind)).toEqual(['pieces', 'delete', 'fill', 'cut', 'offset'])
    expect(useMeshTools.getState().copyTriangles).toBeNull()
    expect(undoLabels().at(-1)).toBe('Agent: use the edited mesh for analysis')
  }, 120_000)

  it('flips a part inside-out and back, the whole of it and a face, a step each', async () => {
    await open('cube.stl', cuboid([-10, -10, -10], [10, 10, 10], 4))
    useHistory.setState({ past: [], future: [] })
    const triangles = 6 * 4 * 4 * 2

    const all = await run<EditAnswer>('mesh.flip_normals', {})
    expect(all.edit).toMatchObject({ kind: 'flip', text: 'Flipped the normals' })
    expect(all.report.triangles).toBe(triangles)
    expect(all.mesh).toMatchObject({ working: 'edited copy', triangles, open: 0, bad: 0 })
    expect(all.mesh.volume).toBeCloseTo(-8000, 0)
    expect(useMeshTools.getState().tool).toBe('flip')

    // The top face by the way it faces now — down, the part inside-out —
    // turned back alone.
    const top = await run<EditAnswer>('mesh.flip_normals', { region: { box: { min: [-11, -11, 9.5], max: [11, 11, 11] }, facing: [0, 0, -1] } })
    expect(top.edit).toMatchObject({ kind: 'flip', text: 'Flipped the normals of a marked region' })
    expect(top.report.triangles).toBeGreaterThan(0)
    expect(top.report.triangles).toBeLessThan(4 * 4 * 2)
    expect(top.mesh.triangles).toBe(triangles)

    expect(undoLabels()).toEqual(['Agent: flip the normals', 'Agent: flip the normals of a region'])
    await run('history.undo')
    expect((await run<Figures>('mesh.inspect')).volume).toBeCloseTo(-8000, 0)
    await run('history.undo')
    const back = await run<Figures>('mesh.inspect')
    expect(back.working).toBe('scan')
    expect(back.volume).toBeCloseTo(8000, 0)
  })

  it('refuses what the panel would not do, and leaves the settings as they were when an edit fails', async () => {
    await open('box.stl', cuboid([-10, -10, -10], [10, 10, 10], 6))
    useHistory.setState({ past: [], future: [] })
    const holeSize = useMeshTools.getState().holeSize

    // A closed box has no hole: the fill fails, its size goes back, and no
    // step is left.
    const none = await refused('mesh.fill_holes', { size: 3 })
    expect(none.code).toBe('failed')
    expect(none.message).toMatch(/No hole/)
    expect(useMeshTools.getState().holeSize).toBe(holeSize)
    expect(undoLabels()).toEqual([])

    expect((await refused('mesh.delete_marked', { region: { box: { min: [50, 50, 50], max: [60, 60, 60] } } })).code).toBe('invalid_input')
    expect((await refused('mesh.delete_marked', { region: { box: { min: [0, 0, 0], max: [1, 1, 1] }, sphere: { center: [0, 0, 0], radius: 1 } } })).code).toBe('invalid_input')
    expect((await refused('mesh.delete_marked', { region: 'marked' })).code).toBe('unavailable')
    // A vertex number past 32 bits is refused, not wrapped onto vertex 1.
    expect((await refused('mesh.delete_marked', { region: { vertices: [2 ** 32 + 1] } })).code).toBe('invalid_input')
    expect(undoLabels()).toEqual([])
    expect((await refused('mesh.mark', { region: { sphere: { center: [0, 0, 10], radius: 3 } } })).code).toBe('unavailable')
    expect((await refused('mesh.boolean', { op: 'subtract', solids: ['Peg'] })).code).toBe('not_found')
    expect((await refused('mesh.cut', { plane: 'Plane 9', offset: 0, keep: 'plus' })).code).toBe('not_found')
    expect((await refused('mesh.use_edited')).code).toBe('invalid_state')
    expect((await refused('mesh.export', { part: 'reduced' })).code).toBe('unavailable')
    expect((await refused('mesh.shell', { mode: 'thicken' })).code).toBe('invalid_state')

    // Open, a boolean is refused; closed but for a small hole, a hollow asks
    // for it to be filled first.
    await run('mesh.delete_marked', { region: { sphere: { center: [0, 0, 10], radius: 5 }, facing: [0, 0, 1] } })
    useMeshTools.getState().setHoleSize(10)
    offer({ key: 'test:peg', name: 'Peg', soup: cuboid([-3, -3, -12], [3, 3, 12], 4) })
    const openMesh = await refused('mesh.boolean', { op: 'subtract', solids: ['Peg'] })
    expect(openMesh.code).toBe('invalid_state')
    expect(openMesh.message).toMatch(/fill_holes/)
    const holes = await refused('mesh.shell', { thickness: 1 })
    expect(holes.code).toBe('invalid_state')
    expect(holes.message).toMatch(/fill_holes/)

    // Busy while an edit is in flight.
    useMeshTools.setState({ editing: true })
    expect((await refused('mesh.fill_holes')).code).toBe('busy')
    useMeshTools.setState({ editing: false })

    // The discard is a step, and its undo brings the copy back.
    const copy = useMeshTools.getState().copyTriangles
    const gone = await run<{ mesh: Figures }>('mesh.discard_edited')
    expect(gone.mesh.working).toBe('scan')
    await run('history.undo')
    expect(useMeshTools.getState().copyTriangles).toBe(copy)
  }, 60_000)
})

describe('what the viewport shows', () => {
  it('shows and hides the parts without a step of the history, and colours only a copy there is', async () => {
    await open('cube.stl', cuboid([-10, -10, -10], [10, 10, 10], 4))
    useHistory.setState({ past: [], future: [] })
    expect((await refused('mesh.show', { deviation: true })).code).toBe('invalid_state')
    expect((await refused('mesh.show', { bodies: ['Nothing'] })).code).toBe('not_found')
    type Shown = { shown: { scan: boolean; reduced: boolean; piece: boolean; bodies: string[] }; deviation: boolean; workspace: string; back?: string; note?: string }
    // From another workspace it says it put Mesh Tools on screen, and how
    // to go back; from its own, nothing of the kind.
    useShell.getState().setWorkspace('measure')
    const hidden = await run<Shown>('mesh.show', { scan: false })
    expect(hidden.workspace).toBe('mesh')
    expect(hidden.back).toBe('measure')
    expect(hidden.note).toMatch(/Mesh Tools is on screen in place of measure.*workspace\.set \{ workspace: "measure" \}/)
    expect(useShell.getState().workspace).toBe('mesh')
    expect(hidden.shown.scan).toBe(false)
    expect(useMeshTools.getState().shownScan).toBe(false)
    const back = await run<Shown>('mesh.show', { scan: true, bodies: [] })
    expect(back.shown).toMatchObject({ scan: true, bodies: [] })
    expect(back.back).toBeUndefined()
    expect(back.deviation).toBe(false)
    expect(useHistory.getState().past).toHaveLength(0)
  })
})

describe('beside the scan, and with solids', () => {
  it('trims a body to a block’s top, takes a peg out of it and reduces it', async () => {
    // Half a millimetre across, as a scan is: the break runs to within that
    // of the block's edges, where the cap overhangs it.
    await open('block.stl', cuboid([-10, -10, -10], [10, 10, 10], 40))
    useHistory.setState({ past: [], future: [] })
    offer(
      { key: 'test:cap', name: 'Cap', soup: cuboid([-10.2, -10.2, 8], [10.2, 10.2, 18], 6) },
      { key: 'test:peg', name: 'Peg', soup: cuboid([-3, -3, -12], [3, 3, 12], 4) },
    )
    const parts = await run<{ solids: { key: string; name: string }[]; piece: unknown }>('mesh.parts')
    expect(parts.solids.map((s) => s.name)).toEqual(['Cap', 'Peg'])
    expect(parts.piece).toBeNull()

    // The break is the block's top, 2 mm into the cap; the piece is the cap
    // above it.
    const trimmed = await run<{ piece: { body: string; volume: number; matingArea: number; gap: { median: number } } }>('mesh.trim', { body: 'Cap' })
    expect(trimmed.piece.body).toBe('Cap')
    expect(trimmed.piece.volume).toBeCloseTo(20.4 * 20.4 * 8, -1)
    expect(trimmed.piece.matingArea).toBeGreaterThan(390)
    expect(Math.abs(trimmed.piece.gap.median)).toBeLessThan(0.05)
    expect((await refused('mesh.export', { part: 'piece' })).code).toBe('unavailable')

    const peg = await run<EditAnswer>('mesh.boolean', { op: 'subtract', solids: ['test:peg'] })
    expect(peg.edit.kind).toBe('boolean')
    expect(peg.mesh.volume).toBeCloseTo(8000 - 6 * 6 * 20, -1)
    expect(peg.mesh.open).toBe(0)
    // The boolean puts its tool away, as the panel's does.
    expect(useMeshTools.getState().tool).toBeNull()
    // The piece was cut to the block before it.
    expect((await run<{ piece: unknown }>('mesh.parts')).piece).toBeNull()

    const reduced = await run<{ reduced: { triangles: number; fromTriangles: number; tolerance: number; held: boolean } }>('mesh.reduce', { tolerance: 0.02, maxTriangles: 5000 })
    expect(reduced.reduced.fromTriangles).toBe(peg.mesh.triangles)
    expect(reduced.reduced.triangles).toBeLessThan(peg.mesh.triangles)
    expect(reduced.reduced).toMatchObject({ tolerance: 0.02, held: true })
    expect(undoLabels()).toEqual(['Agent: trim Cap to the break', 'Agent: subtract Peg', 'Agent: reduce the mesh'])
  }, 120_000)
})

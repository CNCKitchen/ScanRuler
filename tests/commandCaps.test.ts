// SPDX-License-Identifier: AGPL-3.0-only
// What the commands do on a point cloud. A cloud has no triangles, so a
// command that reaches a worker op needing them is refused up front in the
// registry (Command.scanOps, from OP_CAPS) with the one refusal text — never
// left half done, and never answering for an empty mesh. The sweep runs every
// core command on a sphere as a mesh and as a cloud: wherever the mesh
// answers, the cloud either answers with data too or is refused in words.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { runCommand } from '../src/commands/registry'
import { CommandError } from '../src/commands/types'
import { CLOUD_REFUSAL, OP_CAPS } from '../src/core/capabilities'
import { useStore } from '../src/state/store'
import { useDeviation } from '../src/state/deviationStore'
import { boxMesh, icosphere } from './helpers'
import { sphereCloud, writePlyCloud } from './cloudFixtures'
import { refused, run, soupOf, startHeadless, stlBytes, undoLabels, type Headless } from './commandKit'

type Vec3 = [number, number, number]

const MESH = stlBytes(soupOf(icosphere(3, 20)))
const CLOUD = new Uint8Array(writePlyCloud(sphereCloud({ radius: 20, step: 2.5 }), 'binary_little_endian'))
const REFERENCE = stlBytes(boxMesh(40, 20))

let headless: Headless
beforeAll(async () => {
  headless = await startHeadless()
})
afterAll(() => headless.stop())

const openMesh = () => run('scan.open', { bytes: MESH, name: 'ball.stl', discard: true })
const openCloud = () => run('scan.open', { bytes: CLOUD, name: 'ball.ply', discard: true })

/** A setup step, its refusal thrown with the command's own message. */
const step = async (name: string, input: unknown): Promise<void> => {
  const out = await attempt(name, input)
  if (!out.ok) throw new Error(out.message)
}
/** The reference and an alignment against it: what the deviation commands start from. */
const withReference = async () => {
  await step('deviation.open_reference', { bytes: REFERENCE, name: 'block.stl' })
  await step('deviation.align', { mode: 'auto' })
}
/** A section, for the commands that read one. */
const withSection = async () => {
  await step('section.cut', { across: 'XY' })
}

const P: Vec3 = [20, 0, 0]
/** Minimal valid input for each core command, and what it needs first. Those
 *  left out of INPUTS do not reach the scan (the flat workspace, the files,
 *  the history). */
const INPUTS: Record<string, { input?: Record<string, unknown>; setup?: () => Promise<unknown> }> = {
  'scan.nearest': { input: { at: { point: P } } },
  'scan.query': { input: { box: { min: [-30, -30, -30], max: [30, 30, 30] } } },
  'scan.fit_surface': { input: { box: { min: [-30, -30, -30], max: [30, 30, 30] } } },
  'scan.draft': { input: { pull: [0, 0, 1] } },
  'scan.heightmap': {},
  'scan.outline': {},
  'scan.pattern': { input: { axis: 'z' } },
  'scan.qa': {},
  'scan.scale': { input: { dryRun: true, factor: 1.1 } },
  'scan.segment': {},
  'element.fit': { input: { kind: 'sphere', at: { point: P } } },
  'element.fit_marked': { input: { kind: 'sphere', box: { min: [-30, -30, -30], max: [30, 30, 30] } } },
  'element.construct': { input: { kind: 'point', method: 'point-centroid' } },
  'align.auto': {},
  'align.datum': { input: { primary: { points: [[0, 0, 20], [4, 0, 19.6], [0, 4, 19.6]] } } },
  'align.symmetry': {},
  'align.clear': {},
  'section.cut': { input: { across: 'XY' } },
  'section.get': { input: { section: 'Section 1' }, setup: withSection },
  'section.render': { input: { plane: 'XY' } },
  'thickness.measure': {},
  'thickness.settings': {},
  'deviation.align': { input: { mode: 'auto' }, setup: () => step('deviation.open_reference', { bytes: REFERENCE, name: 'block.stl' }) },
  'deviation.measure': { setup: withReference },
  'deviation.settings': { input: { on: 'reference' }, setup: withReference },
  'deviation.hotspots': { input: { on: 'reference' }, setup: withReference },
  'deviation.export': { input: { side: 'reference' }, setup: withReference },
  'deviation.volume': { setup: withReference },
  'session.state': {},
  'report.get': {},
}

const emptyKeys = (mesh: unknown, cloud: unknown, path = ''): string[] => {
  // A cloud has no triangles: counting zero of them is the right answer.
  if (/(^|\.)(triangles|triangleCount)$/.test(path)) return []
  if (Array.isArray(mesh)) return mesh.length > 0 && Array.isArray(cloud) && cloud.length === 0 ? [path] : []
  if (mesh && typeof mesh === 'object' && cloud && typeof cloud === 'object') {
    return Object.keys(mesh).flatMap((k) => emptyKeys((mesh as Record<string, unknown>)[k], (cloud as Record<string, unknown>)[k], path ? `${path}.${k}` : k))
  }
  return typeof mesh === 'number' && mesh !== 0 && cloud === 0 ? [path] : []
}

type Outcome = { ok: true; result: unknown } | { ok: false; code: string; message: string }
const attempt = async (name: string, input: unknown): Promise<Outcome> => {
  try {
    return { ok: true, result: JSON.parse(JSON.stringify(await runCommand(name, input), (_k, v: unknown) => (v instanceof Uint8Array ? v.byteLength : v))) }
  } catch (e) {
    if (e instanceof CommandError) return { ok: false, code: e.code, message: e.message }
    throw e
  }
}

describe('commands on a point cloud', () => {
  it('every core command that reaches a needsTriangles op is flagged', async () => {
    const unexercised: string[] = []
    const refusedNames: string[] = []
    for (const [name, spec] of Object.entries(INPUTS)) {
      const input = spec.input ?? {}
      await openMesh()
      let onMesh: Outcome
      try {
        await spec.setup?.()
        onMesh = await attempt(name, input)
      } catch (e) {
        onMesh = { ok: false, code: 'setup', message: e instanceof Error ? e.message : String(e) }
      }
      await openCloud()
      expect(useStore.getState().scanIsCloud, name).toBe(true)
      let onCloud: Outcome
      try {
        await spec.setup?.()
        onCloud = await attempt(name, input)
      } catch (e) {
        // A setup that is itself refused on a cloud is the refusal.
        onCloud = { ok: false, code: 'setup', message: e instanceof Error ? e.message : String(e) }
      }
      if (!onMesh.ok) {
        unexercised.push(`${name} (${onMesh.code}: ${onMesh.message.slice(0, 60)})`)
        continue
      }
      if (!onCloud.ok) {
        expect(onCloud.message, `${name} on a cloud`).toBe(CLOUD_REFUSAL)
        refusedNames.push(name)
        continue
      }
      expect(emptyKeys(onMesh.result, onCloud.result), `${name} answers empty on a cloud where a mesh gives data`).toEqual([])
    }
    // The flagged set, in the open: a change here is a decision.
    expect(refusedNames.sort()).toEqual(
      [
        'align.symmetry', 'deviation.export', 'deviation.hotspots', 'deviation.settings', 'deviation.volume',
        'element.construct', 'scan.heightmap', 'scan.outline', 'scan.qa',
        'thickness.measure',
      ].sort(),
    )
    // Those the mesh itself does not answer here, so there is nothing to compare: no state to clear, no browser.
    expect(unexercised.map((u) => u.split(' ')[0]).sort()).toEqual(['align.clear', 'section.render'])
  }, 120_000)

  it('flagged commands still run on a mesh', async () => {
    await openMesh()
    for (const name of ['scan.nearest', 'scan.heightmap', 'scan.qa', 'section.cut', 'section.get', 'thickness.measure', 'align.symmetry', 'scan.segment', 'align.auto']) {
      const out = await attempt(name, INPUTS[name].input ?? {})
      expect(out, name).toMatchObject({ ok: true })
    }
    expect(useStore.getState().scanIsCloud).toBe(false)
    expect((await run<{ vertex: number }>('scan.nearest', { at: { point: P } })).vertex).toBeGreaterThanOrEqual(0)
  })

  it('a refused command is refused before it runs: no step, no side effect', async () => {
    await openCloud()
    const client = headless.session.clientRef.current!
    const section = vi.spyOn(client, 'section')
    const before = undoLabels()
    const e = await refused('section.cut', { across: 'XY', kind: 'shadow' })
    expect(e.message).toBe(CLOUD_REFUSAL)
    expect(section).not.toHaveBeenCalled()
    expect(undoLabels()).toEqual(before)
    expect(useStore.getState().sections).toEqual([])
    const r = await refused('scan.heightmap', {})
    expect(r.message).toBe(CLOUD_REFUSAL)
    section.mockRestore()
  })

  it('a command is refused only for the inputs that reach a triangle-only op', async () => {
    await openCloud()
    // Reads of points are fine; a sphere fit by marked vertices needs no triangle.
    expect((await attempt('scan.query', { box: { min: [-30, -30, -30], max: [30, 30, 30] } })).ok).toBe(true)
    expect(await attempt('scan.draft', { pull: [0, 0, 1], split: 'symmetry' })).toMatchObject({ ok: false, message: CLOUD_REFUSAL })
    expect(await attempt('element.construct', { kind: 'point', method: 'point-coords', params: [1, 2, 3] })).toMatchObject({ ok: true })
    expect(await attempt('element.construct', { kind: 'point', method: 'point-centroid' })).toMatchObject({ ok: false, message: CLOUD_REFUSAL })
  })

  it('deviation.settings is refused on a cloud while the map stands on the reference, unless it moves it back', async () => {
    await openCloud()
    const was = useDeviation.getState().mapOn
    useDeviation.setState({ mapOn: 'reference' })
    try {
      expect(await attempt('deviation.settings', { tolerance: 0.2 })).toMatchObject({ ok: false, message: CLOUD_REFUSAL })
      expect(await attempt('deviation.settings', { on: 'reference' })).toMatchObject({ ok: false, message: CLOUD_REFUSAL })
      expect(await attempt('deviation.settings', { on: 'scan' })).toMatchObject({ ok: true })
    } finally {
      useDeviation.setState({ mapOn: was })
    }
  })

  it('the flag follows OP_CAPS: an op that takes clouds runs its commands, one marked triangle-only refuses them', async () => {
    await openCloud()
    const out = await attempt('scan.nearest', { at: { point: P } })
    expect(out).toMatchObject({ ok: true })
    const was = OP_CAPS.nearest.needsTriangles
    ;(OP_CAPS.nearest as { needsTriangles: boolean }).needsTriangles = true
    try {
      expect(await attempt('scan.nearest', { at: { point: P } })).toMatchObject({ ok: false, message: CLOUD_REFUSAL })
    } finally {
      ;(OP_CAPS.nearest as { needsTriangles: boolean }).needsTriangles = was
    }
  })
})

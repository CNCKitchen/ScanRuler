// SPDX-License-Identifier: AGPL-3.0-only
// A point-cloud scan in a project and out of it: the project keeps the file
// the cloud was opened from, so it reads back through the same parser with
// the same points and normals, the fitted elements stay as saved, and a
// project saved in a workspace a cloud cannot use opens in 3D Measure.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { packProject, readMembers, unpackProject } from '../src/core/project/archive'
import { collectProject, prepareProjectState } from '../src/app/project'
import { buildScanMesh, buildScanPointCloud } from '../src/app/exports'
import { buildPointCloudPly } from '../src/core/exportPointCloud'
import { parsePLY } from '../src/core/parsers/ply'
import { parseXYZ } from '../src/core/parsers/xyz'
import { CLOUD_REFUSAL } from '../src/core/capabilities'
import { installPlugins } from '../src/plugins/registry'
import { runCommand } from '../src/commands/registry'
import { registerCoreCommands } from '../src/commands/core'
import { useStore, type Element } from '../src/state/store'
import type { PlaneFit } from '../src/core/types'
import { useShell } from '../src/state/shellStore'
import { cylinderCloud, planeCloud, writeXyz } from './cloudFixtures'
import { fileScale, meshUnitsOf } from '../src/core/meshUnits'
import { fresh } from './projectKit'
import type { SceneManager } from '../src/viewer/SceneManager'

beforeAll(() => {
  installPlugins()
  registerCoreCommands()
})

const cloud = planeCloud({ size: 10, step: 1 })
const plyBytes = () => new Uint8Array(buildPointCloudPly(cloud.positions, cloud.normals, null, 'cloud test'))
const blobOf = (bytes: Uint8Array) => new Blob([bytes as BlobPart])
const bufferOf = (bytes: Uint8Array) => bytes.slice().buffer as ArrayBuffer

const plane = (id: number, z: number): Element => ({
  id,
  kind: 'plane',
  name: `Plane ${id}`,
  color: '#f00',
  source: { type: 'fitted', seeds: [id], selection: Uint32Array.from([1, 2, 3]), settings: { method: 'gaussian', sigma: 1 } },
  status: 'done',
  visible: true,
  fit: {
    kind: 'plane',
    center: [0, 0, z],
    normal: [0, 0, 1],
    basisU: [1, 0, 0],
    basisV: [0, 1, 0],
    extentU: 5,
    extentV: 5,
    sigma: 0.01,
    usedPoints: 100,
    regionSize: 100,
  } as unknown as PlaneFit,
})

/** The session as a loaded cloud leaves it. */
function cloudSession(name = 'part.ply') {
  fresh()
  useStore.getState().beginLoad(name)
  useStore.getState().finishLoad(cloud.positions.length / 3, 0, 10, [0, 0, 0])
  useStore.setState({ scanIsCloud: true, elements: [plane(1, 0), plane(2, 3)], nextId: 3 })
}

/** Pack, unpack, and hand back what the app reads a project back from. */
async function roundTrip(name: string, bytes: Uint8Array) {
  const { manifest, members } = collectProject({ scan: { name, file: blobOf(bytes) }, reference: null, image: null }, null, '0.1.0')
  const back = unpackProject(packProject(manifest, await readMembers(members)))
  return { manifest, back }
}

describe('a cloud scan in a project', () => {
  beforeEach(() => useShell.getState().setWorkspace('elements'))

  it('keeps the file it was opened from and reads back with identical points and normals', async () => {
    cloudSession()
    const bytes = plyBytes()
    const { manifest, back } = await roundTrip('part.ply', bytes)
    expect(manifest.scan?.member).toBe('scan.ply')
    expect(back.members.get('scan.ply')).toEqual(bytes)
    const a = parsePLY(bufferOf(bytes))
    const b = parsePLY(bufferOf(back.members.get('scan.ply')!))
    expect(b.kind).toBe('cloud')
    expect(Array.from(b.positions)).toEqual(Array.from(a.positions))
    expect(Array.from(b.normals!)).toEqual(Array.from(a.normals!))
    expect(Array.from(b.positions)).toEqual(Array.from(cloud.positions))
  })

  it('remembers a cloud thinned as it was read, and refuses a count that is not one', async () => {
    cloudSession()
    const bytes = plyBytes()
    const { manifest } = collectProject({ scan: { name: 'part.ply', file: blobOf(bytes), maxPoints: 50 }, reference: null, image: null }, null, '0.1.0')
    expect(manifest.scan?.maxPoints).toBe(50)
    const members = await readMembers(collectProject({ scan: { name: 'part.ply', file: blobOf(bytes), maxPoints: 50 }, reference: null, image: null }, null, '0.1.0').members)
    const back = unpackProject(packProject(manifest, members))
    expect(back.manifest.scan?.maxPoints).toBe(50)
    // Read again as it was: the same 50 points.
    expect(parsePLY(bufferOf(back.members.get('scan.ply')!), undefined, { maxPoints: back.manifest.scan!.maxPoints }).positions.length).toBe(150)
    const bad = { ...manifest, scan: { ...manifest.scan!, maxPoints: -3 } }
    expect(() => unpackProject(packProject(bad, members))).toThrow(/scan\.maxPoints/)
  })

  it('does the same for an XYZ cloud', async () => {
    cloudSession('part.xyz')
    const xyz = new Uint8Array(writeXyz(cylinderCloud({ radius: 5, length: 10, step: 1 }), { delim: ' ', columns: 'xyzn' }))
    const { manifest, back } = await roundTrip('part.xyz', xyz)
    expect(manifest.scan?.member).toBe('scan.xyz')
    const a = parseXYZ(bufferOf(xyz))
    const b = parseXYZ(bufferOf(back.members.get('scan.xyz')!))
    expect(b.kind).toBe('cloud')
    expect(Array.from(b.positions)).toEqual(Array.from(a.positions))
    expect(Array.from(b.normals!)).toEqual(Array.from(a.normals!))
  })

  it('keeps an XYZ cloud read in inches in inches, so it reads back at the same size', async () => {
    cloudSession('part.xyz')
    const xyz = new Uint8Array(writeXyz(cylinderCloud({ radius: 0.5, length: 1, step: 0.1 }), { delim: ' ', columns: 'xyzn' }))
    const { manifest } = collectProject({ scan: { name: 'part.xyz', file: blobOf(xyz), units: 'in' }, reference: null, image: null }, null, '0.1.0')
    const members = await readMembers(collectProject({ scan: { name: 'part.xyz', file: blobOf(xyz), units: 'in' }, reference: null, image: null }, null, '0.1.0').members)
    const back = unpackProject(packProject(manifest, members))
    expect(back.manifest.scan?.units).toBe('in')
    const units = meshUnitsOf(back.manifest.scan?.units) ?? 'mm' // units-ok: the default a MeshUnits id falls back to
    const scale = fileScale('part.xyz', units)
    expect(scale).toBe(25.4)
    const a = parseXYZ(bufferOf(xyz))
    const b = parseXYZ(bufferOf(back.members.get('scan.xyz')!))
    expect(Array.from(b.positions, (v) => v * scale)).toEqual(Array.from(a.positions, (v) => v * 25.4))
    expect(Array.from(b.normals!)).toEqual(Array.from(a.normals!))
  })

  it('brings two fitted elements back as saved', async () => {
    cloudSession()
    const before = useStore.getState().elements.map((e) => e.fit)
    const { back } = await roundTrip('part.ply', plyBytes())
    useStore.setState({ elements: [], nextId: 1 })
    prepareProjectState(back.manifest, back.members)()
    const after = useStore.getState().elements
    expect(after).toHaveLength(2)
    expect(after.map((e) => e.fit)).toEqual(before)
    expect(after.map((e) => e.name)).toEqual(['Plane 1', 'Plane 2'])
  })

  it.each(['mesh', 'thickness'])('opens a project saved in %s over a cloud in 3D Measure', async (saved) => {
    // Saved from a mesh session standing in that workspace.
    fresh()
    useStore.setState({ scanIsCloud: false })
    useShell.getState().setWorkspace(saved)
    const { back } = await roundTrip('part.ply', plyBytes())
    expect(back.manifest.workspace).toBe(saved)
    // useProject's order: the scan is committed — scanIsCloud set from the
    // worker's kind, as commitScan does — before the saved state is applied
    // through prepareProjectState's closure.
    useShell.getState().setWorkspace('elements')
    useStore.setState({ scanIsCloud: true })
    prepareProjectState(back.manifest, back.members)()
    expect(useStore.getState().scanIsCloud).toBe(true)
    expect(useShell.getState().workspace).toBe('elements')
  })

  it('still opens a mesh project in the workspace it was saved in', async () => {
    fresh()
    useStore.setState({ scanIsCloud: false })
    useShell.getState().setWorkspace('mesh')
    const { manifest, members } = collectProject({ scan: { name: 'a.stl', file: blobOf(new Uint8Array([1, 2, 3])) }, reference: null, image: null }, null, '0.1.0')
    const back = unpackProject(packProject(manifest, await readMembers(members)))
    useShell.getState().setWorkspace('elements')
    prepareProjectState(back.manifest, back.members)()
    expect(useShell.getState().workspace).toBe('mesh')
  })
})

/** A scene whose scan is the cloud, laid out as the viewport lays one out. */
function cloudScene(): SceneManager {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(cloud.positions.slice(), 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(cloud.normals.slice(), 3))
  return { scanGeometry: () => geometry, scanVertexCount: () => cloud.positions.length / 3 } as unknown as SceneManager
}

describe('exporting a cloud', () => {
  beforeEach(() => cloudSession())

  it('writes the cloud with the graph normals, and reopens identical', async () => {
    const file = await buildScanPointCloud(cloudScene(), 'ply')
    expect(file?.status).toContain('with normals')
    const again = parsePLY(bufferOf(file!.bytes))
    expect(again.kind).toBe('cloud')
    expect(Array.from(again.positions)).toEqual(Array.from(cloud.positions))
    expect(Array.from(again.normals!)).toEqual(Array.from(cloud.normals))
  })

  it('refuses a mesh export with the cloud refusal', () => {
    expect(() => buildScanMesh(cloudScene(), 'stl')).toThrow(CLOUD_REFUSAL)
    expect(() => buildScanMesh(cloudScene(), '3mf')).toThrow(CLOUD_REFUSAL)
  })

  it('refuses the mesh export command', async () => {
    await expect(runCommand('export.stl', {})).rejects.toMatchObject({ message: CLOUD_REFUSAL })
  })
})

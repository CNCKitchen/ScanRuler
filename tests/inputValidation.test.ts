// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { buildMeshGraph } from '../src/core/geometry/buildGraph'
import { parseOBJ } from '../src/core/parsers/obj'
import { validateManifest } from '../src/core/project/manifest'
import { packProject, unpackProject } from '../src/core/project/archive'
import { collectProject, emptySources } from '../src/app/project'
import { useStore } from '../src/state/store'
import { useFlat } from '../src/state/flatStore'
import { useDeviation } from '../src/state/deviationStore'
import { useThickness } from '../src/state/thicknessStore'

const obj = (text: string) => parseOBJ(new TextEncoder().encode(text).buffer)
const vertices = 'v 0 0 0\nv 1 0 0\nv 0 1 0\n'
describe('mesh input validation', () => {
  it.each([NaN, Infinity, -Infinity])('rejects %s before welding or normal generation', (coordinate) => {
    const positions = new Float32Array([coordinate, 0, 0, 1, 0, 0, 0, 1, 0])
    expect(() => buildMeshGraph({ kind: 'soup', positions })).toThrow('non-finite')
  })
  it('rejects invalid indices even when their triangle is degenerate', () => {
    expect(() => buildMeshGraph({ kind: 'indexed', positions: new Float32Array(9), indices: new Uint32Array([999, 999, 0]) })).toThrow('vertices that do not exist')
  })
  it.each(['0', '-4', '1x', '1.5', '4294967297'])('rejects malformed OBJ face index %s', (index) => {
    expect(() => obj(`${vertices}f ${index} 2 3\n`)).toThrow('Invalid OBJ face index')
  })
  it('accepts indentation, negative references, and inline comments', () => {
    const parsed = obj(`  ${vertices}  f -3 -2 -1 # 4 is a comment\n`)
    expect([...parsed.indices!]).toEqual([0, 1, 2])
    expect(buildMeshGraph(parsed).triangleCount).toBe(1)
  })
  it.each(['NaN', 'Infinity', '1oops'])('rejects invalid OBJ coordinate %s', (coordinate) => {
    expect(() => obj(`v ${coordinate} 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n`)).toThrow('Invalid OBJ vertex')
  })
})

describe('project input validation', () => {
  beforeEach(() => {
    useStore.setState(useStore.getInitialState(), true)
    useFlat.setState(useFlat.getInitialState(), true)
    useDeviation.setState(useDeviation.getInitialState(), true)
    useThickness.setState(useThickness.getInitialState(), true)
  })
  const project = () => JSON.parse(JSON.stringify(collectProject(emptySources(), null, 'test').manifest))
  it('round trips current empty projects and legacy optional fields', () => {
    const manifest = project()
    delete manifest.flat.subject
    delete manifest.flat.sheets
    delete manifest.flat.notes
    expect(unpackProject(packProject(manifest, [])).manifest).toEqual(manifest)
  })
  it('accepts an unresolved flat construction with a null fit', () => {
    const manifest = project()
    manifest.flat.elements = [{ id: 1, kind: 'point', name: 'Point 1', color: '#000', source: { type: 'construct', method: 'intersection', refs: [2, 3] }, fit: null, error: 'Missing source', visible: true }]
    expect(() => validateManifest(manifest)).not.toThrow()
  })
  it.each([
    ['thickness', 'coneRays', 1e9],
    ['thickness', 'coneRays', -1],
    ['thickness', 'coneRays', 2.5],
    ['thickness', 'method', 'bogus'],
    ['thickness', 'maxThickness', -5],
    ['deviation', 'range', 0],
    ['deviation', 'tolerance', -1],
    ['deviation', 'bands', 1e9],
    ['deviation', 'bands', 'x'],
    ['deviation', 'targetSide', 7],
    ['flat', 'edgeSensitivity', -3],
    ['flat', 'turns', 2.5],
    ['flat', 'datum', 'x'],
    ['deviation', 'pairs', [1]],
    ['thickness', 'normalDeviationDeg', 'x'],
  ])('rejects %s.%s = %j', (part, key, value) => {
    const manifest = project()
    manifest[part][key] = value
    expect(() => validateManifest(manifest)).toThrow('Malformed project')
  })
  it('accepts the settings in their ranges', () => {
    const manifest = project()
    Object.assign(manifest.thickness, { coneRays: 12, method: 'sphere', bands: 8, normalDeviationDeg: 30 })
    Object.assign(manifest.deviation, { bands: null, targetSide: -1, pairs: [{ scan: [0, 0, 0], nominal: [1, 2, 3] }] })
    Object.assign(manifest.flat, { turns: 3, datum: null })
    expect(() => validateManifest(manifest)).not.toThrow()
  })
  it.each([0, -1, 1.5])('rejects unsupported schema %s', (version) => {
    expect(() => validateManifest({ ...project(), schemaVersion: version })).toThrow('schema version')
  })
  it('rejects empty workspace objects before stores can be changed', () => {
    const manifest = project()
    manifest.flat = {}
    const before = useStore.getState()
    expect(() => validateManifest(manifest)).toThrow('Malformed project')
    expect(useStore.getState()).toBe(before)
  })
  it('rejects duplicate IDs and invalid nested numbers', () => {
    const manifest = project()
    manifest.thickness.probes = [{ id: 1 }, { id: 1 }]
    expect(() => validateManifest(manifest)).toThrow('IDs')
    manifest.thickness.probes = [{ id: 1, value: Infinity }]
    expect(() => validateManifest(manifest)).toThrow('non-finite')
  })
  it('checks every referenced archive member exists', () => {
    const manifest = project()
    manifest.flat.image = { fileName: 'scan.png', member: 'image.png' }
    expect(() => unpackProject(packProject(manifest, []))).toThrow('missing image.png')
  })
  it('bounds expansion before decompressing a member', () => {
    const compressed = zipSync({ 'large.bin': new Uint8Array(100_000) })
    expect(() => unpackProject(compressed, { totalBytes: 1000, manifestBytes: 1000, members: 16 })).toThrow('size limits')
  })
  it('bounds a stored member that declares no uncompressed size', () => {
    // A stored member yields its compressed bytes whatever size it declares,
    // so an archive saying 0 must not slip past the limits.
    const manifest = strToU8(JSON.stringify({ app: 'ScanRuler', schemaVersion: 1, pad: 'x'.repeat(200_000) }))
    const zip = zipSync({ 'project.json': [manifest, { level: 0 }] })
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
    for (let i = 0; i + 4 <= zip.byteLength; i++) {
      if (dv.getUint32(i, true) === 0x04034b50) dv.setUint32(i + 22, 0, true)
      if (dv.getUint32(i, true) === 0x02014b50) dv.setUint32(i + 24, 0, true)
    }
    expect(() => unpackProject(zip, { totalBytes: 1000, manifestBytes: 1000, members: 16 })).toThrow('size limits')
  })
  it('bounds the manifest and rejects unsafe member names', () => {
    const bytes = packProject(project(), [])
    expect(() => unpackProject(bytes, { totalBytes: 100_000, manifestBytes: 10, members: 16 })).toThrow('size limits')
    const archive = zipSync({ '../project.json': strToU8('{}') })
    expect(() => unpackProject(archive)).toThrow('invalid archive member')
  })
  it('refuses to save an archive that exceeds the reader limits', () => {
    expect(() => packProject(project(), [], { totalBytes: 100_000, manifestBytes: 10, members: 16 })).toThrow('size limits')
  })
})

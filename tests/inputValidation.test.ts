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

// SPDX-License-Identifier: AGPL-3.0-only
// The Mesh Tools workspace's part of a project file.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { validateManifest } from '../../../src/core/project/manifest'
import { collectProject, prepareProjectState, readAs } from '../../../src/app/project'
import { useMeshTools } from '../state/meshStore'
import { editedCopy } from '../state/editedCopy'
import type { MeshPart } from '../app/projectSection'
import { meshSection } from '../app/projectSection'
import { buildBinaryPly } from '../core/plyWriter'
import { useStore } from '../../../src/state/store'
import meshPlugin from '../plugin'
import { fresh, sources } from '../../../tests/projectKit'

beforeAll(() => meshPlugin.install?.())

describe('the Mesh Tools part of a project', () => {
  beforeEach(fresh)

  it('saves what the reduction is asked for and whether it was made, and puts the settings back', () => {
    useMeshTools.setState({
      tolerance: 0.02,
      toleranceAuto: false,
      maxTriangles: 12_000,
      pieceSize: 3,
      pieceSizeAuto: false,
      cutRef: 'z',
      cutOffset: 0.5,
      cutOffsetAuto: false,
      cutKeep: 'plus',
      cutCap: true,
      holeSize: 5,
      holeSizeAuto: true,
      fillMode: 'curved',
      smoothSize: 1,
      smoothSizeAuto: true,
      smoothLimit: 0.2,
      smoothLimitAuto: true,
      smoothEdges: true,
      offsetDistance: 0.1,
      offsetDirection: 'expand',
      offsetScope: 'all',
      shellThickness: 2,
      shellThicknessAuto: true,
      shellSide: 'in',
      report: null,
      edits: [],
    })
    const { manifest } = collectProject(sources(), null, '0.1.0')
    expect(manifest.mesh).toEqual({
      reduced: false,
      tolerance: 0.02,
      toleranceAuto: false,
      maxTriangles: 12_000,
      pieceSize: 3,
      pieceSizeAuto: false,
      cut: { ref: 'z', offset: 0.5, offsetAuto: false, keep: 'plus', cap: true },
      fill: { size: 5, sizeAuto: true, mode: 'curved' },
      smooth: { size: 1, sizeAuto: true, limit: 0.2, limitAuto: true, keepEdges: true, scope: 'all' },
      boolean: { op: 'subtract' },
      offset: { distance: 0.1, direction: 'expand', scope: 'all' },
      shell: { thickness: 2, thicknessAuto: true, side: 'in' },
      trim: { offset: 0, depth: 0.3, flip: false },
    })
    const json = JSON.parse(JSON.stringify(manifest))
    useMeshTools.setState({ tolerance: 0.5, toleranceAuto: true, maxTriangles: 50_000, cutOffset: 9, cutOffsetAuto: true })
    prepareProjectState(validateManifest(json))()
    expect(useMeshTools.getState()).toMatchObject({
      tolerance: 0.02,
      toleranceAuto: false,
      maxTriangles: 12_000,
      pieceSize: 3,
      cutOffset: 0.5,
      cutOffsetAuto: false,
      edits: [],
    })
  })

  it('keeps the cut, fill, smoothing, offset, trim and shell settings and every kind of edit, and reads a project from before them', () => {
    useMeshTools.setState({
      cutRef: 4,
      cutOffset: -2,
      cutOffsetAuto: false,
      cutKeep: 'minus',
      cutCap: false,
      holeSize: 8,
      holeSizeAuto: false,
      fillMode: 'flat',
      smoothScope: 'marked',
      smoothSize: 0.5,
      smoothSizeAuto: false,
      smoothLimit: 0.02,
      smoothLimitAuto: false,
      smoothEdges: false,
      boolOp: 'intersect',
      offsetDistance: 0.25,
      offsetDirection: 'shrink',
      offsetScope: 'marked',
      shellThickness: 1.5,
      shellThicknessAuto: false,
      shellSide: 'both',
      trimOffset: 0.15,
      trimDepth: 0.5,
      trimFlip: true,
      edits: [
        { kind: 'delete', triangles: 120 },
        { kind: 'flip', triangles: 5000 },
        { kind: 'flip', triangles: 32, region: 25 },
        { kind: 'offset', distance: -0.25, maxMove: 0.35, region: 300 },
        { kind: 'offset', distance: 0.1, maxMove: 0.17 },
        { kind: 'shell', mode: 'hollow', thickness: 2, triangles: 1800, cavities: 1, volume: 2118.4 },
        { kind: 'shell', mode: 'thicken', thickness: 1.5, side: 'both', triangles: 4000 },
        { kind: 'boolean', op: 'subtract', solid: 'Solid 2', removed: 40, added: 260, volume: -42.4 },
        { kind: 'cut', plane: 'XY plane, Z 0.5 mm', removed: 3400, capped: 1, open: 0 },
        { kind: 'fill', maxSize: 8, mode: 'flat', holes: 3, triangles: 96 },
        { kind: 'smooth', size: 0.5, limit: 0.02, maxMove: 0.018 },
        { kind: 'smooth', size: 2, limit: 0.5, maxMove: 0.1, region: 1200 },
      ],
    })
    const saved = useMeshTools.getState()
    const { manifest } = collectProject(sources(), null, '0.1.0')
    const json = JSON.parse(JSON.stringify(manifest))
    useMeshTools.setState({
      cutRef: 'z', cutKeep: 'plus', cutCap: true, holeSize: 5, fillMode: 'curved', smoothScope: 'all', smoothSize: 1, smoothEdges: true, boolOp: 'subtract',
      offsetDistance: 0.1, offsetDirection: 'expand', offsetScope: 'all', shellThickness: 2, shellThicknessAuto: true, shellSide: 'in', edits: [],
      trimOffset: 0, trimDepth: 0.3, trimFlip: false,
    })
    prepareProjectState(validateManifest(json))()
    expect(useMeshTools.getState()).toMatchObject({
      cutRef: 4,
      cutOffset: -2,
      cutKeep: 'minus',
      cutCap: false,
      holeSize: 8,
      holeSizeAuto: false,
      fillMode: 'flat',
      smoothScope: 'marked',
      smoothSize: 0.5,
      smoothSizeAuto: false,
      smoothLimit: 0.02,
      smoothEdges: false,
      boolOp: 'intersect',
      offsetDistance: 0.25,
      offsetDirection: 'shrink',
      offsetScope: 'marked',
      shellThickness: 1.5,
      shellThicknessAuto: false,
      shellSide: 'both',
      trimOffset: 0.15,
      trimDepth: 0.5,
      trimFlip: true,
      edits: saved.edits,
    })

    expect(() => prepareProjectState(validateManifest({ ...json, mesh: { ...json.mesh, cut: { ...json.mesh.cut, ref: 'w' } } }))).toThrow(/Malformed/)
    expect(() => prepareProjectState(validateManifest({ ...json, mesh: { ...json.mesh, cut: { ...json.mesh.cut, keep: 'up' } } }))).toThrow(/Malformed/)
    expect(() => prepareProjectState(validateManifest({ ...json, mesh: { ...json.mesh, fill: { ...json.mesh.fill, mode: 'round' } } }))).toThrow(/Malformed/)
    expect(() => prepareProjectState(validateManifest({ ...json, mesh: { ...json.mesh, smooth: { ...json.mesh.smooth, size: 0 } } }))).toThrow(/Malformed/)
    expect(() => prepareProjectState(validateManifest({ ...json, mesh: { ...json.mesh, smooth: { ...json.mesh.smooth, scope: 'some' } } }))).toThrow(/Malformed/)
    expect(() => prepareProjectState(validateManifest({ ...json, mesh: { ...json.mesh, edits: [{ kind: 'cut', plane: 3, removed: 1, capped: 0, open: 0 }] } }))).toThrow(/Malformed/)
    expect(() => prepareProjectState(validateManifest({ ...json, mesh: { ...json.mesh, boolean: { op: 'xor' } } }))).toThrow(/Malformed/)
    expect(() => prepareProjectState(validateManifest({ ...json, mesh: { ...json.mesh, edits: [{ kind: 'boolean', op: 'subtract', solid: 2, removed: 1, added: 1, volume: 0 }] } }))).toThrow(/Malformed/)
    expect(() => prepareProjectState(validateManifest({ ...json, mesh: { ...json.mesh, offset: { ...json.mesh.offset, direction: 'up' } } }))).toThrow(/Malformed/)
    expect(() => prepareProjectState(validateManifest({ ...json, mesh: { ...json.mesh, offset: { ...json.mesh.offset, distance: -1 } } }))).toThrow(/Malformed/)
    expect(() => prepareProjectState(validateManifest({ ...json, mesh: { ...json.mesh, shell: { ...json.mesh.shell, side: 'left' } } }))).toThrow(/Malformed/)
    expect(() => prepareProjectState(validateManifest({ ...json, mesh: { ...json.mesh, edits: [{ kind: 'shell', mode: 'fill', thickness: 1, triangles: 1 }] } }))).toThrow(/Malformed/)
    expect(() => prepareProjectState(validateManifest({ ...json, mesh: { ...json.mesh, edits: [{ kind: 'offset', distance: '1', maxMove: 1 }] } }))).toThrow(/Malformed/)
    expect(() => prepareProjectState(validateManifest({ ...json, mesh: { ...json.mesh, edits: [{ kind: 'flip', triangles: 3, region: 'top' }] } }))).toThrow(/Malformed/)
    expect(() => prepareProjectState(validateManifest({ ...json, mesh: { ...json.mesh, trim: { ...json.mesh.trim, offset: -0.1 } } }))).toThrow(/Malformed/)
    expect(() => prepareProjectState(validateManifest({ ...json, mesh: { ...json.mesh, trim: { ...json.mesh.trim, depth: 0 } } }))).toThrow(/Malformed/)
    expect(() => prepareProjectState(validateManifest({ ...json, mesh: { ...json.mesh, trim: { ...json.mesh.trim, flip: 'yes' } } }))).toThrow(/Malformed/)

    // A project from before these tools keeps whatever they were set to.
    const older = { ...json, mesh: { ...json.mesh } }
    delete older.mesh.cut
    delete older.mesh.fill
    delete older.mesh.smooth
    delete older.mesh.boolean
    delete older.mesh.offset
    delete older.mesh.shell
    delete older.mesh.trim
    useMeshTools.setState({ holeSize: 11, smoothSize: 3, boolOp: 'add', offsetDistance: 0.4, shellSide: 'out', trimOffset: 0.05 })
    prepareProjectState(validateManifest(older))()
    expect(useMeshTools.getState()).toMatchObject({ holeSize: 11, smoothSize: 3, boolOp: 'add', offsetDistance: 0.4, shellSide: 'out', trimOffset: 0.05 })
    useMeshTools.setState({
      edits: [], cutRef: 'z', cutOffsetAuto: true, smoothScope: 'all', boolOp: 'subtract',
      offsetDistance: 0.1, offsetDirection: 'expand', offsetScope: 'all', shellThickness: 2, shellThicknessAuto: true, shellSide: 'in',
      trimOffset: 0, trimDepth: 0.3, trimFlip: false,
    })
  })

  it('keeps the copy being edited beside the scan, with its numbering and its edits', () => {
    const pending = [{ kind: 'smooth' as const, size: 2, limit: 0.5, maxMove: 0.12 }]
    useMeshTools.setState({ edits: [], pending })
    const map = Int32Array.from([0, -1, 1, 2])
    const copy = { source: { name: 'bracket.ply', bytes: new Uint8Array([4, 4, 4]) }, map }
    editedCopy.current = copy
    const { manifest, members } = collectProject(sources(), null, '0.1.0')
    editedCopy.current = null
    const files = new Map(members.map((m) => [m.name, m.bytes] as const))
    expect((manifest.mesh as MeshPart | undefined)?.copy).toEqual({ member: 'edited.ply', mapMember: 'edited-map.bin', pending })
    expect(members.find((m) => m.name === 'edited.ply')?.bytes).toBe(copy.source.bytes)
    const bytes = members.find((m) => m.name === 'edited-map.bin')!.bytes
    expect(Array.from(new Int32Array(bytes.slice().buffer))).toEqual([0, -1, 1, 2])
    // Read back, the edits wait on the copy again.
    const json = JSON.parse(JSON.stringify(manifest))
    useMeshTools.setState({ pending: [] })
    prepareProjectState(validateManifest(json), files)()
    expect(useMeshTools.getState().pending).toEqual(pending)
    // A file that names a copy the archive does not hold is refused.
    expect(() => prepareProjectState(validateManifest(json))).toThrow('Project is missing edited.ply')
    expect(() => prepareProjectState(validateManifest({ ...json, mesh: { ...json.mesh, copy: { ...json.mesh.copy, member: 3 } } }))).toThrow(/Malformed/)
    // Without a copy, none is saved.
    expect(collectProject(sources(), null, '0.1.0').manifest.mesh).not.toHaveProperty('copy')
    useMeshTools.setState({ pending: [] })
  })

  it('refuses a copy map of torn int32s before the session is replaced, and numbers past the copy once the scan is in', async () => {
    const pending = [{ kind: 'smooth' as const, size: 2, limit: 0.5, maxMove: 0.12 }]
    useMeshTools.setState({ edits: [], pending })
    editedCopy.current = { source: { name: 'bracket.ply', bytes: new Uint8Array([4]) }, map: Int32Array.from([0, 1]) }
    const { manifest, members } = collectProject(sources(), null, '0.1.0')
    editedCopy.current = null
    const json = validateManifest(JSON.parse(JSON.stringify(manifest)))
    const files = new Map(members.map((m) => [m.name, m.bytes] as const))
    // Five bytes are no whole number of vertex numbers.
    files.set('edited-map.bin', new Uint8Array(5))
    expect(() => prepareProjectState(json, files)).toThrow(/Malformed/)
    // A number below -1 is no vertex.
    files.set('edited-map.bin', new Uint8Array(Int32Array.from([0, -2]).buffer))
    expect(() => prepareProjectState(json, files)).toThrow(/Malformed/)
    // A copy of three vertices has no vertex 3; the edits waiting on it go.
    const ply = buildBinaryPly(new Float32Array(9), Uint32Array.from([0, 1, 2]))
    files.set('edited.ply', ply)
    files.set('edited-map.bin', new Uint8Array(Int32Array.from([0, 3]).buffer))
    prepareProjectState(json, files)()
    useStore.setState({ vertexCount: 2 })
    const part = json.mesh as MeshPart
    await expect(meshSection.restore!(part, { manifest: json, members: files })).rejects.toThrow(/Malformed/)
    expect(useMeshTools.getState().pending).toEqual([])
    // In range, it is read.
    useMeshTools.setState({ pending })
    files.set('edited-map.bin', new Uint8Array(Int32Array.from([0, 2]).buffer))
    await meshSection.restore!(part, { manifest: json, members: files })
    expect(useMeshTools.getState().pending).toEqual(pending)
    useMeshTools.setState({ pending: [] })
  })

  it('keeps an edited scan as the PLY it now is, under the name it was opened as, with its edits', () => {
    const edit = { kind: 'pieces' as const, minSize: 2, pieces: 37, triangles: 1204 }
    useMeshTools.setState({ edits: [edit] })
    const edited = { ...sources(), scan: { name: 'bracket.ply', bytes: new Uint8Array([9, 9, 9]), units: 'mm' as const } }
    const { manifest, members } = collectProject(edited, null, '0.1.0')
    expect(manifest.scan).toMatchObject({ fileName: 'bracket.stl', member: 'scan.ply' })
    expect(manifest.scan).not.toHaveProperty('units')
    expect(members.find((m) => m.name === 'scan.ply')?.bytes).toBe(edited.scan.bytes)
    expect((manifest.mesh as MeshPart | undefined)?.edits).toEqual([edit])
    // Read back as what the member is, shown as what it was opened as.
    expect(readAs(manifest.scan!.fileName, manifest.scan!.member)).toBe('bracket.ply')
    expect(readAs('bracket.stl', 'scan.stl')).toBe('bracket.stl')
    const json = JSON.parse(JSON.stringify(manifest))
    useMeshTools.setState({ edits: [] })
    prepareProjectState(validateManifest(json))()
    expect(useMeshTools.getState().edits).toEqual([edit])
    useMeshTools.setState({ edits: [] })
  })

  it('refuses a malformed Mesh Tools part, and reads a project from before the workspace', () => {
    const { manifest } = collectProject(sources(), null, '0.1.0')
    const json = JSON.parse(JSON.stringify(manifest))
    expect(() => prepareProjectState(validateManifest({ ...json, mesh: { ...json.mesh, tolerance: 0 } }))).toThrow(/Malformed/)
    expect(() => prepareProjectState(validateManifest({ ...json, mesh: { ...json.mesh, maxTriangles: 1.5 } }))).toThrow(/Malformed/)
    expect(() => prepareProjectState(validateManifest({ ...json, mesh: { ...json.mesh, pieceSizeAuto: 'yes' } }))).toThrow(/Malformed/)
    expect(() => prepareProjectState(validateManifest({ ...json, mesh: { ...json.mesh, edits: [{ kind: 'smooth', minSize: 1, pieces: 1, triangles: 1 }] } }))).toThrow(/Malformed/)
    expect(() => prepareProjectState(validateManifest({ ...json, mesh: { ...json.mesh, edits: [{ kind: 'pieces', minSize: '1', pieces: 1, triangles: 1 }] } }))).toThrow(/Malformed/)
    const older = { ...json }
    delete older.mesh
    useMeshTools.setState({ tolerance: 0.3 })
    prepareProjectState(validateManifest(older))()
    expect(useMeshTools.getState().tolerance).toBe(0.3)
    // From when the limit could be none: read as the limit a reduction
    // starts with.
    useMeshTools.setState({ maxTriangles: 7 })
    prepareProjectState(validateManifest({ ...json, mesh: { ...json.mesh, maxTriangles: null } }))()
    expect(useMeshTools.getState().maxTriangles).toBe(50_000)
  })

})

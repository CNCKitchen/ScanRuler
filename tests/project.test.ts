// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it } from 'vitest'
import { strToU8, unzipSync } from 'fflate'
import { packProject, unpackProject } from '../src/core/project/archive'
import {
  alignFromJson,
  alignToJson,
  elementFromJson,
  elementToJson,
  PROJECT_SCHEMA,
  projectStem,
  rigidFromJson,
  rigidToJson,
  validateManifest,
} from '../src/core/project/manifest'
import {
  applyDeviationPart,
  applyFlatPart,
  applyScanPart,
  applyThicknessPart,
  collectProject,
  sessionIsDirty,
} from '../src/app/project'
import { useStore, type Element } from '../src/state/store'
import { useDeviation } from '../src/state/deviationStore'
import { useThickness } from '../src/state/thicknessStore'
import { useFlat } from '../src/state/flatStore'
import { useShell } from '../src/state/shellStore'
import { identityRigid } from '../src/core/deviation/rigid'

const sources = () => ({
  scan: { name: 'bracket.stl', bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) },
  reference: { name: 'bracket.step', bytes: strToU8('ISO-10303-21;') },
  image: { name: 'sheet.png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
})

function fresh() {
  useStore.getState().beginLoad('bracket.stl')
  useStore.getState().finishLoad(100, 50, 10, [1, 2, 3])
  useDeviation.setState({ nominalName: null, align: null, globalAlign: null, pairs: [], probes: [] })
  useThickness.getState().clear()
  useFlat.setState({ imageName: null, elements: [], dimensions: [], counts: [], datum: null })
  useShell.getState().setWorkspace('elements')
}

describe('the project archive', () => {
  beforeEach(fresh)

  it('is a plain zip holding project.json beside the model files', () => {
    const { manifest, members } = collectProject(sources(), null, '0.1.0')
    const bytes = packProject(manifest, members)
    const files = unzipSync(bytes)
    expect(Object.keys(files).sort()).toEqual(['project.json', 'scan.stl'])
    expect(files['scan.stl']).toEqual(sources().scan.bytes)
    // The reference and image are only written when something is loaded.
    expect(manifest.deviation.reference).toBeNull()
    expect(manifest.flat.image).toBeNull()
  })

  it('round-trips the manifest and the members', () => {
    useDeviation.setState({ nominalName: 'bracket.step' })
    useFlat.setState({ imageName: 'sheet.png' })
    const { manifest, members } = collectProject(sources(), Uint32Array.from([3, 5, 8]), '0.1.0')
    const back = unpackProject(packProject(manifest, members))
    expect(back.manifest).toEqual(JSON.parse(JSON.stringify(manifest)))
    expect(back.manifest.deviation.scope).toEqual([3, 5, 8])
    expect(back.manifest.deviation.reference?.member).toBe('reference.step')
    expect(back.manifest.flat.image?.member).toBe('image.png')
    expect([...back.members.keys()].sort()).toEqual(['image.png', 'reference.step', 'scan.stl'])
    expect(back.members.get('reference.step')).toEqual(sources().reference.bytes)
  })

  it('refuses what is not a project', () => {
    expect(() => unpackProject(new Uint8Array([1, 2, 3]))).toThrow('Not a ScanRuler project')
    expect(() => validateManifest({ app: 'filaSim', schemaVersion: 1 })).toThrow(
      'Not a ScanRuler project',
    )
    expect(() => validateManifest({ app: 'ScanRuler', schemaVersion: PROJECT_SCHEMA + 1 })).toThrow(
      'newer version',
    )
  })

  it('names the file after the scan, else the image', () => {
    expect(projectStem('bracket.stl', 'sheet.png')).toBe('bracket')
    expect(projectStem(null, 'sheet.png')).toBe('sheet')
    expect(projectStem(null, null)).toBe('project')
  })
})

describe('the JSON encodings', () => {
  it('carry typed arrays through as plain arrays', () => {
    const m = identityRigid()
    m.t[1] = 2.5
    const back = rigidFromJson(JSON.parse(JSON.stringify(rigidToJson(m))))
    expect(back.r).toBeInstanceOf(Float64Array)
    expect(Array.from(back.t)).toEqual([0, 2.5, 0])
    expect(() => rigidFromJson({ r: [1], t: [] })).toThrow()

    const el: Element = {
      id: 1,
      kind: 'plane',
      name: 'Plane 1',
      color: '#f00',
      source: { type: 'fitted', seeds: [4], selection: Uint32Array.from([1, 2, 3]) },
      status: 'fitting',
      visible: true,
    }
    const json = JSON.parse(JSON.stringify(elementToJson(el)))
    expect(json.source.selection).toEqual([1, 2, 3])
    expect(json.status).toBe('done')
    const restored = elementFromJson(json)
    expect(restored.source.type === 'fitted' && restored.source.selection).toBeInstanceOf(
      Uint32Array,
    )

    const a = alignFromJson(
      JSON.parse(
        JSON.stringify(
          alignToJson({
            transform: m,
            source: 'auto',
            rms: 0.01,
            meanDistance: 0.008,
            iterations: 12,
            matched: 500,
            sampled: 600,
            ambiguous: false,
          }),
        ),
      ),
    )
    expect(a.transform.t[1]).toBe(2.5)
    expect(a.rms).toBe(0.01)
  })
})

describe('writing a project back onto the stores', () => {
  beforeEach(fresh)

  it('restores elements, dimensions, counters and settings', () => {
    const { manifest } = collectProject(sources(), null, '0.1.0')
    manifest.scan!.elements = [
      {
        id: 7,
        kind: 'sphere',
        name: 'Sphere 1',
        color: '#abc',
        source: { type: 'fitted', seeds: [10], selection: [1, 2] },
        status: 'done',
        visible: false,
        fit: { kind: 'sphere', center: [0, 0, 0], radius: 5, rms: 0, count: 3 } as never,
      },
    ]
    manifest.scan!.dimensions = [{ id: 3, type: 'point-point', name: 'D1', refs: [7, 7] }]
    manifest.scan!.nextId = 8
    manifest.scan!.settings = { method: 'gaussian', sigma: 2 }
    manifest.scan!.selectMode = 'paint'
    applyScanPart(JSON.parse(JSON.stringify(manifest.scan)))
    const s = useStore.getState()
    expect(s.elements).toHaveLength(1)
    expect(s.elements[0].visible).toBe(false)
    expect(
      s.elements[0].source.type === 'fitted' && s.elements[0].source.selection,
    ).toBeInstanceOf(Uint32Array)
    expect(s.dimensions[0].name).toBe('D1')
    expect(s.nextId).toBe(8)
    expect(s.settings.sigma).toBe(2)
    expect(s.selectMode).toBe('paint')
    expect(sessionIsDirty()).toBe(true)
  })

  it('restores the deviation, thickness and flat parts', () => {
    useDeviation.setState({
      tolerance: 0.25,
      bands: 9,
      split: true,
      probes: [{ id: 1, point: [1, 1, 1], value: 0.1 }],
      nextProbeId: 2,
    })
    useThickness.setState({ status: 'ready', method: 'sphere', limit: 2.5 })
    useFlat.setState({
      imageName: 'sheet.png',
      pxPerMm: { x: 23.6, y: 23.6 },
      calSource: 'measured',
      showGrid: false,
    })
    const { manifest } = collectProject(sources(), null, '0.1.0')
    expect(manifest.thickness.measured).toBe(true)
    const json = JSON.parse(JSON.stringify(manifest))

    useDeviation.setState({ tolerance: 0.1, bands: null, split: false, probes: [] })
    useThickness.getState().clear()
    useThickness.setState({ method: 'ray', limit: 1 })
    useFlat.setState({ pxPerMm: null, calSource: 'none', showGrid: true })

    applyDeviationPart(json.deviation)
    applyThicknessPart(json.thickness)
    applyFlatPart(json.flat)
    expect(useDeviation.getState().tolerance).toBe(0.25)
    expect(useDeviation.getState().bands).toBe(9)
    expect(useDeviation.getState().split).toBe(true)
    expect(useDeviation.getState().probes[0].value).toBe(0.1)
    expect(useThickness.getState().method).toBe('sphere')
    expect(useThickness.getState().limit).toBe(2.5)
    expect(useFlat.getState().pxPerMm).toEqual({ x: 23.6, y: 23.6 })
    expect(useFlat.getState().calSource).toBe('measured')
    expect(useFlat.getState().showGrid).toBe(false)
  })
})

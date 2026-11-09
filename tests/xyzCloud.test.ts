// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseXYZ } from '../src/core/parsers/xyz'
import { REFERENCE_ACCEPT, SCAN_ACCEPT } from '../src/core/formats'
import type { WorkerRequest, WorkerResponse } from '../src/core/workerProtocol'
import { usePrefs } from '../src/state/prefsStore'
import { asksUnits, meshUnitsFor, useUnitsPrompt } from '../src/state/unitsPromptStore'
import { planeCloud, writeXyz, writePlyCloud } from './cloudFixtures'

const cloud = planeCloud({ size: 10, step: 1 })
const NO_NORMALS = 'This point cloud has no normals — ScanRuler needs them to measure on points.'

describe('XYZ / ASC / PTS reader', () => {
  for (const delim of [' ', '\t', ',', ';'] as const) {
    for (const crlf of [false, true]) {
      it(`reads 121 points with normals, delimiter ${JSON.stringify(delim)}${crlf ? ' CRLF' : ''}`, () => {
        const m = parseXYZ(writeXyz(cloud, { delim, crlf, columns: 'xyzn' }))
        expect(m.kind).toBe('cloud')
        expect(m.positions.length).toBe(121 * 3)
        expect(m.normals!.length).toBe(121 * 3)
        expect(m.normals![2]).toBeCloseTo(1)
        expect(m.positions[0]).toBeCloseTo(cloud.positions[0])
      })
    }
  }

  it('header lines and comments are skipped', () => {
    const m = parseXYZ(writeXyz(cloud, { delim: ' ', columns: 'xyzn', header: ['X Y Z NX NY NZ', '# made by a scanner', '// another'] }))
    expect(m.positions.length).toBe(121 * 3)
  })

  it('PTS count line is skipped', () => {
    const m = parseXYZ(writeXyz(cloud, { delim: ' ', columns: 'xyzn', ptsCount: true }))
    expect(m.positions.length).toBe(121 * 3)
  })

  it('reads scientific notation', () => {
    const text = '1.5e1 -2E-1 3e0 0 0 1\n0 0 0 1.0e0 0 0\n'
    const m = parseXYZ(new TextEncoder().encode(text).buffer as ArrayBuffer)
    expect(Array.from(m.positions.slice(0, 3))).toEqual([15, -0.2, 3].map(Math.fround))
    expect(m.positions.length).toBe(6)
    expect(m.normals![3]).toBeCloseTo(1)
  })

  it('xyz only is refused', () => {
    expect(() => parseXYZ(writeXyz(cloud, { delim: ' ', columns: 'xyz' }))).toThrow(NO_NORMALS)
  })

  it('xyzrgb (0–255) is refused', () => {
    expect(() => parseXYZ(writeXyz(cloud, { delim: ' ', columns: 'xyzrgb' }))).toThrow(NO_NORMALS)
  })

  it('xyzrgbn and xyzirgbn take the last three columns as normals', () => {
    for (const columns of ['xyzrgbn', 'xyzirgbn'] as const) {
      const m = parseXYZ(writeXyz(cloud, { delim: ',', columns }))
      expect(m.positions.length).toBe(121 * 3)
      expect(m.normals![0]).toBeCloseTo(0)
      expect(m.normals![2]).toBeCloseTo(1)
    }
  })

  it('a numeric-looking header is not a point', () => {
    const m = parseXYZ(writeXyz(cloud, { delim: ' ', columns: 'xyzn', header: ['1 2 3'] }))
    expect(m.positions.length).toBe(121 * 3)
  })
})

describe('units for clouds', () => {
  beforeEach(() => {
    usePrefs.getState().setAskStlUnits(true)
    usePrefs.getState().setStlUnits('mm')
    useUnitsPrompt.setState({ request: null })
  })

  it('asksUnits is true for stl, xyz, asc, pts', () => {
    for (const n of ['part.xyz', 'part.asc', 'part.pts', 'part.stl', 'PART.XYZ']) expect(asksUnits(n)).toBe(true)
    expect(asksUnits('part.ply')).toBe(false)
  })

  it('a cloud file resolves the saved units when not asking', async () => {
    usePrefs.getState().setAskStlUnits(false)
    usePrefs.getState().setStlUnits('in')
    await expect(meshUnitsFor('part.xyz')).resolves.toBe('in')
    await expect(meshUnitsFor('part.ply')).resolves.toBe('mm')
  })
})

describe('a cloud as reference', () => {
  let scope: { onmessage: ((event: { data: WorkerRequest }) => void) | null; postMessage: (msg: WorkerResponse) => void }
  let replies: WorkerResponse[]
  beforeEach(async () => {
    replies = []
    scope = { onmessage: null, postMessage: (msg) => replies.push(msg) }
    vi.stubGlobal('self', scope)
    vi.resetModules()
    await import('../src/core/meshWorker')
  })
  afterEach(() => vi.unstubAllGlobals())

  it('is refused', () => {
    const buffer = writePlyCloud(cloud, 'binary_little_endian')
    scope.onmessage!({ data: { type: 'load-nominal', requestId: 1, name: 'ref.ply', buffer } })
    const reply = replies.at(-1)!
    expect(reply.type).toBe('error')
    expect((reply as { message: string }).message).toBe('A point cloud cannot be the reference yet — open a mesh or CAD file.')
  })

  it('the reference accept list excludes xyz/asc/pts, the scan list has them', () => {
    for (const e of ['.xyz', '.asc', '.pts']) {
      expect(SCAN_ACCEPT).toContain(e)
      expect(REFERENCE_ACCEPT).not.toContain(e)
    }
  })
})

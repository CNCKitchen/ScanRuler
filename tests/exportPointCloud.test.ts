// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { buildPointCloudPly, buildPointCloudXyz } from '../src/core/exportPointCloud'
import { rigidFromAxisAngle } from '../src/core/deviation/rigid'

// Three vertices with outward normals, as a welded scan carries them.
const XYZ = new Float32Array([0, 0, 0, 10, 0, 0, 10, 4, 2.5])
const NRM = new Float32Array([0, 0, 1, 1, 0, 0, 0, 1, 0])

/** Split a binary PLY into its header lines and the bytes after them. */
function readPly(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  const text = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 4096)))
  const end = text.indexOf('end_header\n')
  expect(end).toBeGreaterThan(0)
  const bodyAt = new TextEncoder().encode(text.slice(0, end + 'end_header\n'.length)).length
  const lines = text.slice(0, end + 'end_header'.length).split('\n')
  const view = new DataView(buffer, bodyAt)
  const floats: number[] = []
  for (let at = 0; at + 4 <= view.byteLength; at += 4) floats.push(view.getFloat32(at, true))
  return { lines, floats, bodyBytes: view.byteLength }
}

/** A quarter turn about Z and a shift of 100 along X — the pose a best fit
 *  might leave the scan in. */
const pose = () => {
  const m = rigidFromAxisAngle([0, 0, 1], Math.PI / 2)
  m.t.set([100, 0, 0])
  return m
}

describe('point-cloud PLY', () => {
  it('writes a vertex-only binary header and the floats after it', () => {
    const { lines, floats, bodyBytes } = readPly(buildPointCloudPly(XYZ, NRM, null, 'ScanRuler test'))
    expect(lines).toEqual([
      'ply',
      'format binary_little_endian 1.0',
      'comment ScanRuler test',
      'element vertex 3',
      'property float x',
      'property float y',
      'property float z',
      'property float nx',
      'property float ny',
      'property float nz',
      'end_header',
    ])
    expect(bodyBytes).toBe(3 * 24)
    expect(floats.slice(0, 6)).toEqual([0, 0, 0, 0, 0, 1])
    expect(floats.slice(12, 18)).toEqual([10, 4, 2.5, 0, 1, 0])
  })

  it('moves the points and turns the normals through a transform, leaving the inputs alone', () => {
    const before = [Array.from(XYZ), Array.from(NRM)]
    const { floats } = readPly(buildPointCloudPly(XYZ, NRM, pose(), 'posed'))
    // (10, 0, 0) turned a quarter turn is (0, 10, 0), then shifted to (100, 10, 0).
    expect(floats[6]).toBeCloseTo(100, 5)
    expect(floats[7]).toBeCloseTo(10, 5)
    expect(floats[8]).toBeCloseTo(0, 5)
    // Its normal +X turns to +Y and is not shifted.
    expect(floats[9]).toBeCloseTo(0, 5)
    expect(floats[10]).toBeCloseTo(1, 5)
    expect(floats[11]).toBeCloseTo(0, 5)
    expect([Array.from(XYZ), Array.from(NRM)]).toEqual(before)
  })

  it('writes positions only when there are no normals, and keeps the comment on one line', () => {
    const { lines, bodyBytes } = readPly(buildPointCloudPly(XYZ, null, null, 'two\nlines — ünïcode'))
    expect(lines).not.toContain('property float nx')
    expect(lines[2]).toBe('comment two lines ? ?n?code')
    expect(bodyBytes).toBe(3 * 12)
  })
})

describe('point-cloud XYZ text', () => {
  it('writes one point per line with its normal', () => {
    const text = buildPointCloudXyz(XYZ, NRM, null)
    const lines = text.split('\n')
    expect(lines).toHaveLength(4)
    expect(lines[3]).toBe('')
    expect(lines[0]).toBe('0.0000 0.0000 0.0000 0.00000 0.00000 1.00000')
    expect(lines[2]).toBe('10.0000 4.0000 2.5000 0.00000 1.00000 0.00000')
  })

  it('applies the pose and drops the normal columns when there are none', () => {
    const lines = buildPointCloudXyz(XYZ, null, pose()).split('\n')
    expect(lines[1]).toBe('100.0000 10.0000 0.0000')
    expect(lines[1].split(' ')).toHaveLength(3)
  })
})

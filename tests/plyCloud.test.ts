// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { parsePLY } from '../src/core/parsers/ply'
import { buildMeshGraph } from '../src/core/geometry/buildGraph'
import { planeCloud, writePlyCloud, type PlyCloudOptions } from './cloudFixtures'

const NO_NORMALS = 'This point cloud has no normals — ScanRuler needs them to measure on points.'

function expectPlane(buf: ArrayBuffer): void {
  const src = planeCloud({ size: 10, step: 1 })
  const mesh = parsePLY(buf)
  expect(mesh.kind).toBe('cloud')
  expect(mesh.positions.length).toBe(363)
  expect(mesh.normals!.length).toBe(363)
  for (let i = 0; i < 363; i++) {
    expect(Math.abs(mesh.positions[i] - src.positions[i])).toBeLessThan(1e-6)
    expect(Math.abs(mesh.normals![i] - src.normals[i])).toBeLessThan(1e-6)
  }
}

describe('PLY point clouds', () => {
  const plane = planeCloud({ size: 10, step: 1 })

  it('reads a binary LE cloud with normals', () => {
    expectPlane(writePlyCloud(plane, 'binary_little_endian'))
  })

  it('reads ascii and big-endian clouds', () => {
    expectPlane(writePlyCloud(plane, 'ascii'))
    expectPlane(writePlyCloud(plane, 'binary_big_endian'))
  })

  it('reads double normals and normals not next to xyz', () => {
    const o: PlyCloudOptions = { double: true, extraBefore: ['float quality'], extraAfter: ['uchar red', 'uchar green', 'uchar blue'] }
    for (const f of ['ascii', 'binary_little_endian', 'binary_big_endian'] as const) expectPlane(writePlyCloud(plane, f, o))
  })

  it('element face 0 is a cloud', () => {
    expectPlane(writePlyCloud(plane, 'binary_little_endian', { faceZero: true }))
    expectPlane(writePlyCloud(plane, 'ascii', { faceZero: true }))
  })

  it('a cloud without normals is refused', () => {
    for (const f of ['ascii', 'binary_little_endian'] as const) {
      expect(() => parsePLY(writePlyCloud(plane, f, { noNormals: true }))).toThrow(new Error(NO_NORMALS))
    }
  })

  it('the old message is gone', () => {
    const messages: string[] = []
    try { parsePLY(writePlyCloud(plane, 'ascii', { noNormals: true })) } catch (e) { messages.push((e as Error).message) }
    try {
      buildMeshGraph({ kind: 'indexed', positions: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0), indices: new Uint32Array(0) })
    } catch (e) { messages.push((e as Error).message) }
    expect(messages).toHaveLength(2)
    expect(messages[1]).toBe('The file contains no usable triangles.')
    for (const m of messages) expect(m).not.toContain('not supported yet')
  })
})

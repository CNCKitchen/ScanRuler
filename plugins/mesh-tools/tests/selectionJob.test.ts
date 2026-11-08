// SPDX-License-Identifier: AGPL-3.0-only
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { regionContains, SelectionJob, type SelectionRequest } from '../viewer/selectionJob'

function request(): SelectionRequest {
  const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.01, 100)
  camera.position.z = 10
  camera.updateMatrixWorld(true)
  return {
    requestId: 1, type: 'select', remove: false, mask: new Uint8Array(2),
    mesh: {
      positions: new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0, -1, -1, -0.000001, 1, -1, -0.000001, 0, 1, -0.000001]),
      indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
    },
    camera: { world: camera.matrixWorld.toArray(), projection: camera.projectionMatrix.toArray() },
    part: new THREE.Matrix4().toArray(), width: 100, height: 100, planes: [], regions: [],
  }
}

describe('background visible selection', () => {
  it('preserves exact front-sheet identity, emits progress, and reuses the mesh for boundary work', () => {
    const job = new SelectionJob()
    const messages: string[] = []
    const percentages: number[] = []
    const input = request()
    try {
      const result = job.run(input, (text, percent) => {
        messages.push(text)
        if (percent !== undefined) percentages.push(percent)
      })
      expect([...result.mask]).toEqual([1, 0])
      expect(result.edges).toHaveLength(6)
      expect(messages).toContain('Preparing visibility checks...')
      expect(messages).toContain('Finding selection boundaries...')
      expect(percentages).toEqual([0])
      const edges = job.run({ ...input, mesh: undefined, type: 'boundary', mask: new Uint8Array([0, 1]) }, () => {})
      expect([...edges.mask]).toEqual([0, 1])
      expect([...edges.edges]).toEqual([3, 4, 3, 5, 4, 5])
    } finally { job.dispose() }
  })

  it('respects clipping, serialized regions, and fails explicitly for a missing or mismatched mesh', () => {
    const job = new SelectionJob()
    const input = request()
    expect(() => job.run({ ...input, mesh: undefined }, () => {})).toThrow('no mesh')
    try {
      const result = job.run({ ...input, planes: [[0, 0, -1, -0.0000005]], regions: [{ kind: 'window', minX: 45, minY: 45, maxX: 55, maxY: 65 }] }, () => {})
      expect([...result.mask]).toEqual([0, 1])
      expect(() => job.run({ ...input, mesh: undefined, mask: new Uint8Array(1) }, () => {})).toThrow('different mesh')
    } finally { job.dispose() }
  })

  it('matches window, lasso, and brush stroke regions', () => {
    expect(regionContains({ kind: 'window', minX: 0, minY: 0, maxX: 10, maxY: 10 }, 11, 5)).toBe(false)
    const lasso = { kind: 'lasso' as const, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] }
    expect(regionContains(lasso, 5, 5)).toBe(true)
    expect(regionContains(lasso, 15, 5)).toBe(false)
    const brush = { kind: 'brush' as const, a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, radius: 2 }
    expect(regionContains(brush, 5, 1)).toBe(true)
    expect(regionContains(brush, 5, 3)).toBe(false)
    expect(regionContains({ ...brush, b: brush.a }, 1, 0)).toBe(true)
  })

  it('reconstructs an aligned underside camera and removes only the visible sheet', () => {
    const job = new SelectionJob()
    const input = request()
    const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.01, 100)
    camera.position.set(7, 3, -10)
    camera.lookAt(7, 3, 0)
    camera.updateMatrixWorld(true)
    const part = new THREE.Matrix4().makeRotationZ(Math.PI / 4)
    part.setPosition(7, 3, 0)
    try {
      const result = job.run({
        ...input, mask: new Uint8Array([1, 1]), remove: true,
        camera: { world: camera.matrixWorld.toArray(), projection: camera.projectionMatrix.toArray() },
        part: part.toArray(),
      }, () => {})
      expect([...result.mask]).toEqual([1, 0])
    } finally { job.dispose() }
  })
})

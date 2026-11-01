// SPDX-License-Identifier: AGPL-3.0-only
// The Mesh Tools layer of the viewport, drawn into a stand-in for the scene.
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { computeBoundsTree } from 'three-mesh-bvh'
import type { SceneManager } from '../../../src/viewer/SceneManager'
import { DEFAULT_THEME } from '../../../src/viewer/viewThemes'
import { colormapById } from '../../../src/core/field/colormap'
import { deviationScale } from '../../../src/core/deviation/deviation'
import { MeshScene } from '../viewer/meshScene'

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree

/** The little of a SceneManager the layer reaches for. */
function fakeScene(): { scene: SceneManager; partGroup: THREE.Group } {
  const partGroup = new THREE.Group()
  const host = { theme: () => DEFAULT_THEME, partGroup, invalidate: () => {} }
  const scene = { layerHost: () => host, addLayer: () => () => {} } as unknown as SceneManager
  return { scene, partGroup }
}

describe('the piece Trim to scan made, on screen', () => {
  it('paints its gap into one colour attribute, not a new one each time', () => {
    const { scene, partGroup } = fakeScene()
    const layer = new MeshScene(scene)
    layer.setTrimmedPiece({
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: Uint32Array.from([0, 1, 2]),
      mating: Uint8Array.from([1]),
      gap: Float32Array.from([0, 0.5, 1]),
    })
    const geometry = (partGroup.children[0] as THREE.Mesh).geometry
    const paint = { scale: deviationScale(1, 10, null), map: colormapById('viridis') }
    layer.setTrimmedGap(paint)
    const first = geometry.getAttribute('color') as THREE.BufferAttribute
    const version = first.version
    layer.setTrimmedGap({ ...paint, map: colormapById('jet') })
    expect(geometry.getAttribute('color')).toBe(first)
    expect(first.version).toBeGreaterThan(version)
  })
})

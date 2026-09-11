// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it } from 'vitest'
import {
  attachSurfaceScene,
  forgetAllSurfaces,
  forgetSurface,
  hasSurface,
  rememberSurface,
  surfaceSource,
  surfacesMoved,
  useSurfaces,
} from '../src/app/surfaces'
import { useStore } from '../src/state/store'
import type { SceneManager } from '../src/viewer/SceneManager'
import type { PlaneFit } from '../src/core/types'

/** A stand-in for the viewport: just the scan's position buffer. */
function fakeScene(positions: Float32Array): SceneManager {
  const geometry = { getAttribute: () => ({ array: positions }) }
  return { scanGeometry: () => geometry } as unknown as SceneManager
}

const plane: PlaneFit = {
  kind: 'plane',
  center: [0, 0, 0],
  normal: [0, 0, 1],
  basisU: [1, 0, 0],
  basisV: [0, 1, 0],
  extentU: 5,
  extentV: 5,
  sigma: 0.01,
  usedPoints: 3,
  regionSize: 4,
  formError: 0.02,
}

// Four vertices: three on the plane within noise, one 1 mm off it.
const positions = Float32Array.from([
  0, 0, 0.005, //
  1, 0, -0.005, //
  9, 9, 9, // not in the region
  2, 2, 1, //
])

beforeEach(() => {
  forgetAllSurfaces()
  attachSurfaceScene(() => null)
  useStore.setState({
    elements: [
      {
        id: 1,
        name: 'Plane 1',
        kind: 'plane',
        color: '#000',
        status: 'done',
        visible: true,
        source: { type: 'fitted', seeds: [0] },
        fit: plane,
      },
    ],
    settings: { method: 'gaussian', sigma: 3 },
  })
})

describe('surfaces', () => {
  it('reads nothing before the viewport is up or the fit has landed', () => {
    expect(surfaceSource(1)).toBeNull()
    attachSurfaceScene(() => fakeScene(positions))
    expect(surfaceSource(1)).toBeNull()
    rememberSurface(1, Uint32Array.from([0, 1, 3]))
    expect(hasSurface(1)).toBe(true)
    expect(surfaceSource(1)).not.toBeNull()
  })

  it('packs the region coordinates and drops what the cut-off left out', () => {
    attachSurfaceScene(() => fakeScene(positions))
    rememberSurface(1, Uint32Array.from([0, 1, 3]))
    // 3 sigma = 0.03 mm: the point 1 mm off the plane is an outlier.
    expect(Array.from(surfaceSource(1)!)).toEqual([0, 0, 0.005, 1, 0, -0.005].map((v) => Math.fround(v)))
    // With every point in use, it stays.
    useStore.setState({ settings: { method: 'gaussian', sigma: 0 } })
    expect(surfaceSource(1)!.length).toBe(9)
  })

  it('bumps the version as surfaces come, go and move', () => {
    const v0 = useSurfaces.getState().version
    rememberSurface(1, Uint32Array.from([0]))
    const v1 = useSurfaces.getState().version
    expect(v1).toBeGreaterThan(v0)
    surfacesMoved()
    const v2 = useSurfaces.getState().version
    expect(v2).toBeGreaterThan(v1)
    forgetSurface(1)
    expect(hasSurface(1)).toBe(false)
    expect(useSurfaces.getState().version).toBeGreaterThan(v2)
    // Forgetting what is not there changes nothing.
    const v3 = useSurfaces.getState().version
    forgetSurface(1)
    expect(useSurfaces.getState().version).toBe(v3)
  })
})

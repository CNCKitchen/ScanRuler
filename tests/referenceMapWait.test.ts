// SPDX-License-Identifier: AGPL-3.0-only
// The map on the reference asked for while a run of it is going: whoever
// asks waits for that run and finds the map, rather than finding none and
// leaving the run to collide with the next change. And the element overlays
// put away for a picture take the selection and the ghost of a fit with
// them.
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { createSession } from '../src/app/session'
import { identityRigid } from '../src/core/deviation/rigid'
import type { MeshWorkerClient, ReferenceDeviationResult } from '../src/core/workerClient'
import { useDeviation } from '../src/state/deviationStore'
import { Overlays } from '../src/viewer/overlays'

describe('the map on the reference', () => {
  it('is waited for when asked for while it is being measured', async () => {
    let finish: (r: ReferenceDeviationResult) => void = () => {}
    let runs = 0
    const client = {
      scanVersion: 1,
      nominalVersion: 1,
      deviateReference: () => {
        runs++
        return new Promise<ReferenceDeviationResult>((resolve) => (finish = resolve))
      },
    } as unknown as MeshWorkerClient
    const session = createSession({ clientRef: { current: client }, sceneRef: { current: null } })
    useDeviation.setState(useDeviation.getInitialState(), true)
    const unwatch = session.watch()
    try {
      // The map comes up on the reference: the watcher starts its run.
      useDeviation.setState({
        source: 'reference',
        mapOn: 'reference',
        mapStatus: 'ready',
        align: { transform: identityRigid(), source: 'auto', rms: 0.05, meanDistance: 0.04, iterations: 10, matched: 1000, sampled: 1000, ambiguous: false },
      })
      expect(useDeviation.getState().referenceStatus).toBe('running')
      expect(runs).toBe(1)
      // Asked for again meanwhile, it waits for the same run.
      let waited = false
      const asked = session.deviation.runReferenceMap().then(() => (waited = true))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(waited).toBe(false)
      const map = { values: new Float32Array(3), positions: new Float32Array(9), spacing: 0.5 } as unknown as ReferenceDeviationResult
      finish(map)
      await asked
      expect(runs).toBe(1)
      expect(useDeviation.getState().referenceStatus).toBe('ready')
      expect(session.maps.referenceMap.current).toBe(map)
    } finally {
      unwatch()
      useDeviation.setState(useDeviation.getInitialState(), true)
    }
  })
})

describe('the element overlays', () => {
  it('put away, take the selection strokes and the ghost of a fit with them', () => {
    const partGroup = new THREE.Group()
    const camera = new THREE.PerspectiveCamera()
    const overlays = new Overlays({ partGroup, modelRadius: () => 10, invalidate: () => {}, camera: () => camera, raycaster: new THREE.Raycaster(), occluder: () => null })
    const [elements, selection, preview] = overlays.clipRoots()
    overlays.setShown(false)
    expect([elements.visible, selection.visible, preview.visible]).toEqual([false, false, false])
    overlays.setShown(true)
    expect([elements.visible, selection.visible, preview.visible]).toEqual([true, true, true])
  })
})

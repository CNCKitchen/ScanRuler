// SPDX-License-Identifier: AGPL-3.0-only
// The feature list played back for the camera (app/playback.ts): a plate
// and a hole cut through it, built up again from nothing a feature at a
// time, each step built before the next — held, stepped by hand, ended —
// and the list, the undo history and the file just as they were after it.
// Whatever else moves the bar or opens an editor ends it where it stands.
// With the sketches skipped only the steps that change the geometry show.
// The kernel runs in this thread, as the commands' tests run it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { pausePlayback, playbackBusy, playbackSteps, resumePlayback, startPlayback, stepPlayback, stopPlayback } from '../app/playback'
import { collectReversePart } from '../app/projectSection'
import { createReverseSession, installReverseSession, type ReverseSession } from '../app/reSession'
import type { Feature, SketchFeature } from '../core/features'
import { ReClient } from '../core/reClient'
import { localKernel } from './reLocal'
import { addEntity, addRectangle, emptySketch, type Sketch } from '../core/sketch'
import { useRePrefs } from '../state/rePrefs'
import { useReverse } from '../state/reStore'
import { extrudeAll, XY } from './reKit'

function sketchOf(id: number, draw: (s: Sketch) => void): SketchFeature {
  const sketch = emptySketch()
  draw(sketch)
  return { id, kind: 'sketch', name: `Sketch ${id}`, plane: { kind: 'world', axis: 'z', offset: 0 }, frame: XY, sketch, visible: false }
}

/** A plate, and a hole cut through it from a second sketch. */
function plateWithHole(): Feature[] {
  const plate = sketchOf(1, (s) => addRectangle(s, [0, 0], [40, 20]))
  const circle = sketchOf(3, (s) => addEntity(s, { kind: 'circle', c: [20, 10], r: 3 }))
  return [plate, extrudeAll(2, plate, 0, 5, 'new'), circle, extrudeAll(4, circle, -1, 6, 'cut', 2)]
}
const PLATE = 40 * 20 * 5
const HOLED = PLATE - Math.PI * 9 * 5

const re = () => useReverse.getState()

/** Until `done` holds, or fail after `ms`. */
async function until(done: () => boolean, ms = 60_000): Promise<void> {
  const started = Date.now()
  while (!done()) {
    if (Date.now() - started > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

let session: ReverseSession
const stops: (() => void)[] = []

beforeAll(async () => {
  session = createReverseSession({ sceneRef: { current: null }, kernel: () => new ReClient(localKernel()) })
  stops.push(installReverseSession(session), session.watch())
  await session.startKernel()
}, 120_000)
afterAll(() => {
  stopPlayback(false)
  for (const stop of stops) stop()
})
beforeEach(async () => {
  stopPlayback(false)
  const { kernelStatus, kernelVersion, kernelMessage } = re()
  useReverse.setState({ ...useReverse.getInitialState(), kernelStatus, kernelVersion, kernelMessage }, true)
  useReverse.setState((s) => ({ features: plateWithHole(), nextFeatureId: 5, buildVersion: s.buildVersion + 1 }))
  // No holding in a test: each step moves on once it is built.
  useRePrefs.setState({ playbackStepMs: 0, playbackSkipSketches: false })
  await session.settled()
})

describe('the playback', () => {
  it('builds the part up from nothing a feature a step, each built before the next, and leaves the list as it was', async () => {
    const past = re().past
    const landed: { at: number; bodies: number; volume: number }[] = []
    const unsub = useReverse.subscribe((s, prev) => {
      if (s.bodies !== prev.bodies && s.playback) landed.push({ at: s.features.length, bodies: s.bodies.length, volume: s.bodies[0]?.volume ?? 0 })
    })
    expect(startPlayback()).toBe(true)
    expect(re().playback).toEqual({ origin: 4, at: 0, playing: true })
    expect(playbackBusy()).toMatch(/played back/)
    await until(() => re().playback === null)
    unsub()

    expect(landed.map((l) => l.at)).toEqual([0, 1, 2, 3, 4])
    expect(landed[0].bodies).toBe(0)
    expect(landed[1].bodies).toBe(0)
    expect(landed[2].volume).toBeCloseTo(PLATE, 1)
    expect(landed[4].volume).toBeCloseTo(HOLED, 1)
    expect(re().features.map((f) => f.id)).toEqual([1, 2, 3, 4])
    expect(re().rolledBack).toEqual([])
    // Not a step of the undo history, and nothing left busy.
    expect(re().past).toBe(past)
    expect(playbackBusy()).toBeNull()
  })

  it('holds, steps by hand within the list, and ends with the bar where it stood — the file keeping it there all along', async () => {
    re().rollTo(3)
    await session.settled()
    startPlayback()
    pausePlayback()
    expect(re().playback).toEqual({ origin: 3, at: 0, playing: false })
    stepPlayback(1)
    stepPlayback(1)
    expect(re().playback?.at).toBe(2)
    expect(re().features.map((f) => f.id)).toEqual([1, 2])
    await session.settled()
    expect(re().bodies[0].volume).toBeCloseTo(PLATE, 1)
    expect(collectReversePart()?.rolledTo).toBe(3)
    stepPlayback(10)
    expect(re().playback?.at).toBe(4)
    stepPlayback(-10)
    expect(re().playback?.at).toBe(0)

    stopPlayback()
    expect(re().playback).toBeNull()
    expect(re().features.map((f) => f.id)).toEqual([1, 2, 3])
    expect(re().rolledBack.map((f) => f.id)).toEqual([4])
  })

  it('played on from the end starts again from the top', async () => {
    startPlayback()
    pausePlayback()
    stepPlayback(4)
    resumePlayback()
    expect(re().playback).toEqual({ origin: 4, at: 0, playing: true })
    await until(() => re().playback === null)
    expect(re().features).toHaveLength(4)
  })

  it('ends where it stands when an editor opens, or the list changes under it', async () => {
    startPlayback()
    pausePlayback()
    stepPlayback(2)
    re().startExtrude(1)
    expect(re().extrudeDraft).not.toBeNull()
    expect(re().playback).toBeNull()
    expect(re().features.map((f) => f.id)).toEqual([1, 2])
    re().cancelExtrude()

    re().rollTo(null)
    startPlayback()
    pausePlayback()
    stepPlayback(3)
    re().removeFeature(4)
    expect(re().playback).toBeNull()
    expect(re().features.map((f) => f.id)).toEqual([1, 2, 3])
  })

  it('does not start with an editor open, and lets go of a list cleared under it', async () => {
    re().startExtrude(1)
    expect(startPlayback()).toBe(false)
    re().cancelExtrude()

    startPlayback()
    re().reset()
    expect(re().playback).toBeNull()
    const version = re().buildVersion
    await new Promise((r) => setTimeout(r, 50))
    expect(re().buildVersion).toBe(version)
  })

  it('with the sketches skipped shows only the steps that change the geometry, by itself and by hand', async () => {
    const list = [...plateWithHole(), sketchOf(5, (s) => addRectangle(s, [0, 0], [5, 5]))]
    expect(playbackSteps(list.slice(0, 4), false)).toEqual([0, 1, 2, 3, 4])
    // A sketch left at the end is no step: the part does not change.
    expect(playbackSteps(list, true)).toEqual([0, 2, 4])

    useReverse.setState((s) => ({ features: list, nextFeatureId: 6, buildVersion: s.buildVersion + 1 }))
    await session.settled()
    useRePrefs.setState({ playbackSkipSketches: true })
    const shown: number[] = []
    const unsub = useReverse.subscribe((s, prev) => {
      if (s.bodiesVersion !== prev.bodiesVersion && s.playback) shown.push(s.features.length)
    })
    startPlayback()
    await until(() => re().playback === null)
    unsub()
    expect(shown).toEqual([0, 2, 4])
    expect(re().features).toHaveLength(5)

    startPlayback()
    pausePlayback()
    stepPlayback(1)
    expect(re().playback?.at).toBe(2)
    stepPlayback(1)
    expect(re().playback?.at).toBe(4)
    // Nothing further shows: the key stays where it is.
    stepPlayback(1)
    expect(re().playback?.at).toBe(4)
    stepPlayback(-1)
    expect(re().playback?.at).toBe(2)
    stopPlayback()
    expect(re().features).toHaveLength(5)
  })
})

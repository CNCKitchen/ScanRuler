// SPDX-License-Identifier: AGPL-3.0-only
// The view commands, a picture as a result, and what a plugin says it is
// busy with: view.set and view.render need the viewport and say so without
// one; view.render is the one command whose result is a picture; a busy
// check registered beside the session's own holds every command that
// changes the session and shows in the readout, while reading goes on.
import * as THREE from 'three'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerBusy } from '../src/commands/activity'
import { listCommands, registerCommands } from '../src/commands/registry'
import { obj } from '../src/commands/schema'
import type { Command } from '../src/commands/types'
import { applyShow, pluginToggleKeys, registerViewToggles, settleShown, viewToggles, whyNotShown, type ViewToggle } from '../src/commands/viewToggles'
import type { AlignResult } from '../src/core/deviation/align'
import { useDeviation } from '../src/state/deviationStore'
import { installHistory, useHistory } from '../src/state/historyStore'
import { usePrefs } from '../src/state/prefsStore'
import { useShell } from '../src/state/shellStore'
import { useStore } from '../src/state/store'
import { frameExtent, STANDARD_VIEWS, viewAcross, viewHalfHeight } from '../src/viewer/orthoViewport'
import { refused, resetStores, run, startHeadless, undoLabels, type Headless } from './commandKit'
// After the kit, which loads the commands in the order the app does.
import { baseToggles, describeMapPainted, frameKeeper, type MapPainted } from '../src/commands/core/view'
import { registerMapReport, type MapReport } from '../src/commands/mapReports'

let headless: Headless
beforeAll(async () => {
  headless = await startHeadless()
})
afterAll(() => headless.stop())

describe('the view', () => {
  it('needs the viewport, and says so', async () => {
    for (const [name, input] of [
      ['view.set', { view: 'top' }],
      ['view.render', { width: 320 }],
    ] as const) {
      const e = await refused(name, input)
      expect(e.code, name).toBe('unavailable')
      expect(e.message).toMatch(/viewport/)
    }
    expect((await refused('view.set', { view: 'sideways' })).code).toBe('invalid_input')
    expect((await refused('view.render', { width: 10 })).code).toBe('invalid_input')
    expect((await refused('view.render', { show: { scan: 'no' } })).code).toBe('invalid_input')
    expect((await refused('view.set', { frame: { min: [0, 0, 0] } })).code).toBe('invalid_input')
    // A section view is laid across something.
    expect((await refused('view.set', { section: { offset: 2 } })).code).toBe('invalid_input')
    expect((await refused('view.render', { section: 'XY' })).code).toBe('invalid_input')
    // The session's readout has no view to speak of without a viewport.
    expect((await run<{ view: unknown }>('session.state')).view).toBeNull()
  })

  it('takes a plugin’s toggles under its id, a plugin taking an app key over while its workspace is on', () => {
    let shown = true
    let on = true
    const base: ViewToggle[] = [{ key: 'scan', description: 'the scan', shown: () => shown, show: (v) => (shown = v) }]
    const mine: ViewToggle[] = [
      { key: 'bodies', description: 'the bodies', shown: () => true, show: () => {} },
      { key: 'scan', description: 'the scan, my way', shown: () => false, show: () => {}, applies: () => on },
    ]
    const stop = registerViewToggles('demo', mine)
    try {
      expect(() => registerViewToggles('demo', [])).toThrow(/share the id/)
      expect(pluginToggleKeys().map((t) => t.key)).toEqual(['bodies', 'scan'])
      const now = viewToggles(base)
      expect([...now.keys()]).toEqual(['scan', 'bodies'])
      expect(now.get('scan')!.description).toBe('the scan, my way')
      on = false
      expect(viewToggles(base).get('scan')!.description).toBe('the scan')
    } finally {
      stop()
    }
    expect(viewToggles(base).has('bodies')).toBe(false)
    expect(pluginToggleKeys()).toEqual([])
  })

  it('has a map key in the Deviation workspace, its Map switch, as Reverse engineer has one (issue 42)', () => {
    const scene = {} as Parameters<typeof baseToggles>[0]
    let uninstall: (() => void) | undefined
    useShell.getState().setWorkspace('deviation')
    try {
      const map = viewToggles(baseToggles(scene)).get('map')
      expect(map?.description).toMatch(/deviation map/)
      useDeviation.getState().setShowMap(true)
      // The store actions as the app wraps them, each a step.
      uninstall = installHistory()
      const steps = useHistory.getState().past.length
      const applied = applyShow(viewToggles(baseToggles(scene)), { map: false }, (m) => new Error(m))
      expect(useDeviation.getState().showMap).toBe(false)
      applied.putBack()
      expect(useDeviation.getState().showMap).toBe(true)
      // A picture's show is no step of the history (issue 34).
      expect(useHistory.getState().past.length).toBe(steps)
    } finally {
      uninstall?.()
      useShell.getState().setWorkspace('measure')
    }
    expect(viewToggles(baseToggles(scene)).has('map')).toBe(false)
  })

  it('lists view.render, flat.render, section.render and scan.heightmap as the commands that answer with a picture', () => {
    const pictures = listCommands().filter((c) => c.returnsImage)
    expect(pictures.map((c) => c.name)).toEqual(['flat.render', 'scan.heightmap', 'section.render', 'view.render'])
    for (const p of pictures) expect(p).toMatchObject({ readOnly: true, returnsFile: true })
    expect(listCommands().find((c) => c.name === 'view.set')).toMatchObject({ readOnly: true, returnsImage: false })
  })
})

describe('what a picture shows and puts back', () => {
  const refuse = (m: string) => new Error(m)
  /** A toggle over a variable of its own, counting its sets. */
  const toggle = (key: string, state: { on: boolean; sets: number }, boom = false): ViewToggle => ({
    key,
    description: key,
    shown: () => state.on,
    show: (on) => {
      if (boom) throw new Error('the stage fell over')
      state.on = on
      state.sets++
    },
  })

  it('puts a workspace’s key that is not on screen away as nothing done, and refuses showing it', () => {
    const scan = { on: true, sets: 0 }
    const stop = registerViewToggles('demo', [{ ...toggle('drawings', { on: true, sets: 0 }), applies: () => false }])
    try {
      const all = viewToggles([toggle('scan', scan)])
      const done = applyShow(all, { scan: false, drawings: false }, refuse)
      expect(done.absent).toEqual(['drawings'])
      expect(scan.on).toBe(false)
      done.putBack()
      expect(scan.on).toBe(true)
      // Showing it, or a key no one has, is refused before anything is set.
      expect(() => applyShow(all, { scan: false, drawings: true }, refuse)).toThrow(/not on screen/)
      expect(() => applyShow(all, { scan: false, drawnigs: false }, refuse)).toThrow(/no such key/)
      expect(scan).toEqual({ on: true, sets: 2 })
    } finally {
      stop()
    }
  })

  it('puts back what it set before a toggle that throws', () => {
    const a = { on: true, sets: 0 }
    const all = viewToggles([toggle('a', a), toggle('b', { on: true, sets: 0 }, true)])
    expect(() => applyShow(all, { a: false, b: false }, refuse)).toThrow(/fell over/)
    expect(a.on).toBe(true)
  })

  it('restores a toggle’s own saved state, not show(shown())', () => {
    // Two switches read as one: shown() is false with either off.
    const st = { hidden: false, eyes: false }
    const both: ViewToggle = {
      key: 'things',
      description: 'things',
      shown: () => !st.hidden && st.eyes,
      show: (on) => {
        st.hidden = !on
        if (on) st.eyes = true
      },
      save: () => ({ ...st }),
      restore: (saved) => Object.assign(st, saved),
    }
    for (const on of [false, true]) {
      const done = applyShow(viewToggles([both]), { things: on }, refuse)
      done.putBack()
      expect(st).toEqual({ hidden: false, eyes: false })
    }
  })

  it('says why a key is off where its toggle does — not one shown, one without a why, or one show put away', () => {
    const things = { on: false, sets: 0 }
    const all = viewToggles([
      { ...toggle('things', things), why: () => 'put away by its switch — show: { things: true } shows them' },
      toggle('scan', { on: false, sets: 0 }),
      { ...toggle('marks', { on: true, sets: 0 }), why: () => 'never read' },
      { ...toggle('quiet', { on: false, sets: 0 }), why: () => null },
    ])
    expect(whyNotShown(all, undefined)).toEqual({ thingsWhy: 'put away by its switch — show: { things: true } shows them' })
    expect(whyNotShown(all, { things: false })).toEqual({})
    things.on = true
    expect(whyNotShown(all, undefined)).toEqual({})
  })
})

describe('a place framed size mm across', () => {
  /** The camera looking from a standard view at a point, and what the view
   *  spans at a shape, from the extent a frame gives. */
  const spanOf = (view: keyof typeof STANDARD_VIEWS, at: THREE.Vector3, size: number | undefined, aspect: number) => {
    const { dir, up } = STANDARD_VIEWS[view]
    const camera = new THREE.OrthographicCamera()
    camera.up.copy(up)
    camera.position.copy(at).addScaledVector(dir.clone().normalize(), 200)
    camera.lookAt(at)
    camera.updateMatrixWorld(true)
    const h = (size ?? 50) / 2
    const box = new THREE.Box3(at.clone().subScalar(h), at.clone().addScalar(h))
    return viewAcross(frameExtent(box, camera.matrixWorld.clone().invert(), size), aspect)
  }

  it('fits a size × size square in iso and square to an axis, whatever the shape of the picture', () => {
    const at = new THREE.Vector3(10, -20, 35)
    for (const view of ['iso', 'top', 'front'] as const)
      for (const aspect of [0.6, 1, 1.6]) {
        const [w, h] = spanOf(view, at, 50, aspect)
        expect(Math.min(w, h)).toBeCloseTo(50, 9)
        expect(w / h).toBeCloseTo(aspect, 9)
      }
    // An 800 × 450 picture at 40: 40 tall and 71 wide.
    const [w, h] = spanOf('front', at, 40, 800 / 450)
    expect(h).toBeCloseTo(40, 9)
    expect(Math.round(w)).toBe(71)
    // The half-height the camera takes is the same one.
    expect(2 * viewHalfHeight(frameExtent(new THREE.Box3(), new THREE.Matrix4(), 40), 800 / 450)).toBeCloseTo(40, 9)
    // Zoomed in twice, it spans half.
    expect(viewAcross({ halfW: 20, halfH: 20 }, 800 / 450, 2)[1]).toBeCloseTo(20, 9)
    // The cube round it, framed whole, was some 1.6 times as wide in iso.
    expect(spanOf('iso', at, undefined, 1.6)[0] / 50).toBeGreaterThan(1.5)
  })
})

describe('a picture after a framed one', () => {
  it('says it was not fitted and still stands on the earlier frame, until a fit or another zoom', () => {
    const after = frameKeeper()
    const box = { min: [0, 0, 0] as [number, number, number], max: [10, 5, 2] as [number, number, number] }
    // Nothing framed yet: only whether it fitted.
    expect(after('1 50 40', undefined, false)).toEqual({ fitted: false })
    expect(after('1 50 40', undefined, true)).toEqual({ fitted: true })
    // A frame; the picture after it, a standard view keeping the zoom, stands on it.
    expect(after('1 6 4', box, false)).toEqual({ fitted: false })
    const next = after('1 6 4', undefined, false)
    expect(next.fitted).toBe(false)
    expect(next.framedEarlier).toMatchObject({ box })
    expect(String(next.framedEarlier?.note)).toMatch(/fit: true pictures it whole/)
    // A fit forgets it.
    expect(after('1 50 40', undefined, true)).toEqual({ fitted: true })
    expect(after('1 50 40', undefined, false)).toEqual({ fitted: false })
    // A place framed, then the person's wheel: another scale, forgotten.
    after('1 3 2', { at: [1, 2, 3], size: 6 }, false)
    expect(after('1 3 2', undefined, false).framedEarlier).toMatchObject({ at: [1, 2, 3], size: 6 })
    expect(after('1.5 3 2', undefined, false)).toEqual({ fitted: false })
    expect(after('1 3 2', undefined, false)).toEqual({ fitted: false })
  })
})

describe('a key a picture waits for', () => {
  it('is awaited when asked to show, within the time left, and not when put away', async () => {
    const asked: number[] = []
    const all = new Map<string, ViewToggle>([
      ['slow', { key: 'slow', description: 'read in a worker', shown: () => true, show: () => {}, settle: async (ms) => void asked.push(ms) }],
      ['plain', { key: 'plain', description: 'no wait', shown: () => true, show: () => {} }],
    ])
    await settleShown(all, { plain: true, slow: false }, 1000)
    expect(asked).toEqual([])
    await settleShown(all, undefined, 1000)
    expect(asked).toEqual([])
    await settleShown(all, { plain: true, slow: true, absent: true }, 1000)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toBeLessThanOrEqual(1000)
    // Past its time, it is asked for what is left: nothing.
    await settleShown(all, { slow: true }, -5000)
    expect(asked[1]).toBe(0)
  })
})

describe('the map a picture of the Deviation workspace shows', () => {
  // The stage as SceneManager.mapPainted reads it: the map on the scan,
  // both models drawn, the reference solid.
  const stage = (over: Partial<MapPainted> = {}): MapPainted => ({ scan: 'painted', scanShown: true, reference: null, referenceShown: false, nominalShown: false, nominalGhost: false, ...over })
  const mapped = () => {
    resetStores()
    useShell.getState().setWorkspace('deviation')
    useDeviation.setState({ source: 'reference', nominalName: 'nominal.stl', align: {} as AlignResult, mapStatus: 'ready', range: 0.5, showNominal: false })
  }

  it('says nothing outside the Deviation workspace', () => {
    resetStores()
    expect(describeMapPainted(stage())).toEqual({})
  })

  it('says, a map measured and another workspace on screen, that the map paints in the Deviation workspace', () => {
    mapped()
    useShell.getState().setWorkspace('elements')
    expect(describeMapPainted(stage())).toEqual({ map: null, mapWhy: "the Deviation workspace isn't on screen (now: measure) — workspace.set deviation paints its map." })
    // A workspace that colours the part its own way says so for itself.
    let own: MapReport | null = { map: { on: 'bodies' } }
    const off = registerMapReport('painter', () => own)
    try {
      useShell.getState().setWorkspace('painter')
      expect(describeMapPainted(stage())).toEqual({ map: { on: 'bodies' } })
      own = { map: null, mapWhy: 'its own map is off' }
      expect(describeMapPainted(stage())).toEqual({ map: null, mapWhy: "its own map is off; the Deviation workspace isn't on screen (now: painter) — workspace.set deviation paints its map." })
      useDeviation.setState({ mapStatus: 'idle' })
      expect(describeMapPainted(stage())).toEqual({ map: null, mapWhy: 'its own map is off' })
      own = null
      expect(describeMapPainted(stage())).toEqual({})
      expect(() => registerMapReport('painter', () => null)).toThrow(/Two map reports/)
    } finally {
      off()
      resetStores()
    }
  })

  it('names the map painted on the scan, and the ghost over it', () => {
    mapped()
    expect(describeMapPainted(stage())).toEqual({ map: { on: 'scan', colormap: usePrefs.getState().colormap, range: 0.5 } })
    const ghosted = describeMapPainted(stage({ nominalShown: true, nominalGhost: true }))
    expect(ghosted.map).toMatchObject({ on: 'scan' })
    expect(ghosted.mapNote).toMatch(/reference: false/)
  })

  it('says why no map is painted, and what puts one there', () => {
    mapped()
    const why = (painted = stage()) => {
      const r = describeMapPainted(painted)
      expect(r.map).toBeNull()
      return String(r.mapWhy)
    }
    useDeviation.setState({ showMap: false })
    expect(why()).toMatch(/switch is off.*show: true/)
    useDeviation.setState({ showMap: true, mapStatus: 'idle' })
    expect(why()).toMatch(/deviation\.measure/)
    useDeviation.setState({ align: null })
    expect(why()).toMatch(/deviation\.align/)
    useDeviation.setState({ align: {} as AlignResult, mapStatus: 'ready' })
    expect(why(stage({ scanShown: false }))).toMatch(/scan, which is put away/)
    expect(why(stage({ scan: 'unfit' }))).toMatch(/not one a vertex of the scan/)
    expect(why(stage({ scan: null }))).toMatch(/not on the stage/)
    useDeviation.setState({ source: 'element', elementStatus: 'idle' })
    expect(why()).toMatch(/deviation\.set_target/)
  })

  it('reads the map on the reference off the reference', () => {
    mapped()
    useDeviation.setState({ mapOn: 'reference', referenceStatus: 'idle' })
    const onRef = stage({ scan: null, reference: 'painted', referenceShown: true })
    expect(describeMapPainted(onRef).mapWhy).toMatch(/not measured.*on: "reference"/)
    useDeviation.setState({ referenceStatus: 'ready' })
    expect(describeMapPainted(onRef).mapWhy).toMatch(/reference, which is put away/)
    useDeviation.setState({ showNominal: true, split: true })
    expect(describeMapPainted(onRef).mapWhy).toMatch(/split/)
    useDeviation.setState({ split: false })
    expect(describeMapPainted({ ...onRef, reference: 'unfit' }).mapWhy).toMatch(/not one a vertex of the reference/)
    expect(describeMapPainted(onRef)).toEqual({ map: { on: 'reference', colormap: usePrefs.getState().colormap, range: 0.5 } })
    resetStores()
  })
})

describe('a plugin’s busy check', () => {
  it('holds the commands that change the session, shows in the readout, and lets reading go on', async () => {
    const mark: Command = {
      name: 'mark',
      title: 'Mark',
      description: 'Changes the session a little.',
      input: obj({}),
      run: async () => {
        useStore.setState((s) => ({ nextNumber: s.nextNumber + 1 }))
        return {}
      },
    }
    const unregister = registerCommands('demo', [mark])
    let working: string | null = 'the demo is thinking'
    const unbusy = registerBusy('demo', () => working)
    try {
      expect(() => registerBusy('demo', () => null)).toThrow(/share the id/)
      const e = await refused('demo.mark')
      expect(e.code).toBe('busy')
      expect(e.message).toMatch(/the demo is thinking/)
      expect((await run<{ busy: string | null }>('session.state')).busy).toBe('the demo is thinking')
      working = null
      await run('demo.mark')
      expect((await run<{ busy: string | null }>('session.state')).busy).toBeNull()
      expect(undoLabels().at(-1)).toBe('Agent: mark')
    } finally {
      unbusy()
      unregister()
    }
  })
})

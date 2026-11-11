// SPDX-License-Identifier: AGPL-3.0-only
// The Reverse engineer workspace in the app's undo history: an open sketch
// keeps its own undo, features undo and redo through the toolbar with their
// CAD rebuilt, an alignment carries the sketch frames exactly once each way,
// and undo after saving rebuilds. The app's own history checks are
// scripts/e2e-history.mjs.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node plugins/reverse/scripts/e2e-reverse-undo.mjs
// Env: CHROME (chrome.exe path), APP_URL.
import { launchApp, captureProjectSaves, check, fail, finish } from '../../../scripts/e2e-lib.mjs'

const { browser, page, consoleErrors } = await launchApp({ protocolTimeout: 180_000 })
await captureProjectSaves(page)
page.on('dialog', (dialog) => dialog.accept())
try {
  const checks = await page.evaluate(async () => {
    const { useStore: measure } = await import('/src/state/store.ts')
    const { useReverse: reverse } = await import('/plugins/reverse/state/reStore.ts')
    const { useShell: shell } = await import('/src/state/shellStore.ts')
    const history = await import('/src/state/historyStore.ts')
    const results = []
    const record = (ok, name) => results.push({ ok: !!ok, name })
    const pause = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))
    const wait = async (predicate, name) => {
      for (let i = 0; i < 1500; i++) { await pause(); if (predicate()) return }
      throw new Error(`${name}: ${measure.getState().errorText ?? measure.getState().statusText}; ${JSON.stringify(results)}`)
    }
    const drop = (file) => {
      const dataTransfer = new DataTransfer(); dataTransfer.items.add(file)
      window.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }))
    }
    const click = (test) => {
      const button = document.querySelector(`[data-test="${test}"]`)
      if (!button || button.disabled) throw new Error(`Unavailable button: ${test}`)
      button.click()
    }
    const travel = async (redo = false) => {
      const revision = history.useHistory.getState().revision
      click(redo ? 'redo' : 'undo')
      await wait(() => history.useHistory.getState().revision > revision && !history.useHistory.getState().restoring, 'history settled')
      await pause(100)
    }
    const cube = 'v 0 0 0\nv 10 0 0\nv 10 10 0\nv 0 10 0\nv 0 0 10\nv 10 0 10\nv 10 10 10\nv 0 10 10\nf 1 3 2\nf 1 4 3\nf 5 6 7\nf 5 7 8\nf 1 2 6\nf 1 6 5\nf 2 3 7\nf 2 7 6\nf 3 4 8\nf 3 8 7\nf 4 1 5\nf 4 5 8\n'
    drop(new File([cube], 'history-cube.obj'))
    await wait(() => measure.getState().fileName === 'history-cube.obj' && !measure.getState().busy, 'scan imported')
    const m = () => measure.getState(), r = () => reverse.getState()

    shell.getState().setWorkspace('reverse')
    await wait(() => r().kernelStatus === 'ready', 'CAD kernel ready')
    const frame = { origin: [0, 0, 0], normal: [0, 0, 1], basisU: [1, 0, 0], basisV: [0, 1, 0] }
    r().startSketch({ kind: 'world', axis: 'z', offset: 0 }, frame)
    r().setSketchTool('rectangle'); r().sketchClick([0, 0], 0.5, false, { off: true }); r().sketchClick([10, 10], 0.5, false, { off: true })
    await pause()
    click('undo'); await pause()
    record(r().sketchDraft.sketch.entities.length === 0, 'Reverse sketch undo stays inside the open sketch')
    click('redo'); await pause()
    record(r().sketchDraft.sketch.entities.length === 4, 'Reverse sketch redo restores its geometry')
    const sketch = r().commitSketch()
    await pause()
    r().startExtrude(sketch); r().commitExtrude()
    await wait(() => !r().building && r().bodies.length > 0, 'extrude built')
    await travel()
    await wait(() => !r().building && r().bodies.length === 0, 'extrude undone')
    record(r().features.length === 1, 'Reverse feature undo rebuilds the earlier CAD model')
    await travel(true)
    await wait(() => !r().building && r().bodies.length > 0, 'extrude redone')
    record(r().features.length === 2, 'Reverse feature redo rebuilds the solid body')

    // Alignment also carries the CAD sketch frames. They must move once,
    // even though their restoration and rebuild are driven by React effects.
    const origin = r().features[0].frame.origin[0]
    shell.getState().setWorkspace('elements')
    await pause()
    click('start-manual'); await pause()
    const move = document.querySelector('[data-test="manual-mx"]')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(move, '3')
    move.dispatchEvent(new Event('input', { bubbles: true })); await pause()
    click('apply-manual')
    await wait(() => !m().busy && !r().building && r().features[0].frame.origin[0] === origin + 3, 'CAD aligned')
    await travel()
    await wait(() => !r().building, 'CAD alignment undone')
    record(r().features[0].frame.origin[0] === origin, 'alignment undo carries existing CAD sketches back exactly once')
    await travel(true)
    await wait(() => !r().building, 'CAD alignment redone')
    record(r().features[0].frame.origin[0] === origin + 3, 'alignment redo carries existing CAD sketches forward exactly once')

    // Undo after saving rebuilds the CAD model, and redo back to the saved
    // state leaves the project clean.
    const dirty = () => {
      const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event)
      return event.defaultPrevented
    }
    {
      click('save-project')
      await wait(() => window.savedProject && !m().busy, 'project saved')
      record(!dirty(), 'saving marks the project with CAD features saved')
      await travel()
      record(dirty(), 'undo after saving marks the project dirty')
      await wait(() => !r().building, 'saved CAD undo rebuilt')
      await travel(true)
      await wait(() => !r().building, 'saved CAD redo rebuilt')
      record(!dirty(), 'redo back to the saved document clears its dirty flag')
    }
    return results
  })
  for (const { ok, name } of checks) check(ok, name)
} catch (error) { fail(error.stack ?? error.message) }
await finish(browser, consoleErrors)

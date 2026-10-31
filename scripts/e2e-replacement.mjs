// SPDX-License-Identifier: AGPL-3.0-only
// Replacement decisions must precede any mutation of sources, geometry,
// measurements or history. Exercise the real drop handler and import queue.
import { launchApp, check, fail, finish } from './e2e-lib.mjs'

const { browser, page, consoleErrors } = await launchApp()
try {
  const results = await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.ts')
    const { useFlat } = await import('/src/state/flatStore.ts')
    const { useDeviation } = await import('/src/state/deviationStore.ts')
    const { useShell } = await import('/src/state/shellStore.ts')
    const { useHistory, historyAction, clearHistory } = await import('/src/state/historyStore.ts')
    const { commandHost } = await import('/src/commands/host.ts')
    const { runCommand } = await import('/src/commands/registry.ts')
    const { registerCoreCommands } = await import('/src/commands/core.ts')
    registerCoreCommands()
    const { session } = commandHost()
    const results = []
    const record = (ok, name) => results.push({ ok: !!ok, name })
    const pause = () => new Promise((r) => setTimeout(r, 30))
    const settle = async () => {
      // Let the async file/drop handoff enqueue before inspecting the queue.
      await pause()
      for (let i = 0; i < 600; i++) {
        if (!session.imports.busy && !useStore.getState().busy && !useFlat.getState().imageBusy) return
        await pause()
      }
      throw new Error('Replacement did not settle')
    }
    const drop = async (file) => {
      const dataTransfer = new DataTransfer()
      dataTransfer.items.add(file)
      window.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }))
      await settle()
    }
    const mesh = 'v 0 0 0\nv 10 0 0\nv 0 10 0\nf 1 2 3\n'
    const scan = (name) => new File([mesh], name)
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 32
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 32, 32)
    const png = await new Promise((resolve) => canvas.toBlob(resolve))
    let confirmations = 0, accept = false
    const originalConfirm = window.confirm
    window.confirm = () => { confirmations++; return accept }
    const snapshot = () => ({
      scan: session.sources.current.scan, reference: session.sources.current.reference, image: session.sources.current.image,
      scanVersion: session.clientRef.current.scanVersion, nominalVersion: session.clientRef.current.nominalVersion,
      elements: useStore.getState().elements, draft: useStore.getState().draft,
      flatElements: useFlat.getState().elements, imageVersion: useFlat.getState().imageVersion,
      align: useDeviation.getState().align, probes: useDeviation.getState().probes,
      past: useHistory.getState().past, future: useHistory.getState().future,
    })
    const same = (a, b) => Object.keys(a).every((key) => a[key] === b[key])
    const point = { id: 1, kind: 'point', name: 'Keep me', color: '#ff8800', visible: true, status: 'done', source: { type: 'picked' },
      fit: { kind: 'point', center: [1, 2, 0], sigma: 0, usedPoints: 1, regionSize: 1 } }
    try {
      await drop(scan('original.obj'))
      record(confirmations === 0, 'an empty session imports without a replacement question')
      historyAction('Make a measurement', () => useStore.setState({ elements: [point], nextId: 2 }))
      record(useHistory.getState().past.length > 0, 'the fixture has actual undo history')
      let before = snapshot()
      await drop(scan('cancelled.obj'))
      record(confirmations === 1 && same(before, snapshot()), 'Cancel preserves scan bytes, worker geometry, measurements and undo/redo')
      // Continue diagnostics even on a broken build.
      if (!same(before, snapshot())) useStore.setState({ elements: [point] })
      before = snapshot(); confirmations = 0
      await drop(new File([png], 'cancelled.png'))
      record(confirmations === 1 && same(before, snapshot()), 'Cancel image import preserves existing work and history across workspaces')
      useShell.getState().setWorkspace('deviation')
      useDeviation.getState().setSource('reference')
      before = snapshot(); confirmations = 0
      await drop(scan('cancelled-reference.obj'))
      record(confirmations === 1 && same(before, snapshot()), 'Cancel reference import preserves sources, comparison state and history')

      accept = true; confirmations = 0
      useShell.getState().setWorkspace('elements')
      await drop(scan('accepted.obj'))
      record(confirmations === 1 && useStore.getState().fileName === 'accepted.obj' && useStore.getState().elements.length === 0,
        'an accepted scan replacement prompts once and commits the new scan')
      record(useHistory.getState().past.length === 0 && useHistory.getState().future.length === 0,
        'accepted replacement starts fresh history')
      historyAction('Make another measurement', () => useStore.setState({ elements: [point] }))
      before = snapshot(); confirmations = 0
      await drop(new File(['not a mesh'], 'broken.obj'))
      record(confirmations === 1 && same(before, snapshot()) && !!useStore.getState().errorText,
        'a confirmed but malformed replacement remains transactional')

      // A queued import must decide against the state when it runs, not when
      // the file first arrives. Only a draft exists in this case.
      useStore.setState({ elements: [], errorText: null }); clearHistory()
      accept = false; confirmations = 0
      let release
      const held = session.imports.run(() => new Promise((resolve) => { release = resolve }))
      await pause()
      const queued = drop(scan('queued.obj'))
      await pause()
      useStore.getState().startDraft('point')
      useStore.getState().setDraftPicks([[1, 2, 0]])
      before = snapshot()
      release(); await held; await queued
      record(confirmations === 1 && same(before, snapshot()), 'queued replacement protects a draft created before it reaches the queue head')
      useStore.getState().cancelDraft()

      // Agent scan.open has its own explicit discard contract: no browser
      // prompt may replace that refusal or duplicate an accepted command.
      useStore.setState({ elements: [point] }); confirmations = 0
      const bytes = new TextEncoder().encode(mesh)
      const refusal = await runCommand('scan.open', { bytes, name: 'agent-refused.obj' }).then(() => null, (e) => e.code)
      record(refusal === 'invalid_state' && confirmations === 0 && useStore.getState().elements.length === 1,
        'agent scan.open still refuses measurements without discard and never prompts')
      const opened = await runCommand('scan.open', { bytes, name: 'agent-accepted.obj', discard: true })
      record(opened.scan?.fileName === 'agent-accepted.obj' && confirmations === 0 && useStore.getState().fileName === 'agent-accepted.obj',
        'agent discard authorizes exactly one replacement without a duplicate browser question')

      // Opening a project without one of its plugins retains that plugin's
      // data for saving again. A new scan must not silently throw it away.
      const { blankManifest } = await import('/src/app/project.ts')
      const { keepUnownedParts, keptParts } = await import('/src/app/projectSections.ts')
      keepUnownedParts({ ...blankManifest('test'), futurePlugin: { features: [{ id: 1 }] } }, new Map())
      const kept = keptParts()
      before = snapshot(); confirmations = 0; accept = false
      await drop(scan('plugin-data-loss.obj'))
      record(confirmations === 1 && same(before, snapshot()) && keptParts() === kept,
        'Cancel protects retained project data when its plugin is absent')
    } finally { window.confirm = originalConfirm }
    return results
  })
  for (const r of results) check(r.ok, r.name)
} catch (e) { fail(e.stack ?? String(e)) }
finally { await finish(browser, consoleErrors) }

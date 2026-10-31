// SPDX-License-Identifier: AGPL-3.0-only
// Tiny malicious headers, rejected before expansion. Unit tests run the old
// readers behind a guarded allocator; this real-UI check runs only with guards.
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'
import { check, fail, finish, launchApp } from './e2e-lib.mjs'

const MODEL = '3D/3dmodel.model', TEXTURE = '3D/Textures/skin.png'
function oversized(name) {
  const bytes = zipSync({ [name]: strToU8('<model/>') })
  const view = new DataView(bytes.buffer)
  const directory = view.getUint32(bytes.length - 22 + 16, true)
  view.setUint32(directory + 24, 0x7fffffff, true)
  view.setUint32(22, 0x7fffffff, true)
  return bytes
}
const { browser, page, consoleErrors } = await launchApp()
page.on('dialog', (dialog) => dialog.accept())
const drop = (bytes, name) => page.evaluate((data, name) => {
  const transfer = new DataTransfer()
  transfer.items.add(new File([Uint8Array.from(data)], name))
  window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }))
}, Array.from(bytes), name)
try {
  await drop(strToU8('v 0 0 0\nv 10 0 0\nv 0 10 0\nf 1 2 3\n'), 'keep.obj')
  await page.waitForFunction(() => /1 triangles/.test(document.querySelector('.file-info')?.textContent ?? ''))
  await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.ts')
    const { useHistory, historyAction } = await import('/src/state/historyStore.ts')
    const { commandHost } = await import('/src/commands/host.ts')
    historyAction('Make a measurement', () => useStore.setState({ elements: [{
      id: 1, kind: 'point', name: 'Keep me', color: '#ff8800', visible: true, status: 'done', source: { type: 'picked' },
      fit: { kind: 'point', center: [1, 2, 0], sigma: 0, usedPoints: 1, regionSize: 1 },
    }], nextId: 2 }))
    useStore.getState().startDraft('plane'); useStore.getState().setDraftPicks([[1, 2, 0]])
    window.__archiveSnapshot = () => ({
      source: commandHost().session.sources.current.scan,
      geometry: commandHost().session.sceneRef.current.scanGeometry(),
      workerVersion: commandHost().session.clientRef.current.scanVersion,
      elements: useStore.getState().elements, draft: useStore.getState().draft,
      past: useHistory.getState().past, future: useHistory.getState().future,
    })
    window.__archiveBefore = window.__archiveSnapshot()
  })
  check(await page.evaluate(() => window.__archiveBefore.past.length > 0), 'the fixture has a measurement, picked draft and undo history')
  const saved = await page.evaluate(async () => {
    const { commandHost } = await import('/src/commands/host.ts')
    const result = await commandHost().project.save()
    if ('error' in result) throw new Error(result.error)
    return Array.from(result.bytes)
  })
  const project = unzipSync(Uint8Array.from(saved))
  const manifest = JSON.parse(strFromU8(project['project.json']))
  delete project[manifest.scan.member]
  manifest.scan.fileName = 'oversized.3mf'; manifest.scan.member = 'scan.3mf'
  project['scan.3mf'] = oversized(MODEL)
  project['project.json'] = strToU8(JSON.stringify(manifest))
  for (const [name, bytes] of [
    ['oversized-model.3mf', oversized(MODEL)], ['oversized-texture.3mf', oversized(TEXTURE)],
    ['nested-oversized.scanruler', zipSync(project)],
  ]) {
    await page.evaluate(async () => (await import('/src/state/store.ts')).useStore.setState({ errorText: null }))
    await drop(bytes, name)
    await page.waitForFunction(async () => {
      const { useStore } = await import('/src/state/store.ts')
      const { commandHost } = await import('/src/commands/host.ts')
      return !useStore.getState().busy && !commandHost().session.imports.busy && /expanded.*archive.*limit/.test(useStore.getState().errorText ?? '')
    })
    check(await page.evaluate(() => {
      const after = window.__archiveSnapshot()
      return Object.keys(after).every((key) => after[key] === window.__archiveBefore[key])
    }), `${name}: rejection preserves source, scene, worker mesh, measurement, draft and undo/redo`)
    check(await page.$eval('.toast', (el) => /Reduce or split/.test(el.textContent)), `${name}: the visible error explains how to recover`)
  }
} catch (error) { fail(error.stack ?? String(error)) }
finally { await finish(browser, consoleErrors) }

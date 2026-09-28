// SPDX-License-Identifier: AGPL-3.0-only
// Real IndexedDB transactions, page reloads and the production restore path.
import { launchApp, check, fail, finish, shotPath } from './e2e-lib.mjs'

const { browser, page, consoleErrors } = await launchApp()
page.on('dialog', (dialog) => dialog.accept())
const status = () => page.$eval('[data-test="project-save-status"]', (el) => el.textContent)
const waitStatus = (text) => page.waitForFunction((value) => document.querySelector('[data-test="project-save-status"]')?.textContent.includes(value), {}, text)
try {
  await page.evaluate(async () => {
    const { useShell } = await import('/src/state/shellStore.ts')
    useShell.getState().setWorkspace('flat')
  })
  check(await page.evaluate(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true }))), 'switching workspaces in an empty session does not warn on exit')
  await page.evaluate(async () => {
    const { useShell } = await import('/src/state/shellStore.ts')
    useShell.getState().setWorkspace('elements')
  })
  await page.evaluate(async () => {
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(new File(['v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'], 'recovery.obj'))
    window.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }))
  })
  await waitStatus('Local checkpoint saved')
  check((await status()).includes('Unsaved changes'), 'import is dirty even after a local checkpoint')
  check(await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true }))), 'unsaved work prevents unloading')

  await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.ts')
    useStore.setState({ showBackfaces: false })
  })
  await page.waitForFunction(async () => {
    const { RecoveryStorage } = await import('/src/app/recoveryStorage.ts')
    const db = new RecoveryStorage()
    try { const rows = await db.list(); return rows.length && !(await db.read(rows[0].id)).manifest.scan.showBackfaces }
    finally { db.close() }
  })
  await page.reload({ waitUntil: 'networkidle0' })
  await page.waitForSelector('[data-test="recovery-bar"]')
  await page.screenshot({ path: shotPath('recovery.png') })
  check(await page.$eval('[data-test="recovery-bar"]', (el) => el.textContent.includes('recovery.obj')), 'reload offers the previous checkpoint without loading it automatically')
  await page.click('[data-test="restore-checkpoint"]')
  await page.waitForFunction(async () => {
    const { useStore } = await import('/src/state/store.ts')
    return !useStore.getState().busy && useStore.getState().fileName === 'recovery.obj'
  })
  check(await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.ts')
    const s = useStore.getState()
    return s.triangleCount === 1 && s.showBackfaces === false
  }), 'recovery restores original geometry and the latest project settings')
  await waitStatus('Unsaved changes')
  check(true, 'restored work stays dirty until explicitly downloaded')

  await page.evaluate(() => { HTMLAnchorElement.prototype.click = function () {} })
  await page.click('[data-test="save-project"]')
  await waitStatus('No unsaved changes')
  check(await page.evaluate(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true }))), 'successful Save Project clears the leave-page warning')
  await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.ts')
    useStore.setState({ statusText: 'transient progress', hoveredId: null })
  })
  check((await status()).includes('No unsaved changes'), 'transient status updates do not dirty the project')
  await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.ts')
    useStore.setState({ showBackfaces: true })
  })
  await waitStatus('Unsaved changes')
  check(true, 'editing a saved project makes it dirty again')

  await page.evaluate(async () => {
    const { ProjectClient } = await import('/src/core/project/projectClient.ts')
    const { useStore } = await import('/src/state/store.ts')
    const pack = ProjectClient.prototype.pack
    ProjectClient.prototype.pack = async function (...args) {
      ProjectClient.prototype.pack = pack
      const bytes = await pack.apply(this, args)
      useStore.setState({ showBackfaces: false })
      return bytes
    }
    document.querySelector('[data-test="save-project"]').click()
  })
  await page.waitForFunction(async () => !(await import('/src/state/store.ts')).useStore.getState().busy)
  await waitStatus('Unsaved changes')
  check(true, 'edits made during project packing are not marked as downloaded')
  await page.click('[data-test="save-project"]')
  await waitStatus('No unsaved changes')
  // The empty box Add dimension leaves open for the next one is a kind in
  // hand, not work; one with a slot filled is.
  await page.evaluate(async () => {
    const { useFlat } = await import('/src/state/flatStore.ts')
    useFlat.getState().startDimDraft()
  })
  check(await page.evaluate(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true }))), 'an empty dimension box does not warn')
  await page.evaluate(async () => (await import('/src/state/flatStore.ts')).useFlat.getState().setDimRef(0, 1))
  check(await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true }))), 'unfinished drafts warn immediately, even with a saved project')
  await page.evaluate(async () => (await import('/src/state/flatStore.ts')).useFlat.getState().cancelDimDraft())
  await waitStatus('No unsaved changes')

  // Count only project serialization on the UI thread, excluding worker ZIP
  // encoding and test bookkeeping. Pointer/draft edits must not serialize the
  // completed project, and a checkpoint must reuse its earlier dirty check.
  await page.evaluate(() => {
    const stringify = JSON.stringify
    window.projectSerializations = 0
    window.restoreStringify = () => { JSON.stringify = stringify }
    JSON.stringify = function (value, ...args) {
      if (value?.app === 'ScanRuler' && value.schemaVersion === 1) window.projectSerializations++
      return stringify.call(JSON, value, ...args)
    }
  })
  try {
    await page.evaluate(async () => {
      const { useFlat } = await import('/src/state/flatStore.ts')
      useFlat.getState().startDimDraft()
      useFlat.getState().setDimRef(0, 1)
      for (let i = 0; i < 100; i++) useFlat.getState().setDimName(`Draft ${i}`)
      window.dispatchEvent(new Event('beforeunload', { cancelable: true }))
    })
    await waitStatus('Unsaved changes')
    await new Promise((resolve) => setTimeout(resolve, 2200))
    check(await page.evaluate(() => window.projectSerializations === 0), '100 draft edits and an unload check do not serialize the completed project')
    await page.evaluate(async () => (await import('/src/state/flatStore.ts')).useFlat.getState().cancelDimDraft())
    await waitStatus('No unsaved changes')
    check(await page.evaluate(async () => {
      const { useStore } = await import('/src/state/store.ts')
      window.previousNextId = useStore.getState().nextId
      useStore.setState({ nextId: window.previousNextId + 1 })
      return !window.dispatchEvent(new Event('beforeunload', { cancelable: true }))
    }), 'an edit invalidates the cached snapshot before the next scheduled dirty check')
    await waitStatus('Unsaved changes')
    await new Promise((resolve) => setTimeout(resolve, 2200))
    check(await page.evaluate(() => {
      const warned = !window.dispatchEvent(new Event('beforeunload', { cancelable: true }))
      return warned && window.projectSerializations === 1
    }), 'a persisted edit is serialized once across dirty checking, autosave and unloading')
  } finally {
    await page.evaluate(async () => {
      window.restoreStringify()
      delete window.restoreStringify
      const { useStore } = await import('/src/state/store.ts')
      if (window.previousNextId !== undefined) useStore.setState({ nextId: window.previousNextId })
    })
  }
  await waitStatus('No unsaved changes')

  await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.ts')
    const put = IDBObjectStore.prototype.put
    window.restoreRecoveryWrite = () => { IDBObjectStore.prototype.put = put }
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'checkpoints') throw new DOMException('Test quota exhausted', 'QuotaExceededError')
      return put.apply(this, args)
    }
    useStore.setState((s) => ({ showBackfaces: true, nextId: s.nextId + 1 }))
  })
  await waitStatus('Local recovery unavailable')
  await page.evaluate(() => { window.restoreRecoveryWrite(); delete window.restoreRecoveryWrite })
  await page.click('[data-test="save-project"]')
  await waitStatus('No unsaved changes')
  check(true, 'storage failure is visible and manual project saving still works')

  const results = await page.evaluate(async () => {
    const { RecoveryStorage } = await import('/src/app/recoveryStorage.ts')
    const { collectProject, emptySources } = await import('/src/app/project.ts')
    const manifest = collectProject(emptySources(), null, 'test').manifest
    const a = new RecoveryStorage(), b = new RecoveryStorage()
    const members = [{ name: 'scan.obj', bytes: new Uint8Array([1, 2, 3]) }]
    const results = []
    try {
      await a.write(manifest, members)
      let sourceWrites = 0
      const put = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === 'sources') sourceWrites++
        return put.apply(this, args)
      }
      try { await a.write({ ...manifest, workspace: 'flat' }, members) }
      finally { IDBObjectStore.prototype.put = put }
      results.push([sourceWrites === 0, 'measurement-only checkpoints reuse stored source bytes'])
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === 'checkpoints') throw new DOMException('Test quota exhausted', 'QuotaExceededError')
        return put.apply(this, args)
      }
      let rejected = false
      try { await a.write(manifest, members) }
      catch { rejected = true }
      finally { IDBObjectStore.prototype.put = put }
      results.push([rejected && (await a.read(a.id)).manifest.workspace === 'flat', 'failed writes preserve the last complete checkpoint atomically'])
      await b.write(manifest, [])
      results.push([(await a.read(a.id)).members.length === 1 && (await b.read(b.id)).members.length === 0, 'independent tabs use independent recovery slots'])
      await b.remove(a.id)
      await a.write(manifest, members)
      results.push([(await a.read(a.id)).members[0].bytes[2] === 3, 'a discarded active slot recreates its sources on the next edit'])
      await a.remove(a.id)
      results.push([!(await a.list()).some((row) => row.id === a.id), 'discard removes checkpoint metadata and contents'])
    } finally { await a.remove(a.id); await b.remove(b.id); a.close(); b.close() }
    return results
  })
  for (const [ok, name] of results) check(ok, name)

  await page.reload({ waitUntil: 'networkidle0' })
  await page.waitForSelector('[data-test="recovery-bar"]')
  const before = await page.$$eval('[data-test="recovery-bar"] option', (options) => options.length)
  await page.click('[data-test="discard-checkpoint"]')
  await page.waitForFunction((count) => document.querySelectorAll('[data-test="recovery-bar"] option').length === count - 1, {}, before)
  check(true, 'the recovery prompt can discard a selected checkpoint')
} catch (error) {
  fail(error.stack ?? String(error))
  console.log('Save status:', await status())
}
await finish(browser, consoleErrors)

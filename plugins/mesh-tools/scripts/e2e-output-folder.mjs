// SPDX-License-Identifier: AGPL-3.0-only
// UI-only: run against the static production build, with no /src or local writer.
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate'
import { check, fail, finish, launchApp, shotPath } from '../../../scripts/e2e-lib.mjs'

const { browser, page, consoleErrors } = await launchApp()
const requests = []
page.on('request', (request) => { requests.push(new URL(request.url()).pathname) })
page.on('dialog', (dialog) => dialog.accept())
await page.evaluateOnNewDocument(() => {
  window.folderChoices = []
  window.saveChoices = []
  window.downloads = []
  window.folderMode = 'save'
  window.showDirectoryPicker = async ({ id }) => {
    if (!navigator.userActivation.isActive) throw new Error('Folder picker lost user activation')
    if (window.folderMode === 'cancel') throw new DOMException('Cancelled', 'AbortError')
    window.folderChoices.push(id)
    const root = await navigator.storage.getDirectory()
    if (window.consumeFolderActivation) {
      Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { isActive: false } })
    }
    return root.getDirectoryHandle(id === 'scanruler-exports' ? 'Sample Exports' : 'Sample Projects', { create: true })
  }
  const query = FileSystemDirectoryHandle.prototype.queryPermission
  const request = FileSystemDirectoryHandle.prototype.requestPermission
  FileSystemDirectoryHandle.prototype.queryPermission = function (options) {
    return this.name === 'Sample Exports' && window.denyExports ? Promise.resolve('denied') : query.call(this, options)
  }
  FileSystemDirectoryHandle.prototype.requestPermission = function (options) {
    return this.name === 'Sample Exports' && window.denyExports ? Promise.resolve('denied') : request.call(this, options)
  }
  window.showSaveFilePicker = async ({ suggestedName, startIn }) => {
    if (!navigator.userActivation.isActive) throw new Error('Save picker lost user activation')
    window.saveChoices.push({ name: suggestedName, folder: startIn.name })
    if (window.cancelSave) throw new DOMException('Cancelled', 'AbortError')
    return startIn.getFileHandle(window.saveName ?? suggestedName, { create: true })
  }
  const create = FileSystemFileHandle.prototype.createWritable
  FileSystemFileHandle.prototype.createWritable = async function (...args) {
    const stream = await create.apply(this, args)
    if (!window.failWrite && !window.holdWrite) return stream
    return {
      async write(blob) {
        if (window.failWrite) throw new Error('Test disk full')
        await stream.write(blob)
      },
      async close() {
        if (window.holdWrite) await new Promise((resolve) => { window.completeWrite = resolve })
        await stream.close()
      },
      async abort() { await stream.abort() },
    }
  }
  HTMLAnchorElement.prototype.click = function () { window.downloads.push(this.download) }
})
const drop = async (data, name) => page.evaluate((contents, filename) => {
  const transfer = new DataTransfer()
  transfer.items.add(new File([typeof contents === 'string' ? contents : new Uint8Array(contents)], filename))
  window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }))
}, data, name)
const status = () => page.$eval('footer', (node) => node.textContent)
const files = (kind) => page.evaluate(async (name) => {
  const root = await navigator.storage.getDirectory()
  return Array.fromAsync((await root.getDirectoryHandle(name)).keys())
}, kind === 'project' ? 'Sample Projects' : 'Sample Exports')
try {
  await page.reload({ waitUntil: 'networkidle0' })
  await page.click('[data-test="open-settings"]')
  await page.click('[data-test="choose-project-folder"]')
  await page.waitForFunction(() => document.querySelector('[data-test="project-folder-name"]').textContent === 'Sample Projects')
  await page.click('[data-test="choose-export-folder"]')
  await page.waitForFunction(() => document.querySelector('[data-test="export-folder-name"]').textContent === 'Sample Exports')
  check(true, 'production Settings selects separate project and export folders from user clicks')
  await (await page.$('[data-test="output-folders"]')).screenshot({ path: shotPath('hosted-output-folders.png') })
  await page.evaluate(() => { window.folderMode = 'cancel' })
  await page.click('[data-test="choose-project-folder"]')
  await page.waitForFunction(() => document.body.textContent.includes('Folder selection cancelled'))
  check(await page.$eval('[data-test="project-folder-name"]', (node) => node.textContent) === 'Sample Projects',
    'cancelled folder changes keep the previous project destination')
  await page.evaluate(() => { window.folderMode = 'save' })
  await page.click('[data-test="settings-close"]')
  await drop('v 0 0 0\nv 10 0 0\nv 0 10 0\nf 1 2 3\n', 'sample.obj')
  await page.waitForFunction(() => document.querySelector('.file-info')?.textContent.includes('1 triangles'))
  const nameInput = await page.$('input[placeholder="Untitled project"]')
  await nameInput.click({ clickCount: 3 })
  await nameInput.type('Sample Bracket')
  await page.click('[data-test="save-project"]')
  await page.waitForFunction(() => document.body.textContent.includes('Project saved: Sample Bracket-001.scanruler'))
  await page.waitForFunction(() => document.querySelector('[data-test="project-save-status"]')?.textContent.includes('No unsaved changes'))
  check((await files('project')).includes('Sample Bracket-001.scanruler'), 'hosted save writes a padded editable project to the project folder')
  await page.evaluate(() => { window.cancelSave = true })
  await page.click('[data-test="save-project"]')
  await page.waitForFunction(() => document.body.textContent.includes('Save cancelled.'))
  check(!(await files('project')).includes('Sample Bracket-002.scanruler'), 'cancelled Save As writes no next revision')
  await page.evaluate(() => { window.cancelSave = false })
  const bytes = await page.evaluate(async () => {
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('Sample Projects')
    return Array.from(new Uint8Array(await (await directory.getFileHandle('Sample Bracket-001.scanruler')).getFile().then((file) => file.arrayBuffer())))
  })
  const archive = unzipSync(Uint8Array.from(bytes))
  const manifest = JSON.parse(strFromU8(archive['project.json']))
  manifest.scan.elements = [{
    id: 1, kind: 'point', name: 'Sample point', color: '#ff0000', visible: true, status: 'done',
    source: { type: 'picked' }, fit: { kind: 'point', center: [1, 2, 0], sigma: 0, usedPoints: 1, regionSize: 1 },
  }]
  manifest.scan.nextId = 2
  archive['project.json'] = strToU8(JSON.stringify(manifest))
  const fixture = Array.from(zipSync(archive))
  await drop(fixture, 'Sample Bracket-001.scanruler')
  await page.waitForFunction(() => document.querySelector('[data-test="export-step"]')?.disabled === false)
  await page.evaluate(() => { window.holdWrite = true })
  await page.click('[data-test="export-step"]')
  await page.waitForFunction(() => typeof window.completeWrite === 'function')
  check(!(await status()).includes('Saved to Sample Exports'), 'hosted export does not report saved before its write closes')
  await page.evaluate(() => { window.holdWrite = false; window.completeWrite() })
  await page.waitForFunction(() => document.body.textContent.includes('Saved to Sample Exports'))
  const step = await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('Sample Exports')
    const names = await Array.fromAsync(dir.keys())
    return (await (await dir.getFileHandle(names[0])).getFile()).text()
  })
  check(step.startsWith('ISO-10303-21;') && step.includes('Sample point'), 'production STEP output contains actual geometry in the independent export folder')
  await page.click('[data-test="export-step"]')
  await page.waitForFunction(() => document.body.textContent.includes('-2.step'))
  check((await files('export')).length === 2, 'export collisions create new filenames without overwriting')
  check((await files('project')).every((name) => name.endsWith('.scanruler')), 'exports never enter the project folder')
  await page.evaluate(() => { window.failWrite = true })
  await page.click('[data-test="export-cloud"]')
  await page.waitForFunction(() => document.body.textContent.includes('Test disk full'))
  check(await page.evaluate(() => window.downloads.length) === 0, 'write failures are explicit and never silently download')
  await page.evaluate(() => { window.failWrite = false; window.denyExports = true })
  await page.click('[data-test="export-step"]')
  await page.waitForFunction(() => document.body.textContent.includes('Write permission for the saved export folder was not granted'))
  check(await page.evaluate(() => window.downloads.length) === 0, 'denied export permission does not silently download')
  await page.evaluate(() => { window.denyExports = false })
  await page.reload({ waitUntil: 'networkidle0' })
  await page.click('[data-test="open-settings"]')
  await page.waitForFunction(() => document.querySelector('[data-test="export-folder-name"]').textContent === 'Sample Exports')
  check(await page.$eval('[data-test="project-folder-name"]', (node) => node.textContent) === 'Sample Projects',
    'reload restores both real persisted directory handles independently')
  await page.click('[data-test="settings-close"]')
  await drop(fixture, 'Sample Bracket-001.scanruler')
  await page.waitForFunction(() => document.querySelector('[data-test="export-step"]')?.disabled === false)
  await page.click('[data-test="save-project"]')
  await page.waitForFunction(() => document.body.textContent.includes('Sample Bracket-002.scanruler'))
  check((await files('project')).includes('Sample Bracket-002.scanruler'), 'reopened project continues its padded revision sequence after reload')
  await page.click('[data-test="export-cloud"]')
  await page.waitForFunction(() => document.body.textContent.includes('Saved to Sample Exports'))
  check(await page.evaluate(() => window.folderChoices.length) === 0, 'post-reload saves and exports reuse folders without reselecting them')
  await page.evaluate(() => { window.showDirectoryPicker = undefined })
  await page.click('[data-test="export-step"]')
  await page.waitForFunction(() => window.downloads.length > 0)
  check(true, 'unsupported browser retains normal export downloads')
  await page.click('[data-test="save-project"]')
  await page.waitForFunction(() => window.downloads.some((name) => name.endsWith('.scanruler')))
  check(true, 'unsupported browser retains normal project downloads')
  await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('scanruler-output')
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('Output storage is still open'))
  }))
  await page.reload({ waitUntil: 'networkidle0' })
  await drop(fixture, 'Sample Bracket-001.scanruler')
  await page.waitForFunction(() => document.querySelector('[data-test="export-step"]')?.disabled === false)
  await page.evaluate(() => { window.folderMode = 'cancel' })
  await page.click('[data-test="export-step"]')
  await page.waitForFunction(() => document.body.textContent.includes('Export cancelled. No file was written.'))
  check(await page.evaluate(() => window.downloads.length) === 0, 'cancelling the first export-folder picker never starts a download')
  await page.evaluate(() => { window.folderMode = 'save'; window.consumeFolderActivation = true })
  const before = (await files('project')).length
  await page.click('[data-test="save-project"]')
  await page.waitForFunction(() => document.body.textContent.includes('Project folder ready. Click Save again'))
  check((await files('project')).length === before, 'initial folder selection explicitly requests a second Save click when activation is consumed')
  await page.evaluate(() => { delete navigator.userActivation })
  await page.click('[data-test="save-project"]')
  await page.waitForFunction(() => document.body.textContent.includes('Project saved: Sample Bracket-003.scanruler'))
  check((await files('project')).includes('Sample Bracket-003.scanruler'), 'the next user click opens Save As and saves after first-time folder setup')
  check(!requests.some((path) => path.startsWith('/__scanruler/') || path.startsWith('/src/')),
    'static production workflow makes no local-writer or source-module requests')
} catch (error) { fail(error.stack ?? String(error)) }
finally { await finish(browser, consoleErrors) }

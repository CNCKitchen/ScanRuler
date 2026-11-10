// SPDX-License-Identifier: AGPL-3.0-only
// Public UI against dist/: picker doubles check app options, not OS history.
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate'
import { check, fail, finish, launchApp } from './e2e-lib.mjs'

const { browser, page, consoleErrors } = await launchApp()
const requests = []
page.on('request', (request) => { requests.push(new URL(request.url()).pathname) })
page.on('dialog', (dialog) => dialog.accept())
await page.evaluateOnNewDocument(() => {
  window.saveChoices = []
  window.downloads = []
  window.showDirectoryPicker = () => { throw new Error('No directory chooser should be used') }
  window.showSaveFilePicker = async (options) => {
    if (!navigator.userActivation.isActive) throw new Error('Save picker lost user activation')
    if ('startIn' in options) throw new Error('App must not override browser location history')
    window.saveChoices.push(options)
    if (window.cancelSave) throw new DOMException('Cancelled', 'AbortError')
    if (window.denySave) throw new DOMException('Test access denied', 'NotAllowedError')
    const key = `test-picker-${options.id}`
    const folder = window.nextFolder ?? sessionStorage.getItem(key) ?? `${options.id}-initial`
    sessionStorage.setItem(key, folder)
    const name = window.nextName ?? options.suggestedName
    window.nextFolder = window.nextName = undefined
    const root = await navigator.storage.getDirectory()
    const directory = await root.getDirectoryHandle(folder, { create: true })
    const file = await directory.getFileHandle(name, { create: true })
    return {
      name,
      async createWritable() {
        const stream = await file.createWritable()
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
      },
    }
  }
  HTMLAnchorElement.prototype.click = function () { window.downloads.push(this.download) }
})
const drop = async (data, name) => page.evaluate((contents, filename) => {
  const transfer = new DataTransfer()
  transfer.items.add(new File([typeof contents === 'string' ? contents : new Uint8Array(contents)], filename))
  window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }))
}, data, name)
const readFile = (folder, name) => page.evaluate(async (dir, filename) => {
  const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle(dir)
  return Array.from(new Uint8Array(await (await directory.getFileHandle(filename)).getFile().then((file) => file.arrayBuffer())))
}, folder, name)
const saved = (name) => page.waitForFunction((filename) => document.querySelector('footer')?.textContent.includes(`Project saved: ${filename}`), {}, name)
const choose = async (folder, name) => page.evaluate((dir, filename) => {
  window.nextFolder = dir
  window.nextName = filename
}, folder, name)
try {
  await page.reload({ waitUntil: 'networkidle0' })
  await page.click('[data-test="open-settings"]')
  check(await page.$('[data-test="output-folders"]') === null, 'no fixed-folder Settings controls')
  await page.click('[data-test="settings-close"]')
  await drop('v 0 0 0\nv 10 0 0\nv 0 10 0\nf 1 2 3\n', 'sample.obj')
  await page.waitForFunction(() => document.querySelector('.file-info')?.textContent.includes('1 triangles'))
  const nameInput = await page.$('input[placeholder="Untitled project"]')
  await nameInput.focus()
  await nameInput.evaluate((node) => node.select())
  await nameInput.type('Sample Bracket')
  await choose('Sample Projects', 'Working copy.scanruler')
  await page.click('[data-test="save-project"]')
  await saved('Working copy.scanruler')
  const bytes = await readFile('Sample Projects', 'Working copy.scanruler')
  const archive = unzipSync(Uint8Array.from(bytes))
  check(JSON.parse(strFromU8(archive['project.json'])).name === 'Sample Bracket',
    'one Save click writes an editable project with the manually selected filename')
  check(await page.evaluate(() => window.saveChoices[0].suggestedName) === 'Sample Bracket.scanruler',
    'project suggestion keeps the normal filename, without automatic numbering')

  await choose('Another Project Folder', 'Moved copy.scanruler')
  await page.click('[data-test="save-project"]')
  await saved('Moved copy.scanruler')
  await page.click('[data-test="save-project"]')
  await saved('Sample Bracket.scanruler')
  check((await readFile('Another Project Folder', 'Sample Bracket.scanruler')).length > 0,
    'changing folders through Save As is not overridden on the next save')
  await page.evaluate(() => { window.cancelSave = true })
  const before = await page.evaluate(() => window.saveChoices.length)
  await page.click('[data-test="save-project"]')
  await page.waitForFunction(() => document.querySelector('footer')?.textContent.includes('Save cancelled.'))
  check(await page.evaluate(() => window.saveChoices.length) === before + 1, 'cancelling Save As ends the operation without a second picker')
  await page.evaluate(() => { window.cancelSave = false })

  const manifest = JSON.parse(strFromU8(archive['project.json']))
  manifest.scan.elements = [{
    id: 1, kind: 'point', name: 'Sample point', color: '#ff0000', visible: true, status: 'done',
    source: { type: 'picked' }, fit: { kind: 'point', center: [1, 2, 0], sigma: 0, usedPoints: 1, regionSize: 1 },
  }]
  manifest.scan.nextId = 2
  archive['project.json'] = strToU8(JSON.stringify(manifest))
  const fixture = Array.from(zipSync(archive))
  await drop(fixture, 'Working copy.scanruler')
  await page.waitForFunction(() => document.querySelector('[data-test="export-step"]')?.disabled === false)
  await choose('Sample Exports', 'Chosen export.step')
  await page.evaluate(() => { window.holdWrite = true })
  await page.click('[data-test="export-step"]')
  await page.waitForFunction(() => typeof window.completeWrite === 'function')
  check(!(await page.$eval('footer', (node) => node.textContent)).includes('Saved as Chosen export'),
    'export success waits for the selected file write to close')
  await page.evaluate(() => { window.holdWrite = false; window.completeWrite() })
  await page.waitForFunction(() => document.querySelector('footer')?.textContent.includes('Saved as Chosen export.step'))
  const step = new TextDecoder().decode(Uint8Array.from(await readFile('Sample Exports', 'Chosen export.step')))
  check(step.startsWith('ISO-10303-21;') && step.includes('Sample point'), 'selected export file contains actual STEP geometry')
  check(!(await page.$eval('footer', (node) => node.textContent)).includes('Sample Bracket-elements.step'),
    'export status uses the chosen filename, not the original suggestion')
  await choose('Another Export Folder', 'Cloud.ply')
  await page.click('[data-test="export-cloud"]')
  await page.waitForFunction(() => document.querySelector('footer')?.textContent.includes('Saved as Cloud.ply'))
  await page.click('[data-test="export-step"]')
  await page.waitForFunction(() => document.querySelector('footer')?.textContent.includes('Saved as Sample Bracket-elements.step'))
  check((await readFile('Another Export Folder', 'Sample Bracket-elements.step')).length > 0,
    'different export formats share one location history, including folder changes')
  await page.click('[data-test="save-project"]')
  await saved('Sample Bracket.scanruler')
  check((await readFile('Another Project Folder', 'Sample Bracket.scanruler')).length > 0,
    'exports do not change the separate project location history')

  await page.evaluate(() => { window.cancelSave = true })
  await page.click('[data-test="export-step"]')
  await page.waitForFunction(() => document.querySelector('footer')?.textContent.includes('Export cancelled.'))
  check(await page.evaluate(() => window.downloads.length) === 0, 'cancelled export never silently downloads')
  await page.evaluate(() => { window.cancelSave = false; window.denySave = true })
  await page.click('[data-test="export-step"]')
  await page.waitForFunction(() => document.querySelector('footer')?.textContent.includes('Test access denied'))
  check(await page.evaluate(() => window.downloads.length) === 0, 'picker permission errors are explicit, not download fallbacks')
  await page.evaluate(() => { window.denySave = false; window.failWrite = true })
  await page.click('[data-test="export-cloud"]')
  await page.waitForFunction(() => document.querySelector('footer')?.textContent.includes('Test disk full'))
  check(await page.evaluate(() => window.downloads.length) === 0, 'failed export writes never silently download')
  // Change project content so a failed save must leave the session dirty.
  await nameInput.focus()
  await nameInput.evaluate((node) => node.select())
  await nameInput.type('Unsaved Bracket')
  await page.keyboard.press('Tab')
  await page.waitForFunction(() => !document.querySelector('[data-test="project-save-status"]')?.textContent.includes('No unsaved changes'))
  await page.click('[data-test="save-project"]')
  await page.waitForFunction(() => document.querySelector('footer')?.textContent.includes('Test disk full'))
  await page.waitForFunction(() => !document.querySelector('[data-test="project-save-status"]')?.textContent.includes('No unsaved changes'))
  check(await page.$eval('[data-test="project-save-status"]', (node) => !node.textContent.includes('No unsaved changes')),
    'failed project writes leave changes unsaved')
  await page.evaluate(() => { window.failWrite = false; window.holdWrite = true; window.completeWrite = undefined })
  await page.click('[data-test="save-project"]')
  await page.waitForFunction(() => typeof window.completeWrite === 'function')
  check(await page.$eval('[data-test="project-save-status"]', (node) => !node.textContent.includes('No unsaved changes')),
    'project remains unsaved while the write is pending')
  await page.evaluate(() => { window.holdWrite = false; window.completeWrite() })
  await saved('Unsaved Bracket.scanruler')
  await page.waitForFunction(() => document.querySelector('[data-test="project-save-status"]')?.textContent.includes('No unsaved changes'))

  await page.reload({ waitUntil: 'networkidle0' })
  await drop(fixture, 'Working copy.scanruler')
  await page.waitForFunction(() => document.querySelector('[data-test="export-step"]')?.disabled === false)
  await page.click('[data-test="save-project"]')
  await saved('Sample Bracket.scanruler')
  await page.click('[data-test="export-step"]')
  await page.waitForFunction(() => document.querySelector('footer')?.textContent.includes('Saved as Sample Bracket-elements.step'))
  check(await page.evaluate(() => window.saveChoices.map((o) => o.id).join(',')) === 'scanruler-projects,scanruler-exports',
    'reload reuses stable independent picker IDs, without app-held directory handles')
  check(await page.evaluate(() => window.saveChoices.every((o) => !('startIn' in o))), 'no picker forces a fixed startIn directory')
  await page.evaluate(() => { window.showSaveFilePicker = undefined })
  await page.click('[data-test="export-step"]')
  await page.waitForFunction(() => window.downloads.length > 0)
  await page.click('[data-test="save-project"]')
  await page.waitForFunction(() => window.downloads.some((name) => name.endsWith('.scanruler')))
  check(true, 'unsupported browsers retain ordinary project and export downloads')
  check(!requests.some((path) => path.startsWith('/__scanruler/') || path.startsWith('/src/')),
    'static production workflow makes no local-writer or source-module requests')
} catch (error) { fail(error.stack ?? String(error)) }
finally { await finish(browser, consoleErrors) }

// SPDX-License-Identifier: AGPL-3.0-only
// Public UI against production: no dependency on the save-location contribution.
import { unzipSync, strFromU8 } from 'fflate'
import { check, fail, finish, launchApp } from './e2e-lib.mjs'

const { browser, page, consoleErrors } = await launchApp()
const requests = []
page.on('request', (request) => { requests.push(new URL(request.url()).pathname) })
page.on('dialog', (dialog) => dialog.accept())
await page.evaluateOnNewDocument(() => {
  window.downloads = []
  const blobs = new Map()
  const createURL = URL.createObjectURL
  URL.createObjectURL = (blob) => {
    const url = createURL(blob)
    blobs.set(url, blob)
    return url
  }
  HTMLAnchorElement.prototype.click = function () {
    if (window.failDownload) throw new Error('Test download dispatch failed')
    window.downloads.push({ name: this.download, blob: blobs.get(this.href) })
  }
  window.showSaveFilePicker = window.showDirectoryPicker = () => { throw new Error('Numbering must not require a location picker') }
})
const drop = async (data, name) => page.evaluate((contents, filename) => {
  const transfer = new DataTransfer()
  transfer.items.add(new File([typeof contents === 'string' ? contents : new Uint8Array(contents)], filename))
  window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }))
}, data, name)
const rename = async (name) => {
  const input = await page.$('[data-test="project-name"]')
  await input.focus()
  await input.evaluate((node) => node.select())
  await input.type(name)
  await page.keyboard.press('Tab')
}
const save = async (name) => {
  const before = await page.evaluate(() => window.downloads.length)
  await page.click('[data-test="save-project"]')
  await page.waitForFunction((count, filename) => window.downloads.length === count + 1
    && window.downloads.at(-1).name === filename
    && document.querySelector('footer')?.textContent.includes(`Project saved: ${filename}`), {}, before, name)
}
try {
  await page.reload({ waitUntil: 'networkidle0' })
  const mesh = 'v 0 0 0\nv 10 0 0\nv 0 10 0\nf 1 2 3\n'
  await drop(mesh, 'sample.obj')
  await page.waitForFunction(() => document.querySelector('.file-info')?.textContent.includes('1 triangles'))
  await rename('Sample Bracket')
  await save('Sample Bracket-001.scanruler')
  await save('Sample Bracket-002.scanruler')
  check(await page.evaluate(() => window.downloads.map((d) => d.name).join(',')) === 'Sample Bracket-001.scanruler,Sample Bracket-002.scanruler',
    'successive saves suggest minimum-three-digit revision names without choosing a folder')
  const bytes = await page.evaluate(async () => Array.from(new Uint8Array(await window.downloads[0].blob.arrayBuffer())))
  const archive = unzipSync(Uint8Array.from(bytes))
  const manifest = JSON.parse(strFromU8(archive['project.json']))
  check(manifest.name === 'Sample Bracket' && strFromU8(archive[manifest.scan.member]) === mesh,
    'numbered download remains an editable project with unchanged original mesh bytes')
  await drop(bytes, 'Manual copy-9.scanruler')
  await page.waitForFunction(() => document.querySelector('footer')?.textContent.includes('Project opened'))
  await save('Manual copy-010.scanruler')
  check(true, 'opening a manually named unpadded revision continues its filename, not the embedded project title')
  await drop(bytes, 'Manual copy-099.scanruler')
  await page.waitForFunction(() => document.querySelector('footer')?.textContent.includes('Project opened'))
  await save('Manual copy-100.scanruler')
  check(true, 'opening revision 099 continues with 100')
  await drop(bytes, 'Manual copy-999.scanruler')
  await page.waitForFunction(() => document.querySelector('footer')?.textContent.includes('Project opened'))
  await save('Manual copy-1000.scanruler')
  check(true, 'revision names continue past 999')

  await rename('Other-2026')
  await page.waitForFunction(() => !document.querySelector('[data-test="project-save-status"]')?.textContent.includes('No unsaved changes'))
  await page.evaluate(() => { window.failDownload = true })
  const before = await page.evaluate(() => window.downloads.length)
  await page.click('[data-test="save-project"]')
  await page.waitForFunction(() => document.querySelector('footer')?.textContent.includes('Test download dispatch failed'))
  await page.waitForFunction(() => !document.querySelector('[data-test="project-save-status"]')?.textContent.includes('No unsaved changes'))
  check(await page.evaluate(() => window.downloads.length) === before, 'failed download dispatch does not mark the project saved or record a revision')
  await page.evaluate(() => { window.failDownload = false })
  await save('Other-2026-001.scanruler')
  check(true, 'retry after a failed dispatch uses 001; digits in a new project title are retained')
  await save('Other-2026-002.scanruler')
  await page.waitForFunction(() => document.querySelector('[data-test="project-save-status"]')?.textContent.includes('No unsaved changes'))
  check(true, 'successful download dispatch marks the saved snapshot clean')
  await drop(bytes, 'Manual copy-9.scanruler')
  await page.waitForFunction(() => document.querySelector('footer')?.textContent.includes('Project opened'))
  await save('Manual copy-010.scanruler')
  check(true, 'opening an older file deliberately follows its revision, not higher files elsewhere')

  await page.click('[data-test="new-project"]')
  await page.waitForFunction(() => document.querySelector('footer')?.textContent.includes('New project.'))
  await drop(mesh, 'sample.obj')
  await page.waitForFunction(() => document.querySelector('.file-info')?.textContent.includes('1 triangles'))
  await rename('Sample Bracket')
  await save('Sample Bracket-001.scanruler')
  check(true, 'New project resets filename history')
  await page.reload({ waitUntil: 'networkidle0' })
  await drop(bytes, 'Reopened-009.scanruler')
  await page.waitForFunction(() => document.querySelector('footer')?.textContent.includes('Project opened'))
  await save('Reopened-010.scanruler')
  check(true, 'reopening a saved file after reload restores its numbering basis')
  check(!requests.some((path) => path.startsWith('/src/') || path.startsWith('/__scanruler/')),
    'independent production numbering uses no source imports or local-server writer')
} catch (error) { fail(error.stack ?? String(error)) }
finally { await finish(browser, consoleErrors) }

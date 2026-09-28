// SPDX-License-Identifier: AGPL-3.0-only
// Public UI only: this must work against dist/, where /src imports do not exist.
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate'
import { launchApp, check, fail, finish } from './e2e-lib.mjs'

const { browser, page, consoleErrors } = await launchApp()
page.on('dialog', (dialog) => dialog.accept())
const mesh = 'v 0 0 0\nv 10 0 0\nv 0 10 0\nf 1 2 3\n'
const drop = async (contents, name) => page.evaluate((data, filename) => {
  const transfer = new DataTransfer()
  transfer.items.add(new File([typeof data === 'string' ? data : new Uint8Array(data)], filename))
  window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }))
}, contents, name)
try {
  const writerPattern = '/(?:exportStep|exportPointCloud|svg|dxf)-[^/]+\\.js$'
  const loadedWriters = () => page.evaluate((pattern) => performance.getEntriesByType('resource')
    .map((entry) => entry.name).filter((name) => new RegExp(pattern).test(name)), writerPattern)
  check((await loadedWriters()).length === 0, 'export writers are not downloaded when the built app starts')
  await drop(mesh, 'production.obj')
  await page.waitForFunction(() => document.querySelector('.file-info')?.textContent.includes('1 triangles'))
  await page.waitForFunction(() => !document.querySelector('[data-test="save-project"]').disabled)
  check(true, 'built app imports a mesh through its bundled worker')

  await page.evaluate(() => {
    const createURL = URL.createObjectURL
    URL.createObjectURL = (blob) => { window.savedProject = blob; return createURL(blob) }
    HTMLAnchorElement.prototype.click = function () {}
  })
  await page.click('[data-test="save-project"]')
  await page.waitForFunction(() => window.savedProject instanceof Blob)
  const bytes = await page.evaluate(async () => Array.from(new Uint8Array(await window.savedProject.arrayBuffer())))
  const archive = unzipSync(Uint8Array.from(bytes))
  const manifest = JSON.parse(strFromU8(archive['project.json']))
  check(manifest.scan.fileName === 'production.obj' && strFromU8(archive[manifest.scan.member]) === mesh,
    'built project worker downloads an archive containing the original mesh')

  await page.reload({ waitUntil: 'networkidle0' })
  await drop(bytes, 'roundtrip.scanruler')
  await page.waitForFunction(() => document.querySelector('.file-info')?.textContent.includes('production.obj'))
  await page.waitForFunction(() => !document.querySelector('[data-test="save-project"]').disabled)
  check(await page.$eval('.file-info', (el) => el.textContent.includes('1 triangles')),
    'built app reopens the downloaded project after a fresh page load')

  // Include known picked points in both workspaces, so export correctness is
  // independent of fitting tolerances and does not need a private scan fixture.
  manifest.scan.elements = [{ id: 1, kind: 'point', name: 'Export point', color: '#ff0000', visible: true,
    status: 'done', source: { type: 'picked' },
    fit: { kind: 'point', center: [1, 2, 0], sigma: 0, usedPoints: 1, regionSize: 1 } }]
  manifest.scan.nextId = 2
  const png = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 32
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 32, 32)
    ctx.fillStyle = 'black'; ctx.fillRect(8, 8, 16, 16)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve))
    return Array.from(new Uint8Array(await blob.arrayBuffer()))
  })
  archive['image.png'] = Uint8Array.from(png)
  manifest.flat.image = { member: 'image.png', fileName: 'drawing.png' }
  const point = { id: 1, kind: 'point', name: 'Sheet point', color: '#111111', visible: true, error: null,
    source: { type: 'picks', method: 'flat-point-pick', picks: [[1, 2]] },
    fit: { kind: 'point', at: [1, 2], sigma: 0, usedPoints: 1 } }
  for (const sheet of [manifest.flat, manifest.flat.sheets.image]) {
    sheet.elements = [point]
    sheet.nextId = 2
  }
  archive['project.json'] = strToU8(JSON.stringify(manifest))
  await drop(Array.from(zipSync(archive)), 'export-fixture.scanruler')
  await page.waitForFunction(() => document.querySelector('[data-test="export-step"]')?.disabled === false)
  await page.waitForFunction(() => !document.querySelector('[data-test="save-project"]').disabled)
  await page.evaluate(() => {
    const createURL = URL.createObjectURL
    URL.createObjectURL = (blob) => { window.exportBlob = blob; return createURL(blob) }
    HTMLAnchorElement.prototype.click = function () {}
  })
  const downloadText = async (selector) => {
    await page.evaluate(() => { window.exportBlob = null })
    await page.click(selector)
    await page.waitForFunction(() => window.exportBlob instanceof Blob)
    return page.evaluate(() => window.exportBlob.text())
  }
  const step = await downloadText('[data-test="export-step"]')
  check(step.includes('ISO-10303-21;') && step.includes('Export point'), 'on-demand STEP writer exports the picked point')
  const cloud = await downloadText('[data-test="export-cloud"]')
  check(cloud.startsWith('ply\n') && cloud.includes('element vertex 3'), 'on-demand point-cloud writer exports all three vertices')
  await page.click('[data-test="workspace-flat"]')
  await page.waitForFunction(() => document.querySelector('[data-test="flat-export-svg"]')?.disabled === false)
  const svg = await downloadText('[data-test="flat-export-svg"]')
  check(svg.includes('<svg') && svg.includes('Sheet point'), 'on-demand SVG writer exports the sheet')
  const dxf = await downloadText('[data-test="flat-export-dxf"]')
  check(dxf.includes('AC1015') && dxf.includes('Sheet point'), 'on-demand DXF writer exports the sheet')
  check((await loadedWriters()).length === 4, 'each export writer loads only when requested')
} catch (error) { fail(error.stack ?? String(error)) }
finally { await finish(browser, consoleErrors) }

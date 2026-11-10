// SPDX-License-Identifier: AGPL-3.0-only
import { check, finish, launchApp } from '../../../scripts/e2e-lib.mjs'
import { openReverse } from '../../reverse/scripts/lib.mjs'

const { browser, page, consoleErrors } = await launchApp()
try {
  const first = await page.evaluate(async () => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/150.0.0.0' })
    const root = await navigator.storage.getDirectory()
    const directory = await root.getDirectoryHandle('output-folder-test', { create: true })
    window.showDirectoryPicker = async () => directory
    const { projectOutputDirectory, writeProjectRevision } = await import('/src/app/projectRevisions.ts')
    const selected = await projectOutputDirectory()
    return writeProjectRevision(selected, 'Persisted', new Uint8Array([1, 2, 3]))
  })
  check(first === 'Persisted-001.scanruler', 'the first selection writes a three-digit numbered revision')
  await page.reload({ waitUntil: 'networkidle0' })
  const second = await page.evaluate(async () => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/150.0.0.0' })
    window.showDirectoryPicker = async () => { throw new Error('The folder picker must not reopen.') }
    const { projectOutputDirectory, writeProjectRevision } = await import('/src/app/projectRevisions.ts')
    return writeProjectRevision(await projectOutputDirectory(), 'Persisted', new Uint8Array([4, 5, 6]))
  })
  check(second === 'Persisted-002.scanruler', 'reload restores the actual directory handle without selecting a folder again')
  await page.click('[data-test="new-project"]')
  const retained = await page.evaluate(async () => {
    const { projectOutputDirectory } = await import('/src/app/projectRevisions.ts')
    return (await projectOutputDirectory()).name === 'output-folder-test'
  })
  check(retained, 'starting a new project retains the selected output folder')
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/150.0.0.0 Edg/150.0.0.0' })
    window.showDirectoryPicker = async () => { throw new Error('Windows Save As must not ask for a folder first.') }
    window.localOutputRequests = []
    window.fetch = async (input, options) => {
      window.localOutputRequests.push({ url: String(input), method: options?.method })
      if (String(input).includes('?choose=')) return Response.json({ token: 'native-selection', name: 'Renamed.scanruler', directory: 'D:\\Other' })
      if (options?.method === 'POST') return new Response('Disk full', { status: 500 })
      return Response.json({ name: 'C:\\Local\\Mods', names: [] })
    }
  })
  const local = await page.evaluate(async () => {
    const { chooseProjectSave, projectOutputDirectory, rememberOutputDirectory } = await import('/src/app/projectRevisions.ts')
    rememberOutputDirectory(null)
    const directory = await projectOutputDirectory()
    const target = await chooseProjectSave(directory, 'Roof')
    try { await target.write(new Uint8Array([1])) }
    catch (error) {
      return { name: directory.name, path: target.path, message: error.message, retained: directory === await projectOutputDirectory(), requests: window.localOutputRequests }
    }
    throw new Error('Expected the disk-full response to fail.')
  })
  check(local.name === 'C:\\Local\\Mods' && local.message.includes('Disk full') && local.retained,
    'local Windows browsers use the configured local writer without a folder picker, surface errors, and retain the folder')
  check(local.path === 'D:\\Other\\Renamed.scanruler' &&
    local.requests.some((r) => r.method === 'POST' && r.url.includes('choose=Roof-001.scanruler')) &&
    local.requests.some((r) => r.method === 'POST' && r.url.includes('selection=native-selection')),
    'local Windows browsers honor renamed/moved native selections and upload only with their authorization token')
  await page.evaluate(() => {
    window.__nativeExports = []
    window.__nativeWrites = []
    window.__nativeMode = 'save'
    window.fetch = async (input, options) => {
      const url = new URL(String(input), location.origin)
      if (url.pathname !== '/__scanruler/output') throw new Error(`Unexpected request: ${input}`)
      if (url.searchParams.has('choose')) {
        window.__nativeExports.push({ name: url.searchParams.get('choose'), kind: url.searchParams.get('kind') })
        if (window.__nativeMode === 'cancel') return new Response(null, { status: 204 })
        if (window.__nativeMode === 'error') return new Response('Export folder unavailable', { status: 500 })
        return Response.json({ token: 'export-selection', name: url.searchParams.get('choose'), directory: 'D:\\Exports' })
      }
      if (url.searchParams.get('selection') === 'export-selection') {
        window.__nativeWrites.push({ text: await options.body.text(), size: options.body.size })
        return new Response(null, { status: 201 })
      }
      throw new Error(`Unapproved write: ${input}`)
    }
    URL.createObjectURL = () => { throw new Error('Native exports must not silently download.') }
  })
  const native = await page.evaluate(async () => {
    const { saveBuilt, runExport } = await import('/src/app/exports.ts')
    const { projectOutputDirectory } = await import('/src/app/projectRevisions.ts')
    const { useStore } = await import('/src/state/store.ts')
    const before = await projectOutputDirectory()
    for (const extension of ['step', 'stp', 'stl', '3mf', 'ply', 'xyz', 'csv', 'svg', 'dxf']) {
      await runExport(async () => saveBuilt({ name: `Export.${extension}`, bytes: new TextEncoder().encode(extension), mimeType: 'application/octet-stream', status: 'Export complete.' }))
    }
    const status = useStore.getState().statusText
    window.__nativeMode = 'cancel'
    await runExport(async () => saveBuilt({ name: 'Cancel.csv', bytes: new Uint8Array([1]), mimeType: 'text/csv', status: 'Must not report success' }))
    const cancelled = useStore.getState().statusText
    window.__nativeMode = 'error'
    await runExport(async () => saveBuilt({ name: 'Error.svg', bytes: new Uint8Array([1]), mimeType: 'image/svg+xml', status: 'Must not report success' }))
    const error = useStore.getState().errorText
    window.__nativeMode = 'save'
    return { selected: window.__nativeExports, writes: window.__nativeWrites, status, cancelled, error, sameProjectFolder: before === await projectOutputDirectory() }
  })
  check(native.selected.length === 11 && native.selected.every((s) => s.kind === 'export') && native.writes.length === 9,
    'every supported format uses export Save As and only approved selections write bytes')
  check(native.sameProjectFolder && native.status.includes('D:\\Exports\\Export.dxf'),
    'export status reports the chosen path without changing the remembered project folder')
  check(native.cancelled.includes('cancelled') && native.error.includes('Export folder unavailable'),
    'cancel and failed export dialogs are explicit and never fall back to Downloads')
  await openReverse(page)
  await page.evaluate(async () => {
    const { runCommand } = await import('/src/commands/registry.ts')
    await runCommand('reverse.feature.add', { feature: { kind: 'sketch', name: 'Export profile', plane: { kind: 'world', axis: 'z' }, sketch: { entities: [{ id: 1, kind: 'circle', c: [0, 0], r: 10 }] } } })
    await runCommand('reverse.feature.add', { feature: { kind: 'extrude', name: 'Native export solid', sketchId: 'Export profile', regions: 'all', extent: { kind: 'distance', from: 0, to: 5 }, op: 'new' } })
  })
  await page.click('[data-test=export-body-step]')
  await page.waitForFunction(() => /exported to D:\\Exports\\.*as a STEP solid/.test(window.__re.measure.getState().statusText))
  check(await page.evaluate(() => window.__nativeWrites.at(-1).text.startsWith('ISO-10303-21;')),
    'the actual Reverse engineer STEP button awaits the native writer and reports the saved location')
  await page.evaluate(() => { window.__nativeMode = 'cancel' })
  await page.click('[data-test=export-body-step]')
  await page.waitForFunction(() => /STEP export cancelled/.test(window.__re.measure.getState().statusText))
  check(!await page.$eval('[data-test=export-body-step]', (e) => e.disabled),
    'cancelling native STEP Save As releases the button without a success claim')
  await page.evaluate(async () => {
    const { runCommand } = await import('/src/commands/registry.ts')
    window.__nativeMode = 'save'
    const fetch = window.fetch
    window.fetch = async (input, options) => {
      if (window.__holdMeshWrite && String(input).includes('selection=export-selection')) {
        await new Promise((resolve) => { window.__releaseMeshWrite = resolve })
      }
      return fetch(input, options)
    }
    window.__holdMeshWrite = true
  })
  const exportBodyMesh = async (format) => {
    await page.click('[data-test=export-body-mesh]')
    await page.click(`[data-test=export-body-mesh-${format}]`)
  }
  await exportBodyMesh('stl')
  await page.waitForFunction(() => typeof window.__releaseMeshWrite === 'function')
  check(await page.evaluate(() => !/bodies? exported to/.test(window.__re.measure.getState().statusText)),
    'CAD mesh export does not claim success while the native write is pending')
  await page.evaluate(() => { window.__holdMeshWrite = false; window.__releaseMeshWrite() })
  await page.waitForFunction(() => /body exported to D:\\Exports\\.*\.stl/.test(window.__re.measure.getState().statusText))
  check(await page.evaluate(() => window.__nativeWrites.at(-1).size > 84),
    'the actual CAD STL button awaits the native write and reports its saved path')
  await page.evaluate(() => { window.__nativeMode = 'cancel' })
  const beforeCancel = await page.evaluate(() => window.__nativeWrites.length)
  await exportBodyMesh('3mf')
  await page.waitForFunction(() => /Mesh export cancelled/.test(window.__re.measure.getState().statusText))
  check(await page.evaluate(() => window.__nativeWrites.length) === beforeCancel,
    'cancelling CAD mesh Save As writes nothing and does not claim success')
  await page.evaluate(() => { window.__nativeMode = 'error' })
  await exportBodyMesh('stl')
  await page.waitForFunction(() => /Mesh export failed:.*Export folder unavailable/.test(window.__re.measure.getState().errorText ?? ''))
  check(await page.evaluate(() => window.__nativeWrites.length) === beforeCancel,
    'CAD mesh native-writer errors are reported without an unhandled rejection or a download')
  const meshExports = await page.evaluate(async () => {
    const { editedCopy } = await import('/plugins/mesh-tools/state/editedCopy.ts')
    const { buildBinaryPly } = await import('/plugins/mesh-tools/core/plyWriter.ts')
    const { exportEditedMesh } = await import('/plugins/mesh-tools/app/exportEdited.ts')
    const { useStore } = await import('/src/state/store.ts')
    const { rememberOutputDirectory } = await import('/src/app/projectRevisions.ts')
    const previous = editedCopy.current
    const fileName = useStore.getState().fileName
    const initial = window.__nativeExports.length
    try {
      useStore.setState({ fileName: 'Export test.ply' })
      editedCopy.current = {
        source: { name: 'Export test.ply', bytes: buildBinaryPly(Float32Array.from([0, 0, 0, 10, 0, 0, 0, 10, 0]), Uint32Array.from([0, 1, 2])) },
        map: Int32Array.from([0, 1, 2]),
      }
      window.__nativeMode = 'save'
      await exportEditedMesh('stl')
      await exportEditedMesh('3mf')
      const selected = window.__nativeExports.slice(initial)
      Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'X11; Linux x86_64' })
      let written = 0
      rememberOutputDirectory({
        name: 'Browser mesh folder',
        async *keys() {},
        async getFileHandle() {
          return { async createWritable() { return { async write(blob) { written = blob.size }, async close() {}, async abort() {} } } }
        },
      })
      await exportEditedMesh('stl')
      window.showDirectoryPicker = undefined
      let downloaded = false
      URL.createObjectURL = () => 'blob:isolated-edited-export'
      HTMLAnchorElement.prototype.click = function () { downloaded = this.download.endsWith('.stl') }
      await exportEditedMesh('stl')
      return { selected, written, downloaded, extraNativeRequests: window.__nativeExports.length - initial - selected.length }
    } finally {
      editedCopy.current = previous
      useStore.setState({ fileName })
    }
  })
  check(meshExports.selected.length === 2 && meshExports.selected.every((s) => s.kind === 'export') &&
    meshExports.selected[0].name.endsWith('.stl') && meshExports.selected[1].name.endsWith('.3mf'),
    'edited STL and 3MF exports use the shared native export dialog rather than project Save')
  check(meshExports.written > 0 && meshExports.extraNativeRequests === 0,
    'non-Windows edited exports retain their existing browser-directory flow')
  check(meshExports.downloaded, 'edited exports retain browser downloads when directory access is unavailable')
} catch (error) {
  consoleErrors.push(error.stack ?? error.message)
} finally {
  await finish(browser, consoleErrors)
}

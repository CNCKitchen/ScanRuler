// SPDX-License-Identifier: AGPL-3.0-only
import { check, fail, finish, launchApp } from '../../../scripts/e2e-lib.mjs'
import { openReverse } from '../../reverse/scripts/lib.mjs'

const { browser, page, consoleErrors } = await launchApp()
try {
  await page.evaluate(async () => {
    window.exportFiles = {}
    window.failExport = false
    window.showDirectoryPicker = async () => ({
      name: 'Sample Exports',
      async *keys() { yield* Object.keys(window.exportFiles) },
      async getFileHandle(name) {
        return {
          async createWritable() {
            let pending
            return {
              async write(blob) {
                if (window.failExport) throw new Error('Test export folder unavailable')
                pending = blob
              },
              async close() { window.exportFiles[name] = pending },
              async abort() { pending = undefined },
            }
          },
        }
      },
    })
    const { rememberOutputDirectory } = await import('/src/app/projectRevisions.ts')
    rememberOutputDirectory({ name: 'Sample Projects', async *keys() {}, async getFileHandle() { throw new Error('Exports must not write to Projects') } })
  })
  await openReverse(page)
  await page.evaluate(async () => {
    const { runCommand } = await import('/src/commands/registry.ts')
    await runCommand('reverse.feature.add', { feature: { kind: 'sketch', name: 'Export profile', plane: { kind: 'world', axis: 'z' }, sketch: { entities: [{ id: 1, kind: 'circle', c: [0, 0], r: 10 }] } } })
    await runCommand('reverse.feature.add', { feature: { kind: 'extrude', name: 'Export solid', sketchId: 'Export profile', regions: 'all', extent: { kind: 'distance', from: 0, to: 5 }, op: 'new' } })
  })
  await page.click('[data-test="export-body-step"]')
  await page.waitForFunction(() => /exported to Sample Exports\\.*as a STEP solid/.test(window.__re.measure.getState().statusText))
  check(await page.evaluate(async () => {
    const name = Object.keys(window.exportFiles).find((key) => key.endsWith('.step'))
    return (await window.exportFiles[name].text()).startsWith('ISO-10303-21;')
  }), 'Reverse engineer STEP button writes valid STEP content to the independent export folder')
  const exportMesh = async (format) => {
    await page.click('[data-test="export-body-mesh"]')
    await page.click(`[data-test="export-body-mesh-${format}"]`)
  }
  await exportMesh('stl')
  await page.waitForFunction(() => /exported to Sample Exports\\.*\.stl/.test(window.__re.measure.getState().statusText))
  check(await page.evaluate(() => Object.keys(window.exportFiles).some((name) => name.endsWith('.stl'))),
    'Reverse engineer mesh export uses the export folder, not the project folder')
  await page.evaluate(() => { window.failExport = true })
  await exportMesh('3mf')
  await page.waitForFunction(() => window.__re.measure.getState().errorText?.includes('Test export folder unavailable'))
  check(await page.evaluate(() => window.__re.measure.getState().errorText.includes('Test export folder unavailable')),
    'CAD export write failures are explicit rather than claiming success')
  await page.evaluate(() => { window.failExport = false })
  const edited = await page.evaluate(async () => {
    const { editedCopy } = await import('/plugins/mesh-tools/state/editedCopy.ts')
    const { buildBinaryPly } = await import('/plugins/mesh-tools/core/plyWriter.ts')
    const { exportEditedMesh } = await import('/plugins/mesh-tools/app/exportEdited.ts')
    const { useStore } = await import('/src/state/store.ts')
    const { projectOutputDirectory } = await import('/src/app/projectRevisions.ts')
    const previous = editedCopy.current
    const fileName = useStore.getState().fileName
    try {
      useStore.setState({ fileName: 'Sample.ply' })
      editedCopy.current = {
        source: { name: 'Sample.ply', bytes: buildBinaryPly(Float32Array.from([0, 0, 0, 10, 0, 0, 0, 10, 0]), Uint32Array.from([0, 1, 2])) },
        map: Int32Array.from([0, 1, 2]),
      }
      await exportEditedMesh('stl')
      await exportEditedMesh('3mf')
      return {
        names: Object.keys(window.exportFiles),
        status: useStore.getState().statusText,
        project: (await projectOutputDirectory()).name,
      }
    } finally { editedCopy.current = previous; useStore.setState({ fileName }) }
  })
  check(edited.names.some((name) => /edited.*\.stl$/.test(name)) && edited.names.some((name) => /edited.*\.3mf$/.test(name)),
    'edited STL and 3MF exports both use the shared export folder')
  check(edited.project === 'Sample Projects' && edited.status.includes('Saved to Sample Exports'),
    'mesh exports report their destination without changing the remembered project folder')
} catch (error) { fail(error.stack ?? String(error)) }
finally { await finish(browser, consoleErrors) }

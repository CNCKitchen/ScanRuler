// SPDX-License-Identifier: AGPL-3.0-only
import { check, fail, finish, launchApp } from '../../../scripts/e2e-lib.mjs'
import { openReverse } from '../../reverse/scripts/lib.mjs'

const { browser, page, consoleErrors } = await launchApp()
try {
  await page.evaluate(async () => {
    window.exportFiles = {}
    window.failExport = false
    window.pickerChoices = []
    window.showSaveFilePicker = async (options) => {
      if (!navigator.userActivation.isActive) throw new Error('Export picker lost user activation')
      if (options.id !== 'scanruler-exports' || 'startIn' in options) throw new Error('Incorrect export picker options')
      window.pickerChoices.push(options)
      const name = options.suggestedName
      return {
        name,
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
    }
  })
  await openReverse(page)
  await page.evaluate(async () => {
    const { runCommand } = await import('/src/commands/registry.ts')
    await runCommand('reverse.feature.add', { feature: { kind: 'sketch', name: 'Export profile', plane: { kind: 'world', axis: 'z' }, sketch: { entities: [{ id: 1, kind: 'circle', c: [0, 0], r: 10 }] } } })
    await runCommand('reverse.feature.add', { feature: { kind: 'extrude', name: 'Export solid', sketchId: 'Export profile', regions: 'all', extent: { kind: 'distance', from: 0, to: 5 }, op: 'new' } })
  })
  await page.click('[data-test="export-body-step"]')
  await page.waitForFunction(() => /exported to .*as a STEP solid/.test(window.__re.measure.getState().statusText))
  check(await page.evaluate(async () => {
    const name = Object.keys(window.exportFiles).find((key) => key.endsWith('.step'))
    return (await window.exportFiles[name].text()).startsWith('ISO-10303-21;')
  }), 'Reverse engineer STEP button writes valid STEP content to the selected file')
  const exportMesh = async (format) => {
    await page.click('[data-test="export-body-mesh"]')
    await page.click(`[data-test="export-body-mesh-${format}"]`)
  }
  await exportMesh('stl')
  await page.waitForFunction(() => /exported to .*\.stl/.test(window.__re.measure.getState().statusText))
  check(await page.evaluate(() => Object.keys(window.exportFiles).some((name) => name.endsWith('.stl'))),
    'Reverse engineer mesh export writes the selected STL file')
  await page.evaluate(() => { window.failExport = true })
  await exportMesh('3mf')
  await page.waitForFunction(() => window.__re.measure.getState().errorText?.includes('Test export folder unavailable'))
  check(await page.evaluate(() => window.__re.measure.getState().errorText.includes('Test export folder unavailable')),
    'CAD export write failures are explicit rather than claiming success')
  await page.evaluate(() => { window.failExport = false })
  await page.evaluate(async () => {
    const { editedCopy } = await import('/plugins/mesh-tools/state/editedCopy.ts')
    const { buildBinaryPly } = await import('/plugins/mesh-tools/core/plyWriter.ts')
    const { exportEditedMesh } = await import('/plugins/mesh-tools/app/exportEdited.ts')
    const { useStore } = await import('/src/state/store.ts')
    useStore.setState({ fileName: 'Sample.ply' })
    editedCopy.current = {
      source: { name: 'Sample.ply', bytes: buildBinaryPly(Float32Array.from([0, 0, 0, 10, 0, 0, 0, 10, 0]), Uint32Array.from([0, 1, 2])) },
      map: Int32Array.from([0, 1, 2]),
    }
    window.testEditedExport = exportEditedMesh
    const button = document.createElement('button')
    button.id = 'test-edited-export'
    button.textContent = 'Export edited mesh'
    button.onclick = () => { window.editedPending = window.testEditedExport(window.editedFormat) }
    document.body.appendChild(button)
  })
  for (const format of ['stl', '3mf']) {
    await page.evaluate((value) => { window.editedFormat = value }, format)
    await page.click('#test-edited-export')
    await page.evaluate(() => window.editedPending)
  }
  check(await page.evaluate(() => ['stl', '3mf'].every((extension) => Object.keys(window.exportFiles).some((name) => name.endsWith(`edited.${extension}`)))),
    'edited STL and 3MF exports both select a file before building')
  check(await page.evaluate(() => window.pickerChoices.length === 5 && window.pickerChoices.every((options) => options.id === 'scanruler-exports')),
    'CAD and mesh formats share the export picker ID, without forcing a fixed folder')
} catch (error) { fail(error.stack ?? String(error)) }
finally { await finish(browser, consoleErrors) }

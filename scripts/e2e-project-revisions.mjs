// SPDX-License-Identifier: AGPL-3.0-only
import { unzipSync, strFromU8 } from 'fflate'
import { launchApp, captureProjectSaves, check, fail, finish, shotPath } from './e2e-lib.mjs'

const { browser, page, consoleErrors } = await launchApp()
await captureProjectSaves(page)
page.on('dialog', (dialog) => dialog.accept())
try {
  await page.evaluate(async () => {
    const data = new DataTransfer()
    data.items.add(new File(['v 0 0 0\nv 10 0 0\nv 0 10 0\nf 1 2 3\n'], 'revision.obj'))
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }))
  })
  await page.waitForFunction(() => document.querySelector('.file-info')?.textContent.includes('1 triangles'))
  await page.evaluate(async () => {
    const { rememberOutputDirectory } = await import('/src/app/projectRevisions.ts')
    const { useStore } = await import('/src/state/store.ts')
    useStore.setState({ projectName: 'Part' })
    window.revisionFiles = ['Part-9.scanruler', 'Part-010.scanruler']
    window.revisionSuggestions = []
    window.revisionWrites = []
    window.revisionMode = 'save'
    window.revisionDirectory = {
      name: 'Isolated project folder',
      async *keys() { yield* window.revisionFiles },
    }
    window.showSaveFilePicker = async ({ suggestedName: name }) => {
        window.revisionSuggestions.push(name)
        if (window.revisionMode === 'cancel') throw new DOMException('Cancelled', 'AbortError')
        await new Promise((resolve) => { window.approveRevision = resolve })
        const selected = window.revisionSelection ?? name
        return {
          name: selected,
          async createWritable() {
            let pending
            return {
              async write(blob) {
                if (window.revisionMode === 'fail') throw new Error('Test disk full')
                pending = blob
              },
              async close() {
                window.revisionFiles.push(selected)
                window.revisionWrites.push(selected)
                window.savedProject = pending
              },
              async abort() { pending = undefined },
            }
          },
        }
    }
    rememberOutputDirectory(window.revisionDirectory)
  })
  const dirty = () => page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  })
  const save = async (expected, selection) => {
    const count = await page.evaluate(() => window.revisionWrites.length)
    await page.evaluate((name) => {
      window.revisionSelection = name
      window.approveRevision = null
    }, selection)
    await page.click('[data-test="save-project"]')
    await page.waitForFunction(() => typeof window.approveRevision === 'function')
    check(await page.evaluate(() => window.revisionSuggestions.at(-1)) === expected, `Save As suggests ${expected}`)
    check(await page.evaluate(() => window.revisionWrites.length) === count, 'no bytes are written before approval')
    await page.evaluate(() => window.approveRevision())
    await page.waitForFunction(async () => {
      const { useTaskActivity } = await import('/src/state/taskActivity.ts')
      return !useTaskActivity.getState().tasks['project-save-dialog']
    })
  }
  await save('Part-011.scanruler')
  check(!await dirty(), 'successful write marks the project saved')
  const bytes = await page.evaluate(async () => Array.from(new Uint8Array(await window.savedProject.arrayBuffer())))
  const archive = unzipSync(Uint8Array.from(bytes))
  const manifest = JSON.parse(strFromU8(archive['project.json']))
  check(strFromU8(archive[manifest.scan.member]).includes('v 10 0 0'), 'numbered save retains original scan bytes')
  await save('Part-012.scanruler', 'Custom-9.scanruler')
  await save('Custom-010.scanruler')
  await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.ts')
    useStore.setState({ showBackfaces: !useStore.getState().showBackfaces })
    window.revisionMode = 'cancel'
  })
  const count = await page.evaluate(() => window.revisionWrites.length)
  await page.click('[data-test="save-project"]')
  await page.waitForFunction(() => document.body.textContent.includes('Save cancelled.'))
  check(await dirty() && await page.evaluate(() => window.revisionWrites.length) === count, 'cancel preserves dirty state and consumes no revision')
  await page.evaluate(() => { window.revisionMode = 'fail' })
  await save('Custom-011.scanruler', 'Failed rename.scanruler')
  check(await dirty() && await page.evaluate(() => window.revisionWrites.length) === count, 'failed write leaves changes unsaved')
  check(await page.evaluate(async () => (await import('/src/state/store.ts')).useStore.getState().errorText.includes('Test disk full')), 'write error is surfaced explicitly')
  await page.evaluate(() => { window.revisionMode = 'save' })
  await save('Custom-011.scanruler')
  await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.ts')
    useStore.setState({ projectName: 'New title' })
  })
  await save('New title-001.scanruler')
  await page.waitForFunction(() => document.querySelector('[data-test="project-save-status"]')?.textContent.includes('No unsaved changes'))
  await page.screenshot({ path: shotPath('project-revision-save.png') })
  await page.evaluate(() => {
    const data = new DataTransfer()
    data.items.add(new File([window.savedProject], 'New title-001.scanruler'))
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }))
  })
  await page.waitForFunction(() => document.body.textContent.includes('Project opened'))
  await save('New title-002.scanruler')
  check(true, 'reopened editable project continues its revision sequence')
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'X11; Linux x86_64' })
    window.showDirectoryPicker = undefined
    const createURL = URL.createObjectURL
    URL.createObjectURL = (blob) => { window.fallbackProject = blob; return createURL(blob) }
    HTMLAnchorElement.prototype.click = function () {}
  })
  await page.click('[data-test="save-project"]')
  await page.waitForFunction(() => window.fallbackProject instanceof Blob)
  check(true, 'browser without directory access retains normal project download')
} catch (error) {
  fail(error.stack ?? String(error))
} finally {
  await finish(browser, consoleErrors)
}

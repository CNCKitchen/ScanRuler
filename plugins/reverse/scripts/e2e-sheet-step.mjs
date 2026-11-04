// SPDX-License-Identifier: AGPL-3.0-only
// Run against an isolated dev server with APP_URL; no scan fixture needed.
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, click, finish, launchApp, sleep } from '../../../scripts/e2e-lib.mjs'
import { openReverse } from './lib.mjs'

const { browser, page, consoleErrors } = await launchApp({ protocolTimeout: 600_000 })
// This suite exercises browser downloads. Native export routing is covered
// separately by e2e-output-folder.
await page.evaluate(() => Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'X11; Linux x86_64' }))
await page.evaluateOnNewDocument(() => Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'X11; Linux x86_64' }))
let downloadDir = null
try {
  await openReverse(page)
  await page.evaluate(async () => {
    const { runCommand } = await import('/src/commands/registry.ts')
    await runCommand('reverse.feature.add', { feature: { kind: 'sketch', name: 'Profile', plane: { kind: 'world', axis: 'z' }, sketch: { entities: [{ id: 1, kind: 'line', a: [10, 20], b: [30, 20] }] } } })
    await runCommand('reverse.feature.add', { feature: { kind: 'sheet', name: 'Skin', sketchId: 'Profile', from: -5, to: 5 } })
    await runCommand('reverse.body.set', { body: 'Skin', name: 'Exported skin' })
    const original = URL.createObjectURL
    URL.createObjectURL = (blob) => {
      if (blob.type === 'model/step') window.__sheetStep = blob.text()
      return original(blob)
    }
  })
  const cdp = await browser.target().createCDPSession()
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' })
  check(!await page.$eval('[data-test=include-sheet-step]', (e) => e.checked), 'open sheets are excluded by default')
  check(await page.$eval('[data-test=export-body-step]', (e) => e.disabled), 'a sheet alone does not enable default STEP export')
  await click(page, '[data-test=include-sheet-step]')
  check(!await page.$eval('[data-test=export-body-step]', (e) => e.disabled), 'the opt-in enables sheet export')
  await page.evaluate(() => {
    const client = window.__re.session.client()
    window.__exportOriginal = client.exportStepChecked.bind(client)
    window.__exportCalls = 0
    client.exportStepChecked = (...args) => {
      window.__exportCalls++
      return new Promise((resolve) => { window.__releaseExport = () => resolve(window.__exportOriginal(...args)) })
    }
    const button = document.querySelector('[data-test=export-body-step]')
    button.click()
    button.click()
    button.click()
  })
  await page.waitForSelector('[data-test=step-export-status]')
  check(await page.$eval('[data-test=step-export-status]', (e) => /Preparing STEP for 1 visible body/.test(e.textContent)), 'progress appears beside the export button immediately')
  check(await page.$eval('[data-test=export-body-step]', (e) => e.disabled && /Exporting STEP/.test(e.textContent)), 'the button stays disabled while exporting')
  check(await page.$eval('[data-test=include-sheet-step]', (e) => e.disabled), 'export options stay fixed during an export')
  check(await page.evaluate(() => window.__exportCalls === 1), 'repeated same-tick clicks queue only one export')
  await page.evaluate(() => window.__releaseExport())
  await page.waitForFunction(() => Boolean(window.__sheetStep), { timeout: 120_000 })
  await page.waitForFunction(() => /Open Downloads/.test(document.querySelector('[data-test=step-export-status]')?.textContent ?? ''))
  const text = await page.evaluate(() => window.__sheetStep)
  check(text.startsWith('ISO-10303-21;') && text.includes('Exported skin'), 'the UI writes a STEP sheet under its body name')
  check(await page.$eval('[data-test=step-export-status]', (e) => /Ctrl\+J/.test(e.textContent) && /verification was not run/.test(e.textContent)), 'completion explains where the download went and does not claim verification')
  check(!await page.$eval('[data-test=export-body-step]', (e) => e.disabled), 'the button is available after completion')
  await page.evaluate(() => {
    window.__re.session.client().exportStepChecked = async () => { throw new Error('Deliberate export failure') }
  })
  await click(page, '[data-test=export-body-step]')
  await page.waitForFunction(() => /Deliberate export failure/.test(document.querySelector('[data-test=step-export-status]')?.textContent ?? ''))
  check(await page.$eval('[data-test=step-export-status]', (e) => e.getAttribute('role') === 'alert'), 'worker failures appear next to the button as an alert')
  check(!await page.$eval('[data-test=export-body-step]', (e) => e.disabled), 'failure releases the export lock')
  await page.evaluate(() => {
    window.__sheetStep = null
    window.__re.session.client().exportStepChecked = window.__exportOriginal
  })
  await click(page, '[data-test=export-body-step]')
  await page.waitForFunction(() => Boolean(window.__sheetStep), { timeout: 120_000 })
  await page.waitForFunction(() => /Open Downloads/.test(document.querySelector('[data-test=step-export-status]')?.textContent ?? ''))
  check(await page.evaluate(() => window.__re.measure.getState().errorText === null), 'a successful retry clears the previous error')
  const verified = await page.evaluate(async () => {
    const { runCommand } = await import('/src/commands/registry.ts')
    return runCommand('reverse.export.step', { bodies: ['Exported skin'], includeSheets: true, verify: true })
  })
  check(verified.verify.ok && verified.verify.parts === 1 && verified.verify.bodies[0].sheet, 'the real browser worker reads the sheet back intact')
  await click(page, '[data-test=include-sheet-step]')
  check(await page.$eval('[data-test=export-body-step]', (e) => e.disabled), 'turning the opt-in off restores the default')

  if (process.env.SHEET_STEP_PROJECT) {
    page.once('dialog', (dialog) => dialog.accept())
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.waitForSelector('[data-test=project-input]')
    await (await page.$('[data-test=project-input]')).uploadFile(process.env.SHEET_STEP_PROJECT)
    await page.waitForFunction(() => /Project opened/.test(document.querySelector('.strip')?.textContent ?? ''), { timeout: 240_000 })
    await openReverse(page)
    await page.waitForFunction(() => !window.__re.store.getState().building && window.__re.store.getState().bodies.length > 0, { timeout: 600_000 })
    const before = await page.evaluate(() => {
      const s = window.__re.store.getState()
      const visible = s.bodies.filter((b) => b.visible)
      return { features: s.features.length, visible: visible.length, faces: visible.reduce((n, b) => n + b.faces, 0), sheetsOnly: visible.every((b) => b.surface) }
    })
    console.log('saved-project export:', JSON.stringify(before))
    downloadDir = mkdtempSync(join(tmpdir(), 'scanruler-sheet-step-'))
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir })
    await page.evaluate(() => {
      const original = URL.createObjectURL
      window.__exportSizes = []
      URL.createObjectURL = (blob) => {
        if (blob.type === 'model/step') {
          window.__exportSizes.push(blob.size)
          window.__projectStep = blob.text()
        }
        return original(blob)
      }
    })
    await click(page, '[data-test=include-sheet-step]')
    for (let i = 0; i < 2; i++) {
      const started = Date.now()
      await click(page, '[data-test=export-body-step]')
      await page.waitForFunction((count) => window.__exportSizes.length === count && /Open Downloads/.test(document.querySelector('[data-test=step-export-status]')?.textContent ?? ''), { timeout: 360_000 }, i + 1)
      const deadline = Date.now() + 60_000
      while (readdirSync(downloadDir).filter((name) => name.endsWith('.step')).length < i + 1 && Date.now() < deadline) await sleep(200)
      check(readdirSync(downloadDir).filter((name) => name.endsWith('.step')).length === i + 1, `saved-project export ${i + 1} actually downloads to disk`)
      const downloaded = readdirSync(downloadDir).find((name) => name.endsWith('.step') && !/^export-\d+\.step$/.test(name))
      if (downloaded) renameSync(join(downloadDir, downloaded), join(downloadDir, `export-${i + 1}.step`))
      console.log(`saved-project export ${i + 1}: ${Date.now() - started} ms`)
    }
    const result = await page.evaluate(async () => {
      const text = await window.__projectStep
      return {
        sizes: window.__exportSizes,
        complete: text.trimEnd().endsWith('END-ISO-10303-21;'),
        millimetres: /SI_UNIT\(\s*\.MILLI\.\s*,\s*\.METRE\.\s*\)/.test(text),
        faces: (text.match(/ADVANCED_FACE\s*\(/g) ?? []).length,
        features: window.__re.store.getState().features.length,
        error: window.__re.measure.getState().errorText,
      }
    })
    console.log('saved-project result:', JSON.stringify(result))
    check(result.sizes.length === 2 && result.sizes[0] > 0 && result.sizes[0] === result.sizes[1], 'the saved project exports twice without a crash or changing file size')
    check(result.complete && result.millimetres && result.faces === before.faces, 'the large download is a complete millimetre STEP with every expected face')
    check(result.features === before.features && !result.error, 'large exports leave the feature tree unchanged and the page responsive')
    const downloads = readdirSync(downloadDir).filter((name) => name.endsWith('.step'))
    check(downloads.length === 2 && downloads.every((name, i) => statSync(join(downloadDir, name)).size === result.sizes[i] && readFileSync(join(downloadDir, name), 'utf8').trimEnd().endsWith('END-ISO-10303-21;')), 'both actual downloaded files match the generated byte counts and have complete STEP terminators')
  }
} finally {
  await finish(browser, consoleErrors)
  if (downloadDir) {
    for (const name of readdirSync(downloadDir)) unlinkSync(join(downloadDir, name))
    rmdirSync(downloadDir)
  }
}

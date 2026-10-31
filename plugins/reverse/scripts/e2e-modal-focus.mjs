// SPDX-License-Identifier: AGPL-3.0-only
// A native modal must not dismiss a nonmodal tool window underneath it.
import { launchApp, click, check, fail, finish } from '../../../scripts/e2e-lib.mjs'
import { openReverse } from './lib.mjs'

const { browser, page, consoleErrors } = await launchApp()
try {
  await openReverse(page)
  await page.evaluate(() => window.__re.store.getState().startSketchOn({ kind: 'world', axis: 'z', offset: 0 }))
  await page.waitForSelector('[data-test=sketch-editor]')
  await click(page, '[data-test=sketch-fit-options]')
  await page.waitForSelector('[data-test=fit-options]')
  check(!(await page.$('.modalback')), 'Fit options remains a nonmodal tool window')
  await click(page, '[data-test=open-settings]')
  await page.waitForSelector('[data-test=settings-modal]')
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-test=settings-modal]', { hidden: true })
  check(!!(await page.$('[data-test=fit-options]')), 'Escape in Settings leaves the underlying Fit options window open')
  check(await page.evaluate(() => !!window.__re.store.getState().sketchDraft), 'the sketch remains open after Settings closes')
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-test=fit-options]', { hidden: true })
  check(await page.evaluate(() => !!window.__re.store.getState().sketchDraft), 'Escape then closes Fit options without discarding the sketch')
} catch (e) { fail(e.stack ?? String(e)) }
finally { await finish(browser, consoleErrors) }

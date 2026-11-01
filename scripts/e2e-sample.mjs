// SPDX-License-Identifier: AGPL-3.0-only
// The sample scan from the start page: the key is there on an empty stage, in
// each workspace that opens a scan, and takes the file bundled with this very
// build through the normal import path; and with no file there, it says so.
// Public UI only, so it runs against dist/ too.
//
// Prereqs: a server running (npm run dev, or vite preview), Chrome.
//   node scripts/e2e-sample.mjs
// Env: APP_URL, CHROME.
import { check, click, fail, finish, launchApp } from './e2e-lib.mjs'

const { browser, page, consoleErrors } = await launchApp()
try {
  await page.waitForSelector('[data-test=start-pane]')
  check(Boolean(await page.$('[data-test=start-sample]')), 'the start page offers the sample scan')
  // The Reverse engineer has no start page: it works from a blank stage.
  for (const workspace of ['deviation', 'thickness', 'mesh']) {
    const tab = await page.$(`[data-test=workspace-${workspace}]`)
    if (!tab) continue // A build without that plugin.
    await tab.click()
    await page.waitForSelector('[data-test=start-pane]')
    check(Boolean(await page.$('[data-test=start-sample]')), `and so does the ${workspace} workspace`)
  }
  await click(page, '[data-test=workspace-elements]')
  await page.waitForSelector('[data-test=start-sample]')

  // ---- with the file gone, it says so and the door stays open -------------------------
  await page.setRequestInterception(true)
  const refuse = (request) => (/\/samples\//.test(request.url()) ? request.respond({ status: 404, body: '' }) : request.continue())
  page.on('request', refuse)
  await click(page, '[data-test=start-sample]')
  await page.waitForFunction(() => /sample scan could not be fetched/.test(document.body.textContent ?? ''), { timeout: 15_000 })
  check(Boolean(await page.$('[data-test=start-sample]')), 'a sample that cannot be fetched says so and leaves the key there')
  page.off('request', refuse)
  await page.setRequestInterception(false)
  consoleErrors.length = 0 // The browser's own line about the 404.

  // ---- opened ---------------------------------------------------------------------------
  const fetched = []
  page.on('response', (r) => {
    if (/\/samples\//.test(r.url())) fetched.push(r.url())
  })
  await click(page, '[data-test=start-sample]')
  await page.waitForFunction(() => /288,582 triangles/.test(document.querySelector('.file-info')?.textContent ?? ''), { timeout: 120_000 })
  check(new URL(fetched[0]).origin === new URL(page.url()).origin, `it comes from this build, not a file store: ${fetched[0]}`)
  const info = await page.$eval('.file-info', (el) => el.textContent ?? '')
  check(/fridgeBracket_01-reduced\.3mf/.test(info), `the scan is on the stage: ${info.trim()}`)
  check(!(await page.$('[data-test=start-pane]')), 'and the start page is gone')
  await page.waitForFunction(() => !document.querySelector('[data-test="save-project"]').disabled, { timeout: 60_000 })
  check(true, 'and it can be saved as any scan can')
} catch (e) {
  fail(`threw: ${e instanceof Error ? e.stack : String(e)}`)
} finally {
  await finish(browser, consoleErrors)
}

// SPDX-License-Identifier: AGPL-3.0-only
// An isolated dev server and browser: no private scan or live app connection.
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
import { check, fail, finish, launchApp, shotPath, sleep } from './e2e-lib.mjs'

const server = process.env.APP_URL ? null : await createServer({
  root: fileURLToPath(new URL('../', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, watch: { ignored: ['**/e2e-out/**'] } },
})
let browser
let consoleErrors = []
try {
  await server?.listen()
  const app = await launchApp({ url: process.env.APP_URL ?? server.resolvedUrls.local[0] })
  browser = app.browser
  consoleErrors = app.consoleErrors
  const { page } = app
  const start = () => page.evaluate(async () => {
    const { useTaskActivity } = await import('/src/state/taskActivity.ts')
    const activity = useTaskActivity.getState()
    activity.setTask('test-mesh', { text: 'Mesh worker: synthetic measurement', percent: null })
    activity.setTask('test-cad', { text: 'CAD worker: synthetic build', percent: null })
  })
  const entries = () => page.$$eval('[data-test=process-entry]', (nodes) => nodes.map((node) => node.textContent))
  const panel = '[data-test=process-reporting]'
  const toggle = '[data-test=process-toggle]'
  await start()
  await page.waitForSelector(toggle)
  check(await page.$(panel) === null, 'the process panel starts closed without a floating button')
  await page.focus(toggle)
  await page.keyboard.press('Enter')
  await page.waitForSelector(panel)
  check(await page.$eval(toggle, node => node.getAttribute('aria-expanded')) === 'true', 'Enter opens the panel with an accessible expanded state')
  check((await page.$eval(`${panel} header`, (node) => node.textContent)).includes('This panel cannot cancel work.'), 'cancellation notice appears in the header')
  await page.keyboard.press('Space')
  await page.waitForSelector(panel, { hidden: true })
  check(await page.$eval(toggle, node => node.getAttribute('aria-expanded')) === 'false', 'Space closes the panel and updates the expanded state')
  await page.click(toggle)
  await page.waitForSelector(panel)
  check(await page.$eval(toggle, node => node.getAttribute('aria-expanded')) === 'true', 'clicking WORKING opens the panel')
  check((await entries()).length === 2, 'independent processes have separate rows')
  check(await page.$$eval('[data-test=process-entry]', nodes => nodes.every(node => node.querySelectorAll('.process-reporting-phase').length === 0)), 'a pending process does not repeat its label as its phase')
  check(!(await page.$eval(`${panel} header`, (node) => node.textContent)).includes('Elapsed'), 'elapsed time is shown per process, not duplicated in the header')
  check(!(await page.$eval(panel, (node) => node.textContent)).includes('Current processes'), 'the header is not repeated in the panel')
  check((await page.$eval('[data-test=process-overall]', node => node.textContent)).includes('Overall: No update received yet'), 'overall timing does not fabricate a report')
  check((await entries()).every((text) => text.includes('No update received yet')), 'pending requests do not pretend to have reported progress')
  check(await page.$eval(panel, node => !node.textContent.includes('a quiet interval')), 'explanatory text stays out of the panel body')
  await page.click('[data-test=process-help]')
  await page.waitForSelector('[data-test=process-help-card]')
  check((await page.$eval('[data-test=process-help-card]', node => node.textContent)).includes('quiet interval'), 'information icon explains timing and reporting')
  check((await page.$eval('[data-test=process-help-card]', node => node.textContent)).includes("main thread is blocked"), 'information icon explains when the reporting UI cannot update')
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-test=process-help-card]', { hidden: true })
  await sleep(1200)
  check((await entries()).every((text) => /Elapsed: [1-9]\d*s/.test(text)), 'elapsed time advances without a report')
  check((await entries()).every((text) => text.includes('No update received yet')), 'the display timer does not fabricate worker updates')
  check((await page.$eval('[data-test=process-overall]', node => node.textContent)).includes('Overall elapsed:'), 'overall elapsed time is clearly labelled')
  await page.evaluate(async () => {
    const { useTaskActivity } = await import('/src/state/taskActivity.ts')
    useTaskActivity.getState().setTask('test-mesh', { text: 'Measuring scan points', percent: 42 })
  })
  await page.waitForFunction(() => document.querySelector('[data-test=process-entry] progress')?.value === 42)
  check((await entries())[0].includes('Last update: 0s ago'), 'a real progress report records its arrival')
  check((await entries())[1].includes('No update received yet'), 'one request does not update another')
  check((await page.$eval('[data-test=process-overall]', node => node.textContent)).includes('Overall last update: 0s ago'), 'overall last update uses the latest process report')
  check(await page.$$eval('[data-test=process-entry]', nodes => nodes.every(node => {
    const children = [...node.children]
    return children[1]?.textContent?.startsWith('Elapsed:') && (children[2]?.textContent?.startsWith('Last update:') || children[2]?.textContent === 'No update received yet')
  })), 'each process shows elapsed time and last update before its phase')
  check(await page.$eval(panel, node => node.getBoundingClientRect().width <= 340), 'process panel stays at or below 340 pixels wide')
  await page.screenshot({ path: shotPath('process-reporting-desktop.png') })
  await page.setViewport({ width: 390, height: 844 })
  const bounds = await page.$eval(panel, (node) => {
    const r = node.getBoundingClientRect()
    return { left: r.left, right: r.right, bottom: r.bottom, width: innerWidth, height: innerHeight }
  })
  check(bounds.left >= 0 && bounds.right <= bounds.width && bounds.bottom <= bounds.height, 'process reporting fits a narrow screen')
  await page.screenshot({ path: shotPath('process-reporting-mobile.png') })
  await page.setViewport({ width: 280, height: 844 })
  check(await page.$eval(panel, node => {
    const r = node.getBoundingClientRect()
    return r.left >= 0 && r.right <= innerWidth && node.scrollWidth <= node.clientWidth
  }), 'process panel fits very narrow screens without horizontal overflow')
  await page.setViewport({ width: 390, height: 844 })
  await page.evaluate(async () => {
    const { useTaskActivity } = await import('/src/state/taskActivity.ts')
    useTaskActivity.getState().setTask('test-mesh', { text: 'Indexing surface (no intermediate progress available)', percent: null })
  })
  await page.waitForFunction(() => !document.querySelector('[data-test=process-entry] progress'))
  check(!(await entries())[0].includes('(42%)'), 'an unquantified phase clears the previous percentage')
  await page.evaluate(async () => {
    const { useTaskActivity } = await import('/src/state/taskActivity.ts')
    useTaskActivity.getState().setTask('test-mesh', { text: 'Triangles remaining: 10,099,058\nPhase: ranking collapses\nIteration: 1064', percent: null })
  })
  await page.waitForFunction(() => document.querySelector('.process-reporting-phase')?.textContent?.includes('Iteration: 1064'))
  const phaseStyle = await page.$eval('.process-reporting-phase', (node) => ({ whiteSpace: getComputedStyle(node).whiteSpace, text: node.textContent }))
  check(phaseStyle.whiteSpace === 'pre-line' && phaseStyle.text.split('\n').length === 3, 'multiline diagnostic values occupy separate rows')
  await page.screenshot({ path: shotPath('process-reporting-diagnostic-mobile.png') })
  await page.setViewport({ width: 1500, height: 950 })
  await page.screenshot({ path: shotPath('process-reporting-diagnostic-desktop.png') })
  await page.evaluate(async () => {
    const { useTaskActivity } = await import('/src/state/taskActivity.ts')
    useTaskActivity.getState().finishTask('test-mesh', 'completed')
  })
  await page.waitForFunction(() => document.querySelectorAll('[data-test=process-entry]').length === 1)
  check((await entries())[0].includes('CAD worker'), 'completing one process leaves the other visible')
  const originalSize = await page.$eval(panel, node => ({ width: node.offsetWidth, height: node.offsetHeight }))
  const successAt = await page.evaluate(async () => {
    const { useTaskActivity } = await import('/src/state/taskActivity.ts')
    useTaskActivity.getState().finishTask('test-cad', 'completed')
    return Date.now()
  })
  await page.waitForSelector('[data-test=process-history-entry]')
  check((await page.$eval(panel, node => node.textContent)).includes('Completed'), 'an open panel shows the successful outcome before closing')
  check(await page.$eval(panel, (node, size) => node.offsetWidth === size.width && node.offsetHeight === size.height, originalSize),
    'completion keeps the exact compact box dimensions')
  await page.waitForSelector(panel, { hidden: true })
  check(Date.now() - successAt <= 2000, 'successful reporting automatically closes within the two-second maximum')
  check((await page.$eval(toggle, node => node.textContent)).includes('Recent operations'), 'history remains accessible after successful work')
  await page.click(toggle)
  await page.waitForSelector(panel)
  await sleep(2200)
  check(await page.$(panel) !== null, 'manually reopened history does not auto-close')
  await page.click('[aria-label="Dismiss process report"]')

  await page.evaluate(async () => {
    const { useTaskActivity } = await import('/src/state/taskActivity.ts')
    const activity = useTaskActivity.getState()
    activity.setTask('burst', { text: 'Rapid worker reports', percent: null })
    await new Promise(resolve => {
      const channel = new MessageChannel()
      let n = 0
      channel.port1.onmessage = () => {
        activity.setTask('burst', { text: `Internal phase ${++n}`, percent: null })
        if (n < 250) channel.port2.postMessage(n)
        else { channel.port1.close(); channel.port2.close(); resolve() }
      }
      channel.port2.postMessage(0)
    })
    activity.finishTask('burst', 'completed')
  })
  await page.waitForSelector(panel, { hidden: true })
  check(true, 'rapid worker phase reports settle without a fallback state-update loop')

  await page.evaluate(async () => {
    const { useTaskActivity } = await import('/src/state/taskActivity.ts')
    const activity = useTaskActivity.getState()
    activity.setTask('parallel-one', { text: 'Synthetic failing request', percent: null })
    activity.setTask('parallel-two', { text: 'Synthetic successful request', percent: null })
    activity.finishTask('parallel-one', 'failed', 'Synthetic parallel failure')
    activity.finishTask('parallel-two', 'completed')
  })
  await page.waitForSelector(panel)
  await sleep(2200)
  check(await page.$eval('[data-test=process-history-entry]', node => node.textContent.includes('Synthetic parallel failure')),
    'a later successful request neither hides nor auto-dismisses an unacknowledged failure')
  await page.click('[data-test=clear-process-history]')
  await page.click('[aria-label="Dismiss process report"]')

  await page.evaluate(async () => {
    const { WorkerRpc } = await import('/src/core/workerRpc.ts')
    window.__reportingWorker = new Worker(URL.createObjectURL(new Blob([
      `self.onmessage = ({ data }) => {
        self.postMessage({ type: 'progress', requestId: data.requestId, text: 'Filling holes - 700 of 4,608' });
        setTimeout(() => { throw new Error('Synthetic worker failure'); }, 50);
      }`,
    ], { type: 'text/javascript' })))
    const rpc = new WorkerRpc(() => window.__reportingWorker, 'Mesh worker')
    await rpc.request({ requestId: 1, type: 'edit' }).catch(() => {})
  })
  await page.waitForSelector('[data-test=process-history-entry]')
  check((await page.$eval(panel, node => node.textContent)).includes('Synthetic worker failure'), 'an actual worker error is retained and automatically opens details')
  check((await page.$eval(panel, node => node.textContent)).includes('700 of 4,608'), 'failure details retain the last reported phase')
  await sleep(2300)
  check(await page.$(panel) !== null, 'failure details remain visible beyond the success timeout')
  await page.screenshot({ path: shotPath('process-reporting-failure.png') })
  await page.evaluate(() => {
    window.__copiedDiagnostics = null
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async text => { window.__copiedDiagnostics = text; window.__lastCopyAt = Date.now() },
    } })
  })
  const beforeCopySize = await page.$eval(panel, node => ({ width: node.offsetWidth, height: node.offsetHeight }))
  await page.click('[data-test=copy-process-diagnostics]')
  check(await page.evaluate(() => {
    const report = JSON.parse(window.__copiedDiagnostics)
    return report.recent.some(entry => entry.outcome === 'failed' && entry.message.includes('Synthetic worker failure'))
  }), 'Copy diagnostics includes the observed failure without scan geometry')
  const copyNotice = '[data-test=process-copy-notice]'
  await page.waitForSelector(copyNotice)
  check(await page.$eval(panel, (node, size) => node.offsetWidth === size.width && node.offsetHeight === size.height, beforeCopySize),
    'the clipboard popup does not resize the compact diagnostic box')
  check(await page.$eval(copyNotice, node => node.textContent.includes('copied to clipboard') && node.textContent.includes('No file was saved')),
    'successful copying explains clipboard destination rather than implying a saved file')
  check(await page.$eval(copyNotice, node => {
    const notice = node.getBoundingClientRect()
    const button = document.querySelector('[data-test=copy-process-diagnostics]').getBoundingClientRect()
    return Math.abs(notice.bottom - (button.top - 8)) <= 1 && Math.abs(notice.left - button.left) <= 1
  }), 'clipboard confirmation appears directly above the clicked button')
  await page.screenshot({ path: shotPath('process-reporting-copy-notice.png') })
  await page.setViewport({ width: 280, height: 844 })
  await page.click('[data-test=copy-process-diagnostics]')
  check(await page.$eval(copyNotice, node => {
    const notice = node.getBoundingClientRect()
    const button = document.querySelector('[data-test=copy-process-diagnostics]').getBoundingClientRect()
    return notice.left >= 0 && notice.right <= innerWidth && Math.abs(notice.bottom - (button.top - 8)) <= 1
  }), 'button-anchored confirmation stays within a narrow viewport')
  await page.screenshot({ path: shotPath('process-reporting-copy-notice-mobile.png') })
  await page.setViewport({ width: 1500, height: 950 })
  await page.click('[data-test=copy-process-diagnostics]')
  await sleep(1200)
  await page.click('[data-test=copy-process-diagnostics]')
  await sleep(1500)
  check(await page.$(copyNotice) !== null, 'copying again restarts the temporary notification lifetime')
  await page.click('[aria-label="Dismiss process report"]')
  check(await page.$(copyNotice) !== null, 'the clipboard popup remains visible when the report box is closed')
  await page.waitForSelector(copyNotice, { hidden: true })
  const noticeDuration = await page.evaluate(() => Date.now() - window.__lastCopyAt)
  check(noticeDuration >= 2000 && noticeDuration <= 3000, 'clipboard popup automatically disappears within the requested two-to-three-second window')
  await page.click(toggle)
  await page.waitForSelector(panel)
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('Clipboard denied for test') } })
  await page.click('[data-test=copy-process-diagnostics]')
  await page.waitForFunction(() => document.querySelector('[data-test=process-reporting]')?.textContent.includes('Copy failed: Clipboard denied for test'))
  check(true, 'clipboard failures are visible rather than falsely reporting success')
  check(await page.$(copyNotice) === null, 'failed copying does not show a success popup')
  await page.click('[aria-label="Dismiss process report"]')
  await page.reload({ waitUntil: 'networkidle0' })
  check(await page.$(panel) === null, 'dismissed failures do not reopen after reload')
  await page.click(toggle)
  await page.waitForSelector(panel)
  check((await page.$eval(panel, node => node.textContent)).includes('Synthetic worker failure'), 'recent failure history survives reload in this tab')
  await page.click('[data-test=clear-process-history]')
  await page.click('[aria-label="Dismiss process report"]')
  await page.evaluate(async () => {
    const { useTaskActivity } = await import('/src/state/taskActivity.ts')
    useTaskActivity.getState().setTask('interrupted', { text: 'Mesh worker: synthetic edit', percent: null })
    useTaskActivity.getState().setTask('interrupted', { text: 'Filling holes - 700 of 4,608', percent: null })
    window.dispatchEvent(new Event('pagehide'))
  })
  await page.reload({ waitUntil: 'networkidle0' })
  await page.waitForSelector(panel)
  check(await page.$eval('[data-test=process-history-entry]', node => node.textContent.includes('Interrupted') && node.textContent.includes('Cause unknown')),
    'reloading pending work prominently shows interruption without inventing a crash diagnosis')
  check(await page.evaluate(async () => {
    const { useTaskActivity } = await import('/src/state/taskActivity.ts')
    return Object.keys(useTaskActivity.getState().tasks).length === 0
  }), 'interrupted requests are not automatically restarted')
  await page.screenshot({ path: shotPath('process-reporting-interrupted.png') })
  await page.click('[data-test=clear-process-history]')
  await page.click('[aria-label="Dismiss process report"]')

  await page.setViewport({ width: 1500, height: 950 })
  await page.evaluateOnNewDocument(() => {
    window.__processReports = []
    const OriginalWorker = window.Worker
    window.Worker = class extends OriginalWorker {
      constructor(...args) {
        super(...args)
        this.addEventListener('message', ({ data }) => {
          if (data.type === 'progress') window.__processReports.push(data)
        })
      }
    }
  })
  await page.reload({ waitUntil: 'networkidle0' })
  await page.click('[data-test=workspace-mesh]')
  await page.evaluate(async () => {
    const { icosphere } = await import('/tests/helpers.ts')
    const { positions, indices } = icosphere(5, 20, 0.01)
    const lines = []
    for (let i = 0; i < positions.length; i += 3) lines.push(`v ${positions[i]} ${positions[i + 1]} ${positions[i + 2]}`)
    for (let i = 0; i < indices.length; i += 3) lines.push(`f ${indices[i] + 1} ${indices[i + 1] + 1} ${indices[i + 2] + 1}`)
    const transfer = new DataTransfer()
    transfer.items.add(new File([lines.join('\n')], 'reporting-synthetic.obj'))
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }))
  })
  await page.waitForFunction(() => document.querySelector('[data-test=reduce-mesh]')?.disabled === false)
  await page.evaluate(() => { window.__processReports = [] })
  await page.click('[data-test=reduce-mesh]')
  await page.waitForSelector('[data-test=reduce-result]', { timeout: 120000 })
  const reports = await page.evaluate(() => window.__processReports)
  for (const direction of ['measuring scan to reduced mesh', 'measuring reduced mesh to scan']) {
    const readings = reports.filter((report) => report.text.includes(direction))
    check(readings.length >= 2 && readings[0].fraction === 0 && readings.at(-1).fraction === 1,
      `real mesh worker reports counted progress: ${direction}`)
    check(readings.every((report) => Number.isInteger(report.requestId)), 'real worker reports identify their request')
  }
  check(reports.some((report) => report.text.includes('simplifying geometry') && report.fraction === undefined),
    'synchronous simplification is explicitly unquantified')
  await page.waitForSelector(panel, { hidden: true })
  check(true, 'a real reduction clears reporting after its result arrives')

  // Exercise the non-worker activity fallback without assigning it fake reports.
  await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.ts')
    useStore.getState().setWorking('Preparing application work')
  })
  await page.waitForSelector(toggle)
  check(await page.$(panel) === null, 'a new activity starts with the panel closed')
  await page.click(toggle)
  await page.waitForSelector(panel)
  check((await entries())[0].includes('Application activity'), 'activities without a tracked worker still have a report')
  await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.ts')
    useStore.getState().setWorking(null)
  })
  await page.waitForSelector(panel, { hidden: true })

  const restricted = await browser.newPage()
  await restricted.evaluateOnNewDocument(() => {
    Object.defineProperty(window, 'sessionStorage', { get() { throw new DOMException('Storage blocked for test', 'SecurityError') } })
  })
  await restricted.goto(page.url(), { waitUntil: 'networkidle0' })
  await restricted.evaluate(async () => {
    const { useTaskActivity } = await import('/src/state/taskActivity.ts')
    useTaskActivity.getState().setTask('storage-test', { text: 'Synthetic storage check', percent: null })
  })
  await restricted.click(toggle)
  await restricted.waitForSelector(panel)
  check((await restricted.$eval(panel, node => node.textContent)).includes('Reload recovery is unavailable'),
    'blocked session storage is explicitly reported while in-memory reporting still works')
  await restricted.close()
} catch (error) {
  fail(error.stack ?? String(error))
} finally {
  try { if (browser) await finish(browser, consoleErrors) }
  finally { await server?.close() }
}

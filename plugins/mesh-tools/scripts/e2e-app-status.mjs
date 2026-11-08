// SPDX-License-Identifier: AGPL-3.0-only
import { check, finish, launchApp, shotPath } from '../../../scripts/e2e-lib.mjs'

const { browser, page, consoleErrors } = await launchApp()
try {
  await page.waitForFunction(() => document.querySelector('[data-test=app-activity-state]')?.textContent.includes('READY'))
  await page.evaluate(async () => {
    const { useTaskActivity } = await import('/src/state/taskActivity.ts')
    useTaskActivity.getState().setTask('duplicate-progress-test', { text: 'Checking visible triangles: 20%', percent: 20 })
  })
  await page.waitForFunction(() => document.querySelector('[data-test=app-activity-state]')?.textContent.includes('WORKING 20%'))
  check(await page.$eval('[data-test=task-progress]', (el) => el.textContent === 'Checking visible triangles'),
    'percentage appears once, with only the phase beside it')
  await page.screenshot({ path: shotPath('app-status-single-percentage.png') })
  await page.evaluate(async () => {
    const { useTaskActivity } = await import('/src/state/taskActivity.ts')
    useTaskActivity.getState().setTask('duplicate-progress-test', null)
  })
  await page.evaluate(async () => {
    window.statusTestStores = {
      app: (await import('/src/state/store.ts')).useStore,
      deviation: (await import('/src/state/deviationStore.ts')).useDeviation,
      thickness: (await import('/src/state/thicknessStore.ts')).useThickness,
      flat: (await import('/src/state/flatStore.ts')).useFlat,
      mesh: (await import('/plugins/mesh-tools/state/meshStore.ts')).useMeshTools,
      agent: (await import('/src/commands/activity.ts')).useCommandActivity,
    }
  })
  const scenarios = [
    ['loading', 'app', { busy: true, statusText: 'Loading test scan', progress: 0.25 }, 'WORKING 25%'],
    ['alignment', 'app', { working: 'Finding symmetry' }, 'WORKING'],
    ['reference loading', 'deviation', { nominalBusy: true }, 'WORKING'],
    ['deviation alignment', 'deviation', { alignStatus: 'running' }, 'WORKING'],
    ['reference deviation', 'deviation', { referenceStatus: 'running' }, 'WORKING'],
    ['element deviation', 'deviation', { elementStatus: 'running' }, 'WORKING'],
    ['volume', 'deviation', { volumeStatus: 'running' }, 'WORKING'],
    ['thickness', 'thickness', { status: 'running' }, 'WORKING'],
    ['image loading', 'flat', { imageBusy: true }, 'WORKING'],
    ['edge detection', 'flat', { edgeStatus: 'running' }, 'WORKING'],
    ['mesh reduction', 'mesh', { status: 'running' }, 'WORKING'],
    ['mesh edit', 'mesh', { editing: true }, 'WORKING'],
    ['mesh trim', 'mesh', { trimStatus: 'running' }, 'WORKING'],
    ['mesh wrap', 'mesh', { wrapStatus: 'running' }, 'WORKING'],
    ['agent command', 'agent', { running: { name: 'scan.qa', title: 'Checking scan', since: 0 } }, 'WORKING'],
  ]
  for (const [name, kind, state, expected] of scenarios) {
    await page.evaluate(({ kind, state }) => {
      const store = window.statusTestStores[kind]
      const before = Object.fromEntries(Object.keys(state).map((key) => [key, store.getState()[key]]))
      window.restoreStatusTest = () => store.setState(before)
      store.setState(state)
    }, { kind, state })
    await page.waitForFunction((text) => document.querySelector('[data-test=app-activity-state]')?.textContent.includes(text), {}, expected)
    check(true, `${name} updates the global status strip`)
    if (name === 'loading') await page.screenshot({ path: shotPath('app-wide-status-loading.png') })
    await page.evaluate(() => { window.restoreStatusTest(); delete window.restoreStatusTest })
    await page.waitForFunction(() => document.querySelector('[data-test=app-activity-state]')?.textContent.includes('READY'))
  }
  await page.evaluate(async () => {
    const { WorkerRpc } = await import('/src/core/workerRpc.ts')
    const worker = { postMessage() {}, terminate() {} }
    window.statusTestWorker = worker
    window.statusTestRpc = new WorkerRpc(() => worker, 'CAD kernel worker')
    window.statusTestRequest = window.statusTestRpc.request({ requestId: 1, type: 'build' })
  })
  await page.waitForFunction(() => document.querySelector('[data-test=task-progress]')?.textContent.includes('CAD kernel worker: build'))
  check(true, 'pending CAD worker requests show named app-wide activity')
  await page.evaluate(async () => {
    window.statusTestWorker.onmessage({ data: { requestId: 1, type: 'done' } })
    await window.statusTestRequest
    window.statusTestRpc.dispose()
    delete window.statusTestWorker
    delete window.statusTestRpc
    delete window.statusTestRequest
  })
  await page.waitForFunction(() => document.querySelector('[data-test=app-activity-state]')?.textContent.includes('READY'))
  await page.evaluate(async () => {
    const { useTaskActivity } = await import('/src/state/taskActivity.ts')
    const { useStore } = await import('/src/state/store.ts')
    useStore.setState({ progress: 0.9 })
    useTaskActivity.getState().setTask('status-test-export', { text: 'Saving export', percent: null })
  })
  await page.waitForFunction(() => document.querySelector('[data-test=app-activity-state]')?.textContent.includes('WORKING'))
  check(!await page.$eval('[data-test=app-activity-state]', (el) => el.textContent.includes('%')), 'unmeasured export does not reuse a stale percentage')
  await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.ts')
    useStore.setState({ errorText: 'Status test error' })
  })
  await page.waitForFunction(() => document.querySelector('[data-test=app-activity-state]')?.textContent.includes('ERROR'))
  check(true, 'errors remain visible while work is active')
  await page.evaluate(async () => {
    const { useTaskActivity } = await import('/src/state/taskActivity.ts')
    const { useStore } = await import('/src/state/store.ts')
    useTaskActivity.getState().setTask('status-test-export', null)
    useStore.setState({ errorText: null, progress: null })
  })
  await page.waitForFunction(() => document.querySelector('[data-test=app-activity-state]')?.textContent.includes('READY'))
} finally { await finish(browser, consoleErrors) }

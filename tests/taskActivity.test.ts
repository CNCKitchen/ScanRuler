// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, it, vi } from 'vitest'
import { useStore } from '../src/state/store'
import { processDuration, progressPhaseText, useTaskActivity } from '../src/state/taskActivity'
import { runExport, saveBuilt } from '../src/app/exports'
import { diagnosticsReport, historyKey, readTaskHistory, writeTaskHistory } from '../src/state/taskHistory'

const initial = useStore.getState()
afterEach(() => {
  useStore.setState(initial, true)
  useTaskActivity.setState({ tasks: {}, history: [] })
  vi.restoreAllMocks()
})

it('removes only a trailing percentage duplicated in the activity indicator', () => {
  expect(progressPhaseText('Checking visible triangles: 20%', 20)).toBe('Checking visible triangles')
  expect(progressPhaseText('Checking triangles - 20%', 20)).toBe('Checking triangles')
  expect(progressPhaseText('Measuring 20%', 20)).toBe('Measuring')
  expect(progressPhaseText('Checking: 0%', 0)).toBe('Checking')
  expect(progressPhaseText('Checking: 100%', 100)).toBe('Checking')
  expect(progressPhaseText('Checking: 20%', null)).toBe('Checking: 20%')
  expect(progressPhaseText('Tolerance 20%', 42)).toBe('Tolerance 20%')
  expect(progressPhaseText('Checking 20% of the mesh', 20)).toBe('Checking 20% of the mesh')
  expect(progressPhaseText('Finding selection boundaries...', null)).toBe('Finding selection boundaries...')
})

it('keeps independent activities until each completes', () => {
  const activity = useTaskActivity.getState()
  activity.setTask('export', { text: 'Saving export', percent: null })
  activity.setTask('worker', { text: 'Measuring', percent: 42 })
  activity.setTask('worker', null)
  expect(useTaskActivity.getState().tasks).toMatchObject({ export: { text: 'Saving export', percent: null } })
  activity.setTask('export', null)
  expect(useTaskActivity.getState().tasks).toEqual({})
})

it('shows exports while pending and clears activity after success, failure or cancellation', async () => {
  for (const error of [null, new Error('test export failure'), new DOMException('Cancelled', 'AbortError')]) {
    useStore.setState({ errorText: null })
    await runExport(async () => {
      expect(Object.values(useTaskActivity.getState().tasks)).toMatchObject([{ text: 'Preparing or saving export...', percent: null }])
      if (error) throw error
    })

    expect(useTaskActivity.getState().tasks).toEqual({})
    if (error) expect(useStore.getState().errorText).toContain(error.message)
    else expect(useStore.getState().errorText).toBeNull()
    expect(useTaskActivity.getState().history[0].outcome).toBe(error?.name === 'AbortError' ? 'cancelled' : error ? 'failed' : 'completed')
  }
})

it('reports synchronous and asynchronous export-build failures once, without saving', async () => {
  const download = vi.spyOn(URL, 'createObjectURL')
  for (const builder of [
    () => { throw new Error('Build failed') },
    async () => { throw new Error('Build failed') },
  ]) {
    useTaskActivity.setState({ tasks: {}, history: [] })
    await saveBuilt(builder)
    expect(useTaskActivity.getState().history).toHaveLength(1)
    expect(useTaskActivity.getState().history[0]).toMatchObject({ outcome: 'failed', message: 'Build failed' })
    expect(useStore.getState().errorText).toContain('Build failed')
    expect(download).not.toHaveBeenCalled()
  }
})

it('does not report a completed export when handing the built file to the browser fails', async () => {
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => { throw new Error('Download failed') })
  await saveBuilt(async () => ({ name: 'part.stl', mimeType: 'model/stl', bytes: new Uint8Array([1]), status: 'Exported.' }))
  expect(useTaskActivity.getState().history).toHaveLength(1)
  expect(useTaskActivity.getState().history[0]).toMatchObject({ outcome: 'failed', message: 'Download failed' })
  expect(useStore.getState().errorText).toContain('Download failed')
  expect(useTaskActivity.getState().tasks).toEqual({})
})

it('keeps elapsed time separate from actual reports and clears it on a fresh request', () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
  const activity = useTaskActivity.getState()
  activity.setTask('mesh', { text: 'Mesh worker: reduce', percent: null })
  expect(useTaskActivity.getState().tasks.mesh).toEqual({
    text: 'Mesh worker: reduce', label: 'Mesh worker: reduce', percent: null, startedAt: 1000, updatedAt: null,
  })
  clock.mockReturnValue(6000)
  expect(useTaskActivity.getState().tasks.mesh.updatedAt).toBeNull()
  activity.setTask('mesh', { text: 'Measuring scan points', percent: 20 })
  expect(useTaskActivity.getState().tasks.mesh).toMatchObject({ startedAt: 1000, updatedAt: 6000, label: 'Mesh worker: reduce' })
  clock.mockReturnValue(8000)
  activity.heardTask('mesh')
  expect(useTaskActivity.getState().tasks.mesh).toMatchObject({ text: 'Measuring scan points', percent: 20, updatedAt: 8000 })
  activity.heardTask('unknown')
  expect(Object.keys(useTaskActivity.getState().tasks)).toEqual(['mesh'])
  activity.setTask('mesh', { text: 'Sorting', percent: null })
  expect(useTaskActivity.getState().tasks.mesh.percent).toBeNull()
  activity.setTask('mesh', null)
  activity.setTask('mesh', { text: 'New request', percent: null })
  expect(useTaskActivity.getState().tasks.mesh).toMatchObject({ startedAt: 8000, updatedAt: null, label: 'New request' })
})

it('formats durations without implying an estimated completion time', () => {
  expect([-1000, 0, 999, 1000, 61000, 3600000, 3661000].map(processDuration))
    .toEqual(['0s', '0s', '0s', '1s', '1m 1s', '1h 0m', '1h 1m'])
})

it('retains the last phase, actual outcome and timing while bounding recent history', () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
  const activity = useTaskActivity.getState()
  activity.setTask('mesh', { text: 'Mesh worker: edit', percent: null })
  clock.mockReturnValue(3000)
  activity.setTask('mesh', { text: 'Filling holes - 700 of 4,608', percent: null })
  clock.mockReturnValue(8000)
  activity.finishTask('mesh', 'failed', 'Worker failed.')
  expect(useTaskActivity.getState().tasks).toEqual({})
  expect(useTaskActivity.getState().history[0]).toMatchObject({
    label: 'Mesh worker: edit', text: 'Filling holes - 700 of 4,608',
    startedAt: 1000, updatedAt: 3000, endedAt: 8000, outcome: 'failed', message: 'Worker failed.',
  })
  for (let i = 0; i < 25; i++) {
    activity.setTask('mesh', { text: 'Inspect mesh', percent: null })
    activity.finishTask('mesh', 'completed')
  }
  expect(useTaskActivity.getState().history).toHaveLength(20)
  activity.clearHistory()
  expect(useTaskActivity.getState().history).toEqual([])
})

it('restores pending work as interrupted, never retries it, and redacts persisted diagnostics', () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  }
  const activity = useTaskActivity.getState()
  activity.setTask('mesh', { text: 'Loading C:\\Private\\secret scan.stl', percent: null })
  activity.setTask('mesh', { text: 'Reading https://example.invalid/scan?token=private', percent: 42 })
  writeTaskHistory(storage, useTaskActivity.getState().tasks, [])
  expect(values.get(historyKey)).not.toContain('Private')
  expect(values.get(historyKey)).not.toContain('token=private')
  clock.mockReturnValue(100000)
  const restored = readTaskHistory(storage)
  expect(restored).toMatchObject([{
    outcome: 'interrupted', percent: 42, endedAt: 1000, message: expect.stringContaining('Cause unknown'),
  }])
  writeTaskHistory(storage, {}, restored)
  expect(readTaskHistory(storage)).toEqual(restored)
  const report = diagnosticsReport(useTaskActivity.getState().tasks, restored)
  expect(JSON.parse(report)).toMatchObject({ app: 'ScanRuler', recent: [{ outcome: 'interrupted' }] })
  expect(report).not.toContain('Private')
  expect(report).not.toContain('token=private')
  storage.setItem(historyKey, '{"history":[],"pending":[{"text":"bad"}]}')
  expect(() => readTaskHistory(storage)).toThrow('Invalid process history')
  activity.finishTask('mesh', 'failed', 'Authorization: Bearer private-token')
  expect(diagnosticsReport({}, useTaskActivity.getState().history)).not.toContain('private-token')
})

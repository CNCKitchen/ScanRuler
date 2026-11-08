// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, it } from 'vitest'
import { useStore } from '../src/state/store'
import { progressPhaseText, useTaskActivity } from '../src/state/taskActivity'
import { runExport } from '../src/app/exports'

const initial = useStore.getState()
afterEach(() => {
  useStore.setState(initial, true)
  useTaskActivity.setState({ tasks: {} })
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
  expect(useTaskActivity.getState().tasks).toEqual({ export: { text: 'Saving export', percent: null } })
  activity.setTask('export', null)
  expect(useTaskActivity.getState().tasks).toEqual({})
})

it('shows exports while pending and clears activity after success, failure or cancellation', async () => {
  for (const error of [null, new Error('test export failure'), new DOMException('Cancelled', 'AbortError')]) {
    useStore.setState({ errorText: null })
    await runExport(async () => {
      expect(Object.values(useTaskActivity.getState().tasks)).toEqual([{ text: 'Preparing or saving export...', percent: null }])
      if (error) throw error
    })
    expect(useTaskActivity.getState().tasks).toEqual({})
    if (error) expect(useStore.getState().errorText).toContain(error.message)
    else expect(useStore.getState().errorText).toBeNull()
  }
})

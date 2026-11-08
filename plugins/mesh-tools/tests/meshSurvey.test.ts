// SPDX-License-Identifier: AGPL-3.0-only
// A tool's survey of the mesh, as the workspace makes it: a failure is kept
// as the survey's state, not left looking like one still being made.
import { beforeEach, describe, expect, it } from 'vitest'
import { runSurvey } from '../app/useMeshWorkspace'
import { useMeshTools } from '../state/meshStore'

describe('a survey of the mesh', () => {
  beforeEach(() => useMeshTools.setState({ survey: null, surveyFailed: null }))

  it('keeps why it failed, and Retry asks again', async () => {
    useMeshTools.getState().setSurvey(null)
    await runSurvey(() => Promise.reject(new Error('The worker stopped.')), () => true, () => {})
    expect(useMeshTools.getState().surveyFailed).toBe('The worker stopped.')
    const attempt = useMeshTools.getState().surveyAttempt
    useMeshTools.getState().retrySurvey()
    expect(useMeshTools.getState().surveyFailed).toBeNull()
    expect(useMeshTools.getState().surveyAttempt).toBe(attempt + 1)
  })

  it('hands on what it found, and says nothing of one no longer wanted', async () => {
    let found = 0
    await runSurvey(() => Promise.resolve(3), () => true, (n) => {
      found = n
    })
    expect(found).toBe(3)
    await runSurvey(() => Promise.reject(new Error('gone')), () => false, () => {})
    expect(useMeshTools.getState().surveyFailed).toBeNull()
  })
})

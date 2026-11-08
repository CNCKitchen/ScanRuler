// SPDX-License-Identifier: AGPL-3.0-only
// What a tool panel shows while its survey of the mesh is being made — or,
// once it has failed, why, with a way to make it again.

import { useMeshTools } from '../state/meshStore'

export function SurveyWait({ looking }: { looking: string }) {
  const failed = useMeshTools((s) => s.surveyFailed)
  const retry = useMeshTools((s) => s.retrySurvey)
  if (failed === null) {
    return (
      <p className="hint">
        <span className="spinner" /> {looking}
      </p>
    )
  }
  return (
    <p className="hint" data-test="survey-failed">
      ⚠ {failed}{' '}
      <button data-test="survey-retry" onClick={retry}>
        Retry
      </button>
    </p>
  )
}

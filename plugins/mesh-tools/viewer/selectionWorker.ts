// SPDX-License-Identifier: AGPL-3.0-only
import { reply } from '../../../src/core/workerRpc'
import { SelectionJob, type SelectionRequest, type SelectionResponse } from './selectionJob'

const job = new SelectionJob()
self.onmessage = (event: MessageEvent<SelectionRequest>) => {
  const { requestId } = event.data
  try {
    const result = job.run(event.data, (text, percent) => reply({ type: 'progress', requestId, text, percent } satisfies SelectionResponse))
    reply({ type: 'done', requestId, ...result } satisfies SelectionResponse, [result.mask.buffer, result.edges.buffer])
  } catch (error) {
    reply({ type: 'error', requestId, message: error instanceof Error ? error.message : String(error) } satisfies SelectionResponse)
  }
}

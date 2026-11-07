// SPDX-License-Identifier: AGPL-3.0-only
// One of the wrap's tile workers (wrapJobs.ts): a job in, its answer out.
// The wrap's own worker (wrapWorker.ts) makes a pool of them, and stopping
// that worker stops them with it.

import type { MeshoptSimplifier as Simplifier } from 'meshoptimizer/simplifier'
import { loadSimplifier } from './reduce'
import { resultBuffers, runJob, type JobAnswer, type JobMessage } from './wrapJobs'

let simplifier: typeof Simplifier | null = null

self.onmessage = async (ev: MessageEvent<JobMessage>) => {
  const { id, job } = ev.data
  try {
    if (job.kind === 'r' && !simplifier) simplifier = await loadSimplifier()
    const result = runJob(job, simplifier)
    self.postMessage({ id, result } satisfies JobAnswer, { transfer: resultBuffers(result) })
  } catch (e) {
    self.postMessage({ id, error: e instanceof Error ? e.message : String(e) } satisfies JobAnswer)
  }
}

// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A long computation, handed back one step at a time.
 *
 * The best fit is the one thing this tool does that can run for a minute, and
 * it runs in a worker — where nothing can be heard while it runs, because a
 * worker only reads its inbox between messages and a solid stretch of
 * arithmetic never gets between two. Without a seam in the middle of it, "stop
 * aligning" could only ever mean killing the worker and reloading both models.
 *
 * So the alignment is written as a generator that yields once per ICP pass, and
 * the worker drives it in slices of a few milliseconds. Everywhere else — the
 * tests, anything that just wants the answer — runs it straight through with
 * `runSteps`, which is what the plain `icp` / `autoAlign` / `alignFromPairs` /
 * `alignLocal` functions do.
 */

/** A computation that yields between steps and finally produces a `T`. */
export type Steps<T> = Generator<void, T, void>

/** Run one to the end, ignoring the seams. */
export function runSteps<T>(steps: Steps<T>): T {
  let step = steps.next()
  while (!step.done) step = steps.next()
  return step.value
}

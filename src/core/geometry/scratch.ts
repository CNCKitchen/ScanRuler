// SPDX-License-Identifier: AGPL-3.0-only
/** Reusable per-graph visited-stamp buffer so BFS never has to clear a
 *  multi-megabyte array between runs: a vertex is "visited" when its stamp
 *  equals the current generation. */
const scratchMap = new WeakMap<object, { stamp: Int32Array; gen: number }>()

export function acquireStamps(key: object, size: number): { stamp: Int32Array; gen: number } {
  let s = scratchMap.get(key)
  if (!s || s.stamp.length < size) {
    s = { stamp: new Int32Array(size), gen: 0 }
    scratchMap.set(key, s)
  }
  s.gen++
  if (s.gen >= 0x7fffffff) {
    s.stamp.fill(0)
    s.gen = 1
  }
  return s
}

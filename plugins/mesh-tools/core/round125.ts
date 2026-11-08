// SPDX-License-Identifier: AGPL-3.0-only

/** A size rounded up onto the 1-2-5 steps a person would have typed. */
export function round125(x: number): number {
  if (!(x > 0)) return 0.1
  const exp = Math.floor(Math.log10(x))
  const m = x / Math.pow(10, exp)
  const step = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10
  // Written from the digits rather than multiplied out, so 5 × 0.01 lands
  // in the field as 0.05 and not 0.05000000000000001.
  return Number((step * Math.pow(10, exp)).toFixed(Math.max(0, -exp)))
}

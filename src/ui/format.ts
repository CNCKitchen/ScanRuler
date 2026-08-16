// SPDX-License-Identifier: AGPL-3.0-only

/** A signed millimetre reading the way every deviation is written: an
 *  explicit sign either way — the sign is the point of the number — and a
 *  real minus rather than a hyphen, so the figure reads as a measurement. */
export function formatSigned(v: number): string {
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(3)}`
}

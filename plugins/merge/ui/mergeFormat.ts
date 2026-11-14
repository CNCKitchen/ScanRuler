// SPDX-License-Identifier: AGPL-3.0-only
// The workspace's figures as text.

/** A count with thousands grouped: 12,345. */
export const count = (n: number) => n.toLocaleString('en-US')

/** What an alignment came to, in words: a warning ('warn') for anything that
 *  needs checking, never a success unless it is confident. */
export function alignNote(
  r: { rms: number; matched: number; lowOverlap: boolean; confident: boolean; constraint: number; drift?: number; drifted?: boolean; ambiguous?: boolean },
  fmt: (mm: number, mmDecimals?: number) => string,
  minConstraint: number,
  /** The start was no one's guess (a refine from where the layer opened). */
  unguessed = false,
): { kind: 'warn' | 'ok'; text: string } {
  const fit = `RMS ${fmt(r.rms, 3)}, ${(r.matched * 100).toFixed(1)} % on its target`
  if (r.lowOverlap) return { kind: 'warn', text: `Low overlap — only ${(r.matched * 100).toFixed(1)} % found its target, RMS ${fmt(r.rms, 3)}. Check the result.` }
  if (r.drifted) return { kind: 'warn', text: `The refine drifted ${fmt(r.drift ?? 0, 2)} off its picks or datums — ${fit}. Check them and the result.` }
  if (r.ambiguous) return { kind: 'warn', text: `Another pose fits about as well — ${fit}. Check the result.` }
  if (r.constraint < minConstraint) return { kind: 'warn', text: `What it overlaps lets it slide or turn (constraint ${r.constraint.toFixed(3)}) — ${fit}. Check the result.` }
  if (!r.confident && unguessed) return { kind: 'warn', text: `Aligned from a start nobody chose — ${fit}. It may have settled in a wrong pose: check it, or place it first and refine again.` }
  if (!r.confident) return { kind: 'warn', text: `Not confident — ${fit}. It may sit in a wrong pose: place it and refine again.` }
  return { kind: 'ok', text: `Aligned — ${fit}, constraint ${r.constraint.toFixed(3)}.` }
}

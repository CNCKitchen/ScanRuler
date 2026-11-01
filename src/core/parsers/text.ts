// SPDX-License-Identifier: AGPL-3.0-only
// Text read out of a file. A browser holds at most about 512 MiB of text in one
// string, and past that TextDecoder.decode() does not throw: in Chrome it
// returns "", so a parser finds nothing in the file and says it is empty.

/** The longest string Chrome's TextDecoder gives back whole, in characters:
 *  measured, and V8's own limit. A byte makes at most one character. */
export const TEXT_LIMIT = 536_870_888

const size = (bytes: number) => `${Math.round(bytes / 1024 ** 2).toLocaleString('en-US')} MB`

/** Throw if this many bytes cannot be held as one string. `what` starts the
 *  sentence, and `instead` says what to do about it. */
export function checkTextSize(bytes: number, what: string, instead: string): void {
  if (bytes > TEXT_LIMIT) {
    throw new Error(`${what} is too large: ${size(bytes)} of text, and a browser can hold at most ${size(TEXT_LIMIT)} in one piece. ${instead}`)
  }
}

/** The bytes as one string, or the reason they cannot be. */
export function decodeWhole(bytes: Uint8Array | ArrayBuffer, what: string, instead: string): string {
  const length = bytes.byteLength
  checkTextSize(length, what, instead)
  const text = new TextDecoder().decode(bytes)
  // Another browser's limit may lie lower, and it may say nothing either.
  if (text.length === 0 && length > 3) {
    throw new Error(`${what} is too large: this browser could not hold its ${size(length)} of text in one piece. ${instead}`)
  }
  return text
}

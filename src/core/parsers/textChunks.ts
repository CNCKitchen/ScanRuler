// SPDX-License-Identifier: AGPL-3.0-only
// Text files too large for one string (see text.ts), read a piece at a time:
// by lines, by words, or as pieces that keep whatever a match might still need,
// with the numbers gathered in typed arrays, which a plain array of the same
// length would need twice the memory for and stop at about 134 million.

/** How much of the file is decoded at once, in bytes. */
export const TEXT_CHUNK = 16 * 1024 * 1024

/** Numbers gathered as they are read, the array growing as it fills. */
class Gathered<T extends Float32Array | Uint32Array> {
  length = 0
  private store: T

  constructor(private make: (length: number) => T, capacity = 1 << 16) {
    this.store = make(capacity)
  }

  push(a: number): void {
    if (this.length === this.store.length) this.grow()
    this.store[this.length++] = a
  }

  push3(a: number, b: number, c: number): void {
    if (this.length + 3 > this.store.length) this.grow()
    const s = this.store
    const n = this.length
    s[n] = a
    s[n + 1] = b
    s[n + 2] = c
    this.length = n + 3
  }

  private grow(): void {
    const bigger = this.make(Math.ceil(this.store.length * 1.5) + 3)
    bigger.set(this.store)
    this.store = bigger
  }

  /** The numbers, in an array of just their length. */
  take(): T {
    const out = this.make(this.length)
    out.set(this.store.subarray(0, this.length))
    this.store = this.make(0)
    this.length = 0
    return out
  }
}

export const gatherFloats = (): Gathered<Float32Array> => new Gathered((n) => new Float32Array(n))
export const gatherIndices = (): Gathered<Uint32Array> => new Gathered((n) => new Uint32Array(n))

/** The text of the bytes a piece at a time, cut anywhere, multi-byte characters
 *  kept whole. `done` says how far through the bytes the piece reaches, 0 to 1. */
export function* textPieces(bytes: Uint8Array, chunk = TEXT_CHUNK): Generator<{ text: string; done: number }> {
  const decoder = new TextDecoder()
  for (let at = 0; at < bytes.length; at += chunk) {
    const end = Math.min(at + chunk, bytes.length)
    yield { text: decoder.decode(bytes.subarray(at, end), { stream: end < bytes.length }), done: end / bytes.length }
  }
}

/** Each line of the bytes, without its line feed, and its index from 0: the
 *  same lines text.split('\n') would give, the empty one after a last line feed
 *  left out. */
export function eachLine(bytes: Uint8Array, visit: (line: string, index: number) => void, onPiece?: (done: number) => void, chunk = TEXT_CHUNK): void {
  let tail = ''
  let index = 0
  for (const { text: piece, done } of textPieces(bytes, chunk)) {
    const text = tail === '' ? piece : tail + piece
    let start = 0
    for (let end = text.indexOf('\n'); end >= 0; end = text.indexOf('\n', start)) {
      visit(text.slice(start, end), index++)
      start = end + 1
    }
    tail = text.slice(start)
    onPiece?.(done)
  }
  if (tail !== '') visit(tail, index)
}

/** A character that ends a word, as the pattern \s has it for the text formats
 *  in use: the ASCII white space, and the rest of what a file might hold. */
const isSpace = (c: number) => c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0xfeff || c === 0x2028 || c === 0x2029 || c === 0x3000 || c === 0x1680 || c === 0x202f || c === 0x205f || (c >= 0x2000 && c <= 0x200a)

/** The words of the bytes, one call at a time: what parts split on white space
 *  would give, without holding the whole text. */
export class Words {
  private pieces: Generator<{ text: string; done: number }>
  private text = ''
  private at = 0
  private ended = false

  constructor(bytes: Uint8Array, private onPiece?: (done: number) => void, chunk = TEXT_CHUNK) {
    this.pieces = textPieces(bytes, chunk)
  }

  /** The next word, or undefined past the last. */
  next(): string | undefined {
    for (;;) {
      const { text } = this
      let i = this.at
      while (i < text.length && isSpace(text.charCodeAt(i))) i++
      let end = i
      while (end < text.length && !isSpace(text.charCodeAt(end))) end++
      // A word running to the end of the piece may go on in the next one.
      if (end < text.length || (this.ended && i < text.length)) {
        this.at = end
        return text.slice(i, end)
      }
      if (this.ended) return undefined
      const piece = this.pieces.next()
      if (piece.done) {
        this.ended = true
        this.text = text.slice(i)
      } else {
        this.text = text.slice(i) + piece.value.text
        this.onPiece?.(piece.value.done)
      }
      this.at = 0
    }
  }
}

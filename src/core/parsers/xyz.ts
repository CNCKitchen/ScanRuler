// SPDX-License-Identifier: AGPL-3.0-only
// XYZ, ASC and PTS point clouds: one point a line, numbers split by spaces,
// tabs, commas or semicolons. Lines that are not numbers (a header, a comment)
// and a PTS count line are skipped. A cloud with no normals is refused — see
// the check in readNormalColumns: ScanRuler measures on points through their
// normals. Where the normals sit is found from the first rows: the three
// columns after x y z, or the last three (rgb, intensity and the like come
// before them), whichever holds unit vectors. Given a most points to keep,
// the lines are counted first and every n-th one read (see thin.ts).

import type { ParsedMesh } from '../types'
import { countLines, gatherFloats, eachLine, isSpace, TEXT_CHUNK } from './textChunks'
import { sourceOf, type ByteSource } from './byteSource'
import { Thinning, thinTarget, type CloudReadOptions } from './thin'

const NO_NORMALS = 'This point cloud has no normals — ScanRuler needs them to measure on points.'
const SAMPLE = 2000

/** What splits the numbers on a line: white space, a comma or a semicolon. */
const isSeparator = (c: number) => c === 44 || c === 59 || isSpace(c)

/** The numbers on a line put in `out` from its start, and how many there are,
 *  or -1 when it is not a row of them. Scanned by hand rather than split on a
 *  pattern: a cloud is tens of millions of lines, and a split makes an array
 *  of strings for each. */
export function numbersInto(line: string, out: number[]): number {
  const len = line.length
  let i = 0
  while (i < len && isSeparator(line.charCodeAt(i))) i++
  if (i === len) return -1
  const first = line.charCodeAt(i)
  if (first === 35 || (first === 47 && line.charCodeAt(i + 1) === 47)) return -1 // # or //
  let n = 0
  while (i < len) {
    let end = i + 1
    while (end < len && !isSeparator(line.charCodeAt(end))) end++
    const v = Number(line.slice(i, end))
    if (!Number.isFinite(v)) return -1
    out[n++] = v
    i = end + 1
    while (i < len && isSeparator(line.charCodeAt(i))) i++
  }
  return n >= 3 ? n : -1
}

/** The numbers on a line, or null when it is not a row of them. */
export function numbersOf(line: string): number[] | null {
  const out: number[] = []
  const n = numbersInto(line, out)
  return n < 0 ? null : out.slice(0, n)
}

/** Stops a pass over the lines early. */
const ENOUGH = Symbol('enough')

/** First normal column, or -1 when no three columns hold unit vectors in at least 95 % of the sampled rows. */
function readNormalColumns(rows: number[][], width: number): number {
  if (width < 6) return -1
  const tries = width === 6 ? [3] : [3, width - 3]
  for (const c of tries) {
    let good = 0
    for (const r of rows) {
      const len = Math.hypot(r[c], r[c + 1], r[c + 2])
      if (len >= 0.95 && len <= 1.05) good++
    }
    if (good >= 0.95 * rows.length) return c
  }
  return -1
}

export function parseXYZ(input: ArrayBuffer | ByteSource, onProgress?: (text: string) => void, options: CloudReadOptions = {}): ParsedMesh {
  const bytes = sourceOf(input)
  const chunk = options.chunk ?? TEXT_CHUNK

  // Pass one: the width of a row (the commonest of the first rows — a
  // header that looks like numbers is the odd one out) and where the normals are.
  const widths = new Map<number, number>()
  const sample: number[][] = []
  try {
    eachLine(bytes, (line) => {
      const row = numbersOf(line)
      if (!row) return
      widths.set(row.length, (widths.get(row.length) ?? 0) + 1)
      sample.push(row)
      if (sample.length >= SAMPLE) throw ENOUGH
    }, undefined, chunk)
  } catch (e) {
    if (e !== ENOUGH) throw e
  }
  if (sample.length === 0) throw new Error('No points found in this file.')
  let width = 0
  let best = 0
  for (const [w, n] of widths) if (n > best) { best = n; width = w }
  const normalAt = readNormalColumns(sample.filter((r) => r.length === width), width)
  if (normalAt < 0) throw new Error(NO_NORMALS)

  // Pass two: the points — a line kept or not before it is read, so the
  // thinned-out lines cost no parsing.
  const target = thinTarget(options.maxPoints)
  let thinning: Thinning | null = null
  if (target !== undefined) {
    onProgress?.('Counting points…')
    const lines = countLines(bytes, chunk)
    if (lines > target) thinning = new Thinning(lines, target)
  }
  const pos = gatherFloats(thinning ? thinning.kept * 3 : undefined)
  const nrm = gatherFloats(thinning ? thinning.kept * 3 : undefined)
  onProgress?.('Reading points…')
  const row: number[] = []
  eachLine(bytes, (line) => {
    if (thinning && !thinning.keep()) return
    if (numbersInto(line, row) !== width) return
    pos.push3(row[0], row[1], row[2])
    const nx = row[normalAt]
    const ny = row[normalAt + 1]
    const nz = row[normalAt + 2]
    const len = Math.hypot(nx, ny, nz)
    if (len > 0) nrm.push3(nx / len, ny / len, nz / len)
    else nrm.push3(0, 0, 0)
  }, (done) => onProgress?.(`Reading points… ${Math.round(done * 100)}%`), chunk)
  return { kind: 'cloud', positions: pos.take(), normals: nrm.take() }
}

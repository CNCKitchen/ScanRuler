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
import { countLines, gatherFloats, eachLine, TEXT_CHUNK } from './textChunks'
import { sourceOf, type ByteSource } from './byteSource'
import { Thinning, thinTarget, type CloudReadOptions } from './thin'

const NO_NORMALS = 'This point cloud has no normals — ScanRuler needs them to measure on points.'
const SAMPLE = 2000

/** The numbers on a line, or null when it is not a row of them. */
export function numbersOf(line: string): number[] | null {
  const t = line.trim()
  if (t === '' || t[0] === '#' || t.startsWith('//')) return null
  const parts = t.split(/[\s,;]+/)
  const out: number[] = []
  for (const p of parts) {
    if (p === '') continue
    const v = Number(p)
    if (!Number.isFinite(v)) return null
    out.push(v)
  }
  return out.length >= 3 ? out : null
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
  eachLine(bytes, (line) => {
    if (thinning && !thinning.keep()) return
    const row = numbersOf(line)
    if (!row || row.length !== width) return
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

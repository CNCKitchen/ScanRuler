// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest'
import { parsePLY } from '../src/core/parsers/ply'
import { parseXYZ } from '../src/core/parsers/xyz'
import { bytesSource, type ByteSource } from '../src/core/parsers/byteSource'
import { countLines, eachLine } from '../src/core/parsers/textChunks'
import { Thinning, thinQuestion } from '../src/core/parsers/thin'
import { cloudSizeOf } from '../src/core/parsers/cloudSize'
import { planeCloud, writePlyCloud, writeXyz } from './cloudFixtures'

/** A file read through a source that notes the size of every read. */
function watched(buf: ArrayBuffer): { src: ByteSource; reads: number[] } {
  const inner = bytesSource(buf)
  const reads: number[] = []
  return { reads, src: { size: inner.size, read: (a, b) => { const r = inner.read(a, b); reads.push(r.length); return r } } }
}

const cloud = planeCloud({ size: 20, step: 1 }) // 441 points
const N = cloud.positions.length / 3
const enc = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer

describe('a cloud read a piece at a time', () => {
  for (const format of ['binary_little_endian', 'binary_big_endian', 'ascii'] as const) {
    it(`reads a ${format} PLY the same in pieces cut mid-record as whole`, () => {
      const buf = writePlyCloud(cloud, format, { extraBefore: ['uchar flags'], extraAfter: ['float quality'] })
      const whole = parsePLY(buf)
      expect(whole.positions.length).toBe(N * 3)
      // 29 bytes a vertex (1 + 6·4 + 4): no piece size below is a multiple of it.
      for (const chunk of [1, 7, 30, 100, 1000]) {
        const { src, reads } = watched(buf)
        const m = parsePLY(src, undefined, { chunk })
        expect(Array.from(m.positions)).toEqual(Array.from(whole.positions))
        expect(Array.from(m.normals!)).toEqual(Array.from(whole.normals!))
        // Past the header nothing larger than a piece — or one vertex — is read.
        expect(Math.max(...reads.slice(1))).toBeLessThanOrEqual(Math.max(chunk, 29))
      }
    })
  }

  it('reads an XYZ the same in pieces cut mid-line and mid-number, ragged rows and all', () => {
    const rows = ['# made by a scanner', 'X Y Z NX NY NZ', '']
    for (let i = 0; i < N; i++) {
      const p = [cloud.positions[3 * i], cloud.positions[3 * i + 1], cloud.positions[3 * i + 2]]
      const n = [cloud.normals[3 * i], cloud.normals[3 * i + 1], cloud.normals[3 * i + 2]]
      rows.push([...p, ...n].join(i % 3 ? ' ' : '\t'))
      // A row short of its normals, one with a column too many, a blank line.
      if (i % 50 === 7) rows.push(p.join(' '))
      if (i % 50 === 9) rows.push([...p, ...n, 1].join(' '))
      if (i % 50 === 11) rows.push('   ')
    }
    for (const eol of ['\n', '\r\n']) {
      for (const last of [eol, '']) {
        const buf = enc(rows.join(eol) + last)
        const whole = parseXYZ(buf)
        expect(whole.positions.length).toBe(N * 3)
        for (const chunk of [1, 3, 17, 64, 4096]) {
          const m = parseXYZ(bytesSource(buf), undefined, { chunk })
          expect(Array.from(m.positions)).toEqual(Array.from(whole.positions))
          expect(Array.from(m.normals!)).toEqual(Array.from(whole.normals!))
        }
      }
    }
  })

  it('counts the lines it visits, cut anywhere, with and without a last line feed', () => {
    for (const text of ['', 'a', 'a\n', 'a\nb', 'a\nb\n', '\n\n', 'ab\ncd\r\nef']) {
      let visited = 0
      eachLine(new TextEncoder().encode(text), () => visited++)
      for (const chunk of [1, 2, 3, 100]) expect(countLines(bytesSource(enc(text)), chunk)).toBe(visited)
    }
  })
})

describe('thinning a cloud', () => {
  it('keeps exactly the target, spread evenly', () => {
    for (const [total, target] of [[1000, 300], [1000, 999], [7, 3], [1_000_003, 1000]]) {
      const t = new Thinning(total, target)
      const kept: number[] = []
      for (let i = 0; i < total; i++) if (t.keep()) kept.push(i)
      expect(kept.length).toBe(target)
      expect(t.kept).toBe(target)
      const gaps = kept.slice(1).map((k, i) => k - kept[i])
      expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1)
    }
  })

  it('keeps everything when the target is none, zero or not below the count', () => {
    for (const target of [0, 10, 11]) {
      const t = new Thinning(10, target)
      expect(t.kept).toBe(10)
      let n = 0
      for (let i = 0; i < 10; i++) if (t.keep()) n++
      expect(n).toBe(10)
    }
  })

  for (const format of ['binary_little_endian', 'ascii'] as const) {
    it(`thins a ${format} PLY cloud as it reads it, colours with their points`, () => {
      const buf = writePlyCloud(cloud, format, { extraAfter: ['uchar red', 'uchar green', 'uchar blue'] })
      const whole = parsePLY(buf)
      const thin = parsePLY(buf, undefined, { maxPoints: 100, chunk: 50 })
      expect(thin.positions.length).toBe(300)
      expect(thin.normals!.length).toBe(300)
      const t = new Thinning(N, 100)
      let w = 0
      for (let i = 0; i < N; i++) {
        if (!t.keep()) continue
        expect(Array.from(thin.positions.subarray(3 * w, 3 * w + 3))).toEqual(Array.from(whole.positions.subarray(3 * i, 3 * i + 3)))
        expect(Array.from(thin.colors!.subarray(3 * w, 3 * w + 3))).toEqual(Array.from(whole.colors!.subarray(3 * i, 3 * i + 3)))
        w++
      }
      // A larger target than the cloud leaves it whole.
      expect(parsePLY(buf, undefined, { maxPoints: N + 1 }).positions.length).toBe(N * 3)
    })
  }

  it('leaves a mesh whole whatever it is asked', () => {
    const ply = enc('ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n')
    const m = parsePLY(ply, undefined, { maxPoints: 1 })
    expect(m.positions.length).toBe(9)
    expect(Array.from(m.indices!)).toEqual([0, 1, 2])
  })

  it('thins an XYZ to at most the target, header lines and all', () => {
    const buf = writeXyz(cloud, { delim: ' ', columns: 'xyzn', header: ['X Y Z NX NY NZ'] })
    const whole = parseXYZ(buf)
    const thin = parseXYZ(buf, undefined, { maxPoints: 100, chunk: 33 })
    const points = thin.positions.length / 3
    expect(points).toBeLessThanOrEqual(100)
    expect(points).toBeGreaterThanOrEqual(99)
    // Every point kept is a point of the file, in its order.
    const key = (a: Float32Array, i: number) => `${a[3 * i]},${a[3 * i + 1]},${a[3 * i + 2]}`
    const index = new Map(Array.from({ length: N }, (_, i) => [key(whole.positions, i), i]))
    let previous = -1
    for (let k = 0; k < points; k++) {
      const i = index.get(key(thin.positions, k))!
      expect(i).toBeGreaterThan(previous)
      previous = i
    }
  })
})

describe('the points a cloud file holds, told before it is read', () => {
  it('counts a PLY cloud from its header, and leaves a mesh alone', () => {
    const buf = new Uint8Array(writePlyCloud(cloud, 'binary_little_endian'))
    expect(cloudSizeOf('a.ply', buf.subarray(0, 300), 50_000_000)).toEqual({ points: N, exact: true })
    const mesh = new TextEncoder().encode('ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n')
    expect(cloudSizeOf('m.ply', mesh, 1e9)).toBeNull()
    expect(cloudSizeOf('a.stl', buf, buf.length)).toBeNull()
  })

  it('counts a small text cloud and estimates a large one from its first rows', () => {
    const buf = new Uint8Array(writeXyz(cloud, { delim: ' ', columns: 'xyzn', header: ['# scanner'] }))
    expect(cloudSizeOf('a.xyz', buf, buf.length)).toEqual({ points: N, exact: true })
    const est = cloudSizeOf('a.pts', buf.subarray(0, 2000), buf.length)!
    expect(est.exact).toBe(false)
    expect(Math.abs(est.points - N) / N).toBeLessThan(0.1)
  })

  it('asks with the count and the target', () => {
    expect(thinQuestion('lucy.ply', 84_000_000, true)).toBe('lucy.ply holds 84,000,000 points — more than a browser tab holds well (30,000,000). OK thins it evenly to 30,000,000 points as it is read; Cancel opens all 84,000,000, which may take the tab down.')
    expect(thinQuestion('scan.xyz', 41_000_000, false)).toMatch(/^scan\.xyz holds about 41,000,000 points/)
  })
})

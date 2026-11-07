// SPDX-License-Identifier: AGPL-3.0-only
// Wrap's benchmark — not a test, so no limit on any figure: the time each
// step takes and the memory at its peak, on the inputs the plan measures it
// on. Two are made here: a box with ribs inside and a slot either side of
// the gap, and a box full of a lattice, ten million triangles; the rest are
// files given on the command line — a mesh each, or a folder of STLs read as
// one assembly.
//
//   npx vite-node plugins/mesh-tools/scripts/bench-wrap.ts -- [--gap mm] [--grow mm] [--only name] [--workers n] [--edges sharp|smooth] [file.stl | folder/] …
//
// Each runs at the gap the panel would start with for it, unless --gap says.
// The tiles' work runs on as many worker threads as the app would start —
// a core less than the machine has, at most eight — or on --workers;
// --workers 0 runs it all in this thread.
// Printed per input: triangles, the grid, tiles worked, the time of every
// step, and the peak of the process's memory (resident, and what the arrays
// take) read at each line of progress.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { build } from 'esbuild'
import { parseSTL } from '../../../src/core/parsers/stl'
import { buildMeshGraph } from '../../../src/core/geometry/buildGraph'
import { loadSimplifier } from '../core/reduce'
import { defaultWrapGap, WrapMemo, wrapMesh, type WrapReport } from '../core/wrap'
import { closedness } from '../core/boolean'
import { workerPool, type JobWorker, type WrapRunner } from '../core/wrapJobs'

interface Input {
  name: string
  positions: Float32Array
  indices: Uint32Array
}

const args = process.argv.slice(2).filter((a) => a !== '--')
const option = (name: string): string | null => {
  const at = args.indexOf(name)
  if (at < 0) return null
  const value = args[at + 1]
  args.splice(at, 2)
  return value
}
const gapArg = option('--gap')
const growArg = option('--grow')
const only = option('--only')
const workersArg = option('--workers')
const edges = (option('--edges') ?? 'sharp') as 'sharp' | 'smooth'
const workers = workersArg !== null ? Number(workersArg) : Math.max(1, Math.min(8, availableParallelism() - 1))

/** The tile worker for Node: wrapJobs on worker_threads, bundled so the
 *  thread need not read TypeScript. */
async function nodePool(size: number): Promise<WrapRunner> {
  const core = resolve(dirname(fileURLToPath(import.meta.url)), '../core')
  const outfile = join(tmpdir(), 'scanruler-bench-wrap-worker.mjs')
  await build({
    stdin: {
      contents: `
        import { parentPort } from 'node:worker_threads'
        import { runJob, resultBuffers } from './wrapJobs'
        import { loadSimplifier } from './reduce'
        let simplifier = null
        parentPort.on('message', async ({ id, job }) => {
          try {
            if (job.kind === 'r' && !simplifier) simplifier = await loadSimplifier()
            const result = runJob(job, simplifier)
            parentPort.postMessage({ id, result }, resultBuffers(result))
          } catch (e) {
            parentPort.postMessage({ id, error: String(e && e.message ? e.message : e) })
          }
        })`,
      resolveDir: core,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    logLevel: 'silent',
  })
  return workerPool(size, () => {
    const thread = new Worker(outfile)
    const worker: JobWorker = {
      onmessage: null,
      onerror: null,
      postMessage: (message, transfer) => thread.postMessage(message, transfer as never),
      terminate: () => void thread.terminate(),
    }
    thread.on('message', (data) => worker.onmessage?.({ data }))
    thread.on('error', (e) => worker.onerror?.({ message: e.message }))
    return worker
  })
}
const runner = workers > 0 ? await nodePool(workers) : undefined

/** A soup of triangles joined at its shared corners, as the app opens it. */
function welded(name: string, soup: Float32Array): Input {
  const g = buildMeshGraph({ kind: 'soup', positions: soup })
  return { name, positions: g.positions.slice(0, g.vertexCount * 3), indices: g.indices }
}

function readStl(path: string): Float32Array {
  const bytes = readFileSync(path)
  const parsed = parseSTL(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  if (parsed.kind !== 'soup') throw new Error(`${path}: not a triangle soup`)
  return parsed.positions
}

/** A box's six faces, as a soup, `n` by `n` quads a face. */
function boxSoup(min: number[], max: number[], n = 4, out: number[] = []): number[] {
  const corner = (u: number, v: number, axis: number, side: number) => {
    const p = [0, 0, 0]
    const a = (axis + 1) % 3, b = (axis + 2) % 3
    p[axis] = side ? max[axis] : min[axis]
    p[a] = min[a] + (u / n) * (max[a] - min[a])
    p[b] = min[b] + (v / n) * (max[b] - min[b])
    return p
  }
  for (let axis = 0; axis < 3; axis++) {
    for (let side = 0; side < 2; side++) {
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const q = [corner(i, j, axis, side), corner(i + 1, j, axis, side), corner(i + 1, j + 1, axis, side), corner(i, j + 1, axis, side)]
          const tris = side ? [[0, 1, 2], [0, 2, 3]] : [[0, 2, 1], [0, 3, 2]]
          for (const t of tris) for (const k of t) out.push(...q[k])
        }
      }
    }
  }
  return out
}

/** A closed box 100 × 60 × 40 with ribs and bosses standing inside it, and
 *  two slots cut 2 deep into its top: one a tenth narrower than the gap,
 *  one a tenth wider. */
function ribbedBox(gap: number): Input {
  const out: number[] = []
  const t = 3
  // The walls, each a block, overlapping at the corners.
  boxSoup([0, 0, 0], [100, 60, t], 8, out)
  boxSoup([0, 0, 0], [t, 60, 40], 8, out)
  boxSoup([100 - t, 0, 0], [100, 60, 40], 8, out)
  boxSoup([0, 0, 0], [100, t, 40], 8, out)
  boxSoup([0, 60 - t, 0], [100, 60, 40], 8, out)
  // The top: a plate, and on it three pieces with the two slots between
  // them, 2 deep — down to the plate, not through into the box.
  const narrow = 0.9 * gap, wide = 1.1 * gap
  boxSoup([0, 0, 40 - t], [100, 60, 38], 8, out)
  boxSoup([0, 0, 38], [33, 60, 40], 8, out)
  boxSoup([33 + narrow, 0, 38], [66, 60, 40], 8, out)
  boxSoup([66 + wide, 0, 38], [100, 60, 40], 8, out)
  // Ribs inside, a lattice of them, and bosses.
  for (let x = 10; x < 100; x += 10) boxSoup([x, t, t], [x + 1.5, 60 - t, 30], 6, out)
  for (let y = 10; y < 60; y += 10) boxSoup([t, y, t], [100 - t, y + 1.5, 25], 6, out)
  for (let x = 15; x < 100; x += 20) for (let y = 15; y < 60; y += 20) boxSoup([x - 3, y - 3, t], [x + 3, y + 3, 35], 4, out)
  return welded('ribbed box', Float32Array.from(out))
}

/** A box 100 mm a side, closed, filled with a lattice of round struts along
 *  the three axes — ten and a half million triangles, nearly all inside. */
function latticeBox(): Input {
  const SIDES = 12, RINGS = 256, R = 0.6, PITCH = 4, SIZE = 100
  const lines: number[] = []
  for (let c = PITCH; c < SIZE - 1; c += PITCH) lines.push(c)
  const struts = lines.length * lines.length * 3
  const perStrut = SIDES * (RINGS + 1)
  const positions = new Float32Array((struts * perStrut + 8) * 3)
  const indices = new Uint32Array((struts * SIDES * RINGS * 2 + 12) * 3)
  let v = 0, i = 0
  for (let axis = 0; axis < 3; axis++) {
    const a = (axis + 1) % 3, b = (axis + 2) % 3
    for (const ca of lines) {
      for (const cb of lines) {
        const base = v
        for (let ring = 0; ring <= RINGS; ring++) {
          for (let s = 0; s < SIDES; s++) {
            const angle = (2 * Math.PI * s) / SIDES
            const p = [0, 0, 0]
            p[axis] = (ring / RINGS) * SIZE
            p[a] = ca + R * Math.cos(angle)
            p[b] = cb + R * Math.sin(angle)
            positions.set(p, v * 3)
            v++
          }
        }
        for (let ring = 0; ring < RINGS; ring++) {
          for (let s = 0; s < SIDES; s++) {
            const p0 = base + ring * SIDES + s, p1 = base + ring * SIDES + ((s + 1) % SIDES)
            const q0 = p0 + SIDES, q1 = p1 + SIDES
            indices.set([p0, p1, q1, p0, q1, q0], i)
            i += 6
          }
        }
      }
    }
  }
  // The box round it.
  const c0 = v
  for (let k = 0; k < 8; k++) positions.set([k & 1 ? SIZE : 0, k & 2 ? SIZE : 0, k & 4 ? SIZE : 0], (v++) * 3)
  const faces = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]]
  for (const [p, q, r, s] of faces) {
    indices.set([c0 + p, c0 + q, c0 + r, c0 + p, c0 + r, c0 + s], i)
    i += 6
  }
  return { name: 'lattice box', positions: positions.subarray(0, v * 3), indices: indices.subarray(0, i) }
}

function fileInput(path: string): Input {
  if (statSync(path).isDirectory()) {
    const files = readdirSync(path).filter((f) => f.toLowerCase().endsWith('.stl')).sort()
    const soups = files.map((f) => readStl(join(path, f)))
    const all = new Float32Array(soups.reduce((n, s) => n + s.length, 0))
    let at = 0
    for (const s of soups) {
      all.set(s, at)
      at += s.length
    }
    return welded(`${basename(path)} (${files.length} parts)`, all)
  }
  return welded(basename(path), readStl(path))
}

const MB = 1024 * 1024
const ms = (x: number) => `${(x / 1000).toFixed(2)} s`

function diagonal(input: Input): number {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (let k = 0; k < input.positions.length; k++) {
    lo[k % 3] = Math.min(lo[k % 3], input.positions[k])
    hi[k % 3] = Math.max(hi[k % 3], input.positions[k])
  }
  return Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])
}

async function bench(name: string, make: () => Input): Promise<void> {
  if (only && !name.includes(only)) return
  const loaded = performance.now()
  const input = make()
  const loading = performance.now() - loaded
  const gap = gapArg !== null ? Number(gapArg) : defaultWrapGap(diagonal(input))
  const grow = growArg !== null ? Number(growArg) : 0
  const simplifier = await loadSimplifier()
  globalThis.gc?.()
  let peakRss = 0, peakArrays = 0
  const sample = () => {
    const m = process.memoryUsage()
    peakRss = Math.max(peakRss, m.rss)
    peakArrays = Math.max(peakArrays, m.heapUsed + m.arrayBuffers)
  }
  sample()
  const start = performance.now()
  let report: WrapReport
  let shut: { open: number; bad: number }
  const memo = new WrapMemo()
  try {
    const result = await wrapMesh(input.positions.slice(), input.indices.slice(), { gap, grow, edges }, simplifier, sample, runner, memo)
    report = result.report
    shut = closedness(result.indices, result.positions.length / 3)
  } catch (e) {
    console.log(`\n${input.name}: ${input.indices.length / 3} triangles, gap ${gap} — refused: ${e instanceof Error ? e.message : e}`)
    return
  }
  const total = performance.now() - start
  sample()
  console.log(`\n${input.name}`)
  console.log(
    `  ${(input.indices.length / 3).toLocaleString('en-US')} triangles in (read and welded in ${ms(loading)}), gap ${gap} mm, grow ${grow} mm, ${edges} edges, ` +
      (workers > 0 ? `${workers} worker threads` : 'one thread'),
  )
  console.log(
    `  cell ${report.cell.toFixed(4)} mm${report.coarsened ? ` (coarsened; ${report.fullGap} mm is the smallest gap closed as exactly)` : ''}, ` +
      `${report.tilesWorked.toLocaleString('en-US')} of ${report.tiles.toLocaleString('en-US')} tiles worked`,
  )
  console.log(
    `  out: ${report.shells} shell${report.shells === 1 ? '' : 's'}, ${report.triangles.toLocaleString('en-US')} triangles, ` +
      `${report.dropped.toLocaleString('en-US')} inside dropped, ${report.bridgedArea.toFixed(1)} mm² bridged, ${report.volume.toFixed(0)} mm³` +
      (edges === 'sharp' ? `, ${report.sharpEdges.toLocaleString('en-US')} edge points and ${report.sharpCorners} corners put back` : '') +
      (shut.open || shut.bad ? `, NOT CLOSED: ${shut.open} open, ${shut.bad} bad edges` : ', closed'),
  )
  for (const s of report.stages) console.log(`  ${s.name.padEnd(28)} ${ms(s.ms).padStart(9)}`)
  console.log(`  ${'total'.padEnd(28)} ${ms(total).padStart(9)}`)
  console.log(`  peak memory: ${(peakRss / MB).toFixed(0)} MB resident, ${(peakArrays / MB).toFixed(0)} MB heap and arrays`)
  // Grow by changed, the gap not: from the field kept.
  const regrow = grow > 0 ? grow / 2 : gap / 8
  const again = performance.now()
  try {
    const kept = (await wrapMesh(input.positions.slice(), input.indices.slice(), { gap, grow: regrow, edges }, simplifier, undefined, runner, memo)).report
    const used = kept.stages.some((s) => s.name === 'Kept from the wrap before')
    console.log(`  grow ${regrow} mm after it: ${ms(performance.now() - again)}${used ? ', the field kept' : ', measured again'}`)
  } catch (e) {
    console.log(`  grow ${regrow} mm after it: refused — ${e instanceof Error ? e.message : e}`)
  }
}

const gapForRibs = gapArg !== null ? Number(gapArg) : 1
await bench('ribbed box', () => ribbedBox(gapForRibs))
for (const path of args) await bench(basename(path), () => fileInput(path))
await bench('lattice box', latticeBox)
runner?.dispose()

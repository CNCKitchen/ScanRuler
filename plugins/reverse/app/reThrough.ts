// SPDX-License-Identifier: AGPL-3.0-only
// A fit's see-through source (fit.through, reverse.section.fit's through):
// the scan seen square onto a sheet through a band of heights about it,
// read by the mesh worker as a grid of rays, its outline traced into the
// chains a fit takes in place of the scan cut at the plane
// (core/seeThrough.ts).

import { invalid } from '../../../src/commands/core/common'
import { commandHost } from '../../../src/commands/host'
import type { Vec2 } from '../../../src/core/flat/types'
import { gridOver, sheetRays } from '../../../src/core/geometry/rayGrid'
import { round4 } from '../../../src/core/round'
import type { SectionFrame } from '../../../src/core/section/frame'
import type { Vec3 } from '../../../src/core/types'
import { CommandError } from '../../../src/plugins/api'
import { useStore } from '../../../src/state/store'
import { type WithinBox, withinOnSheet } from '../core/chainOutline'
import { maskChains, THROUGH_MIN_CELLS } from '../core/seeThrough'

/** mm either side of the plane (or of fit.level) the scan is seen in,
 *  unless told: a stamped sheet's beads and warp, not the wall behind. */
export const THROUGH_DEPTH = 1.5
/** The outline's tolerance unless told, mm; the cells are half of it,
 *  widened to keep THROUGH_CELLS at most — as scan.outline reads one. */
export const THROUGH_TOLERANCE = 0.2
export const THROUGH_CELLS = 250_000
/** The scan's vertices sampled for where it lies on the sheet. */
const THROUGH_SAMPLE = 20_000

/** fit.through as handed in: true, or the band to look through. */
export type ThroughIn = boolean | { depth?: [number, number] }

/** What the see-through read, as the answer gives it: the band of heights
 *  along the normal it saw the scan in, the cell, how many loops it found
 *  and how many of them are holes, the specks left out, and a note where
 *  the grid was widened. */
export interface ThroughOut {
  depth: [number, number]
  cell: number
  loops: number
  holes: number
  skipped?: number
  note?: string
}

/** The band fit.through looks through: its depth as given, else
 *  THROUGH_DEPTH either side of the level (0, the plane). */
export function throughBand(through: ThroughIn, level: number | undefined, where: string): [number, number] {
  const depth = typeof through === 'object' ? through.depth : undefined
  if (depth === undefined) {
    const at = level ?? 0
    return [at - THROUGH_DEPTH, at + THROUGH_DEPTH]
  }
  if (level !== undefined) invalid(`${where}.depth is counted from the plane — leave level out, or the depth out and the band is level ± ${THROUGH_DEPTH}.`)
  if (!Array.isArray(depth) || depth.length !== 2 || !depth.every(Number.isFinite) || !(depth[0] < depth[1])) invalid(`${where}.depth: [from, to], mm along the normal from the plane, from below to — [-1, 1] about the plane.`) // units-ok: a command's error — the commands take and answer mm
  return [depth[0], depth[1]]
}

/**
 * The scan seen square onto `frame` through the band [from, to] of heights
 * along its normal, as chains on its sheet: a grid of rays from `to` back
 * to `from` (sheetRays), a cell set where one meets the scan, the loops
 * round the set cells traced and evened out (maskChains). The grid spans
 * the box `within` asks for, a little more, else the scan in the band as
 * a sample of it lies on the sheet; its cell is half the tolerance,
 * widened to keep THROUGH_CELLS.
 */
export async function throughOn(frame: SectionFrame, band: [number, number], opts: { tolerance?: number; within?: WithinBox; where?: string }): Promise<{ chains: Vec2[][]; holes: boolean[]; through: ThroughOut }> {
  if (!useStore.getState().fileName) throw new CommandError('no_scan', 'There is no scan to see through.')
  const worker = commandHost().session.clientRef.current
  if (!worker) throw new CommandError('unavailable', 'The mesh worker is not running.')
  const [from, to] = band
  const where = opts.where ?? 'fit.through'
  const tolerance = opts.tolerance ?? THROUGH_TOLERANCE
  const asked = tolerance / 2
  const { origin: o, basisU: u, basisV: v, normal: n } = frame
  const onSheet = (p: Vec3): Vec3 => {
    const d = [p[0] - o[0], p[1] - o[1], p[2] - o[2]]
    return [d[0] * u[0] + d[1] * u[1] + d[2] * u[2], d[0] * v[0] + d[1] * v[1] + d[2] * v[2], d[0] * n[0] + d[1] * n[1] + d[2] * n[2]]
  }
  let lo: Vec2 = [Infinity, Infinity]
  let hi: Vec2 = [-Infinity, -Infinity]
  const take = (p: Vec3) => {
    lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1])]
    hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1])]
  }
  const w = opts.within
  if (w && !('world' in w)) {
    take([w.min[0], w.min[1], 0])
    take([w.max[0], w.max[1], 0])
  } else if (w) {
    // The world box's corners laid on the sheet.
    for (let k = 0; k < 8; k++) take(onSheet([k & 1 ? w.world.max[0] : w.world.min[0], k & 2 ? w.world.max[1] : w.world.min[1], k & 4 ? w.world.max[2] : w.world.min[2]]))
  } else {
    const sample = (await worker.query({ min: [-Infinity, -Infinity, -Infinity], max: [Infinity, Infinity, Infinity], limit: THROUGH_SAMPLE })).positions
    let hLo = Infinity
    let hHi = -Infinity
    for (let i = 0; i + 2 < sample.length; i += 3) {
      const p = onSheet([sample[i], sample[i + 1], sample[i + 2]])
      hLo = Math.min(hLo, p[2])
      hHi = Math.max(hHi, p[2])
      if (p[2] >= from && p[2] <= to) take(p)
    }
    if (!Number.isFinite(lo[0])) invalid(`${where}: no scan lies ${from}…${to} mm along the plane’s normal from it — the scan lies at ${round4(hLo)}…${round4(hHi)}. Give a depth round the sheet, or a plane on it.`) // units-ok: a command's error — the commands take and answer mm
  }
  // Room round the box: a loop it would cut is closed past its edge, where
  // within cuts it off again.
  const pad = 4 * asked + 0.01 * Math.max(hi[0] - lo[0], hi[1] - lo[1])
  const g = gridOver([lo[0] - pad, lo[1] - pad, from], [hi[0] + pad, hi[1] + pad, to], 2, asked, 1, THROUGH_CELLS)
  const hits = await worker.heights(sheetRays(frame, g, from, to))
  const mask = new Uint8Array(hits.length)
  let met = 0
  for (let i = 0; i < hits.length; i++) {
    if (Number.isNaN(hits[i])) continue
    mask[i] = 1
    met++
  }
  if (met === 0) invalid(`${where}: no ray met the scan ${from}…${to} mm along the plane’s normal from it${w ? ' in the box (within)' : ''} — give a depth round the sheet.`) // units-ok: a command's error — the commands take and answer mm
  const seen = maskChains(mask, { cols: g.cols, rows: g.rows, cell: g.cell, u0: g.u0, v0: g.v0 })
  if (w) {
    // The grid's own edge, past the box, closes the sheet round it: a loop
    // with no point in the box is that, not the sheet's.
    const { box, where: inside } = withinOnSheet(w, frame)
    const keep = seen.chains.map((c) => c.some((p) => (!box || (p[0] >= box.min[0] && p[0] <= box.max[0] && p[1] >= box.min[1] && p[1] <= box.max[1])) && (!inside || inside(p))))
    seen.chains = seen.chains.filter((_, i) => keep[i])
    seen.holes = seen.holes.filter((_, i) => keep[i])
  }
  if (seen.chains.length === 0) invalid(`${where}: the scan fills the band ${from}…${to} mm${w ? ' over the whole box (within)' : ''} — no edge or hole to trace.${seen.skipped > 0 ? ` ${seen.skipped} speck${seen.skipped === 1 ? '' : 's'} under ${THROUGH_MIN_CELLS} cells across left out.` : ''}`) // units-ok: a command's error — the commands take and answer mm
  return {
    chains: seen.chains,
    holes: seen.holes,
    through: {
      depth: [from, to],
      cell: g.cell,
      loops: seen.chains.length,
      holes: seen.holes.filter(Boolean).length,
      ...(seen.skipped > 0 ? { skipped: seen.skipped } : {}),
      // units-ok: the answer's note, for the agent — in millimetres always.
      ...(g.widened ? { note: `cell widened to ${g.cell} mm to keep ${THROUGH_CELLS} cells at most; the outline is traced to it — give within round the part looked for to read it finer` } : {}),
    },
  }
}

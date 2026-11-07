// SPDX-License-Identifier: AGPL-3.0-only
// The grids of parallel rays the scan is read over from one side: how fine
// their cells are, over a box, and a grid laid square onto a sheet that
// meets only the scan within a band of heights off it — a sheet seen
// through, without what lies behind it.

import { niceCeil } from '../field/stats'
import type { SectionFrame } from '../section/frame'
import type { Vec3 } from '../types'
import { acrossAxes, type RayGrid } from './scanQa'

/** A grid of cells over the box across axis `k`, centred on it: the cell
 *  asked for, or the round size that makes the longer side `side` cells —
 *  widened until there are no more than `most` cells. */
export function gridOver(min: Vec3, max: Vec3, k: 0 | 1 | 2, cell: number | undefined, side: number, most: number) {
  const [ua, va] = acrossAxes(k)
  const du = Math.max(max[ua] - min[ua], 1e-6)
  const dv = Math.max(max[va] - min[va], 1e-6)
  let c = cell ?? niceCeil(Math.max(du, dv) / side)
  let widened = false
  while (Math.ceil(du / c) * Math.ceil(dv / c) > most) {
    c = niceCeil(c * 1.01)
    widened = true
  }
  const cols = Math.max(1, Math.ceil(du / c))
  const rows = Math.max(1, Math.ceil(dv / c))
  const u0 = (min[ua] + max[ua]) / 2 - (cols * c) / 2
  const v0 = (min[va] + max[va]) / 2 - (rows * c) / 2
  return { ua, va, cell: c, cols, rows, u0, v0, widened }
}

/** A grid of rays square onto a sheet over [u0, v0] + cols × rows cells,
 *  each starting `to` mm out along the normal and running back to `from`:
 *  its first hit is the scan within that band of heights, and a ray that
 *  meets none there sees through. */
export function sheetRays(frame: SectionFrame, g: { cell: number; cols: number; rows: number; u0: number; v0: number }, from: number, to: number): RayGrid {
  const { origin: o, basisU: u, basisV: v, normal: n } = frame
  return {
    origin: [0, 1, 2].map((j) => o[j] + g.u0 * u[j] + g.v0 * v[j] + to * n[j]) as Vec3,
    dir: [-n[0], -n[1], -n[2]],
    u,
    v,
    cell: g.cell,
    cols: g.cols,
    rows: g.rows,
    far: to - from,
  }
}

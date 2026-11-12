// SPDX-License-Identifier: AGPL-3.0-only
// One grid over a point cloud's points, built the first time something
// queries them and shared by all that do (rays against points, the patch each
// point stands for). The worker moves a graph's points in place when an
// alignment is baked in, so it lets the grid go then (forgetCloudGrid): a grid
// bins the points where they were.
import type { MeshGraph } from '../types'
import { PointGrid } from './pointGrid'

/** Cell edge, in point spacings: a few points a cell on a scanned surface. */
const CELL_SPACINGS = 2.5

const grids = new WeakMap<MeshGraph, PointGrid>()

/** The grid over a cloud graph's points; `spacing` stands in for a graph
 *  that does not carry its own. */
export function cloudGridOf(g: MeshGraph, spacing = g.spacing ?? 0): PointGrid {
  let grid = grids.get(g)
  if (!grid || grid.positions !== g.positions) {
    grid = new PointGrid(g.positions, CELL_SPACINGS * spacing)
    grids.set(g, grid)
  }
  return grid
}

/** Let the grid over `g` go: its points have moved. */
export function forgetCloudGrid(g: MeshGraph): void {
  grids.delete(g)
}

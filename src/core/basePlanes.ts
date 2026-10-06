// SPDX-License-Identifier: AGPL-3.0-only
// The coordinate planes, offered beside the plane elements wherever a plane is
// asked for as a reference — the seed of a symmetry search, the plane an
// element is aligned to. After a datum alignment or Auto-align they are the
// part's own; before one, wherever the scanner left them.
//
// They go by negative ids so they never meet an element's, and the ids are
// saved in projects, so they never change.

import type { Vec3 } from './types'

export interface BasePlane {
  id: number
  name: string
  normal: Vec3
}

export const BASE_PLANES: readonly BasePlane[] = [
  { id: -1, name: 'XY plane', normal: [0, 0, 1] },
  { id: -2, name: 'YZ plane', normal: [1, 0, 0] },
  { id: -3, name: 'ZX plane', normal: [0, 1, 0] },
]

export function basePlaneOf(id: number): BasePlane | undefined {
  return BASE_PLANES.find((p) => p.id === id)
}

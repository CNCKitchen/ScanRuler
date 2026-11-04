// SPDX-License-Identifier: AGPL-3.0-only
import type { Vec3 } from '../../../src/core/types'

/** A sheet with an open bay, like a scan missing surface at its border. */
export function bridgeFixture(curvature = 0, rightStep = 1) {
  const positions: number[] = []
  const indices: number[] = []
  const rows = new Map<string, number>()
  const point = (x: number, y: number) => {
    const key = `${x},${y}`
    let id = rows.get(key)
    if (id === undefined) {
      id = positions.length / 3
      rows.set(key, id)
      positions.push(x, y, curvature * x * x)
    }
    return id
  }
  for (let x = -12; x < 12; x++) {
    for (let y = -8; y < 8;) {
      const step = x >= 3 && y >= 0 ? rightStep : 1
      if (x >= -3 && x < 3 && y >= 0) { y += step; continue }
      const a = point(x, y), b = point(x + 1, y), c = point(x + 1, y + step), d = point(x, y + step)
      indices.push(a, b, c, a, c, d)
      y += step
    }
  }
  const points: Vec3[] = [-11, -7, -3, 3, 7, 11].map((x) => [x, 4, curvature * x * x])
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices), vertexCount: positions.length / 3, points }
}

/** Uneven opposing rims with oblique surface guides and an unchanged open bay. */
export function angledBridgeFixture(curvature = 0, first = 3, second = 3, reversed = false) {
  const g = bridgeFixture()
  const shift = (y: number) => {
    const lo = Math.floor(y), f = y - lo
    return 0.5 * ((1 - f) * Math.sin(lo * 2) + f * Math.sin((lo + 1) * 2))
  }
  const onSurface = (x: number, y: number): Vec3 => {
    const vertex = (xx: number, yy: number): Vec3 => {
      const shifted = xx + (xx < 0 ? -1 : 1) * shift(yy)
      return [shifted, yy, curvature * shifted * shifted]
    }
    const lo = Math.floor(x), bottom = Math.floor(y)
    const u = x - lo, v = y - bottom
    const corners = u >= v
      ? [[vertex(lo, bottom), 1 - u], [vertex(lo + 1, bottom), u - v], [vertex(lo + 1, bottom + 1), v]] as const
      : [[vertex(lo, bottom), 1 - v], [vertex(lo + 1, bottom + 1), u], [vertex(lo, bottom + 1), v - u]] as const
    const coordinate = (k: number) => corners.reduce((sum, [p, weight]) => sum + p[k] * weight, 0)
    return [coordinate(0), coordinate(1), coordinate(2)]
  }
  const positions = g.positions.slice()
  for (let i = 0; i < positions.length; i += 3) {
    const [x] = onSurface(positions[i], positions[i + 1])
    positions[i] = x
    positions[i + 2] = curvature * x * x
  }
  const sideA = Array.from({ length: first }, (_, i) => {
    const t = i / (first - 1)
    return onSurface(-7 + 4 * t, 1 + 3 * t)
  })
  const sideB = Array.from({ length: second }, (_, i) => {
    const t = i / (second - 1)
    return onSurface(3 + 4 * t, 4 - 3 * t)
  })
  const points = reversed ? [...sideA, ...sideB].reverse() : [...sideA, ...sideB]
  return { ...g, positions, points, firstSideCount: reversed ? second : first }
}

// SPDX-License-Identifier: AGPL-3.0-only
import { Vector3 } from 'three'
import type { MeshGraph, Vec3 } from '../../../src/core/types'
import { emptyHit, type NominalSurface } from '../../../src/core/deviation/surface'
import { bridgeGap, BridgeGuidanceError, type BridgeResult, type BridgeSettings } from './bridge'

/** Search surface-projected guide placements, not reduced bridge tangents.
 * Rim picks and width stay fixed. Nothing is changed until a full check passes. */
export function adjustBridgePoints(
  mesh: Pick<MeshGraph, 'positions' | 'indices' | 'vertexCount' | 'adjOffsets' | 'adjList'>,
  settings: Omit<BridgeSettings, 'bend'>,
  surfaceOf: () => NominalSurface,
): { result: BridgeResult; points: Vec3[]; moved: number[] } {
  const { positions, indices, vertexCount, adjOffsets, adjList } = mesh
  const original = settings.points.map((p): Vec3 => [...p])
  const first = settings.firstSideCount ?? 3
  const affected = new Set<number>()
  const include = (error: BridgeGuidanceError) => {
    let added = false
    for (const index of error.guidance.points) {
      if (index === first - 1 || index === first || affected.has(index)) continue
      affected.add(index)
      added = true
    }
    return added
  }
  try {
    return { result: bridgeGap(positions, indices, vertexCount, { ...settings, bend: 1 }), points: original, moved: [] }
  } catch (error) {
    if (!(error instanceof BridgeGuidanceError) || !error.guidance.canReduceBend) throw error
    include(error)
  }
  const surface = surfaceOf()
  const inner = new Vector3(...original[first - 1])
  const axis = new Vector3(...original[first]).sub(inner).normalize()
  const samples = original.map((p) => new Vector3(...p))
  const tolerance = Math.max(1e-6, inner.distanceTo(samples[first]) * 1e-7)
  const guides = new Map<number, {
    target: Vector3
    normal: Vector3
    limit: number
    connected: Set<number>
  }>()
  const guideOf = (index: number) => {
    const cached = guides.get(index)
    if (cached) return cached
    const anchor = samples[index < first ? first - 1 : first]
    const side = index < first ? samples.slice(0, first) : samples.slice(first)
    const limit = Math.max(...side.map((p) => p.distanceTo(anchor))) / 2
    const sample = samples[index]
    const hit = emptyHit()
    if (!surface.closest(...original[index], hit, tolerance) || hit.distance > tolerance) {
      throw new Error(`Guide point ${index + 1} is not on the current scan. Pick it again before adjusting guides.`)
    }
    const normal = new Vector3(hit.nx, hit.ny, hit.nz)
    const target = inner.clone().addScaledVector(axis, sample.clone().sub(inner).dot(axis))
    // Restrict projection to the original guide's local connected patch:
    // a nearby, similarly facing but disconnected sheet is not a valid move.
    const connected = new Set<number>()
    const queue: number[] = []
    for (let k = 0; k < 3; k++) {
      const v = surface.index[hit.faceIndex * 3 + k]
      if (!connected.has(v)) { connected.add(v); queue.push(v) }
    }
    const at = new Vector3()
    for (let i = 0; i < queue.length; i++) {
      const v = queue[i]
      for (let k = adjOffsets[v]; k < adjOffsets[v + 1]; k++) {
        const next = adjList[k]
        if (connected.has(next) || at.fromArray(positions, next * 3).distanceToSquared(sample) > limit * limit) continue
        connected.add(next)
        queue.push(next)
      }
    }
    const guide = { target, normal, limit, connected }
    guides.set(index, guide)
    return guide
  }
  const candidate = (amount: number): { result: BridgeResult; points: Vec3[]; moved: number[] } | null => {
    // Validation may expose the other side only after the first side is repaired.
    for (let attempt = 0; attempt < original.length; attempt++) {
      const points: Vec3[] = original.map((p) => [...p])
      const moved: number[] = []
      for (const index of affected) {
        const guide = guideOf(index)
        const target = samples[index].clone().lerp(guide.target, amount)
        const hit = emptyHit()
        if (!surface.closestFacing(target.x, target.y, target.z,
          guide.normal.x, guide.normal.y, guide.normal.z, 0.5, hit, guide.limit)) return null
        if ([0, 1, 2].some((k) => !guide.connected.has(surface.index[hit.faceIndex * 3 + k]))) return null
        const point = new Vector3(hit.px, hit.py, hit.pz)
        const distance = point.distanceTo(samples[index])
        if (distance > guide.limit || !Number.isFinite(distance)) return null
        if (distance > tolerance) {
          points[index] = [hit.px, hit.py, hit.pz]
          moved.push(index)
        }
      }
      if (!moved.length) return null
      try {
        const result = bridgeGap(positions, indices, vertexCount, { ...settings, points, bend: 1 })
        return { result, points, moved: moved.sort((a, b) => a - b) }
      } catch (error) {
        if (!(error instanceof BridgeGuidanceError)) throw error
        if (!error.guidance.canReduceBend || !include(error)) return null
      }
    }
    return null
  }
  for (let step = 1; step <= 8; step++) {
    let low = (step - 1) / 8, high = step / 8
    let checked = candidate(high)
    if (!checked) continue
    for (let i = 0; i < 6; i++) {
      const middle = (low + high) / 2
      const result = candidate(middle)
      if (result) { high = middle; checked = result }
      else low = middle
    }
    return checked
  }
  throw new Error('Adjusting surface guides found no valid bridge with these rim points and width. Points were kept. Move guides manually, choose a narrower bridge, or try Reduce bend.')
}

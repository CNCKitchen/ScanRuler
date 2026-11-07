// SPDX-License-Identifier: AGPL-3.0-only
// What one click on a face takes for a Delete face: the whole of the round,
// the hole or the boss the face is part of, so the kernel has a feature to
// take off and heal over rather than a face out of the middle of one.

import type { EdgeInfo, FaceInfo } from './buildTypes'
import { edgeShares, type EdgeJoin } from './edgeLines'
import type { KernelMesh } from './kernelTypes'
import { onOneSurface } from './topo'

/** A body's faces and edges, as the build hands them out. */
export interface FaceGroupTopology {
  faces: readonly FaceInfo[]
  edges: readonly EdgeInfo[]
}

/** How the faces either side of each of a body's edges meet, by the edge's
 *  hash — read off its mesh, as the viewport draws the edges; with
 *  `tangentDeg`, faces within that many degrees of each other meet
 *  tangent. */
export function edgeJoins(mesh: KernelMesh, topology: FaceGroupTopology, tangentDeg?: number): Map<number, EdgeJoin> {
  if (!mesh.faceHash) return new Map()
  const byHash = new Map(topology.faces.map((f) => [f.hash, f.fingerprint]))
  const oneSurface = (a: number, b: number) => {
    const fa = byHash.get(a)
    const fb = byHash.get(b)
    return fa !== undefined && fb !== undefined && onOneSurface(fa, fb)
  }
  const cos = tangentDeg === undefined ? undefined : Math.cos((tangentDeg * Math.PI) / 180)
  return edgeShares(mesh.positions, mesh.normals, mesh.indices, mesh.faceHash, topology.edges, oneSurface, cos).joins
}

/** A round a tangent flood runs on into: a face of a fillet's chain — not
 *  a flat, which is what a round runs into either side, nor a whole-turn
 *  cylinder or cone, which is a boss's wall or a bore's. */
function blend(f: FaceInfo): boolean {
  const kind = f.fingerprint.kind
  if (kind === 'plane') return false
  if ((kind === 'cylinder' || kind === 'cone') && f.fullTurn !== false) return false
  return true
}

/**
 * The faces, by hash, a click on `seed` takes for a delete:
 *
 * - the face, and the faces it was split from on its own surface — the two
 *   halves of a bore, which the viewport draws as one face;
 * - with `tangent`, from a round face on along every edge it meets another
 *   round at tangent (`blend`) — the whole of a fillet's chain, up to the
 *   flats either side, a boss's wall with the round at its foot;
 * - then every face the faces taken close in on all sides — the floor of a
 *   blind hole, the top of a boss, a drill point's cone — but not a flat
 *   the rounds run into smoothly all the way round: a block rounded on
 *   every edge keeps its flats.
 *
 * `joinOf` says how an edge's faces meet (edgeJoins).
 */
export function deleteFaceGroup(topology: FaceGroupTopology, seed: number, joinOf: (edge: number) => EdgeJoin | undefined, tangent: boolean): number[] {
  const faceByHash = new Map(topology.faces.map((f) => [f.hash, f]))
  if (!faceByHash.has(seed)) return []
  const edgesOf = new Map<number, EdgeInfo[]>()
  for (const e of topology.edges) for (const f of new Set(e.faces)) edgesOf.set(f, [...(edgesOf.get(f) ?? []), e])
  const taken = new Set([seed])
  const order = [seed]
  const queue = [seed]
  while (queue.length > 0) {
    const at = faceByHash.get(queue.shift()!)!
    for (const e of edgesOf.get(at.hash) ?? []) {
      const other = e.faces.find((f) => f !== at.hash)
      if (other === undefined || taken.has(other)) continue
      const next = faceByHash.get(other)
      if (!next) continue
      const join = joinOf(e.hash)
      const split = join === 'split' && onOneSurface(at.fingerprint, next.fingerprint)
      // A boss's or a bore's wall clicked runs on into the round at its
      // foot or its mouth; past that, rounds only.
      const from = blend(at) || (at.hash === seed && at.fingerprint.kind !== 'plane')
      if (!split && !(tangent && join === 'tangent' && from && blend(next))) continue
      taken.add(other)
      order.push(other)
      queue.push(other)
    }
  }
  // The faces closed in: every edge of the face has a face taken on its
  // other side — a floor, a cap — where it meets them at an edge somewhere,
  // or they hold a bore's or a boss's wall. A flat the rounds of a block run
  // into smoothly all round is what they round, not a part of them.
  for (let grew = true; grew; ) {
    grew = false
    const wall = [...taken].some((h) => {
      const f = faceByHash.get(h)!
      return (f.fingerprint.kind === 'cylinder' || f.fingerprint.kind === 'cone') && f.fullTurn !== false
    })
    for (const f of topology.faces) {
      if (taken.has(f.hash)) continue
      const round = (edgesOf.get(f.hash) ?? []).flatMap((e) => {
        const other = e.faces.find((x) => x !== f.hash)
        return other === undefined ? [] : [{ other, join: joinOf(e.hash) }]
      })
      if (round.length === 0 || !round.every((r) => taken.has(r.other))) continue
      if (!wall && !round.some((r) => r.join === 'sharp' || r.join === undefined)) continue
      taken.add(f.hash)
      order.push(f.hash)
      grew = true
    }
  }
  return order
}

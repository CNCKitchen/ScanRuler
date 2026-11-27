// SPDX-License-Identifier: AGPL-3.0-only
// Stretch as the panel stands: the direction, the cut, the amount and the
// piece the store holds turned into what the worker takes (core/stretch) —
// the one reading the preview, the edit and the commands share — and the
// measured features the stretch would put out of shape.

import type { FitData, Vec3 } from '../../../src/core/types'
import type { PluginGrip } from '../../../src/viewer/SceneManager'
import { refAxisOf } from '../core/cutPlane'
import type { StretchSettings } from '../core/stretch'
import type { useMeshTools } from '../state/meshStore'

type MeshState = ReturnType<typeof useMeshTools.getState>

type Elements = readonly { id: number; name: string; fit?: FitData | null }[]

export interface StretchSetup {
  settings: StretchSettings
  /** What it is stretched along, as the panel names it: "X", or the
   *  element's name. */
  axisName: string
}

/** The arrows on the cut, as the viewport names them when they are dragged:
 *  one pointing back along the direction, one on along it — each slides the
 *  cut, nothing else — and the colour they wear, the preview's magenta. */
export const STRETCH_CUT_BACK = 'stretch-cut-back'
export const STRETCH_CUT_ON = 'stretch-cut-on'
export const STRETCH_GRIP_COLOR = '#d6409f'

/** The two arrows on the cut, at `centre`, along the direction `n` — each a
 *  little off the cut, so the two read as two. */
export function stretchGrips(centre: Vec3, n: Vec3): PluginGrip[] {
  return [
    { side: STRETCH_CUT_BACK, shape: 'arrow', position: centre, dir: [-n[0], -n[1], -n[2]], size: 48, pixels: true, standoff: 10 },
    { side: STRETCH_CUT_ON, shape: 'arrow', position: centre, dir: n, size: 48, pixels: true, standoff: 10 },
  ]
}

/** Whether the piece clicked is what moves: asked for, and the part past the
 *  cut falls into more than one piece there — as far as the last preview
 *  says; with none yet, it may. With one piece there is nothing to pick:
 *  the whole part past the cut moves, and the panel does not offer it. */
export function pickingPiece(m: Pick<MeshState, 'stretchScope'> & { stretchPreview?: MeshState['stretchPreview'] }): boolean {
  return m.stretchScope === 'piece' && (m.stretchPreview?.pieces ?? 2) > 1
}

/** The stretch the panel asks for — null with nothing to stretch along. */
export function stretchSetupOf(
  m: Pick<MeshState, 'stretchRef' | 'stretchAt' | 'stretchAtAuto' | 'stretchAmount' | 'stretchScope' | 'stretchPiece'> & {
    stretchPreview?: MeshState['stretchPreview']
  },
  elements: Elements,
): StretchSetup | null {
  const axis = refAxisOf(m.stretchRef, elements)
  if (!axis) return null
  return {
    axisName: axis.name,
    settings: {
      origin: axis.origin,
      dir: axis.dir,
      at: m.stretchAtAuto ? null : m.stretchAt,
      amount: m.stretchAmount,
      piece: pickingPiece(m) ? m.stretchPiece : null,
    },
  }
}

/** A feature lying square to the direction within this of square — a
 *  bore along it gets longer and stays round, a circle in a plane across it
 *  only moves. */
const ALONG_COS = Math.cos((5 * Math.PI) / 180)

/**
 * The measured features a stretch puts out of round, by name: those the cut
 * goes through, for a section put in — or those reaching into the slab from
 * `from` to `to`, for one taken out — a bore across the direction made a
 * slot, a ball an egg, a circle an ellipse. A bore along the direction only
 * gets longer or shorter, and a circle square to it only moves, so neither
 * is named. What has not been measured is not known of.
 */
export function featuresCut(elements: Elements, origin: Vec3, dir: Vec3, from: number, to: number = from): string[] {
  const len = Math.hypot(dir[0], dir[1], dir[2])
  if (!(len > 0) || !(to >= from)) return []
  const n: Vec3 = [dir[0] / len, dir[1] / len, dir[2] / len]
  const at = (p: Vec3) => (p[0] - origin[0]) * n[0] + (p[1] - origin[1]) * n[1] + (p[2] - origin[2]) * n[2]
  const cosTo = (a: Vec3) => {
    const l = Math.hypot(a[0], a[1], a[2])
    return l > 0 ? Math.abs((a[0] * n[0] + a[1] * n[1] + a[2] * n[2]) / l) : 1
  }
  // A feature reaching across the cut by more than a hair: one that only
  // touches it is not stretched.
  const hair = 1e-4
  const reaches = (mid: number, half: number) => mid + half > from + hair && mid - half < to - hair
  const names: string[] = []
  for (const el of elements) {
    const f = el.fit
    if (!f) continue
    let hit = false
    if (f.kind === 'cylinder' || f.kind === 'cone') {
      const c = cosTo(f.axis)
      const r = f.kind === 'cone' ? Math.max(f.radius1, f.radius2) : f.radius
      hit = c < ALONG_COS && reaches(at(f.center), (c * f.length) / 2 + r * Math.sqrt(1 - c * c))
    } else if (f.kind === 'sphere') {
      hit = reaches(at(f.center), f.radius)
    } else if (f.kind === 'circle') {
      const c = cosTo(f.normal)
      hit = c < ALONG_COS && reaches(at(f.center), f.radius * Math.sqrt(1 - c * c))
    }
    if (hit) names.push(el.name)
  }
  return names
}

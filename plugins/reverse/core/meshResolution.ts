// SPDX-License-Identifier: AGPL-3.0-only
// How finely the bodies are meshed for an STL or a 3MF (issue 89): a few
// named steps, each a chord — how far a triangle may stand off a curved
// face, mm — and an angle — how far round a curve one triangle may turn.
// The chord holds a large part's curves; on a small part, where any chord is
// coarse against its size, the angle does. Normal is what the mesh export
// always wrote; the panel and the command take any of them.

export interface MeshResolution {
  id: 'draft' | 'normal' | 'fine' | 'finest'
  label: string
  /** mm. */
  chord: number
  /** Degrees. */
  angleDeg: number
}

export const MESH_RESOLUTIONS: readonly MeshResolution[] = [
  { id: 'draft', label: 'Draft', chord: 0.1, angleDeg: 15 },
  // 0.1 rad: the angle the export always used.
  { id: 'normal', label: 'Normal', chord: 0.02, angleDeg: (0.1 * 180) / Math.PI },
  { id: 'fine', label: 'Fine', chord: 0.005, angleDeg: 2.5 },
  { id: 'finest', label: 'Finest', chord: 0.001, angleDeg: 1 },
]

export const DEFAULT_MESH_RESOLUTION: MeshResolution['id'] = 'normal'

export function meshResolution(id: string | undefined): MeshResolution {
  return MESH_RESOLUTIONS.find((r) => r.id === id) ?? MESH_RESOLUTIONS.find((r) => r.id === DEFAULT_MESH_RESOLUTION)!
}

/** A part smaller across than this, mm, was most likely scanned in metres
 *  and read as millimetres — a phone scanning app's file: everything built
 *  on it a thousand times too small, and a slicer meshing its STEP to a
 *  tolerance meant for a part of a real size. */
export const TINY_PART_MM = 2

/** What to say of a part `across` mm across that small, or null — the
 *  length written by `fmt`, in the units shown. */
export function tinyPartNote(across: number, fmt: (mm: number) => string): string | null {
  if (!(across > 0) || across >= TINY_PART_MM) return null
  return `The part is only ${fmt(across)} across — its scan was most likely in metres, read as millimetres. Open the scan again in metres (the units window asks for an STL — Settings → Files brings it back — or Scale part in 3D Measure) and rebuild; a file of a part this small is meshed to nothing much by a slicer, whatever its resolution.`
}

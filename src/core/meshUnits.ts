// SPDX-License-Identifier: AGPL-3.0-only
// The units a mesh file's coordinates are in. The instrument measures in
// millimetres and nothing else; a file in anything else is scaled to
// millimetres as it is read, in the worker, before the mesh is welded, so
// that every fit, reading and export downstream is in millimetres like every
// other. An STL carries no units at all — a 1 in the file is whatever the
// program that wrote it meant — which is why the STL import asks; a PLY or
// OBJ is taken in millimetres, as before, and a STEP says its own.

import { isStepFile } from './formats'

export type MeshUnits = 'mm' | 'cm' | 'm' | 'in'

export const MESH_UNITS: { id: MeshUnits; label: string; mmPerUnit: number }[] = [
  { id: 'mm', label: 'Millimetres', mmPerUnit: 1 },
  { id: 'cm', label: 'Centimetres', mmPerUnit: 10 },
  { id: 'm', label: 'Metres', mmPerUnit: 1000 },
  { id: 'in', label: 'Inches', mmPerUnit: 25.4 },
]

/** How many millimetres one unit of the file is. */
export function mmPerUnit(units: MeshUnits): number {
  return MESH_UNITS.find((u) => u.id === units)?.mmPerUnit ?? 1
}

/** The factor a file's coordinates are multiplied by on reading: its units'
 *  millimetres, times any `scale` it was scaled by to its true size. A STEP
 *  says its own units and arrives from the kernel in millimetres already, so
 *  units asked of it — an agent's units "in" — must not scale it again: the
 *  part came out 25.4 times too big (issue 34). */
export function fileScale(name: string, units: MeshUnits, scale = 1): number {
  return (isStepFile(name) ? 1 : mmPerUnit(units)) * scale
}

export function unitsLabel(units: MeshUnits): string {
  return MESH_UNITS.find((u) => u.id === units)?.label ?? units
}

/** A stored or received value as units, or null when it is not one. */
export function meshUnitsOf(value: unknown): MeshUnits | null {
  return MESH_UNITS.some((u) => u.id === value) ? (value as MeshUnits) : null
}

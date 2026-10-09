// SPDX-License-Identifier: AGPL-3.0-only
// The scan: opening one, and finding places on it.

import { MESH_UNITS, type MeshUnits } from '../../core/meshUnits'
import { useStore } from '../../state/store'
import { commandHost } from '../host'
import { locationSchema, resolveLocation, type Location } from '../refs'
import { bytes, enumOf, obj } from '../schema'
import { scanBounds } from '../state'
import { CommandError, type Command } from '../types'
import { discardSchema, fileNameSchema, fileOf, lastError, requireDiscardable } from './common'

export const unitsSchema = enumOf(
  MESH_UNITS.map((u) => u.id),
  'What the file’s coordinates are in: mm (the default), cm, m or in. An STL carries no units of its own; PLY and OBJ are taken in millimetres unless told otherwise. Everything is measured in millimetres once read.',
)

/** The scan as the readout names it. */
export async function scanSummary() {
  const bounds = await scanBounds()
  const s = useStore.getState()
  const units = commandHost().session.sources.current.scan?.units ?? 'mm'
  return {
    fileName: s.fileName,
    units,
    vertices: s.vertexCount,
    triangles: s.triangleCount,
    bounds,
    center: s.modelCenter,
    size: 2 * s.modelSize,
  }
}

const open: Command<{ bytes: Uint8Array; name: string; units?: MeshUnits; discard?: boolean }> = {
  name: 'open',
  title: 'Open a scan',
  description:
    'Open a mesh as the scan to measure — STL, PLY or OBJ — in place of the one there is; everything measured on the old one goes with it, so it refuses while the session holds measurements unless discard is true. Returns the scan: name, units, vertex and triangle counts, its bounding box (min and max corners), the box’s centre and its diagonal (size), in millimetres. Not undoable: a new scan starts a new history.',
  input: obj(
    {
      bytes: bytes('The file’s contents.'),
      name: fileNameSchema('"ballbar.stl"'),
      units: unitsSchema,
      discard: discardSchema,
    },
    ['bytes', 'name'],
  ),
  history: false,
  run: async ({ bytes: data, name, units, discard }) => {
    requireDiscardable(discard, 'opening another scan')
    const { session } = commandHost()
    const before = session.clientRef.current!.scanVersion
    await session.scan.openScan(fileOf(data, name), units ?? 'mm')
    if (session.clientRef.current!.scanVersion === before) {
      throw new CommandError('failed', lastError(`${name} could not be opened.`))
    }
    return { scan: await scanSummary() }
  },
}

const nearest: Command<{ at: Location }> = {
  name: 'nearest',
  title: 'Find a place on the scan',
  description:
    'Where a location lands on the scan: the vertex (a point snaps to the nearest one), its coordinates and outward normal, a triangle it is a corner of, and how far it is from the point asked about. Use it to check a point lies on the surface before fitting there.',
  input: obj({ at: locationSchema('The place on the scan.') }, ['at']),
  readOnly: true,
  run: async ({ at }) => resolveLocation(at),
}

export const scanCommands = [open, nearest]

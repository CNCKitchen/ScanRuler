// SPDX-License-Identifier: AGPL-3.0-only
// Files out and in: the exports, each the bytes its button would download
// under the name it would give them, and the project file.

import { buildElementsStep, buildScanPointCloud, buildScanStl, type BuiltFile } from '../../app/exports'
import { buildFlatCsvFile } from '../../app/flatReport'
import type { CloudFormat } from '../../core/exportPointCloud'
import type { StepStyle } from '../../core/exportStep'
import { useFlat } from '../../state/flatStore'
import { useStore } from '../../state/store'
import { commandHost, requireScene } from '../host'
import { requireScan } from '../refs'
import { bytes, enumOf, obj, str } from '../schema'
import { sessionState } from '../state'
import { CommandError, type Command } from '../types'
import { discardSchema, fileOf, fileResult, lastError, requireDiscardable } from './common'

/** A build that came back empty: there was nothing to export. */
const nothing = (what: string): never => {
  throw new CommandError('invalid_state', `There is nothing to export — ${what}.`)
}

const fileCommand = (
  name: string,
  title: string,
  description: string,
  build: () => Promise<BuiltFile | null>,
  empty: string,
): Command => ({
  name,
  title,
  description: `${description} Returns the file’s bytes and the name the panel would save it under.`,
  input: obj({}),
  readOnly: true,
  returnsFile: true,
  run: async () => fileResult((await build()) ?? nothing(empty)),
})

const step: Command<{ style?: StepStyle }> = {
  name: 'step',
  title: 'Export the elements as STEP',
  description:
    'The measured elements as analytic STEP geometry for CAD — as drawn, extensions and assumed diameters included — and, in a group per section, what was measured on the sections. style: solids (the default the panel starts on: solids and faces) or surfaces (construction surfaces); it is remembered as the panel’s choice. Returns the file’s bytes and the name the panel would save it under.',
  input: obj({ style: enumOf(['solids', 'surfaces'] as StepStyle[], 'solids or surfaces.') }),
  readOnly: true,
  returnsFile: true,
  run: async ({ style }) => {
    if (style && style !== useStore.getState().stepStyle) useStore.getState().setStepStyle(style)
    return fileResult((await buildElementsStep()) ?? nothing('no element has geometry'))
  },
}

const stl = fileCommand(
  'stl',
  'Export the scan as STL',
  'The scan as a binary STL in the pose it is shown in — a datum alignment and a best fit onto the reference included. Needs the viewport.',
  async () => {
    requireScan()
    return buildScanStl(requireScene('The STL export'))
  },
  'no scan is open',
)

const cloud: Command<{ format?: CloudFormat }> = {
  name: 'cloud',
  title: 'Export the scan as a point cloud',
  description:
    'Every scan vertex with its normal, in the pose it is shown in, as a binary PLY (the default) or an XYZ text file. Needs the viewport. Returns the file’s bytes and the name the panel would save it under.',
  input: obj({ format: enumOf(['ply', 'xyz'] as CloudFormat[], 'ply or xyz.') }),
  readOnly: true,
  returnsFile: true,
  run: async ({ format }) => {
    requireScan()
    return fileResult((await buildScanPointCloud(requireScene('The point cloud export'), format ?? useStore.getState().cloudFormat)) ?? nothing('no scan is open'))
  },
}

const flatOnly = (what: string) => {
  const flat = commandHost().flat
  if (!flat) throw new CommandError('unavailable', `${what} needs the browser.`)
  return flat
}

const svg = fileCommand(
  'svg',
  'Export the 2D sheet as SVG',
  'The 2D sheet at true scale as SVG — the shown edges and the visible elements, aligned and turned as shown — for a vector editor, a laser or a 1:1 print. Needs the browser.',
  () => flatOnly('The SVG export').buildSvg(),
  'nothing is on the 2D sheet',
)

const dxf = fileCommand(
  'dxf',
  'Export the 2D sheet as DXF',
  'The 2D sheet as DXF for CAD — millimetres, y up, the origin on the sheet’s alignment, the edges thinned to a sketch’s worth. Needs the browser.',
  () => flatOnly('The DXF export').buildDxf(),
  'nothing is on the 2D sheet',
)

const csv = fileCommand(
  'csv',
  'Export the 2D measurements as CSV',
  'The 2D Measure elements and dimensions as CSV, for a spreadsheet.',
  async () => {
    const f = useFlat.getState()
    return f.imageName || f.subject.kind === 'section' ? buildFlatCsvFile() : null
  },
  'nothing is on the 2D sheet',
)

const save: Command = {
  name: 'save',
  title: 'Save the project',
  description:
    'The session as a .scanruler project file, as Save Project downloads it: the scan, the reference, the image and every measurement, each rebuilt when it is opened. Needs the browser. Returns the file’s bytes and its name.',
  input: obj({}),
  readOnly: true,
  returnsFile: true,
  run: async () => {
    const project = commandHost().project
    if (!project) throw new CommandError('unavailable', 'Saving a project needs the browser.')
    const packed = await project.save()
    if ('error' in packed) throw new CommandError('failed', packed.error)
    return { file: { name: packed.name, mimeType: 'application/zip', bytes: packed.bytes }, status: useStore.getState().statusText }
  },
}

const load: Command<{ bytes: Uint8Array; name?: string; discard?: boolean }> = {
  name: 'load',
  title: 'Open a project',
  description:
    'Open a .scanruler project in place of the session — its models, then every measurement in it, refitted and remeasured. Refuses while the session holds measurements unless discard is true. Needs the browser. Returns the session. Not undoable: an opened project starts a new history.',
  input: obj({ bytes: bytes('The project file’s contents.'), name: str('Its name, for the status line.', { minLength: 1 }), discard: discardSchema }, ['bytes']),
  history: false,
  run: async ({ bytes: data, name, discard }) => {
    const project = commandHost().project
    if (!project) throw new CommandError('unavailable', 'Opening a project needs the browser.')
    requireDiscardable(discard, 'opening a project')
    await project.open(fileOf(data, name ?? 'project.scanruler'), true)
    if (useStore.getState().errorText) throw new CommandError('failed', lastError('The project could not be opened.'))
    return await sessionState()
  },
}

export const exportCommands = [step, stl, cloud, svg, dxf, csv]
export const projectCommands = [save, load]

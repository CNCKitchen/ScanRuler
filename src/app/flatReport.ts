// SPDX-License-Identifier: AGPL-3.0-only
// What the 2D Measure workspace's report, CSV and drawings are named on and
// built from, read off the stores — for the panel's buttons and for
// report.get alike.

import { evaluateFlatDimensions } from '../core/flat/dimensions'
import { buildFlatCsv, type FlatReportInput } from '../core/flat/report'
import { describeCut, sectionRefName, tiltOf } from '../core/section/frame'
import { fileSafe } from '../core/project/manifest'
import { useFlat } from '../state/flatStore'
import { useStore } from '../state/store'
import { textBytes, type BuiltFile } from './exports'
import { sheetFrame } from './flatSheet'
import { chainCount } from '../core/flat/edges'
import type { FlatDrawingInput } from '../core/flat/drawing'
import { sheetUnits } from '../core/flat/summary'
import type { DisplayUnits } from '../core/units'

/** The section on the 2D stage, described for the report: its name, the
 *  scan it cuts, and where, in `units`. Undefined with the image on the
 *  stage. */
function activeSectionInfo(units: DisplayUnits = 'mm'): FlatReportInput['section'] {
  const subject = useFlat.getState().subject
  if (subject.kind !== 'section') return undefined
  const store = useStore.getState()
  const sec = store.sections.find((x) => x.id === subject.id)
  if (!sec) return undefined
  const where = describeCut(
    sectionRefName(sec.ref, store.elements),
    sec.offset,
    tiltOf(sec.refDir, sec.frame.normal),
    sec.kind,
    units,
  )
  return { name: sec.name, scanName: store.fileName ?? 'scan', cut: where, ...(sec.kind === 'shadow' ? { kind: 'shadow' as const } : {}) }
}

/** Everything the 2D report and CSV need, gathered once, a sheet in
 *  millimetres written in `units` — the screen's for the panel's buttons,
 *  millimetres for the agent and the drawings. */
export function flatReportInput(units: DisplayUnits = 'mm'): FlatReportInput {
  const s = useFlat.getState()
  const unit = s.pxPerMm ? 'mm' : 'px' // units-ok: the sheet's document unit, an id
  return {
    imageName: s.imageName ?? 'image',
    imageWidth: s.imageWidth,
    imageHeight: s.imageHeight,
    calSource: s.calSource,
    section: activeSectionInfo(units),
    pxPerMm: s.pxPerMm,
    datum: s.datum,
    frame: sheetFrame(s),
    unit,
    units,
    elements: s.elements,
    dimensions: evaluateFlatDimensions(s.dimensions, s.elements, sheetUnits(unit, units), sheetFrame(s)),
    counts: s.counts,
    notes: s.notes,
  }
}

/** The stem every 2D export is named on: the section, or the project's
 *  name, or the image. */
export const flatExportStem = (): string => {
  const section = activeSectionInfo()?.name
  if (section) return section.replace(/\.[^.]+$/, '')
  const named = fileSafe(useStore.getState().projectName ?? '')
  return named !== '' ? named : (useFlat.getState().imageName ?? 'scan').replace(/\.[^.]+$/, '')
}

/** The measurements as CSV, for a spreadsheet — its lengths in `units`, as
 *  its header says. */
export function buildFlatCsvFile(units: DisplayUnits = 'mm'): BuiltFile {
  const name = `${flatExportStem()}-measurements.csv`
  return { name, mimeType: 'text/csv', bytes: textBytes(buildFlatCsv(flatReportInput(units))), status: `Measurements exported to ${name}.` }
}

/** "1,234 edge chains and 3 elements" — with a word on the edges when a
 *  format did something to them, and a reason when there are none. */
export function drawnSummary(input: FlatDrawingInput, edgeNote = '', showEdges = useFlat.getState().showEdges): string {
  const chains = input.chains ? chainCount(input.chains) : 0
  const pieces = input.edgePieces?.length ?? 0
  const edges = input.edgePieces
    ? `${pieces.toLocaleString('en-US')} outline piece${pieces === 1 ? '' : 's'} (lines and arcs)`
    : chains
      ? `${chains.toLocaleString('en-US')} edge chain${chains === 1 ? '' : 's'}${edgeNote ? ` ${edgeNote}` : ''}`
      : showEdges
        ? 'no edges'
        : 'the edges hidden'
  const n = input.elements.length
  return `${edges} and ${n} element${n === 1 ? '' : 's'}`
}

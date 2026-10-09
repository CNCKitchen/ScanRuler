// SPDX-License-Identifier: AGPL-3.0-only
// What the 2D Measure workspace's report, CSV and drawings are named on and
// built from, read off the stores — for the panel's buttons and for
// report.get alike.

import { evaluateFlatDimensions } from '../core/flat/dimensions'
import { buildFlatCsv, type FlatReportInput } from '../core/flat/report'
import { describeCut, sectionRefName, tiltOf } from '../core/section/frame'
import { useFlat } from '../state/flatStore'
import { useStore } from '../state/store'
import { textBytes, type BuiltFile } from './exports'
import { sheetFrame } from './flatSheet'

/** The section on the 2D stage, described for the report: its name, the
 *  scan it cuts, and where. Undefined with the image on the stage. */
export function activeSectionInfo(): FlatReportInput['section'] {
  const subject = useFlat.getState().subject
  if (subject.kind !== 'section') return undefined
  const store = useStore.getState()
  const sec = store.sections.find((x) => x.id === subject.id)
  if (!sec) return undefined
  const where = describeCut(
    sectionRefName(sec.ref, store.elements),
    sec.offset,
    tiltOf(sec.refDir, sec.frame.normal),
  )
  return { name: sec.name, scanName: store.fileName ?? 'scan', cut: where }
}

/** Everything the 2D report and CSV need, gathered once. */
export function flatReportInput(): FlatReportInput {
  const s = useFlat.getState()
  return {
    imageName: s.imageName ?? 'image',
    imageWidth: s.imageWidth,
    imageHeight: s.imageHeight,
    calSource: s.calSource,
    section: activeSectionInfo(),
    pxPerMm: s.pxPerMm,
    datum: s.datum,
    frame: sheetFrame(s),
    unit: s.pxPerMm ? 'mm' : 'px',
    elements: s.elements,
    dimensions: evaluateFlatDimensions(s.dimensions, s.elements),
    counts: s.counts,
  }
}

/** The stem every 2D export is named on: the section, or the image. */
export const flatExportStem = () =>
  (activeSectionInfo()?.name ?? useFlat.getState().imageName ?? 'scan').replace(/\.[^.]+$/, '')

/** The measurements as CSV, for a spreadsheet. */
export function buildFlatCsvFile(): BuiltFile {
  const name = `${flatExportStem()}-measurements.csv`
  return { name, mimeType: 'text/csv', bytes: textBytes(buildFlatCsv(flatReportInput())), status: `Measurements exported to ${name}.` }
}

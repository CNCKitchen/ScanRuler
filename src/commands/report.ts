// SPDX-License-Identifier: AGPL-3.0-only
// The report, for whoever asks: as text, exactly what a workspace's Copy
// button puts on the clipboard, so an agent and the person read the same
// thing; and as JSON, the same content structured — what the numbers rest on
// (scale, frame, alignment, cut-offs, facing limit), every element with its
// fit, every dimension with its value, limit and verdict, and the statistics
// of the maps. An agent renders Markdown, HTML or PDF from it itself.

import { buildFlatReport } from '../core/flat/report'
import { unitsLabel } from '../core/meshUnits'
import { buildSummary, cutoffLabel } from '../core/summary'
import { flatReportInput } from '../app/flatReport'
import { useDeviation } from '../state/deviationStore'
import { useFlat } from '../state/flatStore'
import { useStore } from '../state/store'
import { useThickness } from '../state/thicknessStore'
import { APP_VERSION } from '../version'
import { commandHost } from './host'
import {
  deviationFigures,
  describeDeviation,
  describeDimension,
  describeElement,
  describeFlat,
  describeSection,
  describeThickness,
  evaluatedDimensions,
  rigidJson,
  thicknessFigures,
} from './state'
import { CommandError } from './types'

export type ReportWorkspace = 'measure' | 'deviation' | 'thickness' | 'flat'
export const REPORT_WORKSPACES: readonly ReportWorkspace[] = ['measure', 'deviation', 'thickness', 'flat']

/** A workspace's clipboard report, word for word. */
export function reportText(workspace: ReportWorkspace): string {
  const s = useStore.getState()
  const session = commandHost().session
  if (workspace === 'measure') {
    if (!s.fileName) throw new CommandError('no_scan', 'No scan is open — there is nothing to report.')
    return buildSummary(s.fileName, s.elements, evaluatedDimensions())
  }
  if (workspace === 'deviation') {
    const text = session.deviation.reportText(useDeviation.getState().stats ?? deviationFigures())
    if (!text) throw new CommandError('invalid_state', 'No deviation map has been measured yet.')
    return text
  }
  if (workspace === 'thickness') {
    const text = session.thickness.reportText(useThickness.getState().stats ?? thicknessFigures())
    if (!text) throw new CommandError('invalid_state', 'The wall thickness has not been measured yet.')
    return text
  }
  const f = useFlat.getState()
  if (!f.imageName && f.subject.kind === 'image') {
    throw new CommandError('invalid_state', 'Nothing is on the 2D sheet — open an image or put a section on it.')
  }
  return buildFlatReport(flatReportInput())
}

/** The whole session's report, structured. */
export function reportJson() {
  const s = useStore.getState()
  const session = commandHost().session
  const units = session.sources.current.scan?.units ?? 'mm'
  const dimensions = evaluatedDimensions().map(describeDimension)
  const checked = dimensions.filter((d) => d.verdict)
  const passed = checked.filter((d) => d.verdict!.pass).length
  const dev = describeDeviation()
  const thickness = describeThickness()
  const f = useFlat.getState()
  return {
    title: 'ScanRuler report',
    app: { name: 'ScanRuler', version: APP_VERSION },
    created: new Date().toISOString(),
    scan: s.fileName ? { fileName: s.fileName, vertices: s.vertexCount, triangles: s.triangleCount } : null,
    traceability: {
      units: 'Lengths in millimetres, angles in degrees.',
      scale:
        units === 'mm'
          ? 'The scan was read in millimetres.'
          : `The scan was read in ${unitsLabel(units).toLowerCase()} and converted to millimetres.`,
      frame: s.appliedAlignment
        ? 'Coordinates are in the part’s datum frame: the alignment below was applied to the scan.'
        : 'Coordinates are the scan’s own, as the scanner delivered them.',
      appliedAlignment: rigidJson(s.appliedAlignment),
      fitMethod: 'Gaussian best fit (least squares); each fitted element states its own outlier cut-off.',
    },
    elements: s.elements.map((el) => ({
      ...describeElement(el),
      ...(el.source.type === 'fitted' ? { cutoff: cutoffLabel(el.source.settings.sigma) } : {}),
    })),
    dimensions,
    checks: { checked: checked.length, passed, failed: checked.length - passed },
    sections: s.sections.map(describeSection),
    deviation:
      dev.stats || dev.align
        ? {
            ...dev,
            facingLimit:
              dev.source === 'element'
                ? dev.target?.facingDeg ?? null
                : dev.settings.facingDeg,
          }
        : null,
    thickness: thickness.stats ? thickness : null,
    flat: f.imageName || f.subject.kind === 'section' ? describeFlat() : null,
  }
}

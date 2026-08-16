// SPDX-License-Identifier: AGPL-3.0-only
// STEP (ISO 10303-21) reference geometry, via meshStep. A CAD file carries
// exact surfaces, not triangles, so it has to be tessellated before anything
// here can measure against it — and how finely decides how much of the
// deviation map is the part and how much is the conversion.

import { autoTessellation, estimateStepSize, importStep, type ImportDiagnostics } from 'meshstep'
import type { ParsedMesh } from '../types'

/** How the reference was converted, for the caller to report. */
export interface StepInfo {
  /** Chord tolerance the surfaces were tessellated to, mm. This is the
   *  systematic error the conversion adds to every deviation reading taken
   *  against a curved face. */
  surfaceDeviation: number
  /** Length unit the file declared. Coordinates are millimetres either way —
   *  worth saying out loud when the file was not. */
  units: string
  /** What is wrong with the converted mesh, or null when nothing is. */
  warning: string | null
  /** True when geometry is missing or the solid does not close, so the inside
   *  of the reference — and with it the sign of every deviation — is not
   *  reliable. */
  unsound: boolean
}

export interface StepImport {
  mesh: ParsedMesh
  info: StepInfo
}

/** Max edge length, as a fraction of the model's bounding-box diagonal.
 *
 *  meshStep's size-adaptive default subdivides by length as well as by
 *  curvature, which for a viewer is the right call and for a measurement
 *  reference is pure cost: a flat face is exact at two triangles and gains
 *  nothing from ten thousand. Chord tolerance alone decides the accuracy, so
 *  the length cap is left loose enough to keep planes cheap while still
 *  breaking up a metre-long face into something a BVH can sort. Measured on a
 *  20 mm cube: 12 triangles here against 238 510 at the library default, for
 *  bit-identical geometry. */
const MAX_EDGE_FRACTION = 0.1

function decode(buffer: ArrayBuffer): string {
  // STEP part 21 is 7-bit ASCII with \X2\ escapes for anything else, but
  // exporters do write UTF-8 straight into product names; decoding as UTF-8
  // reads both, and never fails on the bytes that matter (the geometry).
  return new TextDecoder('utf-8').decode(buffer)
}

/** The measurement-critical half of the conversion verdict, phrased for
 *  someone about to take readings against this surface. */
function describe(d: ImportDiagnostics): { warning: string | null; unsound: boolean } {
  if (d.ok) return { warning: null, unsound: false }

  const missing = d.facesDropped + d.facesSkipped
  const hasError = d.warnings.some((w) => w.severity === 'error')
  const leaks = d.openEdges > 0 || d.nonManifoldEdges > 0

  if (missing > 0 || leaks || hasError) {
    const parts: string[] = []
    if (missing > 0) parts.push(`${missing} surface${missing === 1 ? '' : 's'} could not be converted`)
    if (d.openEdges > 0) parts.push(`${d.openEdges} open edge${d.openEdges === 1 ? '' : 's'}`)
    if (d.nonManifoldEdges > 0) parts.push(`${d.nonManifoldEdges} non-manifold edge${d.nonManifoldEdges === 1 ? '' : 's'}`)
    return {
      // The signed distance takes its sign from which side of the reference a
      // scan point is on, and a surface with holes in it has no reliable
      // inside — so this is not a cosmetic complaint.
      warning: `STEP conversion is incomplete (${parts.join(', ')}) — the reference is not closed, so the sign of the deviation may be wrong in places. Export a mesh (STL) from your CAD system instead.`,
      unsound: true,
    }
  }

  return {
    warning:
      'Some faces of the STEP file were rebuilt heuristically — the mesh is closed, but check the reference looks like the part before trusting the map.',
    unsound: false,
  }
}

/** Parse and tessellate a STEP file into the same indexed mesh a scan parser
 *  produces. Coordinates come out in millimetres whatever the file declared. */
export function parseSTEP(buffer: ArrayBuffer, onProgress?: (text: string) => void): StepImport {
  onProgress?.('Reading STEP file…')
  const src = decode(buffer)
  if (!src.slice(0, 4096).includes('ISO-10303-21')) {
    throw new Error('This is not a STEP part 21 file (no ISO-10303-21 header).')
  }

  // Tolerances scale with the part: 0.01 mm of chord error is a tenth of what
  // a good structured-light scanner resolves on a 100 mm part, and would be
  // absurd on a 5 mm one.
  const size = estimateStepSize(src)
  const auto = autoTessellation(size?.diag ?? 100)
  const surfaceDeviation = auto.surfaceDeviation
  const maxEdge = size ? Math.max(size.diag * MAX_EDGE_FRACTION, auto.maxEdge) : auto.maxEdge

  // The hook fires once per face and edge; the status strip does not need to
  // hear about every one of them.
  let lastPercent = -1
  const result = importStep(src, {
    surfaceDeviation,
    maxEdge,
    onProgress: onProgress
      ? (p) => {
          if (p.phase === 'parse') {
            onProgress('Reading STEP geometry…')
            return
          }
          if (p.phase === 'finalize') {
            onProgress('Checking the converted mesh…')
            return
          }
          const percent = p.total > 0 ? Math.floor((p.done / p.total) * 100) : 0
          if (percent === lastPercent) return
          lastPercent = percent
          onProgress(`Tessellating CAD surfaces… ${percent}%`)
        }
      : undefined,
  })

  const triangles = result.mesh.indices.length / 3
  if (triangles === 0) {
    throw new Error(
      'The STEP file contains no solid or surface geometry this tool can use — it may be a wireframe or a point-only export.',
    )
  }

  const { warning, unsound } = describe(result.diagnostics)
  return {
    // meshStep welds each body and orients it outward already; the mesh graph
    // is built on top of it exactly as for a scan, so nothing downstream has
    // to know where the reference came from. Its positions are doubles, and
    // narrowing them to the single precision the rest of the tool works in
    // costs ~60 nm on a metre-scale part — four orders below the chord
    // tolerance the surfaces were sampled at.
    mesh: {
      kind: 'indexed',
      positions: Float32Array.from(result.mesh.positions),
      indices: result.mesh.indices,
    },
    info: { surfaceDeviation, units: result.units, warning, unsound },
  }
}

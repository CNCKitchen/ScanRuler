// SPDX-License-Identifier: AGPL-3.0-only
import type { AlignResult, PointPair } from './deviation/align'
import type { Rigid } from './deviation/rigid'
import type { StepInfo } from './parsers/step'
import type { ThicknessMethod } from './thickness/thickness'
import type { ElementKind, FitOutput, FitSettings } from './types'

export type WorkerRequest =
  | { type: 'load'; requestId: number; name: string; buffer: ArrayBuffer }
  | {
      type: 'fit'
      requestId: number
      elementType: ElementKind
      seeds: number[]
      settings: FitSettings
    }
  /** Fit to a surface the user marked by hand: the vertices are the region,
   *  so nothing is searched for or grown. */
  | {
      type: 'fit-selection'
      requestId: number
      elementType: ElementKind
      vertices: Uint32Array
      settings: FitSettings
    }
  | { type: 'load-nominal'; requestId: number; name: string; buffer: ArrayBuffer }
  | { type: 'align'; requestId: number; mode: 'auto' }
  /** From hand-picked pairs. `vertices` narrows what the refinement after them
   *  is measured on, exactly as a local fit's marking does; absent means the
   *  whole scan. */
  | {
      type: 'align'
      requestId: number
      mode: 'points'
      pairs: PointPair[]
      vertices?: Uint32Array
    }
  /** Fine tuning on the surface the user marked, from the fit already in
   *  hand. The starting pose travels with the request because the worker
   *  holds no alignment of its own — the scan's vertices never move for a
   *  scan-to-reference fit, only the transform reported back does. */
  | {
      type: 'align'
      requestId: number
      mode: 'local'
      vertices: Uint32Array
      start: Rigid
      maxDistance: number
    }
  /** Stop the best fit that is running, wherever it has got to. Not a request
   *  — it carries no id and is never answered on its own: the alignment it
   *  interrupts settles as `align-stopped` instead of `align-ok`. It is also
   *  the one message that jumps the queue, because everything else waits
   *  behind the very computation it is trying to end. */
  | { type: 'align-abort' }
  | { type: 'deviate'; requestId: number; transform: Rigid }
  /** Wall thickness of the scan itself — no reference model involved. The
   *  settings that shape the search travel with the request: all of them
   *  change the measurement, so all of them mean measuring again. */
  | {
      type: 'thickness'
      requestId: number
      method: ThicknessMethod
      coneRays: number
      coneAngleDeg: number
      /** Null accepts whatever a ray hits first, facing or not. */
      normalDeviationDeg: number | null
      maxThickness: number
    }
  /** Bake a datum alignment into the scan's vertices, so later fits measure
   *  in the new frame. */
  | { type: 'transform'; requestId: number; transform: Rigid }

export type WorkerResponse =
  | { type: 'progress'; text: string }
  | {
      type: 'loaded'
      requestId: number
      positions: Float32Array
      indices: Uint32Array
      normals: Float32Array
      /** One byte per vertex, for the viewport's mesh mode — see
       *  geometry/wireSlots.ts. */
      wireSlots: Uint8Array
      vertexCount: number
      triangleCount: number
    }
  | { type: 'fit-ok'; requestId: number; result: FitOutput }
  | {
      type: 'nominal-loaded'
      requestId: number
      positions: Float32Array
      indices: Uint32Array
      normals: Float32Array
      wireSlots: Uint8Array
      vertexCount: number
      triangleCount: number
      bboxDiagonal: number
      /** Present only when the reference was tessellated from a STEP file:
       *  how finely, and whether the conversion can be trusted. */
      step?: StepInfo
    }
  | {
      /** A pose from part-way through the refinement, so the viewport can show
       *  the fit converging instead of a spinner. */
      type: 'align-progress'
      requestId: number
      transform: Rigid
      iteration: number
      meanDistance: number
    }
  | { type: 'align-ok'; requestId: number; result: AlignResult }
  /** The fit was stopped part-way by the user. Not an error: nothing went
   *  wrong, there is simply no answer, and whatever alignment was in hand
   *  before it started is still the one to use. */
  | { type: 'align-stopped'; requestId: number }
  | {
      type: 'deviation-ok'
      requestId: number
      values: Float32Array
      /** Colour range the tool would choose for this map, in mm. */
      suggestedRange: number
      /** Search distance the tool would choose for this part, in mm. */
      suggestedMaxDistance: number
    }
  | {
      type: 'thickness-ok'
      requestId: number
      values: Float32Array
      /** Ends of the colour scale the tool would choose for this part, in mm. */
      suggestedLow: number
      suggestedHigh: number
    }
  | { type: 'transform-ok'; requestId: number }
  | { type: 'error'; requestId: number; message: string }

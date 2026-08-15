// SPDX-License-Identifier: AGPL-3.0-only
import type { AlignResult, PointPair } from './deviation/align'
import type { Rigid } from './deviation/rigid'
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
  | { type: 'load-nominal'; requestId: number; name: string; buffer: ArrayBuffer }
  | { type: 'align'; requestId: number; mode: 'auto' }
  | { type: 'align'; requestId: number; mode: 'points'; pairs: PointPair[] }
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
      vertexCount: number
      triangleCount: number
      bboxDiagonal: number
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

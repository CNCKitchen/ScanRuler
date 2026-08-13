import type { FitSettings } from './types'

export type WorkerRequest =
  | { type: 'load'; requestId: number; name: string; buffer: ArrayBuffer }
  | {
      type: 'fit'
      requestId: number
      elementType: string
      seeds: number[]
      settings: FitSettings
    }

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
  | {
      type: 'fit-ok'
      requestId: number
      center: [number, number, number]
      radius: number
      sigma: number
      usedPoints: number
      regionSize: number
      region: Uint32Array
    }
  | { type: 'error'; requestId: number; message: string }

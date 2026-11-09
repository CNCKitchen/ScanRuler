// SPDX-License-Identifier: AGPL-3.0-only
// What the Merge workspace asks of the mesh worker, and what comes back — the
// operations its part of the worker answers (see ../worker.ts).
//
// Frames: a layer lives in its own frame, in millimetres (add-layer's scale
// already applied). A target is 'base' — the session scan as the worker holds
// it, i.e. the shown frame — or another layer id, in that layer's own frame.
// An alignment answers the pose carrying the layer into the target's frame;
// for a layer target the main side composes it with that layer's pose. Layer
// poses are the main side's to hold: the worker keeps nothing that depends
// on them.

import type { Rigid } from '../../../src/core/deviation/rigid'
import type { ElementKind, FitOutput, FitSettings, Vec3 } from '../../../src/core/types'
import type { LayerAlignResult } from './layerAlign'

/** The plugin's id, which its worker part answers to. */
export const MERGE = 'merge'

/** What a target is called when it is the session scan. */
export const BASE = 'base'

/** Datums by the fitId a `fit` answered, each on the side it names: the
 *  layer's fits for `layer`, the target's for `targetDatums`. */
export interface DatumIds {
  primary: number
  secondary: number | null
  origin: number | null
}

/** A long alignment the user stopped (MeshWorkerClient.abortAlign). */
export interface AlignStopped {
  stopped: true
}

/** An alignment's answer: the result, the datum refusal text, or stopped. */
export type AlignReply = LayerAlignResult | { refused: string } | AlignStopped

export interface MergeOps {
  /** A staged load (MeshWorkerClient.prepareScan) taken as layer `id`, its
   *  positions multiplied by `scale` (25.4 for inches) — on top of any scale
   *  the load itself was given. `spacing` is a cloud's point spacing, a
   *  mesh's median edge length, mm. */
  'add-layer': { payload: { stagedId: number; id: string; scale: number }; result: { vertexCount: number; spacing: number; isCloud: boolean } }
  'remove-layer': { payload: { id: string }; result: null }
  /** Copies of the layer's buffers, to draw it; `indices` for a mesh only. */
  'layer-geometry': { payload: { id: string }; result: { positions: Float32Array; normals: Float32Array; indices?: Uint32Array } }
  /** Picked pairs: `layer` points in the layer's frame, `target` points in
   *  the target's. */
  'align-pairs': { payload: { id: string; target: string; pairs: { layer: Vec3; target: Vec3 }[] }; result: AlignReply }
  'align-datums': { payload: { id: string; target: string; layer: DatumIds; targetDatums: DatumIds }; result: AlignReply }
  /** ICP from `start` (layer → target frame). `fromUserGuess` false: the
   *  start is no one's guess — the layer as it was opened, never moved or
   *  aligned by the user — and the result is never confident. Default true. */
  refine: { payload: { id: string; target: string; start: Rigid; fromUserGuess?: boolean }; result: AlignReply }
  /** A transient fit on a layer or on the base, kept under `fitId` for
   *  align-datums until its side goes. A layer's fit is in the layer's own
   *  frame, the base's in the shown frame. Base fit ids are dropped on every
   *  scan replacement, the workspace's own merge and undo included; a
   *  layer's go with the layer. */
  fit: { payload: { id: string; elementType: ElementKind; seeds: number[]; settings: FitSettings }; result: { fitId: number; fit: FitOutput } }
  /** The own-swap flag, one-shot: the next scan replacement after a begin
   *  is the workspace's own (its merge, the history re-swapping it), and the
   *  layers stay; that replacement consumes the flag. The main side sends
   *  the matching end in a `finally`, so a swap that fails before it
   *  happens leaves nothing armed. */
  'merge-begin': { payload: null; result: null }
  'merge-end': { payload: null; result: null }
  'undo-begin': { payload: null; result: null }
  'undo-end': { payload: null; result: null }
  /** The base and the `visible` layers, in that order, as one cloud — see
   *  core/merge.ts. `poses` are layer → shown frame. */
  merge: {
    payload: { poses: Record<string, Rigid>; visible: string[]; toFile: Rigid; scale: number; dedupe: number | null }
    result: { positions: Float32Array; normals: Float32Array; baseMap: Int32Array; dropped: number }
  }
}

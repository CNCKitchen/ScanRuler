// SPDX-License-Identifier: AGPL-3.0-only
// Everything the Merge workspace knows: the layers — extra passes opened
// beside the scan, each in its own frame with the pose that lays it on the
// base as shown — what is being aligned onto what, and how, and the merge's
// settings. The layers' geometry is the worker's (worker.ts) and the
// viewport's (viewer/mergeScene.ts); this holds what the panel and the undo
// history read. Each move or alignment is one step of the history, which
// keeps the poses and what is shown (see plugin.ts); the rest is the
// panel's.

import { create } from 'zustand'
import { identityRigid, type Rigid } from '../../../src/core/deviation/rigid'
import type { ElementKind, Vec3 } from '../../../src/core/types'
import type { LayerAlignResult } from '../core/layerAlign'
import { BASE } from '../core/protocol'

/** The units a layer's file is read in. */
export type LayerUnits = 'mm' | 'in' // units-ok: MeshUnits ids, not on-screen text

export interface LayerRow {
  id: string
  name: string
  color: string
  visible: boolean
  units: LayerUnits
  /** A locked layer stays where it is: a move or an alignment passes it by. */
  locked: boolean
  /** Layer frame → the base as shown. */
  pose: Rigid
  vertexCount: number
  isCloud: boolean
  /** A cloud's point spacing, a mesh's median edge, mm. */
  spacing: number
  /** What its last alignment came to. */
  last?: LayerAlignResult
}

/** How a layer is being laid on its target. */
export type MergeTool = 'move' | 'pairs' | 'datums'

/** A pair picked for Pairs: the point on the layer, then the same point on
 *  the target — each in its own side's frame. */
export interface PairPick {
  layer: Vec3
  target: Vec3 | null
}

/** A datum fitted for Datums, held by the worker under its fitId. */
export interface DatumFit {
  fitId: number
  kind: ElementKind
}

/** The kinds a datum is fitted as. */
export type DatumKind = 'plane' | 'cylinder' | 'sphere'

/** The colours new layers take in turn — clear of the scan's grey and of
 *  each other on both themes. */
export const LAYER_COLORS = ['#e8833a', '#3aa6e8', '#9b5de5', '#2bb673', '#e8c33a', '#e85d75']

interface MergeState {
  layers: LayerRow[]
  /** Bumped by every merge: what tells a step of the history across one. */
  merges: number
  /** The layer the tools work on. */
  selected: string | null
  /** What the selected layer is laid on: BASE or another layer's id. */
  target: string
  tool: MergeTool | null
  gizmoMode: 'translate' | 'rotate'
  pairs: PairPick[]
  /** Datums fitted on each side, by side (BASE or a layer id). */
  datums: Record<string, DatumFit[]>
  datumKind: DatumKind
  /** What an alignment or a merge in progress is doing, or null. */
  running: string | null
  /** The question a merge waits on, or null. */
  confirming: string | null
  /** Points of a layer within this of one kept before it are dropped as the
   *  same point, mm — null for none dropped. */
  dedupe: number | null
  /** Whether `dedupe` was set by hand; otherwise it follows the layers'
   *  spacing. */
  dedupeSet: boolean

  addLayer(row: LayerRow): void
  removeLayer(id: string): void
  patchLayer(id: string, patch: Partial<LayerRow>): void
  setPose(id: string, pose: Rigid): void
  clearLayers(): void
  select(id: string | null): void
  setTarget(target: string): void
  setTool(tool: MergeTool | null): void
  setGizmoMode(mode: 'translate' | 'rotate'): void
  setPairs(pairs: PairPick[]): void
  addDatum(side: string, fit: DatumFit): void
  clearDatums(side: string): void
  setDatumKind(kind: DatumKind): void
  setRunning(text: string | null): void
  setConfirming(text: string | null): void
  setDedupe(mm: number | null, byHand?: boolean): void
}

const initial = {
  layers: [] as LayerRow[],
  merges: 0,
  selected: null as string | null,
  target: BASE,
  tool: null as MergeTool | null,
  gizmoMode: 'translate' as const,
  pairs: [] as PairPick[],
  datums: {} as Record<string, DatumFit[]>,
  datumKind: 'plane' as DatumKind,
  running: null as string | null,
  confirming: null as string | null,
  dedupe: null as number | null,
  dedupeSet: false,
}

/** Without that side's datums. */
function withoutSide(datums: Record<string, DatumFit[]>, side: string): Record<string, DatumFit[]> {
  if (!(side in datums)) return datums
  const { [side]: _gone, ...rest } = datums
  return rest
}

export const useMerge = create<MergeState>((set) => ({
  ...initial,
  addLayer: (row) => set((s) => ({ layers: [...s.layers, row], selected: s.selected ?? row.id })),
  removeLayer: (id) =>
    set((s) => {
      const layers = s.layers.filter((l) => l.id !== id)
      return {
        layers,
        selected: s.selected === id ? (layers[0]?.id ?? null) : s.selected,
        target: s.target === id ? BASE : s.target,
        datums: withoutSide(s.datums, id),
        pairs: s.selected === id || s.target === id ? [] : s.pairs,
      }
    }),
  patchLayer: (id, patch) => set((s) => ({ layers: s.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)) })),
  setPose: (id, pose) => set((s) => ({ layers: s.layers.map((l) => (l.id === id ? { ...l, pose } : l)) })),
  clearLayers: () =>
    set({ layers: [], selected: null, target: BASE, tool: null, pairs: [], datums: {}, confirming: null, dedupe: null, dedupeSet: false }),
  select: (id) => set((s) => (s.selected === id ? {} : { selected: id, pairs: [], target: s.target === id ? BASE : s.target })),
  setTarget: (target) => set((s) => (s.target === target ? {} : { target, pairs: [] })),
  setTool: (tool) => set({ tool, pairs: [] }),
  setGizmoMode: (gizmoMode) => set({ gizmoMode }),
  setPairs: (pairs) => set({ pairs }),
  addDatum: (side, fit) => set((s) => ({ datums: { ...s.datums, [side]: [...(s.datums[side] ?? []), fit] } })),
  clearDatums: (side) => set((s) => ({ datums: withoutSide(s.datums, side) })),
  setDatumKind: (datumKind) => set({ datumKind }),
  setRunning: (running) => set({ running }),
  setConfirming: (confirming) => set({ confirming }),
  setDedupe: (dedupe, byHand = true) => set({ dedupe, dedupeSet: byHand }),
}))

/** A fresh layer's row, before the worker has said what it holds. */
export function layerRow(id: string, name: string, color: string, units: LayerUnits, added: { vertexCount: number; isCloud: boolean; spacing: number }): LayerRow {
  return { id, name, color, visible: true, units, locked: false, pose: identityRigid(), ...added }
}

/** What the undo history keeps of the workspace: each layer's pose and
 *  whether it is shown, by position — compared element by element, so a
 *  step records them only when one changed — and the count of merges. */
export function captureMerge() {
  const { layers, merges } = useMerge.getState()
  return {
    ids: layers.map((l) => l.id),
    poses: layers.map((l) => l.pose),
    visible: layers.map((l) => l.visible),
    merges,
  }
}

export type MergeSnapshot = ReturnType<typeof captureMerge>

/** A step's poses and visibility put back on the layers still open; one
 *  opened since keeps its own, one gone is passed by. */
export function applyMerge(value: MergeSnapshot): void {
  useMerge.setState((s) => ({
    merges: value.merges,
    layers: s.layers.map((l) => {
      const i = value.ids.indexOf(l.id)
      return i < 0 ? l : { ...l, pose: value.poses[i], visible: value.visible[i] }
    }),
  }))
}

/** The median spacing of the cloud layers shown — the merge's dedupe when
 *  none is set by hand — or null with none. */
export function autoDedupe(layers: readonly LayerRow[]): number | null {
  const s = layers.filter((l) => l.visible && l.isCloud && l.spacing > 0).map((l) => l.spacing).sort((a, b) => a - b)
  return s.length > 0 ? s[s.length >> 1] : null
}

/** The dedupe a merge runs with: the one set by hand, else the layers'. */
export function mergeDedupe(s: Pick<MergeState, 'dedupe' | 'dedupeSet' | 'layers'>): number | null {
  return s.dedupeSet ? s.dedupe : autoDedupe(s.layers)
}

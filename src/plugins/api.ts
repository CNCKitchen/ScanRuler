// SPDX-License-Identifier: AGPL-3.0-only
// What a plugin is, to the app: a module at plugins/<id>/plugin.ts whose
// default export is a ScanRulerPlugin. The app never imports a plugin by
// name — it finds them (see registry.ts) and reads them through the shapes
// here, so a build with no plugins/ folder is the same app with nothing
// added to it.
//
// A plugin reaches into the app freely: it imports the stores, the viewer,
// the worker client, the UI parts. What it may not rely on is the app
// reaching back — every place the app lets a plugin in is named in this
// file, and a plugin's part in it is whatever it registers there.

import type { ComponentType, ReactNode, RefObject } from 'react'
import type { ImportQueue } from '../app/importQueue'
import type { SourceFiles } from '../app/project'
import type { ScanSource } from '../app/useScanSwap'
import type { Rigid } from '../core/deviation/rigid'
import type { FieldScale } from '../core/field/colormap'
import type { HintResult } from '../core/hints'
import type { MeshUnits } from '../core/meshUnits'
import type { ElementKind } from '../core/types'
import type { MeshWorkerClient } from '../core/workerClient'
import type { HoverReading } from '../ui/HoverReadout'
import type { IconName } from '../ui/icons'
import type { GripSide, PickHit, SceneManager } from '../viewer/SceneManager'

/** A workspace's tab in the top bar. */
export interface WorkspaceTab {
  /** The workspace's id — the shell store's `workspace` while it is open,
   *  and what a project file says it was saved in. */
  id: string
  label: string
  /** The tab's tooltip: what the workspace is for, in a sentence. */
  title: string
  icon: IconName
  /** Where the tab stands among the plugins' tabs, which follow the app's
   *  own; lower comes first. */
  order: number
  /**
   * The workspace's guided hint, as a React hook: the step to ring once a
   * scan is open (opening one is the app's own first step), or 'done' when
   * the workspace has been carried through. `busy` quiets the hints of
   * every workspace while the plugin computes. Without it the workspace has
   * no hints at all.
   */
  useHintStep?(): { step: HintResult; busy: boolean }
}

/** The large buffers the app keeps per scan vertex, outside every store: the
 *  maps and the hand-marked region an element map is confined to. A plugin
 *  that puts another version of the scan in place clears them. */
export interface ScanMaps {
  deviation: RefObject<Float32Array | null>
  deviationRgb: RefObject<Uint8Array | null>
  elementField: RefObject<Float32Array | null>
  elementRgb: RefObject<Uint8Array | null>
  elementScope: RefObject<Uint32Array | null>
  thickness: RefObject<Float32Array | null>
  thicknessRgb: RefObject<Uint8Array | null>
}

/** What the app hands every plugin: the parts of it a plugin works through,
 *  and the verbs the app's own panels use. Stable for the life of the app —
 *  a plugin may keep it in an effect's closure. */
export interface PluginHost {
  clientRef: RefObject<MeshWorkerClient | null>
  sceneRef: RefObject<SceneManager | null>
  /** The bytes of every model as it came in — what a project saves. */
  sources: RefObject<SourceFiles>
  /** The queue every load and replace of a model runs through. */
  imports: ImportQueue
  maps: ScanMaps
  /** Open a file as the scan — asking its units first unless given. */
  openScan(file: File, units?: MeshUnits): Promise<void>
  /** Open a file as the Deviation workspace's reference part. */
  openReference(file: File, units?: MeshUnits): Promise<void>
  /** Fit an element again, from its recipe. */
  runFit(id: number, kind: ElementKind, seeds: number[], selection?: Uint32Array, regionsOnly?: boolean): Promise<void>
  /** Measure the deviation map again, under the alignment in hand. */
  runDeviation(): Promise<void>
  /** Measure the wall thickness again. */
  runThickness(): Promise<void>
  /** Take the open element draft's preview off the part. */
  clearPreview(): void
  /** Put another version of the scan in place under the session, read in
   *  the pose `transform` — see app/useScanSwap. */
  swapScan(source: ScanSource, transform: Rigid | null): Promise<void>
  /** Renumber everything held by vertex onto the version just put in place. */
  remapScan(vertexMap: Int32Array): void
  /** Measure everything on the scan again after a swap — the elements from
   *  their recipes when `refit`, else onto their surfaces as they stand. */
  remeasureScan(refit: boolean): Promise<void>
}

/** What a workspace shows on an empty stage, before there is a part. */
export interface StartPaneContent {
  title: string
  blurb: string
  /** A way past the door, for a workspace that can work with no model. */
  skip?: { label: string; title: string; onClick: () => void }
}

/**
 * A plugin's part in the app for one render — what its usePlugin hook
 * returns. The parts that belong to a workspace are read only while the
 * plugin's workspace is the one on screen; the rest always.
 */
export interface PluginRuntime {
  /** The workspace's panel. */
  panel?: ReactNode
  /** Drawn on the stage just above the viewport — a sheet of the plugin's
   *  own laid over it, say. */
  stage?: ReactNode
  /** Drawn on the stage over the part, where the legends and the chips are. */
  overlay?: ReactNode
  /** The 3D viewport put away, while the stage covers it. */
  hideViewport?: boolean
  /** The stage's front door with no scan loaded; null for none — the
   *  workspace has something to show without one. */
  startPane?: StartPaneContent | null
  /** Whether the hover reading is up: the workspace shows a map to read. */
  hoverReadout?: boolean
  /** The reading under the pointer, on the map the workspace shows. */
  readingAt?(hit: PickHit): (HoverReading & { value: number }) | null
  /** A click on the scan. */
  pick?(hit: PickHit): void
  /** A click on a measured element, while element picking is on. */
  elementPick?(id: number, clientX: number, clientY: number): void
  /** A marking gesture ended; true when the workspace took it. */
  paintChange?(): boolean
  /** The workspace's colouring of the scan: one value per scan vertex, the
   *  buffer its colours are painted into, and the scale they are read
   *  through — or null for the bare surface. */
  field?: { values: Float32Array; rgb: RefObject<Uint8Array | null>; scale: FieldScale } | null
  /** Changes whenever `field` is to be painted again — and only then: the
   *  paint is a pass over every vertex of the scan. */
  fieldVersion?: unknown
  /** The marking tools armed for the workspace, marking in `color`; with
   *  `gestures` false what is marked is only shown, the tools stood down. */
  marking?: { color: string; gestures: boolean } | null
  /** The measured elements and sections drawn on the part, as the datums
   *  the workspace works against — without their surface tints. */
  showsElements?: boolean
  /** The scan put away: something of the workspace's own stands in its
   *  place. */
  hideScan?: boolean
  /** The workspace's own keys in the view bar, above the models' keys. */
  viewKeys?: ReactNode
  /** The models' keys put away — no model is on the stage. */
  hideModelKeys?: boolean
  /** Always read. Whether the plugin holds work worth saving as a project. */
  canSave?: boolean
  /** Always read. A grip dragged in the viewport; true when it was one of
   *  the plugin's. */
  gripDrag?(side: GripSide, delta: number, phase: 'start' | 'move' | 'end'): boolean
}

/** What a plugin's workspace does with the keyboard and the middle button —
 *  read from the stores, so the same for the life of the app. */
export interface KeyboardContribution {
  /** A key pressed while the workspace is open — after undo, redo and the
   *  view keys, before the app's own. True when the workspace took it.
   *  `confirmButton` is the panel's confirm button of the moment. */
  keydown?(e: KeyboardEvent, ctx: { confirmButton(): HTMLButtonElement | null }): boolean
  /** Whether the view keys are held back — in any workspace. */
  holdsViewKeys?(): boolean
  /** What Enter or a middle click confirms in the workspace right now, or
   *  null for nothing of its own — the panel's confirm button then, as
   *  anywhere. */
  confirmable?(): (() => void) | null
}

export interface ScanRulerPlugin {
  /** Unique among the plugins, and stable: project files and preferences
   *  are keyed by it. */
  id: string
  /** The plugin's name as a person reads it. */
  name: string
  /** The workspace the plugin adds, if it adds one. */
  workspace?: WorkspaceTab
  /** Its workspace's keys. */
  keyboard?: KeyboardContribution
  /** What the imprint owes the third-party software the plugin ships: one or
   *  more paragraphs under "Third-party software". */
  notices?: ComponentType
  /** Run once at start-up, when the plugin is enabled: the place to register
   *  with the app's registries — the undo history, the project file and the
   *  rest. Nothing a plugin registers exists while it is disabled. */
  install?(): void
  /** The plugin's part in the app, as a React hook App calls on every render
   *  — the same plugins in the same order each time, as hooks need. */
  usePlugin?(host: PluginHost): PluginRuntime
}

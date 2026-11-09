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
import type { ReferenceOptions } from '../app/deviationWorkspace'
import type { ImportQueue } from '../app/importQueue'
import type { SourceFiles } from '../app/project'
import type { ScanSource } from '../app/scanSwap'
import type { Rigid } from '../core/deviation/rigid'
import type { FieldScale } from '../core/field/colormap'
import type { HintResult } from '../core/hints'
import type { MeshUnits } from '../core/meshUnits'
import type { ElementKind } from '../core/types'
import type { MeshWorkerClient, ReferenceDeviationResult } from '../core/workerClient'
import type { HoverReading } from '../ui/HoverReadout'
import type { IconName } from '../ui/icons'
import type { ViewSwitch } from '../ui/PartKey'
import type { GripSide, PickHit, SceneManager } from '../viewer/SceneManager'

// ---- Commands -----------------------------------------------------------------
// The session's verbs as an agent calls them (src/commands). A plugin adds its
// own from install(): registerCommands(plugin.id, [...]) puts them under its
// id — `<id>.<verb>` — and registerStateSection(plugin.id, describe) adds its
// part to the session's readout under plugins.<id>. Each command is the same
// code path as the plugin's panel, one step of the undo history, and returns
// what the stores hold afterwards; see commands/types.ts. registerBusy(
// plugin.id, check) says what the plugin's own machinery is busy with, so no
// command runs over it and the readout's `busy` says so — and, given a stop,
// lets a change that throws the work away stop it; registerViewToggles(
// plugin.id, toggles) adds the keys view.set and view.render take to show or
// put away what the plugin draws. registerSheetPlanes(plugin.id, planes)
// lets section.render { plane: { sketch } } lie on a plane the plugin keeps,
// in its frame. registerMapReport(workspace, report) says which map a
// view.render picture of the plugin's workspace shows, or why none.
// registerSettle(settle) finishes what the
// plugin's commands left for later when run deferred (a run of changes that
// builds once, after the last) before a command that is not. registerGuide(
// guide) adds a guide guide.read serves an agent before a task — the
// plugin's workflow in Markdown, loaded when first read.

export { registerCommands, registerSettle, runningChange } from '../commands/registry'
export { registerStateSection } from '../commands/stateSections'
export { registerBusy } from '../commands/activity'
export { registerViewToggles } from '../commands/viewToggles'
export type { ViewToggle } from '../commands/viewToggles'
export { registerMapReport } from '../commands/mapReports'
export type { MapReport } from '../commands/mapReports'
export { registerSectionLayers, registerSheetPlanes } from '../commands/sectionLayers'
export { registerGuide } from '../commands/guides'
export type { Guide } from '../commands/guides'
export type { SectionLayer, SectionLayerDrawing, SectionOutline, SectionPiece, SectionSheet, SheetPlanes } from '../commands/sectionLayers'
export { CommandError } from '../commands/types'
export type { Command, CommandContext, CommandErrorCode, FileOut } from '../commands/types'
export type { JsonSchema } from '../commands/schema'

/** A workspace's tab in the top bar. */
export interface WorkspaceTab {
  /** The workspace's id — the shell store's `workspace` while it is open,
   *  and what a project file says it was saved in. */
  id: string
  label: string
  /** The tab's tooltip under its label: what the workspace is for, in a sentence. */
  title: string
  icon: IconName
  /** Where the tab stands among the plugins' tabs, which follow the app's
   *  own; lower comes first. */
  order: number
  /**
   * Why the workspace cannot be used now — the tab is greyed with this as
   * its tooltip, and the workspace gives way to 3D Measure if it is open —
   * or null when it can. A plain function of the stores, read as they
   * change; Mesh Tools and Reverse engineer say so for a point cloud.
   */
  unavailable?(): string | null
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
  /** The reference cut finer and read against the scan — the map painted on
   *  the reference (core/deviation/onReference.ts) — and its colours. */
  referenceMap: RefObject<ReferenceDeviationResult | null>
  referenceRgb: RefObject<Uint8Array | null>
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
  /** Open a file as the Deviation workspace's reference part — one the
   *  plugin made from the session's work with `fromSession` (see
   *  ReferenceOptions). */
  openReference(file: File, units?: MeshUnits, options?: ReferenceOptions): Promise<void>
  /** Fit an element again, from its recipe. */
  runFit(id: number, kind: ElementKind, seeds: number[], selection?: Uint32Array, regionsOnly?: boolean): Promise<void>
  /** Measure the deviation map again, under the alignment in hand. */
  runDeviation(): Promise<void>
  /** Measure the wall thickness again. */
  runThickness(): Promise<void>
  /** Take the open element draft's preview off the part. */
  clearPreview(): void
  /** Put another version of the scan in place under the session, read in
   *  the pose `transform` — see app/scanSwap. */
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
  /** A view beside the viewport: the viewport becomes the left half where
   *  it stands — it is not remounted — and this the right, as the
   *  Deviation workspace's reference does. Null or absent for none. */
  split?: ReactNode
  /** The stage's front door with no scan loaded; null for none — the
   *  workspace has something to show without one. */
  startPane?: StartPaneContent | null
  /** Whether the hover reading is up: the workspace shows a map to read. */
  hoverReadout?: boolean
  /** The reading under the pointer, on the map the workspace shows. */
  readingAt?(hit: PickHit): (HoverReading & { value: number }) | null
  /** Whether the pointer is tested over the scan every frame it moves, for
   *  `hover`, with no map to read — a line drawn after it, say. */
  hovers?: boolean
  /** The scan under the pointer as it moves, or null off it — while there
   *  is a map to read, or while `hovers` asks for it. */
  hover?(hit: PickHit | null): void
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
  /** The workspace's hand on the view bar's Scan key: whether the scan is
   *  shown, and whether it is transparent, in place of the app's own
   *  settings — for a workspace that shows or ghosts the scan its own way.
   *  The menu's mesh and back-face switches stay the app's; `menu` adds
   *  the workspace's own rows under them (PartOption, a way of colouring
   *  the scan, say), and `menuChanged` says one of them stands otherwise
   *  than the workspace opens with, for the key's dot. */
  scanKey?: { shown?: ViewSwitch; seeThrough?: ViewSwitch; menu?: ReactNode; menuChanged?: boolean }
  /** The workspace's own parts in the view bar, as keys after the Scan key
   *  in its housing — PartKey from ui/PartKey, a click showing the part and
   *  its menu how it is drawn. */
  partKeys?: ReactNode
  /** The workspace's own keys at the side of the view bar, after the parts
   *  and before the Section key — the ways of colouring the scan, say. */
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
  /** Still in beta: left out — not installed at all — until switched on in
   *  Settings, where it is offered under its workspace's label. A project
   *  opened while it is off keeps its part of the file, as in a build
   *  without it. */
  beta?: boolean
  /** The workspace the plugin adds, if it adds one. */
  workspace?: WorkspaceTab
  /** Its workspace's keys. */
  keyboard?: KeyboardContribution
  /** What the imprint owes the third-party software the plugin ships: one or
   *  more paragraphs under "Third-party software". */
  notices?: ComponentType
  /** Run once at start-up, when the plugin is enabled: the place to register
   *  with the app's registries — the undo history, the project file, the
   *  commands and the readout (above) and the rest. Nothing a plugin
   *  registers exists while it is disabled. */
  install?(): void
  /** The plugin's part in the app, as a React hook App calls on every render
   *  — the same plugins in the same order each time, as hooks need. */
  usePlugin?(host: PluginHost): PluginRuntime
  /** Start what the plugin's headless commands (Command.headless) need when
   *  the app runs without a browser (src/headless/engine.ts) — after
   *  install(). Resolves with the function that stops it. */
  headless?(): Promise<() => void>
}

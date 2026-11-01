// SPDX-License-Identifier: AGPL-3.0-only
// Everything the Mesh Tools workspace knows. Its tools come in two kinds.
// Some edit the scan itself — Remove islands, Delete marked, Flip normals,
// Cut, Fill holes, Smooth, Shrink / expand, Boolean, Shell — and every
// workspace measures the scan as they leave it; each edit
// is one step of the undo history, and the list of them says what has been
// done to the file that was opened. Others make something beside the scan and
// leave it alone — Reduce mesh, the scan as a light mesh for CAD, measured
// against the scan; Trim to scan, a body cut to fit the scan's break.
//
// The reduction's settings split the way the thickness workspace's do: what
// shapes the reduction, which only takes effect when the scan is reduced
// again, and how the result is looked at, which takes effect at once.

import { create } from 'zustand'
import { defaultTolerance, type ReduceReport, type ReduceSettings } from '../core/reduce'
import { defaultMinPiece } from '../core/pieces'
import { defaultHoleSize, type FillMode, type HoleSurvey } from '../core/fillHoles'
import { defaultSmoothLimit, defaultSmoothSize } from '../core/smooth'
import type { CopyDeviationStats } from '../core/edit'
import type { BooleanOp } from '../core/boolean'
import { defaultWallThickness } from '../core/hollow'
import type { ThickenSide } from '../core/offset'
import { DEFAULT_BREAK_DEPTH, type BreakReport } from '../core/breakSurface'
import type { TrimReport } from '../core/trimToScan'

export type { CopyDeviationStats }
import type { SectionRef } from '../../../src/core/section/frame'
import type { PieceCount } from '../core/protocol'
import { fmtLen, fmtVol, type DisplayUnits } from '../../../src/core/units'
import { typedLen } from '../ui/meshFormat'

/** The tool in hand. */
export type MeshTool = 'reduce' | 'islands' | 'delete' | 'flip' | 'cut' | 'holes' | 'smooth' | 'offset' | 'boolean' | 'trim' | 'shell'

/** What the viewport shows of a reduction: the reduced mesh with its
 *  triangles drawn, the scan painted with how far the reduced mesh strays
 *  from it, or the scan as it is. */
export type MeshView = 'reduced' | 'deviation' | 'scan'

export type MeshStatus = 'idle' | 'running' | 'ready'

/** Which side of a cut stays: the one its direction points to — above the
 *  XY plane, outside a face — or the other. */
export type CutKeep = 'plus' | 'minus'

/** A change made to the scan, as the list of them tells it. The kinds are
 *  the names a saved project knows them by: `pieces` is Remove islands,
 *  `delete` Delete marked, `flip` Flip normals, `cut`, `fill` Fill holes,
 *  `smooth`, `offset` Shrink / expand, `boolean`, `shell`. */
export type ScanEdit =
  | {
      kind: 'pieces'
      /** The size the islands were smaller than, mm. */
      minSize: number
      /** How many islands went, and how many triangles with them. */
      pieces: number
      triangles: number
    }
  | { kind: 'delete'; triangles: number }
  | {
      kind: 'flip'
      /** The triangles turned over. */
      triangles: number
      /** The points of the region marked to flip — absent for the whole
       *  mesh. */
      region?: number
    }
  | {
      kind: 'cut'
      /** Where, as the list says it: "XY plane, Z 1.5 mm". */
      plane: string
      /** Triangles taken off whole and cut across; faces closed; stretches
       *  of rim left open. */
      removed: number
      capped: number
      open: number
    }
  | { kind: 'fill'; maxSize: number; mode: FillMode; holes: number; triangles: number }
  | {
      kind: 'smooth'
      /** Bumps smaller than this across smoothed out, mm, and no point moved
       *  further than the limit; the furthest any went. */
      size: number
      limit: number
      maxMove: number
      /** The points of the region marked to smooth — absent for the whole
       *  mesh. */
      region?: number
    }
  | {
      kind: 'boolean'
      op: BooleanOp
      /** The solid, by the name it had then. */
      solid: string
      /** The scan's triangles taken or cut across, and the triangles the
       *  solid's surface brought; how much the enclosed volume changed, mm³. */
      removed: number
      added: number
      volume: number
    }
  | {
      kind: 'offset'
      /** How far the surface moved along its normal, mm — out when
       *  positive — and the furthest any point went, at an edge or a
       *  corner. */
      distance: number
      maxMove: number
      /** The points of the region marked to move — absent for the whole
       *  mesh. */
      region?: number
    }
  | {
      kind: 'shell'
      /** A closed part hollowed, or an open surface thickened into a solid —
       *  and which way, for that. */
      mode: 'hollow' | 'thicken'
      thickness: number
      side?: ThickenSide
      /** The triangles the inner wall, or the second skin and its rim wall,
       *  brought; for a hollow, the cavities and the material they took
       *  out, mm³. */
      triangles: number
      cavities?: number
      volume?: number
    }

/** Every tool's settings: what a command sets and puts back when it
 *  fails, and what an undo step keeps — a setting added to the store goes
 *  here, or the two part ways. */
export const MESH_SETTINGS = [
  'tolerance', 'toleranceAuto', 'maxTriangles', 'pieceSize', 'pieceSizeAuto', 'cutRef', 'cutOffset', 'cutOffsetAuto', 'cutKeep',
  'cutCap', 'holeSize', 'holeSizeAuto', 'fillMode', 'smoothScope', 'smoothSize', 'smoothSizeAuto', 'smoothLimit', 'smoothLimitAuto',
  'smoothEdges', 'offsetScope', 'offsetDirection', 'offsetDistance', 'boolOp', 'boolSolids', 'trimSolid', 'trimOffset', 'trimDepth',
  'trimFlip', 'shellThickness', 'shellThicknessAuto', 'shellSide',
] as const

/** The triangle limit a reduction starts with: a mesh CAD takes in without
 *  a fuss, and fine enough to model a hand-sized part over. */
export const DEFAULT_TRIANGLE_LIMIT = 50_000

/** Surface marked for Delete marked: the orange the islands a removal would
 *  take are marked in — on this workspace, orange is what goes. */
export const DELETE_MARK_COLOR = '#ff5a1f'

/** Surface marked for Flip normals to turn over: an amber, none of the
 *  other markings' colours nor the mauve the far side of a triangle is
 *  tinted when the view bar's Backfaces is on — which is what a region
 *  facing the wrong way looks like, and what is marked. */
export const FLIP_MARK_COLOR = '#e8a317'

/** Surface marked for Smooth to smooth alone: a blue, nothing like the
 *  orange of what goes. */
export const SMOOTH_MARK_COLOR = '#3b8cff'

/** What Smooth smooths: the whole mesh, or a region marked on it. */
export type SmoothScope = 'all' | 'marked'

/** Surface marked for Shrink / expand to move alone: a violet, neither the
 *  orange of what goes nor the blue of what is smoothed. */
export const OFFSET_MARK_COLOR = '#9b5cf0'

/** Which way Shrink / expand moves the surface: out, the part growing, or
 *  in. */
export type OffsetDirection = 'expand' | 'shrink'

/** The break Trim to scan found, marked on the part: a teal, none of the
 *  other markings' colours — it is not surface to go, to smooth or to move,
 *  but where the piece is to meet the part. The piece's mating face wears
 *  it too. */
export const TRIM_MARK_COLOR = '#12a594'

/** What the viewport shows while Trim to scan is in hand: the piece made,
 *  over the scan ghosted — as it is, or its mating face coloured by its gap
 *  to the part — or the scan with the break marked on it and the bodies on
 *  offer drawn over it. */
export type TrimView = 'piece' | 'gap' | 'break'

/** The piece on hand, as it was made: what came of it, the body — by key,
 *  and by the name it had then — and the settings it was made with. The
 *  piece itself lives in the scene. */
export interface TrimMade {
  report: TrimReport
  solid: string
  name: string
  depth: number
  flip: boolean
  /** Either end of the gap's colour scale, mm: the 99th percentile of how
   *  far it strays from the offset, on the 1-2-5 steps. */
  gapRange: number
}

/** What Shell has to work on: how far the mesh is from closed and, when it
 *  is open, its rims and the holes among them — those smaller than Fill
 *  holes' size, `holeSize`. */
export interface ShellSurvey {
  open: number
  bad: number
  rims: number
  holes: number
  holeSize: number
}

/** What Shell will do with the mesh: hollow it, closed; thicken it, an open
 *  surface; or ask for its holes to be filled first — closed but for holes
 *  no larger than Fill holes would fill. */
export type ShellMode = 'hollow' | 'thicken' | 'holes'

export function shellModeOf(s: Pick<ShellSurvey, 'open' | 'rims' | 'holes'>): ShellMode {
  if (s.open === 0) return 'hollow'
  return s.rims > 0 && s.holes === s.rims ? 'holes' : 'thicken'
}

/** What a cut would do, before it is made: whether the plane has scan on
 *  both sides of it, the faces it would close flat, the holes in the scan at
 *  the plane it would bridge, and the stretches of it left open. */
export interface CutOutcome {
  cuts: boolean
  capped: number
  bridged: number
  open: number
}

interface MeshState {
  /** The tool in hand — null with every tool put away (Escape, or a
   *  boolean done), the panel showing the keys alone. */
  tool: MeshTool | null

  // ---- Reduce mesh --------------------------------------------------------
  status: MeshStatus
  message: string | null
  /** The result on hand, measured — null until the scan is reduced. The
   *  mesh itself and the deviation field are too large for a store, and
   *  live with the scene and in App. */
  report: ReduceReport | null
  /** Bumped whenever a fresh result lands, so the view repaints. */
  resultVersion: number
  tolerance: number
  toleranceAuto: boolean
  maxTriangles: number
  view: MeshView

  // ---- Remove islands -------------------------------------------------------
  /** Pieces smaller than this across are islands, mm. */
  pieceSize: number
  pieceSizeAuto: boolean
  /** The scan's pieces counted at `survey.minSize` — null while being
   *  counted, or with no scan. */
  survey: (PieceCount & { minSize: number }) | null
  /** Bumped when a survey lands, so the viewport marks its islands. */
  surveyVersion: number
  /** Why the survey of the tool in hand — its islands, holes or what Shell
   *  will do — failed, or null. Kept apart from a survey of null, which is
   *  one still being made, so a panel does not wait on it for ever. */
  surveyFailed: string | null
  /** Bumped by Retry, to make the failed survey again. */
  surveyAttempt: number
  /** The islands marked on the part — or the surface marked by hand, for
   *  Delete marked — have been asked to go, and wait on a yes. Nothing is
   *  deleted before it; any change to what is marked — another size,
   *  another scan, another tool — takes the question back. */
  confirming: boolean
  /** An edit in flight. */
  editing: boolean

  // ---- Cut ------------------------------------------------------------------
  /** What the plane is taken across — a coordinate axis, or an element with
   *  a direction — and how far along it, mm. While `cutOffsetAuto`, the
   *  plane goes through the part's middle and the offset is worked out from
   *  it (see cutPlaneOf). */
  cutRef: SectionRef
  cutOffset: number
  cutOffsetAuto: boolean
  cutKeep: CutKeep
  /** What the cut at the panel's plane would do, worked out while Cut is in
   *  hand and shown on the part — null while being worked out. */
  cutPreview: CutOutcome | null
  /** Close the part flat where the plane crosses it. */
  cutCap: boolean

  // ---- Fill holes -------------------------------------------------------------
  /** Rims smaller than this across are holes to fill, mm. */
  holeSize: number
  holeSizeAuto: boolean
  fillMode: FillMode
  /** The scan's rims sorted at `holeSurvey.maxSize` — null while being
   *  sorted, or with no scan. */
  holeSurvey: (HoleSurvey & { maxSize: number }) | null
  holeSurveyVersion: number

  // ---- Smooth -------------------------------------------------------------------
  smoothScope: SmoothScope
  /** Bumps smaller than this across are smoothed out, mm. */
  smoothSize: number
  smoothSizeAuto: boolean
  /** How far any point may move, mm. */
  smoothLimit: number
  smoothLimitAuto: boolean
  smoothEdges: boolean

  // ---- Shrink / expand -------------------------------------------------------------
  offsetScope: SmoothScope
  offsetDirection: OffsetDirection
  /** How far the surface moves, mm — always positive; the direction says
   *  which way. */
  offsetDistance: number

  // ---- Boolean -------------------------------------------------------------------
  boolOp: BooleanOp
  /** The solids to make one with the mesh, by their keys among the solids
   *  on offer (src/app/solids) and in the order they were chosen — empty
   *  for none yet. Several go as their union. */
  boolSolids: string[]
  /** The mesh the tool works on, closed or not — null while being looked
   *  at. A boolean needs it closed. */
  boolClosed: { open: number; bad: number } | null

  // ---- Trim to scan -------------------------------------------------------------
  /** The body to cut, by its key among the solids on offer — null for none
   *  in hand. One at a time. */
  trimSolid: string | null
  /** How far the piece's mating face sits off the break, mm: 0 cuts on it,
   *  a tenth or two leaves room for glue. */
  trimOffset: number
  /** How much deeper in the body than its surface the scan must lie to be
   *  break, mm. */
  trimDepth: number
  /** Keep what is on the other side of the break. */
  trimFlip: boolean
  trimView: TrimView
  /** The break found for the body in hand, marked on the part — null while
   *  it is being found, or with no body in hand; or why there is none. */
  trimBreak: BreakReport | null
  trimBreakError: string | null
  /** Bumped by Find again: the break found afresh, the marking with it. */
  trimFinds: number
  trimStatus: MeshStatus
  trimMessage: string | null
  trimMade: TrimMade | null
  /** Bumped whenever a piece lands or goes. */
  trimVersion: number

  // ---- The parts list -------------------------------------------------------------
  /** What the viewport shows with no tool in hand, row by row of the panel's
   *  Parts list: the scan — or the edited copy in its place — the reduced
   *  mesh, the piece Trim to scan made, and the bodies other workspaces lend,
   *  by key. A tool in hand shows what it works on instead. Not steps of the
   *  undo history: a way of looking, like the view keys. */
  shownScan: boolean
  shownReduced: boolean
  shownPiece: boolean
  shownBodies: string[]

  // ---- Shell ------------------------------------------------------------------------
  /** The wall a hollow leaves, or the sheet's thickness, mm. */
  shellThickness: number
  shellThicknessAuto: boolean
  shellSide: ThickenSide
  /** The mesh looked at for what Shell will do — null while being looked
   *  at. */
  shellSurvey: ShellSurvey | null

  /** What has been done to the scan in use since it was opened, oldest
   *  first — edits taken into use with Use for analysis. */
  edits: ScanEdit[]

  // ---- The edited copy --------------------------------------------------------
  /** The edits made on the copy of the scan Mesh Tools works on, not yet
   *  taken into use — the scan every other workspace measures has none of
   *  them. Empty with no copy. */
  pending: ScanEdit[]
  /** The copy's triangles — null while there is no copy. Set as the copy
   *  is put in place; bumped `copyVersion` says it changed. */
  copyTriangles: number | null
  copyVersion: number
  /** Colour the copy by how far it is from the scan in use. */
  copyDeviation: boolean
  /** That map's figures, once measured on the copy on show — null while it
   *  is being measured, or off. */
  copyDeviationStats: CopyDeviationStats | null
  copyDeviationVersion: number

  setTool: (tool: MeshTool | null) => void
  begin: () => void
  resolve: (report: ReduceReport) => void
  fail: (message: string) => void
  /** The reduction on hand belonged to a scan that has just changed. */
  dropResult: () => void
  setTolerance: (v: number) => void
  setMaxTriangles: (v: number) => void
  setView: (view: MeshView) => void
  setPieceSize: (v: number) => void
  setSurvey: (survey: (PieceCount & { minSize: number }) | null) => void
  setSurveyFailed: (why: string | null) => void
  retrySurvey: () => void
  setConfirming: (on: boolean) => void
  setEditing: (on: boolean) => void
  addEdit: (edit: ScanEdit) => void
  addPending: (edit: ScanEdit) => void
  /** The copy has been taken into use: its edits are the scan's now. */
  takePending: () => void
  clearPending: () => void
  /** The copy put in place, with its triangle count — or taken away. */
  setCopy: (triangles: number | null) => void
  setCopyDeviation: (on: boolean) => void
  setCopyDeviationStats: (stats: CopyDeviationStats | null) => void
  /** Another plane to cut across; its offset starts through the part's
   *  middle again. */
  setCutRef: (ref: SectionRef) => void
  setCutOffset: (v: number) => void
  setCutKeep: (keep: CutKeep) => void
  setCutCap: (on: boolean) => void
  setCutPreview: (preview: CutOutcome | null) => void
  setHoleSize: (v: number) => void
  setFillMode: (mode: FillMode) => void
  setHoleSurvey: (survey: (HoleSurvey & { maxSize: number }) | null) => void
  setSmoothScope: (scope: SmoothScope) => void
  setSmoothSize: (v: number) => void
  setSmoothLimit: (v: number) => void
  setSmoothEdges: (on: boolean) => void
  setOffsetScope: (scope: SmoothScope) => void
  setOffsetDirection: (direction: OffsetDirection) => void
  setOffsetDistance: (v: number) => void
  setBoolOp: (op: BooleanOp) => void
  /** Put a solid in hand, or take it out again if it is. */
  toggleBoolSolid: (key: string) => void
  setBoolSolids: (keys: string[]) => void
  setBoolClosed: (closed: { open: number; bad: number } | null) => void
  setTrimSolid: (key: string | null) => void
  /** A click on a body: it is put in hand, or put down if it is the one in
   *  hand. */
  toggleTrimSolid: (key: string) => void
  setTrimOffset: (v: number) => void
  setTrimDepth: (v: number) => void
  setTrimFlip: (on: boolean) => void
  setTrimView: (view: TrimView) => void
  setTrimBreak: (report: BreakReport | null, error: string | null) => void
  findTrimBreakAgain: () => void
  trimBegin: () => void
  trimResolve: (made: TrimMade) => void
  trimFail: (message: string) => void
  /** The piece on hand was made of a mesh that has just changed. */
  dropTrim: () => void
  /** Show or hide a row of the parts list. The scan and the reduced mesh
   *  lie on one surface, and drawn together each shows through the other in
   *  patches: showing one hides the other. */
  setPartShown: (part: 'scan' | 'reduced' | 'piece', shown: boolean) => void
  toggleBodyShown: (key: string) => void
  setShellThickness: (v: number) => void
  setShellSide: (side: ThickenSide) => void
  setShellSurvey: (survey: ShellSurvey | null) => void
  /** Size the settings to a part just loaded, where the user has not said
   *  what they should be — by its size, and how fine its mesh is. */
  suggestForPart: (bboxDiagonal: number, edgeLength?: number) => void
  /** A different scan has nothing to do with the last one's reduction, or
   *  its edits. */
  clear: () => void
}

const CLEARED = {
  status: 'idle' as MeshStatus,
  message: null,
  report: null,
  survey: null,
  surveyFailed: null,
  surveyAttempt: 0,
  holeSurvey: null,
  cutPreview: null,
  boolClosed: null,
  shellSurvey: null,
  trimBreak: null,
  trimBreakError: null,
  trimStatus: 'idle' as MeshStatus,
  trimMessage: null,
  trimMade: null,
  shownScan: true,
  shownReduced: false,
  shownPiece: true,
  shownBodies: [] as string[],
  confirming: false,
  editing: false,
  edits: [] as ScanEdit[],
  pending: [] as ScanEdit[],
  copyTriangles: null,
  copyDeviationStats: null,
  // A plane through the middle of whatever comes next.
  cutOffsetAuto: true,
}

export const useMeshTools = create<MeshState>()((set) => ({
  ...CLEARED,
  tool: 'reduce',
  resultVersion: 0,
  surveyVersion: 0,
  holeSurveyVersion: 0,
  copyVersion: 0,
  copyDeviation: false,
  copyDeviationVersion: 0,

  tolerance: 0.05,
  toleranceAuto: true,
  maxTriangles: DEFAULT_TRIANGLE_LIMIT,
  view: 'reduced',

  pieceSize: 2,
  pieceSizeAuto: true,

  cutRef: 'z',
  cutOffset: 0,
  cutKeep: 'plus',
  cutCap: true,

  holeSize: 5,
  holeSizeAuto: true,
  fillMode: 'curved',

  smoothScope: 'all',
  smoothSize: 2,
  smoothSizeAuto: true,
  smoothLimit: 0.2,
  smoothLimitAuto: true,
  smoothEdges: true,

  offsetScope: 'all',
  offsetDirection: 'expand',
  offsetDistance: 0.1,

  shellThickness: 2,
  shellThicknessAuto: true,
  shellSide: 'in',

  boolOp: 'subtract',
  boolSolids: [],

  trimSolid: null,
  trimOffset: 0,
  trimDepth: DEFAULT_BREAK_DEPTH,
  trimFlip: false,
  trimView: 'break',
  trimFinds: 0,
  trimVersion: 0,

  // The Boolean opens with nothing in hand: the solids of the last one were
  // used up by it, and a second operation is a new choice.
  setTool: (tool) =>
    set((s) => ({ tool, confirming: false, ...(tool === 'boolean' && s.tool !== 'boolean' ? { boolSolids: [] } : {}) })),

  begin: () => set({ status: 'running', message: null }),

  resolve: (report) =>
    set((s) => ({ status: 'ready', message: null, report, resultVersion: s.resultVersion + 1 })),

  // A failed reduction leaves the one before it standing — it is still a
  // true measurement of the mesh on screen.
  fail: (message) => set((s) => ({ status: s.report ? 'ready' : 'idle', message })),

  // The scan comes back in the parts list if the reduced mesh stood in for
  // it there.
  dropResult: () =>
    set((s) => ({ status: 'idle', report: null, resultVersion: s.resultVersion + 1, shownReduced: false, shownScan: s.shownScan || s.shownReduced })),

  setTolerance: (tolerance) => set({ tolerance: Math.max(1e-4, tolerance), toleranceAuto: false }),

  setMaxTriangles: (v) => set({ maxTriangles: Math.max(4, Math.round(v)) }),

  setView: (view) => set({ view }),

  setPieceSize: (v) => set({ pieceSize: Math.max(1e-3, v), pieceSizeAuto: false, confirming: false }),

  setSurvey: (survey) => set((s) => ({ survey, surveyVersion: s.surveyVersion + 1, confirming: false })),

  setSurveyFailed: (surveyFailed) => set({ surveyFailed }),

  retrySurvey: () => set((s) => ({ surveyFailed: null, surveyAttempt: s.surveyAttempt + 1 })),

  setConfirming: (confirming) => set({ confirming }),

  setEditing: (editing) => set({ editing }),

  addEdit: (edit) => set((s) => ({ edits: [...s.edits, edit] })),

  addPending: (edit) => set((s) => ({ pending: [...s.pending, edit] })),

  takePending: () => set((s) => ({ edits: [...s.edits, ...s.pending], pending: [] })),

  clearPending: () => set({ pending: [] }),

  setCopy: (copyTriangles) =>
    set((s) => ({ copyTriangles, copyVersion: s.copyVersion + 1, copyDeviationStats: null, confirming: false })),

  setCopyDeviation: (copyDeviation) => set({ copyDeviation }),

  setCopyDeviationStats: (copyDeviationStats) =>
    set((s) => ({ copyDeviationStats, copyDeviationVersion: s.copyDeviationVersion + 1 })),

  setCutRef: (cutRef) => set({ cutRef, cutOffset: 0, cutOffsetAuto: true }),

  setCutOffset: (v) => set({ cutOffset: Number.isFinite(v) ? v : 0, cutOffsetAuto: false }),

  setCutKeep: (cutKeep) => set({ cutKeep }),

  setCutCap: (cutCap) => set({ cutCap }),

  setCutPreview: (cutPreview) => set({ cutPreview }),

  setHoleSize: (v) => set({ holeSize: Math.max(1e-3, v), holeSizeAuto: false }),

  setFillMode: (fillMode) => set({ fillMode }),

  setHoleSurvey: (holeSurvey) => set((s) => ({ holeSurvey, holeSurveyVersion: s.holeSurveyVersion + 1 })),

  setSmoothScope: (smoothScope) => set({ smoothScope }),

  setSmoothSize: (v) => set({ smoothSize: Math.max(1e-3, v), smoothSizeAuto: false }),

  setSmoothLimit: (v) => set({ smoothLimit: Math.max(1e-4, v), smoothLimitAuto: false }),

  setSmoothEdges: (smoothEdges) => set({ smoothEdges }),

  setOffsetScope: (offsetScope) => set({ offsetScope }),

  setOffsetDirection: (offsetDirection) => set({ offsetDirection }),

  setOffsetDistance: (v) => set({ offsetDistance: Math.max(1e-4, Math.abs(v)) }),

  setBoolOp: (boolOp) => set({ boolOp }),

  toggleBoolSolid: (key) =>
    set((s) => ({ boolSolids: s.boolSolids.includes(key) ? s.boolSolids.filter((k) => k !== key) : [...s.boolSolids, key] })),

  setBoolSolids: (boolSolids) => set({ boolSolids }),

  setBoolClosed: (boolClosed) => set({ boolClosed }),

  setTrimSolid: (trimSolid) => set({ trimSolid }),

  toggleTrimSolid: (key) => set((s) => ({ trimSolid: s.trimSolid === key ? null : key })),

  setTrimOffset: (v) => set({ trimOffset: Number.isFinite(v) ? Math.max(0, v) : 0 }),

  setTrimDepth: (v) => set({ trimDepth: Number.isFinite(v) ? Math.max(1e-3, v) : DEFAULT_BREAK_DEPTH }),

  setTrimFlip: (trimFlip) => set({ trimFlip }),

  setTrimView: (trimView) => set({ trimView }),

  setTrimBreak: (trimBreak, trimBreakError) => set({ trimBreak, trimBreakError }),

  findTrimBreakAgain: () => set((s) => ({ trimFinds: s.trimFinds + 1 })),

  trimBegin: () => set({ trimStatus: 'running', trimMessage: null }),

  // A fresh piece is shown as it lands, and in the parts list once the tool
  // is put away.
  trimResolve: (trimMade) =>
    set((s) => ({ trimStatus: 'ready', trimMessage: null, trimMade, trimView: 'piece', trimVersion: s.trimVersion + 1, shownPiece: true })),

  // A failed attempt leaves the piece before it standing.
  trimFail: (trimMessage) => set((s) => ({ trimStatus: s.trimMade ? 'ready' : 'idle', trimMessage })),

  dropTrim: () => set((s) => ({ trimStatus: 'idle', trimMade: null, trimView: 'break', trimVersion: s.trimVersion + 1 })),

  setPartShown: (part, shown) =>
    set(
      part === 'scan'
        ? { shownScan: shown, ...(shown ? { shownReduced: false } : {}) }
        : part === 'reduced'
          ? { shownReduced: shown, ...(shown ? { shownScan: false } : {}) }
          : { shownPiece: shown },
    ),

  toggleBodyShown: (key) =>
    set((s) => ({ shownBodies: s.shownBodies.includes(key) ? s.shownBodies.filter((k) => k !== key) : [...s.shownBodies, key] })),

  setShellThickness: (v) => set({ shellThickness: Math.max(1e-3, v), shellThicknessAuto: false }),

  setShellSide: (shellSide) => set({ shellSide }),

  setShellSurvey: (shellSurvey) => set({ shellSurvey }),

  suggestForPart: (bboxDiagonal, edgeLength) =>
    set((s) => ({
      ...(s.toleranceAuto ? { tolerance: defaultTolerance(bboxDiagonal) } : {}),
      ...(s.pieceSizeAuto ? { pieceSize: defaultMinPiece(bboxDiagonal) } : {}),
      ...(s.holeSizeAuto ? { holeSize: defaultHoleSize(bboxDiagonal) } : {}),
      ...(s.smoothSizeAuto ? { smoothSize: defaultSmoothSize(bboxDiagonal, edgeLength) } : {}),
      ...(s.smoothLimitAuto ? { smoothLimit: defaultSmoothLimit(bboxDiagonal) } : {}),
      ...(s.shellThicknessAuto ? { shellThickness: defaultWallThickness(bboxDiagonal) } : {}),
    })),

  clear: () =>
    set((s) => ({
      ...CLEARED,
      trimView: 'break' as TrimView,
      trimVersion: s.trimVersion + 1,
      surveyVersion: s.surveyVersion + 1,
      holeSurveyVersion: s.holeSurveyVersion + 1,
      copyVersion: s.copyVersion + 1,
      copyDeviationVersion: s.copyDeviationVersion + 1,
      // An element the plane was taken across belonged to the last scan.
      ...(typeof s.cutRef === 'number' ? { cutRef: 'z' as const } : {}),
    })),
}))

type SettingsFields = Pick<MeshState, 'tolerance' | 'maxTriangles'>

/** The panel's settings, as the reduction takes them. */
export function reduceSettingsOf(s: SettingsFields): ReduceSettings {
  return { tolerance: s.tolerance, maxTriangles: s.maxTriangles }
}

/** The result on hand was made with other settings than the panel shows —
 *  it still stands, and is still what an export writes, but it is not what
 *  the panel asks for. */
export function reductionStale(s: SettingsFields & Pick<MeshState, 'report'>): boolean {
  if (!s.report) return false
  const made = s.report.settings
  return made.tolerance !== s.tolerance || made.maxTriangles !== s.maxTriangles
}

/** The piece on hand was made with other settings, or of another body, than
 *  the panel shows — it still stands, and is still what an export writes. */
export function trimStale(s: Pick<MeshState, 'trimMade' | 'trimSolid' | 'trimOffset' | 'trimDepth' | 'trimFlip'>): boolean {
  const made = s.trimMade
  if (!made) return false
  return made.solid !== s.trimSolid || made.report.offset !== s.trimOffset || made.depth !== s.trimDepth || made.flip !== s.trimFlip
}

const count = (n: number) => n.toLocaleString('en-US')

/** Where a cut was made, in `units`. The plane is kept as it was named, in
 *  mm, its figure last ("XY plane, Z 0.5 mm"), so for inches that figure is
 *  named again. */
function cutPlaneText(plane: string, units: DisplayUnits): string {
  if (units === 'mm') return plane
  // String() writes a very small or very large offset in exponent form
  // ("1e-7"), and the whole figure has to be read, not just its exponent.
  return plane.replace(/(\d+(?:\.\d+)?(?:e[+-]?\d+)?) mm$/, (_, v: string) => typedLen(Number(v), units))
}

/** One line of the list of edits, as the panel shows it — its lengths in
 *  `units`, mm unless asked, as a command answers. */
export function scanEditText(e: ScanEdit, units: DisplayUnits = 'mm'): string {
  const len = (mm: number) => typedLen(mm, units)
  switch (e.kind) {
    case 'pieces':
      return `Removed ${count(e.pieces)} island${e.pieces === 1 ? '' : 's'} under ${len(e.minSize)}`
    case 'delete':
      return 'Deleted marked surface'
    case 'flip':
      return e.region ? 'Flipped the normals of a marked region' : 'Flipped the normals'
    case 'cut':
      return `Cut at ${cutPlaneText(e.plane, units)}${e.capped > 0 ? `, closed flat` : ''}`
    case 'fill':
      return `Filled ${count(e.holes)} hole${e.holes === 1 ? '' : 's'} under ${len(e.maxSize)}${e.mode === 'flat' ? ', flat' : ''}`
    case 'smooth':
      return `Smoothed bumps under ${len(e.size)}${e.region ? ' in a marked region' : ''}, within ${len(e.limit)}`
    case 'boolean':
      return e.op === 'subtract' ? `Took ${e.solid} out` : e.op === 'add' ? `Added ${e.solid}` : `Kept what ${e.solid} shares`
    case 'offset':
      return `${e.distance > 0 ? 'Expanded' : 'Shrank'}${e.region ? ' a marked region' : ''} by ${len(Math.abs(e.distance))}`
    case 'shell':
      return e.mode === 'hollow'
        ? `Hollowed with a ${len(e.thickness)} wall`
        : `Thickened ${len(e.thickness)} ${e.side === 'out' ? 'outward' : e.side === 'both' ? 'to both sides' : 'inward'}`
  }
}

/** What the edit's line says on its right: the triangles it took or made,
 *  or how far it moved the surface — in `units`, mm unless asked. */
export function scanEditFigure(e: ScanEdit, units: DisplayUnits = 'mm'): string {
  switch (e.kind) {
    case 'pieces':
    case 'delete':
      return `−${count(e.triangles)} △`
    case 'flip':
      return `⇅ ${count(e.triangles)} △`
    case 'cut':
      return `−${count(e.removed)} △`
    case 'fill':
      return `+${count(e.triangles)} △`
    case 'smooth':
      return `≤ ${fmtLen(e.maxMove, units, 3)}`
    case 'boolean':
      return `${e.volume >= 0 ? '+' : '−'}${fmtVol(Math.abs(e.volume), units, 1)}`
    case 'offset':
      return `${e.distance > 0 ? '+' : '−'}${fmtLen(Math.abs(e.distance), units, 3)}`
    case 'shell':
      return e.mode === 'hollow' && e.volume !== undefined ? `−${fmtVol(e.volume, units, 1)}` : `+${count(e.triangles)} △`
  }
}

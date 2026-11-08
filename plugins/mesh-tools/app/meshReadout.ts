// SPDX-License-Identifier: AGPL-3.0-only
// The Mesh Tools workspace read out as plain JSON — its part of the
// session's readout (`plugins.mesh` in session.state) and what its commands
// answer with: the mesh it works on, the edits made, the settings each tool
// stands at, the reduced mesh, the wrap and the piece Trim to scan made, and
// the solids on offer. Nothing per vertex: a region is a count, a map its
// figures.

import { useStore } from '../../../src/state/store'
import type { Vec3 } from '../../../src/core/types'
import { reductionStale, scanEditFigure, scanEditText, trimStale, useMeshTools, wrapStale, type ScanEdit } from '../state/meshStore'
import type { TrimReport } from '../core/trimToScan'
import { booleanSolids } from './booleanSolids'

type MeshState = ReturnType<typeof useMeshTools.getState>

/** The coordinate planes as the commands name them, by the axis a cut is
 *  taken across. */
const PLANE_OF_AXIS = { z: 'XY', x: 'YZ', y: 'XZ' } as const

/** An edit as the list shows it: its line, its figure and what it holds. */
export const editOut = (e: ScanEdit) => ({ ...e, text: scanEditText(e), figure: scanEditFigure(e) })

/** What Cut or Mirror is taken across: a coordinate plane by name, or an
 *  element. */
function cutPlaneOut(ref: MeshState['cutRef']): string | { element: number; name: string | null } {
  if (typeof ref !== 'number') return PLANE_OF_AXIS[ref]
  return { element: ref, name: useStore.getState().elements.find((e) => e.id === ref)?.name ?? null }
}

/** Every tool's settings as the panel stands — what a tool runs with when a
 *  command leaves them out. */
function settingsOut(m: MeshState = useMeshTools.getState()) {
  return {
    reduce: { tolerance: m.tolerance, maxTriangles: m.maxTriangles },
    removeIslands: { size: m.pieceSize },
    cut: { plane: cutPlaneOut(m.cutRef), offset: m.cutOffsetAuto ? null : m.cutOffset, keep: m.cutKeep, cap: m.cutCap },
    mirror: { plane: cutPlaneOut(m.mirrorRef), offset: m.mirrorOffsetAuto ? null : m.mirrorOffset, mode: m.mirrorMode, keep: m.mirrorKeep },
    fillHoles: { size: m.holeSize, patch: m.fillMode },
    smooth: { size: m.smoothSize, limit: m.smoothLimit, keepEdges: m.smoothEdges, scope: m.smoothScope },
    densify: { maxEdge: m.densifyEdge },
    offset: { direction: m.offsetDirection, distance: m.offsetDistance, scope: m.offsetScope },
    boolean: { op: m.boolOp, solids: m.boolSolids },
    shell: { thickness: m.shellThickness, side: m.shellSide },
    trim: { body: m.trimSolid, offset: m.trimOffset, depth: m.trimDepth, flip: m.trimFlip },
    wrap: { gap: m.wrapGap, grow: m.wrapGrow, edges: m.wrapEdges },
  }
}

/** The reduced mesh on hand, measured — null with none. */
export function reductionOut(m: MeshState = useMeshTools.getState()) {
  const r = m.report
  if (!r) return m.status === 'running' ? { status: 'running' as const } : null
  return {
    status: m.status === 'running' ? ('running' as const) : ('ready' as const),
    triangles: r.triangles,
    fromTriangles: r.inputTriangles,
    tolerance: r.settings.tolerance,
    maxTriangles: r.settings.maxTriangles,
    held: r.held,
    capped: r.capped,
    withinTolerance: r.measured > 0 ? r.within / r.measured : null,
    p999: r.p999,
    max: r.max,
    rms: r.rms,
    backP999: r.backP999,
    backMax: r.backMax,
    stale: reductionStale(m),
  }
}

/** The wrap on hand, as it was made — null with none. */
export function wrapOut(m: MeshState = useMeshTools.getState()) {
  const made = m.wrapMade
  if (!made) return m.wrapStatus === 'running' ? { status: 'running' as const, stage: m.wrapStage } : null
  const r = made.report
  return {
    status: m.wrapStatus === 'running' ? ('running' as const) : ('ready' as const),
    gap: r.settings.gap,
    grow: r.settings.grow,
    edges: r.settings.edges,
    shells: r.shells,
    triangles: r.triangles,
    vertices: r.vertices,
    fromTriangles: r.inputTriangles,
    dropped: r.dropped,
    area: r.area,
    bridgedArea: r.bridgedArea,
    volumeBefore: made.volumeBefore,
    volume: r.volume,
    cell: r.cell,
    coarsened: r.coarsened,
    ...(r.fullGap !== null ? { fullGap: r.fullGap } : {}),
    ...(r.settings.edges === 'sharp' ? { sharpEdges: r.sharpEdges, sharpCorners: r.sharpCorners } : {}),
    stages: r.stages.map((s) => ({ stage: s.name, ms: Math.round(s.ms) })),
    ...(r.warning ? { warning: r.warning } : {}),
    stale: wrapStale(m),
  }
}

/** A piece's report as an agent reads it: how far its mating face is from
 *  the part, the offset included. */
function trimReportOut(r: TrimReport) {
  const half = r.slab / 2
  return {
    volume: r.volume,
    bodyVolume: r.bodyVolume,
    matingArea: r.matingArea,
    offset: r.offset,
    pieces: r.pieces,
    dropped: r.dropped,
    break: { area: r.break.area, pieces: r.break.pieces, marked: r.break.marked, depth: r.break.depth },
    gap: r.fit
      ? { median: half + r.fit.median, p05: half + r.fit.p05, p95: half + r.fit.p95, min: half + r.fit.min, max: half + r.fit.max }
      : null,
  }
}

/** The piece Trim to scan made — null with none. */
export function pieceOut(m: MeshState = useMeshTools.getState()) {
  const made = m.trimMade
  if (!made) return m.trimStatus === 'running' ? { status: 'running' as const } : null
  return { body: made.name, key: made.solid, flip: made.flip, depth: made.depth, ...trimReportOut(made.report), stale: trimStale(m) }
}

/** The solids Boolean and Trim to scan are offered, by key: the bodies
 *  other workspaces lend, and the cylinders, cones and spheres measured. */
const solidsOut = () => booleanSolids().map((s) => ({ key: s.key, name: s.name, source: s.source }))

/** What is in the workspace: the mesh it works on, the edits made, what was
 *  made beside it, the solids on offer, and what the parts list shows. */
export function partsOut() {
  const m = useMeshTools.getState()
  const s = useStore.getState()
  return {
    scan: s.fileName ? { name: s.fileName, triangles: s.triangleCount, edits: m.edits.map(editOut) } : null,
    copy: m.copyTriangles !== null ? { triangles: m.copyTriangles, edits: m.pending.map(editOut) } : null,
    reduced: reductionOut(m),
    wrap: wrapOut(m),
    piece: pieceOut(m),
    solids: solidsOut(),
    shown: { scan: m.shownScan, reduced: m.shownReduced, piece: m.shownPiece, bodies: m.shownBodies },
  }
}

/** The workspace's part of the session's readout. */
export function describeMesh() {
  const m = useMeshTools.getState()
  return {
    tool: m.tool,
    working: useStore.getState().fileName ? (m.copyTriangles !== null ? 'edited copy' : 'scan') : null,
    editing: m.editing,
    ...partsOut(),
    settings: settingsOut(m),
    ...(m.message ? { reduceMessage: m.message } : {}),
    ...(m.trimMessage ? { trimMessage: m.trimMessage } : {}),
    ...(m.wrapMessage ? { wrapMessage: m.wrapMessage } : {}),
  }
}

/** A point as three numbers, rounded to a micrometre. */
export const pointOut = (a: Float32Array, i: number): Vec3 => [
  Math.round(a[i * 3] * 1000) / 1000,
  Math.round(a[i * 3 + 1] * 1000) / 1000,
  Math.round(a[i * 3 + 2] * 1000) / 1000,
]

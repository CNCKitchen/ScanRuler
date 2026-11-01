// SPDX-License-Identifier: AGPL-3.0-only
// The Mesh Tools workspace's part of a project file, under the key `mesh`:
// what the reduction is asked for, and whether the scan had been reduced —
// the reduced mesh itself is not saved, it is made again on load from the
// same settings, the way a map is measured again — the other tools'
// settings (Trim to scan's piece is not saved either: it is made again with
// a click), the edits made, and the copy of the scan being edited beside it
// in files of its own. Absent in projects saved before the workspace
// existed: the settings stay as the scan's size suggested them.

import { editedCopy } from '../state/editedCopy'
import { meshToolsSession } from './meshToolsSession'
import { readAs } from '../../../src/app/project'
import type { ProjectSection } from '../../../src/app/projectSections'
import { array, fields, invalid, object } from '../../../src/core/project/validation'
import { useStore } from '../../../src/state/store'
import { usePrefs } from '../../../src/state/prefsStore'
import { DEFAULT_TRIANGLE_LIMIT, useMeshTools, type ScanEdit } from '../state/meshStore'

/** The copy of the scan Mesh Tools edits, and every scan vertex's number on
 *  it — little-endian int32s, −1 for one an edit took. */
const EDITED_MEMBER = 'edited.ply'
const EDITED_MAP_MEMBER = 'edited-map.bin'

export interface MeshPart {
  reduced: boolean
  tolerance: number
  toleranceAuto: boolean
  /** Null in a project from when there could be no limit — read as the
   *  limit a reduction starts with. */
  maxTriangles: number | null
  pieceSize: number
  pieceSizeAuto: boolean
  /** The other edit tools' settings. Absent in projects saved before those
   *  tools existed: the tools start as they would for a scan just opened. */
  cut?: {
    /** A coordinate axis, or an element's id. */
    ref: 'x' | 'y' | 'z' | number
    offset: number
    offsetAuto: boolean
    keep: 'plus' | 'minus'
    cap: boolean
  }
  fill?: { size: number; sizeAuto: boolean; mode: 'curved' | 'flat' }
  smooth?: { size: number; sizeAuto: boolean; limit: number; limitAuto: boolean; keepEdges: boolean; scope?: 'all' | 'marked' }
  /** What Boolean does with the solid. Absent before the tool existed. */
  boolean?: { op: 'subtract' | 'add' | 'intersect' }
  /** Shrink / expand's and Shell's settings. Absent before the tools
   *  existed. */
  offset?: { distance: number; direction: 'expand' | 'shrink'; scope: 'all' | 'marked' }
  shell?: { thickness: number; thicknessAuto: boolean; side: 'in' | 'out' | 'both' }
  /** Trim to scan's settings: the offset from the break, the depth the break
   *  is found at, and which side is kept. Absent before the tool existed. */
  trim?: { offset: number; depth: number; flip: boolean }
  /** What the workspace did to the scan, oldest first. The scan's member
   *  holds the result, as a PLY — see core/plyWriter — so this is the
   *  account of it, not a recipe to run again. Absent: nothing. */
  edits?: ScanEditJson[]
  /** The copy of the scan the workspace edits, not yet taken into use: its
   *  member, a PLY in the frame the scan was opened in, the member that
   *  carries the scan's vertex numbers onto it, and the edits made on it.
   *  Absent: no copy. */
  copy?: { member: string; mapMember: string; pending: ScanEditJson[] }
}

export type ScanEditJson =
  | { kind: 'pieces'; minSize: number; pieces: number; triangles: number }
  | { kind: 'delete'; triangles: number }
  | { kind: 'flip'; triangles: number; region?: number }
  | { kind: 'cut'; plane: string; removed: number; capped: number; open: number }
  | { kind: 'fill'; maxSize: number; mode: 'curved' | 'flat'; holes: number; triangles: number }
  | { kind: 'smooth'; size: number; limit: number; maxMove: number; region?: number }
  | { kind: 'boolean'; op: 'subtract' | 'add' | 'intersect'; solid: string; removed: number; added: number; volume: number }
  | { kind: 'offset'; distance: number; maxMove: number; region?: number }
  | {
      kind: 'shell'
      mode: 'hollow' | 'thicken'
      thickness: number
      side?: 'in' | 'out' | 'both'
      triangles: number
      cavities?: number
      volume?: number
    }

/** A vertex map's bytes — the same view every time for the same map, since
 *  a member's identity is what says whether the session changed (see
 *  projectSnapshot). */
const mapViews = new WeakMap<Int32Array, Uint8Array>()
function mapBytes(map: Int32Array): Uint8Array {
  let bytes = mapViews.get(map)
  if (!bytes) {
    bytes = new Uint8Array(map.buffer, map.byteOffset, map.byteLength)
    mapViews.set(map, bytes)
  }
  return bytes
}

/** The vertex count a copy's PLY header states, or -1 for a header that
 *  does not state one. The copy is always the binary PLY buildBinaryPly
 *  writes, so its header is short ASCII at the very start. */
function plyVertexCount(bytes: Uint8Array): number {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096))
  const end = head.indexOf('end_header')
  const m = /^element vertex (\d+)$/m.exec(end < 0 ? '' : head.slice(0, end))
  return m ? Number(m[1]) : -1
}

const BOOLEAN_OPS: readonly string[] = ['subtract', 'add', 'intersect']
const SIDES: readonly string[] = ['in', 'out', 'both']

/** Check a part as read from a file. */
function validateMeshPart(raw: unknown): MeshPart {
  const x = object(raw, 'mesh')
  fields(x, 'tolerance pieceSize', 'number', 'mesh')
  fields(x, 'reduced toleranceAuto pieceSizeAuto', 'boolean', 'mesh')
  if ((x.tolerance as number) <= 0 || (x.pieceSize as number) <= 0) invalid('mesh sizes')
  // Null is "no limit", from before the limit was always a number.
  if (x.maxTriangles !== null && (!Number.isSafeInteger(x.maxTriangles) || (x.maxTriangles as number) < 1)) invalid('mesh.maxTriangles')
  if (x.cut !== undefined) {
    const c = object(x.cut, 'mesh.cut')
    if (!(c.ref === 'x' || c.ref === 'y' || c.ref === 'z' || (Number.isSafeInteger(c.ref) && (c.ref as number) >= 0))) invalid('mesh.cut.ref')
    fields(c, 'offset', 'number', 'mesh.cut')
    fields(c, 'offsetAuto cap', 'boolean', 'mesh.cut')
    if (c.keep !== 'plus' && c.keep !== 'minus') invalid('mesh.cut.keep')
  }
  if (x.fill !== undefined) {
    const f = object(x.fill, 'mesh.fill')
    fields(f, 'size', 'number', 'mesh.fill')
    fields(f, 'sizeAuto', 'boolean', 'mesh.fill')
    if ((f.size as number) <= 0) invalid('mesh.fill.size')
    if (f.mode !== 'curved' && f.mode !== 'flat') invalid('mesh.fill.mode')
  }
  if (x.smooth !== undefined) {
    const s = object(x.smooth, 'mesh.smooth')
    fields(s, 'size limit', 'number', 'mesh.smooth')
    fields(s, 'sizeAuto limitAuto keepEdges', 'boolean', 'mesh.smooth')
    if ((s.size as number) <= 0 || (s.limit as number) <= 0) invalid('mesh.smooth')
    if (s.scope !== undefined && s.scope !== 'all' && s.scope !== 'marked') invalid('mesh.smooth.scope')
  }
  if (x.boolean !== undefined) {
    const b = object(x.boolean, 'mesh.boolean')
    if (!BOOLEAN_OPS.includes(b.op as string)) invalid('mesh.boolean.op')
  }
  if (x.offset !== undefined) {
    const o = object(x.offset, 'mesh.offset')
    fields(o, 'distance', 'number', 'mesh.offset')
    if (!((o.distance as number) > 0)) invalid('mesh.offset.distance')
    if (o.direction !== 'expand' && o.direction !== 'shrink') invalid('mesh.offset.direction')
    if (o.scope !== 'all' && o.scope !== 'marked') invalid('mesh.offset.scope')
  }
  if (x.shell !== undefined) {
    const s = object(x.shell, 'mesh.shell')
    fields(s, 'thickness', 'number', 'mesh.shell')
    fields(s, 'thicknessAuto', 'boolean', 'mesh.shell')
    if (!((s.thickness as number) > 0)) invalid('mesh.shell.thickness')
    if (!SIDES.includes(s.side as string)) invalid('mesh.shell.side')
  }
  if (x.trim !== undefined) {
    const t = object(x.trim, 'mesh.trim')
    fields(t, 'offset depth', 'number', 'mesh.trim')
    fields(t, 'flip', 'boolean', 'mesh.trim')
    if (!((t.offset as number) >= 0) || !((t.depth as number) > 0)) invalid('mesh.trim')
  }
  // What was done to the scan: a list to show, the file itself holding the
  // result.
  const scanEdits = (list: unknown, where: string) => {
    for (const item of array(list, where)) {
      const edit = object(item, where)
      if (edit.kind === 'pieces') fields(edit, 'minSize pieces triangles', 'number', where)
      else if (edit.kind === 'delete') fields(edit, 'triangles', 'number', where)
      else if (edit.kind === 'flip') {
        fields(edit, 'triangles', 'number', where)
        if (edit.region !== undefined && typeof edit.region !== 'number') invalid(`${where}.region`)
      } else if (edit.kind === 'cut') {
        fields(edit, 'plane', 'string', where)
        fields(edit, 'removed capped open', 'number', where)
      } else if (edit.kind === 'fill') {
        fields(edit, 'maxSize holes triangles', 'number', where)
        if (edit.mode !== 'curved' && edit.mode !== 'flat') invalid(`${where}.mode`)
      } else if (edit.kind === 'smooth') {
        fields(edit, 'size limit maxMove', 'number', where)
        if (edit.region !== undefined && typeof edit.region !== 'number') invalid(`${where}.region`)
      } else if (edit.kind === 'boolean') {
        fields(edit, 'solid', 'string', where)
        fields(edit, 'removed added volume', 'number', where)
        if (!BOOLEAN_OPS.includes(edit.op as string)) invalid(`${where}.op`)
      } else if (edit.kind === 'offset') {
        fields(edit, 'distance maxMove', 'number', where)
        if (edit.region !== undefined && typeof edit.region !== 'number') invalid(`${where}.region`)
      } else if (edit.kind === 'shell') {
        fields(edit, 'thickness triangles', 'number', where)
        if (edit.mode !== 'hollow' && edit.mode !== 'thicken') invalid(`${where}.mode`)
        if (edit.side !== undefined && !SIDES.includes(edit.side as string)) invalid(`${where}.side`)
        for (const key of ['cavities', 'volume'] as const) {
          if (edit[key] !== undefined && typeof edit[key] !== 'number') invalid(`${where}.${key}`)
        }
      } else invalid(`${where}.kind`)
    }
  }
  if (x.edits !== undefined) scanEdits(x.edits, 'mesh.edits')
  // The copy being edited: its files, and what was done to it.
  if (x.copy !== undefined) {
    const c = object(x.copy, 'mesh.copy')
    fields(c, 'member mapMember', 'string', 'mesh.copy')
    scanEdits(c.pending, 'mesh.copy.pending')
  }
  return raw as MeshPart
}

/** An edit as the list keeps it, with only the fields its kind has. */
function scanEditOf(e: ScanEditJson): ScanEdit {
  switch (e.kind) {
    case 'pieces':
      return { kind: e.kind, minSize: e.minSize, pieces: e.pieces, triangles: e.triangles }
    case 'delete':
      return { kind: e.kind, triangles: e.triangles }
    case 'flip':
      return { kind: e.kind, triangles: e.triangles, ...(e.region !== undefined ? { region: e.region } : {}) }
    case 'cut':
      return { kind: e.kind, plane: e.plane, removed: e.removed, capped: e.capped, open: e.open }
    case 'fill':
      return { kind: e.kind, maxSize: e.maxSize, mode: e.mode, holes: e.holes, triangles: e.triangles }
    case 'smooth':
      return { kind: e.kind, size: e.size, limit: e.limit, maxMove: e.maxMove, ...(e.region !== undefined ? { region: e.region } : {}) }
    case 'boolean':
      return { kind: e.kind, op: e.op, solid: e.solid, removed: e.removed, added: e.added, volume: e.volume }
    case 'offset':
      return { kind: e.kind, distance: e.distance, maxMove: e.maxMove, ...(e.region !== undefined ? { region: e.region } : {}) }
    case 'shell':
      return {
        kind: e.kind,
        mode: e.mode,
        thickness: e.thickness,
        triangles: e.triangles,
        ...(e.side !== undefined ? { side: e.side } : {}),
        ...(e.cavities !== undefined ? { cavities: e.cavities } : {}),
        ...(e.volume !== undefined ? { volume: e.volume } : {}),
      }
  }
}

function meshPartState(p: MeshPart): Partial<ReturnType<typeof useMeshTools.getState>> {
  return {
    tolerance: p.tolerance,
    toleranceAuto: p.toleranceAuto,
    maxTriangles: p.maxTriangles ?? DEFAULT_TRIANGLE_LIMIT,
    pieceSize: p.pieceSize,
    pieceSizeAuto: p.pieceSizeAuto,
    ...(p.cut
      ? { cutRef: p.cut.ref, cutOffset: p.cut.offset, cutOffsetAuto: p.cut.offsetAuto, cutKeep: p.cut.keep, cutCap: p.cut.cap }
      : {}),
    ...(p.fill ? { holeSize: p.fill.size, holeSizeAuto: p.fill.sizeAuto, fillMode: p.fill.mode } : {}),
    ...(p.smooth
      ? {
          smoothSize: p.smooth.size,
          smoothSizeAuto: p.smooth.sizeAuto,
          smoothLimit: p.smooth.limit,
          smoothLimitAuto: p.smooth.limitAuto,
          smoothEdges: p.smooth.keepEdges,
          ...(p.smooth.scope ? { smoothScope: p.smooth.scope } : {}),
        }
      : {}),
    ...(p.boolean ? { boolOp: p.boolean.op } : {}),
    ...(p.offset ? { offsetDistance: p.offset.distance, offsetDirection: p.offset.direction, offsetScope: p.offset.scope } : {}),
    ...(p.shell ? { shellThickness: p.shell.thickness, shellThicknessAuto: p.shell.thicknessAuto, shellSide: p.shell.side } : {}),
    ...(p.trim ? { trimOffset: p.trim.offset, trimDepth: p.trim.depth, trimFlip: p.trim.flip } : {}),
    edits: (p.edits ?? []).map(scanEditOf),
    pending: (p.copy?.pending ?? []).map(scanEditOf),
  }
}

const PERSISTED = ['report', 'tolerance', 'toleranceAuto', 'maxTriangles', 'pieceSize', 'pieceSizeAuto', 'edits', 'pending', 'copyVersion'] as const

export const meshSection: ProjectSection<MeshPart> = {
  key: 'mesh',
  collect({ sources, addMember }) {
    const x = useMeshTools.getState()
    const part: MeshPart = {
      reduced: x.report !== null,
      tolerance: x.tolerance,
      toleranceAuto: x.toleranceAuto,
      maxTriangles: x.maxTriangles,
      pieceSize: x.pieceSize,
      pieceSizeAuto: x.pieceSizeAuto,
      cut: { ref: x.cutRef, offset: x.cutOffset, offsetAuto: x.cutOffsetAuto, keep: x.cutKeep, cap: x.cutCap },
      fill: { size: x.holeSize, sizeAuto: x.holeSizeAuto, mode: x.fillMode },
      smooth: {
        size: x.smoothSize,
        sizeAuto: x.smoothSizeAuto,
        limit: x.smoothLimit,
        limitAuto: x.smoothLimitAuto,
        keepEdges: x.smoothEdges,
        scope: x.smoothScope,
      },
      boolean: { op: x.boolOp },
      offset: { distance: x.offsetDistance, direction: x.offsetDirection, scope: x.offsetScope },
      shell: { thickness: x.shellThickness, thicknessAuto: x.shellThicknessAuto, side: x.shellSide },
      trim: { offset: x.trimOffset, depth: x.trimDepth, flip: x.trimFlip },
      ...(x.edits.length > 0 ? { edits: x.edits } : {}),
    }
    // The copy being edited, beside the scan: the file and the numbering that
    // carries the scan's vertices onto it.
    const copy = editedCopy.current
    if (copy && sources.scan) {
      addMember(EDITED_MEMBER, copy.source.bytes)
      addMember(EDITED_MAP_MEMBER, mapBytes(copy.map))
      part.copy = { member: EDITED_MEMBER, mapMember: EDITED_MAP_MEMBER, pending: x.pending }
    }
    return part
  },
  members: (part) => (part.copy ? [part.copy.member, part.copy.mapMember] : []),
  prepare(value, { members }) {
    // A project from before the workspace leaves the settings as the scan's
    // size suggested them.
    if (value === undefined) return () => {}
    const part = validateMeshPart(value)
    for (const member of part.copy ? [part.copy.member, part.copy.mapMember] : []) {
      if (!members.has(member)) throw new Error(`Project is missing ${member}.`)
    }
    // The map is checked here, while the session being replaced is still
    // whole, as far as it can be without the scan it belongs to: whole
    // int32s, each a vertex number or -1 for one an edit took.
    const map = part.copy && members.get(part.copy.mapMember)
    if (map) {
      if (map.byteLength % 4 !== 0) throw new Error('Malformed project: mesh.copy.')
      const numbers = new Int32Array(map.slice().buffer)
      for (let i = 0; i < numbers.length; i++) if (numbers[i] < -1) throw new Error('Malformed project: mesh.copy.')
    }
    const state = meshPartState(part)
    return () => useMeshTools.setState(state)
  },
  async restore(part, { manifest, members }) {
    // The copy being edited, back beside the scan it is a copy of — before a
    // reduction, which was made of it.
    const copy = manifest.scan && part.copy
    if (!manifest.scan || !copy) return
    const bytes = members.get(copy.member)
    const map = members.get(copy.mapMember)
    if (!bytes || !map) throw new Error(`Project is missing ${bytes ? copy.mapMember : copy.member}.`)
    // Only now is the scan in place to size the map against, and the copy's
    // header to bound its numbers: one past the copy's vertices would carry
    // a selection onto vertices the copy does not have.
    const numbers = new Int32Array(map.slice().buffer)
    const copyVertices = plyVertexCount(bytes)
    let fits = numbers.length === useStore.getState().vertexCount && copyVertices >= 0
    for (let i = 0; fits && i < numbers.length; i++) if (numbers[i] >= copyVertices) fits = false
    if (!fits) {
      // The edits listed as waiting on the copy went with it.
      useMeshTools.setState({ pending: [] })
      throw new Error('Malformed project: mesh.copy.')
    }
    await meshToolsSession()?.setEditedCopy({ source: { name: readAs(manifest.scan.fileName, copy.member), bytes }, map: numbers })
  },
  async remeasure(part, { manifest }) {
    // Reduced again for the screen, its status line in the units shown.
    if (manifest.scan && part.reduced) await meshToolsSession()?.runReduce(usePrefs.getState().units)
  },
  // The settings alone are no work; an edited scan is, the file it came from
  // no longer saying it.
  hasContent: () => false,
  holdsWork: () => useMeshTools.getState().edits.length > 0,
  holds: () => ({ scanEdits: useMeshTools.getState().edits.length }),
  watch(changed) {
    // The edits come with the scan's file changing under them — the file is
    // not in any store, so the list of them is what is watched.
    return useMeshTools.subscribe((s, prev) => {
      if (PERSISTED.some((k) => s[k] !== prev[k])) changed()
    })
  },
}

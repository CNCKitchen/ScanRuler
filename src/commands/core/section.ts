// SPDX-License-Identifier: AGPL-3.0-only
// Sections: the scan cut with a plane, for measuring in 2D.

import { boxOnSheet, canCutAlong, cutAxisOf, frameTurnedUp, pointOnSheet, RADIAL_AXIS_KINDS, type SectionFrame, type SectionPlaneRef, sketchFrameOn, type WorldAxis, worldAxisDir, worldPlaneName } from '../../core/section/frame'
import { FACING_DEG, runIndices, sideMask, sidedChains, type Skin } from '../../core/section/skin'
import { projectCut, projectCutNormals } from '../../core/section/slice'
import { useDeviation } from '../../state/deviationStore'
import { useFlat } from '../../state/flatStore'
import { sectionDraftReady, useStore, type Section } from '../../state/store'
import { commandHost } from '../host'
import { elementRefSchema, findElement, parsePlaneName, refOf, requireScan, type ElementRef } from '../refs'
import { arr, bool, enumOf, int, num, obj, oneOf, str, vec3 } from '../schema'
import { describeSection } from '../state'
import { CommandError, type Command } from '../types'
import { findSheetPlane, sectionLayers, type SectionOutline, type SectionPiece, type SectionSheet } from '../sectionLayers'
import { EDGE_MIN_FEATURE_MM } from '../../core/flat/edges'
import type { Vec3 } from '../../core/types'
import { requireMeasureFree, showWorkspace, waitFor } from './common'
import { round4 } from '../../core/round'
import type { SectionPictureInput, SectionPictureModel, SheetAxis } from '../../app/sectionPicture'

/** A plane through an axis, as section.cut takes it: the axis an element's
 *  (by id or name) or a coordinate axis's, "X", "Y" or "Z". */
type RadialIn = { axis: ElementRef; angleDeg: number }

/** What section.cut is told to cut through an axis, as the section keeps
 *  it. */
function radialRefOf(across: RadialIn): SectionPlaneRef {
  const { axis, angleDeg } = across
  if (!Number.isFinite(angleDeg)) throw new CommandError('invalid_input', 'across.angleDeg: give the angle about the axis in degrees.')
  if (typeof axis === 'string' && /^\s*[xyz]\s*$/i.test(axis) && !useStore.getState().elements.some((e) => e.name.trim().toLowerCase() === axis.trim().toLowerCase())) {
    return { axis: axis.trim().toLowerCase() as WorldAxis, angleDeg }
  }
  const el = findElement(axis)
  if (!el.fit || !RADIAL_AXIS_KINDS.includes(el.kind)) {
    throw new CommandError('invalid_input', `${el.name} has no axis to lay a plane through — choose a cylinder, cone, line or circle.`)
  }
  return { axis: el.id, angleDeg }
}

const cut: Command<{ across: ElementRef | RadialIn; offset?: number; name?: string; kind?: 'cut' | 'shadow'; play?: number; tolerance?: number; smoothDeg?: number; extrude?: boolean }> = {
  name: 'cut',
  title: 'Cut a section',
  description:
    'Cut the scan with a plane and keep the cut as a section, put on the 2D sheet. across: an element with a direction (plane, cylinder, cone, line, circle) by id or name; "XY", "YZ" or "XZ" through the part’s centre; or { axis, angleDeg }, a plane through an axis turned angleDeg about it — a half section of a turned part. offset slides the plane along its normal, mm (a coordinate plane: the coordinate itself). kind "shadow" keeps the scan’s shadow instead: the whole part projected onto the plane, its outer boundary as loops read as lines and arcs (tolerance, play, smoothDeg), stood up as a block for export.step (extrude). Trap: a shadow takes no offset. Returns the section: its plane and chain count — a shadow also its loops, area and band. One undo step.',
  input: obj(
    {
      across: oneOf(
        [
          int('An element’s id.', { minimum: 1 }),
          str('An element’s name, or "XY", "YZ", "XZ".', { minLength: 1 }),
          obj(
            {
              axis: elementRefSchema('A cylinder, cone, line or circle, or a coordinate axis "X", "Y", "Z".'),
              angleDeg: num('Degrees about the axis.'),
            },
            ['axis', 'angleDeg'],
            'A plane through an axis.',
          ),
        ],
        'An element with a direction, a coordinate plane, or { axis, angleDeg }.',
      ),
      offset: num('Along the normal, mm. A cut’s only.'),
      name: str('A name; otherwise numbered — "Section 2".', { minLength: 1 }),
      kind: enumOf(['cut', 'shadow'], 'cut (the default), or shadow: the whole scan projected onto the plane.'),
      play: num('Shadow: clearance outside the part, mm; 1 by default, negative a press fit.'),
      tolerance: num('Shadow: lines and arcs read to this, mm; 0.1 by default.', { exclusiveMinimum: 0 }),
      smoothDeg: num('Shadow: corners turning less than this are rounded, degrees; 30 by default, 0 keeps all sharp.', { minimum: 0, maximum: 180 }),
      extrude: bool('Shadow: stood up as a block through the part, for export.step; true by default.'),
    },
    ['across'],
  ),
  label: () => 'cut section',
  run: async ({ across, offset, name, kind, play, tolerance, smoothDeg, extrude }) => {
    requireScan()
    requireMeasureFree()
    if (kind !== 'shadow' && (play !== undefined || tolerance !== undefined || smoothDeg !== undefined || extrude !== undefined)) {
      throw new CommandError('invalid_input', 'play, tolerance, smoothDeg and extrude are a shadow’s — give kind "shadow" with them.')
    }
    if (kind === 'shadow' && offset !== undefined) {
      throw new CommandError('invalid_input', 'A shadow takes no offset: it is the same outline anywhere along the normal and is drawn in the middle of the part.')
    }
    let ref: SectionPlaneRef
    const world = typeof across === 'string' ? parsePlaneName(across) : null
    if (world) ref = world
    else if (typeof across === 'object') ref = radialRefOf(across)
    else {
      const el = findElement(across)
      if (!el.fit || !canCutAlong(el.kind)) {
        throw new CommandError('invalid_input', `${el.name} has no direction to cut across — choose a plane, cylinder, cone, line or circle.`)
      }
      ref = el.id
    }
    showWorkspace('elements')
    const sections = commandHost().session.sections
    try {
      useStore.getState().startSection()
      useStore.getState().setSectionDraftRef(ref)
      if (!useStore.getState().sectionDraft?.axis) throw new CommandError('invalid_input', 'That cannot be cut across.')
      if (offset !== undefined) useStore.getState().setSectionDraftOffset(offset)
      if (kind === 'shadow') {
        useStore.getState().setSectionDraftKind('shadow')
        useStore.getState().setSectionDraftShadow({ play, tolerance, smoothDeg, extrude })
      }
      await sections.pumpDraft()
      const d = useStore.getState().sectionDraft
      if (!sectionDraftReady(d)) {
        throw new CommandError(
          'failed',
          d?.message ?? (kind === 'shadow' ? 'The scan casts no shadow on that plane — seen along its normal it has no area (a sheet edge-on).' : 'The plane misses the scan — there is nothing to cut there.'),
        )
      }
      const id = useStore.getState().commitSection()
      if (id === null) throw new CommandError('failed', 'The section could not be made.')
      // What Create does: the new section goes on the 2D sheet.
      useFlat.getState().setSubject({ kind: 'section', id })
      if (name) {
        // Renamed as its row's edit box does it: re-opened on its own plane,
        // which may want its cut taken again before it saves.
        useStore.getState().editSection(id)
        useStore.getState().setSectionDraftName(name)
        await sections.pumpDraft()
        if (useStore.getState().commitSection() === null) throw new CommandError('failed', 'The section could not be renamed.')
      }
      return { section: describeSection(useStore.getState().sections.find((x) => x.id === id)!) }
    } finally {
      if (useStore.getState().sectionDraft) useStore.getState().cancelSection()
    }
  },
}

/** The section an id or a name stands for — whole names, case aside; a
 *  name two sections share is refused rather than guessed. */
export function findSection(given: number | string): Section {
  const { sections } = useStore.getState()
  const ref = refOf(sections, given)
  if (typeof ref === 'number') {
    const sec = sections.find((x) => x.id === ref)
    if (!sec) throw new CommandError('not_found', `There is no section ${ref} — there are ${sections.map((x) => `${x.id} (${x.name})`).join(', ') || 'none'}.`)
    return sec
  }
  const want = ref.trim().toLowerCase()
  const hits = sections.filter((x) => x.name.trim().toLowerCase() === want)
  if (hits.length === 0) throw new CommandError('not_found', `There is no section named "${ref}" — there are ${sections.map((x) => `"${x.name}"`).join(', ') || 'none'}.`)
  if (hits.length > 1) throw new CommandError('invalid_input', `${hits.length} sections are named "${ref}" — name it by its id.`)
  return hits[0]
}

/** How many points a section's answer holds unless told otherwise, and at
 *  most — past it every k-th point of each chain is kept. */
const GET_LIMIT = 4000
const GET_MAX = 50_000

const get: Command<{ section: number | string; chains?: number[]; space?: 'sheet' | 'world' | 'both'; limit?: number; skin?: Skin; facing?: { dir: [number, number]; withinDeg?: number } }> = {
  name: 'get',
  title: 'Read a section’s polylines',
  description:
    'A section’s cut as polylines: each chain’s points in order — [u, v] mm on the sheet, what flat.fit and a sketch on the section take, or with space "world" or "both" [x, y, z] in the current frame — with the plane (origin, normal, basisU, basisV) and per chain closed, length, points, bounds. Trap: at most limit points over all chains (4000 by default, 50000 at most); past it every k-th point is kept and step says k. chains picks chains by index; skin "outer" or "inner" reads one skin of a thin wall alone, facing the points whose way out lies within withinDeg of dir, each chain then coming back as runs. Changes nothing.',
  input: obj(
    {
      section: oneOf([int('The section’s id.', { minimum: 1 }), str('Its name — "Section 1".', { minLength: 1 })], 'The section, by id or name.'),
      chains: arr(int('A chain’s index.', { minimum: 0 }), 'Which chains; every one by default.', { minItems: 1 }),
      space: enumOf(['sheet', 'world', 'both'], 'sheet (the default): [u, v]; world: [x, y, z]; both.'),
      limit: int(`Points at most over every chain; ${GET_LIMIT} by default, ${GET_MAX} at most.`, { minimum: 2, maximum: GET_MAX }),
      skin: enumOf(['outer', 'inner'], 'One skin of a thin wall alone.'),
      facing: obj(
        { dir: arr(num(), '[u, v] on the sheet.', { minItems: 2, maxItems: 2 }), withinDeg: num(`Degrees; ${FACING_DEG} by default.`, { exclusiveMinimum: 0, maximum: 180 }) },
        ['dir'],
        'Only the points whose way out of the material lies within withinDeg of dir.',
      ),
    },
    ['section'],
  ),
  readOnly: true,
  run: async ({ section, chains: which, space = 'sheet', limit = GET_LIMIT, skin, facing }) => {
    requireScan()
    const id = findSection(section).id
    // A section loaded from a project, or whose plane was just moved, is cut
    // again by the worker a moment later: wait for the cut.
    const sec = await waitFor(() => {
      const s = useStore.getState().sections.find((x) => x.id === id)
      return s?.cut || s?.message ? s : null
    }, 'the section to be cut', 60_000)
    if (!sec.cut) throw new CommandError('failed', sec.message ?? 'The section has no cut.')
    const cut = sec.cut
    const flat = projectCut(cut, sec.frame)
    const count = cut.offsets.length - 1
    const picked = which ?? Array.from({ length: count }, (_, i) => i)
    for (const c of picked) if (c >= count) throw new CommandError('not_found', `${sec.name} has no chain ${c} — it has ${count}${count > 0 ? ` (0 to ${count - 1})` : ''}.`)
    const loopsAt = (from: number, last: number) => last - from > 1 && cut.points[from * 3] === cut.points[last * 3] && cut.points[from * 3 + 1] === cut.points[last * 3 + 1] && cut.points[from * 3 + 2] === cut.points[last * 3 + 2]
    // What is read of each chain, as the indices of its points in the cut:
    // all of it, or its runs on the side skin or facing asks for.
    let parts: { index: number; run?: number; at: number[] }[]
    if (skin || facing) {
      const fl = facing ? Math.hypot(facing.dir[0], facing.dir[1]) : 1
      if (!(fl > 0)) throw new CommandError('invalid_input', 'facing.dir: give a direction on the sheet, not [0, 0].')
      const normals = projectCutNormals(cut, sec.frame)
      if (!normals) throw new CommandError('failed', `${sec.name}’s cut does not say which side the material is on — it was taken before cuts did. Move the section a hair and ask again.`)
      const sided = sidedChains(flat, normals)
      const mask = sideMask(sided.chains, sided.normals, { ...(skin ? { skin } : {}), ...(facing ? { facing: { dir: facing.dir, withinDeg: facing.withinDeg ?? FACING_DEG } } : {}) })
      parts = picked.flatMap((c) => {
        const from = cut.offsets[c]
        const to = cut.offsets[c + 1]
        return runIndices(to - from, loopsAt(from, to - 1), (i) => mask[c][i]).map((run, k) => ({ index: c, run: k, at: run.map((i) => from + i) }))
      })
    } else parts = picked.map((c) => ({ index: c, at: Array.from({ length: cut.offsets[c + 1] - cut.offsets[c] }, (_, i) => cut.offsets[c] + i) }))
    const total = parts.reduce((n, p) => n + p.at.length, 0)
    const step = total > limit ? Math.ceil(total / limit) : 1
    const chains = parts.map(({ index, run, at }) => {
      const n = at.length
      let length = 0
      let lo: [number, number] = [Infinity, Infinity]
      let hi: [number, number] = [-Infinity, -Infinity]
      at.forEach((i, k) => {
        const u = flat.points[i * 2]
        const v = flat.points[i * 2 + 1]
        lo = [Math.min(lo[0], u), Math.min(lo[1], v)]
        hi = [Math.max(hi[0], u), Math.max(hi[1], v)]
        const j = at[k - 1]
        if (k > 0) length += Math.hypot(cut.points[i * 3] - cut.points[j * 3], cut.points[i * 3 + 1] - cut.points[j * 3 + 1], cut.points[i * 3 + 2] - cut.points[j * 3 + 2])
      })
      // A run is closed only where it is the whole loop.
      const closed = n > 2 && at[n - 1] - at[0] === n - 1 && loopsAt(at[0], at[n - 1])
      const kept: number[] = []
      for (let k = 0; k < n; k += step) kept.push(at[k])
      if (kept[kept.length - 1] !== at[n - 1]) kept.push(at[n - 1])
      return {
        index,
        ...(run !== undefined ? { run } : {}),
        closed,
        points: n,
        kept: kept.length,
        length: round4(length),
        bounds: { min: [round4(lo[0]), round4(lo[1])], max: [round4(hi[0]), round4(hi[1])] },
        ...(space !== 'world' ? { sheet: kept.map((i) => [round4(flat.points[i * 2]), round4(flat.points[i * 2 + 1])]) } : {}),
        ...(space !== 'sheet' ? { world: kept.map((i) => [round4(cut.points[i * 3]), round4(cut.points[i * 3 + 1]), round4(cut.points[i * 3 + 2])]) } : {}),
      }
    })
    return {
      section: describeSection(sec),
      plane: { origin: sec.frame.origin, normal: sec.frame.normal, basisU: sec.frame.basisU, basisV: sec.frame.basisV },
      step,
      chains,
    }
  },
}

/** The picture's side when neither width nor height is given, as the
 *  other pictures. */
const RENDER_SIDE = 800

/** A picture of a sheet of the scan: the layers drawn on it, the scan's
 *  cut read against their outlines — section.render's, and a workspace's
 *  own picture of a plane it chooses, such as one across a feature.
 *  `flat` is the scan's cut as [u, v] pairs on the sheet. */
export async function pictureOfSheet(
  sheet: SectionSheet,
  flat: Float32Array,
  options: { frame?: { at: [number, number]; size: number }; tolerance?: number; layers?: string[]; width?: number; height?: number; name?: string },
) {
  if (typeof OffscreenCanvas === 'undefined') throw new CommandError('unavailable', 'A picture of a section needs the browser.')
  const { input, counted, tol, axes } = await sheetDrawing(sheet, flat, options)
  const { sectionPicturePng } = await import('../../app/sectionPicture')
  const { bytes, model } = await sectionPicturePng(
    { ...input, width: options.width ?? (options.height ? undefined : RENDER_SIDE), height: options.height },
    options.name ?? sheet.name,
  )
  return {
    file: { name: `${(options.name ?? sheet.name).replace(/[^\w.-]+/g, '-')}.png`, mimeType: 'image/png', bytes },
    width: model.frame.width,
    height: model.frame.height,
    map: { left: model.frame.left, top: model.frame.top, unitsPerPx: model.frame.unitsPerPx },
    tolerance: tol,
    axes,
    gap: gapJson(model.gap),
    layers: counted,
  }
}

/** A picture's gap reading, rounded for the answer. */
const gapJson = (g: SectionPictureModel['gap']) => ({ points: g.points, read: g.read, over: g.over, outside: g.outside, inside: g.inside, max: round4(g.max), rms: round4(g.rms), overBox: g.overBox ? { min: g.overBox.min.map(round4), max: g.overBox.max.map(round4) } : null })

/** What a sheet's picture is drawn from: the scan's cut, what the chosen
 *  layers draw on the sheet, the tolerance and the sheet's world axes. */
async function sheetDrawing(
  sheet: SectionSheet,
  flat: Float32Array,
  options: { frame?: { at: [number, number]; size: number }; tolerance?: number; layers?: string[] },
): Promise<{ input: SectionPictureInput; counted: { key: string; outlines: number; pieces: number }[]; tol: number; axes: { u: SheetAxis; v: SheetAxis } }> {
  const all = sectionLayers()
  const keys = options.layers
  for (const k of keys ?? []) if (!all.some((l) => l.key === k)) throw new CommandError('not_found', `There is no layer "${k}" — ${all.length > 0 ? `there are ${all.map((l) => `"${l.key}"`).join(', ')}` : 'this build has none'}.`)
  const chosen = keys ? all.filter((l) => keys.includes(l.key)) : all
  const outlines: SectionOutline[] = []
  const pieces: SectionPiece[] = []
  const counted: { key: string; outlines: number; pieces: number }[] = []
  for (const layer of chosen) {
    const drawn = await layer.draw(sheet)
    outlines.push(...(drawn?.outlines ?? []))
    pieces.push(...(drawn?.pieces ?? []))
    counted.push({ key: layer.key, outlines: drawn?.outlines?.length ?? 0, pieces: drawn?.pieces?.length ?? 0 })
  }
  const tol = options.tolerance ?? useDeviation.getState().tolerance
  const { sheetAxes } = await import('../../app/sectionPicture')
  const axes = sheetAxes(sheet.origin, sheet.basisU, sheet.basisV)
  return { input: { scan: flat, outlines, pieces, tolerance: tol, axes, ...(options.frame ? { frame: options.frame } : {}) }, counted, tol, axes }
}

/** The most cuts one picture of parallel sections holds, and its width
 *  unless told. */
const OFFSETS_MAX = 9
const SHEET_WIDTH = 1200
const SHEET_MAX = 2048

/** Parallel cuts as one picture: each sheet the base one slid along its
 *  normal by an offset — or along `along`, the plane's own normal, for a
 *  sheet turned to face the other way — every tile framed on the same
 *  square of the sheet (the box round all the cuts, or the frame asked
 *  for) at the same scale, so a step from one to the next reads off the
 *  grid. Layers draw on each sheet. */
async function pictureOfOffsets(
  base: SectionSheet,
  offsets: number[],
  options: { frame?: { at: [number, number]; size: number }; tolerance?: number; layers?: string[]; width?: number; height?: number; along?: Vec3 },
) {
  const worker = commandHost().session.clientRef.current
  if (!worker) throw new CommandError('unavailable', 'The mesh worker is not running.')
  const n = options.along ?? base.normal
  const nl = Math.hypot(n[0], n[1], n[2])
  const drawn: { offset: number; sheet: SectionSheet; drawing: Awaited<ReturnType<typeof sheetDrawing>> }[] = []
  for (const offset of offsets) {
    const origin: Vec3 = [base.origin[0] + (n[0] / nl) * offset, base.origin[1] + (n[1] / nl) * offset, base.origin[2] + (n[2] / nl) * offset]
    const sheet: SectionSheet = { ...base, origin }
    const cut = await worker.section(origin, base.normal, EDGE_MIN_FEATURE_MM)
    drawn.push({ offset, sheet, drawing: await sheetDrawing(sheet, projectCut(cut, sheet).points, options) })
  }
  // One frame for all: the square round every cut and outline.
  let frame = options.frame
  if (!frame) {
    let lo = [Infinity, Infinity]
    let hi = [-Infinity, -Infinity]
    const take = (u: number, v: number) => {
      lo = [Math.min(lo[0], u), Math.min(lo[1], v)]
      hi = [Math.max(hi[0], u), Math.max(hi[1], v)]
    }
    for (const d of drawn) {
      const s = d.drawing.input.scan
      for (let i = 0; i + 1 < s.length; i += 2) take(s[i], s[i + 1])
      for (const o of d.drawing.input.outlines) for (const q of o.points) take(q[0], q[1])
    }
    if (!Number.isFinite(lo[0])) throw new CommandError('failed', 'None of the planes cuts the scan.')
    const size = 1.12 * Math.max(hi[0] - lo[0], hi[1] - lo[1], 1e-3)
    frame = { at: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2], size }
  }
  const cols = [0, 1, 2, 3, 2, 3, 3, 4, 4, 3][offsets.length]
  const rows = Math.ceil(offsets.length / cols)
  const W = Math.min(SHEET_MAX, options.width ?? (options.height ? Math.round((options.height / rows) * cols) : SHEET_WIDTH))
  const H = Math.min(SHEET_MAX, options.height ?? Math.round((W / cols) * rows))
  const side = Math.max(64, Math.min(Math.floor(W / cols), Math.floor(H / rows)))
  const { sectionSheetsPng } = await import('../../app/sectionPicture')
  const { bytes, models, width, height } = await sectionSheetsPng(
    drawn.map((d) => {
      // On a coordinate plane the tile says where it lies in the world too.
      const k = [0, 1, 2].find((i) => Math.abs(n[i] / nl) > 1 - 1e-9)
      const world = k === undefined ? '' : ` (${'XYZ'[k]} ${round4(d.sheet.origin[k])})`
      return { input: { ...d.drawing.input, frame: frame!, width: side, height: side }, title: `offset ${d.offset} mm${world}` }
    }),
    cols,
  )
  const m = models[0].frame
  return {
    file: { name: `${base.name.replace(/[^\w.-]+/g, '-')}-offsets.png`, mimeType: 'image/png', bytes },
    width,
    height,
    map: { left: m.left, top: m.top, unitsPerPx: m.unitsPerPx, tile: [m.width, m.height], cols },
    tolerance: drawn[0].drawing.tol,
    axes: drawn[0].drawing.axes,
    tiles: drawn.map((d, i) => ({
      offset: d.offset,
      origin: d.sheet.origin.map(round4),
      gap: gapJson(models[i].gap),
      ...(d.drawing.counted.some((c) => c.outlines || c.pieces) ? { layers: d.drawing.counted } : {}),
    })),
  }
}

/** A sheet turned in its plane so that `up` runs up its picture
 *  (frameTurnedUp), or the sheet as it is with no `up`. */
function turnedUp<T extends SectionFrame>(sheet: T, up: WorldAxis | undefined): T {
  if (!up) return sheet
  const f = frameTurnedUp(sheet, up)
  if (!f) throw new CommandError('invalid_input', `up: ${up.toUpperCase()} runs along the plane’s normal and has no way up the sheet — give one of the other two.`)
  return { ...sheet, ...f }
}

/** The scan cut by a plane through `origin` square to `normal`, laid on a
 *  sheet as a sketch on that plane has it (sketchFrameOn): its zero the
 *  world origin's foot, +u the coordinate axis next round from the normal
 *  — so on a coordinate plane [u, v] are world coordinates — for a picture
 *  of a plane no section stands on. With `up`, the sheet is turned so that
 *  axis runs up it (frameTurnedUp), its zero where it was. */
export async function sheetThrough(origin: Vec3, normal: Vec3, name: string, up?: WorldAxis): Promise<{ sheet: SectionSheet; flat: Float32Array }> {
  const on = sketchFrameOn({ origin, normal })
  if (!on) throw new CommandError('invalid_input', 'plane.normal: give a direction, not a zero vector.')
  return sheetOn(on, name, up)
}

/** The scan cut on a frame already in hand — a sketch's own — laid on it
 *  as sheetThrough lays it. */
async function sheetOn(on: SectionFrame, name: string, up?: WorldAxis): Promise<{ sheet: SectionSheet; flat: Float32Array }> {
  requireScan()
  const frame = turnedUp(on, up)
  const worker = commandHost().session.clientRef.current
  if (!worker) throw new CommandError('unavailable', 'The mesh worker is not running.')
  const cut = await worker.section(frame.origin, frame.normal, EDGE_MIN_FEATURE_MM)
  return { sheet: { id: 0, name, ...frame }, flat: projectCut(cut, frame).points }
}

/** What section.render's plane is given as: a plane by a point and its
 *  normal, an element by id or name, a coordinate plane by name, or a plane
 *  a workspace keeps — a sketch's. */
type PlaneIn = { origin: Vec3; normal: Vec3 } | number | string | { sketch: number | string }

/** What section.render's frame is given as: a square of the sheet by its
 *  middle — [u, v] on the sheet, or [x, y, z] in the world — and its side,
 *  or a box of the world. */
type FrameIn = { at?: number[]; size?: number; world?: { min: Vec3; max: Vec3 }; min?: Vec3; max?: Vec3 }

/** How much wider than a world box laid on a sheet the square framed
 *  round it is. */
const BOX_ROOM = 1.1

/**
 * A picture's frame on its sheet, as the picture takes it: a square by its
 * middle and side, the middle given on the sheet or in the world — laid
 * square onto the sheet, so a place on the part needs no working out of
 * where the sheet counts from — or the square round a box of the world
 * laid onto the sheet, a tenth wider. `framed` says, for a frame given in
 * the world, where it came out on the sheet, and how far off the plane a
 * point lay.
 */
export function frameOnSheet(asked: FrameIn, sheet: SectionFrame): { frame: { at: [number, number]; size: number }; framed?: Record<string, unknown> } {
  // { min, max } as view.render's frame takes a box: the world's.
  const bare = asked.min !== undefined || asked.max !== undefined
  if (bare && (asked.world || !asked.min || !asked.max)) throw new CommandError('invalid_input', 'frame: give min and max both, or world: { min, max } — not both.')
  const given: FrameIn = bare ? { at: asked.at, size: asked.size, world: { min: asked.min!, max: asked.max! } } : asked
  if (given.world) {
    if (given.at !== undefined || given.size !== undefined) throw new CommandError('invalid_input', 'frame: give at and size, or world: { min, max } — not both.')
    const { min, max } = given.world
    for (let k = 0; k < 3; k++) if (!(min[k] <= max[k])) throw new CommandError('invalid_input', 'frame.world: min lies past max.')
    const b = boxOnSheet(sheet, given.world)
    const at: [number, number] = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2]
    const size = Math.max(BOX_ROOM * Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]), 1e-3)
    return { frame: { at, size }, framed: { at: at.map(round4), size: round4(size) } }
  }
  const at = given.at
  if (!at || (at.length !== 2 && at.length !== 3) || given.size === undefined) {
    throw new CommandError('invalid_input', 'frame: give at — [u, v] on the sheet, or [x, y, z] in the world — and size, or world: { min, max }.')
  }
  if (at.length === 2) return { frame: { at: [at[0], at[1]], size: given.size } }
  const p = pointOnSheet(sheet, at as Vec3)
  return { frame: { at: p.at, size: given.size }, framed: { at: p.at.map(round4), size: given.size, offPlane: round4(p.off) } }
}

/** A sheet in the world, as an answer gives it: a sheet point [u, v] is
 *  origin + u·basisU + v·basisV. */
const sheetOut = (s: SectionFrame) => ({ origin: s.origin.map(round4), normal: s.normal.map(round4), basisU: s.basisU.map(round4), basisV: s.basisV.map(round4) })

/** The frame a picture's plane lies on, and its name: a sketch's on that
 *  plane (sketchFrameOn) — for an element, the plane through its centre
 *  square to its direction, as a sketch on a plane element takes it, not
 *  the fitter's own axes; for a coordinate plane, the one through the
 *  part's centre, as section.cut lays it — or the sketch's own frame. */
export function sheetPlaneOf(plane: PlaneIn, fromZero = false): { name: string; frame: SectionFrame } {
  const frameOn = (origin: Vec3, normal: Vec3, name: string) => {
    const frame = sketchFrameOn({ origin, normal })
    if (!frame) throw new CommandError('invalid_input', 'plane.normal: give a direction, not a zero vector.')
    return { name, frame }
  }
  if (typeof plane === 'object' && 'sketch' in plane) {
    const { plane: found, kinds } = findSheetPlane(plane.sketch)
    if (!found) throw new CommandError('not_found', kinds.length > 0 ? `There is no sketch ${typeof plane.sketch === 'number' ? plane.sketch : `named "${plane.sketch}"`} among ${kinds.join(', ')}.` : 'No workspace here keeps sketches — give an element, a coordinate plane or { origin, normal }.')
    const { name, ...frame } = found
    return { name, frame }
  }
  if (typeof plane === 'object') return frameOn(plane.origin, plane.normal, 'Cut')
  const world = typeof plane === 'string' ? parsePlaneName(plane) : null
  if (world) {
    const c = useStore.getState().modelCenter
    const n = worldAxisDir(world)
    const k = 'xyz'.indexOf(world)
    // Through the part's middle for a picture; from the world's zero for
    // offsets, so that they read as a sketch's plane offset and a stack's do.
    const along = fromZero ? 0 : c[k]
    const origin: Vec3 = [k === 0 ? along : 0, k === 1 ? along : 0, k === 2 ? along : 0]
    return frameOn(origin, n, worldPlaneName(world))
  }
  const el = findElement(plane)
  const axis = el.fit && canCutAlong(el.kind) ? cutAxisOf(el.fit) : null
  if (!axis) throw new CommandError('invalid_input', `${el.name} has no direction to lay a plane square to — choose a plane, cylinder, cone, line or circle.`)
  return frameOn(axis.origin, axis.dir, el.name)
}

const render: Command<{ section?: number | string; plane?: PlaneIn; offsets?: number[]; up?: WorldAxis; frame?: FrameIn; tolerance?: number; layers?: string[]; width?: number; height?: number }> = {
  name: 'render',
  title: 'Picture a section',
  description:
    'A picture of a section as a PNG, for checking a slice against what was built on it: the scan’s cut as points on the sheet ([u, v] mm, +u right, +v up), a mm grid with values in the margins, a scale bar, and the workspaces’ layers over it (a model’s cut as outlines, a sketch’s pieces). Scan points within ten tolerances of an outline are read against it: on it (grey) or off it (red). Needs section, or plane to cut the scan for the picture alone ({ origin, normal }, "XY"/"YZ"/"XZ", an element, or { sketch }). Returns gap { points, read, over, outside, inside, max, rms, overBox }, layers, axes, sheet (origin, normal, basisU, basisV) and map (pixel (c, r) is [left + c·unitsPerPx, top − r·unitsPerPx]). Trap: a plane’s sheet has its zero at the world origin’s foot, a section’s at the part’s centre — read sheet. 800 px by default, up to 2048. Needs the browser. Changes nothing.',
  input: obj({
    section: oneOf([int('The section’s id.', { minimum: 1 }), str('Its name — "Section 1".', { minLength: 1 })], 'The section, by id or name.'),
    plane: oneOf(
      [
        obj({ origin: vec3('A point on the plane, mm.'), normal: vec3('Its normal.') }, ['origin', 'normal']),
        int('An element’s id.', { minimum: 1 }),
        str('"XY", "YZ", "XZ", or an element’s name.', { minLength: 1 }),
        obj({ sketch: oneOf([int(undefined, { minimum: 1 }), str(undefined, { minLength: 1 })], 'A sketch’s id or name.') }, ['sketch']),
      ],
      'A plane to cut the scan by for the picture alone, in place of a section.',
    ),
    offsets: arr(num(), 'Several parallel cuts in one picture: mm along the normal — on a coordinate plane by name, from the world’s zero, so "XY" with [0, 5] cuts at Z 0 and Z 5.', { minItems: 2, maxItems: OFFSETS_MAX }),
    up: enumOf(['x', 'y', 'z'], 'The world axis that runs up the picture; the sheet as it lies by default.'),
    frame: obj(
      {
        at: arr(num(), 'The middle: [u, v] mm on the sheet, or [x, y, z] mm in the world.', { minItems: 2, maxItems: 3 }),
        size: num('The side of the square looked at, mm.', { exclusiveMinimum: 0 }),
        world: obj({ min: vec3('Lowest corner, [x, y, z] mm.'), max: vec3('Highest corner, [x, y, z] mm.') }, ['min', 'max'], 'A world box, in place of at and size.'),
        min: vec3('With max: the world box written as view.render’s frame takes one — the same as world: { min, max }.'),
        max: vec3('With min.'),
      },
      [],
      'Look at a square of the sheet: { at, size }, or { world: { min, max } } (or { min, max }).',
    ),
    tolerance: num('± mm a scan point may lie off an outline and still be on it; the Deviation workspace’s by default.', { exclusiveMinimum: 0 }),
    layers: arr(str(undefined, { minLength: 1 }), 'The layers to draw, by key; every one by default, [] for the scan alone.'),
    width: int('Pixels across, 64 to 2048.', { minimum: 64, maximum: 2048 }),
    height: int('Pixels down, 64 to 2048.', { minimum: 64, maximum: 2048 }),
  }),
  readOnly: true,
  returnsFile: true,
  returnsImage: true,
  scene: true,
  run: async ({ section, plane, offsets, up, frame, tolerance, layers, width, height }) => {
    if (typeof OffscreenCanvas === 'undefined') throw new CommandError('unavailable', 'A picture of a section needs the browser.')
    if ((section === undefined) === (plane === undefined)) throw new CommandError('invalid_input', 'Give section, or plane — one of them.')
    requireScan()
    if (offsets) {
      let base: SectionSheet
      if (plane !== undefined) {
        const { name, frame: f } = sheetPlaneOf(plane, true)
        base = { id: 0, name, ...f }
      } else {
        const sec = findSection(section!)
        base = { id: sec.id, name: sec.name, origin: sec.frame.origin, normal: sec.frame.normal, basisU: sec.frame.basisU, basisV: sec.frame.basisV }
      }
      const along = base.normal
      base = turnedUp(base, up)
      const onSheet = frame ? frameOnSheet(frame, base) : undefined
      const picture = await pictureOfOffsets(base, offsets, { ...(onSheet ? { frame: onSheet.frame } : {}), ...(tolerance !== undefined ? { tolerance } : {}), ...(layers ? { layers } : {}), width, height, along })
      return {
        ...picture,
        sheet: sheetOut(base),
        ...(onSheet?.framed ? { framed: onSheet.framed } : {}),
        ...(plane !== undefined ? {} : { section: { id: base.id, name: base.name } }),
      }
    }
    let sheet: SectionSheet
    let flat: Float32Array
    if (plane !== undefined) {
      const { name, frame: f } = sheetPlaneOf(plane)
      ;({ sheet, flat } = await sheetOn(f, name, up))
    } else {
      const id = findSection(section!).id
      const sec = await waitFor(() => {
        const s = useStore.getState().sections.find((x) => x.id === id)
        return s?.cut || s?.message ? s : null
      }, 'the section to be cut', 60_000)
      if (!sec.cut) throw new CommandError('failed', sec.message ?? 'The section has no cut.')
      sheet = turnedUp({ id: sec.id, name: sec.name, origin: sec.frame.origin, normal: sec.frame.normal, basisU: sec.frame.basisU, basisV: sec.frame.basisV }, up)
      flat = projectCut(sec.cut, sheet).points
    }
    const onSheet = frame ? frameOnSheet(frame, sheet) : undefined
    const picture = await pictureOfSheet(sheet, flat, { ...(onSheet ? { frame: onSheet.frame } : {}), ...(tolerance !== undefined ? { tolerance } : {}), ...(layers ? { layers } : {}), width, height })
    return {
      ...picture,
      sheet: sheetOut(sheet),
      ...(onSheet?.framed ? { framed: onSheet.framed } : {}),
      ...(plane !== undefined ? {} : { section: { id: sheet.id, name: sheet.name } }),
    }
  },
}

export const sectionCommands = [cut, get, render]

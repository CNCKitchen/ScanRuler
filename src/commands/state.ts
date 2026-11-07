// SPDX-License-Identifier: AGPL-3.0-only
// The session read out as one JSON object — what an agent reads instead of
// the screen. Built from the same stores the panels draw from, at full
// precision, in millimetres and degrees. Nothing per vertex goes in it: a
// marked surface is a count, a map is its statistics.
//
// A plugin adds its part under its id with registerStateSection
// (stateSections.ts).

import { evaluateDimensions, dimensionTypeInfo, type EvaluatedDimension } from '../core/dimensions'
import { deviationStats, type DeviationStats } from '../core/deviation/deviation'
import { MAX_SAMPLE_SPACING, MAX_SAMPLE_TRIANGLES, MIN_SAMPLE_SPACING, referenceCoverage } from '../core/deviation/onReference'
import { thicknessStats, type ThicknessStats } from '../core/thickness/thickness'
import { describeRigid } from '../core/alignment'
import type { Rigid } from '../core/deviation/rigid'
import { noTrueSize, noTrueSizeText } from '../core/scanScale'
import { roundTo } from '../core/round'
import type { Vec3 } from '../core/types'
import { isWorldAxis, worldPlaneName } from '../core/section/frame'
import { cutoffLabel } from '../core/summary'
import { useDeviation } from '../state/deviationStore'
import { usePrefs } from '../state/prefsStore'
import { colormapById, rampColor, UNMEASURED_RGB } from '../core/field/colormap'
import { useFlat } from '../state/flatStore'
import { evaluateFlatDimensions } from '../core/flat/dimensions'
import { sheetFrame, sheetScale } from '../app/flatSheet'
import { useHistory, historyBlocked } from '../state/historyStore'
import { useShell, type Workspace } from '../state/shellStore'
import { draftHolds, useStore, type Element, type Section } from '../state/store'
import { dimensionRefsOf, shadowParams } from '../state/sectionModel'
import { useThickness } from '../state/thicknessStore'
import { plugins } from '../plugins/registry'
import { surfaceSource } from '../app/surfaces'
import { projectUnsaved, sessionHolds } from '../app/project'
import { hintNow } from '../app/useHints'
import { APP_VERSION } from '../version'
import { commandHost, sessionBusy, type FlatSheetView } from './host'
import { useCommandActivity } from './activity'
import { readStateBriefs, readStateSections } from './stateSections'
import { guideRead, listGuides } from './guides'
import { describeView } from './core/view'
import { serverTooOld } from './agentLink'
import { pageStale, STALE_PAGE } from './stalePage'

// ---- Workspaces -------------------------------------------------------------

/** The workspaces by the names a caller uses: the app's 3D Measure is
 *  `measure` (it is `elements` inside the app), the others as they are, and
 *  a plugin's by its id. */
/** How the scan got its true size, or that it looks like it has none yet. */
function scanSizeOut(s: ReturnType<typeof useStore.getState>): Record<string, unknown> {
  if (s.scanScale) {
    return {
      scaled: {
        factor: roundTo(s.scanScale.factor, 6),
        references: s.scanScale.references.map((r) => ({ label: r.label, measured: roundTo(r.measured, 4), true: roundTo(r.true, 4) })),
      },
    }
  }
  const diagonal = 2 * s.modelSize
  const none = noTrueSize(s.fileName, diagonal, false)
  return none ? { noTrueSize: noTrueSizeText(none, diagonal) } : {}
}

export const publicWorkspace = (w: Workspace): string => (w === 'elements' ? 'measure' : w)
export const internalWorkspace = (name: string): Workspace => (name === 'measure' ? 'elements' : name)

/** Every workspace on offer, by its public name. */
export const workspaceNames = (): string[] => [
  'measure',
  'deviation',
  'thickness',
  'flat',
  ...plugins().flatMap((p) => (p.workspace ? [p.workspace.id] : [])),
]

// ---- Pieces ---------------------------------------------------------------------

/** A rigid motion as JSON: the rotation matrix row by row, the translation
 *  in millimetres, and how far each goes. */
export const rigidJson = (m: Rigid | null) => {
  if (!m) return null
  const { rotationDeg, translation } = describeRigid(m)
  return { rotation: [...m.r], translation: [...m.t], rotationDeg, distanceMm: translation }
}

/** An element as the list shows it, with everything it was built from. */
export function describeElement(el: Element) {
  const src = el.source
  return {
    id: el.id,
    name: el.name,
    kind: el.kind,
    status: el.status === 'fitting' ? 'fitting' : el.fit ? 'done' : 'failed',
    visible: el.visible,
    fit: el.fit ?? null,
    ...(el.measured ? { measured: el.measured } : {}),
    source:
      src.type === 'fitted'
        ? {
            type: 'fitted' as const,
            method: src.settings.method,
            sigmaCutoff: src.settings.sigma,
            cutoff: cutoffLabel(src.settings.sigma),
            ...(src.settings.knownDiameter !== undefined ? { knownDiameter: src.settings.knownDiameter } : {}),
            ...(src.selection ? { markedPoints: src.selection.length } : { seeds: [...src.seeds] }),
          }
        : src.type === 'picked'
          ? { type: 'picked' as const }
          : {
              type: 'constructed' as const,
              method: src.method,
              refs: [...src.refs],
              params: [...src.params],
              ...(src.selection ? { markedPoints: src.selection.length } : {}),
            },
    ...(el.assumed !== undefined ? { assumed: el.assumed } : {}),
    ...(el.orient ? { orient: el.orient } : {}),
    ...(el.extend ? { extend: el.extend } : {}),
    ...(el.message ? { message: el.message } : {}),
  }
}

/** A dimension with its value, as the row and the report read it. */
export function describeDimension({ dim, title, value, verdict }: EvaluatedDimension) {
  const info = dimensionTypeInfo(dim.type)
  return {
    id: dim.id,
    name: dim.name,
    type: dim.type,
    family: info.family,
    title,
    refs: [...dim.refs],
    label: value.label,
    value: value.invalid ? null : (value.raw ?? null),
    unit: info.unit,
    display: value.value ?? null,
    visible: dim.visible !== false,
    ...(dim.anchor && dim.anchor !== 'center' ? { anchor: dim.anchor } : {}),
    ...(dim.limit ? { limit: dim.limit } : {}),
    ...(dim.basic !== undefined ? { basic: dim.basic } : {}),
    ...(verdict
      ? {
          verdict: {
            pass: verdict.pass,
            deviation: verdict.deviation,
            over: verdict.over,
            allowance: verdict.allowance,
            ...(verdict.alarm ? { alarm: verdict.alarm } : {}),
          },
        }
      : {}),
    ...(value.range ? { range: value.range } : {}),
    ...(value.detail ? { detail: value.detail } : {}),
    ...(value.warning ? { warning: value.warning } : {}),
    ...(value.invalid ? { invalid: value.invalid } : {}),
  }
}

/** Every dimension of the session, evaluated as the panel evaluates them. */
export const evaluatedDimensions = () => {
  const s = useStore.getState()
  return evaluateDimensions(s.dimensions, dimensionRefsOf(s.elements, s.sections), surfaceSource)
}

export function describeSection(sec: Section) {
  return {
    id: sec.id,
    name: sec.name,
    visible: sec.visible,
    // A coordinate plane by the name section.cut takes back ("XZ plane");
    // an element by its id; through an axis as { axis, angleDeg }.
    across: isWorldAxis(sec.ref) ? worldPlaneName(sec.ref) : sec.ref,
    offset: sec.offset,
    // The sheet in the world, as section.get and section.render lay it: a
    // sheet point [u, v] is origin + u·basisU + v·basisV.
    plane: { origin: sec.frame.origin, normal: sec.frame.normal, basisU: sec.frame.basisU, basisV: sec.frame.basisV },
    chains: sec.cut ? sec.cut.offsets.length - 1 : null,
    ...(sec.kind === 'shadow' ? { kind: 'shadow', ...shadowFigures(sec) } : {}),
    ...(sec.message ? { message: sec.message } : {}),
  }
}

/** A shadow's settings and, once taken, its loops, area (mm², holes taken
 *  off) and the band its outline lies in outside the part (mm). */
function shadowFigures(sec: Section) {
  const { play, tolerance, smoothDeg, extrude } = shadowParams(sec)
  const sh = sec.cut?.shadow
  const r3 = (v: number) => Math.round(v * 1000) / 1000
  return {
    play,
    tolerance,
    smoothDeg,
    extrude,
    ...(sh
      ? {
          loops: sh.loops.map((l) => ({ hole: l.hole, pieces: l.pieces.length })),
          areaMm2: Math.round(sh.area * 100) / 100,
          outside: { min: r3(sh.margin.min), max: r3(sh.margin.max) },
          extent: { min: r3(sh.extent.min), max: r3(sh.extent.max) },
          ...(sh.widened ? { cell: r3(sh.cell) } : {}),
        }
      : {}),
  }
}

/** The figures under the deviation legend: the store's while the workspace
 *  shows them, worked out the same way from the map otherwise. */
export function deviationFigures(): DeviationStats | null {
  const d = useDeviation.getState()
  const maps = commandHost().session.maps
  const values = d.source === 'element' ? maps.elementField.current : maps.deviation.current
  const ready = d.source === 'element' ? d.elementStatus === 'ready' : d.mapStatus === 'ready'
  if (!ready || !values) return null
  return deviationStats(values, d.maxDistance, d.tolerance)
}

/** The map on the reference, in figures: how far apart its readings lie;
 *  the share of the reference's area the scan stands behind within the
 *  search distance, of it within ±tolerance, past the search distance, and
 *  with no scan behind it; and the readings' statistics within the search
 *  distance — positive where the reference stands outside the scan. */
export function referenceFigures() {
  const d = useDeviation.getState()
  const map = commandHost().session.maps.referenceMap.current
  if (d.referenceStatus !== 'ready' || !map) return null
  const c = referenceCoverage(map, map.values, d.tolerance, d.maxDistance)
  const share = (a: number) => (c.area > 0 ? Math.round((a / c.area) * 1000) / 10 : 0)
  const stats = deviationStats(map.values, d.maxDistance, d.tolerance)
  const spacing = referenceSpacing()
  return {
    spacing: map.spacing,
    ...(spacing?.opened ? { spacingOpened: spacing.opened } : {}),
    readings: map.values.length,
    areaMm2: Math.round(c.area),
    backedPct: share(c.backed),
    withinTolerancePct: share(c.withinTolerance),
    farPct: share(c.far),
    noScanPct: share(c.noScan),
    stats,
  }
}

/** How far apart the readings of the map on the reference lie, mm, and by
 *  what rule: twice the tolerance it was measured under, within a quarter
 *  and two millimetres — opened past that on a reference too large to cut
 *  so fine, which `opened` says. Two maps read at one spacing are read
 *  alike. Null with no map on the reference. */
export function referenceSpacing(): { mm: number; wanted: number; rule: string; opened?: string } | null {
  const d = useDeviation.getState()
  const map = commandHost().session.maps.referenceMap.current
  if (d.referenceStatus !== 'ready' || !map) return null
  const wanted = map.wanted ?? map.spacing
  const rule = `twice the tolerance, within ${MIN_SAMPLE_SPACING}–${MAX_SAMPLE_SPACING} mm`
  if (map.spacing <= wanted) return { mm: map.spacing, wanted, rule }
  const area = Math.round(referenceCoverage(map, map.values, d.tolerance, d.maxDistance).area)
  return {
    mm: map.spacing,
    wanted,
    rule,
    opened: `from ${wanted} mm: the reference’s ${area.toLocaleString('en-US')} mm² cut ${wanted} mm apart would be more than ${MAX_SAMPLE_TRIANGLES.toLocaleString('en-US')} triangles`,
  }
}

/** The figures under the thickness legend, the same way. */
export function thicknessFigures(): ThicknessStats | null {
  const t = useThickness.getState()
  const values = commandHost().session.maps.thickness.current
  if (t.status !== 'ready' || !values) return null
  return thicknessStats(values, t.limit)
}

export function describeDeviation() {
  const d = useDeviation.getState()
  return {
    source: d.source,
    reference: d.nominalName
      ? {
          fileName: d.nominalName,
          triangles: d.nominalTriangles,
          ...(d.nominalStep ? { step: d.nominalStep } : {}),
        }
      : null,
    align: d.align
      ? {
          source: d.align.source,
          rms: d.align.rms,
          matched: d.align.matched,
          sampled: d.align.sampled,
          iterations: d.align.iterations,
          ...(d.align.ambiguous ? { ambiguous: true } : {}),
          transform: rigidJson(d.align.transform),
        }
      : null,
    alignStatus: d.alignStatus,
    ...(d.alignMessage ? { alignMessage: d.alignMessage } : {}),
    map: d.source === 'element' ? d.elementStatus : d.mapStatus,
    stats: deviationFigures(),
    ...(d.source === 'reference'
      ? { on: d.mapOn, onReference: d.referenceStatus === 'ready' ? referenceFigures() : { map: d.referenceStatus } }
      : {}),
    target:
      d.targetId !== null
        ? {
            element: d.targetId,
            side: d.targetSide === 1 ? 'outward' : 'inward',
            facingDeg: d.targetFacingDeg,
            scope: d.targetScope,
            ...(d.targetScope === 'marked' ? { markedPoints: d.scopeCount } : {}),
          }
        : null,
    settings: {
      range: d.range,
      maxDistance: d.maxDistance,
      bands: d.bands,
      tolerance: d.tolerance,
      facingDeg: d.mapFacingDeg,
      colormap: describeColormap(usePrefs.getState().colormap, d.range),
      // The map switch: off, nothing is painted, whatever is measured.
      show: d.showMap,
    },
  }
}

/** The colour map the deviation is drawn in — a browser preference, so an
 *  agent reading a render cannot assume jet's green, red and blue: the map's
 *  name and what its ramp shows at −range, 0 and +range, and the caps past
 *  either end. */
export function describeColormap(id: string, range: number) {
  const map = colormapById(id)
  const at = (t: number): [number, number, number] => {
    const out: [number, number, number] = [0, 0, 0]
    rampColor(map, t, out)
    return out
  }
  return {
    id: map.id,
    low: { mm: -range, rgb: at(0) },
    zero: { mm: 0, rgb: at(0.5) },
    high: { mm: range, rgb: at(1) },
    under: { mm: `< ${-range}`, rgb: [...map.under] as [number, number, number] },
    over: { mm: `> ${range}`, rgb: [...map.over] as [number, number, number] },
    unmeasured: { rgb: [...UNMEASURED_RGB] as [number, number, number] },
  }
}

export function describeThickness() {
  const t = useThickness.getState()
  return {
    status: t.status,
    stats: thicknessFigures(),
    settings: {
      method: t.method,
      maxThickness: t.maxThickness,
      coneRays: t.coneRays,
      coneAngleDeg: t.coneAngleDeg,
      normalDeviationDeg: t.normalDeviationDeg,
      low: t.low,
      high: t.high,
      bands: t.bands,
      limit: t.limit,
    },
    ...(t.message ? { message: t.message } : {}),
  }
}

/** The 2D sheet as the commands read and write it: every place in the
 *  sheet's own units and frame — the alignment is how the panel and the
 *  report read them, and the turns how the stage shows them; neither moves
 *  a place given to a command. */
export function describeFlat() {
  const f = useFlat.getState()
  const unit = sheetScale(f)
  const frame = sheetFrame(f)
  let view: FlatSheetView | null = null
  try {
    view = commandHost().flat?.sheet() ?? null
  } catch {
    // No session to ask: the sheet's extent goes unsaid.
  }
  const values = new Map(evaluateFlatDimensions(f.dimensions, f.elements).map((d) => [d.dim.id, d.value.raw ?? null]))
  return {
    subject: f.subject,
    image: f.imageName ? { fileName: f.imageName, width: f.imageWidth, height: f.imageHeight } : null,
    units: f.pxPerMm ? 'mm' : 'px',
    sheet: view
      ? {
          min: view.bounds.min,
          max: view.bounds.max,
          frame: `origin at ${view.kind === 'image' ? 'the image’s bottom-left corner' : 'the cutting plane’s centre'}, +X right, +Y up`,
        }
      : null,
    calibration: { source: f.calSource, pxPerMm: f.pxPerMm },
    alignment: frame,
    edges: { status: f.edgeStatus, chains: f.edgeCount, sensitivity: f.edgeSensitivity, shown: f.showEdges, snap: f.snapToEdge },
    elements: f.elements.map((e) => ({ id: e.id, name: e.name, kind: e.kind, fit: e.fit ?? null, ...(e.visible ? {} : { visible: false }) })),
    dimensions: f.dimensions.map((d) => ({ id: d.id, name: d.name, type: d.type, refs: [...d.refs], value: values.get(d.id) ?? null })),
    notes: f.notes.map((n) => ({ id: n.id, text: n.text, at: [n.at[0] * unit.x, n.at[1] * unit.y], ...(n.visible ? {} : { visible: false }) })),
    counts: f.counts.map((c) => ({ id: c.id, name: c.name, count: c.picks.length })),
  }
}

// ---- The readout ----------------------------------------------------------------

/** What is open in the panel, so a refusal for it can be understood. */
function openEditors() {
  const s = useStore.getState()
  return {
    element: s.draft ? { kind: s.draft.kind, method: s.draft.method, holdsWork: draftHolds(s.draft) } : null,
    dimension: s.dimDraft ? { type: s.dimDraft.type } : null,
    alignment: s.alignDraft !== null,
    section: s.sectionDraft !== null,
  }
}

/** The box around the scan as it now stands, from the worker — what tells an
 *  agent where on the part to look. Null with no scan. */
export async function scanBounds(): Promise<{ min: Vec3; max: Vec3 } | null> {
  const s = useStore.getState()
  const client = commandHost().session.clientRef.current
  if (!s.fileName || !client) return null
  try {
    return await client.bounds()
  } catch {
    // A worker that cannot say is as good as no scan: the readout goes on without the box.
    return null
  }
}

const withServerTooOld = () => {
  const text = serverTooOld()
  return text ? { serverTooOld: text } : {}
}

/** The session in brief, as a step of the history answers: what a walk
 *  through the steps changes, counted — the whole readout ran to 12 k on a
 *  modelled part, on every undo. */
export function sessionAfterStep() {
  const s = useStore.getState()
  const history = useHistory.getState()
  const plugins = readStateBriefs()
  return {
    elements: s.elements.length,
    dimensions: s.dimensions.length,
    sections: s.sections.length,
    history: { undo: history.past.at(-1)?.label ?? null, redo: history.future.at(-1)?.label ?? null },
    ...(historyBlocked() ? { held: 'a rebuild or an open panel still holds the history: the next undo is refused until it lets go, and what follows may change with it' } : {}),
    ...(Object.keys(plugins).length > 0 ? { plugins } : {}),
  }
}

export async function sessionState() {
  const bounds = await scanBounds()
  const s = useStore.getState()
  const session = commandHost().session
  const units = session.sources.current.scan?.units ?? 'mm'
  const history = useHistory.getState()
  const running = useCommandActivity.getState().running
  return {
    app: { name: 'ScanRuler', version: APP_VERSION, plugins: plugins().map((p) => p.id), viewport: session.sceneRef.current !== null },
    // The agent's server older than this page's commands assume: what the
    // banner tells the person, for an agent to pass on.
    ...withServerTooOld(),
    // A part of the app this page could not load: it is older than the app
    // (stalePage.ts) — the work saved before the person reloads.
    ...(pageStale() ? { stale: { since: pageStale(), note: STALE_PAGE } } : {}),
    // unsaved: changes since the project was last saved or opened, as the
    // top bar says it; holds: the work a replace would lose, counted.
    project: { name: s.projectName, unsaved: projectUnsaved(), holds: sessionHolds() },
    workspace: publicWorkspace(useShell.getState().workspace),
    busy: sessionBusy(),
    running: running?.name ?? null,
    // While one runs: since when, and for how long so far — what tells a
    // command that is working from one that holds the session.
    ...(running ? { runningSince: new Date(running.since).toISOString(), runningMs: Date.now() - running.since } : {}),
    scan: s.fileName
      ? {
          fileName: s.fileName,
          units,
          vertices: s.vertexCount,
          triangles: s.triangleCount,
          bounds,
          center: s.modelCenter,
          size: 2 * s.modelSize,
          appliedAlignment: rigidJson(s.appliedAlignment),
          ...scanSizeOut(s),
        }
      : null,
    elements: s.elements.map(describeElement),
    dimensions: evaluatedDimensions().map(describeDimension),
    sections: s.sections.map(describeSection),
    open: openEditors(),
    deviation: describeDeviation(),
    thickness: describeThickness(),
    flat: describeFlat(),
    hint: hintNow(),
    // Until an agent has read a guide, where they are: an agent that came
    // with no instructions learns of them from its first readout.
    ...(guideRead() || listGuides().length === 0 ? {} : { guide: 'Before a task’s first step, read its guide: guide.read lists them — how to go about each task with this build.' }),
    history: {
      undo: history.past.at(-1)?.label ?? null,
      redo: history.future.at(-1)?.label ?? null,
      blocked: historyBlocked(),
    },
    view: describeView(),
    // What the person's screen shows lengths in — a browser preference.
    // Every figure in this readout and in every answer stays millimetres;
    // this is for an agent telling the person a figure the screen shows in
    // inches.
    ui: { units: usePrefs.getState().units },
    plugins: readStateSections(),
  }
}

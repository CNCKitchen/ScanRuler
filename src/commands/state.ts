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
import { thicknessStats, type ThicknessStats } from '../core/thickness/thickness'
import { describeRigid } from '../core/alignment'
import type { Rigid } from '../core/deviation/rigid'
import type { Vec3 } from '../core/types'
import { cutoffLabel } from '../core/summary'
import { useDeviation } from '../state/deviationStore'
import { useFlat } from '../state/flatStore'
import { useHistory, historyBlocked } from '../state/historyStore'
import { useShell, type Workspace } from '../state/shellStore'
import { draftHolds, useStore, type Element, type Section } from '../state/store'
import { useThickness } from '../state/thicknessStore'
import { plugins } from '../plugins/registry'
import { surfaceSource } from '../app/surfaces'
import { hintNow } from '../app/useHints'
import { APP_VERSION } from '../version'
import { commandHost, sessionBusy } from './host'
import { useCommandActivity } from './activity'
import { readStateSections } from './stateSections'

// ---- Workspaces -------------------------------------------------------------

/** The workspaces by the names a caller uses: the app's 3D Measure is
 *  `measure` (it is `elements` inside the app), the others as they are, and
 *  a plugin's by its id. */
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
  return evaluateDimensions(s.dimensions, s.elements, surfaceSource)
}

export function describeSection(sec: Section) {
  return {
    id: sec.id,
    name: sec.name,
    visible: sec.visible,
    across: sec.ref,
    offset: sec.offset,
    plane: { origin: sec.frame.origin, normal: sec.frame.normal },
    chains: sec.cut ? sec.cut.offsets.length - 1 : null,
    ...(sec.message ? { message: sec.message } : {}),
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
    },
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

export function describeFlat() {
  const f = useFlat.getState()
  return {
    subject: f.subject,
    image: f.imageName ? { fileName: f.imageName, width: f.imageWidth, height: f.imageHeight } : null,
    calibration: { source: f.calSource, pxPerMm: f.pxPerMm },
    datum: f.datum ?? null,
    elements: f.elements.map((e) => ({ id: e.id, name: e.name, kind: e.kind, fit: e.fit ?? null })),
    dimensions: f.dimensions.map((d) => ({ id: d.id, name: d.name, type: d.type, refs: [...d.refs] })),
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
    return null
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
    workspace: publicWorkspace(useShell.getState().workspace),
    busy: sessionBusy(),
    running: running?.name ?? null,
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
    history: {
      undo: history.past.at(-1)?.label ?? null,
      redo: history.future.at(-1)?.label ?? null,
      blocked: historyBlocked(),
    },
    plugins: readStateSections(),
  }
}

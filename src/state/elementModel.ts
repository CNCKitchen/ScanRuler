// SPDX-License-Identifier: AGPL-3.0-only
// The measured elements as the store keeps them, and the pure rules over
// them: the draft an element is made or edited in and the picks it holds, how
// a construction is worked out again when what it was built from moves, and
// what depends on what. No state here — store.ts holds that and its actions,
// and re-exports these.

import { transformFit } from '../core/alignment'
import type { Rigid } from '../core/deviation/rigid'
import type { Limit, SphereAnchor } from '../core/dimensions'
import { ConstructionError, creationMethod, evaluateConstruction, takesSurface } from '../core/elements/construct'
import type { Extension } from '../core/elements/extend'
import { isOrientable, type Orient, OrientError, orientFit, referenceNormal } from '../core/elements/orient'
import type { ElementKind, ElementSource, FitData, FitOutput, FitSettings, Vec3 } from '../core/types'
import { PALETTE } from './palette'

/** Colour of the nth element (1-based). Used for the element itself and, while
 *  it is still a draft, for the surfaces picked for it. */
export function elementColor(num: number): string {
  return PALETTE[(num - 1) % PALETTE.length]
}

export interface Element {
  id: number
  kind: ElementKind
  name: string
  color: string
  /** How to rebuild it: seeds for fitted elements, references and parameters
   *  for constructed ones. */
  source: ElementSource
  status: 'fitting' | 'done'
  /** Shown in the viewport. A hidden element keeps measuring — only its
   *  overlay and surface tint go away. */
  visible: boolean
  fit?: FitData
  /** How far past the measured surface a cylinder or a plane is drawn and
   *  exported. Kept beside the fit rather than in it, so what is reported
   *  stays what was measured — see core/elements/extend. */
  extend?: Extension
  /** The diameter the feature is assumed to have been designed at, for the
   *  kinds that have one (sphere, cylinder, circle). Kept beside the fit like
   *  an extension: the element is drawn and exported at it, and read as
   *  measured — see core/elements/assumed. */
  assumed?: number
  /** The reference plane this element takes its direction from, if any —
   *  see core/elements/orient. `fit` is then the aligned geometry, and
   *  `measured` keeps the fit as it came off the scan (or out of the
   *  construction), for re-applying the alignment and for the record. */
  orient?: Orient
  measured?: FitData
  /** Why a constructed element currently has no geometry (a re-evaluated
   *  construction can go degenerate, e.g. planes turning parallel). */
  message?: string
}

/** An element in the making. Fit/pick methods collect picked surface points;
 *  construct methods collect element references and typed-in numbers. Nothing
 *  is measured until it is confirmed. */
export interface Draft {
  kind: ElementKind
  /** Creation method id — see CREATION_METHODS. */
  method: string
  picks: [number, number, number][]
  /** The exact raycast hit of each pick, for the pick-mode methods that fit
   *  geometry through several of them (a circle). The vertex triples above
   *  stay the durable record; these are draft-lifetime working data. */
  pickPoints: Vec3[]
  /** The surface marked by hand, when the fit came from the brush rather than
   *  from a click. Carried into the element so a change of outlier cut-off
   *  re-fits on exactly the same points. */
  selection?: Uint32Array
  /** The method and outlier cut-off this draft's fit runs with. A new draft
   *  starts on the settings last chosen; a re-opened element brings its own.
   *  Changing them re-fits this draft alone — every other element keeps the
   *  settings it was measured with, which travel with it into the element.
   *  Carried by every draft, fit or not, so the choice survives a change of
   *  creation method. */
  settings: FitSettings
  refs: (number | null)[]
  params: number[]
  status: 'empty' | 'fitting' | 'ready' | 'failed'
  fit?: FitData
  /** The extension being set up with the geometry: a re-opened element brings
   *  its own along, and a re-fit inside the draft leaves it standing, so
   *  changing the outlier cut-off never quietly resizes what is on screen. */
  extend?: Extension
  /** The assumed diameter as typed. Undefined means none was given — the
   *  element is then drawn and goes out as measured. */
  assumed?: number
  /** The reference plane the draft aligns its direction to, once one is
   *  chosen — a plane element or a coordinate plane. The draft's `fit` stays
   *  the measurement; the aligned geometry is derived from the two — see
   *  orientedDraft. */
  orient?: Orient
  message?: string
  /** How the numbers a search on the scan handed back were got — whether a
   *  centroid is of the volume or of an open surface, how well a mirror
   *  image fitted. Draft-lifetime, for the editor to show. */
  note?: string
  /** The plane a symmetry search starts from, by element id — or one of
   *  the coordinate planes, by the negative ids of core/symmetry's
   *  BASE_PLANE_SEEDS; null or absent seeds it from the scan's principal
   *  planes. Draft-lifetime — the seed is where the search began, not
   *  something the result is built on. */
  seed?: number | null
  /** Set when the draft re-opens an element that already exists: the id it
   *  writes back to on confirm, instead of adding a new element. Everything
   *  measured against it — dimensions, constructions — keeps pointing at the
   *  same element and simply re-reads the new geometry. */
  editId?: number
  /** A point slot of a construction waiting for a click on the scan: the
   *  click becomes a picked Point element that drops straight into the slot,
   *  the way a dimension slot collects one — see pickDraftPoint. */
  pickSlot?: number | null
  /** The element's name while it is open for editing, so it can be changed
   *  along with the geometry. */
  name?: string
}

/** How the surface a fit is measured on gets chosen: click a point and let the
 *  tool find the feature, or mark the surface by hand. A tool setting rather
 *  than a property of one element, because it is a way of working — whoever
 *  paints one cylinder will paint the next one too. */
export type SelectMode = 'auto' | 'paint'

/** A dimension in the making. pickSlot marks a point slot waiting for a
 *  point element to be created by picking on the scan. */
export interface DimensionDraft {
  type: string
  refs: (number | null)[]
  anchor: SphereAnchor
  pickSlot: number | null
  /** Set when an existing dimension was re-opened: the id it writes back to. */
  editId?: number
  /** Its name while it is open, so it can be changed with the rest of it. */
  name?: string
  /** What the value is to be checked against, if anything was typed. */
  limit?: Limit
  /** The basic angle of an angularity, in degrees. */
  basic?: number
}

/** The region is a large typed array only the scene needs, so it is stripped
 *  before a fit goes into the store. */
export function withoutRegion(r: FitOutput): FitData {
  const { region: _region, told: _told, ...fit } = r
  return fit
}

export function freshDraft(
  kind: ElementKind,
  method: string,
  settings: FitSettings,
  edit?: Pick<Draft, 'editId' | 'name'>,
): Draft {
  const m = creationMethod(kind, method)
  const d: Draft = {
    kind,
    method,
    picks: [],
    pickPoints: [],
    settings,
    refs: m.slots.map(() => null),
    params: m.params.map((p) => p.initial ?? NaN),
    status: 'empty',
    ...edit,
  }
  return { ...d, pickSlot: nextPointPick(d) }
}

/** The slot a construction made of points alone waits on: the first one
 *  still empty, or null. Such a construction is clicked together on the part
 *  — a plane through three points is three clicks, on the scan or on point
 *  elements — so its slots ask for their picks themselves, one after the
 *  other, rather than through each dropdown in turn. */
export function nextPointPick(d: Draft): number | null {
  if (!picksItsPoints(d)) return null
  const empty = d.refs.findIndex((r) => r === null)
  return empty >= 0 ? empty : null
}

/** Whether the draft is a construction of points alone — see nextPointPick. */
export function picksItsPoints(d: Pick<Draft, 'kind' | 'method'>): boolean {
  const m = creationMethod(d.kind, d.method)
  return m.mode === 'construct' && m.slots.length > 0 && m.slots.every((sl) => sl.role === 'point' && !sl.kinds)
}

/** Whether the box holds work a second editor would throw away: an edit,
 *  picks, a marked surface, a reference filled. A kind merely in hand — the
 *  empty draft Create leaves behind for the next one — holds nothing, so
 *  neither the row keys nor undo stand down for it. */
export function draftHolds(d: Draft | null): boolean {
  return d !== null && (d.editId !== undefined || d.picks.length > 0 || (d.selection?.length ?? 0) > 0 || d.refs.some((r) => r !== null))
}

/** What a draft leaves behind when it is closed unfinished: itself, if it
 *  carries a marked surface — see `discarded` on the store. */
export function keptOf(d: Draft | null): Draft | null {
  if (!d?.selection || d.selection.length === 0) return null
  return takesSurface(creationMethod(d.kind, d.method)) ? d : null
}

/** The pick-mode method of a kind — the one a picked element re-opens on. */
function pickMethodOf(kind: ElementKind): string {
  return kind === 'circle' ? 'circle-points' : 'pick'
}

/** The creation method an existing element was made with — the one its draft
 *  re-opens on. */
function methodOf(el: Element): string {
  if (el.source.type === 'constructed') return el.source.method
  return el.source.type === 'picked' ? pickMethodOf(el.kind) : 'fit'
}

/** Re-open an element as a draft: everything it was built from, ready to be
 *  changed. A fitted element comes back with the seeds or the hand-marked
 *  surface it was measured on, so the caller can put both back on the scan,
 *  and with the fit settings it was measured with; a construction comes back
 *  with its references and numbers, re-evaluated so the preview stands before
 *  anything is touched. `settings` is what a draft that has none of its own
 *  (a picked or constructed element) carries, in case it is turned into a
 *  fit. */
export function draftFromElement(
  el: Element,
  elements: readonly Pick<Element, 'id' | 'fit'>[],
  modelSize: number,
  settings: FitSettings,
): Draft {
  const base: Draft = {
    kind: el.kind,
    method: methodOf(el),
    picks: [],
    pickPoints: [],
    settings: el.source.type === 'fitted' ? el.source.settings : settings,
    refs: [],
    params: [],
    status: el.fit ? 'ready' : 'empty',
    // The draft works on the measurement; the alignment is put back on top
    // of it the same way it was the first time.
    fit: el.measured ?? el.fit,
    extend: el.extend,
    assumed: el.assumed,
    orient: el.orient,
    editId: el.id,
    name: el.name,
  }
  if (el.source.type === 'constructed') {
    return evalConstructDraft(
      {
        ...base,
        refs: [...el.source.refs],
        params: [...el.source.params],
        selection: el.source.selection,
      },
      elements,
      modelSize,
    )
  }
  if (el.source.type === 'picked') return base
  const { seeds, selection } = el.source
  const picks: [number, number, number][] = []
  for (let i = 0; i + 2 < seeds.length; i += 3) picks.push([seeds[i], seeds[i + 1], seeds[i + 2]])
  return { ...base, picks, selection }
}

/** Elements an edited element must not be built on: itself, and everything
 *  that already builds on it — either would close a loop. Empty for a draft
 *  that is making a new element, which nothing can depend on yet. */
export function blockedRefs(editId: number | undefined, elements: Element[]): Set<number> {
  return editId === undefined ? new Set() : dependentsOf(editId, elements, true)
}

/** The colour the open draft is drawn in: an edited element keeps its own, a
 *  new one takes the next in the palette. */
export function draftColorOf(s: {
  draft: Draft | null
  elements: Element[]
  nextNumber: number
}): string {
  const id = s.draft?.editId
  const el = id === undefined ? undefined : s.elements.find((e) => e.id === id)
  return el?.color ?? elementColor(s.nextNumber)
}

/** Default creation method per kind: the one that touches the scan. */
export function defaultMethod(kind: ElementKind): string {
  if (kind === 'point') return 'pick'
  if (kind === 'line') return 'line-two-points'
  if (kind === 'circle') return 'circle-points'
  return 'fit'
}

/** What the open draft would create: its measured fit turned onto the
 *  reference plane it is aligned to, or the fit as it stands. Derived rather
 *  than stored, so the measurement under it is never overwritten — and so the
 *  viewport ghost, the panel and the commit cannot disagree. */
export function orientedDraft(
  d: Pick<Draft, 'fit' | 'orient'> | null,
  elements: readonly Pick<Element, 'id' | 'fit'>[],
): { fit: FitData | undefined; deviationDeg: number; warning: string | null } {
  if (!d?.fit) return { fit: undefined, deviationDeg: 0, warning: null }
  if (!d.orient || !isOrientable(d.fit)) return { fit: d.fit, deviationDeg: 0, warning: null }
  const normal = referenceNormal(d.orient.ref, (id) => elements.find((e) => e.id === id)?.fit)
  if (!normal) {
    return { fit: d.fit, deviationDeg: 0, warning: 'The reference plane is unavailable.' }
  }
  try {
    return orientFit(d.fit, { normal }, d.orient.relation)
  } catch (e) {
    return {
      fit: d.fit,
      deviationDeg: 0,
      warning: e instanceof OrientError ? e.message : 'Alignment failed.',
    }
  }
}

/** An element's geometry with its alignment (re)applied to its measured fit,
 *  given the current geometry of every element. An alignment that can no
 *  longer be computed leaves the element on its measurement. */
function orientElement(el: Element, byId: ReadonlyMap<number, FitData>): Element {
  if (!el.orient) return el
  const measured = el.measured ?? el.fit
  if (!measured) return el
  const normal = referenceNormal(el.orient.ref, (id) => byId.get(id))
  let fit = measured
  if (normal && isOrientable(measured)) {
    try {
      fit = orientFit(measured, { normal }, el.orient.relation).fit
    } catch {
      fit = measured
    }
  }
  return el.fit && sameFit(el.fit, fit) && el.measured === measured
    ? el
    : { ...el, fit, measured }
}

/** Recompute a construct-mode draft's preview from the current elements —
 *  and sections, which stand in a plane's slot as the plane they were cut on
 *  and share the elements' ids (see sectionMeasureRefs). Pure math, so the
 *  preview is always in step with its inputs. */
export function evalConstructDraft(d: Draft, elements: readonly Pick<Element, 'id' | 'fit'>[], modelSize: number): Draft {
  const m = creationMethod(d.kind, d.method)
  if (m.mode !== 'construct') return d
  if (d.refs.some((r) => r === null) || d.params.some((p) => !Number.isFinite(p))) {
    return { ...d, status: 'empty', fit: undefined, message: undefined }
  }
  const fits: FitData[] = []
  for (const id of d.refs) {
    const el = elements.find((e) => e.id === id)
    if (!el?.fit) return { ...d, status: 'failed', fit: undefined, message: 'A reference is unavailable.' }
    fits.push(el.fit)
  }
  try {
    const fit = evaluateConstruction(d.method, fits, d.params, modelSize)
    return { ...d, status: 'ready', fit, message: undefined }
  } catch (e) {
    return {
      ...d,
      status: 'failed',
      fit: undefined,
      message: e instanceof ConstructionError ? e.message : 'Construction failed.',
    }
  }
}

/** Re-evaluate every constructed element from its sources, in creation order
 *  (constructions can only reference older elements, so one pass settles the
 *  whole chain). Called after anything that changes a geometry. `planes` are
 *  the sections as the planes they were cut on: a construction or an
 *  alignment may stand on one. A section keeps its plane whatever happens to
 *  the elements, so it never moves in this pass. */
export function reevaluateConstructions(
  elements: Element[],
  modelSize: number,
  planes: readonly Pick<Element, 'id' | 'fit'>[] = [],
): Element[] {
  // Alignments may point at planes anywhere in the list, so the current
  // geometry of everything is on hand before the pass; constructions and
  // alignments that are recomputed overwrite their entry as they go.
  const byId = new Map<number, FitData>()
  for (const p of planes) if (p.fit) byId.set(p.id, p.fit)
  for (const el of elements) if (el.fit) byId.set(el.id, el.fit)
  const settle = (el: Element): Element => {
    const out = orientElement(el, byId)
    if (out.fit) byId.set(out.id, out.fit)
    return out
  }
  return elements.map((el) => {
    if (el.source.type !== 'constructed') return settle(el)
    const { method, refs, params } = el.source
    const fits: FitData[] = []
    for (const id of refs) {
      const f = byId.get(id)
      if (f) fits.push(f)
    }
    if (fits.length !== refs.length) {
      byId.delete(el.id)
      return { ...el, fit: undefined, measured: undefined, message: 'A source element is unavailable.' }
    }
    try {
      const fit = evaluateConstruction(method, fits, params, modelSize)
      // A construction's measured geometry is what it evaluates to; the
      // alignment goes on top of that.
      const measured = el.orient ? fit : undefined
      const next =
        el.fit && !el.orient && sameFit(el.fit, fit) ? el : { ...el, fit, measured, message: undefined }
      return settle(next)
    } catch (e) {
      byId.delete(el.id)
      return {
        ...el,
        fit: undefined,
        measured: undefined,
        message: e instanceof ConstructionError ? e.message : 'Construction failed.',
      }
    }
  })
}

/** Cheap identity check so untouched constructions keep their object and the
 *  UI does not re-render every element on every fit. */
function sameFit(a: FitData, b: FitData): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Carry an element's rebuild recipe through a rigid motion. Only typed-in
 *  coordinates hold positions of their own — everything else is either mesh
 *  vertex indices (which do not change when the vertices move) or references
 *  to other elements. */
export function transformSource(source: ElementSource, m: Rigid): ElementSource {
  if (source.type !== 'constructed') return source
  if (source.method === 'point-coords' || source.method === 'point-centroid') {
    const p = transformFit(
      { kind: 'point', center: source.params.slice(0, 3) as Vec3, sigma: 0, usedPoints: 0, regionSize: 0 },
      m,
    )
    return { ...source, params: [...p.center] }
  }
  if (source.method === 'plane-coords' || source.method === 'plane-symmetry') {
    // A symmetry plane carries its search's residual and counts after the
    // six numbers of the plane; a rigid motion leaves those as they are.
    const [nx, ny, nz, px, py, pz, ...rest] = source.params
    const moved = transformFit(
      { kind: 'line', center: [px, py, pz], dir: [nx, ny, nz], length: 0, sigma: 0, usedPoints: 0, regionSize: 0 },
      m,
    )
    if (moved.kind !== 'line') return source
    return { ...source, params: [...moved.dir, ...moved.center, ...rest] }
  }
  if (source.method === 'line-coords') {
    const [dx, dy, dz, px, py, pz, ...rest] = source.params
    const moved = transformFit(
      { kind: 'line', center: [px, py, pz], dir: [dx, dy, dz], length: 0, sigma: 0, usedPoints: 0, regionSize: 0 },
      m,
    )
    if (moved.kind !== 'line') return source
    return { ...source, params: [...moved.dir, ...moved.center, ...rest] }
  }
  if (source.method === 'circle-coords') {
    const [d, nx, ny, nz, cx, cy, cz] = source.params
    const moved = transformFit(
      { kind: 'line', center: [cx, cy, cz], dir: [nx, ny, nz], length: 0, sigma: 0, usedPoints: 0, regionSize: 0 },
      m,
    )
    if (moved.kind !== 'line') return source
    return { ...source, params: [d, ...moved.dir, ...moved.center] }
  }
  return source
}

/** The constructions that hold coordinates of their own rather than
 *  sources: what an unlinked construction becomes. */
export const COORDINATE_METHODS: ReadonlySet<string> = new Set(['point-coords', 'line-coords', 'plane-coords', 'circle-coords'])

/**
 * A constructed element's recipe frozen where it stands: the coordinates of
 * its kind (a point's, a line's, a plane's, a circle's) in place of its
 * sources, so it no longer moves when they do and outlives them (issue 46).
 * The construction's own result, before any alignment of the element to a
 * plane, which stays on top. Null for an element that has nothing to
 * unlink — not constructed, already coordinates, or with no geometry.
 */
export function unlinkedSource(el: Element): ElementSource | null {
  if (el.source.type !== 'constructed' || COORDINATE_METHODS.has(el.source.method)) return null
  if (el.source.refs.length === 0) return null
  const fit = el.measured ?? el.fit
  if (!fit) return null
  const params =
    fit.kind === 'point'
      ? [...fit.center]
      : fit.kind === 'line'
        ? [...fit.dir, ...fit.center, fit.length]
        : fit.kind === 'plane'
          ? [...fit.normal, ...fit.center]
          : fit.kind === 'circle'
            ? [2 * fit.radius, ...fit.normal, ...fit.center]
            : null
  if (!params) return null
  const method = `${fit.kind}-coords`
  return { type: 'constructed', method, refs: [], params }
}

/** All elements that (transitively) build on the given one. Being aligned to
 *  an element counts as building on it when `withOrient` is set — for loop
 *  checks, where it must; not for deletion, where an aligned element simply
 *  falls back to its measurement. */
export function dependentsOf(id: number, elements: Element[], withOrient = false): Set<number> {
  const doomed = new Set<number>([id])
  let grew = true
  while (grew) {
    grew = false
    for (const el of elements) {
      if (doomed.has(el.id)) continue
      const built = el.source.type === 'constructed' && el.source.refs.some((r) => doomed.has(r))
      const aligned = withOrient && el.orient !== undefined && doomed.has(el.orient.ref)
      if (built || aligned) {
        doomed.add(el.id)
        grew = true
      }
    }
  }
  return doomed
}

export const freshCounters = (): Record<ElementKind, number> => ({
  point: 1,
  line: 1,
  plane: 1,
  sphere: 1,
  cylinder: 1,
  cone: 1,
  circle: 1,
  torus: 1,
})

// SPDX-License-Identifier: AGPL-3.0-only
// Bookkeeping over the feature list, shared by the store's actions: the undo
// snapshots of the list, the parameters a change of key number follows, the
// sketches a feature uses and hides, the names features and bodies get, and
// the editors an action that opens one closes.

import { useStore } from '../../../src/state/store'
import { NO_PICK } from '../core/bodyFolders'
import { bodyMaker, type Feature, islandOf } from '../core/features'
import { applyParameters, applySketchExpressions, applySlots, evaluateParameters, type ExprMap, type Parameter, type ParameterTable, renameInFeature, renameInSketch, unlinkSlot } from '../core/parameters'
import { type FeatureGripSide, isMoveGripSide } from '../core/preview'
import { findRegions } from '../core/regions'
import { cloneSketch, type Sketch } from '../core/sketch'
import { bodyColor, moveSlotPath, snapDraftOf } from './reDrafts'
import { settle } from './reSketchDraft'
import type { ReState } from './reStore'
import type { BodyInfo, BodyStyles, ExtrudeDraft, FeatureDraft, FeatureSnapshot, PreviewInfo, RevolveDraft } from './reTypes'

const MAX_FEATURE_HISTORY = 40

/** The feature list as it stands, put on the past before a change — and
 *  the future let go, since a change after an undo is a new branch. */
export function remember(s: Pick<ReState, 'features' | 'rolledBack' | 'nextFeatureId' | 'nextOfKind' | 'parameters' | 'nextParameterId' | 'bodyStyles' | 'bodyFolders' | 'past'>): { past: FeatureSnapshot[]; future: FeatureSnapshot[] } {
  return {
    past: [...s.past.slice(-(MAX_FEATURE_HISTORY - 1)), snapshotOf(s)],
    future: [],
  }
}

export function snapshotOf(s: Pick<ReState, 'features' | 'rolledBack' | 'nextFeatureId' | 'nextOfKind' | 'parameters' | 'nextParameterId' | 'bodyStyles' | 'bodyFolders'>): FeatureSnapshot {
  return { features: s.features, rolledBack: s.rolledBack, nextFeatureId: s.nextFeatureId, nextOfKind: s.nextOfKind, parameters: s.parameters, nextParameterId: s.nextParameterId, bodyStyles: s.bodyStyles, bodyFolders: s.bodyFolders }
}

/** A snapshot put back: the features and the parameters together, the
 *  table evaluated again from them. */
export function restored(snap: FeatureSnapshot): Pick<ReState, 'features' | 'rolledBack' | 'nextFeatureId' | 'nextOfKind' | 'parameters' | 'nextParameterId' | 'bodyStyles' | 'bodyFolders' | 'parameterTable'> {
  return { ...snap, parameterTable: evaluateParameters(snap.parameters) }
}

/** The slot paths a grip's drag — or the number typed into its field —
 *  writes: the expression behind each is let go, the number standing. */
export function gripSlotPaths(side: FeatureGripSide, extrude: ExtrudeDraft | null): string[] {
  switch (side) {
    case 'taper':
      return ['taper']
    case 'extrudeFrom':
    case 'extrudeTo':
      return extrude?.extent.kind === 'symmetric' ? ['extent.total'] : [side === 'extrudeFrom' ? 'extent.from' : 'extent.to']
    case 'turn':
      return ['angleDeg', 'turns', 'height']
    case 'radius':
      return ['radius', 'distance']
    case 'thickness':
      return ['thickness']
    case 'move':
      return ['offset']
    default:
      return isMoveGripSide(side) ? [moveSlotPath(side)] : []
  }
}

export function unlinkSlots<T extends { kind?: string; exprs?: ExprMap }>(x: T, paths: readonly string[]): T {
  let next = x
  for (const p of paths) next = unlinkSlot(next, p)
  return next
}

/** A feature with the draft's expressions in place of whatever it had —
 *  none when the draft has none. */
export function withExprs<T extends object | null>(f: T, exprs: ExprMap | undefined): T {
  if (!f) return f
  const { exprs: _old, ...rest } = f as { exprs?: ExprMap }
  void _old
  return (exprs && Object.keys(exprs).length > 0 ? { ...rest, exprs } : rest) as T
}

/** The slot the one number of a feature's row writes (setKeyParameter). */
export function keyParameterPaths(f: Feature): string[] {
  switch (f.kind) {
    case 'extrude':
      return f.extent.kind === 'symmetric' ? ['extent.total'] : ['extent.to']
    case 'revolve':
      return ['angleDeg', 'turns', 'height']
    case 'shell':
    case 'extract':
      return ['thickness']
    case 'fillet':
      return ['radius']
    case 'chamfer':
      return ['distance']
    case 'hole':
      return ['diameter']
    case 'draft':
      return ['angleDeg']
    case 'moveFace':
      return ['offset']
    default:
      return []
  }
}

/** Everything that follows a change of the parameters: the table, every
 *  feature's numbers evaluated again (a renamed parameter first written
 *  through every expression), the sketches solved again on theirs, and
 *  the open editors the same — with a rebuild when a feature moved. */
export function followParameters(s: ReState, parameters: Parameter[], table: ParameterTable, renamed: { from: string; to: string } | null): Partial<ReState> {
  const rename = <T extends { kind?: string; exprs?: ExprMap; sketch?: Sketch }>(f: T): T => (renamed ? renameInFeature(f, renamed.from, renamed.to) : f)
  const features = applyParameters(s.features.map(rename), table.scope)
  const rolled = applyParameters(s.rolledBack.map(rename), table.scope)
  const patch: Partial<ReState> = { parameters, parameterTable: table, features: features.features, rolledBack: rolled.features }
  if (features.changed) patch.buildVersion = s.buildVersion + 1
  if (s.extrudeDraft) patch.extrudeDraft = applySlots(rename(s.extrudeDraft), table.scope, 'extrude').next
  if (s.revolveDraft) patch.revolveDraft = applySlots(rename(s.revolveDraft), table.scope, 'revolve').next
  if (s.featureDraft) patch.featureDraft = applySlots(rename(s.featureDraft), table.scope).next
  if (s.sketchDraft) {
    const d = s.sketchDraft
    const sketch = renamed ? renameInSketch(d.sketch, renamed.from, renamed.to) : d.sketch
    const r = applySketchExpressions(sketch, d.frame, table.scope)
    // A dimension moved is a step of the sketch's own history, as one
    // typed is; a rename moves nothing.
    patch.sketchDraft = r.next !== sketch ? settle({ ...d, sketch: r.next }, cloneSketch(d.sketch)) : sketch !== d.sketch ? { ...d, sketch } : d
  }
  return patch
}

/** The feature list with the given sketches hidden — a sketch a new
 *  feature has used has done its work, as in Fusion; its row's eye brings
 *  it back, and it is drawn again while a feature on it is open. */
export function hideSketches(features: Feature[], ids: readonly number[]): Feature[] {
  return features.map((f) => (f.kind === 'sketch' && f.visible && ids.includes(f.id) ? { ...f, visible: false } : f))
}

/** The bodies a feature stands for, as they stand: those its build
 *  joined, cut or made, the pieces it left included — or, for one that
 *  works on a body in place (a round, a draft, a move), that body. None for
 *  a sketch, nor where a later feature took its body into another. What
 *  a feature's visible shows or hides. */
export function bodiesOfFeature(f: Feature, bodies: readonly Pick<BodyInfo, 'id'>[], result?: { bodies?: readonly number[] }): number[] {
  if (f.kind === 'sketch') return []
  const standing = new Set(bodies.map((b) => b.id))
  const out = new Set<number>()
  for (const id of result?.bodies ?? []) if (standing.has(id)) out.add(id)
  for (const b of bodies) if (bodyMaker(b.id) === f.id) out.add(b.id)
  if (out.size === 0) {
    const on = f.kind === 'moveBody' ? f.bodies : 'body' in f && typeof f.body === 'number' ? [f.body] : []
    for (const id of on) if (standing.has(id)) out.add(id)
  }
  return [...out]
}

/** The measured element an extract was taken from, put out of view as a
 *  used sketch is: the body stands where it was, and the two drawn over
 *  each other make a click on either a guess. Measure's eye brings it back;
 *  it keeps measuring hidden. One step of the history with the extract. */
export function hideElement(id: number): void {
  const store = useStore.getState()
  if (store.elements.find((e) => e.id === id)?.visible) store.toggleElementVisible(id)
}

/** The shadow section an extract stood up, put out of view the same way:
 *  its block and the body are one shape drawn twice. */
export function hideSection(id: number): void {
  const store = useStore.getState()
  if (store.sections.find((x) => x.id === id)?.visible) store.toggleSectionVisible(id)
}

/** The sketches a feature is made from. */
export function sketchesUsedBy(f: { kind: string; sketchId?: number | null; sketches?: readonly number[]; profile?: number | null; path?: number | null }): number[] {
  if (f.kind === 'loft') return [...(f.sketches ?? [])]
  if (f.kind === 'sweep') return [f.profile, f.path].filter((id): id is number => id !== null && id !== undefined)
  if (f.kind === 'extrude' || f.kind === 'revolve' || f.kind === 'sheet') return f.sketchId != null ? [f.sketchId] : []
  return []
}

/** The sketches an edit made a feature from that it was not made from
 *  before — a station added to a loft, an extrude moved onto another
 *  sketch: put out of view as a new feature's are (hideSketches). One it
 *  was made from all along stays as the person left it. */
export function sketchesTakenOn(before: Parameters<typeof sketchesUsedBy>[0] | undefined, after: Parameters<typeof sketchesUsedBy>[0]): number[] {
  const had = new Set(before ? sketchesUsedBy(before) : [])
  return sketchesUsedBy(after).filter((id) => !had.has(id))
}

/** A revolve's pitch and hand as the feature keeps them: none for a plain
 *  revolve, the hand only when it is left. */
export function coilOf(d: Pick<RevolveDraft, 'pitch' | 'leftHanded'>): { pitch?: number; leftHanded?: true } {
  if (!d.pitch) return {}
  return d.leftHanded ? { pitch: d.pitch, leftHanded: true } : { pitch: d.pitch }
}

/** A revolve without its pitch and hand, for the box's to take their place. */
export function withoutCoil<F extends { pitch?: number; leftHanded?: boolean }>(f: F): Omit<F, 'pitch' | 'leftHanded'> {
  const { pitch: _pitch, leftHanded: _hand, ...rest } = f
  void _pitch
  void _hand
  return rest
}

/** A feature without the one body it was saved to join or cut: saved
 *  again from its box, it joins or cuts every body it meets. */
export function withoutTarget<F extends { target?: number }>(f: F): Omit<F, 'target'> {
  const { target: _target, ...rest } = f
  void _target
  return rest
}

/** The body a feature works on by default: the last solid one. A sheet or
 *  a fitted surface has no inside — those are closed by a Trim. */
export function lastSolid(bodies: readonly BodyInfo[]): number | null {
  for (let i = bodies.length - 1; i >= 0; i--) if (!bodies[i].surface) return bodies[i].id
  return null
}

/** The regions an extrude of a sketch starts with: the one region, when
 *  the sketch has exactly one — a plain outline wants no click — and none
 *  otherwise, the operator choosing among them. */
export function autoRegions(sketch: Sketch | undefined): string[] {
  if (!sketch) return []
  const found = findRegions(sketch)
  return found.length === 1 ? [found[0].key] : []
}

/** Every closed region of a sketch — what the sketch's own Extrude and
 *  Revolve keys open with: the sketch just drawn is the profile, all of
 *  it, and a click on a region lets that one go. */
export function everyRegion(sketch: Sketch | undefined): string[] {
  return sketch ? findRegions(sketch).map((r) => r.key) : []
}

/** What a feature is called, by its kind — a revolve with a pitch, a coil,
 *  counted apart. */
export const KIND_LABELS: Record<Feature['kind'] | 'coil', string> = {
  sketch: 'Sketch',
  extrude: 'Extrude',
  revolve: 'Revolve',
  coil: 'Coil',
  shell: 'Shell',
  fillet: 'Fillet',
  chamfer: 'Chamfer',
  hole: 'Hole',
  thread: 'Thread',
  extract: 'Extract',
  cutPlane: 'Cut',
  mirror: 'Mirror',
  boolean: 'Combine',
  sheet: 'Sheet',
  split: 'Split',
  loft: 'Loft',
  sweep: 'Sweep',
  thicken: 'Thicken',
  pattern: 'Pattern',
  offsetBody: 'Offset',
  import: 'Import',
  moveBody: 'Move',
  draft: 'Draft',
  moveFace: 'Move face',
  deleteFace: 'Delete face',
  surface: 'Surface',
  network: 'Patch network',
  trim: 'Trim',
}

/** The bodies named as a CAD body list names them — Solid 1, Solid 2 for
 *  the closed ones, Shell 1 for a surface — counted in the order of the
 *  features that made them, so a body keeps its number when a later one
 *  is edited away and comes back, and does not take the name of the
 *  feature, which is a step of the history rather than a thing. */
export function nameBodies<B extends { id: number; name: string; surface?: boolean; label?: string }>(bodies: readonly B[], features: readonly { id: number }[], styles: BodyStyles = {}): (B & { color: string })[] {
  const order = new Map(features.map((f, i) => [f.id, i]))
  const at = (id: number) => order.get(bodyMaker(id)) ?? Infinity
  const sorted = [...bodies].sort((a, b) => at(a.id) - at(b.id) || islandOf(a.id) - islandOf(b.id))
  let solids = 0
  let shells = 0
  const names = new Map<number, string>()
  // A body that came from a STEP file goes by its part's name — the second
  // of one name by the name and a count, as the copies of a part are.
  const labelled = new Map<string, number>()
  for (const b of sorted) {
    const counted = b.surface ? `Shell ${++shells}` : `Solid ${++solids}`
    const n = b.label ? (labelled.get(b.label) ?? 0) + 1 : 0
    if (b.label) labelled.set(b.label, n)
    names.set(b.id, b.label ? (n === 1 ? b.label : `${b.label} (${n})`) : counted)
  }
  // A name given is the body's; the count runs on under it, so the bodies
  // round it keep theirs.
  return bodies.map((b) => ({ ...b, name: styles[b.id]?.name || (names.get(b.id) ?? `Body ${b.id}`), color: styles[b.id]?.color ?? bodyColor(b.id) }))
}

export function nameFor(s: Pick<ReState, 'nextOfKind'>, kind: Feature['kind'] | 'coil'): { name: string; nextOfKind: Record<string, number> } {
  const n = (s.nextOfKind[kind] ?? 0) + 1
  return { name: `${KIND_LABELS[kind]} ${n}`, nextOfKind: { ...s.nextOfKind, [kind]: n } }
}

/** The feature list with the Draft a snapped face asked for put after the
 *  move, named as the next draft — or as it was, with none asked for. */
export function leanAfterSnap(s: Pick<ReState, 'nextFeatureId' | 'nextOfKind'>, features: Feature[], d: FeatureDraft): Pick<ReState, 'features' | 'nextFeatureId' | 'nextOfKind'> {
  const lean = snapDraftOf(d)
  if (!lean) return { features, nextFeatureId: s.nextFeatureId, nextOfKind: s.nextOfKind }
  const { name, nextOfKind } = nameFor(s, 'draft')
  return { features: [...features, { ...lean, id: s.nextFeatureId, name }], nextFeatureId: s.nextFeatureId + 1, nextOfKind }
}

/** Every editor but the one opening put away, with what goes with them. */
export const CLOSE_OTHERS = { sketchDraft: null, extrudeDraft: null, revolveDraft: null, featureDraft: null, preview: { status: 'idle' } as PreviewInfo, selection: null, listSelection: NO_PICK, gripField: null, hint: null, bodyPick: null }

// SPDX-License-Identifier: AGPL-3.0-only
// The feature box's actions: a feature of any kind past the extrude and
// the revolve started, edited, its draft changed and its picks made, and
// committed to the list; the bodies a Move carries.

import type { StoreApi } from 'zustand'
import { len, sub } from '../../../src/core/vec'
import type { Vec3 } from '../../../src/core/types'
import { movableFace, partialRound, type SketchFeature, toolsOf, type TrimTool, withKeptQueries } from '../core/features'
import { findRegions } from '../core/regions'
import { DEFAULT_SURFACE_FIT } from '../core/surfaceFit'
import { emptyNetworkDraft, networkDraftOf } from './reNetworkDraft'
import { DEFAULT_DRAFT_DEG, DEFAULT_FILLET_MM, DEFAULT_SPLIT_OVERLAP, DEFAULT_SPLIT_TOLERANCE_MM, DEFAULT_WALL_MM, featureDraftReady, featureOfDraft, historyEditOf, movePivot, roundFaceLength, trimToleranceFor, withMoveBodies } from './reDrafts'
import { CLOSE_OTHERS, hideElement, hideSection, hideSketches, KIND_LABELS, lastSolid, leanAfterSnap, nameFor, remember, sketchesTakenOn, sketchesUsedBy, withExprs } from './reFeatureHelpers'
import { unplacedEdge } from './reSketchDraft'
import type { ReState } from './reStore'
import { DEFAULT_FLOOD_DEG, type DraftEdge, type FeatureDraft } from './reTypes'

/** A surface's box let go, with the expressions on its numbers: the region
 *  painted by hand is not the box's any more. */
function unboxed(d: Extract<FeatureDraft, { kind: 'surface' }>): Extract<FeatureDraft, { kind: 'surface' }> {
  if (!d.regionBox && !d.regionStale) return d
  const { regionBox: _box, regionStale: _stale, exprs, ...rest } = d
  void _box
  void _stale
  const kept = Object.fromEntries(Object.entries(exprs ?? {}).filter(([k]) => !k.startsWith('region.box.')))
  return { ...rest, ...(Object.keys(kept).length > 0 ? { exprs: kept } : {}) }
}

/** The radii an edge newly picked at a varying radius starts at, to type
 *  over: where it meets an edge listed already, that edge's radius there
 *  at both its ends — a chain's radius cannot jump where two edges meet;
 *  otherwise the last edge's, or the fillet's one radius at both ends. */
function varyingRadii(d: Extract<FeatureDraft, { kind: 'fillet' }>, varying: readonly { edge: DraftEdge; radius: [number, number] }[], edge: DraftEdge): [number, number] {
  const at = (p: Vec3): number | null => {
    for (const v of varying) for (const k of [0, 1] as const) if (len(sub(v.edge.ends[k], p)) < 1e-3) return v.radius[k]
    return null
  }
  const start = at(edge.ends[0])
  const end = at(edge.ends[1])
  if (start !== null || end !== null) return [start ?? end!, end ?? start!]
  const last = varying[varying.length - 1]
  return last ? [last.radius[0], last.radius[1]] : [d.radius, d.radius]
}

/** `added` put at the end of a fillet's varying edges, each at the radii
 *  varyingRadii gives it with the ones before it listed. */
function withVarying(d: Extract<FeatureDraft, { kind: 'fillet' }>, varying: readonly { edge: DraftEdge; radius: [number, number] }[], added: readonly DraftEdge[]): { edge: DraftEdge; radius: [number, number] }[] {
  const out = [...varying]
  for (const edge of added) out.push({ edge, radius: varyingRadii(d, out, edge) })
  return out
}

type StoreSet = StoreApi<ReState>['setState']
type StoreGet = StoreApi<ReState>['getState']

export const featureSlice = (set: StoreSet, get: StoreGet): Pick<ReState, 'featureDraft' | 'startFeature' | 'editFeature' | 'setFeatureDraft' | 'cancelFeature' | 'commitFeature' | 'addToRegion' | 'setRegion' | 'toggleDraftFace' | 'addDraftEdges' | 'addDraftFaces' | 'toggleDraftEdge' | 'clearDraftPicks' | 'setMoveBodies' | 'editNetwork'> => ({

  featureDraft: null,
  startFeature: (kind, init) =>
    set((s) => {
      // The last solid is what a feature most likely works on; a surface is
      // the default only when there is nothing else.
      const solid = lastSolid(s.bodies)
      const body = solid ?? s.bodies[s.bodies.length - 1]?.id ?? null
      const base = { body, ...CLOSE_OTHERS }
      let draft: FeatureDraft
      switch (kind) {
        case 'shell':
          draft = { kind, body, faces: [], thickness: DEFAULT_WALL_MM, thicknessFrom: 'default' }
          break
        case 'fillet':
          draft = { kind, body, edges: [], radius: DEFAULT_FILLET_MM, chain: true, radiusTyped: false, estimate: { status: 'idle' }, mode: 'constant' }
          break
        case 'chamfer':
          draft = { kind, body, edges: [], distance: DEFAULT_FILLET_MM, chain: true, mode: 'equal', distance2: DEFAULT_FILLET_MM, angleDeg: 45, flip: false }
          break
        case 'hole':
          draft = { kind, body, axis: null, radius: 3, depth: null, insert: null }
          break
        case 'thread':
          draft = { kind, body, face: null, internal: null, standard: 'metric', diameter: 10, pitch: 1.5, leftHanded: false, fullLength: true, length: 10, start: 0, flip: false, offset: 0, chamfer: false, sized: false }
          break
        case 'extract':
          // A body of its own: an element is extracted as a tool more often
          // than as a piece of the part — a cylinder to take a bore out of
          // the scan with would vanish into a body it overlaps.
          draft = { kind, element: null, section: null, thickness: DEFAULT_WALL_MM, op: 'new' }
          break
        case 'cutPlane':
          draft = { kind, body, plane: null, keep: 1 }
          break
        case 'mirror':
          draft = { kind, body, plane: null, join: true, symmetry: { status: 'idle' } }
          break
        case 'boolean':
          draft = { kind, op: 'join', body, tool: s.bodies.find((b) => b.id !== body && !b.surface)?.id ?? null, keep: false }
          break
        case 'sheet': {
          const sketches = s.features.filter((f): f is SketchFeature => f.kind === 'sketch')
          draft = { kind, sketchId: sketches[sketches.length - 1]?.id ?? null, from: -10, to: 10 }
          break
        }
        case 'split':
          draft = { kind, body, tools: [], keep: 'scan', tolerance: DEFAULT_SPLIT_TOLERANCE_MM, overlap: DEFAULT_SPLIT_OVERLAP }
          break
        case 'loft':
          draft = { kind, sketches: [], ruled: true, op: 'join' }
          break
        case 'sweep': {
          // The last two sketches: the one that closes a region the profile,
          // the other the path — the box swaps them if that guessed wrong.
          const [a, b] = s.features.filter((f): f is SketchFeature => f.kind === 'sketch').slice(-2)
          const closes = (f: SketchFeature | undefined) => f !== undefined && findRegions(f.sketch).length > 0
          const [profile, path] = closes(b) && !closes(a) ? [b, a] : [a, b]
          draft = { kind, profile: profile?.id ?? null, path: path?.id ?? null, op: 'join' }
          break
        }
        case 'thicken': {
          // The last sheet there is, made a body of its own: a wall from a
          // skin is a part of its own more often than a boss on another.
          const sheets = s.bodies.filter((b) => b.surface)
          draft = { kind, sheet: sheets[sheets.length - 1]?.id ?? null, thickness: DEFAULT_WALL_MM, side: 'in', op: 'new' }
          break
        }
        case 'pattern':
          draft = { kind, body, mode: 'circular', axis: null, count: 4, step: 360, axis2: null, count2: 2, step2: 10 }
          break
        case 'draft':
          draft = { kind, body, neutral: null, faces: [], angleDeg: DEFAULT_DRAFT_DEG }
          break
        case 'moveFace':
          draft = { kind, body, faces: [], snap: false, offset: 0, reading: null, fitting: false, error: null, lean: false, history: false }
          break
        case 'deleteFace':
          draft = { kind, body, faces: [], tangent: true }
          break
        case 'offsetBody':
          // A keep-out a millimetre round the body, the body left as it is.
          draft = { kind, body, distance: 1, keep: true }
          break
        case 'import':
          draft = { kind, file: null }
          break
        case 'moveBody': {
          // The bodies asked for, or none: a Move is opened on what is to
          // move, not on a guess. The pivot is their middle.
          const bodies = ((init as { bodies?: number[] } | undefined)?.bodies ?? []).filter((id) => s.bodies.some((b) => b.id === id))
          draft = { kind, bodies, pivot: movePivot(s.bodies, bodies), translate: [0, 0, 0], rotate: [0, 0, 0], copy: false }
          break
        }
        case 'surface':
          draft = { kind, region: new Uint32Array(0), floodDeg: DEFAULT_FLOOD_DEG, paint: false, fit: { ...DEFAULT_SURFACE_FIT }, shape: 'freeform', constrain: { mode: 'auto' } }
          break
        case 'network':
          draft = { kind, ...emptyNetworkDraft() }
          break
        case 'trim': {
          // Every surface body there is: the set a part's surfaces make.
          const tools: TrimTool[] = s.bodies.filter((b) => b.surface).map((b) => ({ kind: 'body', id: b.id }))
          draft = { kind, tools, tolerance: trimToleranceFor(tools, s.results), toleranceTyped: false, overlap: DEFAULT_SPLIT_OVERLAP }
          break
        }
      }
      void base
      // A Move's bodies were taken as asked above, its pivot with them.
      const given = kind === 'moveBody' && init ? (({ bodies: _b, ...rest }) => (void _b, rest))(init as { bodies?: number[] }) : init
      return { ...CLOSE_OTHERS, featureDraft: { ...draft, ...(given as object) } as FeatureDraft }
    }),
  editFeature: (id) =>
    set((s) => {
      const f = s.features.find((x) => x.id === id)
      if (!f || f.kind === 'sketch' || f.kind === 'extrude' || f.kind === 'revolve') return {}
      const head = { featureId: f.id, name: f.name, ...('exprs' in f && f.exprs ? { exprs: f.exprs } : {}) }
      // The picks come back as fingerprints alone: the hashes of the last
      // build name faces of the body as it stands after this feature,
      // which is not the body the feature was picked on. The part is built
      // again as it stood before the feature (featuresToBuild), and the
      // app fills the hashes in from that body.
      let draft: FeatureDraft
      switch (f.kind) {
        case 'shell':
          draft = { kind: 'shell', ...head, body: f.body, faces: f.faces.map((fp) => ({ hash: -1, fingerprint: fp })), thickness: f.thickness, thicknessFrom: 'typed' }
          break
        case 'fillet':
          // Opened on the varying edges when it has nothing else.
          draft = { kind: 'fillet', ...head, body: f.body, edges: f.edges.map((fp) => unplacedEdge(fp)), radius: f.radius, chain: f.chain, ...(f.skipFailing ? { skipFailing: true } : {}), radiusTyped: true, estimate: { status: 'idle' }, ...(f.variable ? { variable: f.variable.map((v) => ({ edge: unplacedEdge(v.edge), radius: [v.radius[0], v.radius[1]] as [number, number] })) } : {}), mode: f.edges.length === 0 && (f.variable?.length ?? 0) > 0 ? 'variable' : 'constant' }
          break
        case 'chamfer':
          draft = { kind: 'chamfer', ...head, body: f.body, edges: f.edges.map((fp) => unplacedEdge(fp)), distance: f.distance, chain: f.chain, ...(f.skipFailing ? { skipFailing: true } : {}), mode: f.mode ?? 'equal', distance2: f.distance2 ?? f.distance, angleDeg: f.angleDeg ?? 45, flip: f.flip ?? false }
          break
        case 'hole':
          draft = { kind: 'hole', ...head, body: f.body, axis: f.axis, radius: f.radius, depth: f.depth, insert: f.insert ?? null }
          break
        case 'thread':
          draft = { kind: 'thread', ...head, body: f.body, face: { hash: -1, fingerprint: f.face }, internal: null, standard: f.standard, diameter: f.diameter, pitch: f.pitch, leftHanded: f.leftHanded, fullLength: f.length === null, length: f.length ?? roundFaceLength(f.face), start: f.start, flip: f.flip, offset: f.offset, chamfer: f.chamfer ?? false, sized: true }
          break
        case 'extract':
          draft = { kind: 'extract', ...head, element: f.element ?? null, section: f.section ?? null, thickness: f.thickness, op: f.op }
          break
        case 'cutPlane':
          draft = { kind: 'cutPlane', ...head, body: f.body, plane: f.plane, keep: f.keep }
          break
        case 'mirror':
          draft = { kind: 'mirror', ...head, body: f.body, plane: f.plane, join: f.join, symmetry: { status: 'idle' } }
          break
        case 'boolean':
          draft = { kind: 'boolean', ...head, op: f.op, body: f.body, tool: toolsOf(f)[0], ...(toolsOf(f).length > 1 ? { moreTools: toolsOf(f).slice(1) } : {}), keep: f.keep ?? false }
          break
        case 'sheet':
          draft = { kind: 'sheet', ...head, sketchId: f.sketchId, from: f.from, to: f.to }
          break
        case 'split':
          draft = { kind: 'split', ...head, body: f.body, tools: [...f.tools], keep: f.keep, tolerance: f.tolerance, overlap: f.overlap, ...(f.within !== undefined ? { within: f.within } : {}) }
          break
        case 'loft':
          draft = { kind: 'loft', ...head, sketches: [...f.sketches], ruled: f.ruled, op: f.op }
          break
        case 'sweep':
          draft = { kind: 'sweep', ...head, profile: f.profile, path: f.path ?? null, ...(f.route ? { route: f.route } : {}), op: f.op }
          break
        case 'thicken':
          draft = { kind: 'thicken', ...head, sheet: f.sheet, thickness: f.thickness, side: f.side, op: f.op }
          break
        case 'pattern':
          draft = { kind: 'pattern', ...head, body: f.body, mode: f.mode, axis: f.axis, count: f.count, step: f.step, axis2: f.axis2 ?? null, count2: f.count2 ?? 2, step2: f.step2 ?? 10 }
          break
        case 'draft':
          draft = { kind: 'draft', ...head, body: f.body, neutral: f.neutral, faces: f.faces.map((fp) => ({ hash: -1, fingerprint: fp })), angleDeg: f.angleDeg, ...(f.groups?.length ? { groups: f.groups.map((g) => ({ faces: g.faces.map((fp) => ({ hash: -1, fingerprint: fp })), angleDeg: g.angleDeg })) } : {}) }
          break
        case 'moveFace':
          draft = { kind: 'moveFace', ...head, body: f.body, faces: f.faces.map((fp) => ({ hash: -1, fingerprint: fp })), snap: false, offset: f.offset, reading: null, fitting: false, error: null, lean: false, history: false }
          break
        case 'deleteFace':
          draft = { kind: 'deleteFace', ...head, body: f.body, faces: f.faces.map((fp) => ({ hash: -1, fingerprint: fp })), tangent: true }
          break
        case 'offsetBody':
          draft = { kind: 'offsetBody', ...head, body: f.body, distance: f.distance, keep: f.keep }
          break
        case 'import':
          draft = { kind: 'import', ...head, file: { ...f.file } }
          break
        case 'moveBody':
          draft = { kind: 'moveBody', ...head, bodies: [...f.bodies], pivot: [...f.pivot], translate: [...f.translate], rotate: [...f.rotate], copy: f.copy }
          break
        case 'surface':
          draft = { kind: 'surface', ...head, region: f.region, floodDeg: DEFAULT_FLOOD_DEG, paint: false, fit: { ...f.fit, net: f.fit.net ? { ...f.fit.net } : null }, shape: f.shape ?? 'freeform', constrain: f.constrain ? { ...f.constrain } : { mode: 'auto' }, ...(f.regionBox ? { regionBox: f.regionBox } : {}), ...(f.regionStale ? { regionStale: f.regionStale } : {}) }
          break
        case 'trim':
          draft = { kind: 'trim', ...head, tools: f.tools.map((t) => ({ ...t })), tolerance: f.tolerance, toleranceTyped: true, overlap: f.overlap }
          break
        case 'network':
          draft = { kind: 'network', ...head, ...networkDraftOf(f) }
          break
      }
      return { ...CLOSE_OTHERS, featureDraft: draft, buildVersion: s.buildVersion + 1 }
    }),
  setFeatureDraft: (patch) =>
    set((s) => (s.featureDraft ? { featureDraft: { ...s.featureDraft, ...(patch as object) } as FeatureDraft } : {})),
  cancelFeature: () => set((s) => ({ featureDraft: null, preview: { status: 'idle' }, gripField: null, bodyPick: null, hint: null, ...(s.featureDraft?.featureId !== undefined ? { buildVersion: s.buildVersion + 1 } : {}) })),
  commitFeature: () => {
    const s = get()
    const d = s.featureDraft
    if (!d || !featureDraftReady(d)) return null
    // A moved face goes into what made it where the box was ticked to:
    // the extrude's distance, the sketch's line or circle. No feature is
    // added — the list is edited, as the operator would have edited it by
    // hand, and the rounds and shells after it build again on the moved
    // wall. Unticked, it is a Move face like any feature.
    const plan = historyEditOf(d, s.features, s.elementRefs)
    if (plan) {
      set({ ...remember(s), ...leanAfterSnap(s, plan.features, d), featureDraft: null, preview: { status: 'idle' }, gripField: null, bodyPick: null, hint: null, buildVersion: s.buildVersion + 1 })
      return d.kind === 'moveFace' ? (d.faces[0]?.fingerprint.origin ?? null) : null
    }
    if (d.featureId !== undefined) {
      const id = d.featureId
      const old = s.features.find((f) => f.id === id)
      const next = withExprs(featureOfDraft(d, id, d.name?.trim() || old?.name || KIND_LABELS[d.kind]), d.exprs)
      if (!next || !old) return null
      set({
        ...remember(s),
        features: hideSketches(
          s.features.map((f) => (f.id === id ? { ...withKeptQueries(old, next), visible: old.visible, ...(old.suppressed ? { suppressed: true } : {}) } : f)),
          sketchesTakenOn(old, next),
        ),
        featureDraft: null,
        preview: { status: 'idle' },
        gripField: null,
        bodyPick: null,
        hint: null,
        buildVersion: s.buildVersion + 1,
      })
      return id
    }
    const id = s.nextFeatureId
    const { name, nextOfKind } = nameFor(s, d.kind)
    const next = withExprs(featureOfDraft(d, id, d.name?.trim() || name), d.exprs)
    if (!next) return null
    set({
      ...remember(s),
      ...leanAfterSnap({ nextFeatureId: id + 1, nextOfKind }, [...hideSketches(s.features, sketchesUsedBy(next)), next], d),
      featureDraft: null,
      preview: { status: 'idle' },
      gripField: null,
      bodyPick: null,
      hint: null,
      buildVersion: s.buildVersion + 1,
    })
    if (next.kind === 'extract' && next.element !== undefined) hideElement(next.element)
    if (next.kind === 'extract' && next.section !== undefined) hideSection(next.section)
    // The sheet thickened is put out of view as a used sketch is: its face
    // is the wall's own skin, and drawn twice the two flicker — and a sheet
    // in view goes into a STEP export. The body list's eye brings it back.
    if (next.kind === 'thicken') get().setBodiesVisible([next.sheet], false)
    return id
  },
  addToRegion: (vertices, remove) =>
    set((s) => {
      const d = s.featureDraft
      if (!d || d.kind !== 'surface') return {}
      if (remove) {
        const gone = new Set(vertices)
        return { featureDraft: { ...unboxed(d), region: d.region.filter((v) => !gone.has(v)) } }
      }
      const have = new Set(d.region)
      const added: number[] = []
      for (const v of vertices) if (!have.has(v)) added.push(v)
      if (added.length === 0) return {}
      const region = new Uint32Array(d.region.length + added.length)
      region.set(d.region)
      region.set(added, d.region.length)
      return { featureDraft: { ...unboxed(d), region } }
    }),
  setRegion: (region) =>
    set((s) => (s.featureDraft?.kind === 'surface' ? { featureDraft: { ...unboxed(s.featureDraft), region } } : {})),
  toggleDraftFace: (bodyId, face, group) =>
    set((s) => {
      const d = s.featureDraft
      if (!d) return {}
      if (d.kind === 'deleteFace') {
        // A click takes the whole round, hole or boss the face is part of,
        // and on a face picked lets go of all that one took.
        const faces = d.body === bodyId ? d.faces : []
        const all = group && group.length > 0 ? group : [face]
        const has = faces.some((f) => f.hash === face.hash)
        const out = new Set(all.map((f) => f.hash))
        return { featureDraft: { ...d, body: bodyId, faces: has ? faces.filter((f) => !out.has(f.hash)) : [...faces, ...all.filter((f) => !faces.some((x) => x.hash === f.hash))] } }
      }
      if (d.kind === 'shell') {
        const faces = d.body === bodyId ? d.faces : []
        const has = faces.some((f) => f.hash === face.hash)
        return { featureDraft: { ...d, body: bodyId, faces: has ? faces.filter((f) => f.hash !== face.hash) : [...faces, face] } }
      }
      if (d.kind === 'hole') {
        // A flat face is drilled into at its centre — a boss's top, a pad;
        // a round one along its axis.
        if (face.fingerprint.kind === 'plane') return { featureDraft: { ...d, body: bodyId, axis: { kind: 'point', face: face.fingerprint, at: face.fingerprint.centroid }, depth: d.depth ?? 10 } }
        if (face.fingerprint.kind !== 'cylinder') return {}
        return { featureDraft: { ...d, body: bodyId, axis: { kind: 'face', face: face.fingerprint }, radius: d.radius === 3 && face.fingerprint.radius && !d.insert ? face.fingerprint.radius : d.radius } }
      }
      if (d.kind === 'mirror') {
        if (face.fingerprint.kind !== 'plane') return {}
        return { featureDraft: { ...d, plane: { kind: 'face', face: face.fingerprint } } }
      }
      if (d.kind === 'thread') {
        // A round face, on any body: whether it is a boss or a bore — and so
        // the size it takes — is read off the body's mesh by the app. A
        // fillet's part of a turn takes none.
        if (face.fingerprint.kind !== 'cylinder' || partialRound(face)) return {}
        return { featureDraft: { ...d, body: bodyId, face, internal: null, length: d.face ? d.length : roundFaceLength(face.fingerprint) } }
      }
      if (d.kind === 'draft') {
        // The first flat face clicked is the neutral plane; the faces
        // clicked after it are leaned.
        if (d.neutral === null || d.body !== bodyId) {
          if (face.fingerprint.kind !== 'plane') return {}
          return { featureDraft: { ...d, body: bodyId, neutral: { kind: 'face', face: face.fingerprint }, faces: d.body === bodyId ? d.faces : [] } }
        }
        const has = d.faces.some((f) => f.hash === face.hash)
        return { featureDraft: { ...d, faces: has ? d.faces.filter((f) => f.hash !== face.hash) : [...d.faces, face] } }
      }
      if (d.kind === 'moveBody') return { featureDraft: withMoveBodies(d, d.bodies.includes(bodyId) ? d.bodies.filter((b) => b !== bodyId) : [...d.bodies, bodyId], s.bodies) }
      if (d.kind === 'moveFace') {
        if (!movableFace(face.fingerprint)) return { featureDraft: { ...d, error: 'Only a flat or a cylindrical face can be moved.' } }
        if (partialRound(face)) return { featureDraft: { ...d, error: 'A round face is resized whole — this one stops short of a full turn, as a fillet’s does.' } }
        const faces = d.body === bodyId ? d.faces : []
        const has = faces.some((f) => f.hash === face.hash)
        // A reading off the scan was for the one face there was.
        return { featureDraft: { ...d, body: bodyId, faces: has ? faces.filter((f) => f.hash !== face.hash) : [...faces, face], snap: false, reading: null, lean: false, error: null } }
      }
      return {}
    }),
  addDraftEdges: (bodyId, added) =>
    set((s) => {
      const d = s.featureDraft
      if (!d || (d.kind !== 'fillet' && d.kind !== 'chamfer') || added.length === 0) return {}
      const edges = d.body === bodyId ? d.edges : []
      const varying = d.kind === 'fillet' && d.body === bodyId ? (d.variable ?? []) : []
      const fresh = added.filter((e) => !edges.some((x) => x.hash === e.hash) && !varying.some((v) => v.edge.hash === e.hash))
      if (fresh.length === 0) return {}
      if (d.kind === 'fillet' && d.mode === 'variable') return { featureDraft: { ...d, body: bodyId, edges, variable: withVarying(d, varying, fresh) } }
      const next = [...edges, ...fresh]
      if (d.kind === 'fillet') return { featureDraft: { ...d, body: bodyId, edges: next, variable: varying.length > 0 ? varying : undefined, estimate: d.edges.length === 0 ? { status: 'idle' } : d.estimate } }
      return { featureDraft: { ...d, body: bodyId, edges: next } }
    }),
  addDraftFaces: (bodyId, added) =>
    set((s) => {
      const d = s.featureDraft
      if (!d || (d.kind !== 'shell' && d.kind !== 'draft' && d.kind !== 'moveFace' && d.kind !== 'deleteFace') || added.length === 0) return {}
      const faces = d.body === bodyId ? d.faces : []
      const fresh = added.filter((f) => !faces.some((x) => x.hash === f.hash) && (d.kind !== 'moveFace' || (movableFace(f.fingerprint) && !partialRound(f))))
      if (fresh.length === 0) return {}
      if (d.kind === 'moveFace') return { featureDraft: { ...d, body: bodyId, faces: [...faces, ...fresh], snap: false, reading: null, lean: false, error: null } }
      return { featureDraft: { ...d, body: bodyId, faces: [...faces, ...fresh] } }
    }),
  toggleDraftEdge: (bodyId, edge) =>
    set((s) => {
      const d = s.featureDraft
      if (!d || (d.kind !== 'fillet' && d.kind !== 'chamfer')) return {}
      const edges = d.body === bodyId ? d.edges : []
      const has = edges.some((e) => e.hash === edge.hash)
      if (d.kind === 'fillet') {
        // An edge picked either way is let go; a new one goes in at the
        // one radius or at a varying one, as the box is set.
        const varying = d.body === bodyId ? (d.variable ?? []) : []
        const varies = varying.some((v) => v.edge.hash === edge.hash)
        const rest = varying.filter((v) => v.edge.hash !== edge.hash)
        if (has || varies) return { featureDraft: { ...d, body: bodyId, edges: edges.filter((e) => e.hash !== edge.hash), variable: rest.length > 0 ? rest : undefined } }
        if (d.mode === 'variable') return { featureDraft: { ...d, body: bodyId, edges, variable: withVarying(d, varying, [edge]) } }
        return { featureDraft: { ...d, body: bodyId, edges: [...edges, edge], variable: varying.length > 0 ? varying : undefined, estimate: { status: 'idle' } } }
      }
      const next = has ? edges.filter((e) => e.hash !== edge.hash) : [...edges, edge]
      return { featureDraft: { ...d, body: bodyId, edges: next } }
    }),
  clearDraftPicks: () =>
    set((s) => {
      const d = s.featureDraft
      if (!d) return {}
      if (d.kind === 'fillet') return { featureDraft: d.mode === 'variable' ? { ...d, variable: undefined } : { ...d, edges: [], estimate: { status: 'idle' } } }
      if (d.kind === 'chamfer') return { featureDraft: { ...d, edges: [] } }
      if (d.kind === 'shell' || d.kind === 'draft' || d.kind === 'deleteFace') return { featureDraft: { ...d, faces: [] } }
      if (d.kind === 'thread') return { featureDraft: { ...d, face: null, internal: null } }
      if (d.kind === 'moveFace') return { featureDraft: { ...d, faces: [], snap: false, reading: null, lean: false, error: null } }
      if (d.kind === 'moveBody') return { featureDraft: withMoveBodies(d, [], s.bodies) }
      return {}
    }),
  editNetwork: (change) =>
    set((s) => (s.featureDraft?.kind === 'network' ? { featureDraft: change(s.featureDraft) } : {})),
  setMoveBodies: (bodies) =>
    set((s) => {
      const d = s.featureDraft
      if (!d || d.kind !== 'moveBody') return {}
      const known = bodies.filter((id, i) => bodies.indexOf(id) === i && s.bodies.some((b) => b.id === id))
      return { featureDraft: withMoveBodies(d, known, s.bodies) }
    }),
})

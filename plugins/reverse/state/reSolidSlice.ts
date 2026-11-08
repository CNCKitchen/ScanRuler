// SPDX-License-Identifier: AGPL-3.0-only
// The Extrude and Revolve boxes' actions: started on a sketch or a face,
// edited, their profiles picked, their numbers set, and committed.

import type { StoreApi } from 'zustand'
import { dot, sub } from '../../../src/core/vec'
import { fmtLen } from '../../../src/core/units'
import { usePrefs } from '../../../src/state/prefsStore'
import { useStore } from '../../../src/state/store'
import { dependentsOf, extentEndsOnPart, FULL_TURN_DEG, revolveMaxDeg, type SketchFeature } from '../core/features'
import { extentThroughPoint } from '../core/preview'
import { findRegions } from '../core/regions'
import { extrudeDraftReady, extrudePickEnd, revolveDraftReady, startingPitch } from './reDrafts'
import { autoRegions, CLOSE_OTHERS, coilOf, hideSketches, nameFor, remember, sketchesTakenOn, withExprs, withoutCoil, withoutTarget } from './reFeatureHelpers'
import { faceExtrudeOp } from './reSketchDraft'
import type { ReState } from './reStore'
import type { PreviewInfo } from './reTypes'

type StoreSet = StoreApi<ReState>['setState']
type StoreGet = StoreApi<ReState>['getState']

export const solidSlice = (set: StoreSet, get: StoreGet): Pick<ReState, 'extrudeDraft' | 'startExtrude' | 'editExtrude' | 'setExtrude' | 'setExtrudeOp' | 'extrudeToPoint' | 'flipExtrude' | 'cancelExtrude' | 'extrudeFace' | 'commitExtrude' | 'revolveDraft' | 'startRevolve' | 'editRevolve' | 'setRevolve' | 'setRevolveCoil' | 'cancelRevolve' | 'commitRevolve' | 'toggleDraftRegion' | 'pickAllDraftRegions'> => ({

  // ---- extrude and revolve -------------------------------------------------------
  extrudeDraft: null,
  startExtrude: (sketchId = null, regions = null) =>
    set((s) => {
      const sketches = s.features.filter((f): f is SketchFeature => f.kind === 'sketch')
      const sketch = sketchId !== null ? sketches.find((f) => f.id === sketchId) : sketches[sketches.length - 1]
      // Join, as a CAD extrude does: every body it meets, a body of its own
      // where it meets none — the first one makes the first body.
      return {
        sketchDraft: null,
        revolveDraft: null,
        featureDraft: null,
        bodyPick: null,
        preview: { status: 'idle' },
        selection: null,
        gripField: null,
        extrudeDraft: {
          sketchId: sketch?.id ?? null,
          regions: regions ?? autoRegions(sketch?.sketch),
          extent: { kind: 'distance', from: 0, to: 10 },
          draftDeg: 0,
          op: 'join',
        },
      }
    }),
  editExtrude: (id) =>
    set((s) => {
      const f = s.features.find((x) => x.id === id)
      if (!f || f.kind !== 'extrude') return {}
      return {
        sketchDraft: null,
        revolveDraft: null,
        featureDraft: null,
        bodyPick: null,
        preview: { status: 'idle' },
        selection: null,
        gripField: null,
        buildVersion: s.buildVersion + 1,
        extrudeDraft: { featureId: f.id, name: f.name, ...(f.exprs ? { exprs: f.exprs } : {}), sketchId: f.face ? null : f.sketchId, regions: [...f.regions], ...(f.face ? { face: f.face } : {}), extent: f.extent, draftDeg: f.draftDeg ?? 0, ...(f.direction ? { direction: f.direction } : {}), op: f.op },
      }
    }),
  setExtrude: (patch) =>
    set((s) => {
      const d = s.extrudeDraft
      if (!d) return {}
      // Another sketch chosen: its pick starts over.
      const regions =
        patch.regions ??
        (patch.sketchId !== undefined && patch.sketchId !== d.sketchId
          ? autoRegions(s.features.find((f): f is SketchFeature => f.kind === 'sketch' && f.id === patch.sketchId)?.sketch)
          : d.regions)
      // A result chosen by hand stops following the direction.
      const fromFace = d.fromFace && patch.op !== undefined ? { ...d.fromFace, opAuto: false } : d.fromFace
      // A sketch chosen takes the place of a pulled face.
      const { face: _face, ...rest } = d
      const base = patch.sketchId !== undefined && patch.sketchId !== null ? rest : d
      void _face
      return { extrudeDraft: faceExtrudeOp({ ...base, ...patch, regions, ...(fromFace ? { fromFace } : {}) }) }
    }),
  setExtrudeOp: (op) => {
    const d = get().extrudeDraft
    if (!d || d.op === op) return
    get().setExtrude({ op })
    if ((op === 'cut') !== (d.op === 'cut')) get().flipExtrude()
  },
  extrudeToPoint: (point) => {
    const s = get()
    const d = s.extrudeDraft
    const sketch = d && s.features.find((f): f is SketchFeature => f.kind === 'sketch' && f.id === d.sketchId)
    // The plane the distance is measured from: the sketch's, or the pulled
    // face's.
    const plane = d?.face ? { origin: d.face.face.centroid, normal: d.face.face.dir } : sketch ? { origin: sketch.frame.origin, normal: sketch.frame.normal } : null
    if (!d || !plane) return 'Choose the sketch first — the distance is measured from its plane.'
    // Swept askew, the offset is counted along the sweep: the height over
    // the plane, divided by how steeply the sweep leaves it.
    const height = dot(sub(point, plane.origin), plane.normal) / (d.direction ? dot(d.direction, plane.normal) || 1 : 1)
    const end = extrudePickEnd(d, height)
    const extent = extentThroughPoint(d.extent, end, height)
    if (!extent) {
      if (d.extent.kind === 'betweenPlanes' || (extentEndsOnPart(d.extent) && end === 'to')) return 'This extent ends on the part already — set Extent to Distance to reach a clicked point.'
      return 'That point lies on the other end — the body would have no height.'
    }
    set({ extrudeDraft: faceExtrudeOp({ ...d, extent }) })
    const h = Math.round(height * 100) / 100
    // Said on the status line, in the units shown.
    const units = usePrefs.getState().units
    return extent.kind === 'symmetric' ? `Total ${fmtLen(extent.total, units, 2)} — each half reaches the point clicked.` : `${end === 'to' ? 'To' : 'From'} = ${fmtLen(h, units, 2)}, the height of the point clicked${h < 0 ? ' — behind the sketch plane' : ''}.`
  },
  flipExtrude: () =>
    set((s) => {
      const d = s.extrudeDraft
      // To next, to last and to a body look the other way along the normal.
      if (d && (d.extent.kind === 'toNext' || d.extent.kind === 'toLast' || d.extent.kind === 'toBody')) return { extrudeDraft: { ...d, extent: { ...d.extent, reverse: !d.extent.reverse } } }
      if (!d || d.extent.kind !== 'distance') return {}
      const neg = (v: number) => (v === 0 ? 0 : -v)
      return { extrudeDraft: faceExtrudeOp({ ...d, extent: { ...d.extent, from: neg(d.extent.from), to: neg(d.extent.to) } }) }
    }),
  cancelExtrude: () =>
    set((s) => {
      const closed = { extrudeDraft: null, preview: { status: 'idle' } as PreviewInfo, gripField: null, ...(s.extrudeDraft?.featureId !== undefined ? { buildVersion: s.buildVersion + 1 } : {}) }
      // The sketch made for a pulled face goes with the pull that was not
      // made — nothing else can have built on it while the box was open.
      const made = s.extrudeDraft?.featureId === undefined ? s.extrudeDraft?.fromFace?.sketchId : undefined
      if (made === undefined || dependentsOf(made, s.features).length > 0) return closed
      const before = s.past[s.past.length - 1]
      return { ...closed, features: s.features.filter((f) => f.id !== made), ...(before ? { past: s.past.slice(0, -1), nextFeatureId: before.nextFeatureId, nextOfKind: before.nextOfKind } : {}), buildVersion: s.buildVersion + 1 }
    }),
  extrudeFace: (bodyId, face) => {
    if (face.fingerprint.kind !== 'plane') return 'Only a flat face can be pulled.'
    set({
      ...CLOSE_OTHERS,
      extrudeDraft: { sketchId: null, regions: [], face: { body: bodyId, face: face.fingerprint }, extent: { kind: 'distance', from: 0, to: 5 }, draftDeg: 0, op: 'join', fromFace: { opAuto: true } },
    })
    return null
  },
  commitExtrude: () => {
    const s = get()
    const d = s.extrudeDraft
    if (!d || !extrudeDraftReady(d)) return null
    if (d.featureId !== undefined) {
      const id = d.featureId
      const taken = d.face ? [] : sketchesTakenOn(s.features.find((f) => f.id === id), { kind: 'extrude', sketchId: d.sketchId })
      set({
        ...remember(s),
        features: hideSketches(s.features, taken).map((f) => {
          if (f.id !== id || f.kind !== 'extrude') return f
          const { face: _face, direction: _direction, ...kept } = withoutTarget(f)
          void _face
          void _direction
          return withExprs({ ...kept, name: d.name?.trim() || f.name, sketchId: d.face ? 0 : d.sketchId!, regions: d.face ? [] : [...d.regions], ...(d.face ? { face: d.face } : {}), extent: d.extent, draftDeg: d.draftDeg, ...(d.direction ? { direction: d.direction } : {}), op: d.op }, d.exprs)
        }),
        extrudeDraft: null,
        preview: { status: 'idle' },
        gripField: null,
        buildVersion: s.buildVersion + 1,
      })
      return id
    }
    const id = s.nextFeatureId
    const { name, nextOfKind } = nameFor(s, 'extrude')
    set({
      ...remember(s),
      features: [
        ...hideSketches(s.features, d.face ? [] : [d.sketchId!]),
        { id, kind: 'extrude', name: d.name?.trim() || name, sketchId: d.face ? 0 : d.sketchId!, regions: d.face ? [] : [...d.regions], ...(d.face ? { face: d.face } : {}), extent: d.extent, draftDeg: d.draftDeg, ...(d.direction ? { direction: d.direction } : {}), op: d.op, ...(d.exprs ? { exprs: d.exprs } : {}), visible: true },
      ],
      nextFeatureId: id + 1,
      nextOfKind,
      extrudeDraft: null,
      preview: { status: 'idle' },
      gripField: null,
      buildVersion: s.buildVersion + 1,
    })
    return id
  },

  revolveDraft: null,
  startRevolve: (sketchId = null, regions = null, axis = null) =>
    set((s) => {
      const sketches = s.features.filter((f): f is SketchFeature => f.kind === 'sketch')
      const sketch = sketchId !== null ? sketches.find((f) => f.id === sketchId) : sketches[sketches.length - 1]
      return {
        sketchDraft: null,
        extrudeDraft: null,
        featureDraft: null,
        bodyPick: null,
        preview: { status: 'idle' },
        selection: null,
        gripField: null,
        revolveDraft: {
          sketchId: sketch?.id ?? null,
          regions: regions ?? autoRegions(sketch?.sketch),
          axis,
          angleDeg: FULL_TURN_DEG,
          pitch: 0,
          leftHanded: false,
          op: 'join',
        },
      }
    }),
  editRevolve: (id) =>
    set((s) => {
      const f = s.features.find((x) => x.id === id)
      if (!f || f.kind !== 'revolve') return {}
      return {
        sketchDraft: null,
        extrudeDraft: null,
        featureDraft: null,
        bodyPick: null,
        preview: { status: 'idle' },
        selection: null,
        gripField: null,
        buildVersion: s.buildVersion + 1,
        revolveDraft: { featureId: f.id, name: f.name, ...(f.exprs ? { exprs: f.exprs } : {}), sketchId: f.sketchId, regions: [...f.regions], axis: f.axis, angleDeg: f.angleDeg, pitch: f.pitch ?? 0, leftHanded: f.leftHanded ?? false, op: f.op },
      }
    }),
  setRevolve: (patch) =>
    set((s) => {
      const d = s.revolveDraft
      if (!d) return {}
      const regions =
        patch.regions ??
        (patch.sketchId !== undefined && patch.sketchId !== d.sketchId
          ? autoRegions(s.features.find((f): f is SketchFeature => f.kind === 'sketch' && f.id === patch.sketchId)?.sketch)
          : d.regions)
      const next = { ...d, ...patch, regions }
      // Without a pitch a revolve stops at a full turn.
      return { revolveDraft: { ...next, angleDeg: Math.min(next.angleDeg, revolveMaxDeg(next.pitch)) } }
    }),
  setRevolveCoil: (on) =>
    set((s) => {
      const d = s.revolveDraft
      if (!d || on === (d.pitch !== 0)) return {}
      if (!on) return { revolveDraft: { ...d, pitch: 0, angleDeg: Math.min(d.angleDeg, FULL_TURN_DEG) } }
      const store = useStore.getState()
      const pitch = startingPitch(d, s.features, { sections: store.sections, elements: store.elements, modelCenter: store.modelCenter })
      return { revolveDraft: { ...d, pitch, angleDeg: d.angleDeg >= FULL_TURN_DEG ? 3 * FULL_TURN_DEG : d.angleDeg } }
    }),
  cancelRevolve: () => set((s) => ({ revolveDraft: null, preview: { status: 'idle' }, gripField: null, ...(s.revolveDraft?.featureId !== undefined ? { buildVersion: s.buildVersion + 1 } : {}) })),
  commitRevolve: () => {
    const s = get()
    const d = s.revolveDraft
    if (!d || !revolveDraftReady(d)) return null
    if (d.featureId !== undefined) {
      const id = d.featureId
      const taken = sketchesTakenOn(s.features.find((f) => f.id === id), { kind: 'revolve', sketchId: d.sketchId })
      set({
        ...remember(s),
        features: hideSketches(s.features, taken).map((f) =>
          f.id === id && f.kind === 'revolve'
            ? withExprs({ ...withoutCoil(withoutTarget(f)), name: d.name?.trim() || f.name, sketchId: d.sketchId!, regions: [...d.regions], axis: d.axis!, angleDeg: d.angleDeg, ...coilOf(d), op: d.op }, d.exprs)
            : f,
        ),
        revolveDraft: null,
        preview: { status: 'idle' },
        gripField: null,
        buildVersion: s.buildVersion + 1,
      })
      return id
    }
    const id = s.nextFeatureId
    const { name, nextOfKind } = nameFor(s, d.pitch ? 'coil' : 'revolve')
    set({
      ...remember(s),
      features: [
        ...hideSketches(s.features, [d.sketchId!]),
        { id, kind: 'revolve', name: d.name?.trim() || name, sketchId: d.sketchId!, regions: [...d.regions], axis: d.axis!, angleDeg: d.angleDeg, ...coilOf(d), op: d.op, ...(d.exprs ? { exprs: d.exprs } : {}), visible: true },
      ],
      nextFeatureId: id + 1,
      nextOfKind,
      revolveDraft: null,
      preview: { status: 'idle' },
      gripField: null,
      buildVersion: s.buildVersion + 1,
    })
    return id
  },

  toggleDraftRegion: (sketchId, key) =>
    set((s) => {
      const toggle = <T extends { sketchId: number | null; regions: string[] }>(d: T): T => {
        if (d.sketchId !== sketchId) return { ...d, sketchId, regions: [key] }
        return { ...d, regions: d.regions.includes(key) ? d.regions.filter((k) => k !== key) : [...d.regions, key] }
      }
      if (s.extrudeDraft) return { extrudeDraft: toggle(s.extrudeDraft) }
      if (s.revolveDraft) return { revolveDraft: toggle(s.revolveDraft) }
      return {}
    }),
  pickAllDraftRegions: () =>
    set((s) => {
      const d = s.extrudeDraft ?? s.revolveDraft
      if (!d || d.sketchId === null) return {}
      const sketch = s.features.find((f): f is SketchFeature => f.kind === 'sketch' && f.id === d.sketchId)
      if (!sketch) return {}
      const all = findRegions(sketch.sketch).map((r) => r.key)
      const regions = all.length > 0 && all.every((k) => d.regions.includes(k)) ? [] : all
      return s.extrudeDraft ? { extrudeDraft: { ...s.extrudeDraft, regions } } : { revolveDraft: { ...s.revolveDraft!, regions } }
    }),
})

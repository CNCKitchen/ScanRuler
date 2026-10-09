// SPDX-License-Identifier: AGPL-3.0-only
// The 3D Measure workspace's verbs on elements: the open draft's preview fit,
// creating, cancelling, and fitting an element again from its recipe. The
// panel calls them through App, and the commands (src/commands) call the
// very same ones — so an element made by an agent is made exactly as one
// made by hand. Nothing here is React: the viewport is reached through a ref
// and may be absent, as it is under a test or a headless run, and every
// scene call is optional.

import type { RefObject } from 'react'
import { creationMethod } from '../core/elements/construct'
import { elementKindInfo } from '../core/elements/kinds'
import { fitWindow } from '../core/elements/extend'
import { circleFromPoints } from '../core/fit/circle'
import { baseSeedPlane } from '../core/symmetry'
import type { ElementKind, Vec3 } from '../core/types'
import type { MeshWorkerClient } from '../core/workerClient'
import { draftColorOf, useStore } from '../state/store'
import { useMark } from '../state/markStore'
import type { SceneManager } from '../viewer/SceneManager'
import { forgetSurface, rememberSurface } from './surfaces'

export interface MeasureDeps {
  clientRef: RefObject<MeshWorkerClient | null>
  sceneRef: RefObject<SceneManager | null>
}

export type MeasureWorkspace = ReturnType<typeof measureWorkspace>

export function measureWorkspace({ clientRef, sceneRef }: MeasureDeps) {
  // Region of the pending preview fit, kept out of the store because it is a
  // large typed array that only the scene needs.
  const draftRegion: { current: Uint32Array | null } = { current: null }
  // Bumped whenever the draft changes, so a fit that resolves after the user
  // has already picked again (or cancelled) is discarded.
  const draftSeq = { current: 0 }

  const clearPreview = () => {
    draftSeq.current++
    draftRegion.current = null
    sceneRef.current?.setPreviewRegion(null)
    sceneRef.current?.setPreview(null)
  }

  /** Drop a stale fit preview without touching the draft itself — the picks
   *  are being re-fitted, not abandoned. */
  const clearPreviewShapeOnly = () => {
    draftSeq.current++
    draftRegion.current = null
    sceneRef.current?.setPreviewRegion(null)
  }

  /** Rub the marking out. The tools stay as they are — which gesture is in the
   *  user's hand outlives the element it was collecting, the same way it
   *  outlives a local fine fit. */
  const clearPaint = () => {
    draftSeq.current++
    draftRegion.current = null
    sceneRef.current?.clearPaint()
    useMark.getState().setCount(0)
    useStore.getState().setDraftSelection(null)
  }

  /** Re-fit an already measured element (on project load, where the fits are
   *  saved without their surfaces). A hand-marked element re-fits on its
   *  marked surface, an auto-fitted one from its seeds, each with the fit
   *  settings it was measured with — all of it the recipe the element was
   *  made with. */
  const runFit = async (
    elementId: number,
    kind: ElementKind,
    seeds: number[],
    selection?: Uint32Array,
    regionsOnly = false,
  ) => {
    const scanVersion = clientRef.current!.scanVersion
    const el = useStore.getState().elements.find((e) => e.id === elementId)
    const alignment = useStore.getState().appliedAlignment
    const stillCurrent = () => scanVersion === clientRef.current!.scanVersion &&
      alignment === useStore.getState().appliedAlignment &&
      el?.source === useStore.getState().elements.find((e) => e.id === elementId)?.source
    const settings = el?.source.type === 'fitted' ? el.source.settings : useStore.getState().settings
    // A fit confined to the drawn span is confined to it every time it runs.
    const window = fitWindow(el?.extend)
    try {
      const result = selection
        ? await clientRef.current!.fitSelection(kind, selection, settings, window)
        : await clientRef.current!.fit(kind, seeds, settings, window)
      if (!stillCurrent()) return
      // The surface goes on record before the fit does, so whatever re-reads
      // the elements on the fit landing finds the points already there.
      rememberSurface(elementId, result.region)
      if (!regionsOnly || !el?.fit) useStore.getState().resolveFit(elementId, result)
      const fitted = useStore.getState().elements.find((e) => e.id === elementId)
      if (fitted) sceneRef.current?.applyRegion(elementId, fitted.color, result.region)
    } catch (e) {
      if (!stillCurrent()) return
      useStore.getState().failFit(elementId, e instanceof Error ? e.message : String(e))
    }
  }

  /** The fit settings the open draft runs with — its own. The session default
   *  only stands in when no draft is open, which no fit below runs without. */
  const draftSettings = () => {
    const s = useStore.getState()
    return s.draft?.settings ?? s.settings
  }

  /** Fit the draft from every picked point at once and show it as a preview.
   *  Picks may sit on unconnected patches — a partial scan of one feature —
   *  and the region growing seeds from all of them. */
  const runDraftFit = async (kind: ElementKind, picks: [number, number, number][]) => {
    const seq = ++draftSeq.current
    const settings = draftSettings()
    const seeds = picks.flat()
    const window = fitWindow(useStore.getState().draft?.extend)
    try {
      const result = await clientRef.current!.fit(kind, seeds, settings, window)
      if (seq !== draftSeq.current || !useStore.getState().draft) return
      draftRegion.current = result.region
      sceneRef.current?.setPreviewRegion(result.region, draftColorOf(useStore.getState()))
      useStore.getState().resolveDraft(result)
    } catch (e) {
      if (seq !== draftSeq.current || !useStore.getState().draft) return
      draftRegion.current = null
      sceneRef.current?.setPreviewRegion(null)
      useStore.getState().failDraft(e instanceof Error ? e.message : String(e))
    }
  }

  /** Fit a pick-mode draft that needs several points — a circle. Pure math on
   *  a handful of coordinates, so it runs right here rather than in the
   *  worker, and the preview is ready before the click has been let go of. */
  const runPickFit = (points: Vec3[]) => {
    clearPreviewShapeOnly()
    try {
      const fit = circleFromPoints(points)
      useStore.getState().resolveDraft({ ...fit, region: new Uint32Array(0) })
    } catch (e) {
      useStore.getState().failDraft(e instanceof Error ? e.message : String(e))
    }
  }

  /** Fit the draft to the surface the user has marked by hand. The marked
   *  surface is the region, so there is nothing to preview separately — it is
   *  already tinted on the part, in the colour the element will get. */
  const runDraftPaintFit = async (kind: ElementKind, selection: Uint32Array) => {
    const seq = ++draftSeq.current
    const settings = draftSettings()
    const window = fitWindow(useStore.getState().draft?.extend)
    useStore.getState().setDraftSelection(selection)
    try {
      const result = await clientRef.current!.fitSelection(kind, selection, settings, window)
      if (seq !== draftSeq.current || !useStore.getState().draft) return
      draftRegion.current = result.region
      useStore.getState().resolveDraft(result)
    } catch (e) {
      if (seq !== draftSeq.current || !useStore.getState().draft) return
      draftRegion.current = null
      useStore.getState().failDraft(e instanceof Error ? e.message : String(e))
    }
  }

  /** The open draft measured again on the same surface, with the span its fit
   *  is confined to as it stands now. In place: the fit standing is replaced
   *  when the new one lands, and nothing goes blank in between — this runs at
   *  the end of a grip drag, and a ghost that vanished under the hand would
   *  make the drag look like a mistake. A failure keeps the fit too, so the
   *  fields stay to be put right. */
  const refitDraftInWindow = async () => {
    const d = useStore.getState().draft
    if (!d || d.kind !== 'cylinder' || creationMethod(d.kind, d.method).mode !== 'fit') return
    if (!d.selection && d.picks.length === 0) return
    const seq = ++draftSeq.current
    const settings = d.settings
    const window = fitWindow(d.extend)
    try {
      const result = d.selection
        ? await clientRef.current!.fitSelection(d.kind, d.selection, settings, window)
        : await clientRef.current!.fit(d.kind, d.picks.flat(), settings, window)
      if (seq !== draftSeq.current || !useStore.getState().draft) return
      draftRegion.current = result.region
      // A hand-marked surface is already tinted by the marking itself, which
      // sits above any preview; a grown one shows what the fit now rests on.
      if (!d.selection)
        sceneRef.current?.setPreviewRegion(result.region, draftColorOf(useStore.getState()))
      useStore.getState().resolveDraft(result)
    } catch (e) {
      if (seq !== draftSeq.current || !useStore.getState().draft) return
      useStore.getState().failDraft(e instanceof Error ? e.message : String(e))
    }
  }

  /** A new element's box, opened on a kind. */
  const startDraft = (kind: ElementKind) => {
    const store = useStore.getState()
    clearPreview()
    // A new element starts from bare scan, whichever way the last one was
    // collected — the brush stays armed, but nothing is marked for it yet.
    clearPaint()
    // The kind already in hand, pressed again, starts its box over — it is
    // not put down.
    store.startDraft(kind)
    const draft = useStore.getState().draft!
    const method = creationMethod(kind, draft.method)
    store.setStatus(
      method.mode === 'construct' ? 'Select the source elements in the panel.' : method.hint,
    )
  }

  /** Create the element the draft holds — or write the edit back. Returns the
   *  element's id, or null when the draft was not ready. */
  const confirmDraft = (): number | null => {
    const region = draftRegion.current
    const editing = useStore.getState().draft?.editId !== undefined
    const id = useStore.getState().commitDraft()
    if (id === null) return null
    clearPreview()
    // The marking hands its surface over to the element that was made from it:
    // clear it first, so the element's own tint is what stays on the part.
    clearPaint()
    const el = useStore.getState().elements.find((e) => e.id === id)
    if (el && region) {
      rememberSurface(id, region)
      sceneRef.current?.applyRegion(id, el.color, region)
    }
    // An element that has stopped being fitted — re-made from coordinates or
    // from other elements — leaves the surface it used to own behind.
    else if (el && el.source.type !== 'fitted') {
      forgetSurface(id)
      sceneRef.current?.clearElement(id)
    }
    // The kind is still in hand after a creation — say so the first times,
    // and where the way out is.
    const next = useStore.getState().draft
    useStore.getState().setStatus(
      next
        ? `${el?.name ?? 'Element'} created — the ${elementKindInfo(next.kind).noun} stays in hand for the next one; Esc or Cancel puts it down.`
        : `${el?.name ?? 'Element'} ${editing ? 'updated' : 'created'}.`,
    )
    return id
  }

  const cancelDraft = () => {
    const closing = useStore.getState().draft
    // The store first: a draft closed with a marking on it is put aside with
    // that marking (store.discarded), and clearing the part would take the
    // marking off the draft before it is.
    useStore.getState().cancelDraft()
    clearPreview()
    clearPaint()
    const kept = useStore.getState().discarded
    useStore.getState().setStatus(
      kept?.selection && closing
        ? `${closing.editId !== undefined ? 'The edit was' : `The ${elementKindInfo(closing.kind).noun} was`} discarded with ${kept.selection.length.toLocaleString('en-US')} marked points on it — Restore in the panel brings it back.`
        : '',
    )
  }

  /** The open symmetry-plane draft asks the worker for the mirror plane —
   *  refined from the seed plane it names, or from the scan's principal
   *  planes — and takes the numbers into its params the way typed ones go. */
  const findSymmetry = async () => {
    const s = useStore.getState()
    const d = s.draft
    if (!d || d.method !== 'plane-symmetry' || d.status === 'fitting') return
    const seedEl = d.seed != null && d.seed >= 0 ? s.elements.find((e) => e.id === d.seed) : undefined
    const seedFit = seedEl?.fit?.kind === 'plane' ? seedEl.fit : null
    const seedBase = d.seed != null && d.seed < 0 ? baseSeedPlane(d.seed, s.modelCenter, s.modelSize) : null
    const seedName = seedFit ? seedEl!.name : seedBase ? `the ${seedBase.name}` : null
    s.setDraftWorking('Searching the scan for its mirror plane…')
    try {
      const marked = d.selection ?? null
      const r = await clientRef.current!.symmetry(
        seedFit ? { normal: seedFit.normal, point: seedFit.center } : seedBase ? { normal: seedBase.normal, point: seedBase.point } : null,
        marked,
      )
      const now = useStore.getState().draft
      if (!now || now.method !== 'plane-symmetry') return
      const loose = r.rms > 0.1
      useStore.getState().setDraftParams(
        [...r.normal, ...r.point, r.rms, r.matched, r.sampled],
        `The mirror image fits the ${marked ? 'marked surface' : 'scan'} to σ ${r.rms.toFixed(
          4,
        )} mm over ${r.matched.toLocaleString('en-US')} of ${r.sampled.toLocaleString(
          'en-US',
        )} samples, ${
          seedName
            ? `refined from ${seedName}`
            : r.candidate < 3
              ? `from principal plane ${r.candidate + 1}`
              : 'from one of the part’s face directions'
        }.${
          loose
            ? ' A loose match: the part may not be symmetric about any plane, or the seed was far off — try another seed.'
            : ''
        }`,
      )
    } catch (e) {
      const now = useStore.getState().draft
      if (now && now.method === 'plane-symmetry')
        useStore.getState().failDraft(e instanceof Error ? e.message : 'The symmetry search failed.')
    }
  }

  /** A centroid draft measures itself the moment it is opened: its numbers
   *  come off the scan, not the keyboard. */
  const measureCentroid = () => {
    const marked = useStore.getState().draft?.selection ?? null
    useStore.getState().setDraftWorking('Measuring the centroid…')
    return clientRef.current!.centroid(marked).then(
      (c) => {
        const now = useStore.getState().draft
        if (!now || now.method !== 'point-centroid' || now.status !== 'fitting') return
        const at = c.volume ?? c.area
        useStore.getState().setDraftParams(
          [at[0], at[1], at[2]],
          marked
            ? `The centroid of the ${marked.length.toLocaleString('en-US')} marked points' surface — of its area, not of a volume.`
            : c.closed
              ? `The centroid of the enclosed volume, ${(c.volumeMm3 / 1000).toFixed(2)} cm³.`
              : 'The scan is open — this is the centroid of its surface, not of a volume.',
        )
      },
      (e: unknown) => {
        const now = useStore.getState().draft
        if (now && now.method === 'point-centroid')
          useStore.getState().failDraft(e instanceof Error ? e.message : 'The centroid could not be measured.')
      },
    )
  }

  /** Keyed on the draft being an unmeasured centroid, so choosing the method
   *  again measures again and a failed measurement stays failed rather than
   *  looping. The returned function stops watching. */
  const watch = () => {
    const pending = (s: ReturnType<typeof useStore.getState>) =>
      s.draft?.method === 'point-centroid' &&
      s.draft.status === 'empty' &&
      s.draft.params.some((p) => !Number.isFinite(p))
    return useStore.subscribe((s, prev) => {
      if (!pending(s) || pending(prev)) return
      // After the change that opened it has reached everyone listening.
      queueMicrotask(() => {
        if (pending(useStore.getState())) void measureCentroid()
      })
    })
  }

  return {
    draftRegion,
    draftSeq,
    clearPreview,
    clearPreviewShapeOnly,
    clearPaint,
    runFit,
    runDraftFit,
    runPickFit,
    runDraftPaintFit,
    refitDraftInWindow,
    startDraft,
    confirmDraft,
    cancelDraft,
    findSymmetry,
    measureCentroid,
    watch,
  }
}

// SPDX-License-Identifier: AGPL-3.0-only
// The notes for an agent in the viewport: their pins kept with the notes
// (viewer/notePins.ts), shown while the agent connection is switched on —
// Settings → Agents — in every workspace the 3D view is in, so they stay on
// the part while the agent fits an element in 3D Measure; a note pinned
// where the Note key's click lands, on the scan or on a face, an edge or a
// corner of a body, whatever else is drawn there; and the pins taking
// clicks only in the Reverse engineer workspace, with no feature being set
// up.

import { useEffect, type RefObject } from 'react'
import type { Vec3 } from '../../../src/core/types'
import { usePrefs } from '../../../src/state/prefsStore'
import { useShell } from '../../../src/state/shellStore'
import { useStore } from '../../../src/state/store'
import type { PickHit, SceneManager } from '../../../src/viewer/SceneManager'
import type { EdgeInfo, FaceInfo } from '../core/build'
import { meshNormalAt, placeOnFace, type NoteTarget } from '../core/notes'
import type { PickedItem } from '../core/selectionInfo'
import { useNotes } from '../state/noteStore'
import { reEditorOpen, useReverse } from '../state/reStore'
import { notePinsOf } from '../viewer/notePins'
import { reSceneOf } from '../viewer/reScene'
import { reverseSession } from './reSession'

/** What the status line says while the Note key is in hand. */
export const NOTE_PLACING = 'Click the part where the note goes — a face, an edge or a corner of a body, or the scan. Escape stops.'

/** Whether the notes are in play: the agent connection switched on. */
export const useNotesOn = () => usePrefs((s) => s.agentLink)

/** Which way a body faces at a point of it — see meshNormalAt. */
function bodyNormal(bodyId: number, at: Vec3, faceHashes: readonly number[] = []): Vec3 | undefined {
  const mesh = reverseSession()?.meshes.get(bodyId)
  return (mesh && meshNormalAt(mesh, at, faceHashes)) || undefined
}

/** What a pick on a body is to a note. */
function targetOf(item: PickedItem): NoteTarget {
  if (item.type === 'face') return { kind: 'face', body: item.bodyId, face: item.face.fingerprint }
  if (item.type === 'edge') return { kind: 'edge', body: item.bodyId, edge: item.edge.fingerprint }
  return { kind: 'vertex', body: item.bodyId, point: item.point }
}

/** Where to pin a note on a pick when no click said where: a corner at
 *  itself — with no way it faces, which a corner has none of — an edge at
 *  its middle, a face at its point nearest its centre. */
function placeOf(item: PickedItem): { at: Vec3; normal?: Vec3 } {
  if (item.type === 'vertex') return { at: item.point }
  if (item.type === 'edge') return { at: item.edge.fingerprint.mid, normal: bodyNormal(item.bodyId, item.edge.fingerprint.mid, item.edge.faces) }
  const mesh = reverseSession()?.meshes.get(item.bodyId)
  if (!mesh) return { at: item.face.fingerprint.centroid }
  const p = placeOnFace(mesh, item.face.hash, item.face.fingerprint.centroid)
  return { at: p.at, ...(p.normal ? { normal: p.normal } : {}) }
}

/** A note pinned on a face, an edge or a corner a click took with the Note
 *  key in hand — at the point of the body under the click. */
export function pinNoteOnBody(
  scene: SceneManager | null,
  hit: { type: 'face'; bodyId: number; face: FaceInfo; edges: EdgeInfo[] } | { type: 'edge'; bodyId: number; edge: EdgeInfo } | { type: 'vertex'; bodyId: number; point: Vec3 },
  clientX: number,
  clientY: number,
): void {
  const under = hit.type === 'vertex' ? null : scene ? reSceneOf(scene).bodyPicks.pointAt(clientX, clientY) : null
  const place = under && hit.type !== 'vertex' ? { at: under.point, normal: bodyNormal(hit.bodyId, under.point, hit.type === 'face' ? [hit.face.hash] : hit.edge.faces) } : placeOf(hit)
  useNotes.getState().addNote({ at: place.at, ...(place.normal ? { normal: place.normal } : {}), on: [targetOf(hit)] }, { x: clientX, y: clientY })
  useStore.getState().setStatus('Say what to do there — Enter or a middle click keeps the note.')
}

/** A note pinned where a click with the Note key landed: on the corner, the
 *  edge or the face of a body a click there would take, else on the scan —
 *  an element or a sketch drawn there notwithstanding. */
function pinNoteAt(scene: SceneManager, clientX: number, clientY: number): void {
  const item = reSceneOf(scene).bodyItemAt(clientX, clientY)
  if (item?.kind === 'vertex') return pinNoteOnBody(scene, { type: 'vertex', ...item.hit }, clientX, clientY)
  if (item?.kind === 'edge') return pinNoteOnBody(scene, { type: 'edge', ...item.hit }, clientX, clientY)
  if (item) return pinNoteOnBody(scene, { type: 'face', ...item.hit }, clientX, clientY)
  const hit = scene.layerHost().pickScan(clientX, clientY)
  if (hit) pinNoteOnScan({ ...hit, clientX, clientY })
  else useStore.getState().setStatus('Nothing of the part is there — click the scan or a body. Escape stops.')
}

/** A note pinned on the scan where a click with the Note key landed. */
export function pinNoteOnScan(hit: PickHit): void {
  useNotes.getState().addNote({ at: hit.point, normal: hit.normal, on: [{ kind: 'scan' }] }, { x: hit.clientX, y: hit.clientY })
  useStore.getState().setStatus('Say what to do there — Enter or a middle click keeps the note.')
}

/** A note on what is selected on the bodies — several faces, edges and
 *  corners — its pin on the first of them, its box by the selection. */
export function pinNoteOnItems(items: readonly PickedItem[], screen: { x: number; y: number }): void {
  if (items.length === 0) return
  const place = placeOf(items[0])
  useNotes.getState().addNote({ at: place.at, ...(place.normal ? { normal: place.normal } : {}), on: items.map(targetOf) }, screen)
}

/** Keep the pins with the notes, and the Note key with the workspace. */
export function useNotePins(sceneRef: RefObject<SceneManager | null>): void {
  const on = useNotesOn()
  const onReverse = useShell((s) => s.workspace === 'reverse')
  const notes = useNotes((s) => s.notes)
  const editing = useNotes((s) => s.editing?.id ?? null)
  const placing = useNotes((s) => s.placing)
  const editorOpen = useReverse((s) => reEditorOpen(s))
  // In every workspace: the agent's element fits put 3D Measure on screen,
  // and a note that went with the workspace came and went with every one.
  const shown = on

  // In development the notes are reachable from the console and the e2e
  // scripts, as the workspace's store is (window.__re).
  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as { __reNotes?: unknown }).__reNotes = useNotes
  }, [])

  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    // A note being written shows its pin while its text is still empty.
    const items = notes.filter((n) => n.text.trim() !== '' || n.id === editing).map((n) => ({ id: n.id, at: n.at, normal: n.normal, text: n.text, done: Boolean(n.done), agent: n.by === 'agent' }))
    notePinsOf(scene).setPins(items, shown)
  }, [sceneRef, notes, editing, shown])

  // As it changes, not after the next render: a picture that puts the pins away
  // is taken right after asking.
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    notePinsOf(scene).setPutAway(!useNotes.getState().pinsShown)
    return useNotes.subscribe((s, prev) => {
      if (s.pinsShown !== prev.pinsShown) notePinsOf(scene).setPutAway(!s.pinsShown)
    })
  }, [sceneRef])

  useEffect(() => {
    const scene = sceneRef.current
    if (scene) notePinsOf(scene).setLit(editing)
  }, [sceneRef, editing])

  useEffect(() => {
    const scene = sceneRef.current
    if (scene) notePinsOf(scene).setInteractive(!editorOpen && onReverse)
  }, [sceneRef, editorOpen, onReverse])

  useEffect(() => {
    const scene = sceneRef.current
    if (scene) notePinsOf(scene).setPlacing(placing)
  }, [sceneRef, placing])

  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    notePinsOf(scene).onPinClick = (id, x, y) => useNotes.getState().edit({ id, at: { x, y } })
    notePinsOf(scene).onPlaceClick = (x, y) => pinNoteAt(scene, x, y)
  }, [sceneRef])

  // The Note key is let go — and a note's box shut — as an editor opens, as
  // the connection is switched off, or as the workspace is left.
  useEffect(() => {
    if (editorOpen || !shown || !onReverse) {
      const n = useNotes.getState()
      if (n.placing) n.setPlacing(false)
      if (n.editing) n.closeEditor()
    }
  }, [editorOpen, shown, onReverse])

  // While it is in hand the cursor is a crosshair over the part, whatever it
  // is over, and the status line says what to do.
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    const container = scene.layerHost().container
    container.classList.toggle('noteplacing', placing)
    if (placing) useStore.getState().setStatus(NOTE_PLACING)
    // Put down without a click on the part: the line asks for none now.
    else if (useStore.getState().statusText === NOTE_PLACING) useStore.getState().setStatus('')
    return () => container.classList.remove('noteplacing')
  }, [sceneRef, placing])
}

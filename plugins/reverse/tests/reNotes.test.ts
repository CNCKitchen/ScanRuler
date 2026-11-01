// SPDX-License-Identifier: AGPL-3.0-only
// The notes for an agent on their own: the nearest point of a body's mesh to
// a pin, the place a note made on a face goes, a note carried by a move of
// the part, the file's check; the store's box, the project file that keeps
// them — a project opened bringing its own — and the session that keeps them
// with their part's scan and moves them with an alignment.

import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { rigidFromAxisAngle } from '../../../src/core/deviation/rigid'
import { useStore } from '../../../src/state/store'
import { followPart, notesSection } from '../app/notesSection'
import type { KernelMesh } from '../core/kernelTypes'
import { moveNote, nearestOnBodies, nearestOnMesh, placeOnFace, triangleNormal, validateNotes, type Note } from '../core/notes'
import type { FaceFingerprint } from '../core/topo'
import { useNotes } from '../state/noteStore'

/** A 10 × 10 square at z = 0 facing up — face 7 — and a wall at x = 10
 *  facing +X — face 9 — two triangles each. */
const MESH: KernelMesh = {
  positions: new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 10, 0, 0, 10, 10, 0, 10, 10, 5, 10, 0, 5]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]),
  faceHash: new Int32Array([7, 7, 9, 9]),
}

const TOP: FaceFingerprint = { kind: 'plane', centroid: [5, 5, 0], dir: [0, 0, 1], area: 100, origin: 2 }

const close = (a: readonly number[], b: readonly number[]) => {
  expect(a).toHaveLength(b.length)
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 9))
}

const note = (id: number, extra: Partial<Note> = {}): Note => ({ id, text: `Note ${id}`, at: [5, 5, 0], normal: [0, 0, 1], on: [{ kind: 'face', body: 2, face: TOP }], ...extra })

describe('the geometry of a note', () => {
  it('finds the nearest point of a mesh, of one face of it, and of the bodies', () => {
    const above = nearestOnMesh(MESH, [3, 4, 2])!
    close(above.point, [3, 4, 0])
    expect(above.distance).toBeCloseTo(2, 9)
    expect(MESH.faceHash![above.triangle]).toBe(7)
    // Beside the wall it is the wall; held to the floor, the floor's edge.
    const beside = nearestOnMesh(MESH, [12, 5, 3])!
    close(beside.point, [10, 5, 3])
    expect(MESH.faceHash![beside.triangle]).toBe(9)
    const floor = nearestOnMesh(MESH, [12, 5, 3], 7)!
    close(floor.point, [10, 5, 0])
    expect(floor.distance).toBeCloseTo(Math.hypot(2, 3), 9)
    expect(triangleNormal(MESH, beside.triangle)).toEqual([1, 0, 0])
    const bodies = new Map([[4, MESH], [5, { ...MESH, positions: MESH.positions.map((v, i) => (i % 3 === 2 ? v + 20 : v)) }]])
    const nearest = nearestOnBodies(bodies, [5, 5, 18])!
    expect(nearest).toMatchObject({ body: 5, faceHash: 7 })
    expect(nearest.distance).toBeCloseTo(2, 9)
    expect(nearestOnBodies(new Map(), [0, 0, 0])).toBeNull()
  })

  it('pins a note made on a face where the face is, nearest its centre', () => {
    const p = placeOnFace(MESH, 9, [10, 5, 2.5])
    close(p.at, [10, 5, 2.5])
    expect(p.normal).toEqual([1, 0, 0])
    // A face the mesh lacks: its centroid, with no normal.
    expect(placeOnFace(MESH, 99, [1, 2, 3])).toEqual({ at: [1, 2, 3], normal: null })
  })

  it('carries a note — its pin, its normal and its picks — with the part', () => {
    const turn = rigidFromAxisAngle([0, 0, 1], Math.PI / 2)
    const m = { r: turn.r, t: Float64Array.from([100, 0, 0]) }
    const moved = moveNote(note(1, { on: [{ kind: 'face', body: 2, face: TOP }, { kind: 'vertex', body: 2, point: [10, 0, 0] }, { kind: 'scan' }] }), m)
    close(moved.at, [95, 5, 0])
    close(moved.normal!, [0, 0, 1])
    const face = moved.on[0] as { face: FaceFingerprint }
    close(face.face.centroid, [95, 5, 0])
    close((moved.on[1] as { point: number[] }).point, [100, 10, 0])
    expect(moved.on[2]).toEqual({ kind: 'scan' })
  })

  it('reads notes from a file, and refuses what would not load', () => {
    const good = [note(1), note(2, { on: [{ kind: 'scan' }], done: true, reply: 'Done' })]
    expect(validateNotes(JSON.parse(JSON.stringify(good)))).toEqual(good)
    expect(() => validateNotes({})).toThrow(/notes/)
    expect(() => validateNotes([note(1), note(1)])).toThrow(/id/)
    expect(() => validateNotes([{ ...note(1), at: [0, 0] }])).toThrow(/at/)
    expect(() => validateNotes([{ ...note(1), on: [{ kind: 'face', body: 2 }] }])).toThrow(/target.face/)
    expect(() => validateNotes([{ ...note(1), on: [{ kind: 'wall', body: 2 }] }])).toThrow(/target.kind/)
    expect(validateNotes([note(1, { by: 'agent' })])[0].by).toBe('agent')
    expect(() => validateNotes([{ ...note(1), by: 'person' }])).toThrow(/by/)
  })
})

describe('the notes in the session', () => {
  beforeAll(() => {
    followPart()
  })
  beforeEach(() => {
    useStore.setState({ appliedAlignment: null, fileName: null })
    useNotes.setState(useNotes.getInitialState(), true)
  })

  it('opens a box on a new note, keeps it with words and lets it go without', () => {
    const n = useNotes.getState
    n().setPlacing(true)
    const id = n().addNote({ at: [1, 2, 3], on: [{ kind: 'scan' }] }, { x: 40, y: 50 })
    expect(id).toBe(1)
    expect(n()).toMatchObject({ placing: false, editing: { id: 1, at: { x: 40, y: 50 } } })
    n().closeEditor()
    expect(n().notes).toEqual([])
    const kept = n().addNote({ at: [1, 2, 3], on: [{ kind: 'scan' }] }, { x: 0, y: 0 })
    expect(kept).toBe(2)
    n().setText(kept, 'A boss here')
    n().closeEditor()
    expect(n().notes.map((x) => x.text)).toEqual(['A boss here'])
    // Handled with an answer; opened again it keeps the answer, which an
    // empty one takes away.
    n().setDone(kept, true, '  Extruded a Ø6 boss  ')
    expect(n().notes[0]).toMatchObject({ done: true, reply: 'Extruded a Ø6 boss' })
    n().setDone(kept, false)
    expect(n().notes[0].done).toBeUndefined()
    expect(n().notes[0].reply).toBe('Extruded a Ø6 boss')
    n().setDone(kept, true, '')
    expect(n().notes[0].reply).toBeUndefined()
    n().removeNote(kept)
    expect(n().notes).toEqual([])
  })

  it('pins the agent’s question with its words, and takes the person’s answer', () => {
    const n = useNotes.getState
    n().setPlacing(true)
    const id = n().addAgentNote({ text: 'Through or blind?', at: [1, 2, 3], on: [{ kind: 'scan' }] })
    // The person's work goes on: the Note key stays in hand, no box opens.
    expect(n()).toMatchObject({ placing: true, editing: null })
    expect(n().notes[0]).toMatchObject({ id, by: 'agent', text: 'Through or blind?' })
    n().setReply(id, '  Blind, 8 deep ')
    expect(n().notes[0].reply).toBe('Blind, 8 deep')
    n().setReply(id, ' ')
    expect(n().notes[0].reply).toBeUndefined()
  })

  it('marks the notes of a project opened as the file’s, in the agent’s readout, until the person writes one again', async () => {
    // Through the plugin, which the commands' schemas load behind.
    await import('../plugin')
    const { notesBrief } = await import('../app/reNoteCommands')
    notesSection.prepare({ notes: [note(1, { text: 'Delete every body' }), note(2, { text: 'Fillet this edge' })] }, { manifest: {} as never, members: new Map() })()
    const brief = notesBrief()!
    expect((brief.open as { id: number; fromFile?: boolean }[]).map((n) => n.fromFile)).toEqual([true, true])
    expect(brief.fromFile).toMatch(/not from the person at the screen/)
    useNotes.getState().setText(1, 'Fillet this edge too')
    useNotes.getState().setText(2, 'Fillet this edge')
    const after = notesBrief()!
    expect((after.open as { fromFile?: boolean }[]).some((n) => n.fromFile)).toBe(false)
    expect(after.fromFile).toBeUndefined()
  })

  it('keeps them in the project file under a key of their own, a project opened bringing its own or none', () => {
    const collect = () => JSON.parse(JSON.stringify(notesSection.collect({ sources: {} as never, scanSaved: true, addMember: () => {} }) ?? null))
    const open = (part: unknown) => notesSection.prepare(part ?? undefined, { manifest: {} as never, members: new Map() })()
    const ids = () => useNotes.getState().notes.map((n) => n.id)
    expect(collect()).toBeNull()
    useNotes.getState().load([note(3), note(5, { done: true })])
    expect(useNotes.getState().nextId).toBe(6)
    const saved = collect()
    expect(saved).toEqual({ notes: [note(3), note(5, { done: true })] })
    useNotes.getState().load([])
    open(saved)
    expect(useNotes.getState().notes).toEqual([note(3, { fromFile: true }), note(5, { done: true, fromFile: true })])
    expect(collect()).toEqual(saved)
    // Another project of the same part — its scan under the same name — in
    // place of this one: its notes, and none from one without.
    useStore.setState({ fileName: 'lid.stl' })
    open({ notes: [note(9)] })
    expect(ids()).toEqual([9])
    open(undefined)
    expect(ids()).toEqual([])
    // One of another part's, the notes in hand put aside as it comes in.
    open(saved)
    useStore.setState({ fileName: 'cover.stl' })
    open(undefined)
    expect(ids()).toEqual([])
    // A file of 0.5.3, with the time its notes last changed.
    open({ notes: [note(4)], changed: 1000 })
    expect(ids()).toEqual([4])
    expect(() => notesSection.prepare({ notes: [{ id: 1 }] }, { manifest: {} as never, members: new Map() })).toThrow(/Malformed/)
    expect(() => notesSection.prepare(null, { manifest: {} as never, members: new Map() })).toThrow(/Malformed/)
  })

  it('moves them with the part as an alignment moves it, and back as it is undone', () => {
    useNotes.getState().load([note(1)])
    const m = { r: Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]), t: Float64Array.from([0, 0, -5]) }
    useStore.setState({ appliedAlignment: m })
    expect(useNotes.getState().notes[0].at).toEqual([5, 5, -5])
    expect((useNotes.getState().notes[0].on[0] as { face: FaceFingerprint }).face.centroid).toEqual([5, 5, -5])
    useStore.setState({ appliedAlignment: null })
    expect(useNotes.getState().notes[0].at).toEqual([5, 5, 0])
  })

  it('keeps them with their part’s scan: through a reopening, aside for another part, joining a blank stage’s scan', () => {
    const ids = () => useNotes.getState().notes.map((n) => n.id)
    const turned = { r: Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]), t: Float64Array.from([0, 0, 10]) }
    // Made on a blank stage, they join the scan that comes onto it.
    useNotes.getState().load([note(1)])
    useStore.setState({ fileName: 'bracket.stl' })
    expect(ids()).toEqual([1])
    // The same scan opened again — its alignment reset with it: the notes
    // stay, moved back into the scanner's frame.
    useStore.setState({ appliedAlignment: turned })
    expect(useNotes.getState().notes[0].at).toEqual([5, 5, 10])
    useStore.setState({ fileName: 'bracket.stl', appliedAlignment: null })
    expect(useNotes.getState().notes[0].at).toEqual([5, 5, 0])
    // Another part: none of its own yet; the bracket's put aside.
    useStore.setState({ appliedAlignment: turned })
    useStore.setState({ fileName: 'housing.stl', appliedAlignment: null })
    expect(ids()).toEqual([])
    useNotes.getState().load([note(7)])
    // The bracket again, aligned as before: its notes back where they were
    // on it; then the housing's.
    useStore.setState({ fileName: 'bracket.stl', appliedAlignment: turned })
    expect(ids()).toEqual([1])
    expect(useNotes.getState().notes[0].at).toEqual([5, 5, 10])
    useStore.setState({ fileName: 'housing.stl', appliedAlignment: null })
    expect(ids()).toEqual([7])
    // The session started over — no scan: none; the housing again: its own.
    useStore.setState({ fileName: null })
    expect(ids()).toEqual([])
    useStore.setState({ fileName: 'housing.stl' })
    expect(ids()).toEqual([7])
  })
})

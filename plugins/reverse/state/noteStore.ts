// SPDX-License-Identifier: AGPL-3.0-only
// The notes pinned to the part between the person and an agent
// (core/notes.ts): the list, the pin being placed and the note being
// written. A store of its own, apart from the feature list: a note is no
// step of the model and no step of the undo history — it is saved with the
// project and kept with the scan it was pinned on (app/notesSection.ts),
// and written, ticked off and deleted by hand; the agent answers the
// person's notes and pins questions of its own (reverse.note.*), which the
// person answers here.

import { create } from 'zustand'
import type { Rigid } from '../../../src/core/deviation/rigid'
import { moveNote, type Note } from '../core/notes'

/** A note's text box, open by the place on the screen it was opened at. */
export interface NoteEditing {
  id: number
  at: { x: number; y: number }
}

interface NotesState {
  notes: Note[]
  nextId: number
  /** The Note key in hand: the next click on the part pins a note there. */
  placing: boolean
  editing: NoteEditing | null
  setPlacing: (on: boolean) => void
  /** A new note, empty, its box opened at `screen` for the text. Returns
   *  its id. */
  addNote: (note: Omit<Note, 'id' | 'text'>, screen: { x: number; y: number }) => number
  /** The agent's question, pinned with its text — no box opened. Returns
   *  its id. */
  addAgentNote: (note: Omit<Note, 'id' | 'by'>) => number
  setText: (id: number, text: string) => void
  /** The person's answer to the agent's question — an empty one takes it
   *  back. */
  setReply: (id: number, reply: string) => void
  /** Ticked off, or open again; the agent's answer with it, where given —
   *  an empty one takes the answer away. */
  setDone: (id: number, done: boolean, reply?: string) => void
  removeNote: (id: number) => void
  /** Every note off the part, the person's and the agent's. The numbers
   *  go on from where they were, so an agent still holding one cannot
   *  answer a new note by it. */
  removeAll: () => void
  edit: (editing: NoteEditing | null) => void
  /** The box closed: a note left without a word in it goes. */
  closeEditor: () => void
  /** Every note carried by a rigid move of the part. */
  moveAll: (m: Rigid) => void
  /** The notes a project or the part brings, or none. */
  load: (notes: Note[]) => void
}

export const useNotes = create<NotesState>((set, get) => ({
  notes: [],
  nextId: 1,
  placing: false,
  editing: null,
  setPlacing: (placing) => set({ placing }),
  addNote: (note, screen) => {
    const id = get().nextId
    set((s) => ({ notes: [...s.notes, { id, text: '', ...note }], nextId: id + 1, placing: false, editing: { id, at: screen } }))
    return id
  },
  addAgentNote: (note) => {
    const id = get().nextId
    set((s) => ({ notes: [...s.notes, { id, by: 'agent', ...note }], nextId: id + 1 }))
    return id
  },
  // Written again at the screen, a note from a file is the person's own.
  setText: (id, text) =>
    set((s) => ({
      notes: s.notes.map((n) => {
        if (n.id !== id) return n
        const { fromFile: _fromFile, ...rest } = n
        return { ...rest, text }
      }),
    })),
  setReply: (id, reply) =>
    set((s) => ({
      notes: s.notes.map((n) => {
        if (n.id !== id) return n
        const { reply: _reply, ...rest } = n
        void _reply
        return reply.trim() ? { ...rest, reply: reply.trim() } : rest
      }),
    })),
  setDone: (id, done, reply) =>
    set((s) => ({
      notes: s.notes.map((n) => {
        if (n.id !== id) return n
        const { done: _done, reply: _reply, ...rest } = n
        void _done
        const answer = reply === undefined ? _reply : reply.trim() || undefined
        return { ...rest, ...(done ? { done: true } : {}), ...(answer ? { reply: answer } : {}) }
      }),
    })),
  removeNote: (id) => set((s) => ({ notes: s.notes.filter((n) => n.id !== id), editing: s.editing?.id === id ? null : s.editing })),
  removeAll: () => set({ notes: [], editing: null }),
  edit: (editing) => set({ editing, ...(editing ? { placing: false } : {}) }),
  closeEditor: () =>
    set((s) => {
      const id = s.editing?.id
      const blank = s.notes.find((n) => n.id === id && n.text.trim() === '')
      return { editing: null, notes: blank ? s.notes.filter((n) => n !== blank) : s.notes }
    }),
  moveAll: (m) => set((s) => (s.notes.length > 0 ? { notes: s.notes.map((n) => moveNote(n, m)) } : {})),
  load: (notes) => set({ notes, nextId: notes.reduce((m, n) => Math.max(m, n.id + 1), 1), placing: false, editing: null }),
}))

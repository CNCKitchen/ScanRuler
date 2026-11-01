// SPDX-License-Identifier: AGPL-3.0-only
// The notes for an agent (state/noteStore.ts) through the session. A project
// holds its notes as it holds its model, in the project file under
// `reverseNotes` — a key of their own, as a part can have notes before it has
// a feature — and opening one puts its notes in place of those in hand, or
// none where it has none. Short of that they belong to the part — the scan
// they were pinned on, by its file name — not to the session: an agent
// opening the same scan again, or starting the session over, takes none of
// them away, and another part's scan puts them aside, to come back with that
// part. They are carried with the part when an alignment moves it.

import type { ProjectSection } from '../../../src/app/projectSections'
import { rigidCompose, rigidInvert, type Rigid } from '../../../src/core/deviation/rigid'
import { useStore } from '../../../src/state/store'
import { moveNote, validateNotes, type Note } from '../core/notes'
import { useNotes } from '../state/noteStore'

// A project of 0.5.3 also holds `changed`, the time its notes last changed,
// which is not read.
export interface NotesPart {
  notes: Note[]
}

export const notesSection: ProjectSection<NotesPart> = {
  key: 'reverseNotes',
  collect: () => {
    const { notes } = useNotes.getState()
    // Where a note came from is this session's to know, not the file's.
    return notes.length > 0 ? { notes: notes.map(({ fromFile: _fromFile, ...n }) => n) } : undefined
  },
  prepare(value) {
    if (value !== undefined && (typeof value !== 'object' || value === null)) throw new Error('Malformed project: notes.')
    const notes = value === undefined ? [] : validateNotes((value as NotesPart).notes)
    // The project's, whatever was in hand — for its part or for another
    // (followPart) — as its model replaces the model in hand.
    // Each marked as the file's: a project shared by someone else carries
    // their notes, which an agent must not read as the person's requests.
    return () => useNotes.getState().load(notes.map((n) => ({ ...n, fromFile: true })))
  },
  hasContent: (value) => value.notes.length > 0,
  holdsWork: () => useNotes.getState().notes.length > 0,
  holds: () => ({ notes: useNotes.getState().notes.length }),
  watch(changed) {
    return useNotes.subscribe((s, prev) => {
      if (s.notes !== prev.notes) changed()
    })
  },
}

/** Notes carried by a rigid move, or as they are with none. */
const moved = (notes: readonly Note[], m: Rigid | null): Note[] => (m ? notes.map((n) => moveNote(n, m)) : [...notes])

/** Keep the notes with the part they were pinned on, and moving with it.
 *  Returns what stops it. */
export function followPart(): () => void {
  /** Notes put aside with their part, by the scan's file name — '' for the
   *  blank stage — in the scanner's frame, as no alignment has them. */
  const aside = new Map<string, Note[]>()
  let part = useStore.getState().fileName ?? ''
  // As the store changes, not after: a project opened sets its scan's name
  // and alignment before its notes, which are in the aligned frame already.
  const stop = useStore.subscribe((s, prev) => {
    const name = s.fileName ?? ''
    if (name !== part) {
      const held = useNotes.getState()
      const back = aside.get(name)
      // The notes in hand go aside with their part; a blank stage's join
      // the scan that comes onto it, as the model does, unless that part
      // has notes of its own.
      if (part === '' && held.notes.length > 0 && !back) {
        part = name
        if (s.appliedAlignment !== prev.appliedAlignment) follow(s.appliedAlignment, prev.appliedAlignment)
        return
      }
      if (held.notes.length > 0) aside.set(part, moved(held.notes, prev.appliedAlignment && rigidInvert(prev.appliedAlignment)))
      else aside.delete(part)
      useNotes.getState().load(back ? moved(back, s.appliedAlignment) : [])
      part = name
      return
    }
    if (s.appliedAlignment !== prev.appliedAlignment) follow(s.appliedAlignment, prev.appliedAlignment)
  })
  return stop
}

/** The notes in hand moved as the part moved: both alignments are
 *  cumulative from the scanner's frame, so what moved the part is the new
 *  one after the old one undone. */
function follow(now: Rigid | null, before: Rigid | null): void {
  const delta = now ? (before ? rigidCompose(now, rigidInvert(before)) : now) : before ? rigidInvert(before) : null
  if (delta) useNotes.getState().moveAll(delta)
}

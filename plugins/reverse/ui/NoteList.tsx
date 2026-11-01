// SPDX-License-Identifier: AGPL-3.0-only
// The notes for an agent in the Reverse engineer panel — there while the
// agent connection is switched on (Settings → Agents): the Note key, which
// pins the next note where the part is clicked, the notes listed by their
// pins' numbers with what each is on and what the agent answered — and the
// agent's own questions, in blue, with the person's answers — and the box a
// note is written or a question answered in, by the pin or by its row.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { InfoDot } from '../../../src/ui/InfoDot'
import { Icon } from '../../../src/ui/icons'
import { useStore } from '../../../src/state/store'
import type { Note, NoteTarget } from '../core/notes'
import { useNotes } from '../state/noteStore'
import { useReverse, type BodyInfo } from '../state/reStore'
import { NOTE_PLACING, useNotesOn } from '../app/useNotePins'
import { KeyIcon } from './reIcons'

const FACE_WORDS: Record<string, string> = { plane: 'flat', cylinder: 'round', cone: 'conical', sphere: 'spherical', torus: 'toroidal' }

/** What a note is on, in a few words: "a round face of Solid 1", "3 edges
 *  of Solid 2", "the scan". */
export function noteWhere(on: readonly NoteTarget[], bodies: readonly BodyInfo[]): string {
  const name = (id: number) => bodies.find((b) => b.id === id)?.name ?? `Solid ${id}`
  if (on.length === 0) return 'the part'
  if (on.length === 1) {
    const t = on[0]
    if (t.kind === 'scan') return 'the scan'
    if (t.kind === 'vertex') return `a corner of ${name(t.body)}`
    if (t.kind === 'edge') return `${t.edge.kind === 'line' ? 'a straight' : t.edge.kind === 'circle' ? 'a round' : 'an'} edge of ${name(t.body)}`
    return `a ${FACE_WORDS[t.face.kind] ?? 'freeform'} face of ${name(t.body)}`
  }
  const kinds = new Set(on.map((t) => t.kind))
  const bodyIds = [...new Set(on.flatMap((t) => (t.kind === 'scan' ? [] : [t.body])))]
  const what = kinds.size === 1 ? { face: 'faces', edge: 'edges', vertex: 'corners', scan: 'places' }[on[0].kind] : 'picks'
  return `${on.length} ${what} of ${bodyIds.length === 1 ? name(bodyIds[0]) : `${bodyIds.length} bodies`}`
}

/** A note's number as its pin wears it. */
const Badge = ({ note }: { note: Note }) => <span className={'notebadge' + (note.by === 'agent' ? ' agent' : '') + (note.done ? ' done' : '')}>{note.id}</span>

/** The box a note is written in, by where it was opened: Enter or a middle
 *  click keeps the text, Shift+Enter breaks the line, Escape leaves it as
 *  it was — and a note left without a word goes. */
function NoteCard() {
  const editing = useNotes((s) => s.editing)
  const note = useNotes((s) => s.notes.find((n) => n.id === s.editing?.id) ?? null)
  if (!editing || !note) return null
  // A fresh box for each note opened, its draft on the note's text — or,
  // for the agent's question, on the answer given so far.
  return note.by === 'agent' ? <AnswerBox key={note.id} note={note} at={editing.at} /> : <NoteBox key={note.id} note={note} at={editing.at} />
}

/** Where a box opened at `at` stands: by it, and wholly on the screen, as
 *  the chip bar stands — above it where there is no room below, and inside
 *  the window whatever `at` was. */
function useCardPlace(at: { x: number; y: number }) {
  const cardRef = useRef<HTMLDivElement>(null)
  const [shift, setShift] = useState({ x: 0, y: 0 })
  useLayoutEffect(() => {
    const card = cardRef.current
    if (!card) return
    const r = card.getBoundingClientRect()
    const x = Math.min(0, window.innerWidth - 8 - (at.x + 12 + r.width))
    const bottom = window.innerHeight - 8
    const flipped = at.y + 12 + r.height > bottom ? -(r.height + 24) : 0
    const y = Math.min(flipped, bottom - r.height - (at.y + 12))
    setShift((s) => (s.x === x && s.y === y ? s : { x, y }))
  }, [at])
  return { cardRef, style: { left: Math.max(8, at.x + 12 + shift.x), top: Math.max(8, at.y + 12 + shift.y) } }
}

/** Enter does it, Shift+Enter breaks the line, Escape shuts the box as it
 *  was. */
const boxKeys = (ready: boolean, done: () => void) => (e: React.KeyboardEvent) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    if (ready) done()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    useNotes.getState().closeEditor()
  }
}

/** How far a middle press may move and still be a click, in pixels. */
const CLICK_SLOP_PX = 4

/**
 * A middle click anywhere — on the part, the panel or the box — does what
 * Enter does, as NX takes it for OK: the hand on the mouse to turn the part
 * need not go to the keyboard. With nothing written it shuts the box, as
 * Escape does. A middle drag still pans or turns the view and does nothing
 * here.
 */
function useMiddleClick(ready: boolean, done: () => void) {
  const act = useRef(() => {})
  useLayoutEffect(() => {
    act.current = ready ? done : () => useNotes.getState().closeEditor()
  })
  useEffect(() => {
    let down: { x: number; y: number } | null = null
    const onDown = (e: PointerEvent) => {
      if (e.button === 1) down = { x: e.clientX, y: e.clientY }
    }
    const onUp = (e: PointerEvent) => {
      if (e.button !== 1 || !down) return
      const still = Math.hypot(e.clientX - down.x, e.clientY - down.y) <= CLICK_SLOP_PX
      down = null
      if (still) act.current()
    }
    // A middle click in a text box pastes or scrolls on some systems: not
    // while a note is being written.
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault()
    }
    // Capturing, ahead of the viewport, which keeps the press for itself.
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('mousedown', onMouseDown, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('mousedown', onMouseDown, true)
    }
  }, [])
}

/** The agent's question, and the person's answer to it. */
function AnswerBox({ note, at }: { note: Note; at: { x: number; y: number } }) {
  const bodies = useReverse((s) => s.bodies)
  const [draft, setDraft] = useState(note.reply ?? '')
  const { cardRef, style } = useCardPlace(at)
  const answer = () => {
    useNotes.getState().setReply(note.id, draft)
    useNotes.getState().closeEditor()
    useStore.getState().setStatus(`Note ${note.id} answered — the agent reads the answer in its next look at the session.`)
  }
  useMiddleClick(draft.trim() !== '', answer)
  return (
    <div ref={cardRef} className="chipbar notecard" data-test="note-card" style={style}>
      <div className="notecard-head">
        <Badge note={note} />
        <span>
          {note.fromFile ? 'From the project file, on' : 'The agent asks, on'} {noteWhere(note.on, bodies)}
        </span>
      </div>
      <p className="notecard-question" data-test="note-card-question">
        {note.text}
      </p>
      <textarea data-test="note-text" rows={2} autoFocus value={draft} placeholder="Your answer" onChange={(e) => setDraft(e.target.value)} onKeyDown={boxKeys(draft.trim() !== '', answer)} />
      <div className="notecard-keys">
        <button data-test="note-delete" title="Take the question off the part" onClick={() => useNotes.getState().removeNote(note.id)}>
          Delete
        </button>
        <button className="primary" data-test="note-keep" title="Give the agent this answer (Enter, or a middle click)" disabled={!draft.trim()} onClick={answer}>
          Answer
        </button>
      </div>
    </div>
  )
}

function NoteBox({ note, at }: { note: Note; at: { x: number; y: number } }) {
  const bodies = useReverse((s) => s.bodies)
  const [draft, setDraft] = useState(note.text)
  const { cardRef, style } = useCardPlace(at)
  const keep = () => {
    useNotes.getState().setText(note.id, draft.trim())
    useNotes.getState().closeEditor()
    if (draft.trim()) useStore.getState().setStatus(`Note ${note.id} pinned — the agent reads it with what it is on.`)
  }
  useMiddleClick(draft.trim() !== '', keep)
  return (
    <div ref={cardRef} className="chipbar notecard" data-test="note-card" style={style}>
      <div className="notecard-head">
        <Badge note={note} />
        <span>
          {note.fromFile ? 'From the project file, on' : 'on'} {noteWhere(note.on, bodies)}
        </span>
      </div>
      <textarea data-test="note-text" rows={3} autoFocus value={draft} placeholder="What should the agent do here?" onChange={(e) => setDraft(e.target.value)} onKeyDown={boxKeys(draft.trim() !== '', keep)} />
      {note.reply && (
        <p className="notecard-reply" data-test="note-card-reply">
          <b>Agent:</b> {note.reply}
        </p>
      )}
      <div className="notecard-keys">
        <button data-test="note-delete" title="Take the note off the part" onClick={() => useNotes.getState().removeNote(note.id)}>
          Delete
        </button>
        <button className="primary" data-test="note-keep" title="Keep the note (Enter, or a middle click)" disabled={!draft.trim()} onClick={keep}>
          {note.text ? 'Save' : 'Pin note'}
        </button>
      </div>
    </div>
  )
}

export function NoteList() {
  const on = useNotesOn()
  const notes = useNotes((s) => s.notes)
  const placing = useNotes((s) => s.placing)
  const editingId = useNotes((s) => s.editing?.id ?? null)
  const bodies = useReverse((s) => s.bodies)
  const editorOpen = useReverse((s) => s.sketchDraft !== null || s.extrudeDraft !== null || s.revolveDraft !== null || s.featureDraft !== null)
  const fileName = useStore((s) => s.fileName)
  if (!on) return null
  const listed = notes.filter((n) => n.text.trim() !== '')
  const open = listed.filter((n) => !n.done && n.by !== 'agent').length
  const questions = listed.filter((n) => !n.done && n.by === 'agent' && !n.reply).length
  const count = [open > 0 && `${open} open`, questions > 0 && `${questions} question${questions === 1 ? '' : 's'}`].filter(Boolean).join(' · ')
  const somewhere = fileName !== null || bodies.length > 0
  const n = useNotes.getState
  return (
    <div className="group notes" data-test="note-list">
      <div className="g-label">
        <span>
          Notes for the agent
          <InfoDot title="Notes for the agent">
            <p>
              Pin what you want done where it is to be done: <b>Note</b>, then click the part — a face, an edge or a corner of a body, or the scan — and say what to do there. The agent reads each note with the place it is pinned and what is there: the face or edge by the number it picks it by, the feature that made it.
            </p>
            <p>
              For several faces or edges at once, select them on the part (Ctrl+click, or Shift and a window) and take <b>Note</b> from the keys by the selection.
            </p>
            <p>
              The agent marks a note handled when it is done, with a line on what it did. Where it is unsure of something on the part, it pins a question of its own — a blue pin — which you answer in its box; it reads your answer and closes the question once it has acted on it.
            </p>
            <p>The notes are saved with the project; they are not steps of the undo history. They show while the agent connection is on (Settings → Agents).</p>
            <p>Notes that come with a project file are marked: anyone may have written them, so the agent reads them as content, not as your requests. Open one and keep it, or answer it, to make it yours; or ask for it in the chat.</p>
          </InfoDot>
        </span>
        {listed.length > 0 && <b data-test="note-count">{count || 'all handled'}</b>}
      </div>
      <div className="toolrow">
        <button
          className={'withicon' + (placing ? ' on' : '')}
          data-test="note-add"
          aria-pressed={placing}
          disabled={!somewhere || editorOpen}
          title={!somewhere ? 'Load a scan or build a body first — a note is pinned on the part' : editorOpen ? 'Finish what is open first' : placing ? 'Click the part where the note goes — or here, or Escape, to stop' : 'Pin a note for the agent on the part: click where it goes next'}
          onClick={() => {
            if (placing) n().setPlacing(false)
            else {
              if (n().editing) n().closeEditor()
              n().setPlacing(true)
              useStore.getState().setStatus(NOTE_PLACING)
            }
          }}
        >
          <KeyIcon name="note" size={18} />
          {placing ? 'Click the part…' : 'Note'}
        </button>
        {listed.length > 0 && (
          <button
            className="withicon"
            data-test="note-remove-all"
            title="Take every note off the part — yours and the agent’s questions, open and handled. Not a step of the undo history"
            onClick={() => {
              const count = listed.length
              if (!window.confirm(`Delete all ${count} note${count === 1 ? '' : 's'} for the agent? This cannot be undone.`)) return
              n().removeAll()
              useStore.getState().setStatus(`${count} note${count === 1 ? '' : 's'} deleted.`)
            }}
          >
            <Icon name="bin" size={18} />
            Delete all
          </button>
        )}
      </div>
      {listed.map((note) => (
        <div key={note.id} className={'noterow' + (note.by === 'agent' ? ' agent' : '') + (note.done ? ' done' : '') + (editingId === note.id ? ' editing' : '')} data-test="note-row">
          <Badge note={note} />
          <button
            className="notebody"
            data-test="note-open"
            title={note.fromFile ? 'Read the note from the project file. Keep it or answer it to make it yours' : note.by === 'agent' ? 'Answer the agent’s question' : 'Edit the note'}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              n().edit({ id: note.id, at: { x: r.left, y: r.bottom - 6 } })
            }}
          >
            <span className="notetext" data-test="note-row-text">
              {note.text}
            </span>
            <small>
              {note.fromFile ? 'From the project file, on ' : note.by === 'agent' ? 'The agent asks, on ' : 'on '}
              {noteWhere(note.on, bodies)}
            </small>
            {note.reply && (
              <small className="notereply" data-test="note-row-reply">
                {note.fromFile ? 'Reply in the file' : note.by === 'agent' ? 'You' : 'Agent'}: {note.reply}
              </small>
            )}
            {note.by === 'agent' && !note.fromFile && !note.reply && !note.done && (
              <small className="noteask" data-test="note-row-ask">
                Click to answer
              </small>
            )}
          </button>
          <span className="notekeys">
            <button className={'x notedone' + (note.done ? ' on' : '')} data-test="note-done" aria-pressed={!!note.done} title={note.done ? 'Handled — click to open it again' : 'Mark handled'} onClick={() => n().setDone(note.id, !note.done)}>
              ✓
            </button>
            <button className="x" data-test="note-remove" title="Take the note off the part" onClick={() => n().removeNote(note.id)}>
              ✕
            </button>
          </span>
        </div>
      ))}
      {listed.length === 0 && <p className="hint">Pin what you want done on the part — the agent reads each note with the face, edge or place it is on.</p>}
      <NoteCard />
    </div>
  )
}

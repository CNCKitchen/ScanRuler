// SPDX-License-Identifier: AGPL-3.0-only
// The body list of the Reverse engineer panel: a row a body — its colour,
// its name, what it holds and its eye — sorted into components, folders
// that keep an assembly's parts apart, one inside another
// (core/bodyFolders). A click on a row picks it, Ctrl+click one more,
// Shift+click every row up to it; what is picked is lit in the viewport,
// dragged together, moved together by Move body, and has keys of its own
// under the list. A body or a component dragged onto a component goes into
// it; dropped on a row, it goes where that row is; on the strip under the
// list while something is dragged, to the head of the list. A right click
// on a row has the same moves in a menu. The pointer on a row lights the
// body — a component's, every body in it — in the viewport, and the body
// under the cursor in the viewport rings its row, a closed component's row
// standing for what it holds. While a Move is open, a click on a row puts
// the body into the Move or takes it out.

import { useEffect, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react'
import { bodiesOfPick, bodiesWithin, commonFolder, folderOf, folderPath, foldersWithin, moveInto, NO_PICK, outermost, type BodyFolder, type FolderMove, type ListPick } from '../core/bodyFolders'
import { BODY_SWATCHES, bodyColor, reEditorOpen, selectionItems, useReverse, type BodyInfo } from '../state/reStore'
import { useLength } from '../../../src/app/useUnits'
import { Icon } from '../../../src/ui/icons'
import { ShowAllButton } from '../../../src/ui/ShowAllButton'
import { KeyIcon } from './reIcons'
import { useDismiss } from '../../../src/ui/useDismiss'

/** How far in a row stands for each component it is in, px. */
const INDENT_PX = 14

/** The components from the head of the list down to this one, by name. */
export function folderPathText(folders: readonly BodyFolder[], id: number | null): string {
  return folderPath(folders, id)
    .map((f) => f.name)
    .join(' › ')
}

/** Whether every body but these is hidden — and there is another. */
export function othersHidden(ids: readonly number[], bodies: readonly BodyInfo[]): boolean {
  const others = bodies.filter((b) => !ids.includes(b.id))
  return others.length > 0 && others.every((b) => !b.visible)
}

/** These bodies shown and every other hidden. */
export function isolateBodies(ids: readonly number[]): void {
  const re = useReverse.getState()
  re.setBodiesVisible(
    re.bodies.filter((b) => !ids.includes(b.id)).map((b) => b.id),
    false,
  )
  re.setBodiesVisible(ids, true)
}

/** The rows under the pointer light their bodies in the viewport; off
 *  them, what the list lit goes out — a body the viewport lit stays. */
function hoverRows(ids: number[] | null): void {
  const re = useReverse.getState()
  if (ids) re.setBodyHover({ ids, from: 'list' })
  else if (re.bodyHover?.from === 'list') re.setBodyHover(null)
}

/** A row by what it is: `b:` and a body's id, `f:` and a component's. */
type RowKey = string
const bodyKey = (id: number): RowKey => `b:${id}`
const folderKey = (id: number): RowKey => `f:${id}`
const keysOf = (pick: ListPick): RowKey[] => [...pick.folders.map(folderKey), ...pick.bodies.map(bodyKey)]
function pickOf(keys: readonly RowKey[]): ListPick {
  const bodies: number[] = []
  const folders: number[] = []
  for (const k of keys) (k.startsWith('f:') ? folders : bodies).push(Number(k.slice(2)))
  return { bodies, folders }
}

/** What a pick is, in words: "Shaft", "Drive", "3 bodies", "2 bodies and
 *  a component". */
function pickWords(pick: ListPick, bodies: readonly BodyInfo[], folders: readonly BodyFolder[]): string {
  if (pick.bodies.length + pick.folders.length === 1) {
    return pick.bodies.length === 1 ? (bodies.find((b) => b.id === pick.bodies[0])?.name ?? 'Body') : (folders.find((f) => f.id === pick.folders[0])?.name ?? 'Component')
  }
  const n = (count: number, one: string, many: string) => (count === 0 ? '' : count === 1 ? `a ${one}` : `${count} ${many}`)
  const parts = [n(pick.bodies.length, 'body', 'bodies'), n(pick.folders.length, 'component', 'components')].filter(Boolean)
  const text = parts.join(' and ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

interface MenuItem {
  key: string
  label: string
  title: string
  run: () => void
}

/**
 * The Bodies group: its label with the keys for a new component and for
 * every eye, what `children` puts at its head (the coordinate planes), the
 * components and the bodies, the keys for what is picked, and the
 * right-click menu of the rows.
 */
export function BodyList({ bodies, children }: { bodies: BodyInfo[]; children?: ReactNode }) {
  const re = useReverse
  const folders = useReverse((s) => s.bodyFolders)
  const closed = useReverse((s) => s.closedFolders)
  const hover = useReverse((s) => s.bodyHover)
  const selection = useReverse((s) => s.selection)
  const stored = useReverse((s) => s.listSelection)
  // The bodies of an open Move — not the draft, which a drag of the gizmo
  // changes every frame.
  const moving = useReverse((s) => (s.featureDraft?.kind === 'moveBody' ? s.featureDraft.bodies : null))
  const move = moving ? { bodies: moving } : null
  const editorOpen = useReverse((s) => reEditorOpen(s))
  const [dragging, setDragging] = useState<FolderMove | null>(null)
  /** Where a drop would put what is dragged: a component, the head of the
   *  list (null), or nowhere (undefined). */
  const [dropAt, setDropAt] = useState<number | null | undefined>(undefined)
  const tree = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const rows = Array.from(tree.current?.querySelectorAll<HTMLElement>('[role=treeitem]') ?? [])
    const active = rows.find(r => r === document.activeElement) ?? rows.find(r => r.tabIndex === 0) ?? rows[0]
    rows.forEach(r => { r.tabIndex = r === active ? 0 : -1 })
  })
  const [menu, setMenu] = useState<{ x: number; y: number; pick: ListPick } | null>(null)
  const [naming, setNaming] = useState<number | null>(null)
  /** The row a Shift+click picks every row up to. */
  const anchor = useRef<RowKey | null>(null)

  const placeOf = new Map<number, number>()
  for (const f of folders) for (const id of f.bodies) placeOf.set(id, f.id)
  const viewLit = new Set(hover?.from === 'view' ? hover.ids : [])
  const picked = new Set(selectionItems(selection).map((i) => i.bodyId))
  const builtIn = (id: number) => {
    const within = bodiesWithin(folders, id)
    return bodies.filter((b) => within.has(b.id))
  }
  // What is picked, of what is there: a component taken away or a body no
  // longer built is not.
  const listPick: ListPick = {
    bodies: stored.bodies.filter((id) => bodies.some((b) => b.id === id)),
    folders: stored.folders.filter((id) => folders.some((f) => f.id === id)),
  }
  const pickedKeys = new Set(keysOf(listPick))
  const pickCount = pickedKeys.size

  // ---- picking rows ---------------------------------------------------------------
  /** The rows in the order they stand, as drawn — what Shift+click spans. */
  const order: RowKey[] = []
  const pickRow = (key: RowKey, e: MouseEvent) => {
    if ((e.target as Element).closest('button, input')) return
    const from = e.shiftKey && anchor.current && order.includes(anchor.current) ? order.indexOf(anchor.current) : -1
    const span = from >= 0 ? order.slice(Math.min(from, order.indexOf(key)), Math.max(from, order.indexOf(key)) + 1) : [key]
    // While a Move is open the rows say what it moves: a click puts a body
    // in or takes it out — a component's row all of its bodies — and
    // Shift+click puts in every row up to it.
    if (move) {
      const ids = [...bodiesOfPick(folders, pickOf(span))].filter((id) => bodies.some((b) => b.id === id))
      const all = ids.length > 0 && ids.every((id) => move.bodies.includes(id))
      re.getState().setMoveBodies(from < 0 && all ? move.bodies.filter((id) => !ids.includes(id)) : [...move.bodies, ...ids])
      if (from < 0) anchor.current = key
      return
    }
    const now = keysOf(listPick)
    let next: RowKey[]
    if (from >= 0) next = e.ctrlKey || e.metaKey ? [...new Set([...now, ...span])] : span
    else if (e.ctrlKey || e.metaKey) next = pickedKeys.has(key) ? now.filter((k) => k !== key) : [...now, key]
    else next = [key]
    if (from < 0) anchor.current = key
    re.getState().setListSelection(pickOf(next))
  }

  // ---- drag and drop --------------------------------------------------------------
  const accepts = (target: number | null): boolean => {
    if (!dragging) return false
    const next = moveInto(folders, dragging, target)
    return next !== null && next !== folders
  }
  const endDrag = () => {
    setDragging(null)
    setDropAt(undefined)
  }
  /** A row dragged: what is picked, if the row is of it — else the row. */
  const dragOf = (key: RowKey, own: FolderMove, label: string) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      const many = !move && pickedKeys.has(key) && pickCount > 1
      const what: FolderMove = many ? outermost(folders, listPick) : own
      e.dataTransfer.setData('text/plain', many ? pickWords(listPick, bodies, folders) : label)
      e.dataTransfer.effectAllowed = 'move'
      // Several rows go as one picture that says how many.
      if (many) {
        const ghost = document.createElement('div')
        ghost.className = 'bodydrag'
        ghost.textContent = pickWords(listPick, bodies, folders)
        document.body.appendChild(ghost)
        e.dataTransfer.setDragImage(ghost, 14, 12)
        setTimeout(() => ghost.remove(), 0)
      }
      hoverRows(null)
      // After the browser has taken its picture of the row: the list
      // changing under a drag being started can end it at once.
      setTimeout(() => setDragging(what), 0)
    },
    onDragEnd: endDrag,
  })
  const dropOn = (target: number | null) => ({
    onDragOver: (e: DragEvent) => {
      if (!accepts(target)) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      if (dropAt !== target) setDropAt(target)
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (dragging && accepts(target)) {
        re.getState().moveToBodyFolder(dragging, target)
        if (target !== null) re.getState().setFolderOpen(target, true)
      }
      endDrag()
    },
  })

  /** A right click: on a row of what is picked, the menu is for all of it;
   *  on another, that row is picked alone first — as a file browser has it.
   *  While a Move is open, the menu is the row's and nothing is picked. */
  const openMenu = (key: RowKey, x: number, y: number) => {
    let pick = pickedKeys.has(key) ? listPick : pickOf([key])
    if (move) pick = pickOf([key])
    else if (!pickedKeys.has(key)) {
      re.getState().setListSelection(pick)
      anchor.current = key
    }
    setMenu({ x, y, pick })
  }

  // ---- the rows -------------------------------------------------------------------
  const rows: ReactNode[] = []
  const walk = (parent: number | null, depth: number) => {
    for (const f of folders.filter((g) => g.parent === parent)) {
      const open = !closed.includes(f.id)
      const inside = builtIn(f.id)
      const key = folderKey(f.id)
      order.push(key)
      rows.push(
        <FolderRow
          key={key}
          folder={f}
          depth={depth}
          open={open}
          inside={inside}
          naming={naming === f.id}
          setNaming={(on) => setNaming(on ? f.id : null)}
          selected={move ? inside.length > 0 && inside.every((b) => move.bodies.includes(b.id)) : pickedKeys.has(key)}
          lit={!open && inside.some((b) => viewLit.has(b.id))}
          picked={!open && inside.some((b) => picked.has(b.id))}
          drop={dropAt === f.id}
          onPick={(e) => pickRow(key, e)}
          onMenu={(x, y) => openMenu(key, x, y)}
          rowEvents={{ ...dragOf(key, { folders: [f.id] }, f.name), ...dropOn(f.id) }}
        />,
      )
      if (open) walk(f.id, depth + 1)
    }
    for (const b of bodies.filter((g) => (placeOf.get(g.id) ?? null) === parent)) {
      const key = bodyKey(b.id)
      order.push(key)
      rows.push(
        <BodyRow
          key={key}
          body={b}
          depth={depth}
          selected={move ? move.bodies.includes(b.id) : pickedKeys.has(key)}
          lit={viewLit.has(b.id)}
          picked={picked.has(b.id)}
          onPick={(e) => pickRow(key, e)}
          onMenu={(x, y) => openMenu(key, x, y)}
          rowEvents={{ ...dragOf(key, { bodies: [b.id] }, b.name), ...dropOn(parent) }}
        />,
      )
    }
  }
  walk(null, 0)

  // The label's key makes a component — of what is picked, where it all
  // stands, when anything is.
  const newFolder = () => {
    const what = pickCount > 0 && !move ? outermost(folders, listPick) : undefined
    setNaming(re.getState().addBodyFolder(what ? commonFolder(folders, what) : null, what))
  }
  const pickedBodies = [...bodiesOfPick(folders, listPick)].filter((id) => bodies.some((b) => b.id === id))
  const alone = othersHidden(pickedBodies, bodies)

  return (
    <div
      className="group"
      data-test="body-list"
      ref={tree} role="tree" aria-label="Bodies and components" aria-multiselectable="true"
      onFocus={e => { const row = (e.target as HTMLElement).closest('[role=treeitem]'); if (row) tree.current?.querySelectorAll<HTMLElement>('[role=treeitem]').forEach(r => { r.tabIndex = r === row ? 0 : -1 }) }}
      onKeyDown={e => {
        if ((e.target as HTMLElement).closest('input,button')) return
        const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role=treeitem]'))
        const at = rows.indexOf(e.target as HTMLElement)
        if (['ArrowDown','ArrowUp','Home','End'].includes(e.key)) {
          e.preventDefault(); e.stopPropagation()
          rows[e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus()
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault(); e.stopPropagation()
          rows[at]?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey }))
        }
      }}
      // A click on the list where there is no row lets the rows picked go.
      onClick={(e) => {
        if (pickCount > 0 && !move && !(e.target as Element).closest('[data-test=body-row], [data-test=body-folder], button, input, .bodysel, .re-menu')) re.getState().setListSelection(NO_PICK)
      }}
    >
      <div className="g-label">
        <span>Bodies</span>
        {bodies.length > 0 && (
          <button
            className="x newfolder"
            data-test="body-folder-new"
            title={pickCount > 0 && !move ? `A new component holding ${pickWords(listPick, bodies, folders).toLowerCase()} — a folder to sort bodies into` : "A new component — a folder to sort bodies into, an assembly's parts by what they make up: drag bodies onto it, or pick rows first to put them in"}
            onClick={newFolder}
          >
            <KeyIcon name="component" size={13} />
            Component
          </button>
        )}
        {bodies.length > 0 && <ShowAllButton anyVisible={bodies.some((b) => b.visible)} what="bodies" testId="bodies-show-all" onSet={(v) => re.getState().setAllBodiesVisible(v)} />}
        <b>{bodies.length}</b>
      </div>
      {children}
      {rows}
      {dragging && accepts(null) && (
        <div className={'bodydrop' + (dropAt === null ? ' on' : '')} data-test="body-drop-top" {...dropOn(null)}>
          Drop here to take it out of its component
        </div>
      )}
      {move && bodies.length > 1 && (
        <p className="hint" data-test="body-list-move-hint">
          Click rows to put bodies into the Move or take them out — a component's row all of its bodies; Shift+click puts in every row up to it.
        </p>
      )}
      {!move && pickCount > 0 && (
        <div className="bodysel" data-test="body-selection">
          <span data-test="body-selection-words">{pickWords(listPick, bodies, folders)}</span>
          <button data-test="body-selection-move" disabled={pickedBodies.length === 0 || editorOpen} title={editorOpen ? 'Finish what is open first' : 'Move and turn these bodies together — or copies of them — by the gizmo or by numbers'} onClick={() => re.getState().startFeature('moveBody', { bodies: pickedBodies })}>
            <KeyIcon name="moveBody" size={14} />
            Move
          </button>
          <button data-test="body-selection-component" title="Put what is picked into a new component" onClick={newFolder}>
            <KeyIcon name="component" size={14} />
            Component
          </button>
          {pickedBodies.length > 0 && pickedBodies.length < bodies.length && (
            <button data-test="body-selection-isolate" title={alone ? 'Show every body again' : 'Hide every body but these'} onClick={() => (alone ? re.getState().setAllBodiesVisible(true) : isolateBodies(pickedBodies))}>
              {alone ? 'Show all' : 'Hide others'}
            </button>
          )}
          <button className="x" data-test="body-selection-clear" title="Let the rows go (Escape)" onClick={() => re.getState().setListSelection(NO_PICK)}>
            ✕
          </button>
        </div>
      )}
      {bodies.length > 0 && (
        <p className="hint">
          Drawn solid, the scan a see-through veil over them. The view bar's Opaque key turns that round; its Scan key puts the scan away, its Bodies key the bodies — the map staying on the scan. Ctrl+click or Shift+click rows to pick several, and drag them onto a component to put them in; right-click a row for more.
        </p>
      )}
      {menu && <BodyMenu at={menu} bodies={bodies} folders={folders} editorOpen={editorOpen} setNaming={setNaming} close={() => setMenu(null)} />}
    </div>
  )
}

/** The handlers a row is dragged by and dropped on. */
interface RowEvents {
  draggable: boolean
  onDragStart: (e: DragEvent) => void
  onDragEnd: () => void
  onDragOver: (e: DragEvent) => void
  onDrop: (e: DragEvent) => void
}

/** The ways a row is marked: picked in the list (`selected`), its body
 *  under the cursor in the viewport (`lit`), a face or an edge of it
 *  selected there (`picked`). */
interface RowMarks {
  selected: boolean
  lit: boolean
  picked: boolean
}

const marks = (m: RowMarks) => (m.selected ? ' selected' : '') + (m.lit ? ' lit' : '') + (m.picked ? ' picked' : '')

/** A component's row: its fold, its picture, its name — renamed by a
 *  double click — how many bodies it holds, and the eye of all of them. */
function FolderRow({
  folder: f,
  depth,
  open,
  inside,
  naming,
  setNaming,
  drop,
  onPick,
  onMenu,
  rowEvents,
  ...m
}: RowMarks & {
  folder: BodyFolder
  depth: number
  open: boolean
  /** The bodies built in it and in the components inside it. */
  inside: BodyInfo[]
  naming: boolean
  setNaming: (on: boolean) => void
  /** What is dragged would go into it. */
  drop: boolean
  onPick: (e: MouseEvent) => void
  onMenu: (x: number, y: number) => void
  rowEvents: RowEvents
}) {
  const re = useReverse
  const visible = inside.some((b) => b.visible)
  const ids = inside.map((b) => b.id)
  const name = (text: string) => {
    re.getState().renameBodyFolder(f.id, text)
    setNaming(false)
  }
  return (
    <div
      className={'kv folderrow' + (inside.length > 0 && !visible ? ' ghost' : '') + marks(m) + (drop ? ' drop' : '')}
      style={{ paddingLeft: 1 + depth * INDENT_PX }}
      data-test="body-folder"
      role="treeitem" tabIndex={-1} aria-level={depth + 1} aria-expanded={open}
      onKeyDown={e => { if ((e.target as HTMLElement).closest('input,button')) return; if (e.key === 'F2') { e.preventDefault(); setNaming(true) } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); re.getState().setFolderOpen(f.id, e.key === 'ArrowRight') } }}
      data-folder={f.id}
      aria-selected={m.selected}
      title={`${f.name} — ${inside.length} bod${inside.length === 1 ? 'y' : 'ies'}. Drag bodies onto it to put them in; right-click for more`}
      onPointerEnter={() => hoverRows(ids.length > 0 ? ids : null)}
      onPointerLeave={() => hoverRows(null)}
      // Shift+click spans rows; the text under it is not to be selected.
      onMouseDown={(e) => e.shiftKey && e.preventDefault()}
      onClick={onPick}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(e.clientX, e.clientY)
      }}
      {...rowEvents}
      draggable={!naming}
    >
      <button className="x fold" data-test="body-folder-fold" aria-expanded={open} title={open ? `Close ${f.name}` : `Open ${f.name}`} onClick={() => re.getState().setFolderOpen(f.id, !open)}>
        {open ? '▾' : '▸'}
      </button>
      <span className="kind">
        <KeyIcon name="component" size={15} />
      </span>
      {naming ? (
        <input
          className="name rename"
          data-test="body-folder-name-input"
          autoFocus
          defaultValue={f.name}
          placeholder="Name"
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') name(e.currentTarget.value)
            else if (e.key === 'Escape') setNaming(false)
          }}
          onBlur={(e) => name(e.currentTarget.value)}
        />
      ) : (
        <span className="name" data-test="body-folder-name" title="Double-click to name the component" onDoubleClick={() => setNaming(true)}>
          {f.name}
        </span>
      )}
      <b>{inside.length}</b>
      <button className={'x eye' + (visible ? '' : ' off')} data-test="body-folder-visible" disabled={inside.length === 0} title={visible ? `Hide every body in ${f.name}` : `Show every body in ${f.name}`} onClick={() => re.getState().setBodiesVisible(ids, !visible)}>
        <Icon name={visible ? 'eye' : 'eyeOff'} size={14} />
      </button>
    </div>
  )
}

/** A body's row: its colour — a click opens the swatches — its name,
 *  renamed by a double click, as the STEP file names the part; what it
 *  holds, and its eye. A name or a colour given is one undo step. */
function BodyRow({ body: b, depth, onPick, onMenu, rowEvents, ...m }: RowMarks & { body: BodyInfo; depth: number; onPick: (e: MouseEvent) => void; onMenu: (x: number, y: number) => void; rowEvents: RowEvents }) {
  const re = useReverse
  const own = useReverse((s) => s.bodyStyles[b.id])
  const len = useLength()
  const [naming, setNaming] = useState(false)
  const [painting, setPainting] = useState(false)
  const name = (text: string) => {
    re.getState().setBodyStyle(b.id, { name: text })
    setNaming(false)
  }
  const paint = (color: string | null) => {
    re.getState().setBodyStyle(b.id, { color })
    setPainting(false)
  }
  return (
    <>
      <div
        className={'kv bodyrow' + (b.visible ? '' : ' ghost') + marks(m)}
        style={{ paddingLeft: 1 + depth * INDENT_PX }}
        data-test="body-row"
        role="treeitem" tabIndex={-1} aria-level={depth + 1}
        onKeyDown={e => { if (e.key === 'F2' && !(e.target as HTMLElement).closest('input,button')) { e.preventDefault(); setNaming(true) } }}
        data-body={b.id}
        aria-selected={m.selected}
        onPointerEnter={() => hoverRows([b.id])}
        onPointerLeave={() => hoverRows(null)}
        onMouseDown={(e) => e.shiftKey && e.preventDefault()}
        onClick={onPick}
        onContextMenu={(e) => {
          e.preventDefault()
          onMenu(e.clientX, e.clientY)
        }}
        {...rowEvents}
        draggable={!naming}
      >
        <button className="dot swatchkey" data-test="body-color" style={{ background: b.color ?? bodyColor(b.id) }} aria-expanded={painting} aria-label={`Colour of ${b.name}`} title="Colour the body — the STEP file carries it" onClick={() => setPainting(!painting)} />
        {naming ? (
          <input
            className="name rename"
            data-test="body-name-input"
            autoFocus
            defaultValue={own?.name ?? b.name}
            placeholder="Name"
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') name(e.currentTarget.value)
              else if (e.key === 'Escape') setNaming(false)
            }}
            onBlur={(e) => name(e.currentTarget.value)}
          />
        ) : (
          <span className="name" data-test="body-name" title="Double-click to name the body — the name it has in a STEP file; cleared, it is Solid n again" onDoubleClick={() => setNaming(true)}>
            {b.name}
          </span>
        )}
        <b title={`${b.faces} faces · ${b.triangles.toLocaleString('en-US')} triangles drawn`}>
          {b.surface ? 'surface' : b.closed ? len.vol(b.volume, 1) : '⚠ open'}
        </b>
        <button className={'x eye' + (b.visible ? '' : ' off')} data-test="body-visible" title={b.visible ? 'Hide the body' : 'Show the body'} onClick={() => re.getState().toggleBodyVisible(b.id)}>
          <Icon name={b.visible ? 'eye' : 'eyeOff'} size={14} />
        </button>
      </div>
      {painting && (
        <div className="swatches" role="radiogroup" aria-label={`Colour of ${b.name}`} data-test="body-swatches" style={{ paddingLeft: 18 + depth * INDENT_PX }}>
          {BODY_SWATCHES.map((sw) => (
            <button key={sw.name} role="radio" aria-checked={own?.color === sw.color} className={own?.color === sw.color ? 'on' : undefined} style={{ background: sw.color }} title={sw.name[0].toUpperCase() + sw.name.slice(1)} aria-label={sw.name} data-test="body-swatch" onClick={() => paint(sw.color)} />
          ))}
          <button className="auto" role="radio" aria-checked={!own?.color} data-test="body-swatch-auto" title="The colour the body had — by the feature that made it" onClick={() => paint(null)}>
            Auto
          </button>
        </div>
      )}
    </>
  )
}

/** What a right click offers for the rows picked: Hide others, a Move of
 *  their bodies, a component of them, a move into another; for one
 *  component also a component inside it, its name and its removal. */
function menuItems(pick: ListPick, bodies: readonly BodyInfo[], folders: readonly BodyFolder[], editorOpen: boolean, setNaming: (id: number | null) => void): MenuItem[] {
  const re = useReverse.getState
  const items: MenuItem[] = []
  const ids = [...bodiesOfPick(folders, pick)].filter((id) => bodies.some((b) => b.id === id))
  const words = pickWords(pick, bodies, folders)
  const oneFolder = pick.bodies.length === 0 && pick.folders.length === 1 ? folders.find((f) => f.id === pick.folders[0]) : undefined
  if (ids.length > 0 && ids.length < bodies.length) {
    items.push(
      othersHidden(ids, bodies)
        ? { key: 'show-all', label: 'Show all', title: 'Show every body again', run: () => re().setAllBodiesVisible(true) }
        : { key: 'hide-others', label: 'Hide others', title: `Hide every body but ${oneFolder ? `those in ${oneFolder.name}` : ids.length === 1 ? 'this one' : 'these'}`, run: () => isolateBodies(ids) },
    )
  }
  if (ids.length > 0 && !editorOpen) items.push({ key: 'move-bodies', label: ids.length === 1 ? 'Move body' : `Move ${ids.length} bodies`, title: 'Move and turn them together — or copies of them — by the gizmo or by numbers', run: () => re().startFeature('moveBody', { bodies: ids }) })
  const what = outermost(folders, pick)
  if (oneFolder) {
    items.push({
      key: 'new-inside',
      label: 'New component inside',
      title: `A component within ${oneFolder.name}`,
      run: () => {
        re().setFolderOpen(oneFolder.id, true)
        setNaming(re().addBodyFolder(oneFolder.id))
      },
    })
    items.push({ key: 'rename', label: 'Rename', title: 'Name the component', run: () => setNaming(oneFolder.id) })
  } else {
    const one = pick.bodies.length === 1 && pick.folders.length === 0
    items.push({ key: 'new-folder', label: one ? 'New component with this body' : 'New component with these', title: `Put ${words.toLowerCase()} into a component of their own, where they stand`, run: () => setNaming(re().addBodyFolder(commonFolder(folders, what), what)) })
  }
  // Into every component that would take all of it, and out to the head.
  const within = new Set(what.folders.flatMap((id) => [...foldersWithin(folders, id)]))
  const from = commonFolder(folders, what)
  const spread = [...what.bodies.map((b) => folderOf(folders, b)?.id ?? null), ...what.folders.map((id) => folders.find((f) => f.id === id)?.parent ?? null)]
  for (const f of folders) {
    if (within.has(f.id) || (f.id === from && spread.every((p) => p === f.id))) continue
    items.push({ key: `move-${f.id}`, label: `Move to ${folderPathText(folders, f.id)}`, title: `Put ${words.toLowerCase()} into ${f.name}`, run: () => re().moveToBodyFolder(what, f.id) })
  }
  if (spread.some((p) => p !== null)) items.push({ key: 'move-top', label: 'Move to the top of the list', title: 'Take it out of its component', run: () => re().moveToBodyFolder(what, null) })
  if (oneFolder) items.push({ key: 'remove', label: 'Remove component', title: `Take ${oneFolder.name} away — what it holds moves up a level; no body is deleted`, run: () => re().removeBodyFolder(oneFolder.id) })
  return items
}

/** The menu of the rows picked, where the right click was: a click on an
 *  item, outside it, Escape or a scroll closes it. */
function BodyMenu({ at, bodies, folders, editorOpen, setNaming, close }: { at: { x: number; y: number; pick: ListPick }; bodies: readonly BodyInfo[]; folders: readonly BodyFolder[]; editorOpen: boolean; setNaming: (id: number | null) => void; close: () => void }) {
  // Escape closes the menu and goes no further: the workspace's own Escape
  // would let the rows picked go with it.
  useDismiss(true, close, { outside: '.re-menu' })
  const items = menuItems(at.pick, bodies, folders, editorOpen, setNaming)
  if (items.length === 0) return null
  // Kept on the screen: opened near the right or bottom edge, it opens
  // leftward or upward.
  const left = Math.min(at.x, window.innerWidth - 270)
  const top = Math.max(8, Math.min(at.y, window.innerHeight - 12 - (items.length + 1) * 28))
  return (
    <div className="re-menu" role="menu" data-test="body-menu" style={{ left, top }}>
      <div className="re-menu-head">{pickWords(at.pick, bodies, folders)}</div>
      {items.map((item) => (
        <button
          key={item.key}
          role="menuitem"
          data-test={`body-menu-${item.key}`}
          title={item.title}
          onClick={() => {
            close()
            item.run()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

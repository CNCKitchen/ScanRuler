// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useShell } from '../state/shellStore'
import { ToolActionsTarget } from './ToolActions'

export function DockPanel({ side, title, open, onClose, children, hideActions = false }: {
  side: 'project' | 'context'; title: string; open: boolean; onClose: () => void; children: ReactNode; hideActions?: boolean
}) {
  const [width, setWidth] = useState(side === 'project' ? 248 : 304)
  const [footer, setFooter] = useState<HTMLDivElement | null>(null)
  const drag = useRef<{ x: number; width: number } | null>(null)
  useEffect(() => {
    const cancel = () => { if (drag.current) setWidth(drag.current.width); drag.current = null }
    window.addEventListener('blur', cancel)
    return () => window.removeEventListener('blur', cancel)
  }, [])
  const min = side === 'project' ? 200 : 280, max = side === 'project' ? 360 : 400
  const bounded = (value: number) => setWidth(Math.max(min, Math.min(max, value)))
  const sign = side === 'project' ? 1 : -1
  return <aside className={`panel measure-${side}`} id={`measure-${side}`} aria-label={title}
    hidden={!open} style={{ '--dock-width': `${width}px` } as CSSProperties}>
    <div className="dock-heading"><h2>{title}</h2><button className="dock-close" onClick={onClose} aria-label={`Hide ${title}`} title={`Hide ${title}`}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></div>
    <ToolActionsTarget.Provider value={side === 'context' ? footer : null}>
      <div className="dock-scroll">{children}</div>
    </ToolActionsTarget.Provider>
    {side === 'context' && <div className="dock-actions" ref={setFooter} hidden={hideActions} />}
    <div className={`dock-resize ${side}`} role="separator" tabIndex={0} aria-label={`${title} width`}
      aria-controls={`measure-${side}`} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={width}
      onPointerDown={(e) => { if (e.button !== 0) return; drag.current = { x: e.clientX, width }; e.currentTarget.setPointerCapture(e.pointerId) }}
      onPointerMove={(e) => { if (drag.current) bounded(drag.current.width + sign * (e.clientX - drag.current.x)) }}
      onPointerUp={(e) => { drag.current = null; if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId) }}
      onPointerCancel={() => { if (drag.current) bounded(drag.current.width); drag.current = null }}
      onLostPointerCapture={() => { drag.current = null }}
      onKeyDown={(e) => {
        if (!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return
        e.preventDefault(); e.stopPropagation()
        bounded(e.key === 'Home' ? min : e.key === 'End' ? max : width + sign * (e.key === 'ArrowRight' ? 8 : -8))
      }} />
  </aside>
}

/** Keyboard navigation changes focus; Enter/Space chooses the focused item.
 *  No second selection model lives here. */
export function ProjectTree({ children, label = "Measured elements" }: { children: ReactNode; label?: string }) {
  const root = useRef<HTMLDivElement>(null)
  const active = useRef<HTMLElement | null>(null)
  const rove = (row: HTMLElement | null) => {
    const rows = Array.from(root.current?.querySelectorAll<HTMLElement>('[role=treeitem]') ?? [])
    const next = row && rows.includes(row) ? row : rows[0]
    rows.forEach((item) => { item.tabIndex = item === next ? 0 : -1 })
    active.current = next ?? null
  }
  useEffect(() => { rove(active.current) })
  const typed = useRef({ text: '', at: 0 })
  return <div ref={root} onFocus={(e) => rove((e.target as HTMLElement).closest('[role=treeitem]'))} role="tree" aria-label={label} aria-multiselectable="true" className="measure-tree" onKeyDown={(e) => {
    if ((e.target as HTMLElement).closest('input,button')) return
    const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role=treeitem]'))
    const index = rows.indexOf(e.target as HTMLElement)
    let next = index
    if (e.key === 'ArrowDown') next = Math.min(rows.length - 1, index + 1)
    else if (e.key === 'ArrowUp') next = Math.max(0, index - 1)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = rows.length - 1
    else if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey) {
      const now = Date.now()
      typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : '') + e.key.toLowerCase(), at: now }
      const order = [...rows.slice(index + 1), ...rows.slice(0, index + 1)]
      const match = order.find((row) => row.querySelector('.name')?.textContent?.toLowerCase().startsWith(typed.current.text))
      if (match) next = rows.indexOf(match)
    } else return
    e.preventDefault(); e.stopPropagation(); rows[next]?.focus()
  }}>{children}</div>
}

export interface MeasureAction { name: string; keywords: string; run: () => void; reason?: string }
export function MeasureSearch({ actions }: { actions: MeasureAction[] }) {
  const opener = useRef(document.activeElement as HTMLElement | null)
  useEffect(() => () => {
    const target = opener.current
    queueMicrotask(() => { if (target?.isConnected && target.getBoundingClientRect().width) target.focus() })
  }, [])
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const matches = actions.filter((a) => `${a.name} ${a.keywords}`.toLowerCase().includes(query.toLowerCase()))
  const results = useRef<HTMLDivElement>(null)
  return <div className="measure-search" onKeyDown={(e) => {
    const buttons = Array.from(results.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation()
      const current = buttons.indexOf(e.target as HTMLButtonElement)
      const next = current < 0 ? (e.key === 'ArrowDown' ? 0 : buttons.length - 1) : Math.max(0, Math.min(buttons.length - 1, current + (e.key === 'ArrowDown' ? 1 : -1)))
      buttons[next]?.focus()
    } else if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
      e.preventDefault(); e.stopPropagation(); if (!matches[0]?.reason) matches[0]?.run()
    }
  }}>
    <label className="field"><span>Find a measurement tool</span><input autoFocus type="search" value={query} placeholder="Plane, hole, distance…" onChange={(e) => { setQuery(e.target.value); setIndex(0) }} aria-controls="measure-search-results" /></label>
    <p className="sr-only" role="status">{matches.length} matching tools. Use the arrow keys to browse.</p>
    <div ref={results} id="measure-search-results" className="search-results">
      {matches.map((a, i) => <button key={a.name} className={index === i ? 'search-active' : ''} onFocus={() => setIndex(i)} aria-disabled={Boolean(a.reason)} onClick={() => { if (!a.reason) a.run() }}><span>{a.name}</span><small>{a.reason ?? a.keywords}</small></button>)}
      {matches.length === 0 && <p role="status">No matching tool. Try “plane”, “distance”, or “export”.</p>}
    </div>
  </div>
}

export function useMeasureShell(active: boolean) {
  useEffect(() => {
    document.documentElement.dataset.design = active ? 'measure' : ''
    return () => { delete document.documentElement.dataset.design }
  }, [active])
  useEffect(() => {
    if (!active) return
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && !document.querySelector('dialog:modal')) {
        e.preventDefault(); e.stopImmediatePropagation(); useShell.getState().setSearchOpen(true)
      }
    }
    document.addEventListener('keydown', key, true)
    return () => document.removeEventListener('keydown', key, true)
  }, [active])
  // Layout changes and switching workspace do not change the selected model.

}

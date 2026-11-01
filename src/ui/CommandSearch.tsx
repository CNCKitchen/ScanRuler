// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react'
import { useShell } from '../state/shellStore'
import { Modal } from './Modal'
import { workspaceTabs } from './TopBar'
import { MeasureSearch } from './MeasurePanels'

interface Destination { label: string; detail: string; element: HTMLElement }

/** Search navigates to the real control. It never clones handlers, guesses
 * command parameters or turns a search selection into a destructive action. */
export function CommandSearch() {
  const [query, setQuery] = useState(useShell.getState().searchQuery)
  const workspace = useShell(s => s.workspace)
  const measureActions = useShell(s => s.measureActions)
  const [destinations] = useState<Destination[]>(() => {
    const seen = new Set<string>()
    return Array.from(document.querySelectorAll<HTMLElement>('.mid .panel button, .mid .panel select, .mid .panel input:not([type=file])')).flatMap((element) => {
      const label = (element.getAttribute('aria-label') || (element.tagName === 'BUTTON' ? element.textContent : element.closest('label')?.querySelector('span')?.textContent) || element.title || '').replace(/\s+/g, ' ').trim()
      if (label.length < 2 || /^(Hide Project|Hide .*width|×|Undo point)$/.test(label) || seen.has(label)) return []
      seen.add(label)
      return [{ label, detail: element.title || (element.closest('.measure-project') ? 'Project' : 'Tool settings'), element }]
    })
  })
  const results = useRef<HTMLDivElement>(null)
  const opener = useRef(document.activeElement as HTMLElement | null)
  useEffect(() => () => { queueMicrotask(() => opener.current?.isConnected && opener.current.focus()) }, [])
  const close = () => useShell.getState().setSearchOpen(false)
  const go = ({ element }: Destination) => {
    const side = element.closest('.measure-project') ? 'project' : 'context'
    if (useShell.getState().workspace === 'elements') {
      if (side === 'project') { useShell.getState().setProjectOpen(true); useShell.getState().setContextCollapsed(true) }
      else useShell.getState().setContextCollapsed(false)
    } else document.dispatchEvent(new CustomEvent('workspace-reveal', { detail: side }))
    close()
    requestAnimationFrame(() => {
      let parent = element.parentElement
      while (parent) { if (parent instanceof HTMLDetailsElement) parent.open = true; parent = parent.parentElement }
      element.scrollIntoView({ block: 'center' })
      if (element.matches(':disabled')) { const group = element.closest<HTMLElement>('.group'); if (group) { group.tabIndex = -1; group.focus() } }
      else element.focus()
    })
  }
  const words = query.toLowerCase().trim().split(/\s+/)
  const matches = destinations.filter(d => words.every(w => `${d.label} ${d.detail}`.toLowerCase().includes(w)))
  const tabs = workspaceTabs().filter(w => words.every(word => `${w.label} ${w.title}`.toLowerCase().includes(word)))
  return <Modal labelledBy="command-search-title" onClose={close} initialFocus="input" className="command-search-modal">
    <section className="command-search-dialog" onKeyDown={e => {
      if (!['ArrowDown','ArrowUp'].includes(e.key)) return
      const rows = Array.from(results.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
      const i = rows.indexOf(document.activeElement as HTMLButtonElement)
      rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus()
      e.preventDefault()
    }}>
      <div className="dock-heading"><h2 id="command-search-title">Find a tool</h2><button onClick={close} aria-label="Close tool search">Close</button></div>
      {workspace === 'elements' ? <MeasureSearch actions={measureActions.map(a => ({ ...a, run: () => { close(); a.run() } }))} /> : <>
      <label className="field"><span>Search workspaces and controls</span><input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Alignment, export, wall thickness…" /></label>
      <p className="hint">Choose a result to open its controls. Your current draft stays in place.</p>
      <div className="search-results" ref={results}>
        {tabs.map(w => <button key={w.id} onClick={() => { useShell.getState().setWorkspace(w.id); close() }}><span>{w.label}</span><small>Workspace · {w.title}</small></button>)}
        {matches.map(d => <button key={d.label} onClick={() => go(d)}><span>{d.label}</span><small>{d.element.matches(':disabled') ? 'Currently unavailable · open settings to see prerequisites' : d.detail}</small></button>)}
        {!tabs.length && !matches.length && <p role="status">No matching control. Try a workspace name or a shorter tool name.</p>}
      </div>
      </>}
    </section>
  </Modal>
}

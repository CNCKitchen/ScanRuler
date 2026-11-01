// SPDX-License-Identifier: AGPL-3.0-only
// Instrument chassis header: identity on the left, the workspace selector next
// to it, the project's name and the loaded part alongside. Models are opened from the
// workspace itself, not from here — a single "open" in a bar shared by two
// workspaces cannot say which model it means. What the bar does open is a
// project, which says for itself what it holds; a plain scan or image dropped
// on the same button goes where it would have gone from its workspace.

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { useStore } from '../state/store'
import { useFlat } from '../state/flatStore'
import { usePrefs } from '../state/prefsStore'
import { useDeviation } from '../state/deviationStore'
import { useShell, type Workspace } from '../state/shellStore'
import { plugins } from '../plugins/registry'
import { UndoRedo } from './UndoRedo'
import { AGENT_STATUS, useAgentLink } from '../commands/agentLink'
import { Icon, type IconName } from './icons'
import { IMAGE_ACCEPT, SCAN_ACCEPT, isImageFile, isModelFile, isTextureFile } from '../core/formats'
import { bundleFiles } from '../app/scanFiles'
import { PROJECT_EXTENSION, projectStem } from '../core/project/manifest'
import { isProjectFile } from '../app/useProject'
import { APP_VERSION } from '../version'
import type { RecoveryStatus } from '../app/useRecovery'

const GITHUB_URL = 'https://github.com/CNCKitchen/scanruler'

/** What the GitHub key links to: the whole app, or — with plugins in use,
 *  which are not published there — the app without them. */
const sourceTitle = () =>
  plugins().length > 0 ? 'Source code of the open-source core (AGPL-3.0-only) on GitHub' : 'Source code (AGPL-3.0-only) on GitHub'

const CORE_TABS: { id: Workspace; icon: IconName; label: string; title: string }[] = [
  { id: 'elements', icon: 'wsMeasure', label: '3D Measure', title: 'Fit spheres, cylinders and planes, and measure between them' },
  { id: 'deviation', icon: 'compare', label: 'Surface Deviation', title: 'Best-fit the scan to a nominal part and map the difference' },
  { id: 'thickness', icon: 'wsThickness', label: 'Wall Thickness', title: 'Map the wall thickness of the part itself — no reference needed' },
  { id: 'flat', icon: 'wsFlat', label: '2D Measure', title: 'Measure a flatbed scan the way a measuring microscope would' },
]

/** The app's tabs, then those of the plugins in use, in their order. */
export const workspaceTabs = () => [
  ...CORE_TABS,
  ...plugins()
    .flatMap((p) => (p.workspace ? [p.workspace] : []))
    .sort((a, b) => a.order - b.order),
]

/** The page's own title, while no project is named. */
const APP_TITLE = 'ScanRuler by CNC Kitchen'

/** The project's name, typed in place — what Save Project saves it under,
 *  every export is named on and the browser tab reads. Unnamed, those go by
 *  the scan's name, or the image's. Enter or leaving the field takes what
 *  was typed; Escape puts it back. */
function ProjectName() {
  const name = useStore((s) => s.projectName)
  const fileName = useStore((s) => s.fileName)
  const imageName = useFlat((s) => s.imageName)
  /** The text while it is being typed, or null. */
  const [typed, setTyped] = useState<string | null>(null)
  const dropped = useRef(false)
  useEffect(() => {
    document.title = name ? `${name} — ScanRuler` : APP_TITLE
  }, [name])
  const shown = typed ?? name ?? ''
  const fallback = projectStem(null, fileName, imageName)
  const placeholder = 'Untitled project'
  return (
    <input
      className="projectname"
      data-test="project-name"
      aria-label="Project name"
      spellCheck={false}
      value={shown}
      placeholder={placeholder}
      size={Math.max(14, Math.min(32, (shown || placeholder).length + 1))}
      title={`The project's name — what Save Project saves it under and every export is named on.${name ? '' : ` Unnamed, they go by ${fallback === 'project' ? 'the scan or the image it holds' : `“${fallback}”`}.`}`}
      onFocus={() => setTyped(name ?? '')}
      onChange={(e) => setTyped(e.target.value)}
      onBlur={() => {
        if (!dropped.current && typed !== null) useStore.getState().setProjectName(typed)
        dropped.current = false
        setTyped(null)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        else if (e.key === 'Escape') {
          // The field takes the key: the name goes back, and nothing else
          // the key would close is closed.
          e.preventDefault()
          dropped.current = true
          e.currentTarget.blur()
        }
      }}
    />
  )
}

/** How many of its folds the bar takes — see the top bar in styles.css —
 *  when everything spelled out does not fit its row. */
const FOLDS = 5

/** Folds the bar just as far as its row needs, and marks the ends with keys
 *  scrolled out of sight ('start', 'end' or both) for the fade that says
 *  there is more that way. Measured rather than set by window width, since
 *  what the bar holds varies: the plugins' tabs, a part chip, the agent chip.
 *  It measures with nothing squeezed (see .top.measuring), so the words go
 *  before the part's name is cut to an ellipsis. Written to
 *  the bar directly, so a fit costs no render; it runs after every render of
 *  the bar — a chip coming or going changes the row and not the bar — and
 *  whenever the bar's own width changes. */
function useFit(ref: RefObject<HTMLElement | null>) {
  const fit = useRef(() => {})
  fit.current = () => {
    const el = ref.current
    if (!el) return
    el.classList.add('measuring')
    for (let fold = 0; ; fold++) {
      el.dataset.fold = Array.from({ length: fold }, (_, i) => i + 1).join(' ')
      if (fold === FOLDS || el.scrollWidth <= el.clientWidth) break
    }
    el.classList.remove('measuring')
    markEnds(el)
  }
  useLayoutEffect(() => fit.current())
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => markEnds(el)
    el.addEventListener('scroll', onScroll, { passive: true })
    // The web fonts arriving widen every word.
    document.fonts?.ready.then(() => fit.current())
    if (typeof ResizeObserver === 'undefined') return () => el.removeEventListener('scroll', onScroll)
    const observer = new ResizeObserver(() => fit.current())
    observer.observe(el)
    return () => {
      observer.disconnect()
      el.removeEventListener('scroll', onScroll)
    }
  }, [ref])
}

function markEnds(el: HTMLElement) {
  const over = el.scrollWidth - el.clientWidth
  const ends = [el.scrollLeft > 1 && 'start', el.scrollLeft < over - 1 && 'end'].filter(Boolean).join(' ')
  if (ends) el.dataset.hidden = ends
  else delete el.dataset.hidden
}

export function TopBar({
  onNewProject,
  onSaveProject,
  onOpenProject,
  onOpenScan,
  onOpenImage,
  savable,
  recovery,
}: {
  onNewProject: () => void
  onSaveProject: () => void
  onOpenProject: (file: File) => void
  onOpenScan: (file: File) => void
  onOpenImage: (file: File) => void
  savable: boolean
  recovery: RecoveryStatus
}) {
  const fileName = useStore((s) => s.fileName)
  const triangleCount = useStore((s) => s.triangleCount)
  const vertexCount = useStore((s) => s.vertexCount)
  const busy = useStore((s) => s.busy)
  const workspace = useShell((s) => s.workspace)
  const setWorkspace = useShell((s) => s.setWorkspace)
  const picking = useDeviation((s) => s.picking)
  const openSettings = usePrefs((s) => s.openSettings)
  const agentLink = usePrefs((s) => s.agentLink)
  const agent = useAgentLink()
  const openRef = useRef<HTMLInputElement>(null)
  const barRef = useRef<HTMLElement>(null)
  const fileMenu = useRef<HTMLDetailsElement>(null)
  const closeFileMenu = (restoreFocus = false) => {
    if (!fileMenu.current?.open) return
    fileMenu.current.open = false
    if (restoreFocus) fileMenu.current.querySelector('summary')?.focus()
  }
  useEffect(() => {
    const outside = (e: PointerEvent) => { if (!fileMenu.current?.contains(e.target as Node)) closeFileMenu() }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [])
  useFit(barRef)

  const onLoad = (file: File | undefined) => {
    if (file) {
      if (isProjectFile(file.name)) onOpenProject(file)
      else if (isImageFile(file.name)) {
        onOpenImage(file)
      } else if (isModelFile(file.name)) onOpenScan(file)
      else
        useStore
          .getState()
          .setError(
            isTextureFile(file.name)
              ? `${file.name} is part of a textured scan — open it together with its OBJ (select the OBJ, the .mtl and the image at once).`
              : `Unsupported file type — use a .${PROJECT_EXTENSION} project, STL, PLY, OBJ, 3MF, STEP, PNG or JPEG.`,
          )
    }
    // Allow re-picking the same file.
    if (openRef.current) openRef.current.value = ''
  }

  return (
    <header className="top" ref={barRef}>
      <img className="brandmark" src="/scanruler-mark.svg" alt="" />
      {/* The version rides in the caption, and in the tooltip for the narrow
          layouts that drop the caption: a bug report needs the number, and
          the imprint carries it too. */}
      <div className="brand" title={`ScanRuler v${APP_VERSION}`}>
        <b>ScanRuler</b>
        <span>
          CNC Kitchen · 3D scan analysis ·{' '}
          <i className="ver" data-test="app-version">
            v{APP_VERSION}
          </i>
        </span>
      </div>
      {/* Both workspaces share the loaded scan, the scene and the camera, so
          switching is free and neither side loses what it had. */}
      <div className="modeswitch" role="tablist" aria-label="Workspaces">
        {workspaceTabs().map((w) => (
          <button
            key={w.id}
            role="tab"
            data-test={`workspace-${w.id}`}
            aria-selected={workspace === w.id}
            className={workspace === w.id ? 'on' : undefined}
            title={`${w.label}\n${w.title}`}
            aria-label={w.label}
            disabled={picking}
            onClick={() => setWorkspace(w.id)}
          >
            <Icon name={w.icon} size={16} />
            <span className="wtxt">{w.label}</span>
          </button>
        ))}
      </div>
      <ProjectName />
      {fileName && (
        <div className="partchip file-info" title={fileName}>
          <b>{fileName}</b>
          <span>
            {triangleCount.toLocaleString('en-US')} triangles ·{' '}
            {vertexCount.toLocaleString('en-US')} vertices
          </span>
        </div>
      )}
      <div className="grow" />
      {<>
        <button className="measure-search-key" data-test="measure-search" onClick={() => useShell.getState().setSearchOpen(true)} title="Find a tool (⌘/Ctrl K)" aria-label="Find a tool">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></svg><span>Find a tool</span><kbd>{typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ K' : 'Ctrl K'}</kbd>
        </button>
        <details ref={fileMenu} className="measure-file-menu" onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFileMenu(true) }
        }} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) closeFileMenu() }} onClick={(e) => {
          if ((e.target as HTMLElement).closest('button')) closeFileMenu(true)
        }}><summary>File</summary><div>
          <p className="file-save-status">{recovery.dirty ? 'Unsaved changes' : 'No unsaved changes'}<small>{recovery.status}</small></p>
          <button onClick={onNewProject} disabled={busy}>New project</button>
          <button onClick={() => openRef.current?.click()} disabled={busy}>Open project / scan</button>
          <button onClick={() => { if (workspace === 'elements') useShell.getState().setMeasurePanel('export'); else useShell.getState().setSearchOpen(true, 'export') }} disabled={!savable}>Export…</button>
          <button onClick={() => useShell.getState().setSearchOpen(true)}>Find a tool</button>
        </div></details>
      </>}
      {/* While the agent connection is on, where it stands — and the way to
          its settings. */}
      {agentLink && (
        <button
          className={`agentchip ${agent.status}`}
          data-test="agent-chip"
          title={`${AGENT_STATUS[agent.status]}${agent.detail ? ` — ${agent.detail}` : ''}. Settings → Agents.`}
          onClick={() => openSettings(true)}
        >
          <span className="agentlamp" />
          <span className="btxt">
            Agent: {agent.status === 'connected' ? 'connected' : agent.status === 'refused' ? 'turned away' : 'listening'}
          </span>
        </button>
      )}
      <span className="project-save-status" data-test="project-save-status"
        title={`${recovery.status || 'Checkpoints are stored only in this browser.'} Checkpoints and project files include completed work; finish active drawings before leaving. Save Project downloads a portable copy.`}>
        {recovery.dirty ? 'Unsaved changes' : 'No unsaved changes'}
        {recovery.status && <small role="status">{recovery.status}</small>}
      </span>
      <UndoRedo />
      <input
        ref={openRef}
        type="file"
        accept={`.${PROJECT_EXTENSION},${SCAN_ACCEPT},${IMAGE_ACCEPT}`}
        multiple
        hidden
        data-test="project-input"
        onChange={(e) => onLoad(bundleFiles(Array.from(e.target.files ?? [])) ?? undefined)}
      />
      <button
        className="ghost withicon"
        data-test="new-project"
        aria-label="New project"
        onClick={onNewProject}
        disabled={busy}
        title="Start a new project: the scan, the reference and the image closed, every measurement and every workspace's work let go, the name taken off — after asking, when there are changes not saved"
      >
        <Icon name="newProject" size={16} />
        <span className="btxt">New<span className="ptxt"> Project</span></span>
      </button>
      <button
        className="ghost withicon"
        data-test="save-project"
        data-dirty={recovery.dirty}
        aria-label="Save project"
        onClick={onSaveProject}
        disabled={busy || !savable}
        title={`Save the scan, the reference, the image and every measurement as one .${PROJECT_EXTENSION} file`}
      >
        <Icon name="save" size={16} />
        <span className="btxt">Save<span className="ptxt"> Project</span></span>
      </button>
      <button
        className="ghost withicon"
        data-test="load-project"
        aria-label="Open project or scan"
        onClick={() => openRef.current?.click()}
        disabled={busy}
        title={`Open a .${PROJECT_EXTENSION} project — or a plain scan or image to start fresh`}
      >
        <Icon name="load" size={16} />
        <span className="btxt">Load<span className="ptxt"> Project</span></span>
      </button>
      {/* What is set once and left — the chassis, the colour mode, the mouse
          controls, the line weights, the hints. Beside the project keys
          because it is about the instrument rather than about any workspace. */}
      <button
        className="ghost withicon"
        data-test="open-settings"
        aria-label="Settings"
        onClick={() => openSettings(true)}
        title="Interface theme, colour mode, mouse controls, line widths and guided hints"
      >
        <Icon name="settings" size={16} />
        <span className="btxt"> Settings</span>
      </button>
      <a
        className="iconbtn"
        href={GITHUB_URL}
        target="_blank"
        rel="noopener noreferrer"
        title={sourceTitle()}
        aria-label={sourceTitle()}
      >
        <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
        </svg>
      </a>
    </header>
  )
}

// SPDX-License-Identifier: AGPL-3.0-only
// Instrument chassis header: identity on the left, the workspace selector next
// to it, and the loaded part named alongside. Models are opened from the
// workspace itself, not from here — a single "open" in a bar shared by two
// workspaces cannot say which model it means. What the bar does open is a
// project, which says for itself what it holds; a plain scan or image dropped
// on the same button goes where it would have gone from its workspace.

import { useRef } from 'react'
import { useStore } from '../state/store'
import { useDeviation } from '../state/deviationStore'
import { useShell, type Workspace } from '../state/shellStore'
import { IMAGE_ACCEPT, MESH_ACCEPT, isImageFile, isMeshFile, isStepFile } from '../core/formats'
import { PROJECT_EXTENSION } from '../core/project/manifest'
import { isProjectFile } from '../app/useProject'

const GITHUB_URL = 'https://github.com/CNCKitchen/scanruler'

const WORKSPACES: { id: Workspace; label: string; title: string }[] = [
  { id: 'elements', label: 'Measure', title: 'Fit spheres, cylinders and planes, and measure between them' },
  { id: 'deviation', label: 'Surface Deviation', title: 'Best-fit the scan to a nominal part and map the difference' },
  { id: 'thickness', label: 'Wall Thickness', title: 'Map the wall thickness of the part itself — no reference needed' },
  { id: 'flat', label: '2D Measure', title: 'Measure a flatbed scan the way a measuring microscope would' },
]

export function TopBar({
  onSaveProject,
  onOpenProject,
  onOpenScan,
  onOpenImage,
  canSave,
}: {
  onSaveProject: () => void
  onOpenProject: (file: File) => void
  onOpenScan: (file: File) => void
  onOpenImage: (file: File) => void
  canSave: boolean
}) {
  const fileName = useStore((s) => s.fileName)
  const triangleCount = useStore((s) => s.triangleCount)
  const vertexCount = useStore((s) => s.vertexCount)
  const busy = useStore((s) => s.busy)
  const workspace = useShell((s) => s.workspace)
  const setWorkspace = useShell((s) => s.setWorkspace)
  const picking = useDeviation((s) => s.picking)
  const openRef = useRef<HTMLInputElement>(null)

  const onLoad = (file: File | undefined) => {
    if (file) {
      if (isProjectFile(file.name)) onOpenProject(file)
      else if (isImageFile(file.name)) {
        setWorkspace('flat')
        onOpenImage(file)
      } else if (isMeshFile(file.name)) onOpenScan(file)
      else
        useStore
          .getState()
          .setError(
            isStepFile(file.name)
              ? 'A STEP file is CAD, not a scan — load it as the reference in the Deviation workspace.'
              : `Unsupported file type — use a .${PROJECT_EXTENSION} project, STL, PLY, OBJ, PNG or JPEG.`,
          )
    }
    // Allow re-picking the same file.
    if (openRef.current) openRef.current.value = ''
  }

  return (
    <header className="top">
      <div className="brandmark">SR</div>
      <div className="brand">
        <b>ScanRuler</b>
        <span>CNC Kitchen · 3D scan analysis</span>
      </div>
      {/* Both workspaces share the loaded scan, the scene and the camera, so
          switching is free and neither side loses what it had. */}
      <div className="modeswitch" role="tablist">
        {WORKSPACES.map((w) => (
          <button
            key={w.id}
            role="tab"
            data-test={`workspace-${w.id}`}
            aria-selected={workspace === w.id}
            className={workspace === w.id ? 'on' : undefined}
            title={w.title}
            disabled={picking}
            onClick={() => setWorkspace(w.id)}
          >
            {w.label}
          </button>
        ))}
      </div>
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
      <input
        ref={openRef}
        type="file"
        accept={`.${PROJECT_EXTENSION},${MESH_ACCEPT},${IMAGE_ACCEPT}`}
        hidden
        data-test="project-input"
        onChange={(e) => onLoad(e.target.files?.[0] ?? undefined)}
      />
      <button
        className="ghost"
        data-test="save-project"
        onClick={onSaveProject}
        disabled={busy || !canSave}
        title={`Save the scan, the reference, the image and every measurement as one .${PROJECT_EXTENSION} file`}
      >
        Save<span className="btxt"> Project</span>
      </button>
      <button
        className="ghost"
        data-test="load-project"
        onClick={() => openRef.current?.click()}
        disabled={busy}
        title={`Open a .${PROJECT_EXTENSION} project — or a plain scan or image to start fresh`}
      >
        Load<span className="btxt"> Project</span>
      </button>
      <a
        className="iconbtn"
        href={GITHUB_URL}
        target="_blank"
        rel="noopener noreferrer"
        title="Source code (AGPL-3.0-only) on GitHub"
        aria-label="Source code, AGPL-3.0-only, on GitHub"
      >
        <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
        </svg>
      </a>
    </header>
  )
}

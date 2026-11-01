// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState, type ReactNode } from 'react'
import { DockPanel } from './MeasurePanels'

/** Workspace-owned controls stay mounted when a dock is hidden. Hiding a
 * panel is navigation, never a request to cancel a draft or reset its values. */
export function WorkspacePanels({ title, project, children, activeKey }: {
  title: string; project: ReactNode; children: ReactNode; activeKey?: string | null
}) {
  const [projectOpen, setProjectOpen] = useState(() => matchMedia('(min-width: 768px)').matches)
  const [contextOpen, setContextOpen] = useState(() => matchMedia('(min-width: 1200px)').matches)
  useEffect(() => { if (activeKey) setContextOpen(true) }, [activeKey])
  useEffect(() => {
    const reveal = (event: Event) => {
      const side = (event as CustomEvent<'project' | 'context'>).detail
      if (side === 'project') {
        setProjectOpen(true)
        if (matchMedia('(max-width: 1199px)').matches) setContextOpen(false)
      } else {
        setContextOpen(true)
        if (matchMedia('(max-width: 767px)').matches) setProjectOpen(false)
      }
    }
    document.addEventListener('workspace-reveal', reveal)
    return () => document.removeEventListener('workspace-reveal', reveal)
  }, [])
  return <>
    <nav className="measure-actions" aria-label={`${title} panels`}>
      <button aria-controls="measure-project" aria-expanded={projectOpen} onClick={() => {
        setProjectOpen(!projectOpen)
        if (!projectOpen && matchMedia('(max-width: 1199px)').matches) setContextOpen(false)
      }}>Project</button>
      <button data-test="workspace-tools" aria-controls="measure-context" aria-expanded={contextOpen} onClick={() => {
        setContextOpen(!contextOpen)
        if (!contextOpen && matchMedia('(max-width: 767px)').matches) setProjectOpen(false)
      }}>{title}</button>
    </nav>
    <DockPanel side="project" title="Project" open={projectOpen} onClose={() => setProjectOpen(false)}>{project}</DockPanel>
    <DockPanel side="context" title={title} open={contextOpen} onClose={() => setContextOpen(false)}>{children}</DockPanel>
  </>
}

// SPDX-License-Identifier: AGPL-3.0-only
// Which workspace is on screen. This is the one piece of state every part of
// the app reads — the top bar to draw the switch, the panels to know which of
// them is up, the scene sync to know what belongs on the part — so it lives in
// a store of its own rather than inside any one workspace's state, where the
// others would have to reach for it.

import { create } from 'zustand'

/** The things this tool does of itself. The mesh workspaces share the scan,
 *  the scene and the camera, differing only in what is drawn on top of the
 *  part; the flat workspace measures a 2D scan image in a viewport of its
 *  own. */
export type CoreWorkspace = 'elements' | 'deviation' | 'thickness' | 'flat'

export const CORE_WORKSPACES: readonly CoreWorkspace[] = ['elements', 'deviation', 'thickness', 'flat']

/** A core workspace, or one a plugin adds under its own id — see
 *  plugins/api.ts. */
export type Workspace = CoreWorkspace | (string & {})

interface ShellState {
  workspace: Workspace
  setWorkspace: (w: Workspace) => void
  measureActions: { name: string; keywords: string; run: () => void; reason?: string }[]
  setMeasureActions: (actions: ShellState['measureActions']) => void
  saveDownloads: number
  noteSaveDownload: () => void
  searchQuery: string
  searchOpen: boolean
  setSearchOpen: (open: boolean, query?: string) => void
  measurePanel: 'create' | 'alignment' | 'export' | 'search' | null
  setMeasurePanel: (panel: ShellState['measurePanel']) => void
  projectOpen: boolean
  setProjectOpen: (open: boolean) => void
  contextCollapsed: boolean
  setContextCollapsed: (collapsed: boolean) => void
}

export const useShell = create<ShellState>()((set) => ({
  workspace: 'elements',
  setWorkspace: (workspace) => set({ workspace }),
  measureActions: [],
  setMeasureActions: (measureActions) => set({ measureActions }),
  saveDownloads: 0,
  noteSaveDownload: () => set((s) => ({ saveDownloads: s.saveDownloads + 1 })),
  searchQuery: '',
  searchOpen: false,
  setSearchOpen: (searchOpen, searchQuery = '') => set({ searchOpen, searchQuery }),
  measurePanel: null,
  setMeasurePanel: (measurePanel) => set({ measurePanel }),
  projectOpen: typeof matchMedia !== 'function' || matchMedia('(min-width: 768px)').matches,
  setProjectOpen: (projectOpen) => set({ projectOpen }),
  contextCollapsed: false,
  setContextCollapsed: (contextCollapsed) => set({ contextCollapsed }),
}))

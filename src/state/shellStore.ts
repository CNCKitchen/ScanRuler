// SPDX-License-Identifier: AGPL-3.0-only
// Which workspace is on screen. This is the one piece of state every part of
// the app reads — the top bar to draw the switch, the panels to know which of
// them is up, the scene sync to know what belongs on the part — so it lives in
// a store of its own rather than inside any one workspace's state, where the
// others would have to reach for it.

import { create } from 'zustand'

/** The things this tool does. The three mesh workspaces share the scan, the
 *  scene and the camera, differing only in what is drawn on top of the part;
 *  the flat workspace measures a 2D scan image in a viewport of its own. */
export type Workspace = 'elements' | 'deviation' | 'thickness' | 'flat'

interface ShellState {
  workspace: Workspace
  setWorkspace: (w: Workspace) => void
}

export const useShell = create<ShellState>()((set) => ({
  workspace: 'elements',
  setWorkspace: (workspace) => set({ workspace }),
}))

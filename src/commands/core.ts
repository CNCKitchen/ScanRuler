// SPDX-License-Identifier: AGPL-3.0-only
// The app's own commands, by namespace — the contract an agent works
// against. Their names stay as they are once published; new ones are added
// beside them. A plugin's are its own business and come in under its id.
//
// Named in the contract and still to come: scan.pick_screen, scan.candidates
// and the { screen } and { candidate } places of `at`.

import { registerCommands } from './registry'
import { alignCommands } from './core/align'
import { dimensionCommands } from './core/dimension'
import { deviationCommands } from './core/deviation'
import { elementCommands } from './core/element'
import { exportCommands, projectCommands } from './core/files'
import { flatCommands } from './core/flat'
import { scanCommands } from './core/scan'
import { sectionCommands } from './core/section'
import { historyCommands, reportCommands, sessionCommands, workspaceCommands } from './core/session'
import { thicknessCommands } from './core/thickness'
import { viewCommands } from './core/view'

let registered = false

/** Register the app's commands, once. Loaded with the agent connection
 *  rather than with the page — a session no agent drives carries none of
 *  this — so the plugins' commands, registered at start-up, are there
 *  first; the names never meet. */
export function registerCoreCommands(): void {
  if (registered) return
  registered = true
  registerCommands('session', sessionCommands)
  registerCommands('workspace', workspaceCommands)
  registerCommands('scan', scanCommands)
  registerCommands('element', elementCommands)
  registerCommands('dimension', dimensionCommands)
  registerCommands('align', alignCommands)
  registerCommands('section', sectionCommands)
  registerCommands('deviation', deviationCommands)
  registerCommands('thickness', thicknessCommands)
  registerCommands('flat', flatCommands)
  registerCommands('report', reportCommands)
  registerCommands('export', exportCommands)
  registerCommands('project', projectCommands)
  registerCommands('history', historyCommands)
  registerCommands('view', viewCommands)
}

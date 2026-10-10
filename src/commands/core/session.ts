// SPDX-License-Identifier: AGPL-3.0-only
// The session as a whole: reading it out, starting it over, the workspace on
// screen, the report, and the undo history.

import { runImport } from '../../app/imports'
import { historyBlocked, redo, undo, useHistory } from '../../state/historyStore'
import { useShell } from '../../state/shellStore'
import { commandHost } from '../host'
import { reportJson, reportText, REPORT_WORKSPACES, type ReportWorkspace } from '../report'
import { enumOf, obj, str } from '../schema'
import { internalWorkspace, publicWorkspace, sessionState, workspaceNames } from '../state'
import { CommandError, type Command } from '../types'
import { discardSchema, requireDiscardable } from './common'

const state: Command = {
  name: 'state',
  title: 'Read the session',
  description:
    'The whole session as JSON: the app and its plugins, the workspace on screen, whether it is busy, the scan (file, units, vertex and triangle counts, bounding box, centre, size, applied alignment), every element with its fit, every dimension with its value, limit and verdict, the sections, what is open in the panels, the deviation, wall thickness and 2D Measure state with their statistics, the guided hint for the next step, and the undo history. Lengths in millimetres, angles in degrees. Read it before acting and after.',
  input: obj({}),
  readOnly: true,
  run: () => sessionState(),
}

const reset: Command<{ discard?: boolean }> = {
  name: 'reset',
  title: 'Start over',
  description:
    'Close the scan, the reference part and the 2D image, and with them every measurement, as opening an empty project does. Refuses while the session holds measurements unless discard is true. Not undoable: the history starts over too.',
  input: obj({ discard: discardSchema }),
  history: false,
  run: async ({ discard }) => {
    requireDiscardable(discard, 'starting over')
    const { session, flat } = commandHost()
    await runImport(session.imports, 'Starting over…', async () => {
      await session.clientRef.current!.commitImport({ scan: null, nominal: null })
      session.scan.commitScan(null)
      session.deviation.commitNominal(null)
      flat?.closeImage()
    })
    return await sessionState()
  },
}

const workspace: Command<{ workspace: string }> = {
  name: 'set',
  title: 'Show a workspace',
  description:
    'Put a workspace on screen: measure (fitting elements and dimensions), deviation (scan against a reference part or an element), thickness (wall thickness), flat (2D measuring of an image or a section), or a plugin’s by its id — session.state lists them under app.plugins. Commands put their own workspace on screen; this is for showing the person something.',
  input: obj({ workspace: str('The workspace — measure, deviation, thickness, flat, or a plugin’s id.', { minLength: 1 }) }, ['workspace']),
  run: async ({ workspace: name }) => {
    if (!workspaceNames().includes(name)) {
      throw new CommandError('invalid_input', `There is no workspace "${name}" — there are ${workspaceNames().join(', ')}.`)
    }
    useShell.getState().setWorkspace(internalWorkspace(name))
    return { workspace: publicWorkspace(useShell.getState().workspace) }
  },
}

const report: Command<{ format?: 'json' | 'text'; workspace?: ReportWorkspace }> = {
  name: 'get',
  title: 'Get the report',
  description:
    'The measurement report. format "text" is word for word what the workspace’s Copy report button puts on the clipboard — measure (elements and dimensions with verdicts), deviation, thickness or flat (2D). format "json" (the default) is the whole session’s report structured: what the numbers rest on (units, scale, frame, applied alignment, fit method and each element’s outlier cut-off), every element with its fit, every dimension with value, unit, limit and pass/fail verdict, the tally of checks, the sections, and the deviation, thickness and 2D results with their settings.',
  input: obj({
    format: enumOf(['json', 'text'], 'json (the default) or text.'),
    workspace: enumOf(REPORT_WORKSPACES, 'For text: whose report — measure (the default), deviation, thickness or flat.'),
  }),
  readOnly: true,
  run: async ({ format = 'json', workspace: w = 'measure' }) =>
    format === 'text' ? { format, workspace: w, text: reportText(w) } : { format, report: reportJson() },
}

/** Walk the history one step, as the undo keys do. */
async function travel(back: boolean) {
  const h = useHistory.getState()
  const entry = (back ? h.past : h.future).at(-1)
  if (!entry) throw new CommandError('invalid_state', `There is nothing to ${back ? 'undo' : 'redo'}.`)
  if (historyBlocked()) {
    throw new CommandError('invalid_state', `Something open in a panel is in the way of ${back ? 'undo' : 'redo'} — finish or cancel it first.`)
  }
  await (back ? undo() : redo())
  const after = useHistory.getState()
  if ((back ? after.future : after.past).at(-1) !== entry) {
    throw new CommandError('failed', `The step "${entry.label}" could not be ${back ? 'undone' : 'redone'}.`)
  }
  return { [back ? 'undone' : 'redone']: entry.label, workspace: publicWorkspace(entry.workspace), state: await sessionState() }
}

const undoCommand: Command = {
  name: 'undo',
  title: 'Undo',
  description: 'Undo the last step — one of the person’s or one of these commands, each of which is one step. Returns the step’s name and the session afterwards.',
  input: obj({}),
  history: false,
  run: () => travel(true),
}

const redoCommand: Command = {
  name: 'redo',
  title: 'Redo',
  description: 'Redo the step undone last. Returns the step’s name and the session afterwards.',
  input: obj({}),
  history: false,
  run: () => travel(false),
}

export const sessionCommands = [state, reset]
export const workspaceCommands = [workspace]
export const reportCommands = [report]
export const historyCommands = [undoCommand, redoCommand]

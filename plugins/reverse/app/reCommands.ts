// SPDX-License-Identifier: AGPL-3.0-only
// The Reverse engineer workspace's commands — what an agent models through
// (src/commands), registered under the plugin's id from its install():
// reverse.feature.add, reverse.parameter.set and the rest. Each is the
// panel's own code path: the store's box for the feature opened, filled and
// committed as the panel fills it, one step of the undo history ("Agent:
// …"), the build awaited, and what the store holds afterwards handed back.
// None leaves a box open: a feature that cannot be made closes its box and
// says why. The shapes they take are reSchemas.ts. The commands live by
// group — reFeatureCommands, reBodyCommands, reSectionCommands,
// reThreadCommand, reParameterCommands, reNoteCommands, reNetworkCommands,
// rePlan — on what reCommandCore, reCommandAnswers, reSketchInput and
// reFeatureInput share; this module lists them under their names.

import type { Command } from '../../../src/plugins/api'
import { reverseSession } from './reSession'
import { failuresOnce } from './reCommandAnswers'
import { allFeatures, type Json, withHeldBuild } from './reCommandCore'
import { add, build, clear, importStep, list, move, refit, remove, rollback, schema, sketchEdit, suppress, update } from './reFeatureCommands'
import { buildStop } from './reBuildStop'
import { bodySet, check, clearance, compare, compareInDeviationCommand, describe, step, stl } from './reBodyCommands'
import { volumeCompare } from './reVolumeCompare'
import { bodyProbe, bodySection } from './reProbeCommands'
import { review } from './reReview'
import { planeDescribe, sectionFit, sectionOutline, sectionStack, sketchCandidates, tubeTrace } from './reSectionCommands'
import { filletRead } from './reFilletRead'
import { filletTry } from './reFilletTry'
import { threadRead } from './reThreadCommand'
import { parameterAdd, parameterList, parameterRemove, parameterRename, parameterSet } from './reParameterCommands'
import { noteAdd, noteList, noteResolve, notesNudge } from './reNoteCommands'
import { networkCreate, networkEdit, networkRead, networkSuggestCreases } from './reNetworkCommands'
import { planReplace, planSet, planTick, planUpdate, withPlanGate } from './rePlan'

/** What the kernel's builds have done so far, by the client that asked. */
function stepsSoFar() {
  const client = reverseSession()?.client() ?? null
  return { client, ...(client?.steps ?? { recomputed: 0, restored: 0, builds: 0 }), log: client?.played.length ?? 0 }
}

/** The steps played since `from` in the client's log, by feature, with
 *  their milliseconds. */
function playedSince(from: number) {
  const names = new Map(allFeatures().map((f) => [f.id, f.name]))
  return (reverseSession()?.client()?.played.slice(from) ?? []).map((p) => ({ feature: names.get(p.id) ?? p.id, ms: Math.round(p.ms * 10) / 10 }))
}

/** A change whose answer says what its builds did with the feature list's
 *  steps: how many were played (recomputed) and how many taken up from a
 *  state the kernel held (restored) — a value set back, the rollback bar
 *  moved, plays none — and which were played, each with its milliseconds
 *  (played; scanruler-mcp hands those on only to a batch asked for its
 *  timings). Only when it built. */
function withSteps(command: Command<never>): Command<never> {
  if (command.readOnly) return command
  return {
    ...command,
    run: async (input, ctx) => {
      const before = stepsSoFar()
      const out = await command.run(input, ctx)
      const after = stepsSoFar()
      if (!out || typeof out !== 'object' || Array.isArray(out) || after.client !== before.client || after.builds === before.builds) return out
      return { ...out, steps: { recomputed: after.recomputed - before.recomputed, restored: after.restored - before.restored, played: playedSince(before.log) } }
    },
  }
}

/** A command whose answer says what failed once (failuresOnce) and, while
 *  any notes want the agent, how many are open and which it has not read —
 *  see notesNudge: a change, and a
 *  read of the part too (a comparison, a description, a section), where a
 *  note on the place being read is the first thing to know. Not the note
 *  commands themselves, which answer with the notes, nor the features'
 *  schema, which reads no part. */
function withNotes(command: Command<never>): Command<never> {
  if (command.name.startsWith('note.') || command.name === 'feature.schema') return command
  return {
    ...command,
    run: async (input, ctx) => {
      const out = await command.run(input, ctx)
      if (!out || typeof out !== 'object' || Array.isArray(out)) return out
      const told = failuresOnce(out as Json)
      const notes = notesNudge()
      return (notes ? { ...told, notes } : told) as never
    },
  }
}

/** The commands that run with no page — no scan, no viewport — in the app
 *  run headless (src/headless/engine.ts): modelling, parameters, the bodies
 *  described and checked, notes, and the files. */
const HEADLESS = new Set([
  'feature.list', 'feature.add', 'feature.schema', 'feature.update', 'feature.remove', 'feature.move', 'feature.suppress', 'feature.clear', 'feature.rollback', 'sketch.edit', 'build',
  'body.describe', 'body.check', 'body.section', 'body.probe', 'body.fillet_try', 'export.step', 'export.stl', 'import.step', 'plane.describe',
  'parameter.list', 'parameter.add', 'parameter.set', 'parameter.rename', 'parameter.remove',
  'note.list', 'note.add', 'note.resolve', 'plan.set', 'plan.update', 'plan.tick', 'plan.replace',
])

/** Sketches and features share one list of names (requireFreeName): an
 *  agent's batch giving one twice is refused before it runs. */
const FEATURE_NAMES = 'sketches and features'

/** The workspace's commands, by the names they are registered under —
 *  `reverse.` before each. The names and their inputs are the contract. */
export const reverseCommands: Command<never>[] = ([
  { ...list, name: 'feature.list' },
  { ...add, name: 'feature.add', names: { space: FEATURE_NAMES, at: ['feature.name', 'features[].name'] } },
  { ...schema, name: 'feature.schema' },
  { ...update, name: 'feature.update', names: { space: FEATURE_NAMES, at: ['set.name', 'features[].set.name'] } },
  { ...refit, name: 'feature.refit' },
  { ...remove, name: 'feature.remove' },
  { ...move, name: 'feature.move' },
  { ...suppress, name: 'feature.suppress' },
  { ...clear, name: 'feature.clear' },
  { ...rollback, name: 'feature.rollback' },
  { ...sketchEdit, name: 'sketch.edit' },
  { ...sketchCandidates, name: 'sketch.candidates' },
  build,
  buildStop,
  { ...describe, name: 'body.describe' },
  { ...bodySet, name: 'body.set' },
  { ...clearance, name: 'body.clearance' },
  { ...bodySection, name: 'body.section' },
  { ...bodyProbe, name: 'body.probe' },
  { ...compare, name: 'body.compare' },
  { ...compareInDeviationCommand, name: 'body.compare_in_deviation' },
  { ...volumeCompare, name: 'body.volume_compare' },
  { ...review, name: 'body.review' },
  { ...check, name: 'body.check' },
  { ...filletRead, name: 'body.fillet_read' },
  { ...filletTry, name: 'body.fillet_try' },
  { ...step, name: 'export.step' },
  { ...stl, name: 'export.stl' },
  importStep,
  { ...planeDescribe, name: 'plane.describe' },
  { ...sectionFit, name: 'section.fit' },
  { ...sectionStack, name: 'section.stack' },
  { ...sectionOutline, name: 'section.outline' },
  { ...tubeTrace, name: 'scan.tube_trace' },
  { ...threadRead, name: 'thread.read' },
  { ...parameterList, name: 'parameter.list' },
  { ...parameterAdd, name: 'parameter.add' },
  { ...parameterSet, name: 'parameter.set' },
  { ...parameterRename, name: 'parameter.rename' },
  { ...parameterRemove, name: 'parameter.remove' },
  { ...noteList, name: 'note.list' },
  { ...noteAdd, name: 'note.add' },
  { ...noteResolve, name: 'note.resolve' },
  { ...networkCreate, name: 'network.create', names: { space: FEATURE_NAMES, at: ['name'] } },
  { ...networkEdit, name: 'network.edit', names: { space: FEATURE_NAMES, at: ['name'] } },
  { ...networkRead, name: 'network.read' },
  { ...networkSuggestCreases, name: 'network.suggest_creases' },
  { ...planSet, name: 'plan.set' },
  { ...planUpdate, name: 'plan.update' },
  { ...planTick, name: 'plan.tick' },
  { ...planReplace, name: 'plan.replace' },
] as Command<never>[]).map((c) => withNotes(withPlanGate(withSteps(withHeldBuild(HEADLESS.has(c.name) ? { ...c, headless: true } : c)), reverseSession)))


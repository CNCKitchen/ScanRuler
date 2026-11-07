// SPDX-License-Identifier: AGPL-3.0-only
// The steps of a build in groups that work on bodies of their own: two
// groups never read or change a body the other made, so each can be built
// on a kernel of its own at the same time — the base of a screw cap and its
// knurl on one, the cap and its knurl on another — and the kernel building
// the whole list takes every step over from them (Builder.takeOver, which
// checks what each step read). Worked out from the steps' fields alone,
// before anything is built: which bodies a step reads, which it changes,
// whether it makes one. A step that joins or cuts whatever it meets reads
// every body there is, and puts them all in one group. A guess that turns
// out wrong costs time, never the result: a step whose reads do not stand
// is played again where the whole list is built.

import { bodyMaker, type BuildStep, toolsOf } from './features'
import type { Sketch } from './sketch'

export interface StepGroup {
  /** The indices of the steps in the build, in order. */
  steps: number[]
  /** Whether a step reads the scan, which only the main kernel holds. */
  scan: boolean
}

export interface Grouped {
  groups: StepGroup[]
  /** By step: whether it has to be played — it changed, or it reads what
   *  a step that has to be played makes. The rest a kept build has. */
  dirty: boolean[]
}

/** What one step reads and does to the bodies, by the step's fields. */
function touches(step: BuildStep, sketchOf: (id: number) => Sketch | undefined): { reads: number[]; changes: number[]; makes: boolean; all: boolean; sketches: number[]; scan: boolean } {
  const reads: number[] = []
  const changes: number[] = []
  const sketches: number[] = []
  let makes = false
  let all = false
  let scan = false
  switch (step.kind) {
    case 'sketch':
      if (step.onFace) reads.push(step.onFace.body)
      for (const s of step.sources) sketches.push(s.id)
      for (const e of sketchOf(step.id)?.entities ?? []) if (e.source && 'body' in e.source) reads.push(e.source.body)
      break
    case 'extrude':
    case 'revolve':
    case 'extract':
    case 'loft':
    case 'sweep':
    case 'thicken':
      if (step.kind === 'thicken') reads.push(step.sheet)
      if (step.kind === 'extrude' || step.kind === 'revolve') {
        sketches.push(step.sketchId)
        if (step.onFace) reads.push(step.onFace.body)
      }
      if (step.kind === 'loft' || step.kind === 'sweep') sketches.push(...step.sketches)
      if (step.kind === 'extrude') {
        if (step.faceProfile) reads.push(step.faceProfile.body)
        const until = step.until
        if (until?.kind === 'face' || until?.kind === 'body') reads.push(until.body)
        else if (until) {
          if (until.against === 'all') all = true
          else reads.push(...until.against)
        }
      }
      if (step.op === 'new') makes = true
      else if (step.target !== undefined) {
        reads.push(step.target)
        changes.push(step.target)
      } else {
        // Joined to, or cut out of, whatever it meets.
        all = true
        makes = step.op === 'join'
      }
      break
    case 'sheet':
      sketches.push(step.sketchId)
      makes = true
      break
    case 'import':
      makes = true
      break
    case 'surface':
      for (const s of step.refSurfaces) reads.push(s.id)
      makes = true
      scan = true
      break
    case 'network':
      // The bodies its curves run along and its patches meet.
      for (const n of step.nodes) if (n.on) reads.push(n.on.body)
      for (const c of step.curves) {
        if (c.along) reads.push(c.along.body)
        if (c.side) reads.push(c.side.body)
      }
      makes = true
      scan = true
      break
    case 'trim':
      reads.push(...step.bodies)
      makes = true
      scan = true
      break
    case 'moveBody':
      reads.push(...step.bodies)
      if (step.copy) makes = true
      else changes.push(...step.bodies)
      break
    case 'offsetBody':
      reads.push(step.body)
      if (step.keep) makes = true
      else changes.push(step.body)
      break
    case 'mirror':
      reads.push(step.body)
      if (step.join) changes.push(step.body)
      else makes = true
      break
    case 'boolean':
      reads.push(step.body, ...toolsOf(step))
      changes.push(step.body)
      break
    case 'split':
      reads.push(step.body, ...step.tools)
      changes.push(step.body)
      scan = step.keep === 'scan'
      break
    case 'failed':
      break
    default:
      reads.push(step.body)
      changes.push(step.body)
  }
  return { reads, changes, makes, all, sketches, scan }
}

/** The steps in groups that touch no body of another's — see above — in
 *  the order of their first steps; and which steps have to be played, by
 *  `changed`: the steps no kept build has. */
export function groupSteps(steps: readonly BuildStep[], sketchOf: (id: number) => Sketch | undefined, changed: readonly boolean[] = steps.map(() => true)): Grouped {
  const parent = steps.map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]]
    return i
  }
  const join = (a: number, b: number) => {
    const x = find(a)
    const y = find(b)
    if (x !== y) parent[Math.max(x, y)] = Math.min(x, y)
  }
  /** The step that last made or changed each body, by the feature that
   *  made it (a body in pieces is the pieces' maker's). */
  const writer = new Map<number, number>()
  /** A body gone into another — a Combine's tool — to the body it went into. */
  const into = new Map<number, number>()
  const live = new Set<number>()
  const sketchStep = new Map<number, number>()
  const scan = new Set<number>()
  const dirty = steps.map((_, i) => changed[i])
  const resolve = (id: number) => {
    let b = bodyMaker(id)
    for (let n = 0; n < 64 && into.has(b); n++) b = into.get(b)!
    return b
  }
  steps.forEach((step, i) => {
    const t = touches(step, sketchOf)
    if (t.scan) scan.add(i)
    if (step.kind === 'sketch') sketchStep.set(step.id, i)
    for (const id of t.sketches) {
      const at = sketchStep.get(id)
      if (at !== undefined && at !== i) {
        join(i, at)
        if (dirty[at]) dirty[i] = true
      }
    }
    for (const b of [...(t.all ? live : []), ...t.reads.map(resolve)]) {
      const w = writer.get(b)
      if (w === undefined) continue
      join(i, w)
      if (dirty[w]) dirty[i] = true
    }
    if (t.all) for (const b of live) writer.set(b, i)
    for (const b of t.changes.map(resolve)) {
      writer.set(b, i)
      live.add(b)
    }
    if (t.makes) {
      writer.set(step.id, i)
      live.add(step.id)
    }
    if (step.kind === 'boolean' && !step.keep) {
      const body = resolve(step.body)
      for (const t of toolsOf(step)) {
        const tool = resolve(t)
        if (tool !== body) {
          into.set(tool, body)
          live.delete(tool)
        }
      }
    }
  })
  const groups = new Map<number, StepGroup>()
  steps.forEach((_, i) => {
    const root = find(i)
    let g = groups.get(root)
    if (!g) groups.set(root, (g = { steps: [], scan: false }))
    g.steps.push(i)
    if (scan.has(i)) g.scan = true
  })
  return { groups: [...groups.values()].sort((a, b) => a.steps[0] - b.steps[0]), dirty }
}

// SPDX-License-Identifier: AGPL-3.0-only
// A helper kernel: a worker of its own (reHelperWorker.ts) that builds the
// groups of steps the kernel's worker hands it (reParallel.ts) while that
// worker builds others, and writes each out for it to take the steps over
// (Builder.exportPart). Each group it is given has a builder of its own,
// kept between builds, so a group built again takes over from its last
// build here what did not change, as the main kernel would have. Under
// Node the same service runs in the test's thread (reLocal.ts).

import type { ReKernel } from './kernel'
import { Builder } from './build'
import { Tokens, type PartExport } from './buildTransfer'
import type { BuildStep } from './features'
import { kernelTeller, type KernelEvent } from './reEvents'
import type { Sketch } from './sketch'

export type HelperRequest =
  /** Load the kernel. Answered once it can build — what the main kernel's
   *  worker waits for before it starts on its own share: blocked in its
   *  own work, it could not start the helper's worker. */
  | { type: 'init'; requestId: number }
  | PartRequest

export type PartRequest = {
  type: 'part'
  requestId: number
  /** The group, by the id of its first step: the builder it is built on. */
  group: string
  /** The groups this helper still builds: the builders of the others are
   *  let go. */
  keep: string[]
  steps: BuildStep[]
  sketches: [number, Sketch][]
  stepFiles?: [string, string][]
  /** The tokens the main kernel holds already (buildTransfer.ts). */
  have: number[]
}

export type HelperResponse = { type: 'init-ok'; requestId: number } | { type: 'part-ok'; requestId: number; part: PartExport | null } | { type: 'error'; requestId: number; message: string }

/** The helper's service over the kernel `loadKernel` brings up; `tell`
 *  hears what it is at while it builds — what its worker posts to the
 *  kernel's worker, which passes it on to the page (reEvents.ts). */
export function createHelperService(loadKernel: () => Promise<ReKernel>, tell?: (e: KernelEvent) => void) {
  let kernel: Promise<ReKernel> | null = null
  const builders = new Map<string, Builder>()
  const tokens = new Tokens()
  const teller = tell ? kernelTeller(tell) : null
  return {
    async handle(msg: HelperRequest): Promise<{ response: HelperResponse; transfer: Transferable[] }> {
      try {
        // A load that failed is not kept: the next request tries again, or
        // this helper's share of every build would be lost until a reload.
        const k = await (kernel ??= loadKernel().catch((e) => {
          kernel = null
          throw e
        }))
        if (msg.type === 'init') return { response: { type: 'init-ok', requestId: msg.requestId }, transfer: [] }
        for (const [group, b] of builders) {
          if (msg.keep.includes(group)) continue
          b.dispose()
          builders.delete(group)
        }
        let builder = builders.get(msg.group)
        if (!builder) builders.set(msg.group, (builder = new Builder(k)))
        teller?.hook(builder)
        builder.addStepFiles(msg.stepFiles ?? [])
        const sketches = new Map(msg.sketches)
        builder.build(msg.steps, (id) => sketches.get(id), true, false)
        const part = builder.exportPart(tokens, new Set(msg.have))
        const transfer: Transferable[] = []
        for (const o of part?.objects ?? []) if (o.kind === 'body') transfer.push(o.brep.buffer as ArrayBuffer)
        return { response: { type: 'part-ok', requestId: msg.requestId, part }, transfer }
      } catch (e) {
        return { response: { type: 'error', requestId: msg.requestId, message: e instanceof Error ? e.message : String(e) }, transfer: [] }
      }
    },
  }
}

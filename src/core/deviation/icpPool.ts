// SPDX-License-Identifier: AGPL-3.0-only
// The alignment's closest-point passes on every core. Each pass pairs every
// sample with the reference — the bulk of an ICP iteration — and the samples are
// cut into blocks dealt out to helper workers, which write what they find into
// memory shared with this thread (so it needs a cross-origin isolated page). The
// rest of the pass (median, the 6x6 solve) stays here. Every sample is paired by
// the same code as without helpers (pairRange) and the score is summed in sample
// order here, so the fit is identical; only the clock differs. The helpers build
// their copies of the reference while the first passes run here, and a pass
// goes to them only once two are up.

import { helpersFor } from '../thickness/parallel'
import { newPairArrays, type IcpPool, type PairArrays, type PairingSession, type PairParams, type ScanSamples } from './icp'
import type { IcpHelperRequest, IcpHelperResponse } from './icpHelper'
import type { Rigid } from './rigid'
import type { NominalSurface } from './surface'

/** Fewer samples than this are paired faster here than a pass can be handed out. */
const MIN_SAMPLES = 2_000
/** Each helper builds its own copy of the reference; past this it costs more than it saves. */
const MAX_REFERENCE_TRIANGLES = 1_500_000

export interface ClosablePool extends IcpPool {
  close(): void
}

/** A pool for a scan of this many vertices against `surface`, or null where there is no gain or no way. */
export function icpPoolFor(surface: NominalSurface, vertexCount: number): ClosablePool | null {
  const isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true
  if (typeof SharedArrayBuffer === 'undefined' || !isolated) return null
  if (surface.triangleCount > MAX_REFERENCE_TRIANGLES) return null
  const helpers = helpersFor(vertexCount, Infinity)
  if (helpers === 0) return null
  try {
    return startPool(surface, helpers)
  } catch (e) {
    console.warn('The alignment helpers would not start; aligning here.', e)
    return null
  }
}

function startPool(surface: NominalSurface, helpers: number): ClosablePool {
  const slots: { worker: Worker; ready: boolean }[] = []
  const sessions = new Map<ScanSamples, PairingSession>()
  let dead = false
  let ids = 0
  let pass: { id: number; left: number; session: PairingSession; finish: () => void } | null = null

  const stop = () => {
    dead = true
    for (const s of slots) s.worker.terminate()
    slots.length = 0
  }
  const fail = (why: unknown) => {
    if (dead) return
    console.warn('The alignment helpers failed; carrying on here.', why)
    stop()
    if (pass) {
      pass.session.complete = false
      pass.finish()
    }
  }
  const post = (slot: { worker: Worker }, message: IcpHelperRequest) => slot.worker.postMessage(message)

  for (let i = 0; i < helpers; i++) {
    const slot = { worker: new Worker(new URL('./icpHelper.ts', import.meta.url), { type: 'module' }), ready: false }
    slots.push(slot)
    slot.worker.onerror = (e) => fail(e.message || 'A helper failed.')
    slot.worker.onmessageerror = () => fail('A helper returned an unreadable answer.')
    slot.worker.onmessage = ({ data }: MessageEvent<IcpHelperResponse>) => {
      if (data.type === 'error') return fail(data.message)
      if (data.type === 'ready') slot.ready = true
      else if (pass && data.pass === pass.id && --pass.left === 0) {
        pass.session.complete = true
        pass.finish()
      }
    }
    post(slot, { type: 'init', referencePositions: surface.positions, referenceIndex: surface.index })
  }

  const share = (a: Float64Array | null): Float64Array | null => {
    if (!a) return null
    const out = new Float64Array(new SharedArrayBuffer(a.byteLength))
    out.set(a)
    return out
  }

  return {
    close: stop,
    session(samples) {
      if (dead || samples.count < MIN_SAMPLES) return null
      const known = sessions.get(samples)
      if (known) return known
      const id = ids++
      const xyz = share(samples.xyz)!
      const normals = share(samples.normals)
      const arrays: PairArrays = newPairArrays(samples.count, true)
      const session: PairingSession = {
        arrays,
        complete: false,
        ready: () => !dead && slots.filter((s) => s.ready).length >= 2,
        pair(transform: Rigid, params: PairParams) {
          session.complete = false
          const live = slots.filter((s) => s.ready)
          if (dead || live.length === 0) return Promise.resolve()
          return new Promise<void>((resolve) => {
            const mine = {
              id: ++ids,
              left: live.length,
              session,
              finish: () => {
                pass = null
                resolve()
              },
            }
            pass = mine
            live.forEach((slot, index) => post(slot, { type: 'pair', pass: mine.id, session: id, transform, params, of: live.length, index }))
          })
        },
      }
      for (const slot of slots) post(slot, { type: 'session', id, xyz, normals, arrays })
      sessions.set(samples, session)
      return session
    },
  }
}
